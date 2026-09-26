# Tracked-object accuracy measurement (ADAAAA-5050)

Run with the shipped tracker (`app.tracker.IoUTracker`, mode-capacity carve-out)
over the labeled soccer eval set (`evals/track_label_manifest.json`) via the
measurement harness `evals/track_metrics.py`.

## What is measured

Labeled eval set = ground truth over frames (soccer scenes); see
`docs/tracked-object.md` for the tracked-object definition (selection +
ID-persistence rules) that this scores against:

- **ID persistence** — fraction of a labeled object's on-screen frames carried
  by one dominant identity (no split/switch). Bar: >= 95%.
- **IoU** — mean IoU between the tracker's box and the labeled box over frames
  matched to the dominant identity. Bar: >= 0.50.
- **Max concurrent objects** — largest simultaneously-live track count;
  must reach the mode cap (live 3 / VOD 8) and never exceed it.

## Results (local CPU run, same tracker the deployed path uses)

Drop 0% (perfect detections):

| clip | mode | ID persist | IoU | max concurrent / cap | result |
|------|------|-----------|-----|----------------------|--------|
| soc-live-3 | live | 1.000 | 1.000 | 3 / 3 | PASS |
| soc-vod-8 | vod | 1.000 | 1.000 | 8 / 8 | PASS |
| soc-live-1-occlude | live | 1.000 | 1.000 | 1 / 3 (non-cap clip) | PASS |

Under simulated detector dropout (identical tracker, to bound robustness):

| drop | ID persist min | IoU min | max concurrent |
|------|---------------|---------|----------------|
| 5%  | 1.000 | 0.990 | 3 / 3 and 8 / 8 |
| 10% | 1.000 | 0.971 | 3 / 3 and 8 / 8 |
| 20% | 1.000 | 0.943 | 3 / 3 and 8 / 8 |

## Interpretation against acceptance

- **Tracked-object definition documented and applied** — `docs/tracked-object.md`
  (authoritative) + `packages/events/src/index.ts` contract comment; applied in
  live (`mode_capacity`=3) + VOD (`mode_capacity`=8) session/detect paths
  (`services/perceive/app/session.py`, `app/tracker.py`). Verified by
  `services/perceive/tests/test_capacity_modes.py` (174 perceive tests green).
- **Accuracy measured on labeled eval set** — ID persistence **1.000** (bar
  0.95), IoU **>= 0.94** at up to 20% detection dropout, numbers above. All PASS.
- **Max concurrent count** — live clip reaches **3/3**, VOD clip **8/8**,
  never exceeds cap (charter INC-7 target).
- **Tracking value vs cost / precision lift vs untracked baseline** — requires
  the deployed Gemma decide() highlight decision over the eval clips to compare
  tracked-count-driven reaction evidence vs untracked baseline. Deploy-dependent
  (GPU box); handed to QA + a follow-up measurement pass.
- **Livepeer GPU cost per tracked-object-minute** — requires the deployed
  live-runner GPU accounting (Florence detect + SAM3 track passes). Deploy-
  dependent; recorded method + handed off. See issue thread.

## Reproduce

```bash
python3 evals/track_label_manifest.py      # (re)generate manifest
python3 evals/track_metrics.py --drop 0     # score, 0% dropout
python3 -m pytest evals/test_track_metrics.py
```
