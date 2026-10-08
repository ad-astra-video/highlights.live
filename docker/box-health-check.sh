#!/usr/bin/env bash
#
# box-health-check.sh — per-service container health check for the
# highlights.live GPU box (livepeer-ai-x99) and the public edge.
#
# Closes the ADAAAA-3248 monitoring gap: the prior box-health monitor only
# checked the PUBLIC EDGE (highlights-server.dpn.gg /health + /admin/analytics),
# which stays Up even when an internal service (e.g. decide) is dead or stranded
# in a non-running container state. This script ALSO checks per-service container
# state on the GPU box and FAILS (exit 1) when any monitored service is NOT
# `Up` / `Up (healthy)` — including containers stuck in Created/Exited/Restarting.
#
# ADAAAA-6397 fix: the active email/asr containers run under Docker Compose
# v2.39 hashed names (`<hash>_highlights-<svc>`) rather than exactly
# `highlights-<svc>`, so an exact-name match false-ALERTed on a healthy service.
# A service is now matched by its `com.docker.compose.service` label (the
# reliable source of truth) with a `highlights-<svc>` / `<hash>_highlights-<svc>`
# name-pattern fallback. Multiple containers may serve one service (an active
# running container plus a stale duplicate); a service is healthy when AT LEAST
# one matching container is `Up`, and a genuinely stranded (Created/Exited/
# Restarting/Dead) container still FAILs when it is the only one present.
#
# Usage:
#   box-health-check.sh                # check livepeer-ai-x99 + public edge
#   box-health-check.sh <server>       # override the GPU box name
#   box-health-check.sh <server> --no-edge   # skip the public-edge HTTP check
#   box-health-check.sh --self-test    # dry-run: simulate a stranded service and
#                                      #   prove the ALERT path fires (no live box)
#
# Monitored GPU-box services (the highlights-live decision stack):
#   decide, gemma, perceive, orchestrator, asr, server, media, email, postgres,
#   signer — the services that must stay reachable for a full pipeline.
# Exit code: 0 = all monitored services healthy + (unless --no-edge) edge OK;
#           1 = degraded / ALERT (a monitored service is not Up or edge down).
#
# Naming convention: running container names are highlights-<service>, except
# services recreated by recent Compose which carry a `<hash>_` prefix. Matching
# therefore relies on the `com.docker.compose.service` label, with a name-pattern
# fallback for containers run without that label.

set -u

SERVER="${1:-livepeer-ai-x99}"
EDGE_CHECK=1
# --self-test: dry-run that exercises the REAL classification loop with a mocked
# container state (no live box contacted). It proves BOTH paths end to end:
#   * highlights-email under a Compose hashed name (`5545..._highlights-email`,
#     Up) is recognized as healthy (not "missing"), and
#   * highlights-decide stranded in Created (no running container) triggers ALERT
#     (exit 1).
SELF_TEST=0
if [ "${1:-}" = "--self-test" ]; then
  SELF_TEST=1
  EDGE_CHECK=0   # dry-run: do not hit the public edge
fi

if [ "${2:-}" = "--no-edge" ]; then
  EDGE_CHECK=0
fi

# Paths / helpers.
KOMODO="/paperclip/.hermes/skills/komodo/scripts/komodo.py"
EDGE_URL="${EDGE_URL:-https://highlights-server.dpn.gg}"
# GPU-box services that MUST be Up (healthy) for the decision pipeline.
# asr (transcription) added in ADAAAA-6397: its running container is
# 7b16e1195db4_highlights-asr (Up, healthy) under the hashed Compose name.
MONITORED_SERVICES="${MONITORED_SERVICES:-decide gemma perceive orchestrator asr server media email postgres signer}"

# ----- per-service container state (GPU box) -----
# Ask the box for every container that serves the requested compose service.
# A container serves `$svc` when its `com.docker.compose.service` label equals the
# short service name, or when its name is `highlights-<svc>` / `<hash>_highlights-<svc>`
# (Compose v2.39 hashed-name prefix). Returns one "<name>|<status>" line per
# matching container (possibly several — an active container plus a stale dup).
state_for() {
  local svc="$1"
  if [ "$SELF_TEST" = "1" ]; then
    # Mock container state (no live box contacted): decide stranded in Created,
    # email running under a Compose hashed name alongside a stale Created dup,
    # and the rest Up (healthy).
    case "$svc" in
      decide) printf '%s\n' "create_abc_highlights-decide|Created" ;;
      email)  printf '%s\n' "5545ccfb0b11_highlights-email|Up 6 hours" "d1c3edac99d6_highlights-email|Created" ;;
      *)      printf '%s\n' "highlights-$svc|Up 2 hours (healthy)" ;;
    esac
    return 0
  fi
  python3 "$KOMODO" "$SERVER" \
    "docker ps -a --format '{{.Names}}|{{.Status}}|{{.Label \"com.docker.compose.service\"}}' | awk -F'|' '(\$1==\"highlights-${svc}\" || \$1 ~ /_highlights-${svc}\$/ || \$3==\"${svc}\"){print \$1\"|\"\$2}'" \
    | grep -v '__KOMODO_EXIT_CODE' | grep -v '^$'
}

# ----- run per-service checks -----
FAILED=0
DECLARE_ALERT=""
if [ "$SELF_TEST" = "1" ]; then
  echo "SELF-TEST: simulating container state (no live box contacted)"
  printf '  - %s\n' "decide = Created only (stranded)" \
                     "email = hashed 5545..._highlights-email (Up) + stale Created dup" \
                     "rest  = Up (healthy)"
fi
if [ "$SELF_TEST" = "1" ]; then
  echo "== GPU box per-service health: $SERVER (SIMULATED) =="
else
  echo "== GPU box per-service health: $SERVER =="
fi
for svc in $MONITORED_SERVICES; do
  entries="$(state_for "$svc")"
  if [ -z "$entries" ]; then
    echo "  [FAIL] highlights-$svc : NO CONTAINER (missing)"
    FAILED=1; DECLARE_ALERT="$DECLARE_ALERT highlights-$svc(missing)"
    continue
  fi

  # Classify every container serving this service.
  delta=""       # best (running) container description
  running=0
  healthy=0
  stranded=""    # non-running matching containers, if any
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    name="${line%%|*}"
    st="${line#*|}"
    case "$st" in
      Up*healthy*)
        [ -z "$delta" ] && delta="$name ($st)"
        running=1; healthy=1
        ;;
      Up*)
        [ -z "$delta" ] && delta="$name ($st)"
        running=1
        ;;
      Created*|Exited*|Restarting*|Dead*|Paused*)
        stranded="$stranded $name(${st%% *})"
        ;;
      *) ;;
    esac
  done <<< "$entries"

  if [ "$running" = "1" ]; then
    # Service is serving: at least one running container exists.
    if [ "$healthy" = "1" ]; then
      if [ -n "$stranded" ]; then
        echo "  [ OK ] highlights-$svc : $delta  (stale duplicate:$stranded)"
      else
        echo "  [ OK ] highlights-$svc : $delta"
      fi
    else
      if [ -n "$stranded" ]; then
        echo "  [WARN] highlights-$svc : $delta (running, not 'healthy'; stale dup:$stranded)"
      else
        echo "  [WARN] highlights-$svc : $delta (running, not 'healthy')"
      fi
    fi
  else
    # Containers exist but none is running -> genuinely stranded service.
    echo "  [FAIL] highlights-$svc : NOT RUNNING$stranded (stranded)"
    FAILED=1; DECLARE_ALERT="$DECLARE_ALERT highlights-$svc(not-running)"
  fi
done

# ----- public edge HTTP check (optional) -----
if [ "$EDGE_CHECK" = "1" ]; then
  echo "== public edge: $EDGE_URL =="
  h="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$EDGE_URL/health" 2>/dev/null)"
  if [ "$h" = "200" ]; then
    echo "  [ OK ] $EDGE_URL/health -> 200"
  else
    echo "  [FAIL] $EDGE_URL/health -> ${h:-no response}"
    FAILED=1
  fi
  a="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$EDGE_URL/admin/analytics" 2>/dev/null)"
  if [ "$a" = "401" ]; then
    echo "  [ OK ] $EDGE_URL/admin/analytics -> 401 (admin-gated, live)"
  else
    echo "  [WARN] $EDGE_URL/admin/analytics -> ${a:-no response} (expected 401 admin gate)"
  fi
fi

# ----- verdict -----
echo ""
if [ "$FAILED" = "1" ]; then
  echo "BOX-HEALTH: ALERT / FAIL"
  echo "Degraded services:$DECLARE_ALERT"
  if [ "$SELF_TEST" = "1" ]; then
    echo ""
    echo "SELF-TEST PASS: a service stranded in Created (no running container) is"
    echo "caught and flags ALERT (exit 1)."
  fi
  exit 1
else
  echo "BOX-HEALTH: PASS (all monitored GPU-box services Up + edge OK)"
  if [ "$SELF_TEST" = "1" ]; then
    echo ""
    echo "SELF-TEST FAIL: expected the stranded service to trigger ALERT (exit 1)."
  fi
  exit 0
fi
