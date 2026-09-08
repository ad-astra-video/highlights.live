# Railway deployment — server + remote signer (two services)

Security model: the server is the only publicly reachable process. The remote
signer holds the ETH keystore and has NO public domain — the server reaches it
only over Railway's private network (internal routing). GPU boxes never see the
key.

```
Internet
   │
   ▼
[ server ]  (public domain, port 3000)
   │  http://<signer-service>.railway.internal:7936   ← PRIVATE network only
   ▼
[ signer ]  (livepeer -remoteSigner, port 7936, NO public domain)
   │  Arbitrum One RPC  (egress only)
   ▼
[ arbitrum ]
```

## Prerequisites (once per environment)

1. An Arbitrum One RPC endpoint (e.g. Alchemy/Infura) -> `ARBITRUM_RPC`.
2. A funded LPT/wallet whose keystore JSON will be the signer's only key.
   From the app-pipelines reference keystore, the file is named `wallet`
   (go-livepeer keystore under `<dataDir>/keystore/`).

## Two Railway services (same project)

Create TWO services from this repo so they share the private network:

### Service 1 — server (public)
- Build: Dockerfile `docker/Dockerfile.server` (build context = repo root).
- Deploy: port 3000, public domain enabled.
- Env: `PORT=3000`, `ORCHESTRATOR_URL`, `SIGNER_URL`, `DATA_DIR=/data`,
  `FFMPEG_PATH=ffmpeg`, plus `NODE_TLS_REJECT_UNAUTHORIZED=0` ONLY while the
  local offchain orchestrator uses a self-signed cert (remove for public orchs).
- `SIGNER_URL` -> set it to your signer's private DNS, e.g.
  `http://signer.railway.internal:7936`. Railway exposes the private domain as
  `RAILWAY_PRIVATE_DOMAIN` on each service; the server reads `SIGNER_URL`.

### Service 2 — remote signer (NO public domain)
- Build: Dockerfile `services/signer/Dockerfile` (build context = repo root).
- Deploy: port 7936. Turn the public domain OFF (private networking only).
- Env (sealed):
  - `ARBITRUM_RPC` (required; signer cannot run on offchain)
  - `ETH_PASSWORD` = the keystore password (e.g. `testbroadcaster` in the ref).
  - `SIGNER_AUTH_TOKEN` = shared bearer token (server sends it as
    `Authorization: Bearer <token>` via `-remoteSignerHeaders`).
  - `MAX_PRICE_PER_UNIT` = spend cap per unit (wei/sec or 720p-pixel-sec).
- Secret volume: put the keystore `wallet` JSON at `/keystore/wallet`
  (mounted read-only into the container; entrypoint copies it to `/data/keystore`).

## Verify the split after deploy
- `signer` shows Status "running" but has no `*.up.railway.app` / custom public
  domain (list in the dashboard Service Settings -> Networking).
- From the `server` service, resolve the signer's private address:
  `curl http://<signer-service>.railway.internal:7936/health` (or the
  discovery endpoint) succeeds; from your laptop the same hostname does NOT
  resolve — this is the intended isolation.

## Offchain note
The offchain VOD vertical slice runs entirely without a signer (see
`docker/docker-compose.yml`; signer is behind the `signer` compose profile).
The signer only matters on the on-chain path, where reserve returns
`402 Payment Required`, the server calls `signer.generateLivePayment(...)` and
retries with `Livepeer-Payment` / `Livepeer-Segment` headers (see
`packages/livepeer-session` `LivepeerClient` + `HttpSignerClient`).
