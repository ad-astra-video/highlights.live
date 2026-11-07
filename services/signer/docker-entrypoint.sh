#!/usr/bin/env sh
set -eu

# No keystore -> refuse to start rather than silently run keyless.
KEYSTORE_DIR=${KEYSTORE_DIR:-/keystore}
if [ -z "$(ls -A "$KEYSTORE_DIR" 2>/dev/null)" ]; then
  echo "FATAL: $KEYSTORE_DIR is empty. Mount the ETH keystore (e.g. the go-livepeer 'wallet' file)." >&2
  exit 1
fi
if [ -z "$ARBITRUM_RPC" ]; then
  echo "FATAL: ARBITRUM_RPC is required for -remoteSigner (cannot run on -network offchain)." >&2
  exit 1
fi

# Copy keystore into the go-livepeer data dir.
mkdir -p "$DATA_DIR/keystore"
cp "$KEYSTORE_DIR"/* "$DATA_DIR/keystore/"

# --- Orchestrator TLS trust: self-healing CA sync (ADAAAA-8262) ---------------
# go-livepeer v0.9.2 regenerates the orchestrator's self-signed cert on EVERY
# process start (server/cert.go getCert(): "for now, just generate a new cert
# every time"), so a pinned CA file (the ADAAAA-2957 fix) goes stale at the next
# orchestrator restart. The signer's /discovery fetch then fails TLS
# verification (discovery/db_discovery.go callOrchestratorDiscovery uses a plain
# http.Client with system roots, unlike the gRPC GetOrchestratorInfo path which
# skips verification), the failure is DEBUG-only, and the visible symptom is
# `GET /discover-orchestrators` -> `503 cache empty` plus a dark capacity signal.
#
# Durable path, no orchestrator change: fetch the orchestrator's CURRENT cert at
# container start, install it as a CA, and keep polling it. On change, re-pin and
# restart the livepeer child. The restart is REQUIRED: Go caches the system root
# pool per process, so a disk-only CA refresh is never seen by the running binary.
ORCH_CA_REFRESH_SEC=${ORCH_CA_REFRESH_SEC:-300}
ORCH_CA_DIR=${ORCH_CA_DIR:-/usr/local/share/ca-certificates}
ORCH_CA_LIVE="$ORCH_CA_DIR/orchestrator-live.crt"
LP_PID=""

orch_host_port() { # host:port for an https ORCH_ADDR, empty otherwise
  case "${ORCH_ADDR:-}" in
    https://*) hp=${ORCH_ADDR#https://}; hp=${hp%%/*}; echo "${hp%/}" ;;
  esac
}

fetch_orch_cert() { # print the live orchestrator cert (PEM); fails if unreachable
  hp=$(orch_host_port)
  [ -n "$hp" ] || return 1
  host=${hp%%:*}
  case "$hp" in *:*) port=${hp##*:} ;; *) port=443 ;; esac
  if command -v timeout >/dev/null 2>&1; then
    timeout 10 openssl s_client -connect "$host:$port" -servername "$host" </dev/null 2>/dev/null \
      | timeout 10 openssl x509 2>/dev/null
  else
    openssl s_client -connect "$host:$port" -servername "$host" </dev/null 2>/dev/null \
      | openssl x509 2>/dev/null
  fi
}

cert_fp() { # sha256 fingerprint of the cert on stdin
  openssl x509 -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//'
}

sync_orch_ca() { # 0 = unchanged (or fetch failed), 1 = trust store changed
  tmp=$(mktemp) || return 0
  if ! fetch_orch_cert >"$tmp" || ! openssl x509 -noout -in "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    echo "[orch-ca] could not fetch the orchestrator cert; keeping the current trust store"
    return 0
  fi
  new_fp=$(cert_fp <"$tmp")
  cur_fp=""
  [ -f "$ORCH_CA_LIVE" ] && cur_fp=$(cert_fp <"$ORCH_CA_LIVE")
  if [ -n "$new_fp" ] && [ "$new_fp" = "$cur_fp" ]; then
    rm -f "$tmp"
    return 0
  fi
  cp "$tmp" "$ORCH_CA_LIVE" || {
    rm -f "$tmp"
    echo "[orch-ca] could not write $ORCH_CA_LIVE; keeping the current trust store"
    return 0
  }
  rm -f "$tmp"
  update-ca-certificates >/dev/null 2>&1 || true
  echo "[orch-ca] pinned orchestrator cert sha256=$new_fp (previous ${cur_fp:-none})"
  return 1
}

# Install any mounted pin first, then the orchestrator's CURRENT cert.
update-ca-certificates >/dev/null 2>&1 || true

run_livepeer() {
set -- livepeer \
  -remoteSigner \
  -remoteDiscovery \
  -network ${NETWORK:-arbitrum-one-mainnet} \
  -httpAddr "$HTTP_ADDR" \
  -cliAddr "$CLI_ADDR" \
  -ethUrl "$ARBITRUM_RPC" \
  -ethPassword "$ETH_PASSWORD" \
  -dataDir "$DATA_DIR"

if [ -n "$MAX_PRICE_PER_UNIT" ]; then
  set -- "$@" -maxPricePerUnit "$MAX_PRICE_PER_UNIT"
fi
# ADAAAA-6605/6609: forward-reserve horizon (seconds of billing). Without this
# the signer mints only the elapsed fee, so the orchestrator's reserved balance
# drains to the release trough at each refill boundary (under-fee). Sizing the
# forward reserve keeps the reserved balance above the per-interval fee.
if [ -n "$LIVE_PAYMENT_RESERVE" ]; then
  set -- "$@" -livePaymentReserve "$LIVE_PAYMENT_RESERVE"
fi
# Routes discovery/probe traffic to the local orchestrator on the private `hl`
# network (matches ORCH_ADDR in docker/.env).
if [ -n "$ORCH_ADDR" ]; then
  set -- "$@" -orchAddr "$ORCH_ADDR"
fi
# ADAAAA-6609: the signer binds its REST API on 0.0.0.0:7936 (private `hl`
# network only, no published host ports). go-livepeer refuses to bind a remote
# signer on a non-loopback address without either a webhook OIDC auth or this
# override. SIGNER_ALLOW_NO_AUTH=1 is the established docker/.env value; the API
# still requires the SIGNER_AUTH_TOKEN Authorization header on every request.
if [ "$SIGNER_ALLOW_NO_AUTH" = "1" ]; then
  set -- "$@" -remoteSignerAllowNoAuth
fi
if [ -n "$SIGNER_AUTH_TOKEN" ]; then
  set -- "$@" -remoteSignerHeaders "Authorization:Bearer $SIGNER_AUTH_TOKEN"
fi

  "$@" &
  LP_PID=$!
}

stop_livepeer() {
  [ -n "$LP_PID" ] && kill -TERM "$LP_PID" 2>/dev/null || true
}

on_signal() {
  trap - TERM INT
  stop_livepeer
  set +e
  wait "$LP_PID" 2>/dev/null
  exit 0
}
trap on_signal TERM INT

# Pin the orchestrator's current cert BEFORE livepeer starts (a fresh signer
# then never depends on a hand-pinned, restart-stale CA file).
sync_orch_ca || true

run_livepeer
echo "[orch-ca] livepeer pid=$LP_PID; re-checking the orchestrator cert every ${ORCH_CA_REFRESH_SEC}s"

while kill -0 "$LP_PID" 2>/dev/null; do
  sleep "$ORCH_CA_REFRESH_SEC" &
  wait $! 2>/dev/null || true
  kill -0 "$LP_PID" 2>/dev/null || break
  if sync_orch_ca; then
    continue # unchanged (or unreachable) -> nothing to do
  fi
  echo "[orch-ca] orchestrator cert changed; restarting livepeer so Go reloads its system root pool"
  stop_livepeer
  set +e
  wait "$LP_PID" 2>/dev/null
  set -e
  run_livepeer
  echo "[orch-ca] livepeer restarted pid=$LP_PID"
done

set +e
wait "$LP_PID"
exit $?
