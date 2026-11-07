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
decide = single-shot fixed-price runner, both advertised via
`docker/runners.json` and rendered by `docker/render-runners.sh`) is unchanged
by this architecture — each decide invocation is still a single-shot
`unit: fixed` paid call through `packages/livepeer-session`. The **~30 s flag
budget** (cadence + gemma end-to-end latency) and how it is measured/reported on
the Livepeer runner are documented in
[`docs/plan/09-live-observer-latency-report.md`](plan/09-live-observer-latency-report.md).

## Decide admission: capacity-aware ceiling + ordered 503 queue (ADAAAA-8254)

Every decide app-call (live observer, VOD pass, planner) is admitted through ONE
gate in `packages/livepeer-session/src/index.ts`. Two properties matter:

1. **The ceiling is capacity-aware, downward only.**
   `effective = min(funded, advertised)` clamped to `[1, funded]`, where
   `funded` is `DECIDE_CONCURRENCY` (the box runs 8) and `advertised` is the sum
   of `capacity` over the `highlights-live/decide` runners the signer's
   `GET /discover-orchestrators` returns (the 8/2/2 pool advertises 12).
   **`DECIDE_CONCURRENCY` is the funded ceiling that WINS**: capacity stays 8 by
   CEO ruling (ADAAAA-7803, ratified 2026-11-02), so a discovered advertisement
   can only LOWER admission, never raise it. `capacity_available` is recorded but
   never sizes the gate (it is transient); two consecutive all-zero samples hold
   the queue (one probe per backoff window). Discovery errors / timeouts (2 s) /
   malformed answers keep the LAST KNOWN capacity, then the funded value — a
   probe failure never throws into decide and never yields 0.
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
| `DECIDE_CONCURRENCY` | client default 2; box ships 8 | **Funded** decide ceiling — the value that wins. Discovered capacity can only lower admission below it. |
| `DECIDE_CAPACITY_REFRESH_S` | 60 | Minimum seconds between signer capacity probes. A probe also runs (fire-and-forget) at every decide-job start. |
| `DECIDE_QUEUE_MAX_WAIT_MS` | 60000 | Hard per-decide queue-wait budget; exceeding it drops the decide with `DecideCapacityError`. |
| `DECIDE_CAPACITY_DISCOVERY` | on | `0`/`false`/`off`/`no` disables the capacity probe entirely (the byte-identical pre-8254 static gate). No signer configured => no probe regardless. |

Observability: the gate's counters land on the job's `observeMetrics` record
(`decideQueued`, `decideDropped`, `decide503`, `decidePauses`,
`capacityProbeErrors`, and
`decideCapacity: {advertised, funded, effective, probeOk, runners, source}`), so
QA can grade a run from `GET /jobs/:id` without reading container logs.
`probeOk`/`runners`/`source` are provenance only (ADAAAA-8262): `probeOk: false`
means the last discovery probe FAILED, while `probeOk: true, runners: 0` means
the signer answered and advertised no decide runner. `source` names where
`advertised` came from (`probe`, `last-known`, `funded`); none of the three
changes the ceiling arithmetic. The server also prints one
`[decide-capacity] advertised=… funded=… effective=… probeOk=… runners=… source=…`
line whenever the snapshot changes.

What must NOT change with this feature: `OBSERVE_CADENCE_S` (3 s), the 10 s live
window, the live frame budget, `LIVE_DECIDE_KEEP_RATIO`, the funded capacity, and
the VOD 402 → signer → retry path (VOD shares the gate and inherits the queue).

### The routed set is what `advertised` must read (ADAAAA-8281)

`advertised` is the sum of `capacity` over the `highlights-live/decide` runners
the signer answers with. The box has exactly ONE such registration
(`highlights-decide` in `docker/runners.json`, `runner_url =
http://decide-router:8081`), so that registration's `capacity` **is** the declared
routed set — and `docker/decide-router.conf` is the same declaration seen from
the pool side:

| File | Field | Declares |
|---|---|---|
| `docker/decide-router.conf` | `upstream decide_pool` | three PRIMARY upstreams `192.168.1.151:8091/8092/8093`; the x99 pair `decide`/`decide-b` as `backup` (failover only) |
| `docker/runners.template.json` -> `runners.json` | `highlights-decide.capacity` | `3 primary workers x --max-num-seqs 2 = 6` |

Change the two together: the pool edit and the capacity edit are one fact, and
`services/server/test/decide-router-upstreams.test.ts` pins
`capacity === primary_count * 2` so they cannot drift silently. `DECIDE_CONCURRENCY`
stays the FUNDED bar (8); with L1 in force the box prints
`[decide-capacity] advertised=6 funded=8 effective=6 probeOk=true runners=1 source=probe`.
If the 6 ceiling ever binds (`maxDecideInFlight` pinned at 6 with
`decideQueued` rising), the answer is a fourth worker, not a higher funded bar.

Restore, one command per knob, each returning the pre-8281 state:

```sh
# pool: x99 pair primary again, no backup, no 5090 upstreams
cp docker/decide-router.conf.bak-8281-* docker/decide-router.conf
docker compose -f docker-compose.yml up -d --no-deps --force-recreate decide-router

# capacity: back to the fleet number (8091..8093 no longer in the balancing set)
DECIDE_RUNNER_CAPACITY=8 sh docker/render-runners.sh
docker compose -f docker-compose.yml up -d --no-deps --force-recreate orchestrator

# funded concurrency: NOT changed by this landing (DECIDE_CONCURRENCY=8)
```

**The bind-mounted conf is an inode, not a path.** `decide-router` mounts
`decide-router.conf` as a single file; a `mv`/atomic replace of the host file
leaves the container serving the OLD inode, and `docker restart` does NOT remount
it — only `--force-recreate` does. Measured on the 8281 landing: host md5
`708048fc…` vs container md5 `9ac3c308…`, `nginx -T` still listing 2 upstreams
after a reload that read the new host file. Write the file in place
(`cat new > decide-router.conf`) or force-recreate, then always prove membership
from `docker exec highlights-decide-router nginx -T`, never from the host file.


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
