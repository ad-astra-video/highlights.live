# Deploy / reproducible path

Config item 15 from the [ADAAAA-16](/ADAAAA/issues/ADAAAA-16) plan: a
reproducible way to get new builds from repo -> the box (so the tunnel serves
current code). This doc is the source of truth for that path.

## Source of truth

- Repo: `https://github.com/ad-astra-video/highlights.live`
- Branch: `master` (this is what the live box serves)
- Deploy key: `~/.ssh/highlights_live_deploy_ed25519` (SSH host alias
  `github-highlights-live`); grants push to origin/master on this repo.

The beta-gate + waitlist + per-user quota code (entitlement ledger) lives in
`services/server/src/entitlements.ts` and is enforced by `auth.ts` /
`api.ts`. It is on `origin/master`; a fresh clone of master contains it.

## Build contract (reproduce from source)

The repo is a pnpm/npm workspace. The live web app + API are built from
`services/server` (API) and `webapp` (React SPA, output `webapp/dist`).

Local verification that a given HEAD is shippable:

```sh
npm ci
npx vitest run services/server/test/entitlements.test.ts \
  services/server/test/auth.test.ts services/server/test/api.test.ts \
  services/server/test/billing.test.ts services/server/test/waitlist.test.ts \
  services/server/test/wireframe.test.ts   # gate + quota suite
npm run build -w @highlights/webapp        # SPA tsc + vite build
```

## Deploy to the box (<GPU_BOX_HOST> / <PUBLIC_HOST>)

### Webapp build retention (ADAAAA-7917)

Every deploy rebuilds `webapp/dist` inside the `highlights-server` image, so a
container recreate would otherwise leave only the NEW build's content-hashed
assets. A tab that loaded `index.html` before the deploy then requests
`/assets/index-<old>.js` and — before this change — received the 1428-byte SPA
fallback document (`200 text/html`), which fails the module load and leaves a
dead page until the user reloads.

The server now does both halves itself, with no extra deploy step or mount:

- **Retention.** At boot it snapshots the configured `WEBAPP_DIST` into
  `${DATA_DIR}/webapp-assets/<buildKey>/` (`buildKey` = sha1 of `index.html`,
  12 hex chars). `DATA_DIR` is the bind-mounted `./data` volume, so snapshots
  survive a container recreate. The newest `WEBAPP_ASSET_RETENTION` snapshots
  are kept and the rest pruned (`[webapp] retained build …` boot line).
- **Serve path.** The SPA handler reads the live dist first, then the newest
  retained snapshot that still has the requested `assets/` file. A missing
  asset path (`.js`, `.mjs`, `.css`, fonts/images/sourcemaps) answers a real
  `404 {"error":"asset not found"}`; it never answers the SPA document. Client
  routes are extensionless, so history fallback (`/privacy` → `index.html`) is
  unchanged.

Knobs (server env; defaults match the shipped compose):

| env | default | meaning |
| --- | --- | --- |
| `WEBAPP_ASSET_RETENTION` | `5` | build snapshots kept across deploys; `0` disables retention (missing assets 404) |
| `WEBAPP_ASSET_ARCHIVE_DIR` | `${DATA_DIR}/webapp-assets` | where snapshots live (must be on the persistent data volume) |

Acceptance after a real deploy: `GET /assets/<hash>.js` for each of the last
`WEBAPP_ASSET_RETENTION` build hashes returns `content-type: text/javascript`
and the real bundle size, and an unretained hash returns 404 rather than
`text/html`.

### Edge caching of the serve path (ADAAAA-9312)

The public origin sits behind Cloudflare, which caches by **file extension** when
the origin sends no `cache-control` (`.js`, `.css`, fonts and images are on the
default list). The edge TTL then comes from the status code: **2 h** for
`200`/`206`/`301`, **3 min** for `404`/`410`. The `cache-control: max-age=14400`
the edge returns is the zone's *Browser Cache TTL* (4 h) stamped downstream
because the origin sent nothing — it is not the edge TTL. Measured 2026-11-22,
all read-only:

| time (UTC) | request | result |
| --- | --- | --- |
| 06:25:04 | origin loopback `GET /assets/nope-9312.js` | `404 application/json`, **no** `cache-control` — the header is edge-added |
| 04:13 → 06:13 | `/assets/index-ZZZZZZZZ.js` (pre-fix entry) | `200 text/html` `HIT`, `age` grew to 7072 s, then `EXPIRED` at ~06:13 — the 2 h `200` default, **not** 4 h |
| 06:26:01 | a never-seen `/assets/<hash>.js` | `404` `MISS`, then `HIT` with `age: 20` — a fresh 404 is edge-cached too (3 min) |

So the pre-fix fallback outlived its fix for the 2 h edge TTL: a tab could keep
reading `200 text/html` for a module the image had been answering `404` an hour
earlier, and a 404 written in the seconds before `archiveWebappBuild` finishes
was pinned for 3 min. Both are the same defect — the origin said nothing.

The SPA handler now states a policy on every response it emits, in both
`Cache-Control` and `CDN-Cache-Control` (Cloudflare gives the latter precedence
at the edge):

| response | policy | why |
| --- | --- | --- |
| asset-404, unknown `/api/` route, traversal refusal | `no-store` | a cached failure would hide the retained asset, or a route a later deploy adds, for the whole edge TTL |
| SPA document (`/`, `/index.html`, history fallback) | `no-cache` | an edge-pinned `index.html` names asset hashes the current image no longer ships |
| content-hashed asset (`assets/*-<hash>.js`, `assets/*.<hash>.css`, served from the live dist or a retained snapshot) | `public, max-age=31536000, immutable` | the URL pins the bytes, so a stale tab can keep loading its own build |

`no-store` in either header makes Cloudflare treat the response as not cacheable
and report `cf-cache-status: BYPASS` (Cloudflare evaluates `CDN-Cache-Control`
ahead of `Cache-Control`), so an asset-404 stops being pinned: the next attempt
for a hash that retention has archived by then is answered by the origin.

One Cloudflare-side lever defeats that: a **Cache Rule that sets Edge Cache TTL**
overrides origin `Cache-Control`/`CDN-Cache-Control` directives, `no-store`
included. Nothing in the measurements above shows such a rule — a rule-level 4 h
edge TTL would have kept the old entry `HIT` past 06:13 — so the header change is
expected to be sufficient. If the post-deploy read still shows
`max-age=14400` with `HIT`, the rule is the cause and it has to be changed in the
dashboard (`Caching` → `Cache Rules`), which needs the zone-scoped token below.

Verification after a deploy (AC2): the 404 body and both headers must appear at
the public origin, on a first request and again without a cache-buster ~2 s
later — record the pair in the deploy ticket.

```sh
curl -sSI https://<PUBLIC_HOST>/assets/index-DOESNOTEXIST.js
# HTTP/2 404
# content-type: application/json
# cache-control: no-store
# cdn-cache-control: no-store
# cf-cache-status: BYPASS   (DYNAMIC is also fine; MISS/HIT means a rule is pinning it)
```

Purging: **no purge credential exists on the box** — measured on the GPU box, `awk -F= '/^[A-Z_]+=/{print $1}' docker/.env | grep -iE
'cloudflare|cf_'` prints nothing. So a deploy cannot invalidate entries an
earlier build wrote; the edge TTL governs (2 h for a cached `200`, 3 min for a
cached 404) for anything written before the header change landed, and a
`?v=<random>` query is the way to confirm the origin while waiting.

If purging — or changing a Cache Rule — is ever sanctioned, it needs a
**zone-scoped token** for the `<PUBLIC_HOST>` zone, stored only on the box as two
env vars:

| env | meaning |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | scoped token for that zone only (never a global API key): Zone → Cache Purge → Purge, and Zone → Cache Rules → Edit if a rule has to be changed |
| `CLOUDFLARE_ZONE_ID` | the zone id the token is scoped to |

The deploy path would then purge the fallback entries after the recreate:

```sh
curl -sS -X POST \
  "https://<CF_API_HOST>/client/v4/zones/$CLOUDFLARE_ZONE_ID/purge_cache" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --header "Content-Type: application/json" \
  --data '{"files":["https://<PUBLIC_HOST>/assets/index-<old-hash>.js"]}'
```

(`{"prefixes":["https://<PUBLIC_HOST>/assets/"]}` purges the whole asset prefix
at once; both need the token above, so neither can run today.)

The live service runs on the deployment GPU box from the repo source,
served behind the Cloudflare tunnel (`cloudflared`) at
`https://<PUBLIC_HOST>`. The canonical stack is defined in
`docker/docker-compose.yml` (server :3000, media, perceive, decide, gemma,
orchestrator, postgres, email) and is started with:

```sh
git pull origin master          # or fresh: git clone
docker compose -f docker/docker-compose.yml up -d --build
```

### Perceive in-flight deploy gate (ADAAAA-7203)

The `highlights-perceive` runner is **capacity-1**: a staged deploy that recreates
it while a VOD/live analyze job is mid-pass drops the session and the job fails
`analyze failed: HTTP 502` and burns a full re-run. Before recreating the stack
(or `highlights-perceive` specifically), run the opt-in deploy gate:

```sh
DEPLOY_GATE_ENABLED=1 \
  HIGHLIGHTS_COMPOSE=1 \
  docker/deploy-gate.sh   # queries the RUNNING server's /admin/inflight-jobs
```

- **Opt-in** — `DEPLOY_GATE_ENABLED!=1` disables the gate and the deploy proceeds.
- **Bounded** — waits up to `DEPLOY_GATE_MAX_WAIT_S` (default 300) for in-flight
  jobs to drain; never blocks a deploy indefinitely (logs and proceeds on timeout).
- **Logged** — each poll logs the in-flight job ids and the time waited.
- **Fail-open** — if the endpoint is unavailable (pre-gate server, missing
  `HIGHLIGHTS_ADMIN_TOKEN`, server down) it logs the reason and proceeds; the
  in-flight resilience in the server re-reserves a fresh perceive session on a
  dropped session instead of losing the job to a generic 502.
- Auth: `HIGHLIGHTS_ADMIN_TOKEN` (or `HIGHLIGHTS_ADMIN_TOKEN_FILE`, default
  `~/.highlights_admin_readonly_token`) — a long-lived `admin_readonly` bearer
  token (minted with the server `JWT_SECRET`), which is rejected by every write
  route. The read-only principal is accepted on `GET /admin/inflight-jobs`.

### Funnel + CAC readout (ADAAAA-6385 / ADAAAA-6384)

`docker/admin-readout.sh` prints the ADAAAA-6368 conversion funnel
(`signup -> activate -> generate -> subscribe -> retain`), the per-channel
breakdown and the per-channel CAC (spend / paying subscribers) from the RUNNING
server, using the same read-only credential as the deploy gate:

```sh
docker/admin-readout.sh              # formatted readout
docker/admin-readout.sh --json       # raw /admin/funnel + /admin/spend payloads
HIGHLIGHTS_API_BASE=https://<PUBLIC_HOST> docker/admin-readout.sh
```

- GET-only: the `admin_readonly` token is accepted on `GET` and rejected by
  every write route, so this script can measure and report but can never record
  spend.
- Exit codes: `1` = no token found, `2` = an `/admin` request failed (server
  down or token rejected) — never a silent empty report.
- An empty `cac` array means the spend ledger has no rows for that channel, so
  CAC is **undefined** (no numerator). It is not `$0` and it is not evidence
  that the channel is cheap.

The server-side in-flight resilience (ADAAAA-7203) additionally maps a
`502/503/504` from the perceive analyze proxy to a re-reservable
`SessionLostError` (`analyze interrupted (deploy-recreate)`), so even a recreate
that slips past the gate lets `analyzeJob` re-reserve a fresh perceive session
and resume from the last persisted observation — the re-reserve itself retries
with the bounded exponential backoff (default 5 attempts / `VOD_SESSION_RETRY_*`
backoff) so a runner still re-registering after the recreate is re-acquired. It
only ends the job with a typed `analyze interrupted (deploy-recreate)` verdict
(cheaply retriable) if that bounded re-reserve is exhausted.

The **Developer** owns both legs of the deploy: getting the code onto
`origin/master` AND the box leg (reconcile the box branch to `origin/master`,
rebuild the stack, verify the tunnel serves current master). Routing change
2026-09-30 per [ADAAAA-6221](/ADAAAA/issues/ADAAAA-6221): all deploy tasks go
to the Developer; the Infra Monitor keeps read-only fleet health monitoring
only and no longer executes deploys.

## Live-payment durability (ADAAAA-3932)

The paid path (live/VOD -> orchestrator -> remote signer) is the source of the
recurring 402. Two things must survive every redeploy — both are documented in
`.env.example` at the repo root:

1. **Orchestrator ticket EV.** `docker/docker-compose.yml` hard-codes
   `- -ticketEV=80000000000` on the `orchestrator` service. Do not lower it:
   the default 8e9 makes go-livepeer size ~454-ticket live-payment lottery
   batches, which the signer rejects with 400 `numTickets N exceeds maximum of
   100` and the session fails 402 before any GPU compute. 8e10 keeps batches
   under the hard cap of 100 with unchanged total EV. Keep `TICKET_EV` in the
   box `.env` at `80000000000` too.

2. **SIGNER_URL + PAYER_ADDRESS.** These are required, non-empty values in the
   box `.env` (`SIGNER_URL=http://signer:7936`, `PAYER_ADDRESS=<payer
   address>`). The compose placeholders are `${SIGNER_URL:-}` /
   `${PAYER_ADDRESS:-}`, so if they are missing from `.env` a container
   recreate resolves them to empty and every paid session fails 402 "invalid
   live runner payment signer address". `SIGNER_AUTH_TOKEN` is the shared
   bearer secret sent to the remote signer and must also be in `.env`.

Define the full set in `.env` (copy `.env.example`). Never commit a real
`.env`; it holds `SIGNER_AUTH_TOKEN`, `ORCHESTRATOR_ETH_PASSWORD`, database and
SMTP credentials. After a repo-based redeploy, confirm with:

```sh
docker inspect highlights-orchestrator --format '{{.Config.Cmd}}'   # has -ticketEV=80000000000
docker logs highlights-orchestrator | grep TicketEV                  # | TicketEV | 80000000000 |
docker inspect highlights-media --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'SIGNER_URL|PAYER_ADDRESS'
```

## Live decide-observer (ADAAAA-7008)

The live path runs a cadence-driven decide-observer, not a candidate-gated
decide. The server drives a `LiveObserver` (`services/server/src/observe-loop.ts`)
that fires a single-shot decide on the ~3 s cadence
(`OBSERVE_CADENCE_S`) over a rolling-PAST ~10 s window
(`LIVE_OBSERVE_WINDOW_S` = `[now-10s, now]`, because a live observer cannot
decode ahead), hard-capped at <=30 frames (`LIVE_OBSERVE_MAX_FRAMES`).
`perceive` is the **data seeder** (`seeds`) + on-demand provider; its audio
noise-change and motion signals are **bias hints** (`biasHints`), never the
on/off gate. Live tracking stays <=3 objects (`LIVE_MAX_TRACKS`).

Runner registration for the live path (perceive = persistent session runner,
decide = single-shot fixed-price runner) is unchanged by this architecture —
each decide invocation is still a single-shot `unit: fixed` paid call through
`packages/livepeer-session`. The registrations themselves are dynamic: see
[Dynamic live-runner registration](#dynamic-live-runner-registration-no-runnersjson)
below. The **~30 s flag budget** (cadence + gemma end-to-end latency) and how it
is measured/reported on the Livepeer runner are documented in
[`docs/plan/09-live-observer-latency-report.md`](plan/09-live-observer-latency-report.md).

## Decide admission: capacity-wide ceiling + ordered 503 queue (ADAAAA-8254 -> ADAAAA-8437)

Every decide app-call (live observer, VOD pass, planner) is admitted through ONE
gate in `packages/livepeer-session/src/index.ts`. Two properties matter:

1. **The ceiling follows the capacity the fleet advertises.**
   `effective = clamp(advertised, 1, cap)`, where `advertised` is the sum of
   `capacity` over the `highlights-live/decide` runners the signer's
   `GET /discover-orchestrators` returns, and `cap` is the safety bound
   `DECIDE_MAX_ADMISSION` (default 32). Admission sizes UP as well as down: the
   board ruling on ADAAAA-8418 rejected the funded-8 ceiling ("The
   DECIDE_CONCURRENCY artificially limiting to 8 is wrong. It should just be
   limited by the capacity available"), superseding the ADAAAA-7803 framing and
   the ADAAAA-8254 "funded wins, discovery can only lower it" rule. Since
   ADAAAA-8553 S1 decide is registered per CONTAINER: five registrations
   (`highlights-decide-5090-1..3` at capacity 4 each, `highlights-decide-x99`
   and `-x99-b` at capacity 2 each) sum to `advertised`/`effective` 16 on the
   shared `highlights-live/decide` leaf. The x99 pair is real fallback capacity,
   not a router `backup` term, so it counts (the ADAAAA-8418 ruling).
   `DECIDE_CONCURRENCY` survives on the snapshot as
   `funded` for reporting only, and is the fallback when discovery is dark
   (`effective == funded`, a box that never probes is unchanged).
   **The cap is not a funding posture**: it guards a malformed advertisement (a
   duplicated runner id, a mis-set literal capacity, a registration that
   advertises more slots than its container has), so a bad discovery cannot
   open admission unboundedly.
   `capacity_available` is recorded but never sizes the gate (it is transient);
   two consecutive all-zero samples hold the queue (one probe per backoff
   window). Discovery errors / timeouts (2 s) / malformed answers keep the LAST
   KNOWN capacity, then the funded value — a probe failure never throws into
   decide and never yields 0.
2. **A 503 is recovered by an ordered queue, not a probe fan-out.**
   Waiters are FIFO by request order (a retry keeps its position). A 503 opens a
   SHARED pause window (exponential 500 ms → 8 s, with jitter); every queued
   decide waits on that deadline and exactly ONE of them probes per window, so a
   zero-capacity episode costs one decide probe per backoff window instead of one
   per queued request. A decide that exceeds its queue budget fails with the
   typed `DecideCapacityError`, increments `decideDropped`, and the live job
   CONTINUES (logged as `decide @<ts>s dropped by admission`).

Knobs (all unset = the defaults below, i.e. today's behaviour plus the shared
pause queue):

| Env | Default | Meaning |
|---|---|---|
| `DECIDE_CONCURRENCY` | client default 2; box ships 8 | **Funded** decide value — reporting only, and the fallback when discovery is dark (`effective == funded`). No longer a ceiling on a discovered advertisement. |
| `DECIDE_MAX_ADMISSION` | 32 | Safety CAP on a discovered advertisement (`effective = clamp(advertised, 1, cap)`). Not a funding posture: it bounds a malformed advertisement. |
| `DECIDE_CAPACITY_REFRESH_S` | 60 | Minimum seconds between signer capacity probes. A probe also runs (fire-and-forget) at every decide-job start. |
| `DECIDE_QUEUE_MAX_WAIT_MS` | 60000 | Hard per-decide queue-wait budget; exceeding it drops the decide with `DecideCapacityError`. |
| `DECIDE_CAPACITY_DISCOVERY` | on | `0`/`false`/`off`/`no` disables the capacity probe entirely (the byte-identical pre-8254 static gate). No signer configured => no probe regardless. |

Observability: the gate's counters land on the job's `observeMetrics` record
(`decideQueued`, `decideDropped`, `decide503`, `decidePauses`,
`capacityProbeErrors`, and
`decideCapacity: {advertised, funded, effective, probeOk, decideRegistrations, source, cap, at}`), so
QA can grade a run from `GET /admin/jobs/:id/window-audit` (admin) or the stored record without
reading container logs — including a media-rail (browser/RTMP) share, which folds
the snapshot it LATCHED at job start. `at` dates that snapshot (ISO wall clock).
ADAAAA-8504 renamed the old `runners` field to `decideRegistrations` in the
RECORD: the number counts decide registrations, and since ADAAAA-8553 S1 the box
registers FIVE per-container decide runners (`highlights-decide-5090-1..3` and
the x99 pair), so it is 5 — not a worker count backwards-compatible with the old
single `highlights-decide` aggregate. Old rows still parse (`runners` is read
back when present) and the
`[decide-capacity]` log line keeps its `runners=` label because ops greps it.
`probeOk`/`source` are provenance only (ADAAAA-8262): `probeOk: false`
means the last discovery probe FAILED, while `probeOk: true, decideRegistrations: 0` means
the signer answered and advertised no decide runner. `source` names where
`advertised` came from (`probe`, `last-known`, `funded`); none of the three
changes the ceiling arithmetic. The server also prints one
`[decide-capacity] advertised=… funded=… effective=… probeOk=… runners=… source=… cap=…`
line whenever the snapshot changes.

What must NOT change with this feature: `OBSERVE_CADENCE_S` (3 s), the 10 s live
window, the live frame budget, `LIVE_DECIDE_KEEP_RATIO`, the funded capacity, and
the VOD 402 → signer → retry path (VOD shares the gate and inherits the queue).

### Per-container decide registrations (ADAAAA-8553 S1)

`advertised` is the sum of `capacity` over the `highlights-live/decide` runners
the signer answers with. Since ADAAAA-8553 S1 the box registers ONE runner per
decide container, so five registrations — not a router pool — are the declared
routed set:

| runner_id | host | runner_url | capacity | metadata |
|---|---|---|---|---|
| `highlights-decide-5090-1` | <DECIDE_HOST> | `http://<DECIDE_HOST_LAN_IP>:8091` | 4 | `tier=5090, seqs=4` |
| `highlights-decide-5090-2` | <DECIDE_HOST> | `http://<DECIDE_HOST_LAN_IP>:8092` | 4 | `tier=5090, seqs=4` |
| `highlights-decide-5090-3` | <DECIDE_HOST> | `http://<DECIDE_HOST_LAN_IP>:8093` | 4 | `tier=5090, seqs=4` |
| `highlights-decide-x99` | <GPU_BOX_HOST> | `http://decide:8081` | 2 | `tier=x99-fallback, seqs=2` |
| `highlights-decide-x99-b` | <GPU_BOX_HOST> | `http://decide-b:8081` | 2 | `tier=x99-fallback, seqs=2` |

Every registration keeps `app=highlights-live/decide` and `proxy=0`, so
discovery capacity summing keeps matching and the runner id stays the route
(`/apps/<runner_id>/app/...`). `RUNNER_CAPACITY` is a LITERAL per-container
number — the worker's own `--max-num-seqs` — so a capacity change is a decision
about that container, not about a shared router file. The old
`RUNNER_CAPACITY=auto` derivation from `docker/decide-router.conf` is retired;
`decide-router` stays in compose as a manual/debug path and the `DECIDE_URL`
fallback.

Where the registrars run:

- **GPU box:** `registrar-decide-x99` and `registrar-decide-x99-b` in
  `docker/docker-compose.yml`, one per decide container, each probing
  `RUNNER_URL/health`.
- **5090 host:** `docker/registrar-5090.sh` starts
  `highlights-registrar-decide-5090-1..3` as `docker run --network host`
  containers on <DECIDE_HOST>, with `ORCH_URL=https://<GPU_BOX_LAN_IP>:8935`
  and runner urls `http://<DECIDE_HOST_LAN_IP>:809{1,2,3}` — the addresses S0
  (ADAAAA-8557) proved reachable. The orchestrator secret is resolved the same
  way compose resolves it: `ORCH_SECRET` in the environment, then
  `ORCHESTRATOR_SECRET`, then the box `.env`, then the compose default
  `${ORCHESTRATOR_SECRET:-...}` (the 5090 `.env` has no secret, so the last hop
  is what authenticates). The script prints only the SOURCE
  (`./docker/registrar-5090.sh --secret-source`) and hands the value to each
  container by name (`-e ORCH_SECRET`); it never prints the value.

The three-hop latency still applies, but every hop is now per registration:

| Hop | Bound | Why |
|---|---|---|
| registrar -> orchestrator registry | one heartbeat (5 s) | the sidecar heartbeats its literal capacity every tick |
| orchestrator registry -> signer snapshot | `-liveAICapReportInterval` (compose ships `60s`; go-livepeer's default is 25 MINUTES) | `/discover-orchestrators` serves a cached capability snapshot |
| signer snapshot -> server admission | `DECIDE_CAPACITY_REFRESH_S` (default 60 s, probed on the decide path) | `[decide-capacity]` only logs when the snapshot changes |

**Restart order.** A coordinated restart comes up with an EMPTY registry
(registrations are in-memory), so every registrar must re-register inside one
heartbeat:

1. Orchestrator first, in a QUIET window — its restart drops live sessions.
2. x99 registrars:
   `docker compose --env-file .env -f docker-compose.yml up -d --no-deps --force-recreate registrar-decide-x99 registrar-decide-x99-b`
   **and remove the retired aggregate sidecar** — compose leaves it running as
   an orphan otherwise, and it would register a sixth `highlights-decide`:
   `docker rm -f highlights-registrar-decide` (or add `--remove-orphans`).
3. 5090 host: `./docker/registrar-5090.sh` (re-creates all three sidecars; run
   `./docker/registrar-5090.sh down` first for a clean unregister).

For a SINGLE worker: restart that container, wait for its `/health`, then
recreate ONLY its registrar (`docker rm -f highlights-registrar-decide-5090-N`
and re-run the script on that host; on x99 `--force-recreate` only the one
sidecar). Never restart another container's registrar: a graceful shutdown
unregisters that id and releases its sessions, and a per-container fleet has no
reason to touch a healthy peer.

**Prove five registrations, never one:**

```sh
# exactly 5 after a coordinated restart. 1 means the retired aggregate sidecar
# is still what the box runs; 4 means one per-container registrar is missing.
docker logs --since 120s highlights-orchestrator | grep -c 'live runner registered'

docker logs --since 60s highlights-orchestrator | grep 'live runner registered'
# -> runner_id=highlights-decide-5090-1 / ...-2 / ...-3 / -x99 / -x99-b, x5

docker exec highlights-signer wget -qO- \
  'http://127.0.0.1:7936/discover-orchestrators?caps=highlights-live/decide' \
  | jq '[.[].runners[] | select(.app == "highlights-live/decide")]
        | {count: length, capacity: (map(.capacity) | add)}'
# {"count": 5, "capacity": 16}
```

**Failure isolation.** Stopping one decide container (or its registrar) removes
ONLY that `runner_id` within one interval + TTL (<= 25 s); its own sessions are
released and the other four stay `ready`. The sidecar probes only ITS OWN
`RUNNER_URL/health` and unregisters only ITS OWN id — a shared probe would flip
all five. That isolation is pinned in
`services/server/test/live-runner-registrar.test.ts`, which also pins the five
payloads (capacity 4/4/4/2/2, `app=highlights-live/decide`, tier+seqs metadata,
proxy omitted); `decide-admission-config.test.ts` pins the 16-slot sum. The old
`primary_count * seqs` pool pin is gone with the `auto` derivation.

**The router conf is still an inode, not a path.** `decide-router.conf` remains
bind-mounted into `decide-router`; a `mv`/atomic replace leaves the container
serving the OLD inode and `docker restart` does NOT remount it — only
`--force-recreate` does. Write the file in place (`cat new > decide-router.conf`)
or force-recreate, then prove membership from
`docker exec highlights-decide-router nginx -T`, never from the host file. This
now affects only the manual/debug path; registration capacity no longer reads it.

### Dynamic live-runner registration (no `runners.json`)

go-livepeer v0.9.2 has TWO registration paths (`ai/runner/live_runner.go`): the
static `-liveRunnerConfig` file, and dynamic registration over its internal HTTP
API. The box uses the second one — the static file and
`docker/render-runners.sh` are gone:

    POST /runners/heartbeat                Authorization: <ORCHESTRATOR_SECRET>   (first registration)
    POST /runners/heartbeat                Authorization: <heartbeat_secret>      (every 5 s thereafter)
    POST /runners/<runner_id>/unregister   Authorization: <heartbeat_secret>      (shutdown / unhealthy)

Dynamic registration is enabled by `-orchSecret` being non-empty; the
`registrar-perceive` sidecar and the five per-container decide registrars
(`registrar-decide-x99` / `-x99-b` in compose, `registrar-decide-5090-1..3` from
`docker/registrar-5090.sh`) all run `docker/live-runner-registrar.py` (image
`python:3.12-alpine`), present that secret on first registration and keep the
entry alive afterwards. The heartbeat TTL is 20 s, so the sidecar's 5 s interval
is what keeps each runner visible.

Two behaviours differ from the static path and are handled by the sidecar:

- **Readiness is reported, not probed, and it is PER CONTAINER.**
  `checkStaticRunnerHealth` only walks STATIC runners. Each sidecar probes only
  ITS OWN container's `/health` (perceive `/health`, decide `/health`),
  heartbeats `status: ready` only while that answers, and `POST
  .../unregister`s that one id when it does not — so a dead worker's sessions
  are released exactly as the static probe used to release them, and healthy
  peers are untouched. There is no shared/router health probe any more.
- **`runner_id` is the route.** The perceive client calls
  `/apps/highlights-perceive/session`; the decide client now calls
  `/apps/{runner_id}/app/...` for the runner its pool selection picked
  (ADAAAA-8559). Selection prefers `tier=5090` over `tier=x99-fallback`, then
  least local in-flight, then the least-recently picked runner, and a 503 /
  `404 runner not found` hops to the next runner that call has not tried yet
  (bounded by the unchanged attempt budget). The retired aggregate
  `highlights-decide` id survives only as the pre-probe fallback: while the
  discovery pool is empty (dark discovery / a single unnamed registration) the
  client behaves exactly as before. Each decide logs
  `[decide-runner] runner=... tier=... maxInFlight=...` and the job record
  carries `observeMetrics.decideRunners` (per-runner attempts / served / 503 /
  404 / peak concurrency), so spread and failover are graded from the record
  instead of nginx `up=` logs.

Restart order and the 5-line proof are in
[Per-container decide registrations](#per-container-decide-registrations-adaaaa-8553-s1)
above. Recreate the orchestrator, then the x99 registrars, then run
`docker/registrar-5090.sh` on the 5090 host — all in a quiet window, because an
orchestrator restart drops live sessions.

A runner whose container has no registrar sidecar is simply absent from
discovery (that is why `train`, which only ships in
`docker-compose.gpu.yml`, is not registered on this box).

`LIVE_AI_CAP_REPORT_INTERVAL` (compose default `60s`) is the knob for hop 2; set
it back to go-livepeer's default by removing the compose line (25 min) only if
the box stops needing live capacity changes. Unsetting it does not change the
registry's capacity, only how fast `advertised` reflects it.


### The signer must be able to verify the orchestrator's cert (ADAAAA-8262)

`advertised` comes from the signer's discovery poll, and that poll's `/discovery`
fetch uses a plain `http.Client` with the container's system roots
(`discovery/db_discovery.go` `callOrchestratorDiscovery`) — unlike the gRPC
`GetOrchestratorInfo` path, which sets `InsecureSkipVerify`. go-livepeer v0.9.2
regenerates the orchestrator's self-signed cert on **every** process start
(`server/cert.go` `getCert()`), so a pinned CA file (the ADAAAA-2957 fix) goes
stale at the next orchestrator restart; the poll failure is DEBUG-only, so the
only visible symptom is `GET /discover-orchestrators` → `503 cache empty` and
`decideCapacity.advertised = 0` (the ceiling then stays at `funded`).

`services/signer/docker-entrypoint.sh` therefore fetches the orchestrator's
**current** cert at container start, installs it into
`/usr/local/share/ca-certificates` and runs `update-ca-certificates`, then
re-checks it every `ORCH_CA_REFRESH_SEC` (default 300 s). On change it re-pins and
restarts the `livepeer` child — a restart is required because Go caches the
system root pool per process, so a disk-only CA refresh is never seen by the
running binary. `docker/orchestrator-ca.crt` remains mounted as the fallback pin
used when the fetch fails.

| Env | Default | Meaning |
|---|---|---|
| `ORCH_CA_REFRESH_SEC` | 300 | Seconds between orchestrator-cert re-checks by the signer entrypoint. On a fingerprint change it re-pins the CA and restarts `livepeer`. |

## Post-deploy live re-check (acceptance for this task)

After a deploy, confirm the served behavior matches source:

```sh
curl -s https://<PUBLIC_HOST>/health
# {"status":"ok","billing":"disabled"}

# hard beta-gate: non-invited register must be rejected 403 invite_required
curl -s -X POST https://<PUBLIC_HOST>/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"probe@example.com","password":"ChangeMe123!"}'
# 403  {"error":"invite required to create an account","code":"invite_required"}

# public waitlist capture
curl -s -X POST https://<PUBLIC_HOST>/waitlist \
  -H 'Content-Type: application/json' -d '{"email":"probe@example.com"}'
# 200  {"ok":true,"registered":true,...}
```

## Reviewer read path to the box (ADAAAA-7920)

QA/reviewer runs must be able to grade deployed clauses on the live box
(`GET /jobs/:id`, a server-log excerpt, a frame listing) without a human in the
loop. The supported path is the reviewer's **bound Komodo credentials**
(`env.KOMODO_API_KEY` / `env.KOMODO_API_SECRET` on the Highlights.live
Reviewer; secret names `deploy/komodo_api_key` / `deploy/komodo_api_secret` —
values are never stored in issues, comments, or this doc), used to run a
read-only script on `<GPU_BOX_HOST>`:

1. **Job record (AC-C1).** Job routes need a real DB user session, not the
   `admin_readonly` token (which 401s on every `/jobs/:id*` read). The script
   logs in on the box with the server's `ADMIN_EMAIL`/`ADMIN_PASSWORD` (read
   from `docker exec highlights-server printenv` into `chmod 600` temp files,
   never printed), then `GET http://localhost:3000/jobs/<id>` with that bearer.
   The response wraps the record as `{job, highlights, progress,
   liveProgress}`; per-clip cost rides on `job.vodMeter` where present.
2. **Log excerpt (AC-C2).** `docker logs highlights-server | grep -F <job-id>`.
   Beware the recreate window: a container recreated after the job's terminal
   time no longer carries its lines (`docker inspect -f
   '{{.State.StartedAt}}'` first); rotated `*-json.log*` files are deleted with
   the old container.
3. **DB facts.** `jobs` is `id, record, owner_id, status, created_at`; `record`
   is text JSON — select with `record::jsonb->>'<key>'`. The stored attempt
   field is `record->>'attempts'` (there is no `resume.totalAttempts`); the
   failure reason is `record->>'failureReason'` plus the fuller
   `record->>'error'`. Box role is `highlights`:
   `docker exec highlights-postgres psql -U highlights -d highlights -tAc ...`

The path is read-only **by instruction, not by permission model**: the bound
pair is the write-capable admin pair (the board declined a dedicated
read-only service user, ADAAAA-7675), so a reviewer run must treat it as
read/log-only — `docker ps|logs|inspect`, `psql` SELECTs, `curl` of read
routes — and never `docker compose up|restart`, config/`.env` writes, `git
push`, or migrations. Deploy and restart stay with the Developer / CEO.

Verified 2026-11-04 (ADAAAA-7920): `GET /jobs/6fef87c6-a564-499e-8336-18d79dd6b293`
-> 200 via this path, 37 server-log lines for the same id, image digests and a
`status=failed && source=file` enumeration captured.

## Verified deploy (ADAAAA-2505)

- Pushed commit on origin/master: `e7db4cd` (`b3a0afe..e7db4cd master -> master`),
  the merge of local master (with gate+quota commit `0334366`) and the box's
  prior origin/master (compose/gpu work).
- `git ls-remote origin master` -> `e7db4cddb8b147637cf60ba5771e39375a9bd990`.
- Live re-check above re-run against `https://<PUBLIC_HOST>`,
  outputs match the source routes exactly.
