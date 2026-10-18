// dsh-hermes-gateway: Hermes API-server contract over `dsh --profile headless --json`.
// Env: DSH_GATEWAY_KEY (required), PORT (8642), DSH_WORKSPACE (cwd for runs),
//      DSH_BIN (dsh), DSH_PROFILE (headless), DSH_MODEL, DSH_GATEWAY_DATA (state dir).
'use strict';
const express = require('express');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader (no dependencies): real environment always wins.
const __envFile = process.env.DSH_GATEWAY_ENV || path.join(__dirname, '.env');
try {
  const __src = fs.readFileSync(__envFile, 'utf8');
  for (const __line of __src.split('\n')) {
    const __t = __line.trim();
    if (!__t || __t.startsWith('#')) continue;
    const __m = __t.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!__m || process.env[__m[1]] !== undefined) continue;
    let __v = __m[2].trim();
    if (__v.length >= 2 && ((__v[0] === '"' && __v[__v.length - 1] === '"') || (__v[0] === "'" && __v[__v.length - 1] === "'"))) __v = __v.slice(1, -1);
    process.env[__m[1]] = __v;
  }
} catch {}

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
let confirmed = load('confirmed.json', {}); // dsh-confirmed session ids -> first-seen ts (only ids dsh itself reported via a `session` event are ever passed as --session-id)
for (const [k, v] of Object.entries(idem)) if (Date.now() - v.ts > IDEM_TTL) delete idem[k];
const persistIdem = () => save('idempotency.json', idem);
const persistSess = () => save('sessions.json', sessMap);
const persistRuns = () => save('runs.json', settled);
let activeRuns = new Set(load('active.json', [])); // runs submitted but not yet settled (crash/restart recovery)
for (const id of activeRuns) if (!settled[id]) settled[id] = { run_id: id, status: 'failed', session_id: 'unknown', output: 'gateway restarted while this run was active; retry the task' };
if (activeRuns.size) { persistRuns(); logAct('error', `recovered ${activeRuns.size} run(s) active at shutdown as failed`); }
activeRuns = new Set();
const persistActive = () => save('active.json', [...activeRuns]);
const persistConfirmed = () => { // cap 500 oldest; dsh's store is source of truth, this is a pass-list hint
  const ks = Object.keys(confirmed);
  if (ks.length > 500) for (const k of ks.slice(0, ks.length - 500)) delete confirmed[k];
  save('confirmed.json', confirmed);
};
const noteConfirmed = (id) => { if (!id || confirmed[id]) return; confirmed[id] = Date.now(); persistConfirmed(); };

// ---- in-memory runs ----
const runs = new Map(); // run_id -> run
const runningSessions = new Set(); // dsh session ids with a live proc
let shuttingDown = false;
const newId = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const hashBody = (b) => crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex');
const trunc = (s, n = 500) => (s = String(s ?? ''), s.length > n ? s.slice(0, n - 1) + '…' : s); // total <= n
const redact = (s) => String(s ?? '').replace(/oc_sk_[A-Za-z0-9_-]+|sk-[A-Za-z0-9-_]{8,}|Bearer\s+[A-Za-z0-9\-._~+/=]+|api[_-]?key["'\s:=]+[^\s"',}]{4,}/gi, '[REDACTED]');
const preview = (v) => trunc(redact(typeof v === 'string' ? v : JSON.stringify(v)));

// ---- live admin dashboard (in-memory only; headless runs never appear in dsh web UI) ----
const BOOT_TS = Date.now();
const activity = []; // ring buffer: last 200 {ts, kind, detail}
const truncKey = (s, n = 120) => String(s ?? '').slice(0, n); // session keys truncated, never full-logged beyond 120
const tail = (s, n = 200) => { s = String(s ?? ''); return s.length > n ? '…' + s.slice(-(n - 1)) : s; }; // 200-char output tails
function logAct(kind, detail) {
  try {
    activity.push({ ts: new Date().toISOString(), kind, detail: String(detail ?? '').slice(0, 500) });
    if (activity.length > 200) activity.splice(0, activity.length - 200);
  } catch {}
}
const unhandledLogged = new Set(); // dsh event types with no handler, logged once each (protocol-drift visibility)

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { // access log: never log headers/auth, only method + path + status
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} -> ${res.statusCode}`);
    if (req.path === '/admin/api') return; // skip dashboard poll noise so the 200-entry ring keeps real history
    logAct('http', `${req.method} ${req.path} -> ${res.statusCode}`);
  });
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
  // resolve dsh session: confirmed session-key map > previous_response > fresh (omit flag).
  // dsh's --session-id is resume-only: an unknown id is a hard error ("does not exist;
  // omit --session-id to start a new Session"), never auto-created. So only ids dsh itself
  // confirmed via a prior `session` event are passed; fresh conversations omit the flag,
  // dsh assigns the id, and onDsh stores the mapping durably on the `session` event.
  let dshSession;
  const prev = previous_response_id && (runs.get(previous_response_id) || settled[previous_response_id]);
  const prevSid = prev && confirmed[prev.session_id] ? prev.session_id : undefined;
  const mappedSid = session_id && sessMap['sid:' + session_id];
  const mappedSkey = skey && sessMap[skey];
  if (mappedSid && confirmed[mappedSid]) dshSession = mappedSid;
  else if (prevSid) dshSession = prevSid;
  else if (mappedSkey && confirmed[mappedSkey]) dshSession = mappedSkey;
  // else fresh: omit --session-id entirely (see comment above)
  let resume = Boolean(dshSession);
  if (dshSession && runningSessions.has(dshSession)) { dshSession = undefined; resume = false; } // concurrent runs never share a live session
  const run = { run_id: newId('run'), status: 'running', session_id: dshSession || `pending-${crypto.randomBytes(4).toString('hex')}`,
    output: '', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, events: [], subs: new Set(), proc: null, skey, sid: session_id,
    finalText: '', finalArrived: false, turnReason: null, stderrTail: '' };
  runs.set(run.run_id, run);
  activeRuns.add(run.run_id); persistActive();
  logAct('run_started', `${run.run_id} session=${truncKey(run.skey || session_id || dshSession || '', 120)} resume=${resume}`);
  idem[key] = { run_id: run.run_id, bodyHash, ts: Date.now() }; persistIdem();
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
  catch (e) { logAct('error', `${run.run_id} spawn failed: ${String(e.message || e).slice(0, 200)}`); return settle(run, 'failed', `failed to spawn dsh: ${e.message}`); }
  run.proc = proc;
  if (dshSession) { runningSessions.add(dshSession); run.session_id = dshSession; }
  let buf = '';
  proc.stdout.on('data', (c) => { buf += c; const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) { if (!l.trim()) continue; try { onDsh(run, JSON.parse(l)); } catch {} } });
  proc.stderr.on('data', (c) => { run.stderrTail = (run.stderrTail + c.toString()).slice(-2000); }); // keep tail: turn-error diagnostics print here
  proc.on('error', (e) => { logAct('error', `${run.run_id} dsh error: ${String(e.message || e).slice(0, 200)}`); settle(run, 'failed', `dsh error: ${e.message}`); });
  proc.on('close', (code, sig) => {
    if (run.status !== 'running') return;
    if (buf.trim()) { try { onDsh(run, JSON.parse(buf)); } catch {} buf = ''; } // trailing line without newline
    if (run.status !== 'running') return; // flush may have settled via error event
    if (run.stopping || sig || code === 130 || code === 143) return settle(run, 'cancelled');
    // dsh emits exactly one of {final, error} then exits (0 = turn completed, 1 = turn/infra error),
    // but settle here regardless so a missing terminal event can never hang the run.
    const turnFailed = run.turnReason && run.turnReason.kind !== 'completed';
    if (code !== 0 || turnFailed) {
      const why = redact(run.stderrTail).trim()
        || (run.turnReason && run.turnReason.error ? `${run.turnReason.error.code || 'error'}: ${run.turnReason.error.message || ''}`.trim() : '')
        || run.finalText || run.output || `dsh exited with code ${code}`;
      return settle(run, 'failed', why);
    }
    settle(run, 'completed', run.finalText || run.output || '');
  });
}
function onDsh(run, e) {
  if (run.status !== 'running') return;
  switch (e.type) {
    case 'session': run.session_id = e.sessionId || run.session_id;
      if (e.sessionId) noteConfirmed(e.sessionId); // the ONLY source of passable --session-id values
      if (run.skey && !sessMap[run.skey]) { sessMap[run.skey] = run.session_id; persistSess(); }
      if (run.sid && !sessMap['sid:' + run.sid]) { sessMap['sid:' + run.sid] = run.session_id; persistSess(); }
      runningSessions.add(run.session_id); break;
    case 'tool_call': push(run, 'tool.started', { run_id: run.run_id, tool: e.tool, preview: preview(e.input), callId: e.callId }); logAct('tool', `${run.run_id} started ${String(e.tool || '').slice(0, 80)}`); break;
    case 'tool_result': push(run, 'tool.completed', { run_id: run.run_id, tool: e.tool || '', preview: preview(e.result), status: e.status || 'completed', callId: e.callId }); logAct('tool', `${run.run_id} completed ${String(e.tool || '').slice(0, 80)}`); break;
    case 'text': run.output += e.text || ''; push(run, 'message.delta', { run_id: run.run_id, delta: e.text || '' }); break;
    case 'thinking': push(run, 'reasoning.delta', { run_id: run.run_id, delta: e.text || '' }); break;
    case 'status': {
      if (e.usage) { const u = e.usage; run.usage = { input_tokens: u.inputTokens || 0, output_tokens: u.outputTokens || 0, total_tokens: u.totalTokens ?? (u.inputTokens || 0) + (u.outputTokens || 0) }; }
      if (e.phase === 'turn_end' && e.reason && typeof e.reason === 'object') run.turnReason = e.reason; // completed vs error decides settle
      break;
    }
    case 'final': run.output = e.text || run.output; run.finalText = e.text || ''; run.finalArrived = true; break; // settled on close with exit code + turn reason
    case 'error': {
      const m = /session "([^"]+)" does not exist/.exec(e.message || '');
      if (m) { // stale mapping (e.g. session never created, or pruned out-of-band): drop it + unconfirm so the next retry starts fresh instead of looping on the phantom
        let n = 0;
        for (const [k, v] of Object.entries(sessMap)) if (v === m[1]) { delete sessMap[k]; n++; }
        if (n) persistSess();
        if (confirmed[m[1]]) { delete confirmed[m[1]]; persistConfirmed(); }
        logAct('error', `${run.run_id} dsh reports unknown session ${truncKey(m[1])}; dropped ${n} mapping${n === 1 ? '' : 's'} — retry starts fresh`);
      }
      settle(run, 'failed', e.message || 'dsh error');
      break;
    }
    default: {
      if (e && typeof e.type === 'string' && !unhandledLogged.has(e.type)) { // future dsh event: visible, not silent
        unhandledLogged.add(e.type);
        const msg = `unhandled dsh event type=${JSON.stringify(e.type).slice(0, 80)} (protocol may have drifted)`;
        console.warn(`dsh-hermes-gateway: ${run.run_id} ${msg}`);
        logAct('error', `${run.run_id} ${msg}`);
      }
      break;
    }
  }
}
function settle(run, status, output) {
  if (run.status !== 'running') return;
  run.status = status; if (output !== undefined) run.output = output;
  runningSessions.delete(run.session_id);
  activeRuns.delete(run.run_id); persistActive();
  settled[run.run_id] = { run_id: run.run_id, status, session_id: run.session_id, output: run.output }; persistRuns();
  logAct(status === 'failed' ? 'error' : 'run_settled', `${run.run_id} -> ${status}`);
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
    logAct('stop', `${req.params.id} SIGTERM->SIGKILL`);
    killRun(r, 'SIGTERM'); setTimeout(() => { if (r.status === 'running') killRun(r, 'SIGKILL'); }, 5000);
    res.json({ status: 'stopping' });
  });

// ---- live admin dashboard (data behind bearer auth; headless runs are invisible in dsh web UI) ----
app.get('/admin/api', authed, (req, res) => {
  const memIds = new Set(runs.keys());
  const extra = Object.values(settled).filter((s) => !memIds.has(s.run_id));
  const all = [...runs.values()].map((r) => ({
    run_id: r.run_id, status: r.status, session_id: r.session_id,
    output_tail: tail(redact(r.output || '')),
    live: Boolean(r.proc && r.proc.exitCode === null && r.status === 'running'), // dsh proc still alive?
    usage: r.usage ? { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens, total_tokens: r.usage.total_tokens } : undefined,
  })).concat(extra.map((s) => ({
    run_id: s.run_id, status: s.status, session_id: s.session_id, output_tail: tail(redact(s.output || '')), live: false,
  })));
  res.json({
    uptime_s: Math.floor((Date.now() - BOOT_TS) / 1000),
    workspace: WORKSPACE, profile: DSH_PROFILE, model: DSH_MODEL,
    runs: all.slice(-50).reverse(),
    activity: activity.slice(-100).reverse(),
  });
});
const ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-hermes-gateway admin</title>
<style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:2em auto;padding:0 1em;color:#111}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#f2f2f2}code{font-size:12px;word-break:break-all}.tail{white-space:pre-wrap;max-width:480px}
#meta{color:#444;margin-bottom:1em}#err{color:#a00}</style></head>
<body><h1>dsh-hermes-gateway</h1>
<div id="meta">connecting…</div><div id="err"></div>
<h2>Runs (last 50)</h2><table><thead><tr><th>run_id</th><th>status</th><th>live</th><th>session</th><th>output tail (200ch)</th></tr></thead><tbody id="runs"></tbody></table>
<h2>Activity (last 100)</h2><table><thead><tr><th>ts</th><th>kind</th><th>detail</th></tr></thead><tbody id="act"></tbody></table>
<script>(function(){
var key = sessionStorage.getItem('dsh_gw_key') || window.prompt('Bearer key (DSH_GATEWAY_KEY):') || '';
if (key) sessionStorage.setItem('dsh_gw_key', key);
function el(id){ return document.getElementById(id); }
function td(text){ var d = document.createElement('td'); d.textContent = text; return d; }
async function poll(){
  try {
    var r = await window.fetch('/admin/api', { headers: { 'Authorization': 'Bearer ' + key } });
    if (r.status === 401) {
      sessionStorage.removeItem('dsh_gw_key');
      key = window.prompt('Bearer key (401 — try again):') || '';
      if (key) sessionStorage.setItem('dsh_gw_key', key);
      return;
    }
    var j = await r.json();
    el('meta').textContent = 'up ' + j.uptime_s + 's · workspace ' + j.workspace + ' · profile ' + j.profile + ' · model ' + j.model;
    var rb = el('runs'); rb.textContent = '';
    j.runs.forEach(function(run){
      var tr = document.createElement('tr');
      tr.appendChild(td(run.run_id)); tr.appendChild(td(run.status)); tr.appendChild(td(run.live ? 'yes' : '')); tr.appendChild(td(run.session_id));
      var t = document.createElement('td'); t.className = 'tail'; t.textContent = run.output_tail || ''; tr.appendChild(t);
      rb.appendChild(tr);
    });
    var ab = el('act'); ab.textContent = '';
    j.activity.forEach(function(a){
      var tr = document.createElement('tr');
      tr.appendChild(td(a.ts)); tr.appendChild(td(a.kind)); tr.appendChild(td(a.detail));
      ab.appendChild(tr);
    });
    el('err').textContent = '';
  } catch (e) { el('err').textContent = 'fetch error: ' + e; }
}
window.setInterval(poll, 2000); poll();
})();</script></body></html>`;
// NOTE: the HTML shell itself is unauthenticated on purpose — it contains no
// secrets, and requiring bearer auth here would make the browser render a bare
// 401 JSON on navigation so the in-page key prompt could never appear.
// All data stays behind bearer auth on /admin/api.
app.get('/admin', (req, res) => res.type('html').send(ADMIN_HTML));

app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'unknown route' } }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logAct('error', `${req.method} ${req.path} ${err?.type || err?.message || 'internal'}`.slice(0, 200));
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return bad(res, 'invalid JSON body');
  res.status(500).json({ error: { code: 'internal', message: 'internal error' } });
});

const server = app.listen(PORT, '0.0.0.0', () => console.log(`dsh-hermes-gateway on 0.0.0.0:${PORT} workspace=${WORKSPACE} profile=${DSH_PROFILE}`));
const shutdown = () => { shuttingDown = true; console.log('dsh-hermes-gateway: shutting down');
  for (const r of runs.values()) if (r.status === 'running') killRun(r, 'SIGTERM');
  server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 30000).unref(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
