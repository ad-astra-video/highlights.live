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
