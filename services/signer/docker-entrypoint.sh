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
# -network MUST be a go-livepeer-recognized name so the Controller auto-resolves.
# "arbitrum-one" (unqualified) is NOT a valid network in go-livepeer v0.9.2 — the
# registered production name is "arbitrum-one-mainnet". An unrecognized name
# leaves the Controller unset, so go-livepeer starts with Controller=0x0 and
# crashes on startup with `Error getting LivepeerToken address: no contract code
# at given address` / `Failed to set gas info` -> ~6s restart loop (ADAAAA-3512).
# -ethController is pinned explicitly to the canonical Arbitrum One Controller so
# the same error can ONLY mean a transient RPC stale read, never a zero/incorrect
# address — that makes a recurrence diagnosable in <5 min (see docs/DEPLOY.md).
set -- livepeer \
  -remoteSigner \
  -remoteDiscovery \
  -network arbitrum-one-mainnet \
  -ethController 0xD8E8328501E9645d16Cf49539efC04f734606ee4 \
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
