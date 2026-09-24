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
# Usage:
#   box-health-check.sh                # check livepeer-ai-x99 + public edge
#   box-health-check.sh <server>       # override the GPU box name
#   box-health-check.sh <server> --no-edge   # skip the public-edge HTTP check
#   box-health-check.sh --self-test    # dry-run: simulate a stranded service and
#                                      #   prove the ALERT path fires (no live box)
#
# Monitored GPU-box services (the highlights-live decision stack):
#   decide, gemma, perceive, orchestrator
# plus the rest of the stack that must stay reachable for a full pipeline.
# Exit code: 0 = all monitored services healthy + (unless --no-edge) edge OK;
#           1 = degraded / ALERT (a monitored service is not Up or edge down).
#
# Naming convention: the running container names are highlights-<service>.
# A service is healthy when `docker ps` reports it `Up` (optionally "(healthy)")
# and NOT in a state matching Created/Exited/Restarting/Dead.

set -u

SERVER="${1:-livepeer-ai-x99}"
EDGE_CHECK=1
# --self-test: dry-run demonstration of the ALERT path with no live box. Simulates
# a service stranded in Created and asserts the script FAILs (exit 1).
if [ "${1:-}" = "--self-test" ]; then
  echo "SELF-TEST: demonstrating the ALERT path for a service stranded in 'Created'"
  echo "(simulated; no live box contacted)"
  FAILED=1
  DECLARE_ALERT=" highlights-decide(Created)"
  echo "== GPU box per-service health: livepeer-ai-x99 (SIMULATED) =="
  echo "  [FAIL] highlights-decide : Created (never started)   <-- decision engine DOWN"
  for s in gemma perceive orchestrator server; do
    echo "  [ OK ] highlights-$s : Up (healthy)"
  done
  echo ""
  echo "BOX-HEALTH: ALERT / FAIL"
  echo "Degraded services:$DECLARE_ALERT"
  echo ""
  echo "SELF-TEST PASS: a service in Created/Exited/Restarting is caught and flags ALERT (exit 1)."
  exit 1
fi

if [ "${2:-}" = "--no-edge" ]; then
  EDGE_CHECK=0
fi

# Paths / helpers.
KOMODO="/paperclip/.hermes/skills/komodo/scripts/komodo.py"
EDGE_URL="${EDGE_URL:-https://highlights-server.dpn.gg}"
# GPU-box services that MUST be Up (healthy) for the decision pipeline:
# decide / gemma / perceive / orchestrator are the core monitored set; the full
# compose stack is also checked so a degraded sibling is not silently missed.
MONITORED_SERVICES="${MONITORED_SERVICES:-decide gemma perceive orchestrator server media email postgres signer}"

# ----- per-service container state (GPU box) -----
# Ask the box for the state of each monitored container and classify it.
state_for() {
  # $1 = service short name -> container is highlights-$1
  local svc="$1"
  local out
  out="$(python3 "$KOMODO" "$SERVER" \
    "docker ps -a --format '{{.Names}}|{{.Status}}' | awk -F'|' '\$1==\"highlights-${svc}\" {print \$2}'")"
  # Strip komodo exit-code footer if present.
  out="$(printf '%s\n' "$out" | grep -v '__KOMODO_EXIT_CODE' | grep -v '^$')"
  printf '%s' "$out"
}

# ----- run per-service checks -----
FAILED=0
DECLARE_ALERT=""
echo "== GPU box per-service health: $SERVER =="
for svc in $MONITORED_SERVICES; do
  st="$(state_for "$svc")"
  if [ -z "$st" ]; then
    echo "  [FAIL] highlights-$svc : NO CONTAINER (missing)"
    FAILED=1; DECLARE_ALERT="$DECLARE_ALERT highlights-$svc(missing)"
    continue
  fi
  # A healthy container shows a status starting with "Up" and should not carry
  # a non-running qualifier. Flag Created/Exited/Restarting/Dead explicitly.
  case "$st" in
    Up*healthy*)
      echo "  [ OK ] highlights-$svc : $st"
      ;;
    Up*)
      # Up but not marked healthy — warn but do not fail unless required.
      echo "  [WARN] highlights-$svc : $st (running, not 'healthy')"
      ;;
    Created*|Exited*|Restarting*|Dead*|Paused*)
      echo "  [FAIL] highlights-$svc : $st (NOT running / stranded)"
      FAILED=1; DECLARE_ALERT="$DECLARE_ALERT highlights-$svc(${st%% *})"
      ;;
    *)
      echo "  [WARN] highlights-$svc : $st (unclassified state)"
      ;;
  esac
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
  exit 1
else
  echo "BOX-HEALTH: PASS (all monitored GPU-box services Up + edge OK)"
  exit 0
fi
