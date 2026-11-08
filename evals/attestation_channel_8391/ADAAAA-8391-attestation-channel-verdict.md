# ADAAAA-8391 — attestation channel: verdict

**Verdict: does not discriminate on the frozen ADAAAA-8343 set as stored. Lever closes
measured-negative.** The only measured channel the stored artifacts carry (the
`scoreBoardChanged` boolean) attests **1 of 15** goal windows and **2 of 22** no_goal windows —
a goal/no_goal rate ratio of **0.73x** where AC1 requires **>= 4x**, and it reaches **1/15**
goal windows where AC1 requires **>= 8/15**. The two stronger measured channels
(`ballOutcome=goal`, `goalCrossed=true`) are **absent from all 74 stored evidence blocks**, so
they attest nothing on this capture.

Precision therefore has to come from capture/quality ([ADAAAA-8371](/ADAAAA/issues/ADAAAA-8371))
or from the model read. No accept rule was built, nothing was deployed, and no inference ran.

- $0 throughout: offline replay of stored rows + stored perceive evidence. No `POST /jobs`,
  no GPU, no Livepeer debit, no decide/perceive call.
- This ticket deployed nothing and wrote nothing to prod. At measurement time (10:29Z) prod
  served `app/gemma.py` md5 `3797ff73a476d620d5762d395a199f04` — the eval-time guard the stored
  rows were decided by. At 10:33:46Z a **different** ticket's deploy (ADAAAA-8395 instrumentation
  merge `d2a274e`) restarted `highlights-decide` and moved the file to `41f9a9e1f2c398fb9984ec0af6a30fba`;
  that change is not attributable to this ticket and none of this measurement's numbers depend on
  prod's current guard (no rule was derived, nothing was replayed against the new build).
- Frozen set: 296 rows = 8 cells x 37 windows; `label-manifest.json` sha256
  `f6bea8ec97352b3385feac634a7c1c6e8461e01719f79db3c68a061140047ccf`;
  clip `kids-soccer.mp4` sha256 `420c7e7d8aed3d1610e2bb51cce9e66b46aa3bbe47d5c45d0a9fadfb38c13e63`.
- Inputs: `rows.jsonl` sha256 `81f6f303fb5700963f9b2598e088bf325f4e6ecba00345a176de7918c924271b`
  (the same 296 rows ADAAAA-8370/8387 replayed), perceive evidence
  `cache/evidence/{live,vod}/<window>.json` (74 files, bundle sha256
  `97d27f0302d85b47bbacc7eaa35186d69b2fe57ab8bce8f61e42acc19b597788`).

## Method

Channels are read **only** from the measured evidence block each decide row was decided on —
never from the model's self-reported `verdict.criteria` (that self-report is the confabulation
channel; ADAAAA-8120). The channels are exactly decide's
`measured_goal_attestation` (`services/decide/app/gemma.py`):

| channel | source field in the stored evidence |
| --- | --- |
| `ballOutcome=goal` | `evidence.ballOutcome` (case-insensitive `goal`) |
| `goalCrossed=true` | `evidence.goalCrossed === true` |
| `scoreBoardChanged=true` | `evidence.scoreBoardChanged === true` |
| timeline channels | `evidence.perceiveTimeline[].{ballOutcome,goalCrossed,scoreBoardChanged}` |
| verified score delta | `evidence.scoreboardDelta` / `goalLineDelta` |

Rows are the 296 recorded decisions (4 cells per rail share one rail-window evidence block).
Window rates are over the 37 distinct windows; a window counts as attested when a channel fires
on at least one rail. Ratio is a ratio of **rates** (goal windows 15 vs no_goal windows 22).

## 1. Channel coverage (74 stored evidence blocks = 37 windows x 2 rails)

| channel | present | attesting |
| --- | --- | --- |
| `ballOutcome` | 0 / 74 | 0 (`goal`) |
| `goalCrossed` | 0 / 74 | 0 (`true`) |
| `scoreBoardChanged` | 74 / 74 | **3** — `live|ks-n-0312`, `live|ks-n-0402`, `vod|ks-g-0117` |
| `scoreboardDelta` (verified delta) | 0 / 74 | — |
| `goalLineDelta` | 0 / 74 | — |
| `perceiveTimeline` | 0 / 74 | — |

The two homography channels are not merely negative: they are **empty**. Perceive produced no
goal-line attestation for any window of this clip (the decide prompt itself recorded
"goal-line ground-truth (perceive homography): not available"), even though the frame-derived
manifest says all 15 goal windows are `ball_in_net`. That is a capture capability gap, not a
decision-rule gap.

## 2. Discrimination (row level: 120 goal rows / 176 no_goal rows; window level: 15 / 22)

| channel | goal rows attested | no_goal rows attested | row-rate ratio | goal windows | no_goal windows |
| --- | --- | --- | --- | --- | --- |
| `ballOutcome=goal` | 0 / 120 (0%) | 0 / 176 (0%) | — | 0 / 15 | 0 / 22 |
| `goalCrossed=true` | 0 / 120 (0%) | 0 / 176 (0%) | — | 0 / 15 | 0 / 22 |
| `scoreBoardChanged=true` | 4 / 120 (3.33%) | 8 / 176 (4.55%) | **0.73x** | **1 / 15** | **2 / 22** |
| any measured channel | 4 / 120 (3.33%) | 8 / 176 (4.55%) | **0.73x** | **1 / 15** | **2 / 22** |

The classic 8370 framing (accepted rows only) is the same story: **4 of 35** true accepts
attested (11.4%) vs **8 of 30** false accepts (26.7%) — the channel is roughly **2.3x more
likely to fire on a false accept** than on a true one.

Interpretation: the score-board boolean is **anti-correlated with truth** on this set, and the
attestation channels that could plausibly discriminate (homography crossing / ball in net,
verified score delta) are empty in the stored artifacts.

## 3. Acceptance criteria

| AC | requirement | measured | result |
| --- | --- | --- | --- |
| AC1 discrimination | goal attested-rate >= 4x no_goal, and >= 8 of 15 goal windows | ratio 0.73x, 1/15 goal windows | **FAIL** |
| AC2 recall-safe | no accept rule may lower goal recall on any of the 8 cells | reject-unattested loses recall on 7/8 cells | **FAIL** |
| AC3 false-positive floor | score-board channel alone <= 1 of 22 no_goal windows | 2 of 22 (`ks-n-0312`, `ks-n-0402`) | **FAIL** |
| AC4 cost | $0: offline replay only | no job, no GPU, no debit, no decide/perceive call | **PASS** |
| AC5 latency | no new model call / no added live latency | measurement only; nothing added to the live rail | **PASS** |

AC2 per cell (rule: keep an accept only when a measured channel attests the goal):

| cell | v1 recall | recall under rule | delta |
| --- | --- | --- | --- |
| live_ctrl_280_320x180 | 0.2667 | 0.0000 | -0.2667 |
| live_280_768x432 | 0.4000 | 0.0000 | -0.4000 |
| live_140_768x432 | 0.2000 | 0.0000 | -0.2000 |
| live_70_768x432 | 0.2000 | 0.0000 | -0.2000 |
| vod_ctrl_280_640x360 | 0.4000 | 0.0667 | -0.3333 |
| vod_280_1080x608 | 0.4667 | 0.0667 | -0.4000 |
| vod_140_1080x608 | 0.3333 | 0.0667 | -0.2666 |
| vod_70_1080x608 | 0.0667 | 0.0667 | 0.0000 |

## 4. Why it fails — structural, not a tuning miss

1. **No homography on this capture.** `ballOutcome` and `goalCrossed` are absent in 74/74
   evidence blocks. Every one of the 15 labelled goals is `ball_in_net` by frame read, but
   perceive measured no goal-line crossing for any of them, so the two channels that could
   discriminate have no data at all on this set.
2. **The score-board channel is a bare boolean, and the frozen set's is unverified.** The
   harness fold (`eval8343b.py` on `livepeer-ai-x99`, shipped with ADAAAA-8343) ORs the
   per-frame `scoreBoardChanged` flag. Production's live path instead credits a **legible
   delta** — both sides parsed, `>= 2` contiguous OCR reads per side, one transition per run —
   in `deriveWindowAttestation` (`services/server/src/analyzer.ts:1742`, ADAAAA-8071/8078).
   The two no_goal attestations (`ks-n-0312` ocrHits=67, `ks-n-0402` ocrHits=28) are exactly
   the population that verification is supposed to reject, and this artifact cannot verify them.
3. **Neither the verified delta nor the timeline is recoverable from durable artifacts.**
   `scoreboardDelta`/`goalLineDelta` are dropped by the harness fold and are not in the decide
   evidence block either (`services/server/src/analyzer.ts:7248-7250` forwards only the three
   booleans); production does put `perceiveTimeline` in the evidence
   (`analyzer.ts:7213`) but the ADAAAA-8343 harness fold omits it. Raw OCR reads are not
   persisted: `analysis_events` is empty and `job_observations` stores tracks only (checked on
   `highlights-postgres`, read-only). So the verified-delta and timeline channels are
   **unmeasurable offline** from the frozen set — they are unmeasured, not proven negative.

Because of (2) and (3) I did not derive and price a new perceive-side change: the headline
channels cannot be measured on this set, so any priced pass would be buying data for a channel
whose discriminating power is still unknown. That re-measurement is an **instrumentation**
change (persist the raw per-frame signals: observations incl. OCR text, timeline, and the
legible delta), then re-fold offline at $0 — no new model call. It is not in this ticket's
scope and no inference is authorised by it.

## 5. No separable read in the frozen capture, either (context only)

Measured features that are **not** goal attestations (no homography/calibration exists in the
stored evidence), rank AUC goal-vs-no_goal per rail — 0.5 is chance:

| feature | live AUC | vod AUC |
| --- | --- | --- |
| `ocrHits` | 0.458 | 0.389 |
| `maxVelocity` | 0.635 | 0.506 |
| `trackCount` | 0.500 | 0.500 |
| `detections` count | 0.514 | 0.502 |
| last ball bbox x / y | 0.364 / 0.482 | 0.464 / 0.399 |
| `crowdEnergy` | 0.439 | 0.439 |

None separates the classes, so a post-hoc rule over the capture as stored would be noise. This
reinforces the capture/quality conclusion rather than offering a second lever.

## 6. Verification of this measurement

- **Fidelity gate PASS.** Running ADAAAA-8387's `evals/rescore_contract_guard.py` with the
  **deployed** decide app dir (`app/gemma.py` md5 `3797ff73a476d620d5762d395a199f04`) over the
  same frozen rows/evidence reproduces the recorded ADAAAA-8343 per-cell precision/recall table
  on **8/8 cells** and the same lost-goal sets — the inputs are byte-faithful.
- **Independent recompute.** A separate code path (direct glob over the evidence files, no import
  of the measurement module) reproduces 1/15 goal windows, 2/22 no_goal windows, 4/120 and 8/176
  rows exactly.
- **QA artifact agreement.** The emitted `perwin_8391.jsonl` is byte-identical (sha256
  `205418b4…a7393`) to ADAAAA-8387's replayed `perwin_v1.jsonl`: the per-row `attested`,
  `signals`, `pre/post`, truth and guard fields agree on **296/296 rows**. The ADAAAA-8370
  artifact contract (`cell, rail, window, truth, perceive_evidence, pre, post, guard,
  guard_code, attested, signals, criteria, reason, ttft_s, wall_s, usage`) is kept unchanged, so
  8387's re-score tool reads it as-is.
- **Unit tests.** `evals/tests/test_measure_attestation_channel.py` — 11 tests covering reply
  parsing, channel extraction (model-criteria must not attest), rate/window math, the perfect-
  channel infinite-ratio case, AC1/AC3 evaluation, the AC2 rule, AUC ties, and an end-to-end
  fixture run. `python3 -m pytest evals/tests/test_measure_attestation_channel.py -q` -> 11 passed.

## 7. Recommendation

- Close this lever as **measured-negative**, like ADAAAA-8370. Do not merge a guard change; the
  guard's flag stays an advisory audit record (PO ruling on ADAAAA-8389).
- Precision must come from capture/quality ([ADAAAA-8371](/ADAAAA/issues/ADAAAA-8371)) or the
  model read. On this frozen set the capture carries neither a homography crossing nor a
  verified score transition on 14 of 15 goal windows.
- If the PO wants the *verified-delta / timeline* channels re-tested, the prerequisite is
  storing the raw per-frame signals during capture (observations with OCR text + the legible
  delta + the timeline) so they can be re-folded offline at $0. That is instrumentation work,
  not inference, and belongs on its own ticket before any spend is considered.

## Reproduce

```sh
python3 evals/attestation_channel_8391/measure_attestation_channel.py \
  --rows rows.jsonl --manifest label-manifest.json \
  --evidence-dir cache/evidence --perwin-v1 perwin_v1.jsonl \
  --out score_8391.json --perwin perwin_8391.jsonl
```

Outputs: `score_8391.json` (sha256 `d530fb0b53f0047c39d90cbd49d25def79c9f784ea7c4e15499031ee141cdd41`),
`perwin_8391.jsonl` (sha256 `205418b471cab98c574356cf3c784875babd760ca1f9f38fdda330f6f41a7393`).
