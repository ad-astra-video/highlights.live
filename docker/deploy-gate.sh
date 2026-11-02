#!/usr/bin/env sh
# deploy-gate.sh - staged-deploy gate for BOTH pipelines a recreate can strand.
#
# Run this BEFORE `docker compose -f docker/docker-compose.yml up -d --build` on
# the box. Two different in-flight surfaces have to be idle:
#
#   1. the capacity-1 highlights-perceive runner (ADAAAA-7203). Recreating it
#      mid-pass drops the analyze session (used to surface as `analyze failed:
#      HTTP 502` and burn the whole re-run).
#   2. LIVE MEDIA sessions (ADAAAA-7750). A `highlights-media` recreate lands
#      mid-share as `media-session-lost` on the job (ADAAAA-7700) and kills the
#      customer's share, even when the analyze queue is empty - which is why a
#      gate that only read `/admin/inflight-jobs`'s `inflight` array reported a
#      clear runway during a live screen share.
#
# Both surfaces are reported by the running server's `GET /admin/inflight-jobs`
# (`inflight` = mid-analysis jobs, `liveSessions` = `active` media_sessions
# rows). One read, one decision, one printed line.
#
# ENABLED BY DEFAULT (ADAAAA-7750): the gate used to be opt-in
# (`DEPLOY_GATE_ENABLED=1`), which is the same as not having it on any deploy
# nobody remembered to instrument. Set DEPLOY_GATE_ENABLED=0 to bypass it
# deliberately - the bypass is logged with its reason so the deploy log shows it.
#
# Bounded: waits up to DEPLOY_GATE_MAX_WAIT_S (default 300) for both surfaces to
# drain, then proceeds with the still-busy ids in the log (the in-flight
# resilience re-reserves a perceive session, and a live share at least gets an
# honest, named failure instead of a silent empty window list).
#
# Read failures are fail-open by default (a monitoring/config problem must never
# strand a deploy) and fail-closed when DEPLOY_GATE_FAIL_CLOSED=1 - which is what
# `docker/deploy.sh` sets, because it verifies the token before calling the gate.
#
# Every run prints ONE decision line to stdout:
#   DEPLOY GATE: decision=proceed reason=idle inflight=0 live_sessions=0 waited=0s
#
# Env:
#   DEPLOY_GATE_ENABLED          =0 to bypass (default: enabled)
#   DEPLOY_GATE_MAX_WAIT_S       max seconds to wait for busy surfaces (300)
#   DEPLOY_GATE_POLL_S           poll interval in seconds (15)
#   DEPLOY_GATE_FAIL_CLOSED      =1 to exit 3 when the read fails (0)
#   HIGHLIGHTS_API_BASE          server base URL the RUNNING server serves (http://localhost:3000)
#   HIGHLIGHTS_ADMIN_TOKEN       admin_readonly bearer token (overrides the file)
#   HIGHLIGHTS_ADMIN_TOKEN_FILE  path to a file holding the token (~/.highlights_admin_readonly_token)
set -u

log() { printf 'DEPLOY GATE: %s\n' "$1" >&2; }
# decision=... goes to STDOUT so a deploy transcript can grep exactly one line.
decide() { printf 'DEPLOY GATE: decision=%s reason=%s inflight=%s live_sessions=%s waited=%ss%s\n' "$1" "$2" "$3" "$4" "$5" "${6:+ ids=$6}"; }

if [ "${DEPLOY_GATE_ENABLED:-1}" != "1" ]; then
  log "bypassed (DEPLOY_GATE_ENABLED=0); a recreate may strand a live share"
  decide proceed bypassed 0 0 0
  exit 0
fi

MAX_WAIT="${DEPLOY_GATE_MAX_WAIT_S:-300}"
POLL="${DEPLOY_GATE_POLL_S:-15}"
API_BASE="${HIGHLIGHTS_API_BASE:-http://localhost:3000}"
FAIL_CLOSED="${DEPLOY_GATE_FAIL_CLOSED:-0}"
URL="$API_BASE/admin/inflight-jobs"

# Resolve the read-only admin token (bounded credential accepted on GET only).
TOKEN="${HIGHLIGHTS_ADMIN_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN_FILE="${HIGHLIGHTS_ADMIN_TOKEN_FILE:-$HOME/.highlights_admin_readonly_token}"
  if [ -r "$TOKEN_FILE" ]; then
    TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  fi
fi

is_numeric() { case "$1" in ''|*[!0-9]*) return 1;; *) return 0;; esac; }
if ! is_numeric "$MAX_WAIT"; then MAX_WAIT=300; fi
if ! is_numeric "$POLL"; then POLL=15; fi

on_read_failure() {
  if [ "$FAIL_CLOSED" = "1" ]; then
    log "cannot query $URL ($1) and DEPLOY_GATE_FAIL_CLOSED=1; refusing to recreate mid-share"
    decide block read-failure 0 0 0
    exit 3
  fi
  log "cannot query $URL ($1); proceeding (fail-open by default - set DEPLOY_GATE_FAIL_CLOSED=1 to block)"
  decide proceed read-failure 0 0 0
  exit 0
}

if [ -z "$TOKEN" ]; then
  on_read_failure "no admin token (HIGHLIGHTS_ADMIN_TOKEN / $TOKEN_FILE unset)"
fi

log "enabled; max wait ${MAX_WAIT}s, poll ${POLL}s, api $URL"

# fetch_counts: prints "<inflight> <live_sessions> <busy ids>" on stdout, returns
# 0 on a successful 2xx read and 1 on any read/parse failure.
fetch_counts() {
  out="$(mktemp)" || return 1
  # ADAAAA-7750: this header used to be committed as the literal `Bearer ***`
  # (a redacted-token artifact), so every read answered 401 and the gate always
  # fail-opened "proceeding" - it never gated anything. The real token variable
  # is interpolated here.
  code="$(curl -sS -m 10 -o "$out" -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' "$URL" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then
    parsed="$(jq -r '
      [ ((.inflight // []) | length),
        ((.liveSessions // []) | length),
        (([ (.inflight // [])[] | .id ] + [ (.liveSessions // [])[] | ("live:" + (.jobId // "?")) ]) | join(","))
      ] | @tsv' "$out" 2>/dev/null || echo '')"
    if [ -n "$parsed" ]; then
      printf '%s' "$parsed"
      rm -f "$out"
      return 0
    fi
  fi
  rm -f "$out"
  return 1
}

started="$(date +%s)"
while :; do
  counts="$(fetch_counts)"
  status=$?
  if [ "$status" -ne 0 ]; then
    on_read_failure "HTTP/timeouts"
  fi
  inflight="$(printf '%s' "$counts" | cut -f1)"
  live="$(printf '%s' "$counts" | cut -f2)"
  ids="$(printf '%s' "$counts" | cut -f3)"
  now="$(date +%s)"
  elapsed=$(( now - started ))

  if [ "$inflight" = "0" ] && [ "$live" = "0" ]; then
    log "no in-flight analyze jobs and no live media sessions; proceeding with deploy"
    decide proceed idle 0 0 "$elapsed"
    exit 0
  fi

  log "busy: inflight analyze=${inflight} live media sessions=${live} (${ids:-none}); waited ${elapsed}s"
  if [ "$elapsed" -ge "$MAX_WAIT" ]; then
    log "MAX WAIT ${MAX_WAIT}s reached with ${inflight} analyze + ${live} live session(s) still active; proceeding (a recreated media node fails the share honestly rather than silently)"
    decide proceed max-wait-timeout "$inflight" "$live" "$elapsed" "$ids"
    exit 0
  fi
  sleep "$POLL"
done
