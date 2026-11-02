#!/usr/bin/env sh
# deploy.sh - the only supported way to ship highlights.live to the box.
#
# ADAAAA-7750 AC4: a `docker compose up -d --build` recreates `highlights-media`
# (and the perceive runner) unconditionally. If a customer is screen-sharing at
# that moment the share dies with the container and the job lands as
# `media-session-lost` - or, as the board saw, as a job whose page simply says
# "no analysis windows". This wrapper makes the gate part of the deploy instead
# of a step someone has to remember:
#
#   1. prove the read-only admin token exists (no silent skip),
#   2. run docker/deploy-gate.sh fail-closed and PRINT its decision line,
#   3. only then rebuild + recreate.
#
# Usage (from the box repo root, e.g. /home/brad/highlights.live):
#   ./docker/deploy.sh                 # whole stack
#   ./docker/deploy.sh media server    # named services only
#
# Env:
#   DEPLOY_GATE_MAX_WAIT_S  (300)  wait for in-flight analyze jobs / live shares
#   DEPLOY_GATE_POLL_S      (15)
#   HIGHLIGHTS_API_BASE     (http://localhost:3000) the RUNNING server
#   HIGHLIGHTS_ADMIN_TOKEN_FILE (~/.highlights_admin_readonly_token)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
COMPOSE="docker/docker-compose.yml"
TOKEN_FILE="${HIGHLIGHTS_ADMIN_TOKEN_FILE:-$HOME/.highlights_admin_readonly_token}"

if [ -z "${HIGHLIGHTS_ADMIN_TOKEN:-}" ] && [ ! -r "$TOKEN_FILE" ]; then
  # Deploying blind is exactly the failure this wrapper exists to stop.
  printf 'DEPLOY GATE: decision=block reason=no-admin-token inflight=0 live_sessions=0 waited=0s\n'
  printf 'deploy: no read-only admin token at %s; refusing to recreate without a gate read\n' "$TOKEN_FILE" >&2
  exit 3
fi

BUILD_REF="$(git rev-parse --short HEAD)"
SERVICES="$*"

printf 'deploy: revision %s, services %s\n' "$BUILD_REF" "${SERVICES:-all}"

# The gate's decision line lands on stdout; a non-zero exit means it refused.
DEPLOY_GATE_ENABLED=1 \
DEPLOY_GATE_FAIL_CLOSED=1 \
HIGHLIGHTS_ADMIN_TOKEN_FILE="$TOKEN_FILE" \
  ./docker/deploy-gate.sh

if [ -n "$SERVICES" ]; then
  BUILD_REF="$BUILD_REF" docker compose -f "$COMPOSE" up -d --build $SERVICES
else
  BUILD_REF="$BUILD_REF" docker compose -f "$COMPOSE" up -d --build
fi

printf 'deploy: recreated (%s) from %s\n' "${SERVICES:-all}" "$BUILD_REF"
printf 'deploy: served revision -> %s\n' "$(git rev-parse HEAD)"
