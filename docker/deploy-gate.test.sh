#!/usr/bin/env sh
# deploy-gate.test.sh - behavioural test for docker/deploy-gate.sh (ADAAAA-7750 AC4).
#
# The gate is shell + curl + jq against the running server's
# `GET /admin/inflight-jobs`. A stub HTTP server stands in for the server so the
# decisions are proven without a box: idle, busy on a LIVE MEDIA session only
# (the case that used to report a clear runway), a read failure under both
# fail-open and fail-closed, and a missing token.
#
# Run: ./docker/deploy-gate.test.sh        (needs python3)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/deploy-gate.sh"
PORT="${GATE_TEST_PORT:-18080}"
BODY_FILE="$(mktemp)"
STATUS_FILE="$(mktemp)"
SERVER_LOG="$(mktemp)"
FAILS=0

trap 'kill "${STUB_PID:-}" 2>/dev/null; rm -f "$BODY_FILE" "$STATUS_FILE" "$SERVER_LOG"' EXIT INT TERM

printf '{"inflight":[],"liveSessions":[]}' > "$BODY_FILE"
printf '200' > "$STATUS_FILE"

python3 - "$PORT" "$BODY_FILE" "$STATUS_FILE" >"$SERVER_LOG" 2>&1 <<'PY' &
import http.server, socketserver, sys
port, body_file, status_file = int(sys.argv[1]), sys.argv[2], sys.argv[3]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        status = int(open(status_file).read().strip() or "200")
        if status != 200:
            self.send_response(status); self.end_headers(); self.wfile.write(b'{"error":"stub"}'); return
        # Any request without the exact bearer the gate should send is a 401,
        # which is what the committed `Bearer ***` artifact used to do always.
        if self.headers.get("Authorization") != "Bearer test-token":
            self.send_response(401); self.end_headers(); self.wfile.write(b'{"error":"unauthorized"}'); return
        body = open(body_file, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", port), H) as s:
    s.serve_forever()
PY
STUB_PID=$!
sleep 1

run_gate() {
  # run_gate <expected-exit> <expected-substring> [env assignments...]
  expected_exit="$1"; expected_line="$2"; shift 2
  out="$(env HIGHLIGHTS_API_BASE="http://127.0.0.1:$PORT" HIGHLIGHTS_ADMIN_TOKEN=test-token \
        HIGHLIGHTS_ADMIN_TOKEN_FILE=/nonexistent DEPLOY_GATE_POLL_S=1 DEPLOY_GATE_MAX_WAIT_S=2 \
        "$@" sh "$GATE" 2>/dev/null)"
  code=$?
  if [ "$code" != "$expected_exit" ]; then
    printf 'FAIL exit=%s expected=%s :: %s\n' "$code" "$expected_exit" "$out"; FAILS=$((FAILS+1)); return
  fi
  case "$out" in
    *"$expected_line"*) printf 'ok   %s\n' "$out" ;;
    *) printf 'FAIL line missing [%s] :: %s\n' "$expected_line" "$out"; FAILS=$((FAILS+1)) ;;
  esac
}

# 1. Both surfaces idle -> proceed immediately.
run_gate 0 "decision=proceed reason=idle inflight=0 live_sessions=0" DEPLOY_GATE_ENABLED=1

# 2. A LIVE media session with an empty analyze queue -> wait, then bounded proceed.
printf '{"inflight":[],"liveSessions":[{"jobId":"job-live","sessionId":"s1","status":"active"}]}' > "$BODY_FILE"
run_gate 0 "decision=proceed reason=max-wait-timeout inflight=0 live_sessions=1" DEPLOY_GATE_ENABLED=1

# 3. Busy analyze queue is still covered.
printf '{"inflight":[{"id":"job-analyze"}],"liveSessions":[]}' > "$BODY_FILE"
run_gate 0 "decision=proceed reason=max-wait-timeout inflight=1 live_sessions=0" DEPLOY_GATE_ENABLED=1

# 4. Read failure, fail-open (default): proceed and say so.
printf '{"inflight":[],"liveSessions":[]}' > "$BODY_FILE"
printf '500' > "$STATUS_FILE"
run_gate 0 "decision=proceed reason=read-failure" DEPLOY_GATE_ENABLED=1 DEPLOY_GATE_FAIL_CLOSED=0

# 5. Read failure, fail-closed (what docker/deploy.sh sets): refuse.
run_gate 3 "decision=block reason=read-failure" DEPLOY_GATE_ENABLED=1 DEPLOY_GATE_FAIL_CLOSED=1
printf '200' > "$STATUS_FILE"

# 6. A wrong token is a read failure, not a gate that silently passes on 401.
run_gate 3 "decision=block reason=read-failure" DEPLOY_GATE_ENABLED=1 DEPLOY_GATE_FAIL_CLOSED=1 HIGHLIGHTS_ADMIN_TOKEN=wrong-token

# 7. Explicit bypass is logged, never silent.
run_gate 0 "decision=proceed reason=bypassed" DEPLOY_GATE_ENABLED=0

if [ "$FAILS" -ne 0 ]; then
  printf '\n%d gate case(s) FAILED\n' "$FAILS"
  exit 1
fi
printf '\nall deploy-gate cases passed\n'
