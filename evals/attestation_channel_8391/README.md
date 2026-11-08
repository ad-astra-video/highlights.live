# ADAAAA-8391 — attestation-channel measurement

Offline, $0 measurement of whether perceive's measured goal-attestation channel discriminates
true goal windows from no_goal windows on the frozen ADAAAA-8343 set (296 rows = 8 cells x
37 windows). Reads stored artifacts only; no decide call, no perceive call, no GPU.

- Verdict: [`ADAAAA-8391-attestation-channel-verdict.md`](ADAAAA-8391-attestation-channel-verdict.md)
- Tool: `measure_attestation_channel.py`
- Tests: `evals/tests/test_measure_attestation_channel.py` (11 tests)
- Outputs: `score_8391.json`, `perwin_8391.jsonl` (ADAAAA-8370 per-row contract, read unchanged
  by the ADAAAA-8387 re-score tool)

## Inputs (not committed — published as work-product artifacts)

| file | sha256 |
| --- | --- |
| `rows.jsonl` (296 rows) | `81f6f303fb5700963f9b2598e088bf325f4e6ecba00345a176de7918c924271b` |
| `label-manifest.json` | `f6bea8ec97352b3385feac634a7c1c6e8461e01719f79db3c68a061140047ccf` |
| `cache/evidence/{live,vod}/*.json` (74 files, tgz) | `97d27f0302d85b47bbacc7eaa35186d69b2fe57ab8bce8f61e42acc19b597788` |
| ADAAAA-8387 QA evidence bundle | `3313ef55eb6141dfa2dd4551cb2f19aabc62bb2e0a600b49cb25cc99fdd96ea6` |

The rows and manifest are the ADAAAA-8387 artifact `qa8370-evidence.tar.gz`; the evidence blocks
were pulled read-only from `/tmp/eval8343/cache/evidence` on `livepeer-ai-x99`. The 8391 artifact
work product bundles all of them plus this tool's outputs.

## Reproduce

```sh
python3 evals/attestation_channel_8391/measure_attestation_channel.py \
  --rows rows.jsonl --manifest label-manifest.json \
  --evidence-dir cache/evidence --perwin-v1 perwin_v1.jsonl \
  --out score_8391.json --perwin perwin_8391.jsonl
```

Fidelity: the replayed per-row outcome matches ADAAAA-8387's `perwin_v1.jsonl` on 296/296 rows,
and the deployed guard reproduces the ADAAAA-8343 per-cell P/R on 8/8 cells.
