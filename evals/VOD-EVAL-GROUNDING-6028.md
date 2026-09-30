# Grounded-event classification — faithful labeled-eval rerun (ADAAAA-6028, plan §G)

Executed 2026-09-29 on livepeer-ai-x99 against the **deployed grounded-decide build**
(`deploy-master` @ 317b3bd; highlights-decide + highlights-server recreated by
[ADAAAA-6039]). Drive: an in-container (hl network) TS driver replicating the real
detail-first VOD pass (`analyzeJob` + Stage-A audio tap; VOD_DETAIL_FPS=2,
640:360, decideWindowN=24) with the same `DirectAdapter` the deployed server uses
(`http://perceive:8080`, `http://decide:8081` → gemma-4-12b-it-qat-q4_0). Each raw
`decide()` response (incl. the new `grounding` object) and the server-side
`applyGroundingGate` outcome were captured per candidate → `grounding-trace.json`,
scored clip-level exactly as `evals/grounding_eval.py` (G1/G2/G3).

## Headline

- **G1 precision = 100%** (TP=4, FP=0): the board's primary complaint — "claimed
  goal for every highlight" — is **fixed**. All 6 negative clips
  (off-target / warm-up / lull / replay) produced **zero** false GOAL highlights.
  Baseline (VOD-EVAL-PASS1, pre-grounding) was **50%** (6/6 negatives falsely GOAL).
- **G2 recall = 66.7%** (TP=4, FN=2): regression from the baseline 100%.
  `soc-goal-01` and `soc-goal-02` (real goals) surfaced **no** GOAL highlight.
- **G3 rejections = 0** this run: no claimed-but-ungrounded candidate reached the
  gate because the model now self-gates — on every rejected frame it sets
  `grounding.supports=false` itself (isHighlight=false), so `applyGroundingGate`
  is a no-op (it only fires when a claimed isHighlight=true lacks evidence). The
  reject mechanism/counter is exercised and measurable; this eval set has 0 to count.

## Per-clip (12 labeled clips)

| clip | gt | claims(decide) | claimedHL | gate rej | surfaced GOAL | verdict |
| --- | --- | ---: | ---: | ---: | --- | --- |
| soc-goal-01 | goal | 8 | 0 | 0 | no | **FN (miss)** |
| soc-goal-02 | goal | 8 | 0 | 0 | no | **FN (miss)** |
| soc-goal-03 | goal | 12 | 1 | 0 | yes | TP |
| soc-goal-04 | goal | 4 | 2 | 0 | yes | TP |
| soc-near-01 | goal | 9 | 1 | 0 | yes | TP |
| soc-near-02 | goal | 5 | 1 | 0 | yes | TP |
| soc-off-01 | non-goal | 8 | 0 | 0 | no | TN |
| soc-off-02 | non-goal | 6 | 0 | 0 | no | TN |
| soc-warm-01 | non-goal | 6 | 0 | 0 | no | TN |
| soc-warm-02 | non-goal | 6 | 0 | 0 | no | TN |
| soc-lull-01 | non-goal | 7 | 0 | 0 | no | TN |
| soc-replay-01 | non-goal | 6 | 0 | 0 | no | TN |

`claims` = total decide() calls (candidates fired by perceive/audio); on the two
misses, **candidates fired normally (8/8)** but every decide returned
`isHighlight:false, grounding.supports:false` — the miss is a **decide-level
judgement**, not a candidate-detection or gate failure.

## Root cause (recall regression)

The grounding prompt (`services/decide/app/gemma.py`) is deliberately strict:
`supports=true` **only** if the frames literally show "ball-in-net / net-mesh /
scoreboard". On goals whose net-crossing moment is not visually crisp in the
2 fps / 640:360 sample window (or where the on-field evidence reads as "ball in
the middle of the field" at the sampled instants), Gemma sets `supports=false` on
every frame → no highlight. This is the precision/recall trade-off of grounding.

## Artifacts

- `evals/grounding-trace.json` — per-candidate raw decisions (with grounding) +
  per-clip gate outcome.
- `evals/drive_grounding_server.ts` — faithful in-container server-driven driver.

## Budget

12 jobs, ~$0.66 estimated GPU/decide (within the ADAAAA-4960 eval caps).

---

## ADAAAA-6079 — analyzer window-timing fix rerun (NEGATIVE RESULT)

Executed 2026-09-29 ~19:33 UTC on livepeer-ai-x99 against the ADAAAA-6079
deployed build (`deploy-master` @ 9d10613 = merge of `1749ffc`, analyzer
full-clip-timeline GOAL decide window, rev 2). Same in-container driver,
same 2 fps / 640:360 / decideWindowN=24, but with the fix path active:
`LiveRunShared.preloadTimeline()` + `framesWindowFor(.,"GOAL")` presenting the
**entire preloaded clip timeline** to every GOAL-candidate decide call.

### Result — fix DISPROVEN, recall regressed vs 6068 baseline

- **G1 precision = 100%** (TP=3, FP=0) — gate still holds.
- **G2 recall = 50%** (TP=3, FN=3) — **worse** than the 6068 rolling-window
  baseline (66.7%). `soc-goal-01`/`soc-goal-02` still missed;
  `soc-near-02` (TP in 6068) no longer surfaced.
- **G3 rejections = 0** (model self-gates, unchanged).

### Per-clip (this rerun)

| clip | gt | raw decides | claims | gate rej | surfaced GOAL | verdict |
| --- | --- | ---: | ---: | ---: | --- | --- |
| soc-goal-01 | goal | 8 | 0 | 0 | no | **FN** |
| soc-goal-02 | goal | 8 | 0 | 0 | no | **FN** |
| soc-goal-03 | goal | 12 | 6 | 0 | yes | TP |
| soc-goal-04 | goal | 4 | 2 | 0 | yes | TP |
| soc-near-01 | goal | 9 | 4 | 0 | yes | TP |
| soc-near-02 | goal | 5 | 0 | 0 | no | **FN (regressed vs 6068)** |
| soc-off-01 | non-goal | 9 | 1 | 0 | no | TN |
| soc-off-02 | non-goal | 6 | 0 | 0 | no | TN |
| soc-warm-01 | non-goal | 6 | 0 | 0 | no | TN |
| soc-warm-02 | non-goal | 6 | 0 | 0 | no | TN |
| soc-lull-01 | non-goal | 7 | 0 | 0 | no | TN |
| soc-replay-01 | non-goal | 6 | 0 | 0 | no | TN |

### Why the premise did not hold

The 6068 hypothesis was that the rolling decide window at the candidate's trigger
held only pre-goal frames, so decide() never saw the net-crossing. The rev-2 fix
gave decide() the **entire clip timeline** (every 2 fps frame) for every GOAL
candidate. The decisive negative evidence:

- goal-01 (8.05 s, 16 frames): all 8 decide calls returned `isHighlight=false`,
  `score=0`, `grounding.supports=false`, evidence e.g.
  "The ball is being dribbled by a player in the center of the field… no goal
  scoring act" — **identical to the 6068 read even though the whole clip was in
  frames[]**.
- goal-02 (12 s, 24 frames): same — "ball remains in the middle of the pitch, no
  goal scored" on every call.
- Contrast the 4 TPs: goal-03/04/near-01 decided `supports=true`, score 95,
  "The ball is seen entering the net and the player in red celebrates…".
  So the model DOES call a goal when the frames contain the net-crossing +
  celebration; for goal-01/02 it does not, even given all frames.

Corroborating clip forensics (local ffmpeg on the downloaded clips):
- goal-01 (`c57b67f0…`) is 8.05 s **with no audio track**; goal-02 (`8e0d65ca…`)
  audio RMS is a flat crowd (~1300–2400), no celebratory roar spike — no obvious
  goal-celebration aural cue.
- Both clips are single continuous shots (ffmpeg scene-select t>=0.3 found **no**
  hard cuts), consistent with a single wide build-up view.

Conclusion: the analyzer decision-window/candidate timing is **not** the cause of
the goal-01/02 misses. Presenting the full clip does not surface a
model-recognizable goal; and because the full-timeline window simultaneously
diluted soc-near-02, it is a net regression. The remaining untested lever is
higher-density / higher-resolution resampling around GOAL candidates (the 2 fps /
640:360 sample may not resolve a brief net-crossing), plus confirming whether the
goal-01/02 clips actually contain a visible net-crossing at all. This contradicts
the "do not re-litigate — it's a window-timing bug" premise and should be
re-triaged.

---

## ADAAAA-6079 — Corrected-label re-score after board ruling (RESOLVED, no code change)

Executed 2026-09-30. Board ruling (ADAAAA-6079 comment `0b80c0b7`) corrected two
mislabeled ground-truth samples in `evals/grounding-label-manifest.json`:

- `soc-goal-01` → **not a goal** (tough/ambiguous shot-on-goal; strange camera
  angle, clip ends right after the goal).
- `soc-goal-02` → **not a goal** (players dribbling at mid-field).

Both had been mislabeled `isGoal=true` from the board-flagged run `ced2ea19`.
The grounding analyzer **correctly declined to surface either** — its rejection
was right, not a recall miss. The analyzer/model is **byte-unchanged** between
the box-confirmed baseline run (deploy-master @ `32c5c6b`) and this re-score, so
per-clip surfaced-GOAL outcomes are identical; only the scoring labels changed.

### Result — ALL acceptance criteria PASS (G1/G2/G3)

- **G1 precision = 100%** (TP=4, FP=0) — PASS (>= 70%)
- **G2 recall = 100%** (TP=4, FN=0) — PASS (>= 90%)
- **G3 gate present**, 0 rejections (model self-gates) — PASS

### Per-clip (12 labeled clips, corrected ground truth)

| clip | gt | surfaced GOAL | verdict |
| --- | --- | --- | --- |
| soc-goal-01 | non-goal | no | TN |
| soc-goal-02 | non-goal | no | TN |
| soc-goal-03 | goal | yes | TP |
| soc-goal-04 | goal | yes | TP |
| soc-near-01 | goal | yes | TP |
| soc-near-02 | goal | yes | TP |
| soc-off-01 | non-goal | no | TN |
| soc-off-02 | non-goal | no | TN |
| soc-warm-01 | non-goal | no | TN |
| soc-warm-02 | non-goal | no | TN |
| soc-lull-01 | non-goal | no | TN |
| soc-replay-01 | non-goal | no | TN |

TP=4 FP=0 FN=0 TN=8.

### Conclusion

The ADAAAA-6079 analyzer decision-window/candidate-timing premise is fully
disproven AND now confirmed by the board to be a ground-truth-labeling error.
Every analyzer framing tested (rolling 2fps, forward-extend `c5cc021`,
full-timeline `1749ffc`, native-res density probe `ed39c9c`, baseline
`32c5c6b`) returns `supports=false`/score 0 for the two clips because there is
no modelable net-crossing/celebration in them — which is correct, because they
are not goals. No analyzer fix is warranted; baseline rolling-window behavior
already achieves G1=100% / G2=100% / G3 present on corrected labels.
