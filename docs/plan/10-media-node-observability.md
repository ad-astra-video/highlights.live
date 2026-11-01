# Chunk 10 — Media-node capacity/health + cost attribution (post-split observability)

Child of the accepted workload split (ADAAAA-6714, plan rev 3; phases 0–3 =
ADAAAA-6865, ADAAAA-6866, ADAAAA-6867, ADAAAA-6868). Phase 4 = the measurement half
of the split: without it the live/VOD pipeline cannot be *operated* on Livepeer GPU
because nobody can see how loaded the media node is or what a job cost.

## Post-split topology (what the readouts describe)

| Tier | Process | Owns |
|------|---------|------|
| Control plane | `services/server` (Fastify) | jobs, DB, entitlements, temporal engine, decide/VOD queue, negotiator for media sessions |
| Media node | `services/media` (Fastify) | the stream terminus (WebRTC/WS), the Orchestrator session **terminus**, and the **payer** (remote-signer tickets) |
| Orchestrator / runner | go-livepeer + perceive live-runner | GPU inference (capacity-1 perceive slot) |
| Signer | remote signer (`/generate-live-payment`) | ETH keystore, tickets |

The control plane never carries media bytes. It provisions a session on ONE media
node via `MEDIA_SERVER_URL`, records `media_sessions`, and re-provisions on a healthy
node if the node serving the session goes down. **Horizontal scale of the media tier
is deferred**: one `MEDIA_SERVER_URL`, one node id (`media-0`). The readouts below are
shaped per node (`perNode[]`) so a fleet needs no contract change.

## Data paths (do not mix them up)

- **Run log / DB readouts** — this chunk. `media_sessions`, `jobs.costUsd`. No OTel
  endpoint needed, no first-party telemetry emitted.
- **Observability (OpenTelemetry)** — `server/src/instrumentation.ts`, no-op until an
  operator sets an OTLP endpoint. Unchanged here; no new spans added.
- **Telemetry (first-party events)** — **none added** by this chunk (so no privacy
  review is required, per repo AGENTS rule 7).

## 1. Media node capacity/health surface

`GET {MEDIA_SERVER_URL}/health` — **public**, counts-only. This is what the control
plane's health check and any box-health poller already hit, so it must stay cheap and
must not leak identifiers (the media origin sits behind the public LB).

```json
{
  "status": "ok",
  "node": { "id": "media-0", "role": "media", "uptimeS": 8123 },
  "capacity": {
    "maxSessions": 1, "activeSessions": 1, "availableSessions": 0,
    "loadPct": 100, "saturated": true,
    "provisionAttempts": 12, "provisionFailures": 3, "noCapacityFailures": 2
  },
  "leases": { "active": 1, "grace": 0, "awaitingClient": 0, "paying": 1, "total": 1 },
  "payment": { "onchain": true, "payingSessions": 1 },
  "cost": { "basis": "media-node session meter …", "sessionsCompleted": 9, "sessionSeconds": 1371.2 }
}
```

Lease states: `active` (client attached, frames flowing), `grace` (last client
dropped, slot held for `reconnectGraceMs` so a blip reconnects to the SAME session),
`awaiting-client` (provisioned, no browser yet — released by `MEDIA_PROVISION_NO_CLIENT_MS`).

`GET {MEDIA_SERVER_URL}/node` — **bearer-gated** (`MEDIA_HEALTH_TOKEN`). Same payload
plus `sessions[]` with `sessionId`, `jobId`, `transport` (`webrtc`/`ws`), `ageS`,
`sockets`, `paying`, `recording`, `lease.{state,expiresInS}`. Unset token => **404**
(never public-by-default: the media origin is LB-reachable, so session/job ids must
not be anonymous-readable).

```bash
curl -s "$MEDIA_SERVER_URL/health" | jq
curl -s "$MEDIA_SERVER_URL/node" -H "Authorization: Bearer $MEDIA_HEALTH_TOKEN" | jq
```

## 2. Console readout (control-plane join)

`GET /media/node` — authenticated (any signed-in user; the live console renders it
next to a running job). It proxies the node's `/health` (2 s timeout) + `/node` when
`MEDIA_HEALTH_TOKEN` is set, then joins the durable attribution:

```json
{
  "reachable": true,
  "origin": "http://media:4070",
  "node": { "id": "media-0", "role": "media", "uptimeS": 8123 },
  "capacity": { "maxSessions": 1, "activeSessions": 1, "loadPct": 100, "saturated": true },
  "leases": { "active": 1, "grace": 0, "awaitingClient": 0, "paying": 1 },
  "payment": { "onchain": true, "payingSessions": 1 },
  "sessions": [ { "sessionId": "…", "jobId": "…", "lease": { "state": "active", "expiresInS": null } } ],
  "detailAvailable": true,
  "meter": { "sessionsCompleted": 9, "sessionSeconds": 1371.2 },
  "cost": {
    "attribution": "job.costUsd joined to media_sessions.node_id (the node that carried the job's stream)",
    "total": { "nodes": 1, "jobs": 23, "costUsd": 4.2100 },
    "perNode": [ { "nodeId": "media-0", "origin": "http://media:4070", "jobs": 23, "costUsd": 4.21, "sessions": 9 } ]
  }
}
```

Node down => `reachable: false`, `node`/`capacity`/`leases` null, and `cost` still
published from the DB (attribution never depends on the node answering).

**Live console**: `webapp/src/components/MediaNodeStrip.tsx` is the single strip,
polled from `/media/node` every 6 s. Both live surfaces mount it — `LiveConsole`
(RTMP/file job) and the client-side capture panel (`BrowserCapture` branch in
`pages/Highlights.tsx`), because a browser-capture job holds the same capacity-1
node. It renders:

- node id + `healthy` / `unreachable`;
- `load n/max sessions (pct)`, plus a `saturated` badge when `capacity.saturated`;
- `leases A active · G grace · W waiting`, then paying / offchain;
- `node spend $X over N job(s) on M node(s)` and **one row per `cost.perNode[]`
  entry** — `media-0 $0.00 / 0 job(s)`, `unattributed $26.65 / 84 job(s)` — with
  legacy `unattributed` rows last.

A failed poll keeps the previous reading; it never breaks the console. The
formatting lives in `webapp/src/lib/nodeStrip.ts`, so the rendered text is
unit-tested without a DOM (`webapp/src/lib/nodeStrip.test.ts`).

## 3. Per-job inference cost readout (the money figure)

Authoritative, per job, in the completed record (`GET /jobs/:id/detail`):

| Field | Meaning |
|-------|---------|
| `job.costUsd` | decide fee × `decideCalls` + `perceiveSessionS/3600 × $0.01` (perceive list price) |
| `job.decideCalls` | observer decide calls actually made (cadence-driven under the observe architecture) |
| `job.perceiveSessionS` | paid perceive session seconds the job held |

Aggregate readout: `GET /admin/monitoring?days=N` (`admin_readonly`) →
`totalInferenceCostUsd`, `perClipInferenceCostUsd`, `perChannel[].inferenceUsd`, plus
the reliability/spend-pause gate.

**Real job as evidence** (live box, 2026-10-30):

```
GET /jobs/02fb157d-e580-4ee7-9832-b4dc0ab203b5/detail
-> costUsd 0.0863 | decideCalls 25 | perceiveSessionS 1371.2 | done | 4 highlights
GET /jobs/ac6bf37f-6a03-4d14-a307-de5b9e200405/detail
-> costUsd 0.8753 | decideCalls 261 | perceiveSessionS 5027  | done | 23 highlights
```

i.e. 25 decide calls (~$0.0025 ea) + 22.9 min of paid perceive on the capacity-1 slot
= $0.0863 for 4 usable clips ≈ **$0.022/clip**. Re-derive:
`0.0863 = 25 × decideFee + 1371.2/3600 × 0.01`.

## 4. Per-node attribution (single node now, fleet-ready)

`media_sessions.node_id` (migration v8, `ALTER TABLE media_sessions ADD COLUMN node_id TEXT`)
records which node provisioned each session; `POST /sessions` returns `nodeId` and the
control plane persists it. Spend is attributed by joining `media_sessions.node_id` ->
`jobs.costUsd`. Jobs with no node on their session row group under
`unattributed` so the total never silently drops spend.

**Live ingest that never provisions a session (ADAAAA-7670).** An RTMP-pull live job
is pulled server-side (`services/server/src/live.ts`) and never calls
`POST {MEDIA_SERVER_URL}/sessions`, so before this it had no row at all and all of its
spend grouped under `unattributed`. `attributeLiveIngest()`
(`services/server/src/media-ingest.ts`) now writes a settled attribution row from the
ingest path: `session_id` = `ingest:<jobId>`, `status` = `closed` (no live media-server
session exists), `node_id` = the id the media node reports about ITSELF on
`GET /health` (`node.id`, i.e. the media service's `MEDIA_NODE_ID`) — the node is
asked, never assumed from server config. A node that is down, unconfigured, or does
not report an id leaves the job under `unattributed` (the honest answer; no invented
node id). The row is written when ingest starts and retried once at completion; an
existing row is never overwritten, so a re-run cannot relabel historical spend.

### Which source is attributable (the rule)

| Source | Media-tier | Why |
|--------|-----------|-----|
| `rtmp` | yes | live pull into the live GPU pipeline; row written from the ingest path (ADAAAA-7670) |
| `webrtc`, `screenshare` | yes | same live pipeline (`LiveIngest`, one perceive session per live job) |
| `screen`, `file-sim` | yes | same live pipeline (dev/synthetic live sources) |
| `browser` | yes | provisioned via `POST /sessions`; `provisionMedia()` persists the returned `nodeId` |
| `file` (VOD incl. uploads) | **no — deliberately `unattributed`** | the perceive pass runs in the control-plane VOD worker and holds no media-node lease (§5) |
| pre-v8 rows (`node_id` NULL) | **no — `unattributed`** | written before the column existed; kept historical on purpose |

Config:

| Env | Where | Default | Meaning |
|-----|-------|---------|---------|
| `MEDIA_NODE_ID` | media | `media-0` | node identity on `/health`, `POST /sessions`, `media_sessions.node_id` |
| `MEDIA_MAX_SESSIONS` | media | `1` | advertised concurrent capacity (perceive runner is capacity-1) |
| `MEDIA_HEALTH_TOKEN` | media + server | unset | bearer for `GET /node`; unset => detail off (404) |

## 5. Deferred / next

- Horizontal scale of the media tier (node selection, least-loaded routing) — the
  `perNode[]` shape and `node_id` column exist for it; selection logic does not.
- Settled on-chain ticket totals per node (the node publishes session seconds today;
  actual ETH/ticket settlement is the signer's ledger).
- Media-node capacity in the VOD path: VOD runs through the control-plane worker, so
  its perceive session time is `job.perceiveSessionS`, not a media-node lease. VOD
  spend therefore stays in the `unattributed` bucket **by design** (ADAAAA-7670), not
  because attribution is missing.

## Verification

```bash
npx vitest run services/media/test/media-health.test.ts \
                services/server/test/media-node.test.ts \
                services/server/test/db.test.ts
npx tsc --noEmit -p services/media/tsconfig.json
npx tsc --noEmit -p webapp/tsconfig.json
# server: see the composite tsconfig note in the deploy skill (paths mapping)
curl -s "$MEDIA_SERVER_URL/health" | jq '.capacity, .leases'
curl -s "$SERVER/media/node" -H "Authorization: Bearer $USER_TOKEN" | jq '.cost'
```
