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
    "provisionAttempts": 12, "provisionFailures": 3, "noCapacityFailures": 2,
    "provisionReuses": 4
  },
  "leases": { "active": 1, "grace": 0, "awaitingClient": 0, "paying": 1, "total": 1 },
  "payment": { "onchain": true, "payingSessions": 1 },
  "cost": {
    "basis": "media-node session meter …",
    "sessionsCompleted": 9, "sessionSeconds": 1371.2,
    "sessionsUnused": 0, "sessionClosedNotifies": 9
  },
  "restarts": {
    "boots": 3, "bootId": "…", "buildRef": "abc1234", "restartCause": "deploy",
    "sourceDigest": "sha256:…", "sourceFiles": 12,
    "previousBoot": { "bootId": "…", "buildRef": "def5678", "sourceDigest": "sha256:…", "sourceFiles": 12, "atIso": "…", "exit": null },
    "lastStartAt": "…", "lastExit": null,
    "windowS": 600, "threshold": 3, "bootsInWindow": 1, "degraded": false
  }
}
```

Lease states: `active` (client attached, frames flowing), `grace` (last client
dropped, slot held for `reconnectGraceMs` so a blip reconnects to the SAME session),
`awaiting-client` (provisioned, no browser yet — released by `MEDIA_PROVISION_NO_CLIENT_MS`).

### Session ownership, close attribution and boot identity (ADAAAA-7689)

A browser job owns exactly ONE media session.

- `POST /sessions { jobId }` **adopts** the job's live session when it already has
  one and returns it (`reused: true`) instead of reserving a second perceive
  session. The browser QA path calls this twice — once through the control plane's
  `POST /jobs/{id}/media`, once from the harness/browser — and the second reservation
  used to idle out on the no-client timer while still being charged a full 60 s of
  `sessionSeconds`. `capacity.provisionReuses` counts the adopted calls.
- A provisioned session that no client ever joins is counted in
  `cost.sessionsUnused`, **not** in `sessionsCompleted`/`sessionSeconds`: it carried
  no stream, so it must not inflate the per-node cost meter.
- On teardown the node POSTs `{CALLBACK_URL}/jobs/{jobId}/media/session-closed`
  (bearer `MEDIA_HEALTH_TOKEN` when configured) with
  `{ sessionId, jobId, reason, liveSessionsForJob, neverAttached, seconds, nodeId, transport }`,
  where `reason` is one of `client-closed` | `control-close` | `no-client-timeout` |
  `payment-failure` and `liveSessionsForJob` is the number of sessions still carrying
  the job after this one closed. The control plane finalizes the browser job only
  when that count is 0 (same path as `POST /jobs/:id/stop`, run once per job), so
  `GET /jobs` shows no `active` job after a run — including when the closing session
  is one the control plane never tracked (a harness that provisioned its own). The
  callback is fire-and-forget: a missed callback degrades to the old explicit-stop
  behaviour, never to a leaked slot.

`restarts.bootId` + `restarts.buildRef` + `restarts.restartCause` make a restart
attributable from the edge: `deploy` means the revision changed, `crash` means the
same revision with an exit the process never observed (SIGKILL/OOM), `restart` means
an observed exit (clean exit / SIGTERM). The ledger lives on the `media-state`
volume (`MEDIA_STATE_DIR=/state`), so a recreate does not erase the comparison. The
revision comes from the image's `BUILD_REF` build arg — deploy with
`BUILD_REF=$(git rev-parse --short HEAD) docker compose -f docker/docker-compose.yml up -d --build media`;
a boot with no injected revision falls back to the served-source digest (below),
never to a bare placeholder.

### Served-revision proof: `restarts.sourceDigest` (ADAAAA-8048)

`buildRef` is only stamped when the recreate went through `docker/deploy.sh` — the
one path that exports `BUILD_REF=$(git rev-parse --short HEAD)`. A bare
`docker compose up -d` (or a compose recreate triggered by an env change) falls
back to the Dockerfile's `ARG BUILD_REF=unknown`, and then a QA run cannot prove
which source the node is serving from the edge at all (ADAAAA-8007 makes an
unstamped served revision void).

`restarts.sourceDigest` closes that gap because it is derived from the bytes the
container runs, not from the deploy path:

- **What it is** — `sha256:<64 hex>` over every `.ts` under `services/media/src`
  (recursive), folded in sorted relative-path order as
  `relPath NUL content NUL` for each file. `restarts.sourceFiles` is the number of
  files folded in (a sanity check that the whole tree was read — today the media
  source is a flat directory of `.ts` files).
- **Stable across a rebuild** — no timestamps, no absolute paths, no
  directory-listing order in the hash, so rebuilding identical source in a new
  image context reproduces the digest byte-for-byte.
- **Changes on any served edit** — content, rename, add or delete.
- **Recorded per boot** — the ledger (`MEDIA_STATE_DIR`) stores it beside
  `buildRef`, and `previousBoot.sourceDigest` lets a reader compare the source of
  the boot that just died with the one now serving, exactly like a revision.
- **Provenance only** — it does not affect `restartCause` (that stays on
  `buildRef` semantics) and it changes no relay behaviour, sampling or live
  contract. It is a plain hash on the public `/health` surface, so it carries no
  identifiers.

Reproduce it outside the container (this is the exact recipe the unit test
pins, `services/media/test/source-digest.test.ts`):

```bash
python3 - <<'PY'
import hashlib, pathlib
root = pathlib.Path("services/media/src")
h = hashlib.sha256()
for rel in sorted(p.relative_to(root).as_posix() for p in root.rglob("*.ts")):
    h.update(rel.encode()); h.update(b"\0")
    h.update((root / rel).read_bytes()); h.update(b"\0")
print("sha256:" + h.hexdigest())
PY
```

The digest is a property of the tree, so it must be computed on the same commit
that is being deployed (on the box: `cd /home/brad/highlights.live`). Two ways to
read it back from the edge:

```bash
curl -s "$MEDIA_SERVER_URL/health" | jq '.restarts | {buildRef, sourceDigest, sourceFiles, bootId}'
# inside the container, if the origin is not reachable from where you are:
docker exec highlights-media node --import tsx -e \
  'import("./services/media/src/source-digest.ts").then(m=>console.log(m.sourceDigest()))'
```

A QA read is now sufficient proof even on a boot where no git revision was
injected: matching `sourceDigest` names the served commit, and a mismatch means
the container is not running the source you think it is.

### `buildRef` never publishes a placeholder (ADAAAA-8050)

`buildRef` is resolved once at boot, in this order:

1. `MEDIA_BUILD_REF` — explicit runtime override (running the tree outside the image).
2. `BUILD_REF` — the build arg `docker/deploy.sh` exports (`git rev-parse --short HEAD`).
3. the served-source digest — `buildRef: "src-<first 12 hex of sourceDigest>"`.
4. `"unknown"` — only when even the served source could not be read.

`restarts.buildRefSource` names the path that produced the value
(`env:MEDIA_BUILD_REF` | `env:BUILD_REF` | `served-source-digest` | `none`), so a
reader can tell a git revision from a content identity without guessing.

Empty and `unknown` are treated as ABSENT, not as identities. That was the actual
defect: the compose build arg defaults to `unknown`, and the previous
`env.BUILD_REF || "unknown"` chain published that placeholder verbatim for a
real, identifiable build. A recreate taken with a plain
`docker compose up -d [--build] media` now reports `src-<digest>` — the same
value `/health` already publishes as `sourceDigest`, recomputable on the commit
with the recipe above — so a gate worded "which build served this" has something
to read on every recreate path, not only the sanctioned one.

```bash
curl -s "$MEDIA_SERVER_URL/health" | jq '.restarts | {buildRef, buildRefSource, sourceDigest}'
# a hand recreate (no BUILD_REF):  buildRef "src-62b84f8528b4" source "served-source-digest"
# a deploy.sh recreate:           buildRef "1a2288b"          source "env:BUILD_REF"
```

### Session loss attribution: `media-session-lost` (ADAAAA-7700)

A recreate or crash of the media node drops every in-flight RTC session. Before
this, the browser job was indistinguishable from "the pipeline never ran": a bare
`status: failed` with 0 frames and no reason, and the webapp said nothing.

- The node keeps an **open-session ledger** next to the lifecycle ledger
  (`MEDIA_STATE_DIR/highlights-media-open-sessions.json`) listing every session it
  holds, the `jobId` it carries, the transport and whether a client ever attached.
  It is written on session open/attach and the entry is removed on a clean
  teardown.
- At boot the node **drains** that ledger and POSTs the existing
  `POST {CALLBACK_URL}/jobs/{jobId}/media/session-closed` with
  `reason: "media-node-restart"` for each leftover session (bounded retry: the
  control plane is usually restarting at the same instant; the server's boot sweep
  is the backstop). `/health.cost.sessionsLostReported` counts them.
- The control plane maps `media-node-restart` to `status: "failed"` with
  `failureReason: "media-session-lost"` and an actionable `error` ("Media node
  restarted — … Click Start to share again."). A client/control close still
  finalizes as `done`.
- A job stranded at server boot is attributed by the sweep: a browser job that
  still holds a `media_sessions` row becomes `media-session-lost`, anything else
  `server-restart`.
- The transition is appended to the durable `job_lifecycle_events` activity log
  (`GET /jobs/:id/lifecycle`) and pushed to the live console as a `lifecycle` SSE
  event.
- Recovery path: the share is **ended cleanly**, not silently re-provisioned —
  `POST /jobs/:id/media` answers 409 once the job is terminal, so one share can
  never open (or be charged for) a second session. The webapp polls the job row
  every 3 s and turns the attribution into "Media node restarted — click Start to
  share again".

`GET {MEDIA_SERVER_URL}/node` — **bearer-gated** (`MEDIA_HEALTH_TOKEN`). Same payload
plus `sessions[]` with `sessionId`, `jobId`, `transport` (`webrtc`/`ws`), `ageS`,
`sockets`, `paying`, `recording`, `lease.{state,expiresInS}`. Unset token => **404**
(never public-by-default: the media origin is LB-reachable, so session/job ids must
not be anonymous-readable).

```bash
curl -s "$MEDIA_SERVER_URL/health" | jq
curl -s "$MEDIA_SERVER_URL/node" -H "Authorization: Bearer $MEDIA_HEALTH_TOKEN" | jq
```

### Observation socket (`/stream/:sid`)

The node relays every runner observation to each socket attached to a session as a
**TEXT** JSON frame — `{"type":"observation","observation":{...}}` — so a browser can
`JSON.parse(e.data)` directly (`services/media/src/guarded-write.ts` `sendText`).
Frames used to be **BINARY** (`@fastify/websocket`'s SocketStream passes a string
write through as a Buffer, and `ws.send()` then picks the BINARY opcode): a browser
receives a `Blob`, `JSON.parse` throws, and a healthy fan-out reads as "zero
observations" on the client while the log shows `[rtc] obs seq=1..N` (ADAAAA-7678).
A client-side observation count is only meaningful next to `GET /node`
`sessions[].sockets` — that is the server-side "did the socket attach?" answer.

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

Live jobs record the same three fields at completion (`costUsd`,
`perceiveSessionS`, `decideCalls` from the observe pass). ADAAAA-7670 added the
live `costUsd`/`perceiveSessionS` write: before it a live job carried no cost at
all, so its spend was invisible in both `GET /media/node` and
`/admin/monitoring` even when the attribution row existed.

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
| `MEDIA_HEALTH_TOKEN` | media + server | unset | bearer for `GET /node`; unset => detail off (404). Set it in the deploy env (`docker/.env` on the box, not committed): both services read the same `${MEDIA_HEALTH_TOKEN}` from `docker/docker-compose.yml`, but a container created before that line existed keeps an EMPTY value until it is recreated — check with `docker exec highlights-media printenv MEDIA_HEALTH_TOKEN` (ADAAAA-7678). `sessions[].sockets` is the server-side answer to "did the observer socket attach?". |

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
