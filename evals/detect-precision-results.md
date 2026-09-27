# detect_precision.py — real-image detection eval harness (ADAAAA-5166)

Measurement harness comparing **fine-tuned vs base** Florence-2 detection on a
real-image held-out eval slice. Build leg of [ADAAAA-5159] §2.2/§4.3 under
parent [ADAAAA-3126]. Delivers the harness + eval-slice builder only; no GPU
spend.

## What's delivered

- `evals/detect_precision.py` — main harness. Metrics:
  - **detection precision (vocab-matched)**, overall + per class
  - **per-frame detection recall** (esp. `soccer ball` small object), incl.
    dropout-frame analysis
  - **ID persistence** via integration with `evals/track_metrics.py` / the
    repo `IoUTracker` (synthetic `track_label_manifest.json`, and the same
    scorer used by the tracker's own acceptance run)
  - §4.3 fine-tuned-vs-base delta vs the target table
- `evals/detect_schema.py` — pure-stdlib Python mirror of the shared
  `DetectionTrainingSample` Zod contract (`packages/events/src/index.ts`)
  used to validate the train/val manifests at eval time.
- `evals/build_detect_eval_slice.py` — materializes the **held-out eval
  slice** (`detect_eval_slice.jsonl`) from the validated val manifest,
  verifying each imageRef resolves to a real frame (real pixels), and reports
  class coverage vs the §1.3 targets.
- `evals/test_detect_precision.py` — 8 harness-accounting tests (schema
  validation + precision/recall/ID-persistence accounting vs a deterministic
  fixture backend). No model/GPU required.

## Backends

- `fixture` (default): deterministic — labelled boxes as "detections"
  (perfect model), with `--drop-class`/`--junk-fp`/`--drop` to exercise the
  precision/recall/ID-persistence accounting. Local self-check only, **not**
  model-quality evidence.
- `florence`: loads the real `FlorenceDetector`; `--model-base` and
  `--model-finetuned` for base vs fine-tuned. Runs on the GPU box where
  torch/transformers are installed.

## Example run (fixture, validates the accounting)

```
python3 evals/detect_precision.py --val evals/val_manifest.jsonl \
  --backend fixture --drop-class "soccer ball" --drop-rate 0.4 --junk-fp 3
```

Observed (fixture, base degraded to simulate junk-FPs + soccer-ball dropout):

| metric | fine-tuned (perfect) | base (degraded) |
|---|---|---|
| detection precision (overall) | 100.0% (10 TP / 0 FP) | 45.5% (10 TP / 12 FP) |
| soccer-ball per-frame recall | 100.0% (0 dropouts) | 75.0% (1 dropout) |
| tracker synthetic ID persist | 1.000 | 0.991 |

§4.3 precision delta captured (`+54.5 pts` here; real model run reports the
actual base→fine-tuned delta). Manifests validated against the shared
`DetectionTrainingSample` contract — schema validation passes (0 invalid).

## Running against the real labeled manifests

Sequence once the data-path leg ([ADAAAA-5164]) lands the real
`evals/train_manifest.jsonl` / `evals/val_manifest.jsonl`:

```
python3 evals/build_detect_eval_slice.py            # materialize held-out slice
python3 evals/detect_precision.py --val evals/detect_eval_slice.jsonl \
  --backend florence --model-base microsoft/Florence-2-base \
  --model-finetuned /runs/Florence-2-base-finetuned-<run>
```

[ADAAAA-5159]: /ADAAAA/issues/ADAAAA-5159
[ADAAAA-3126]: /ADAAAA/issues/ADAAAA-3126
[ADAAAA-5164]: /ADAAAA/issues/ADAAAA-5164
