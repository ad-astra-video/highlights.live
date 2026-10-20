# Soccer pass-1 prompt A/B — result (ADAAAA-7089, child of ADAAAA-7087)

Executed 2026-10-20 on `livepeer-ai-x99` against the deployed `highlights-perceive`
and `highlights-gemma` (vllm `cyankiwi/gemma-4-12B-it-qat-AWQ-INT4` at
`172.20.0.6:8088`) via the **direct-gemma** arm (`evals/drive_prompt_ab.py`).

## Method (prompt is the ONLY variable)

For each of the 12 labeled soccer clips the drive collects the honest multimodal
evidence ONCE — perceive `/app/analyze` per frame @ sampleFps=2, candidates, the
temporal frame window (decideWindowN=24), and the audio crowd-energy reaction
proxy — then calls gemma DIRECTLY with `apps.gemma.build_prompt(variant=...)`
for **every** variant (v0, A, B, C, D) on the SAME evidence. Perceive output,
frames, candidate set and reaction summary are identical across variants for a
clip. Only the prompt text differs. `parse_decision` is unchanged.

- Branch/commit: `feat/ad-7087-prompt-ab` @ d306d68.
- Candidate set: 96 candidates across the 12 clips (same set for every variant).
- Per-variant trace: `evals/vod_ab_trace_<V>.json` (events = candidate + decision,
  decision carries `framesJudged` + real `reason`).
- Scored with `python3 evals/metrics_runner.py --vod <trace> --live evals/inc9-trace-frames.json evals/label-manifest.json`.

## Per-variant gemma calls / time

| variant | gemmaCalls | gemmaSeconds |
| --- | ---: | ---: |
| v0 | 96 | 168.0 |
| A  | 96 | 121.1 |
| B  | 96 | 85.6 |
| C  | 96 | 94.2 |
| D  | 96 | 125.0 |

Total gemma inference across all 5 arms: ~594s (480 gemma calls) — far under the
ADAAAA-4960 7200 GPU-sec cap. The drive is a box-side direct-vllm run; it did
NOT route through the deployed `/jobs` billing path, so no list cost was billed.

## Bar-by-bar per variant vs the ADAAAA-4959 baseline

The manifest splits clips by `mode`: `vod` positives = soc-goal-03, soc-goal-04,
soc-near-02; `live` positives = soc-goal-01/02, soc-near-01. A2 recall **VOD** is
measured over the 3 `mode:vod` positives.

| bar | spec | ADAAAA-4959 baseline | v0 | A | B | C | D |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A2 recall VOD | >=90% | 100% PASS | **100%** PASS | **100%** PASS | 33% FAIL | 67% FAIL | 33% FAIL |
| A3 precision | >=70% | 50% FAIL | 50% FAIL | 50% FAIL | 50% FAIL | 50% FAIL | 44% FAIL |
| A4 out-depth D_vod vs D_live | D_vod >= 1.10x D_live | 26.8 vs 42.8 FAIL | 47.1 (-2%) FAIL | 64.1 (+33%) PASS | 48.6 (+1%) FAIL | 53.7 (+12%) PASS | 61.3 (+27%) PASS |
| A5 Stage-A FP | <=60% | 100% FAIL | 19.8% PASS | 15.6% PASS | 46.9% PASS | 35.4% PASS | 46.9% PASS |
| A6 onset | p95 <=5s | ~2.7s PASS | 2.0s PASS* | 2.0s PASS* | 2.0s PASS* | 2.0s PASS* | 2.0s PASS* |
| A7 reaction-cited | >=80% of TP | 17% FAIL | 100% PASS | 100% PASS | 100% PASS | 100% PASS | 100% PASS |
| strict-JSON parse | 100% | 100% | 100% | 100% | 100% | 100% | 100% |

\* A6 = 2.0s is a drive artifact: the direct-gemma arm stamps each decision at
`candidate.timestamp + 2.0`, so the scorer's onset span is a constant. The real
Stage-A onset path is unchanged (ADAAAA-4959 p95 ~2.7s shut), so A6 is reported
as unchanged/not-re-measured rather than as an improvement.

A4 note: `metrics_runner` computes the live baseline `D_live` from
`evals/inc9-trace-frames.json` as **48.1 (n=31)** in this run, whereas the
ADAAAA-4959 doc recorded **42.8 (n=49)**. A4 was assessed against the
scorer-computed 48.1; the ADAAAA-4959 documented 42.8 is shown for reference.

## Per-clip verdict (any isHighlight decision -> TP/FP)

| clip | phase | v0 | A | B | C | D |
| --- | --- | --- | --- | --- | --- | --- |
| soc-goal-01 | goal | TP(6) | TP(7) | TP(5) | TP(5) | TP(4) |
| soc-goal-02 | goal | TP(7) | TP(7) | TP(7) | TP(7) | TP(7) |
| soc-goal-03 | goal | TP(10) | TP(10) | TP(8) | TP(9) | TP(8) |
| soc-goal-04 | goal | TP(2) | TP(3) | **FN** | **FN** | **FN** |
| soc-near-01 | near_goal | TP(6) | TP(6) | TP(4) | TP(5) | TP(4) |
| soc-near-02 | near_goal | TP(6) | TP(7) | **FN** | TP(3) | **FN** |
| soc-off-01 | off_target | FP(13) | FP(13) | FP(13) | FP(13) | FP(13) |
| soc-off-02 | off_target | FP(6) | FP(6) | FP(2) | FP(4) | FP(3) |
| soc-warm-01 | warm_up | FP(2) | FP(2) | TN | TN | TN |
| soc-warm-02 | warm_up | FP(6) | FP(5) | FP(2) | FP(3) | FP(1) |
| soc-lull-01 | lull | FP(10) | FP(10) | FP(10) | FP(10) | FP(10) |
| soc-replay-01 | replay | FP(3) | FP(5) | TN | FP(3) | FP(1) |

## Verdict

**No prompt variant beats the current prompt (v0) on the acceptance criteria.**
- A3 precision >=70% is the gating bar and **every** variant fails it (44-50%).
  The root cause is relentless over-publishing on the negatives regardless of
  prompt: `soc-off-01` yields 13 highlight verdicts and `soc-lull-01` 10 under
  **all five** arms, so no prompt text clears the clip-level precision bar.
- **B, C, D regress A2 recall-VOD below the 90% bar** (33%, 67%, 33%): they
  suppress the negatives but also drop `soc-goal-04` (goal) and/or
  `soc-near-02` (near_goal) — i.e. the soccer-highlight discriminator and the
  multi-block variants trade recall for fewer false positives.
- Candidate **D** (the specific acceptance threshold in the issue: A3>=70% AND
  A4 D_vod>=1.10x D_live with no bar regressed) achieves **neither** A3 (44%)
  nor non-regressed A2-VOD recall (33%), so **D does not win**.
- **A** (detail-first narration only) is the most interesting arm: VOD recall
  stays 100%, out-depth jumps to 64.1 (+33% rel over v0), and Stage-A FP drops
  to 15.6% (lowest of any arm) — but it still fails A3 precision (50%), so it
  does not meet the bar either. It is the best candidate to carry forward for
  further refinement (e.g. paired with a stronger precision mechanism).

## Passing bars regressed

Relative to the ADAAAA-4959 baseline, the only previously-passing bar that
regresses is **A2 recall-VOD**: B (33%), C (67%), D (33%) all fall below the 90%
bar that v0 and A hold at 100%. A6 (real onset) is unchanged; A7/parse stay 100%
on all arms.

## Cost compliance

Within the ADAAAA-4960 caps as executed: ~594s of gemma inference across all 5
arms (480 gemma calls) is far under the 7200 GPU-sec cap, and the drive did not
trigger deployed list billing (direct vllm calls, not the `/jobs` pipeline).
Caveat: the direct-gemma arm drives all 96 perceive candidates, a much denser
set than the deployed Stage-A-gated 6, so its candidate-level cost is not a like
-for-like proxy for the deployed per-clip $0.055 avg.

## Artifacts

- `evals/vod_ab_trace_v0.json`, `evals/vod_ab_trace_A.json`, `evals/vod_ab_trace_B.json`, `evals/vod_ab_trace_C.json`, `evals/vod_ab_trace_D.json`
- `evals/drive_prompt_ab.py`
- This file: `evals/VOD-PROMPT-AB-RESULTS.md`
