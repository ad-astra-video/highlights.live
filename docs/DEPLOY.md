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

## Deploy to the box (livepeer-ai-x99 / highlights-server.dpn.gg)

The live service runs on the `.6` box (livepeer-ai-x99) from the repo source,
served behind the Cloudflare tunnel (`cloudflared`) at
`https://highlights-server.dpn.gg`. The canonical stack is defined in
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
HIGHLIGHTS_API_BASE=https://highlights-server.dpn.gg docker/admin-readout.sh
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
| `highlights-decide-5090-1` | ai-server-5090x3-1 | `http://192.168.1.151:8091` | 4 | `tier=5090, seqs=4` |
| `highlights-decide-5090-2` | ai-server-5090x3-1 | `http://192.168.1.151:8092` | 4 | `tier=5090, seqs=4` |
| `highlights-decide-5090-3` | ai-server-5090x3-1 | `http://192.168.1.151:8093` | 4 | `tier=5090, seqs=4` |
| `highlights-decide-x99` | x99 | `http://decide:8081` | 2 | `tier=x99-fallback, seqs=2` |
| `highlights-decide-x99-b` | x99 | `http://decide-b:8081` | 2 | `tier=x99-fallback, seqs=2` |

Every registration keeps `app=highlights-live/decide` and `proxy=0`, so
discovery capacity summing keeps matching and the runner id stays the route
(`/apps/<runner_id>/app/...`). `RUNNER_CAPACITY` is a LITERAL per-container
number — the worker's own `--max-num-seqs` — so a capacity change is a decision
about that container, not about a shared router file. The old
`RUNNER_CAPACITY=auto` derivation from `docker/decide-router.conf` is retired;
`decide-router` stays in compose as a manual/debug path and the `DECIDE_URL`
fallback.

Where the registrars run:

- **x99:** `registrar-decide-x99` and `registrar-decide-x99-b` in
  `docker/docker-compose.yml`, one per decide container, each probing
  `RUNNER_URL/health`.
- **5090 host:** `docker/registrar-5090.sh` starts
  `highlights-registrar-decide-5090-1..3` as `docker run --network host`
  containers on ai-server-5090x3-1, with `ORCH_URL=https://192.168.1.6:8935`
  and runner urls `http://192.168.1.151:809{1,2,3}` — the addresses S0
  (ADAAAA-8557) proved reachable. The orchestrator secret is inherited by name
  (`-e ORCH_SECRET`) and is never printed.

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
  `/apps/highlights-perceive/session`, and the decide client still calls a
  single fixed `/apps/highlights-decide/app/...` until the S2 client change
  lands (ADAAAA-8559). The decide registrations use
  `highlights-decide-5090-1..3` / `-x99` / `-x99-b`, so that fixed id is a known
  remaining single-id call site, not a registration: a client that keeps calling
  it cannot see the five runners.

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
curl -s https://highlights-server.dpn.gg/health
# {"status":"ok","billing":"disabled"}

# hard beta-gate: non-invited register must be rejected 403 invite_required
curl -s -X POST https://highlights-server.dpn.gg/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"probe@example.com","password":"ChangeMe123!"}'
# 403  {"error":"invite required to create an account","code":"invite_required"}

# public waitlist capture
curl -s -X POST https://highlights-server.dpn.gg/waitlist \
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
read-only script on `livepeer-ai-x99`:

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
- Live re-check above re-run against `https://highlights-server.dpn.gg`,
  outputs match the source routes exactly.
