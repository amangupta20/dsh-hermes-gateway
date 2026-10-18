# dsh-hermes-gateway

Hermes-compatible HTTP sidecar so **Paperclip** can drive **DeepSeek Harness (`dsh`)**
exactly like a built-in `hermes_gateway` agent — on a separate machine, with **no new
Paperclip adapter**. Point Paperclip's `hermes_gateway` type at this server.

How it works: the gateway exposes the Hermes API-server contract (runs + SSE) and
executes each task as `dsh --profile <DSH_PROFILE> --json [--session-id <id>] "<task>"`
in a subprocess. No Cordis internals are imported, so `dsh` rc breaking changes don't
kill it — only the headless CLI surface (`--json` event lines, `--session-id`) matters.

## Layout

- `server.js` — the whole gateway (~390 lines, `express` only)
- `package.json` — one dependency: `express`
- `dev-shim.sh` — DEV-ONLY fake `dsh` for offline contract tests. Never use in prod.

## Run

```bash
cd .  # repo root (gateway files live at the top level)
npm install
cp gateway.env.example gateway.env   # then edit gateway.env and set a real DSH_GATEWAY_KEY (openssl rand -hex 32)
node server.js         # listens on 0.0.0.0:8642 (Hermes default)
```

Config precedence: **real environment > `gateway.env` file > built-ins**. Values already
set in the environment are never overwritten by the file. To use a different file,
set `DSH_GATEWAY_ENV=/path/to/custom.env` (defaults to `./gateway.env` next to
`server.js`; `DSH_GATEWAY_ENV` itself is export-only). `gateway.env` is git-ignored;
only `gateway.env.example` is committed.

> **Why `gateway.env` and not `.env`?** dsh itself loads `./.env` from its working
> directory (which is our `DSH_WORKSPACE` for every spawned run) and **refuses all
> `DSH_*` names from any file** — bootstrap-only guard: only the inherited process
> environment may supply them (they decide how dsh starts, where its code loads
> from, how it reaches the network). A `DSH_*`-laden `.env` in the gateway directory
> makes *every* `dsh` invocation from there — spawned runs and manual smoke tests
> alike — die with ``sets "DSH_...", which only the launching environment may set``.
> So the gateway config lives in `gateway.env`, which dsh never reads; values reach
> spawned runs through the inherited environment (`export`, or the gateway's own
> loader setting `process.env` before spawn).

Alternative (no `.env` file — inline env one-liner):

```bash
DSH_GATEWAY_KEY='<long-random-secret>' \
DSH_WORKSPACE=/path/to/working/dir \
DSH_PROFILE=headless \
DSH_MODEL='muse-spark-1.3-contributor' \
PORT=8642 node server.js
```

Target machine needs the shipped `headless` profile working (no setup needed for the
template itself — just smoke-test it):

```bash
dsh --profile headless "say OK"   # answer goes to stdout; diagnostics to stderr
```

`headless` rides on `dsh-base`, so it does NOT inherit your `web` profile's
`cordis.patch.yml` model override. If the smoke test doesn't use your provider/model,
copy the `llm-pi-ai` + `agent-default-model` entries from
`$DSH_HOME/profiles/web/cordis.patch.yml` into the headless profile's patch file and
re-run the smoke test until it answers with the right model.

systemd hint: `Restart=always`, `EnvironmentFile=/etc/dsh-hermes-gateway.env`.

## Env

| Var | Required | Default | Meaning |
|---|---|---|---|
| `DSH_GATEWAY_KEY` | **yes** | — | Bearer key; must equal Paperclip's `apiKey`. Never logged. |
| `PORT` | no | `8642` | Listen port on `0.0.0.0`. |
| `DSH_WORKSPACE` | no | server cwd | cwd for every `dsh` run. Keep stable — headless `--session-id` resume requires the same cwd. |
| `DSH_BIN` | no | `dsh` | Path to the `dsh` binary (override for tests). |
| `DSH_PROFILE` | no | `headless` | `dsh` profile to drive. |
| `DSH_MODEL` | no | `muse-spark-1.3-contributor` | Model string reported in `runtime.model`. |
| `DSH_GATEWAY_DATA` | no | `./.dsh-hermes-gateway` | State dir: idempotency keys (24h TTL), session-key→dsh-session map, settled runs, dsh-confirmed session ids. |
| `DSH_GATEWAY_ENV` | no | `./gateway.env` (next to `server.js`) | Path to the config file to load. Real env always wins over this file. Must be exported, not filed; must never resolve to a `.env` dsh reads (see above). |
| `DSH_PREAMBLE` | no | (see below) | Context line prepended to every task so the harness agent knows it is serving a Paperclip Hermes run (includes run_id + session key). Set to empty to disable. |

## Contract notes

- Health (`GET /health`, `/api/health`, `/v1/health`) needs no auth. Everything else
  needs `Authorization: Bearer <DSH_GATEWAY_KEY>` (else 401).
- Every route is served under **both** `/v1/...` and `/api/v1/...` (Paperclip maps
  dashboard roots to `/api`, so single-prefix would 404 its probes). `GET /v1/runs`
  (and `/api/...`) returns **405** — POST-only proof.
- `POST /runs` body: `{input*, session_id?, instructions?, conversation_history?, previous_response_id?, model?, provider?}`.
  Bad bodies → `400 {"error":{"code":"invalid_params",...}}`.
- `Idempotency-Key` (1–255 visible ASCII) is stored durably 24h → run_id. Identical
  retry → `202` + `Idempotency-Replayed: true` + same run_id. Same key + different
  body → `409 {"error":{"code":"idempotency_key_conflict",...}}`.
- `X-Hermes-Session-Key` (≤256 chars, no CR/LF/NUL) maps e.g.
  `paperclip:company:<cid>:agent:<aid>:issue:<iid>` to one persistent dsh session id
  (durable across restarts): same issue resumes the same context, different issue is
  isolated. A key whose session is currently running starts an isolated run instead —
  **concurrent runs never share a live session**.
- Session resume is **pass-confirmed-ids-only**: dsh's `--session-id` is resume-only —
  an unknown id is a hard error (`session ... does not exist; omit --session-id to
  start a new Session`), never auto-created. So the gateway passes `--session-id`
  only for ids dsh itself reported via a prior `session` event (tracked in
  `confirmed.json`, capped at 500). Fresh conversations omit the flag; dsh assigns
  the id and the gateway maps it durably on the `session` event. If dsh ever reports
  an unknown session (stale map entry, out-of-band prune), the gateway drops the
  mapping and its confirmed status, so the next retry starts fresh instead of
  looping on the phantom. First run after upgrading from a version without
  `confirmed.json` starts one fresh session per conversation, then resumes normally.
- SSE `GET /runs/:id/events`: `tool.started` / `tool.completed` (preview ≤500 chars,
  secret-redacted), `message.delta`, `reasoning.delta`, terminal `run.completed`
  (usage + runtime). `: keepalive` comment every 10s. Stored per run, so reconnects
  replay from the start; settled runs replay then close.
- Turn outcome is honored, not assumed: dsh always ends a `--json` run with exactly
  one of `final` (then exit 0 = turn completed, exit 1 = turn error) or `error`
  (infrastructure failure, exit 1). The gateway captures the `turn_end` reason and
  the last 2KB of stderr (where dsh prints turn diagnostics like
  `dsh: <code>: <message>`), so a turn error settles the run `failed` with the real
  diagnostic instead of `completed` with an empty transcript. A clean exit with no
  terminal event still settles (completed with whatever output accumulated), and a
  trailing JSON line without newline is flushed on close — a missing terminal event
  can never hang a run in `running`. Unknown dsh event types are logged once each
  (gateway console + activity) so protocol drift is visible instead of silent.
- `active.json` tracks submitted-but-unsettled runs: after a gateway restart, any
  ids never settled are marked `failed` ("gateway restarted while this run was
  active") so polling them terminates instead of 404ing forever. (`/admin/api`
  run entries also carry `live`: whether the dsh proc is still alive.)
- `POST /runs/:id/stop` kills the whole `dsh` process group (SIGTERM → SIGKILL) and
  returns `{"status":"stopping"}`; the run settles to `cancelled`.
- SIGTERM/SIGINT: new submissions get `503` + `Retry-After: 5`, running procs are
  signalled, server exits when quiet (≤30s).

## Curl tests (all verified against `dev-shim.sh`)

```bash
BASE=http://127.0.0.1:8642; AUTH="Authorization: Bearer <key>"
# 1. health (no auth)
curl $BASE/health; curl $BASE/api/health            # -> {"status":"ok"}
# 2. models: 200 with key, 401 without
curl -H "$AUTH" $BASE/v1/models                     # -> [{"id":"dsh-agent","object":"model"}]
curl $BASE/v1/models                                # -> 401
# 3. POST-only proof
curl $BASE/v1/runs                                  # -> 405
# 4. submit -> poll -> replay -> conflict
curl -X POST -H "$AUTH" -H "Idempotency-Key: test-1" \
  -H "X-Hermes-Session-Key: paperclip:company:c1:agent:a1:issue:i1" \
  -d '{"input":"echo OK and list cwd"}' $BASE/v1/runs   # -> {"run_id":"run_...","status":"started"}
curl -H "$AUTH" $BASE/v1/runs/<run_id>                 # -> status completed + output + runtime
curl -X POST -H "$AUTH" -H "Idempotency-Key: test-1" \  # same body -> 202 + Idempotency-Replayed: true
  -d '{"input":"echo OK and list cwd"}' $BASE/v1/runs
curl -X POST -H "$AUTH" -H "Idempotency-Key: test-1" \  # diff body -> 409 idempotency_key_conflict
  -d '{"input":"other"}' $BASE/v1/runs
# 5. SSE (+ keepalive every 10s)
curl -N -H "$AUTH" $BASE/v1/runs/<run_id>/events
# 6. stop: submit {"input":"... sleep 60 ..."}, then:
curl -X POST -H "$AUTH" $BASE/v1/runs/<run_id>/stop   # -> {"status":"stopping"}
curl -H "$AUTH" $BASE/v1/runs/<run_id>                # -> status cancelled
```

## Live dashboard

Headless runs are one-shot `dsh` subprocesses, so they **never appear in the dsh
web UI**. The gateway ships its own live view instead:

- `GET /admin/api` (same `Bearer` auth) → JSON
  `{uptime_s, workspace, profile, model, runs[50], activity[100]}`. Run entries
  carry a 200-char `output_tail` and a `live` flag (dsh proc still alive); activity is an in-memory ring (last 200:
  `{ts, kind, detail}`, kinds `http|run_started|run_settled|tool|stop|error` —
  headers/auth are never logged, session keys truncated to 120 chars).
  The `/admin/api` poll itself is excluded from the `http` activity so the
  2s refresh doesn't push real history out of the ring.
- `GET /admin` → self-contained HTML page (no auth — it contains no secrets;
  requiring a bearer here would make the browser show a bare 401 instead of
  the page, so the key prompt could never appear). The page `fetch`-polls
  `/admin/api` every 2s. The key comes from `prompt()` (stored in
  `sessionStorage`); a 401 clears it and re-prompts. (`EventSource` can't set
  `Authorization` headers, hence polling instead of SSE here.) All run data
  stays behind bearer auth on `/admin/api`.

```bash
open http://127.0.0.1:8642/admin   # enter DSH_GATEWAY_KEY at the prompt
curl -H "Authorization: Bearer <key>" http://127.0.0.1:8642/admin/api | jq .
```

## The key: where `DSH_GATEWAY_KEY` comes from

**You generate it** — Paperclip never issues this secret. Verified against the
Paperclip repo (`paperclipai/paperclip`, `doc/HERMES_GATEWAY_ONBOARDING.md` and
`ui/src/lib/agent-onboarding-prompt.ts`): "generate a fresh random gateway key,
start Hermes with `API_SERVER_KEY=<random-gateway-key>`", and "Paperclip stores the
same value as `agentDefaultsPayload.apiKey`". The hire prompt pasted into the
external agent contains no secret — only onboarding URLs and the join flow.

1. Generate: `openssl rand -hex 32` (or any ≥32 random bytes).
2. Start the gateway with that exact value as `DSH_GATEWAY_KEY` (see Run above).
3. Submit the hire request to Paperclip (`POST /api/invites/:token/accept`, the
   "request to be hired") with the JSON below, putting the **same** value in
   `agentDefaultsPayload.apiKey`. From then on Paperclip calls the gateway with
   `Authorization: Bearer <that key>`.
4. Separate flow, separate secret: after board approval, claim a one-time
   Paperclip agent key (`POST /api/join-requests/:rid/claim-api-key`) for the
   gateway→Paperclip direction. Never reuse the gateway key as the Paperclip key.

Rotate by generating a fresh key, updating both the gateway env and Paperclip's
stored `apiKey`, and restarting the gateway.

## Paperclip hire JSON (you submit this — the gateway never calls it)

```json
{"requestType":"agent","agentName":"<my-name>","adapterType":"hermes_gateway","capabilities":"dsh harness agent","agentDefaultsPayload":{"apiBaseUrl":"http://<this-host>:8642","apiKey": "<DSH_GATEWAY_KEY>","paperclipApiUrl":"http://<paperclip>:3100","sessionKeyStrategy":"issue"}}
```
