#!/usr/bin/env sh
# deploy-gate.sh — staged-deploy gate for the capacity-1 highlights-perceive runner.
#
# Run this BEFORE `docker compose -f docker/docker-compose.yml up -d --build` on the
# box (or before recreating highlights-perceive specifically) so a staged deploy
# does not recreate the perceive container while a VOD/live analyze job is
# mid-pass and drop the session (which used to surface as `analyze failed: HTTP
# 502` and burn the whole re-run — ADAAAA-7203).
#
# Opt-in: the gate only blocks/waits when DEPLOY_GATE_ENABLED=1. With it unset the
# gate is disabled and the deploy proceeds — it never blocks an uninstrumented
# deploy and never blocks a deploy indefinitely.
#
# Bounded + logged: waits up to DEPLOY_GATE_MAX_WAIT_S (default 300) for in-flight
# jobs (GET /admin/inflight-jobs) to drain. It NEVER blocks indefinitely: on
# timeout it logs the in-flight job(s) and proceeds (the in-flight resilience in
# the server re-reserves a fresh perceive session on a dropped session instead of
# losing the job to a generic 502).
#
# Fail-open: if the admin endpoint is unavailable (pre-gate server, missing token,
# server down) the gate logs a clear reason and proceeds, so a monitoring/config
# problem can never strand a deploy.
#
# Env:
#   DEPLOY_GATE_ENABLED          =1 to enable (default: disabled / proceed)
#   DEPLOY_GATE_MAX_WAIT_S       max seconds to wait for in-flight jobs (300)
#   DEPLOY_GATE_POLL_S           poll interval in seconds (15)
#   HIGHLIGHTS_API_BASE          server base URL the RUNNING server serves (http://localhost:3000)
#   HIGHLIGHTS_ADMIN_TOKEN       admin_readonly bearer token (overrides the file)
#   HIGHLIGHTS_ADMIN_TOKEN_FILE  path to a file holding the token (~/.highlights_admin_readonly_token)
set -u

log() { printf 'DEPLOY GATE: %s\n' "$1" >&2; }

if [ "${DEPLOY_GATE_ENABLED:-0}" != "1" ]; then
  log "disabled (DEPLOY_GATE_ENABLED!=1); proceeding without gate"
  exit 0
fi

MAX_WAIT="${DEPLOY_GATE_MAX_WAIT_S:-300}"
POLL="${DEPLOY_GATE_POLL_S:-15}"
API_BASE="${HIGHLIGHTS_API_BASE:-http://localhost:3000}"
URL="$API_BASE/admin/inflight-jobs"

# Resolve the read-only admin token (bounded credential accepted on GET only).
TOKEN="${HIGHLIGHTS_ADMIN_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN_FILE="${HIGHLIGHTS_ADMIN_TOKEN_FILE:-$HOME/.highlights_admin_readonly_token}"
  if [ -r "$TOKEN_FILE" ]; then
    TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  fi
fi
if [ -z "$TOKEN" ]; then
  log "no admin token (HIGHLIGHTS_ADMIN_TOKEN / $TOKEN_FILE unset); proceeding (gate not enforced)"
  exit 0
fi

is_numeric() { case "$1" in ''|*[!0-9]*) return 1;; *) return 0;; esac; }
if ! is_numeric "$MAX_WAIT"; then MAX_WAIT=300; fi
if ! is_numeric "$POLL"; then POLL=15; fi

IDS_FILE="$(mktemp)" || exit 1
# fetch_inflight: on a successful 2xx read prints the in-flight COUNT on stdout
# and writes the job ids to $IDS_FILE; returns 0. On any read failure logs a
# clear reason (to stderr, so it is never swallowed by command substitution)
# and returns 1.
fetch_inflight() {
  out="$(mktemp)" || return 1
  code="$(curl -sS -m 10 -o "$out" -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' "$URL" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then
    count="$(jq -r '.inflight | length' "$out" 2>/dev/null || echo '')"
    if [ -n "$count" ] && is_numeric "$count"; then
      jq -r '.inflight[].id' "$out" 2>/dev/null > "$IDS_FILE"
      rm -f "$out"
      printf '%s' "$count"
      return 0
    fi
  fi
  rm -f "$out"
  log "cannot query $URL (HTTP ${code:-timeout}); proceeding (resilience will re-reserve on any dropped session)"
  return 1
}

log "enabled; max wait ${MAX_WAIT}s, poll ${POLL}s, api $URL"
started="$(date +%s)"
while :; do
  count="$(fetch_inflight)"
  status=$?
  if [ "$status" -eq 0 ]; then
    if [ "$count" = "0" ]; then
      log "no in-flight analyze jobs; proceeding with deploy"
      rm -f "$IDS_FILE"
      exit 0
    fi
    now="$(date +%s)"
    elapsed=$(( now - started ))
    ids="$(tr '\n' ' ' < "$IDS_FILE")"
    log "in-flight analyze job(s) active (n=$count: $ids); waited ${elapsed}s"
    if [ "$elapsed" -ge "$MAX_WAIT" ]; then
      log "MAX WAIT ${MAX_WAIT}s reached with in-flight job(s) still active (n=$count); proceeding (in-flight resilience re-reserves on session-drop)"
      rm -f "$IDS_FILE"
      exit 0
    fi
    sleep "$POLL"
  else
    rm -f "$IDS_FILE"
    exit 0
  fi
done
