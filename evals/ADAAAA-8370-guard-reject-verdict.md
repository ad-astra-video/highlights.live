# ADAAAA-8370 — contract-guard lever (flag -> rejection): measured verdict

**Verdict: FAIL.** Turning the shipped contract guard's non-attestation FLAG into a
REJECTION cannot raise goal precision without cutting goal recall on the frozen
decide eval. Measured here by pure offline replay of the stored ADAAAA-8343 rows
(296/296), $0, no decide call, no GPU, no server or config change.

- Issue: ADAAAA-8370 (derived from ADAAAA-8347 §8 lever 1)
- Frozen eval set: `evals/label-manifest.json` sha256
  `f6bea8ec97352b3385feac634a7c1c6e8461e01719f79db3c68a061140047ccf`
  (clip `kids-soccer.mp4` sha256 `420c7e7d8aed3d1610e2bb51cce9e66b46aa3bbe47d5c45d0a9fadfb38c13e63`,
  37 windows = 15 goal + 22 no_goal)
- Stored rows: `/tmp/eval8343/rows.jsonl` on `livepeer-ai-x99` (296 rows, 8 cells),
  replayed against the DEPLOYED `services/decide/app/gemma.py`
  (container `highlights-decide` md5 `3797ff73a476d620d5762d395a199f04`) and
  against the same file with the ADAAAA-8370 change applied.
- Harness fidelity: the v1 replay reproduces the recorded ADAAAA-8343 per-cell
  precision/recall on 8/8 cells and the live control TP set exactly.

## What was implemented (branch, not for merge)

`apply_contract_guard` v2:

1. **Scope** also reads the model's own `verdict.criteria`
   (`ballCrossedLineBetweenPosts` / `ballInNet`) as a goal claim, so an accept
   whose goal-line claim never appears verbatim in the reason text is no longer
   out of scope. Criteria are used for SCOPE only, never as attestation.
2. **An in-scope accept with no measured attestation is rejected** (new refutation
   code `unattested_goal_accept`) instead of recording `unverifiable_evidence`
   and passing.
3. **Downgrade target: `not_highlight`** (not `near_miss`). A near miss asserts a
   shot was goal-bound and stopped, which needs its own measured signal
   (`ballOutcome=blocked|off_target`, already reconciled into `near_miss` before
   this guard); these windows carry no such signal — that absence is why they are
   un-attested. Suppression is metric-neutral (neither class counts as
   `scoring_play`), and it matches the measured pipeline posture: on the live rail
   all 12 FN of the 140 cell were `not_highlight`, 0 `near_miss`.

## AC1 — FAIL: 8 of the 30 flagged false accepts still score `scoring_play`

The as-specified rejection removes 22 of the 30. The remaining 8
(windows `ks-n-0312` x4 cells, `ks-n-0402` x4 cells) are measured-attested by
`scoreBoardChanged=true` — perceive's 60 s rolling / transient-OCR delta detector,
the known false-positive channel — so the guard keeps them. Rejecting those too
would remove 4 true accepts as well (see the separability table).

## AC2 — FAIL: every live control TP is lost

| rail | cell | TP set before | TP set after | attested flags (before) |
| --- | --- | --- | --- | --- |
| live | `live_ctrl_280_320x180` | `ks-g-0117`, `ks-g-0341`, `ks-g-0662`, `ks-g-0770` | `ks-g-0770` | all four `attested=false` |
| vod | `vod_ctrl_280_640x360` | `ks-g-0117`, `ks-g-0341`, `ks-g-0413`, `ks-g-0584`, `ks-g-0662`, `ks-g-0705` | `ks-g-0117` | only `ks-g-0117` `attested=true` |

The AC's own clause ("a TP whose only evidence was non-attested is not a TP")
applies to all four live control TPs and to 5 of 6 VOD control TPs — which is
exactly the reason the lever cannot work: perceive attests **1 of 15** goal
windows in this eval set, so "attested" describes 4 of 35 true accepts and 8 of
30 false accepts. Attestation is anti-correlated with truth here.

## AC3 — FAIL: precision rises only by collapsing recall

| cell | v1 P / R (TP/FP/FN) | as-specified P / R (TP/FP/FN) |
| --- | --- | --- |
| `live_ctrl_280_320x180` | 0.4000 / 0.2667 (4/6/11) | 0.3333 / 0.0667 (1/2/14) |
| `live_280_768x432` | 0.5000 / 0.4000 (6/6/9) | 0.0000 / 0.0000 (0/2/15) |
| `live_140_768x432` | 0.3750 / 0.2000 (3/5/12) | 0.0000 / 0.0000 (0/2/15) |
| `live_70_768x432` | 0.6000 / 0.2000 (3/2/12) | 0.0000 / 0.0000 (0/2/15) |
| `vod_ctrl_280_640x360` | 0.6667 / 0.4000 (6/3/9) | 1.0000 / 0.0667 (1/0/14) |
| `vod_280_1080x608` | 0.5833 / 0.4667 (7/5/8) | 1.0000 / 0.1333 (2/0/13) |
| `vod_140_1080x608` | 0.7143 / 0.3333 (5/2/10) | 1.0000 / 0.1333 (2/0/13) |
| `vod_70_1080x608` | 0.5000 / 0.0667 (1/1/14) | 1.0000 / 0.0667 (1/0/14) |

Goal recall falls on 7 of 8 cells (live control 0.2667 -> 0.0667; live 280
0.4000 -> 0.0000). Precision rises only where recall is decimated.

## Why: the flag does not separate true accepts from false ones

Per accept row (35 TP / 30 FP, across the 8 cells), every measured feature the
guard can read:

| feature | true accepts (TP) | false accepts (FP) |
| --- | --- | --- |
| measured attestation (any channel) | 4 / 35 | **8 / 30** |
| criteria claim goal-line + ball-in-net | 32 / 35 | 30 / 30 |
| reason carries a net/goal-line claim | 27 / 35 | 26 / 30 |
| reason cites a timestamp outside the window | 22 / 35 | 23 / 30 |
| measured `scoreBoardChanged` | 4 / 35 | 8 / 30 |
| perceive timeline goal read | 0 / 35 | 0 / 30 |

An exhaustive search over 10 boolean features (all conjunctions up to 3 literals,
with negations) finds **no** rule that removes the 30 false accepts without
removing true accepts. The best zero-TP-loss rule removes 4 of 30 — a single
window (`ks-n-0402`) in 4 cells, i.e. n=1 window, not a defensible guard.

This is the correction to ADAAAA-8343 §5: the guard does flag 30/30 false
accepts, but it flags them for the same reason it flags 34 of the 35 true
accepts — no measured channel attests the goal. "The guard knows and the accept
survives anyway" is true; "the guard can therefore reject them" is not.

## AC4 / AC5 — unchanged, and not exercised

The change is a pure post-processing branch inside the existing guard call site:
one decide call per window, vision token budget 280, frame scale 320x180 live /
640x360 VOD, `$/decide` $0.003321 baseline, decides/300 s 66 against the 69 gate,
every replicate still `cyankiwi/gemma-4-12B-it-qat-AWQ-INT4`. The whole
measurement is an offline replay of stored rows: no `POST /jobs`, no Livepeer
job, no debit allowance, no GPU time.

## Recommendation (needs a PO/CEO ruling)

Retire the lever as written. On this eval set the only deterministic way to raise
goal precision is to make the attestation channel carry real goal evidence
(perceive goal-line / ball-in-net attestation), or to change the model read — not
to reject un-attested accepts, which is a recall trade, not a precision lever.
Live capture 320x180 -> 768x432 (ADAAAA-8371) remains the other measured lever.

## Reproduction

```
python3 evals/rescore_contract_guard.py --module-dir <dir with app/> \
    --version v1 --rows rows.jsonl --manifest label-manifest.json \
    --evidence-dir <cache>/evidence --out score_v1.json --perwin perwin_v1.jsonl
```

Run once against the deployed `app/` and once against the ADAAAA-8370 `app/`;
the v1 run must reproduce the ADAAAA-8343 table before any comparison is read.
