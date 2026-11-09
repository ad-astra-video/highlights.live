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
| metered-cost guard | aborts at `--abort-at-usd` (default: cap minus $0.05, i.e. **$0.60** on the $0.65 cap) on whichever is higher: the live `costUsd` read or `perceiveSessionS x --metered-rate-usd-per-s`. A wall-clock-only stop cannot hold the cap when metered seconds inflate (8483: 544.5 s metered inside a 300 s window). | — |
| no cost source | if neither `costUsd` nor `perceiveSessionS` is readable within `--cost-source-grace-s`, the leg is stopped and refused (exit 5). A leg with no metered guard is not authorized to run. | `5` |
| authorized-vs-actual | evidence JSON `shape` block + a ready-to-paste table and `AUTHORIZED-VS-ACTUAL:` line. Cost is graded on the same figure the guard uses (`max(costUsd, projection)`), so a projection-only leg that would meter over the cap reads `OVER`, not `WITHIN`. Overshoot is a field, not a discovery. | `0` within / `2` over |
| setup failure | job/session/driver failure stops whatever was created. | `5` |

Exit codes: `0` within, `2` over, `3` gate closed (nothing metered), `4` stop
unconfirmed or overshoot beyond slack, `5` setup refused/failed (including "no
readable cost source").

The harness owns **stop + preflight + metered abort**. It does not grade a leg:
PASS/FAIL/UNMEASURED belongs to the offline grader on `origin/master` 123da6b
(`services/server/src/live-leg-grade.ts`, `scripts/live-leg-grade.ts`).

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
```

Unit tests (stdlib `unittest`, ~1 min, no network beyond localhost):

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
