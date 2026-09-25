# INC-5 — Labeled eval set + acceptance-metric run (QA)

Exact task: assemble a labeled eval clip set (first live sport: soccer) covering
goals / near-goals / off-target / warm-up, then run the acceptance metrics from
research ADAAAA-4275 §6 and report pass/fail per metric with evidence.

## Contents

- `label-manifest.json` — labeled eval clip set definition. Each clip carries a
  machine-checkable ground truth (isHighlight, expected eventType, reaction
  label, ball-track references). Physical clip `source`/`startS`/`endS` are
  filled in by the eval run from the live sport feed; the phase inventory and
  labels are the acceptance set.
- `metrics_runner.py` — pure-stdlib accounting tool. Reads the manifest plus a
  trace of pipeline `OutboundEvent`s (packages/events contract) and prints
  PASS/FAIL for every acceptance bar in §6.
- `fixtures/synthetic-pass.json` — runner self-check that mirrors the
  component-test-verified behaviour, so the accounting (TP/FP, rates, medians,
  tracking aggregation) is validated. This is a runner test, NOT pipeline
  evidence.

## Run

```bash
python3 evals/metrics_runner.py evals/label-manifest.json evals/fixtures/synthetic-pass.json
```

## Evidence status (updated each QA heartbeat)

- Mechanism-level bars verified by the repo test suites on the integrated
  branch `feat/ad-4328-inc4` @ `6edb2f6` (all green, reproduced in QA):
  - ball-track persistence >= 95%   -> `services/perceive/tests/test_ball_track.py`
  - ground-plane speed error <= 15% -> `services/perceive/tests/test_pitch_homography.py`, `test_ball_signal.py`
  - possession accuracy >= 90%      -> `services/perceive/tests/test_possession.py`
  - Stage-A audio gate onset latency <= 1.5s -> `services/perceive/tests/test_audio_gate.py`
  - Stage-A <= 60% FP-rate accumulator -> `services/server/test/stage-a-metrics.test.ts`
  - people-reaction dimension + strict JSON in Gemma decide() -> `services/decide/tests/test_gemma.py`
- End-to-end GPU metrics (highlight recall live/VOD, precision, e2e latency,
  reaction-cited rate on real clips) require driving the deployed perceive+
  decide pipeline over the labeled clips. Filled in as that run completes.

## INC-7 / ADAAAA-4452 — track cap expansion (3 live / 8 VOD)

INC-7 raises the perceive object cap from MAX_TRACKS=2 to 3 concurrent live
objects / 8 VOD objects and verifies the mode carve-out, ball eviction-guard,
and measured per-track latency at the new cap. Delivered on top of the INC-6
find-and-track work:

- Mode carve-out locked: `session.mode_capacity()` -> 8 when a `clip_path`
  (VOD pass) is set, else 3 (live). Wired into the tracker the session builds.
  - `services/perceive/tests/test_capacity_modes.py` (5 tests)
- Ball eviction-guard holds as track count grows: 8 concurrent player tracks
  fill all slots while the dedicated `BallTracker` slot persists >= 95% under
  2-8% per-frame detection dropout and survives occlusion bursts at cap 8.
  - `services/perceive/tests/test_ball_persistence_at_cap.py` (5 tests)
- Measured per-track detect->candidate latency (CPU IoU path, 600 frames/fold,
  `services/perceive/tools/bench_latency.py`):
  - per-track incremental cost ~= 5.7 us/track
  - live cap 3 total step = 0.010 ms/frame; VOD cap 8 = 0.043 ms/frame
  - candidate trigger ~= 3.3 us; far inside the 1-5 s live budget.
    detect() (one Florence <OD> pass) is fixed per frame independent of track
    count; the track-count-sensitive step cost is sub-millisecond even at cap 8.
- No regression: full `services/perceive` suite green (165 passed) on the
  integrated branch, including INC-2/2b/3/4 tests and the INC-5 eval runner
  self-check (all 10 acceptance bars PASS on `evals/fixtures/synthetic-pass.json`).
