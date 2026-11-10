#!/bin/sh
# ADAAAA-8553 S1: run ONE dynamic registrar per decide container on the 5090 host.
#
# The three 5090 decide workers are plain `docker run` containers on
# ai-server-5090x3-1 (192.168.1.151, published ports 8091-8093), not compose
# services, so they cannot be covered by docker/docker-compose.yml. This script
# starts one `python:3.12-alpine` registrar per worker with a distinct
# RUNNER_ID and the worker's OWN literal capacity (4).
#
# S0 (ADAAAA-8557) proved from this host: OUTBOUND to the x99 orchestrator at
# https://192.168.1.6:8935 (self-signed TLS, skipped by the registrar), the
# bootstrap heartbeat/unregister round-trip, and that the registrar image pulls.
# The in-container name `https://orchestrator:8935` is NOT reachable off-box.
#
# The orchestrator secret is resolved the way compose resolves it (S0,
# ADAAAA-8557): env ORCH_SECRET -> env ORCHESTRATOR_SECRET -> the box .env ->
# the compose default `${ORCHESTRATOR_SECRET:-...}`. The 5090 box has no
# ORCHESTRATOR_SECRET, so without the fallback the operator has to paste a value
# that compose already knows. Only the SOURCE is printed; the value only ever
# reaches the container by NAME (`-e ORCH_SECRET`), never on a command line.
#
# Usage (on ai-server-5090x3-1, from the highlights.live checkout):
#   ./docker/registrar-5090.sh                  # secret resolved automatically
#   ./docker/registrar-5090.sh down
#   ./docker/registrar-5090.sh --secret-source  # print WHERE it came from only
#
# Overridable: ORCH_URL, WORKER_HOST, RUNNER_CAPACITY_5090, REGISTRAR_INTERVAL_S,
#              LIVE_RUNNER_REGISTRAR_IMAGE, REGISTRAR_SCRIPT, ENV_FILE,
#              COMPOSE_FILE.
set -eu

PREFIX=highlights-registrar-decide-5090
ORCH_URL=${ORCH_URL:-https://192.168.1.6:8935}
WORKER_HOST=${WORKER_HOST:-192.168.1.151}
CAPACITY=${RUNNER_CAPACITY_5090:-4}
INTERVAL=${REGISTRAR_INTERVAL_S:-5}
IMAGE=${LIVE_RUNNER_REGISTRAR_IMAGE:-python:3.12-alpine}
SCRIPT=${REGISTRAR_SCRIPT:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/live-runner-registrar.py}

# The metadata string go-livepeer stores (max 1024 bytes) and discovery returns.
# `tier` is what the client ranks on in S2; `seqs` is this worker's vLLM
# --max-num-seqs, the source of the literal capacity above.
METADATA='{"model": "cyankiwi/gemma-4-12B-it-qat-AWQ-INT4", "engine": "vllm", "quantization": "compressed-tensors INT4", "tier": "5090", "seqs": 4}'

if [ "${1:-}" = "down" ]; then
  for i in 1 2 3; do
    docker rm -f "$PREFIX-$i" >/dev/null 2>&1 || true
    echo "stopped $PREFIX-$i"
  done
  exit 0
fi

if [ -z "${ORCH_SECRET:-}" ]; then
  # Same resolution order as compose: env -> .env -> compose default.
  ENV_FILE=${ENV_FILE:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/.env}
  COMPOSE_FILE=${COMPOSE_FILE:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/docker-compose.yml}

  # Last assignment wins; strip CR and one layer of surrounding quotes.
  env_file_value() {
    [ -f "$ENV_FILE" ] || return 1
    line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" 2>/dev/null | tail -n 1)
    [ -n "$line" ] || return 1
    value=${line#*=}
    value=$(printf '%s' "$value" | tr -d '\r')
    case $value in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
    esac
    [ -n "$value" ] || return 1
    printf '%s' "$value"
  }

  SECRET_SOURCE=
  if [ -n "${ORCHESTRATOR_SECRET:-}" ]; then
    ORCH_SECRET=$ORCHESTRATOR_SECRET
    SECRET_SOURCE=env:ORCHESTRATOR_SECRET
  elif ORCH_SECRET=$(env_file_value ORCH_SECRET); then
    SECRET_SOURCE="env-file:$ENV_FILE:ORCH_SECRET"
  elif ORCH_SECRET=$(env_file_value ORCHESTRATOR_SECRET); then
    SECRET_SOURCE="env-file:$ENV_FILE:ORCHESTRATOR_SECRET"
  elif [ -f "$COMPOSE_FILE" ]; then
    # Read the default out of `${ORCHESTRATOR_SECRET:-<default>}` rather than
    # hardcoding it here: the registrar then authenticates exactly like the
    # orchestrator process compose started.
    fallback=$(grep -o 'ORCHESTRATOR_SECRET:-[^}]*}' "$COMPOSE_FILE" | head -n 1)
    if [ -n "$fallback" ]; then
      ORCH_SECRET=${fallback#ORCHESTRATOR_SECRET:-}
      ORCH_SECRET=${ORCH_SECRET%\}}
      SECRET_SOURCE="compose:$COMPOSE_FILE:default"
    fi
  fi
fi

if [ "${1:-}" = "--secret-source" ]; then
  if [ -n "${ORCH_SECRET:-}" ]; then
    echo "${SECRET_SOURCE:-env:ORCH_SECRET}"
    exit 0
  fi
  echo "none"
  exit 1
fi

if [ -z "${ORCH_SECRET:-}" ]; then
  echo "no orchestrator secret found: set ORCH_SECRET or ORCHESTRATOR_SECRET, put one" >&2
  echo "in ${ENV_FILE:-.env}, or keep the compose default in ${COMPOSE_FILE:-docker-compose.yml}." >&2
  echo "It is passed by name with -e ORCH_SECRET, so it never appears on a command line." >&2
  exit 2
fi
export ORCH_SECRET
echo "orchestrator secret source: ${SECRET_SOURCE:-env:ORCH_SECRET} (value not printed)"
if [ ! -f "$SCRIPT" ]; then
  echo "registrar script not found: $SCRIPT" >&2
  exit 2
fi

# S0 proved the pull works; fail here rather than half-starting the fleet.
docker pull "$IMAGE" >/dev/null

for i in 1 2 3; do
  port=$((8090 + i))
  name="$PREFIX-$i"
  runner_url="http://$WORKER_HOST:$port"
  docker rm -f "$name" >/dev/null 2>&1 || true
  # --network host: the registrar reaches the orchestrator over the LAN and the
  # worker's PUBLISHED port exactly as the host does (S0's proven route). The
  # worker's /health stays per-container: RUNNER_URL is this worker only.
  docker run -d \
    --name "$name" \
    --restart unless-stopped \
    --network host \
    -e ORCH_URL="$ORCH_URL" \
    -e ORCH_SECRET \
    -e RUNNER_ID="highlights-decide-5090-$i" \
    -e RUNNER_APP=highlights-live/decide \
    -e RUNNER_URL="$runner_url" \
    -e RUNNER_HEALTH_URL=/health \
    -e RUNNER_MODE=single-shot \
    -e RUNNER_PROXY=0 \
    -e RUNNER_CAPACITY="$CAPACITY" \
    -e RUNNER_METADATA="$METADATA" \
    -e RUNNER_VERSION=0.1.0 \
    -e RUNNER_PRICE=0.01 \
    -e RUNNER_PRICE_UNIT=fixed \
    -e REGISTRAR_INTERVAL_S="$INTERVAL" \
    -e REGISTRAR_LOG_PREFIX="[registrar-decide-5090-$i]" \
    -v "$SCRIPT:/opt/live-runner-registrar.py:ro" \
    "$IMAGE" python3 /opt/live-runner-registrar.py >/dev/null
  echo "started $name -> runner_id=highlights-decide-5090-$i url=$runner_url capacity=$CAPACITY"
done

echo "verify within one heartbeat (run on THIS host):"
echo "  docker logs --tail 3 $PREFIX-1"
echo "  curl -sk '$ORCH_URL/discovery' | grep -o 'highlights-decide-5090-[1-3]' | sort -u   # 3 ids"
echo "  # from the x99 box, the signer view must also show 5 decide runners"
echo "  #   docker exec highlights-signer wget -qO- 'http://127.0.0.1:7936/discover-orchestrators?caps=highlights-live/decide'"
