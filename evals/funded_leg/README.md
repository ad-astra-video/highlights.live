# Funded-leg harness (ADAAAA-8489)

A funded cell may only spend inside the shape it was authorized for. This
harness is that rule, executable: one script that refuses a busy gate, stops on
the wall clock instead of on media progress, and writes authorized-vs-actual
duration and cost into the evidence.

Source incident: ADAAAA-8483 disclosure 2 — authorized `<= 300 s` / `<= $0.50`,
ran `perceiveSessionS 544.5` / `$0.6197`. The stop loop lost its stop moment and
a human ended the leg. A cap that depends on someone watching the clock is not a
cap.

## What it enforces

| rule | behaviour | exit |
|---|---|---|
| quiet-window preflight | samples the gate for the whole window before any metered call: 0 nonterminal jobs, media `capacity.activeSessions 0`, all lease counters 0, 0 pool `session=` markers (the workers log `session=<jobId>`; `session=cyc-` is a subset). Any bad sample, unreadable probe, or missing pool container refuses the leg. | `3` |
| hard wall-clock stop | stop fires at `--authorized-duration-s`, driven only by the monotonic clock. Media progress / `liveEdge` is never a stop input. | — |
| stop confirmation | if the job is not terminal within `--hard-stop-slack-s` (<= 10 s) the run exits non-zero; it never reports an unconfirmed stop as a valid leg. | `4` |
| metered-cost guard | aborts at `--abort-at-usd` (default: cap minus $0.05, i.e. **$0.60** on the $0.65 cap) on the money the leg has accounted. A **readable** `costUsd` is that money and is never overridden by a projection; a dark record falls back to `metered x the billed-unit rate` (`--billing-basis decide` prices `decideFee / cadence + perceive accrual`, `perceive` prices `--metered-rate-usd-per-s`). A wall-clock-only stop cannot hold the cap when metered seconds inflate (8483: 544.5 s metered inside a 300 s window). | — |
| no cost source | if neither `costUsd` nor `perceiveSessionS` is readable within `--cost-source-grace-s`, the leg is stopped and refused (exit 5). A leg with no metered guard is not authorized to run. | `5` |
| authorized-vs-actual | evidence JSON `shape` block + a ready-to-paste table and `AUTHORIZED-VS-ACTUAL:` line. Cost is graded on the same figure the guard uses (`max(costUsd, projection)`), so a projection-only leg that would meter over the cap reads `OVER`, not `WITHIN`. Overshoot is a field, not a discovery. | `0` within / `2` over |
| setup failure | job/session/driver failure stops whatever was created. | `5` |

Exit codes: `0` within, `2` over, `3` gate closed (nothing metered), `4` stop
unconfirmed or overshoot beyond slack, `5` setup refused/failed (including "no
readable cost source"), `7` stopped outside the guard (an operator/external stop
or a self-ended job — not gradable, see below).

### The guard must survive the caller (ADAAAA-8943)

Source incident: ADAAAA-8924 rev-8 live leg. The harness was launched from a
one-shot remote exec call and was killed with that session ~1 min after
`job created`. The wall-clock stop lived only in a daemon thread inside that
process, so nothing stopped the job: no `WALL-CLOCK STOP`, no evidence file, and
the leg settled `costUsd $1.4537` against a `$1.3000` cap (overspend `$0.1537`)
when an operator stopped it 1783 s after create. A stop that only exists while
the caller's terminal does is not a stop.

Three pieces close that, and all three are provable at `$0`:

| piece | what it guarantees |
|---|---|
| `launch_funded_leg.py --run-dir DIR` | the harness runs in its own session (`setsid`), stdin on `/dev/null`, stdout/stderr into `DIR/harness.log`, heartbeat + evidence inside `DIR`. Nothing depends on the launching terminal. |
| arm check (same launcher) | within `--arm-timeout-s` (default 30) it requires the `[leg] arm pid=… job=…` line, a heartbeat naming that pid and a job, and a live pid. Missing any of the three: it stops the job it can name, writes `DIR/arm.json` with `outcome: "arm_failed"`, and exits `8`. It never reports a supervised leg it could not prove. |
| `leg_supervisor.py` (launched beside it) | a second process that reads the heartbeat and issues `POST /jobs/{id}/stop` when the beat goes stale (`--stale-s`, default 45) or the heartbeat's `deadlineEpoch` passes by more than `--slack-s`. Verdict in `DIR/supervisor.json`. |

The harness writes `<run-dir>/heartbeat.json` atomically (`--heartbeat-path`) and
prints `[leg] arm …` plus `[leg] heartbeat t=… status=… cost=…` lines, so the arm
proof reads two independent facts rather than one.

Every bundle now names the stop source, and a leg this process did not stop is
**not gradable**:

- `leg.stopSource` / `leg.stopSourceClass` / `leg.stopSourceLine`, `shape.stopSource`
  (also the `stop source` table row) and `result.gradable`;
- `stopSourceClass: "external"` (an `operator_api` stop or a cancel) or
  `"job_self_ended"` (`job_content_end`) exits `7` with `result.outcome:
  "stopped_outside_guard"` and `result.gradable: false`;
- if the settled cost crossed the cap, `capBreach` carries `capUsd`,
  `settledCostUsd`, `overspendUsd` and the cause, so the breach is a field and
  not something a reader has to notice.

Gate probes never inherit the launcher's stdin (ADAAAA-8644). The SQL is passed
to `psql -f -` as input and every other probe reads `/dev/null`, so a
`screen`/pipe launcher cannot stall a probe until its timeout and an EOF cannot
read as a false "0 nonterminal jobs". A failed probe's exception text travels in
`preflight.errors` (and in each sample's `errors`) and is appended to the
refusal reason, so a `cannot prove quiet` refusal names its cause instead of
reading as a busy box.

The harness owns **stop + preflight + metered abort**; the launcher owns
**detached launch + the arm proof**; the supervisor owns **the stop the harness
can no longer issue**. The harness does not grade a leg:
PASS/FAIL/UNMEASURED belongs to the offline grader on `origin/master` 123da6b
(`services/server/src/live-leg-grade.ts`, `scripts/live-leg-grade.ts`) — and that
grader must treat `stopSourceClass: external` as ungradable.

### A guard process is not a guard (ADAAAA-9008)

Source incident: ADAAAA-8998 C2 leg `d46c3788` (file-sim, 1200 s authorized,
cap `$1.45` / abort `$1.31`). `arm.json` read `outcome: "armed"` and the
supervisor pid was live, then **both** guard processes disappeared in the same
second: `harness.log` froze at `t=793.8s`, `supervisor.log` was 0 bytes,
`supervisor.json` was absent, no traceback, no `dmesg` kill. Nothing issued a
stop, the job metered 782 s past the guard's death and 375 s past its clock, and
an operator API stop caught it. Spend stayed inside the abort by `$0.0417`.

A guard that only exists as processes is defeatable by one signal to the
session/cgroup they share. Three layers now answer that, and each is provable
at `$0`:

| layer | what it guarantees |
|---|---|
| the harness's own wall-clock stop | unchanged: fires inside the leg's process. |
| `leg_supervisor.py` (catchable death) | writes `DIR/supervisor.json` with `outcome: "watching"` as soon as it has a beat and refreshes `lastBeatAt` every `--watch-beat-s` (default 10), so "never armed" and "armed then killed" stop reading the same. It **always** logs its start and its death (`--quiet` only silences per-poll noise), catches `SIGTERM`/`SIGINT`/`SIGHUP`, records `outcome: "killed_while_watching"` with the signal, and issues the stop on the way out when the last beat still names a live phase (exit `6`). |
| `--deadline-guard auto` (uncatchable death) | the authorized deadline is committed to `systemd` as a transient timer (`systemd-run --unit=funded-leg-<job>-<fireEpoch> --on-active=…`), which lives under PID 1 outside every session/cgroup the guards share. On fire it runs `DIR/deadline_guard_stop.py` (mode `0700`, mints its own token if none was passed) and writes `DIR/deadline_guard_result.json` with `firedAt`/`lateByS`/the stop's HTTP. Fire time is `deadlineEpoch + hardStopSlackS + --deadline-guard-grace-s` (default 5), so it never races the harness or the supervisor. The supervisor disarms the timer when the leg ends. |

`--deadline-guard auto` (the default) **refuses a real leg** when the timer
cannot be committed: it disarms, stops the job it can name, writes
`arm.json:{outcome:"arm_failed", reason:"no durable deadline guard: …"}`, and
exits `8`. `--dry-run` records `skipped_dry_run` instead (the stub job lives
inside the harness process, so there is nothing external to stop);
`--deadline-guard none` is the explicit opt-out and says so in `arm.json`.

Read the arm proof as five artifacts, not one: launcher rc `0`,
`arm.json.outcome == "armed"`, `harness.log`'s `[leg] arm pid= job=` line,
`heartbeat.json` naming that pid+job with `deadlineEpoch`, and
`arm.json.deadlineGuard.durable: true` with `deadlineGuard.activeState:
"active"` (a read-back from `systemctl show`, not the `systemd-run` exit code).
A real leg whose `deadlineGuard.durable` is false ran with no layer that
survives both guards — treat it as ungradable.

`$0` proof, in order (all of it runs in ~2 min, no box, no job):

```sh
python3 evals/funded_leg/launch_funded_leg.py --run-dir /tmp/armproof --dry-run \
  --stub-scenario clean --authorized-duration-s 8 --cap-usd 0.65 --quiet-window-min 0.1
# rc=0, arm.json outcome=armed, deadlineGuard.kind=skipped_dry_run,
# supervisor.json outcome=finished + a non-empty supervisor.log "start pid=" line,
# evidence.json stopSourceClass=harness

python3 evals/funded_leg/launch_funded_leg.py --run-dir /tmp/extstop --dry-run \
  --stub-scenario operator-stop-overspend --authorized-duration-s 60 \
  --cap-usd 1.30 --quiet-window-min 0.1
# evidence exitCode 7, outcome=stopped_outside_guard, gradable=false,
# stopSource=operator_api / class=external, message carries the $0.1537 breach

python3 -m unittest evals/funded_leg/test_launch_funded_leg.py -v
# 37 tests: SIGTERM-while-watching stops the job and records the death,
# a killed supervisor on a finished leg does not amputate it, an inactive
# timer is not an armed guard, and a leg with no durable guard is refused+stopped
```

The same arm path was proved on `livepeer-ai-x99` (systemd 255) at `$0`: the
timer read back `ActiveState=active`, fired `0.4 s` late after the arming
process had exited, ran the generated stop script, and left no unit behind.


### The guard prices the unit the build bills (ADAAAA-8832)

`costUsd` on this build is `decideFee x (decideCalls + confirmCalls) +
summaryFee x summaryCalls + perceiveSessionS/3600 x $0.01`
(`packages/events/src/decide-knob.ts`, `services/server/src/api.ts`). The guard
therefore defaults to `--billing-basis decide`: a decide-billed live leg's clock
projection is `elapsed x (decideFee / cadence + perceive accrual)` (~$0.00067/s
at the shipped $0.0033324 fee and 5 s cadence), read from the server's
`LIVE_OBSERVE_CADENCE_S`. Pricing the same clock at the perceive-second rate
($0.0011381/s) is ~1.7x the real spend, and that is what stopped leg `27bd816f`
at 357 s of a 540 s shape with $0.2247 of a $0.46 cap unspent. Pass
`--billing-basis perceive` only for a cell that really bills by the perceive
second.

Two rules come out of that leg:

- a **readable** `costUsd` wins: a projection that disagrees with the money
  already accounted never stops a leg;
- the projection is frozen at the stop instant — settlement must not keep
  advancing it, or a stopped leg grades as over its cap.

The evidence names the basis on every block (`authorized.billing`,
`leg.projectedBasis`, `leg.meteredUsdPerS`, `shape.meteredRateBasis`), so a
reader never has to guess which unit a cost headroom was measured in.


## Dry-run (how the guard is proved, $0)

The harness runs the same loop against an in-process stub API — no box, no GPU,
no metered call:

```sh
# hard stop fires at a 60 s shape even though the stub leg never ends by itself
python3 evals/funded_leg/funded_leg.py --dry-run --stub-scenario clean \
  --authorized-duration-s 60 --cap-usd 0.65 --quiet-window-min 0.5 \
  --evidence-out /tmp/funded-leg-dryrun.json

# a busy gate (the 8483 shape) is refused before any metered call
python3 evals/funded_leg/funded_leg.py --dry-run --stub-scenario busy \
  --authorized-duration-s 300 --cap-usd 0.65 \
  --evidence-out /tmp/funded-leg-gate-closed.json

# the metered guard fires on the session-time projection when costUsd is
# unreadable; $0.60 is the default abort point on a $0.65 cap. Rate compressed
# so the crossing happens in seconds (same max(live, metered x rate) branch).
python3 evals/funded_leg/funded_leg.py --dry-run --stub-scenario clean-no-cost \
  --authorized-duration-s 480 --cap-usd 0.65 --metered-rate-usd-per-s 0.06 \
  --evidence-out /tmp/funded-leg-metered-abort.json

# a decide-billed leg whose record is dark (the live rail mid-leg) keeps running
# to its shape: the clock is priced per decide, not per perceive second
python3 evals/funded_leg/funded_leg.py --dry-run --stub-scenario decide-dark \
  --authorized-duration-s 5 --cap-usd 0.005 \
  --evidence-out /tmp/funded-leg-decide-basis.json

# ADAAAA-8943: an operator stop past the cap. Exit 7, not gradable, capBreach
# names the $0.1537 the 8924 leg overspent (check `result.outcome` and
# `capBreach`); `operator-stop-within` is the same stop under the cap.
python3 evals/funded_leg/funded_leg.py --dry-run \
  --stub-scenario operator-stop-overspend --authorized-duration-s 60 \
  --cap-usd 1.30 --quiet-window-min 0.1 \
  --evidence-out /tmp/funded-leg-operator-stop.json; echo "exit=$?"

# the same leg through the launcher: detached, arm-proved, with the fallback
# supervisor beside it. `arm.json` must read `outcome: "armed"`.
python3 evals/funded_leg/launch_funded_leg.py --run-dir /tmp/leg-run-8943 \
  --dry-run --stub-scenario clean --authorized-duration-s 8 --cap-usd 0.65 \
  --quiet-window-min 0.1
cat /tmp/leg-run-8943/arm.json /tmp/leg-run-8943/heartbeat.json
```

The detachment itself is proved by killing the launcher, not by reading it:
`test_launch_funded_leg.py` launches a leg, `SIGKILL`s the launcher's whole
session, and then asserts the harness still reaches its own
`authorized_duration` stop and writes evidence. `leg_supervisor.py` is proved
against a real localhost stop endpoint (a stale heartbeat must produce one
`POST /jobs/{id}/stop`), and the operator-stop scenarios assert exit `7` plus
`capBreach`.

Unit tests (stdlib `unittest`, ~3 min, no network beyond localhost):

```sh
python3 -m unittest discover -s evals/funded_leg -v
```

## Funded cell (the ADAAAA-8516 leg)

The authorized shape is **read from the leg ticket, not hard-coded**: 480 s with
a 500 s hard-stop ceiling, $0.65 metered (ADAAAA-8515), metered guard at $0.60.
Pass `--authorized-duration-s 480`; the harness stops at 480 s and tolerates
<= 10 s of overshoot, which is stricter than the card's 500 s ceiling.

At the authorized $0.0011381/perceive-second the cap is **571 s** of metered
time; the **$0.60** guard point is **527 s**, so the leg stops with ~44 s of
metered headroom before it could meter the cap. The evidence `authorized` block
records `abortAtMeteredS`, `capMeteredS`, and `abortMarginUsd` next to the dollar
figures, and `shape` records `meteredPerceiveSessionS`, `meteredWallRatio`,
`projectedCostUsd`, and `gpuHours`. `--abort-at-usd` may override the guard
point but the harness refuses an abort point at or above the cap.

Run from the repo root. The control stack (server, postgres, media node) is on
`livepeer-ai-x99`; the decide pool workers (`decide-gpu0/1/2`) are on the 5090
host, which is **not** reachable from x99 (ssh and docker TCP are closed). Two
ways to satisfy the pool clause, both machine-checked:

```sh
# (a) run on the box; the pool probe goes out through a host that can see it
HL_LEG_USER_ID=<qa user id> python3 evals/funded_leg/funded_leg.py \
  --authorized-duration-s 480 --cap-usd 0.65 --quiet-window-min 10 \
  --job-source browser --game-hint soccer \
  --driver-cmd 'sh docker/qa-drive-8035.sh --sid {sid} --seconds {seconds} --no-wait --log /state/drive-{sid}.log' \
  --cyc-box-cmd '<command that reaches ai-server-5090x3-1>' \
  --evidence-out /tmp/leg8516-evidence.json

# (b) run from the agent host and drive the box through a remote prefix
python3 evals/funded_leg/funded_leg.py \
  --box-cmd 'python3 /paperclip/.hermes/skills/komodo/scripts/komodo.py livepeer-ai-x99' \
  --cyc-box-cmd 'python3 /paperclip/.hermes/skills/komodo/scripts/komodo.py ai-server-5090x3-1' \
  --authorized-duration-s 480 --cap-usd 0.65 --quiet-window-min 10 \
  --job-source browser --game-hint soccer \
  --driver-cmd 'cd /home/brad/highlights.live && sh docker/qa-drive-8035.sh --sid {sid} --seconds {seconds} --no-wait --log /state/drive-{sid}.log' \
  --gpu-hours <measured> \
  --evidence-out /tmp/leg8516-evidence.json
```

If no route to the pool host exists, the preflight refuses (exit 3) rather than
assuming it is idle — that refusal is the guard working, not a harness bug.

`--token` / `HL_LEG_TOKEN` may be supplied instead of `--user-id`; otherwise the
harness mints a 4 h JWT inside `highlights-server` (needs `jsonwebtoken`, which
the server image has).

Verify the real probes at $0 before spending:

```sh
python3 evals/funded_leg/funded_leg.py --preflight-only \
  --authorized-duration-s 300 --cap-usd 0.65 --quiet-window-min 10 \
  --box-cmd '...' --cyc-box-cmd '...' --evidence-out /tmp/preflight.json
```

## Where the guard lives

`evals/funded_leg/funded_leg.py` is a single script. It owns the leg lifecycle
(preflight → job → media session → driver → poll → stop → settle → evidence), so
the next funded cell inherits the guard by calling it instead of writing a leg
loop. The legacy one-off leg scripts (`/tmp/legNNNN.sh`) did the gate check and
the stop by hand — that is the configuration that overshot on 8483, and it must
not be used for a funded cell.
