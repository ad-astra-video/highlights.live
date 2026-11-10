# ADAAAA-8571 — AC-B shape-2 leg: goal-dense fixture + `$0` census

The single funded leg of record (`$0.65` / 410 s authorized / 430 s hard stop / abort
`$0.60` projected, one leg no retry) for the AC-B shape ratified on
`ADAAAA-8570#document-cap-record-2` rev `6bb5a746`.

## Why this exists

`kids510` cannot carry `n >= 9` attributed anchors because physical content diversity on
this box is **4 score transitions** (ADAAAA-8154: goals at 117 / 149 / 340 / 399 s in
`kids-soccer.mp4`). Leg 8534 (`kids510`, 484.5 s) delivered 7 rows that resolved to 4
anchors. So this leg grades **delivery density** — anchored rows in leg time — on a
fixture built to carry many transition instances inside 410 s, while `N` (the census)
prevents `n` from being inflated by re-delivery of the same moment.

## Files

| file | role |
|---|---|
| `windows_shape2.json` | the 12-window plan: 34 s each = 408 s, round-robin `t1,t2,t3,t4 x3` |
| `build_shape2_fixture.py` | builds the IVF fixture with **zero re-encode** and writes the manifest |
| `census_shape2_8571.py` | the `$0` production census (`POST /app/scoreboard` on a PRE and a POST frame per window) |
| `test_census_offline.py` | offline proof of the census client path against a stub probe |

## Step 0.1 — build (on the box; the reel lives there)

```sh
python3 build_shape2_fixture.py --self-test        # offline, $0, proves zero re-encode
python3 build_shape2_fixture.py \
    --reel /data/clips/kids-soccer.mp4 \
    --baseline-out /state/shape2_8571_src.vp8.ivf \
    --out /state/shape2_8571.vp8.ivf \
    --manifest /state/shape2_8571.manifest.json --verify
```

The reel is encoded **once** to VP8/IVF; from then on the fixture is cut as byte ranges
of whole IVF frame records, so every frame's compressed payload is copied verbatim and a
splice cannot change a decoded frame. Splices are snapped to I-frames (VP8 cannot cut a
predicted frame) and asserted `>= 3 s` inside a steady-score span, away from all four
transition instants. `--verify` compares per-frame decoded pixel md5 of the fixture
against the expected slice of the baseline — a re-encoded window fails it. Measured on a
408 s / 12 240-frame build: **12 240/12 240 frames identical**, duration 408.0 s, min twin
gap **132 s**.

## Step 0.2 — census (`$0` GPU, before any metered call)

```sh
docker cp /state/shape2_8571.vp8.ivf      perceive:/tmp/
docker cp /state/shape2_8571.manifest.json perceive:/tmp/
docker cp census_shape2_8571.py            perceive:/tmp/
docker exec perceive python3 /tmp/census_shape2_8571.py \
    --manifest /tmp/shape2_8571.manifest.json --out /tmp/shape2.8571.census.json
```

`N` = windows whose steady PRE frame and measurable POST frame **both** read a numeric
score and **differ**. `/app/scoreboard` runs one `<OCR>` crop per frame: no detection, no
SAM, no tracker mutation, no decide call, no Livepeer debit — that is why the census is
`$0`. The route is **not** on the public edge (`POST https://highlights-server.dpn.gg/app/scoreboard`
→ 404), so the census must run inside a container on the box.

`N < 9` → the leg does not run; AC-B closes as `N of N` with the 8154 ceiling named and
no cap spent.

## Step 0.3 — the `$0` gate from `cap-record-2` §3.2 (source-checked, not assumed)

The ruling requires proving, before the metered leg, that the dedupe gate is the 30 s
`goal_burst_same_transition` burst window and **not a per-transition lock**. Answer from
source (`services/server/src/analyzer.ts`, master `8abcf3a`):

- **Suppression is gap-bounded, not gap-independent.** `DEFAULT_GOAL_BURST_SUPPRESS_S = 30`,
  `GOAL_SAME_TRANSITION_HORIZON_S = 120` (ADAAAA-8146: a later candidate that re-measured
  the *same* transition key is suppressed out to `max(30, 120)`), `SHOOTOUT_KICK_DEDUP_S = 8`
  for a goal-shaped celebration. A twin 132 s away clears all three, so the fixture is not
  structurally capped at 4 anchors.
- **There IS one gap-independent ledger, and it is not a suppression:** `LiveRunShared.claimScoreTransition`
  credits each score transition **once per run** (`scoreTransitionKey` = `"pre0-pre1>post0-post1"`,
  no time component, bounded FIFO of 256 keys). A later window that re-measures the same key
  derives the instant but cannot attest it, so the accept is **demoted to a celebration row**
  (test `live-window-score-derive-dense-window-8078.test.ts`: "credits the transition once: the
  next overlapping window is unattested" → `downgraded unattested GOAL accept … to a celebration`).
- Consequence to state in the bundle: on this inventory a run can carry at most **4
  score-attested GOAL rows**; anchored rows beyond 4 can only ship as unattested celebration
  rows. AC-B grades anchored rows, so that is permitted, but `delivered GOAL` must be reported
  as `<= 4` and must not be read as a recall number.

## Verification actually run (this heartbeat, `$0`)

```
build_shape2_fixture.py --self-test                 -> SELFTEST PASS (5 windows, per-frame md5 equal)
real-size build (408 s fixture, baseline-in)        -> 12 240 frames, 408.0 s, min twin gap 132.0 s
verify_frame_identity(base510.vp8.ivf, fixture)     -> ok: 12 240/12 240 frames bit-identical
test_census_offline.py <manifest>                   -> PASS: 24 JPEGs, N=12 -> RUN, absent -> NO_RUN
vitest 8078 + goal-burst + goal-transition-dedupe   -> 61/61 tests pass
```
