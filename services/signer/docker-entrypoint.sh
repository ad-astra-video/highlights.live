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

set -- livepeer \
  -remoteSigner \
  -remoteDiscovery \
  -network arbitrum-one \
  -httpAddr "$HTTP_ADDR" \
  -cliAddr "$CLI_ADDR" \
  -ethUrl "$ARBITRUM_RPC" \
  -ethPassword "$ETH_PASSWORD" \
  -dataDir "$DATA_DIR"

if [ -n "$MAX_PRICE_PER_UNIT" ]; then
  set -- "$@" -maxPricePerUnit "$MAX_PRICE_PER_UNIT"
fi
if [ -n "$SIGNER_AUTH_TOKEN" ]; then
  set -- "$@" -remoteSignerHeaders "Authorization:Bearer $SIGNER_AUTH_TOKEN"
fi

exec "$@"
