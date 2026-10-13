#!/usr/bin/env sh
set -eu

# No keystore -> refuse to start rather than silently run keyless.
if [ -z "$(ls -A /keystore 2>/dev/null)" ]; then
  echo "FATAL: /keystore is empty. Mount the ETH keystore (e.g. the go-livepeer 'wallet' file)." >&2
  exit 1
fi
if [ -z "$ARBITRUM_RPC" ]; then
  echo "FATAL: ARBITRUM_RPC is required for -remoteSigner (cannot run on -network offchain)." >&2
  exit 1
fi

# Copy keystore into the go-livepeer data dir.
mkdir -p "$DATA_DIR/keystore"
cp /keystore/* "$DATA_DIR/keystore/"

update-ca-certificates >/dev/null 2>&1 || true
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

exec "$@"
