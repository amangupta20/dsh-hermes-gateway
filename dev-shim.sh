#!/usr/bin/env bash
# DEV-ONLY shim emulating `dsh --profile headless --json` for offline contract tests.
# Real deploy: DSH_BIN=dsh DSH_PROFILE=headless. Never ship this to Paperclip.
sid=""; task=""
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) shift 2;;
    --json) shift;;
    --session-id) sid="$2"; shift 2;;
    *) task="$task $1"; shift;;
  esac
done
[ -z "$sid" ] && sid="dsh-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
echo "{\"type\":\"session\",\"sessionId\":\"$sid\",\"cwd\":\"$PWD\"}"
echo '{"type":"status","phase":"turn_start","turn":1}'
echo '{"type":"tool_call","callId":"c1","tool":"exec","input":{"cmd":"echo OK"}}'
echo '{"type":"tool_result","callId":"c1","status":"completed","result":"OK"}'
echo '{"type":"text","text":"mock output for task:'"$(echo "$task" | head -c 120)"'"}'
if echo "$task" | grep -q "sleep 60"; then sleep 60; fi
if echo "$task" | grep -q "fail-turn"; then # emulate a turn error: empty final + non-zero exit, like a model/provider failure
  echo '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"code":"PROVIDER_ERROR","message":"boom"}}}'
  echo '{"type":"final","text":""}'
  exit 1
fi
echo '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}'
echo '{"type":"final","text":"mock output done"}'
