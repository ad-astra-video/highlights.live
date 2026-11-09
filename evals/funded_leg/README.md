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
| metered-cost ceiling | stops early at `--abort-at-usd` (default `cap - min($0.05, 5%)`; a $0.65 cap aborts at $0.60, per ADAAAA-8487). Two independent sources: the job's live `costUsd` when the API exposes it, **and** the metered-time projection (elapsed since job create x `--metered-usd-per-s`, default the ADAAAA-8515 cap record's `$0.0011381/s`). The live path only writes `costUsd` at settlement, so the projection is what actually bounds metered time on a funded live leg — ADAAAA-8516 A1. `--metered-usd-per-s 0` refuses the leg (exit `5`). | — |
| authorized-vs-actual | evidence JSON `shape` block + a ready-to-paste table and `AUTHORIZED-VS-ACTUAL:` line. Overshoot is a field, not a discovery. | `0` within / `2` over |
| setup failure | job/session/driver failure stops whatever was created. | `5` |

Exit codes: `0` within, `2` over, `3` gate closed (nothing metered), `4` stop
unconfirmed or overshoot beyond slack, `5` setup refused/failed.

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
```

Unit tests (stdlib `unittest`, ~20 s, no network beyond localhost):

```sh
python3 -m unittest discover -s evals/funded_leg -v
```

## Funded cell (the ADAAAA-8516 leg)

Run from the repo root. The control stack (server, postgres, media node) is on
`livepeer-ai-x99`; the decide pool workers (`decide-gpu0/1/2`) are on the 5090
host, which is **not** reachable from x99 (ssh and docker TCP are closed). Two
ways to satisfy the pool clause, both machine-checked:

```sh
# (a) run on the box; the pool probe goes out through a host that can see it
HL_LEG_USER_ID=<qa user id> python3 evals/funded_leg/funded_leg.py \
  --authorized-duration-s 300 --cap-usd 0.65 --quiet-window-min 10 \
  --job-source browser --game-hint soccer \
  --driver-cmd 'sh docker/qa-drive-8035.sh --sid {sid} --seconds {seconds} --no-wait --log /state/drive-{sid}.log' \
  --cyc-box-cmd '<command that reaches ai-server-5090x3-1>' \
  --evidence-out /tmp/leg8516-evidence.json

# (b) run from the agent host and drive the box through a remote prefix
python3 evals/funded_leg/funded_leg.py \
  --box-cmd 'python3 /paperclip/.hermes/skills/komodo/scripts/komodo.py livepeer-ai-x99' \
  --cyc-box-cmd 'python3 /paperclip/.hermes/skills/komodo/scripts/komodo.py ai-server-5090x3-1' \
  --authorized-duration-s 300 --cap-usd 0.65 --quiet-window-min 10 \
  --job-source browser --game-hint soccer \
  --driver-cmd 'cd /home/brad/highlights.live && sh docker/qa-drive-8035.sh --sid {sid} --seconds {seconds} --no-wait --log /state/drive-{sid}.log' \
  --evidence-out /tmp/leg8516-evidence.json
```

If no route to the pool host exists, the preflight refuses (exit 3) rather than
assuming it is idle — that refusal is the guard working, not a harness bug.

The stop fires at the authorized duration (tolerance <= 10 s). For the
ADAAAA-8516 leg that is `--authorized-duration-s 480`, i.e. a stop at 480 s with
`--hard-stop-slack-s 10`: stricter than the card's 500 s ceiling, which remains
an upper bound, not a target.

### A1: the metered-time projection (ADAAAA-8516)

The server stamps its spend clock (`t0`) at the top of `runLiveJob`, before the
perceive reserve, and bills `perceiveSessionS = settle - t0`. A wall-clock stop
therefore cannot bound metered time: ADAAAA-8483 metered **544.5 s inside a
300 s window (1.815x)**. The harness projects that same clock from job create
and stops at `--abort-at-usd`, so a leg that pays startup/teardown inflation
stops before the dollar cap. Evidence carries `meteredProjectionS`,
`meteredUsdPerS`, `meteredProjectedUsd`, `perceiveSessionS`, wall seconds and
`meteredWallRatio` side by side.

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
