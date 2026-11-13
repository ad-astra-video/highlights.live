# ADAAAA-8844 (Inc 2) — identity-verified score surface: measured evidence

Every number on the issue's AC table is produced by one of the three artifacts
below. None of them spends GPU: local pixel arithmetic plus PIL/numpy, and the
decide-rule A/B runs in-process.

## `identity-threshold-ac2.5.json` — the identity threshold (AC2.5)

Produced by `evals/scoreboard_identity_threshold_8844.py` on the box that holds
the labelled crop truth set (ADAAAA-8577 crops / ADAAAA-8578 truth):

```
python3 evals/scoreboard_identity_threshold_8844.py \
    --truth /tmp/eval8551/truth8578/scorebug-truth.json \
    --crops /tmp/eval8551/truth8578/crops \
    --perceive-app <perceive app dir> \
    --out evals/adaaa_8844/identity-threshold-ac2.5.json
```

62 crops carry a surface reading. Same-surface chromaticity drift:
p50 0.0156, p95 0.0349, max 0.3005. Threshold rule = 1.15 x max, rounded up to
2 dp = **0.35** (`SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD`). The printed-name
channel is legible on all 62 crops (`BAR`, `RMA`), which is why the rule can use
names as the corroborating conjunct.

Raw RGB is reported beside it for transparency only: it is exposure-dominated
(the washed-out crop reads 129 raw away from the consensus while sitting on the
same hue), so a raw-RGB bar would have to be wider than any real kit separation.

## `recall-ac2.2-ac2.4.json` — recall and the local cost (AC2.2, AC2.4)

Produced by `evals/adaaa_8844/measure-8844.py` against the same 62 crops, with
the job's real match context (Real Madrid red/white, FC Barcelona blue/grey):

- baseline (no identity measured = today's behaviour): 62 accepted
- patched (measured verdicts applied): 62 accepted, tolerance 0
- verdict distribution: 62 `consistent`, 0 `contradicted`, 0 `absent`
  → the measured bar demotes **no** genuine surface.
- identity pass cost: p50 8.01 ms, p95 8.79 ms, max 9.27 ms **per pass**, and
  at most 2 passes per session (one per measured surface), 0 per-frame work,
  0 added OCR calls.

The pass is therefore ~8-9 ms once or twice per session — not per frame — and it
runs inside perceive, not on the decide path.

## `latency-ac2.4.json` — the decide path is unchanged (AC2.4)

Produced by `evals/adaaa_8844/latency-8844.py` (in-process A/B, rule mode):

- pure `decide()` p50 baseline 3.8 µs; delta with an identity present is
  0.9 µs for `contradicted` and ≈0 (sub-µs, sign varies run to run) for
  `consistent`/`absent`.
- served `POST /app/highlight` p50 3.14 ms → 3.18 ms with the identity field
  (within run-to-run noise on a TestClient round trip).
- the request grows by 45 bytes only when a surface was measured; an unmeasured
  surface sends no key at all.

## Reproducing on the box ($0, no GPU)

Copy `services/perceive/app/surface_identity.py` beside its siblings with its
one relative import flattened (`from match_context import ...`), then run the two
scripts above with `--perceive-app` pointing at that directory. Nothing is
written outside the `--out` file; no job is reserved and no model is called.
