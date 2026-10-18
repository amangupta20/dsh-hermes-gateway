// dsh-hermes-gateway: Hermes API-server contract over `dsh --profile headless --json`.
// Env: DSH_GATEWAY_KEY (required), PORT (8642), DSH_WORKSPACE (cwd for runs),
//      DSH_BIN (dsh), DSH_PROFILE (headless), DSH_MODEL, DSH_GATEWAY_DATA (state dir).
'use strict';
const express = require('express');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8642);
const KEY = process.env.DSH_GATEWAY_KEY;
const WORKSPACE = process.env.DSH_WORKSPACE || process.cwd();
const DSH_BIN = process.env.DSH_BIN || 'dsh';
const DSH_PROFILE = process.env.DSH_PROFILE || 'headless';
const DSH_MODEL = process.env.DSH_MODEL || 'muse-spark-1.3-contributor';
const DATA_DIR = process.env.DSH_GATEWAY_DATA || path.join(process.cwd(), '.dsh-hermes-gateway');
if (!KEY) { console.error('dsh-hermes-gateway: DSH_GATEWAY_KEY is required'); process.exit(1); }
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- durable state (idempotency 24h, session-key map, settled runs) ----
const IDEM_TTL = 24 * 3600 * 1000;
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return d; } };
const save = (f, o) => fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(o));
let idem = load('idempotency.json', {});
let sessMap = load('sessions.json', {});
let settled = load('runs.json', {});
for (const [k, v] of Object.entries(idem)) if (Date.now() - v.ts > IDEM_TTL) delete idem[k];
const persistIdem = () => save('idempotency.json', idem);
const persistSess = () => save('sessions.json', sessMap);
const persistRuns = () => save('runs.json', settled);

// ---- in-memory runs ----
const runs = new Map(); // run_id -> run
const runningSessions = new Set(); // dsh session ids with a live proc
let shuttingDown = false;
const newId = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const hashBody = (b) => crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex');
const trunc = (s, n = 500) => (s = String(s ?? ''), s.length > n ? s.slice(0, n - 1) + '…' : s); // total <= n
const redact = (s) => String(s ?? '').replace(/oc_sk_[A-Za-z0-9_-]+|sk-[A-Za-z0-9-_]{8,}|Bearer\s+[A-Za-z0-9\-._~+/=]+|api[_-]?key["'\s:=]+[^\s"',}]{4,}/gi, '[REDACTED]');
const preview = (v) => trunc(redact(typeof v === 'string' ? v : JSON.stringify(v)));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { // access log: never log the bearer key
  res.on('finish', () => console.log(`${req.method} ${req.path} -> ${res.statusCode}`));
  next();
});
const authed = (req, res, next) => {
  const h = req.headers.authorization || '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(got), b = Buffer.from(KEY);
  if (!got || a.length !== b.length || !crypto.timingSafeEqual(a, b))
    return res.status(401).json({ error: { code: 'unauthorized', message: 'missing or invalid bearer token' } });
  next();
};
const bad = (res, msg) => res.status(400).json({ error: { code: 'invalid_params', message: msg } });

// ---- health (no auth) ----
for (const p of ['/health', '/api/health', '/v1/health'])
  app.get(p, (req, res) => res.json({ status: 'ok' }));

// ---- models (authed) ----
for (const p of ['/v1/models', '/api/v1/models'])
  app.get(p, authed, (req, res) => res.json([{ id: 'dsh-agent', object: 'model' }]));

// ---- capabilities (authed) ----
const CAPS = { object: 'hermes.api_server.capabilities', platform: 'hermes-agent', model: 'dsh-agent',
  auth: { type: 'bearer', required: true },
  features: { chat_completions: true, responses_api: true, run_submission: true, run_status: true, run_events_sse: true, run_stop: true, reasoning_streaming: true } };
for (const p of ['/v1/capabilities', '/api/v1/capabilities'])
  app.get(p, authed, (req, res) => res.json(CAPS));

// ---- POST-only proof ----
for (const p of ['/v1/runs', '/api/v1/runs'])
  app.get(p, (req, res) => res.status(405).set('Allow', 'POST').json({ error: { code: 'method_not_allowed', message: 'use POST' } }));

// ---- run view ----
const view = (r) => ({ object: 'hermes.run', run_id: r.run_id, status: r.status, session_id: r.session_id,
  model: 'dsh-agent', output: r.output || '',
  usage: { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens, total_tokens: r.usage.total_tokens },
  runtime: { provider: 'deepseek', model: DSH_MODEL, route_source: 'global' } });
const push = (r, event, data) => { const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; r.events.push(line); for (const s of r.subs) s.write(line); };

// ---- submit ----
async function submit(req, res) {
  if (shuttingDown) return res.status(503).set('Retry-After', '5').json({ error: { code: 'shutting_down', message: 'gateway is shutting down' } });
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[\x21-\x7E]{1,255}$/.test(key)) return bad(res, 'Idempotency-Key header required: 1-255 visible ASCII chars');
  const skey = req.headers['x-hermes-session-key'];
  if (skey !== undefined && (typeof skey !== 'string' || skey.length > 256 || /[\r\n\0]/.test(skey))) return bad(res, 'X-Hermes-Session-Key must be <=256 chars without CR/LF/NUL');
  const { input, session_id, instructions, conversation_history, previous_response_id } = req.body ?? {};
  if (typeof input !== 'string' || !input.trim()) return bad(res, 'body.input must be a non-empty string');
  if (session_id !== undefined && typeof session_id !== 'string') return bad(res, 'body.session_id must be a string');
  if (instructions !== undefined && typeof instructions !== 'string') return bad(res, 'body.instructions must be a string');
  if (conversation_history !== undefined && !Array.isArray(conversation_history)) return bad(res, 'body.conversation_history must be an array');
  if (previous_response_id !== undefined && typeof previous_response_id !== 'string') return bad(res, 'body.previous_response_id must be a string');
  const bodyHash = hashBody({ input, session_id, instructions, conversation_history, previous_response_id });
  for (const [k, v] of Object.entries(idem)) if (Date.now() - v.ts > IDEM_TTL) delete idem[k]; // opportunistic prune
  const hit = idem[key];
  if (hit) {
    if (hit.bodyHash !== bodyHash) return res.status(409).json({ error: { code: 'idempotency_key_conflict', message: 'Idempotency-Key already used with a different body' } });
    const r = runs.get(hit.run_id);
    return res.status(202).set('Idempotency-Replayed', 'true').json({ run_id: hit.run_id, status: r ? r.status : (settled[hit.run_id]?.status || 'started') });
  }
  // task text: instructions + history + input
  let task = instructions ? `${instructions}\n\n${input}` : input;
  if (conversation_history?.length) task = conversation_history.map((m) => `${m.role || 'user'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n') + '\nuser: ' + input;
  // resolve dsh session: explicit > previous_response > session-key map > fresh
  let dshSession;
  const prev = previous_response_id && (runs.get(previous_response_id) || settled[previous_response_id]);
  if (session_id && sessMap['sid:' + session_id]) dshSession = sessMap['sid:' + session_id];
  else if (session_id) dshSession = sessMap['sid:' + session_id] = `dsh-${crypto.randomBytes(8).toString('hex')}`;
  else if (prev) dshSession = prev.session_id;
  else if (skey && sessMap[skey]) dshSession = sessMap[skey];
  let resume = Boolean(dshSession);
  if (dshSession && runningSessions.has(dshSession)) { dshSession = undefined; resume = false; } // concurrent runs never share a live session
  const run = { run_id: newId('run'), status: 'running', session_id: dshSession || `pending-${crypto.randomBytes(4).toString('hex')}`,
    output: '', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, events: [], subs: new Set(), proc: null, skey, sid: session_id };
  runs.set(run.run_id, run);
  idem[key] = { run_id: run.run_id, bodyHash, ts: Date.now() }; persistIdem();
  if (session_id) persistSess();
  const note = process.env.DSH_PREAMBLE === undefined
    ? 'You are executing a task issued by Paperclip through dsh-hermes-gateway. Do the work and put the final result in your reply.'
    : process.env.DSH_PREAMBLE;
  if (note) task = `[hermes run ${run.run_id}${skey ? ` session ${skey}` : ''}] ${note}\n\n${task}`; // harness-side awareness
  startRun(run, task, resume ? dshSession : undefined);
  res.json({ run_id: run.run_id, status: 'started' });
}
for (const p of ['/v1/runs', '/api/v1/runs']) app.post(p, authed, submit);

// ---- dsh execution ----
function startRun(run, task, dshSession) {
  const args = ['--profile', DSH_PROFILE, '--json'];
  if (dshSession) args.push('--session-id', dshSession);
  args.push(task);
  let proc;
  try { proc = spawn(DSH_BIN, args, { cwd: WORKSPACE, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); } // own process group so stop kills dsh + its children
  catch (e) { return settle(run, 'failed', `failed to spawn dsh: ${e.message}`); }
  run.proc = proc;
  if (dshSession) { runningSessions.add(dshSession); run.session_id = dshSession; }
  let buf = '';
  proc.stdout.on('data', (c) => { buf += c; const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) { if (!l.trim()) continue; try { onDsh(run, JSON.parse(l)); } catch {} } });
  proc.stderr.on('data', () => {}); // reasoning progress; not part of contract
  proc.on('error', (e) => settle(run, 'failed', `dsh error: ${e.message}`));
  proc.on('close', (code, sig) => {
    if (run.status !== 'running') return;
    if (run.stopping || sig || code === 130 || code === 143) settle(run, 'cancelled');
    else if (code === 0) { if (!run.output) settle(run, 'completed', ''); }
    else settle(run, 'failed', run.output || `dsh exited with code ${code}`);
  });
}
function onDsh(run, e) {
  if (run.status !== 'running') return;
  switch (e.type) {
    case 'session': run.session_id = e.sessionId || run.session_id;
      if (run.skey && !sessMap[run.skey]) { sessMap[run.skey] = run.session_id; persistSess(); }
      if (run.sid && !sessMap['sid:' + run.sid]) { sessMap['sid:' + run.sid] = run.session_id; persistSess(); }
      runningSessions.add(run.session_id); break;
    case 'tool_call': push(run, 'tool.started', { run_id: run.run_id, tool: e.tool, preview: preview(e.input), callId: e.callId }); break;
    case 'tool_result': push(run, 'tool.completed', { run_id: run.run_id, tool: e.tool || '', preview: preview(e.result), status: e.status || 'completed', callId: e.callId }); break;
    case 'text': run.output += e.text || ''; push(run, 'message.delta', { run_id: run.run_id, delta: e.text || '' }); break;
    case 'thinking': push(run, 'reasoning.delta', { run_id: run.run_id, delta: e.text || '' }); break;
    case 'status': if (e.usage) { const u = e.usage; run.usage = { input_tokens: u.inputTokens || 0, output_tokens: u.outputTokens || 0, total_tokens: u.totalTokens ?? (u.inputTokens || 0) + (u.outputTokens || 0) }; } break;
    case 'final': settle(run, 'completed', e.text || run.output); break;
    case 'error': settle(run, 'failed', e.message || 'dsh error'); break;
  }
}
function settle(run, status, output) {
  if (run.status !== 'running') return;
  run.status = status; if (output !== undefined) run.output = output;
  runningSessions.delete(run.session_id);
  settled[run.run_id] = { run_id: run.run_id, status, session_id: run.session_id, output: run.output }; persistRuns();
  push(run, 'run.completed', { run_id: run.run_id, status, output: run.output, usage: { input_tokens: run.usage.input_tokens, output_tokens: run.usage.output_tokens, total_tokens: run.usage.total_tokens }, runtime: { provider: 'deepseek', model: DSH_MODEL, route_source: 'global' } });
}

// ---- poll / events / stop ----
function findRun(req, res) {
  const r = runs.get(req.params.id) || settled[req.params.id];
  if (!r) { res.status(404).json({ error: { code: 'not_found', message: 'unknown run_id' } }); return null; }
  if (!runs.has(req.params.id)) { // rehydrate a settled run (e.g. after restart): synthesize its terminal event so SSE reconnect still terminates
    const m = { ...r, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, events: [], subs: new Set(), proc: null };
    runs.set(req.params.id, m); push(m, 'run.completed', { run_id: m.run_id, status: m.status, output: m.output || '', usage: m.usage, runtime: { provider: 'deepseek', model: DSH_MODEL, route_source: 'global' } }); return m;
  }
  return r;
}
const killRun = (r, sig) => { if (!r.proc) return; try { process.kill(-r.proc.pid, sig); } catch { try { r.proc.kill(sig); } catch {} } };
for (const p of ['/v1/runs/:id', '/api/v1/runs/:id'])
  app.get(p, authed, (req, res) => { const r = findRun(req, res); if (r) res.json(view(r)); });
for (const p of ['/v1/runs/:id/events', '/api/v1/runs/:id/events'])
  app.get(p, authed, (req, res) => {
    const r = findRun(req, res); if (!r) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    for (const line of r.events) res.write(line);
    if (r.status !== 'running') { res.end(); return; } // reconnect after settle: replay then close
    const keep = setInterval(() => res.write(': keepalive\n\n'), 10000);
    const sub = { write: (l) => res.write(l) }; r.subs.add(sub);
    req.on('close', () => { clearInterval(keep); r.subs.delete(sub); });
  });
for (const p of ['/v1/runs/:id/stop', '/api/v1/runs/:id/stop'])
  app.post(p, authed, (req, res) => {
    const r = runs.get(req.params.id) || settled[req.params.id];
    if (!r) return res.status(404).json({ error: { code: 'not_found', message: 'unknown run_id' } });
    if (r.status !== 'running' || !r.proc) return res.json({ status: r.status });
    r.stopping = true;
    killRun(r, 'SIGTERM'); setTimeout(() => { if (r.status === 'running') killRun(r, 'SIGKILL'); }, 5000);
    res.json({ status: 'stopping' });
  });

app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'unknown route' } }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return bad(res, 'invalid JSON body');
  res.status(500).json({ error: { code: 'internal', message: 'internal error' } });
});

const server = app.listen(PORT, '0.0.0.0', () => console.log(`dsh-hermes-gateway on 0.0.0.0:${PORT} workspace=${WORKSPACE} profile=${DSH_PROFILE}`));
const shutdown = () => { shuttingDown = true; console.log('dsh-hermes-gateway: shutting down');
  for (const r of runs.values()) if (r.status === 'running') killRun(r, 'SIGTERM');
  server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 30000).unref(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
