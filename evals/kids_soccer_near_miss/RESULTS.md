# kids_soccer goal-acceptance precision (ADAAAA-7590)

Measured precision/recall for the accepted-GOAL path on `kids_soccer.mp4`
(777 s, multi-goal compilation), scored against frame-derived labels. This is
the number the ADAAAA-7477 post-bounce fix was missing: the earlier
"0 accepted windows whose own read refutes a goal (was 1)" is a
**self-consistency** metric, not precision.

## What is labelled

`label-manifest.json` holds **37 windows** (15 goal, 22 no-goal), each with
`t_start`/`t_end`, a `ground_truth`, an `evidence` value and the frame
timestamps that carry the proof:

- 15 goal windows — 14 ball-in-net plus one scoreboard-change goal at t=341
  discovered by the exhaustive catalogue scan (see *Goal catalogue*), each
  cited at 1 s frames.
- 22 no-goal windows — of which **10 are shot-class** (`saved` / `wide` /
  `blocked`: t=130, 178, 201, 351, 359, 402, 426, 622, 628, 722) and 12 are
  no-goal windows without a shot at goal (`evidence: "none"`). AC-1 is met at
  this count: the `>= 20` target was re-homed to the eval corpus by decision
  [ADAAAA-7686](/ADAAAA/issues/ADAAAA-7686) — see *AC-1 status*.
- The 660–720 s segment was inspected densely at 1 s steps end to end
  (windows at 660–684, 689–703, 700–715, 717–731); every goal in it is labelled
  (t=662, 678, 705, 719).

Labels come from pixels only: the job's 3 fps frames
(`GET /jobs/{id}/frames/{seq}`, `seq = round(3 * t)`) rendered as contact sheets
at 1 s steps, plus full-resolution single frames for every disputed call.
Decide's reason text was never used as a label — only as a hint for which
windows to inspect, and every such hint was verified or refuted on the frames
(e.g. decide's `near_miss` windows at t=45/90/144/183 turned out to be open
play, while its accepted windows at t=178/203/351/359/402 are saves/blocks).

## Goal catalogue (336–777 s exhaustive, plus a whole-video pass)

`detect_scoreboard_changes.py` is the objective half: it diffs the score-digit
box of the top-left scoreboard (x 112–154, y 14–31 of the 640×360 frames — the
running clock sits outside that box, so a ticking clock is not a trigger) on
every consecutive visible second and emits candidate goal instants. It is a
candidate generator, not a labeller: a broadcast cut re-renders the overlay and
also moves the digits.

Run: `python3 evals/kids_soccer_near_miss/detect_scoreboard_changes.py
--frames <frame dir> --out results/goal_candidates.json`

The committed catalogue (`results/goal_candidates_catalogue.json`, commit
`8f80eaf`) holds 22 candidates covering 336–777 s.

- **Confirmed goal: t=341** — scoreboard `RMA 1-1 BAR` at t=340 → `RMA 2-1 BAR`
  at t=341, scorer card "11 MANUEL ORDOÑEZ, GOLES: 1" at t=344, players
  celebrating 341–343. Added to the manifest as `ks-g-0341`. It was missed by
  the original pipeline-seeded labelled set, which is why the pre-existing
  recall of 100 % was labelled-set recall only.
- **Still queued: the other 21 candidates** (t=23, 29, 42, 92, 99, 226, 229,
  273, 282, 308, 335, 359, 380, 385, 393, 480, 503, 507, 535, 710) have not
  been frame-confirmed/refuted in a committed run. t=359 and t=393 fall inside
  the already-labelled save windows `ks-n-0359` / `ks-n-0402`, so they cannot
  add a goal; the rest need a 1 s frame pass.

Every goal in the 660–720 s segment stays labelled (t=662, 678, 705, 719); that
segment was inspected at 1 s steps end to end in ADAAAA-7590, and the catalogue
scan raised no additional candidate inside it.

## Scorer

`score_goal_precision.py` is pure stdlib and headless:

```bash
python3 evals/kids_soccer_near_miss/score_goal_precision.py \
  --manifest evals/kids_soccer_near_miss/label-manifest.json \
  --job-detail <job detail json from GET /jobs/{id}/detail> \
  --commit da2d21a --json evals/kids_soccer_near_miss/results/da2d21a.json
```

It prints accepted windows, ground-truth goals, precision, recall, the
false-positive list with `t` and decide's reason text, missed goals, duplicate
cards and the old self-refuting count. `--fail-under-precision 0.70` makes the
scorer a regression gate (exit 1 below the bar).

A card credits a goal when its clip window overlaps the goal window (>=1 s) or
its `localizedTs` is within 10 s of the goal instant (about the clip's
before+after); the second arm keeps a card that surfaces the celebration/replay
of a goal from being scored as a false positive.

Self-check (no ffmpeg, no GPU, no network): `python3 -m pytest
evals/kids_soccer_near_miss/tests/test_score_goal_precision.py` — 14 tests,
including a synthetic "reverted guard" acceptance set whose precision drops to
66.7 %, so the harness's red/green signal for the post-bounce class is proven,
and the synthetic two-clip corpus below (7 tests).

### Corpus mode — pooled aggregate across per-clip manifests

The `>= 20` hard-negative target is a **corpus** target (see *AC-1 decision*),
so the scorer also scores N `(manifest, job detail)` pairs in one invocation and
emits the per-clip rows plus one **pooled** row. Entry point (one documented
invocation, no wrapper): `--corpus <file>` or a repeated `--pair
MANIFEST:JOB_DETAIL[:COMMIT]`.

```bash
# corpus file: evals/kids_soccer_near_miss/corpus.json
python3 evals/kids_soccer_near_miss/score_goal_precision.py \
  --corpus evals/kids_soccer_near_miss/corpus.json \
  --json evals/kids_soccer_near_miss/results/score_corpus.json \
  --fail-under-precision 0.70
```

`corpus.json` is the corpus definition: a `clips` list of `{label, commit,
job_id, manifest, job_detail}`. `manifest` is repo-relative, `job_detail` is a
local cache of `GET /jobs/{id}/detail` (re-fetch per *Reproduction*). **Adding a
clip is a data append to that list — not a code change.** The corpus file itself
is written by hand; the numbers are only ever produced by re-running the scorer.

**Pooling rule — weighted ratios, never the mean of the per-clip ratios:**

```
pooled precision = sum(TP cards) / (sum(TP cards) + sum(FP cards))
pooled recall    = sum(credited goals) / sum(labelled goals)
```

Averaging percentages over-weights a clip with a small accept set and hides
corpus variance: 2 cards at 100 % plus 8 cards at 50 % is **60 %** corpus
precision, not 75 %. The pooled row is a gate input; the naive clip-average is
still printed (`naive clip-average`, `corpus.mean_clip_precision_rejected`) next
to the pooled figure purely for contrast — it is never gated on. Per-clip
precision/recall are printed alongside the pooled row so the spread is visible;
`min_clip_precision` is reported too. Pooled recall counts *credited goals*, not
TP cards, so duplicate cards on one goal cannot push recall above 1.0 (identical
to the TP-card sum whenever there are no duplicates).

Gates: `--fail-under-precision` now applies to the **pooled** figure in corpus
mode (unchanged, per-clip, in single-clip mode) and
`--fail-under-clip-precision` additionally floors every clip on its own
(a clip with no accepted cards has `precision: null` and fails a per-clip
floor — an unmeasured clip must not silently pass).

**Corpus hard-negative count** (ADAAAA-7690's headline metric) is emitted per
clip and summed in the pooled row: a *verified shot-class non-goal window* is a
labelled `no_goal` window whose `evidence` is `saved`, `post`, `blocked` or
`wide`. Windows labelled `evidence: none` rule out a goal but do not assert a
shot, so they are not counted. The count is derived from the manifest windows,
and a manifest that declares `coverage.non_goal_shot_class` is cross-checked
against the derived number (`hard_negatives_declared_matches`, plus a `WARNING`
line in the report on mismatch).

Current corpus: **1 clip** — `results/score_corpus.json` reproduces the
single-clip figure exactly (78.26 % precision / 100 % recall, 10 hard negatives),
which is also the proof that corpus mode is additive. The second clip
([ADAAAA-7690](/ADAAAA/issues/ADAAAA-7690)) appends a row and is where the pooled
figure first differs from the `da2d21a` row.

Self-check for the pooling arithmetic is offline and synthetic
(`tests/fixtures/two_clip_corpus/`): clip-a is 100 % on 2 cards, clip-b is 50 %
on 8 cards, and the test asserts pooled precision `0.6` **and** that it is not
the 75 % clip-average, pooled recall `6/7 = 0.8571` (not 90 %), and corpus hard
negatives `1 + 3 = 4`.

```bash
python3 -m pytest evals/kids_soccer_near_miss/tests/test_score_goal_precision.py -q
```

## Measured numbers

Numbers below are scored against the **exhaustive 336–777 s goal catalogue**
(15 goals — the original 14 labelled goals plus the t=341 goal discovered by the
catalogue scan; see *Goal catalogue*). The pre-superseded labelled-set numbers
(14 goals) were `da2d21a` = 73.91 % / 100 % and pre-fix = 76.19 % / 92.86 %.

| build | job | accepted GOAL cards | precision | recall (15-goal catalogue) | false positives |
|---|---|---|---|---|---|
| `da2d21a` (post-fix) | `ac6bf37f` | 23 | **78.26 %** (18/23) | 100 % (15/15) | 5 |
| pre-fix control | `cc06fb4a` | 21 | **80.95 %** (17/21) | 93.33 % (14/15) | 4 |

Each row is a committed scorer run against this manifest: `results/score_da2d21a.json`
and `results/score_cc06fb4a.json` — `score_goal_precision.py --manifest … --job-detail
/jobs/<id>/detail --commit <sha> --json results/score_<sha>.json`. Both were re-run and
re-committed when [ADAAAA-7611](/ADAAAA/issues/ADAAAA-7611) closed, so the JSONs in the
tree are the numbers quoted here, not a transcription.

Post-fix false positives (`t` = card `localizedTs`), all near-miss class:

- t=178.1 — accepted as "ball clearly enters the net"; frames 175–185 and the
  full-resolution frames 178/180/184 show a sliding challenge in open play with
  the scoreboard at RMA 1–1 BAR (06:50–06:57). Saved/blocked, not a goal.
- t=203.2 — frames 196–211: ball out by the advertising boards, player down; at
  full-res t=201 the keeper is on the ground with the ball outside the net by
  the left post (RMA 1–1, 08:12).
- t=252.6 — claims a scoreboard change 1–1→2–1; frames 244–262 show an empty
  net and midfield play, scoreboard 1–1 at 09:36 then 2–1 with no goalmouth event.
- t=358.8 — same save, no ball in the net; 1–0 unchanged through 366.
- t=401.7 — frames 395–409: keeper saves and holds the ball 400–405; 1–0 both
  ends of the window. The goal in that match is at t=413 (card 417).

Card t=348.8 (window 341.8–356.8) is **now a true positive**, not a false
positive: its own reason cites "the scoreboard updates from 1-1 to 2-1, and
players celebrate", and the 1 s frames confirm it — scoreboard RMA 1–1 BAR at
t=340 → RMA 2–1 BAR at t=341, with the scorer graphic "11 MANUEL ORDOÑEZ,
GOLES: 1" at t=344 (see *Goal catalogue*). The earlier FP entry for this card
relied on a misread ("scoreboard 1–3 unchanged"); the corrected read reclassifies
it. The pre-fix control surfaces the same t=348.8 card, so it is also a TP there.

The one pre-fix card that refuted its own read (t=695, `outcome=near_miss` yet
accepted) is gone post-fix: self-refuting count 1 → 0. On the corrected
catalogue the post-fix precision moved 73.91 % → 78.26 % and the pre-fix
control 76.19 % → 80.95 % because the t=341 goal is now credited in both. The
dominant false-positive class (saves/blocks accepted with a confident "ball
clearly enters the net" reason) is **unchanged**: 5 → 5 post-fix, 4 pre-fix.

## AC-3 — reverted-guard A/B (`results/ac3_guard_ab.json`)

AC-3 asks for the guarded build's numbers against a build with
`services/decide/app/confirm.py::goal_corroborated` reverted (the
`stage1_contradicts` guard dropped), on the same upload, with both FP lists side
by side.

The pair is a controlled A/B, not two arbitrary builds: `git show --stat da2d21a`
touches **only** `services/decide/app/confirm.py` (the guard) plus
`services/decide/tests/test_confirm.py`. The guarded job `ac6bf37f` ran that
commit; the pre-fix control `cc06fb4a` is the same pipeline built before it, i.e.
the reverted-guard build, on the same `kids-soccer.mp4` upload.

| build | job | accepted | precision | recall | FP |
|---|---|---|---|---|---|
| guarded `da2d21a` | `ac6bf37f` | 23 | **78.26 %** (18/23) | **100 %** (15/15) | 5 |
| reverted guard (pre-fix control) | `cc06fb4a` | 21 | **80.95 %** (17/21) | **93.33 %** (14/15) | 4 |

False positives side by side (`t` = card `localizedTs`; the classes are the same
near-miss cards in both builds):

| t | guarded `da2d21a` | reverted guard | what the frames show |
|---|---|---|---|
| 178.1 | FP | — | sliding challenge in open play, scoreboard 1–1 |
| 203.2 | FP | FP | keeper on the ground, ball outside the net |
| 252.6 | FP | FP | empty net / midfield, no goalmouth event |
| 358.8 | FP | FP | the same save, no ball in the net |
| 401.7 | FP | FP | keeper saves and holds 400–405 |
| 695.6 | — | FP (`stage1Disagreed: true`) | the t=688.6 shape: window read says no goal |

**So the revert does not lower precision — it raises it** (80.95 % vs 78.26 %),
exactly the direction AC-3 anticipated, and the guard's net effect on this clip is
**+1 goal of recall and +1 save-class false positive**: reverting adds the
`t=695.6` card *and* removes the `t=178.1` card, while `t=624.8` (the card that
recovers goal `ks-g-0616`, 612–620 s — the pre-fix control's only false negative)
is only found by the guarded build.

**The class the guard actually catches** is narrow and specific: a card whose own
Stage-1 read says *no goal* (`stage1Disagreed: true`) accepted on **window-level**
corroboration (`corroborationSource: scoreboard`, or a narrated penalty tally)
with no instant-anchored evidence. `guard_ab.py` counts it directly:

- guarded build: **0** accepted cards of that class (and no card may exist — the
  guard rejects them, `tests/test_guard_ab.py` pins the rule);
- reverted build: **1** — `ts=690`, `localizedTs=695.6`, `goalConfirmed:
  confirmed_goal`, `stage1Disagreed: true`, `corroborationSource: scoreboard`.

Two honest caveats on that class:

- **It is stage-1 dependent, so it is not reproducible run-to-run.** The *same*
  window `t=690` came back `stage1Disagreed: false` in the guarded run and
  `true` in the reverted run; the disagreement rate was 21/229 confirm runs
  (9.2 %) guarded vs 26/230 (11.3 %) reverted. The guard can only bite when the
  window's own read actually disagrees, so its measured effect moves with the
  model's run-to-run read.
- **The guard does not touch the dominant FP class at all.** Saves/blocks
  accepted with a confident "ball clearly enters the net" reason stay 4 → 5;
  the guard is a corroboration gate, not a shot/save classifier.

Why this A/B uses the recorded control job instead of a fresh revert deploy:
production `highlights-decide` is in active QA use (the live audio-noise trigger
verification on [ADAAAA-7668](/ADAAAA/issues/ADAAAA-7668), with the box's
`hl-rtmp-7670` live job up during this run). Reverting the guard there for the
~90 min of a VOD pass would have changed decide's acceptance behaviour under that
concurrent verification. AC-3's own fallback clause names the pre-fix control for
exactly this case, and the build equivalence above is the proof that the pair is
the same experiment.

```bash
python3 evals/kids_soccer_near_miss/guard_ab.py \
  --guarded  /tmp/job_detail_ac6bf37f-*.json \
  --reverted /tmp/job_detail_cc06fb4a-*.json \
  --score-guarded  evals/kids_soccer_near_miss/results/score_da2d21a.json \
  --score-reverted evals/kids_soccer_near_miss/results/score_cc06fb4a.json \
  --json evals/kids_soccer_near_miss/results/ac3_guard_ab.json --assert-checks
```

## Caveats (read before quoting these numbers)

- **Recall is recall on the 15-goal catalogue, not yet a whole-video goal
  count.** 336–777 s now has an objective scoreboard-change catalogue and every
  goal it confirmed is labelled, but 16 of its 21 candidates are still awaiting
  a committed 1 s frame pass — and the native-resolution pass (see the section
  above) shows a pixel statistic cannot settle them, so they stay queued for a
  localised frame read. 0–335 s was only scanned at 24 s contact-sheet
  granularity in this run. Until those passes are committed, quote recall as
  "recall on the 15-goal catalogue".
- Goal instants are ±1 s (1 s frame grid); a card within 10 s of an instant
  counts as crediting that goal (by design, see the scorer's matching rule).
- AC-3 (reverted `stage1_contradicts` guard makes precision drop) is **not
  reproduced** by the pre-fix control job: on the same 15-goal catalogue the
  pre-fix control (no guard) scores **80.95 %** against the post-fix build's
  **78.26 %**, so removing the guard *raised* precision here. The harness's
  ability to detect such a drop is proven by the unit test, but a real
  reverted-guard VOD job (deploy reverted image, run, score) has not been run —
  the Komodo manager endpoint is unreachable from the agent container.
- **The dominant false-positive class is unchanged.** Every accepted FP is a
  save / block the deep dive described as "ball clearly enters the net" on a
  window-level scoreboard delta (t=178.1, 203.2, 252.6, 358.8, 401.7). The
  post-bounce guard does not catch this class; the `stage1_contradicts` guard
  catches the narrower class where the window's own primary read says *no goal*
  and the only corroboration is a window-level scoreboard delta or a narrated
  penalty tally (the pre-fix t=695.6 self-refuting card). That class is 1 → 0
  post-fix, which is why precision moved even though the save class did not.

## AC-1 status (shot-class non-goal windows: 10 — AC met at the restated bar)

### AC-1 decision (2026-11-01, [ADAAAA-7686](/ADAAAA/issues/ADAAAA-7686))

Decision **A**: AC-1 for `kids_soccer.mp4` is **met at the measured state**; the
`>= 20` target is re-homed to the eval corpus. Recorded here so the numbers
below are quotable without the 20-window caveat.

- **AC-1 (kids_soccer).** The manifest carries **>= 10 verified shot-class
  non-goal windows** (7 `saved`, 2 `blocked`, 1 `wide`) out of its 22 non-goal
  windows, **and** carries the whole-clip census bound as ceiling evidence
  (§7, `results/census.json`): at most 3–4 further non-goal shot windows are
  candidate-generating on this clip. Met.
- **AC-1 (corpus).** **>= 20** hard-negative shot windows across the eval
  corpus — not per clip. Not satisfiable by `kids_soccer.mp4`; carried by the
  second-clip increment escalated at [ADAAAA-7688](/ADAAAA/issues/ADAAAA-7688).
- No census candidate was promoted as a label. `758–759` (`ks-n-0760`,
  shoot-out tail) stays the strongest unpromoted candidate and needs a
  native-resolution frame check before it can move.
- Why 10 is enough for AC-1's purpose (hard negatives, so precision is not
  measured on goals only): **4 of the 5 accepted FPs sit inside labelled
  shot-class windows** — `178.1`→`ks-n-0178` (blocked), `203.2`→`ks-n-0201`
  (saved), `358.8`→`ks-n-0359` (saved), `401.7`→`ks-n-0402` (saved); the fifth,
  `252.6`, lands in `evidence: none` `ks-n-0244`.
- Labels were **not** changed to match a build. The recorded numbers were
  regenerated by the scorer on this manifest (`results/score_da2d21a.json`,
  `results/score_cc06fb4a.json`).

### Measured reproducibility of the read layer (`results/frame_read_audit.json`)

`audit_frame_reads.py` measures the read layer from recorded JSONL only — no
network, no model call — so the AC-1 gate is a number, not an impression:

| metric | value |
| --- | --- |
| primary read seconds | 686 (`results/goalmouth_scan_1s.jsonl`) |
| repeat layer seconds | 85 (`results/goalmouth_scan_cross_prompt.jsonl`) |
| cross-read agreement on shared seconds | **80.0 %** (68 agree / 17 differ) |
| primary "shot" seconds confirmed by the repeat | **0 of 12** |
| shot-class instability | **100 %** (every shot second is open play or a cut in the repeat) |
| template collapse (distinct first sentences) | 96.5 % — the reader is not emitting one canned sentence |

So the disagreement is concentrated exactly on the class AC-1 needs: open play
is stable, shot is not. `promote_shot_windows.py` implements the strict
promotion rule (a second must be a shot class in *every* read layer, sit clear
of a goal instant, and raise no scoreboard candidate), which is why 0 windows
were promoted: no second cleared the unanimity bar.

### Thinking-on single-frame calibration (`results/calib_thinking_on_summary.json`)

The thinking-off layer above was the old configuration. The reader was then
re-calibrated on single frames (2x, `temperature=0`,
`enable_thinking=true`, `max_tokens=12000`) with
`calibrate_shot_reader.py`; 74 recorded reads, mean 12.3 s per frame
(4.1–78.8 s), `finish_reason=stop` on all but 9 endpoint 502s, which were
retried:

| metric | value |
| --- | --- |
| repeat reads of shot-class seconds | 8 |
| identical `ACTION=` class on both reads | **6 / 8 = 75 %** |
| coarse shot-vs-not-shot agreement | 7 / 8 = 87.5 % (one flip: `ks-n-0760` t=760 `keeper_save` → `open_play`) |
| known shot windows the reader reproduces (>= 1 shot second) | **5 / 10 = 50 %** (missed `ks-n-0130`, `-0178`, `-0426`, `-0628`, `-0722`) |
| false-shot seconds on the 12 `evidence: "none"` controls | **3 / 35 = 8.6 %** (two of them in `ks-n-0760`, a penalty-shoot-out frame) |

So thinking-on is far more repeatable than thinking-off (75 % vs 0 of 12), but
it is **not a ground-truth labeller**: it misses half of the windows the manifest
already knows contain a shot, and it flips one shot/no-shot call between reads.
Promoting windows from it would bias the shot-class set towards the shots this
one model happens to see, and its silence cannot certify that a window has no
shot. AC-1 therefore stays open, and the gate is now a number rather than an
impression: clearing it needs a second independent read layer for a vote,
because the endpoint serves exactly one multimodal model. The objective
alternative was built and calibrated in [ADAAAA-7643](/ADAAAA/issues/ADAAAA-7643)
and is measured dead on this cache (score AUC 0.481 — see the section below), so
the second layer has to come from a different prompt family, which needs
`SCAN_KEY` provisioned.

### Second independent layer: objective motion detector (`results/shot_motion_summary.json`)

[ADAAAA-7643](/ADAAAA/issues/ADAAAA-7643) added the second layer and calibrated
it on the same 10 shot windows and 12 controls. The mechanism is the one the
issue ranks first: `detect_shot_motion.py`, a deterministic, offline detector
over the cached frames — no model, no key, no network, no sampling. Its decision
comes from temporal pixel motion rather than a still-frame prompt
(`score(t) = max mean |frame(t) - shift(frame(t-1))|` over 8x8 blocks in the
pitch band, with broadcast cuts excluded), so its errors cannot correlate with
prompt-family errors. Two runs produce byte-identical output
(`sha256 1cc2786…` on `results/shot_motion_reads.jsonl`).

**It does not work on this footage.** The calibration numbers, with the layer
voting with the thinking-on reads at threshold 55:

| metric | value |
| --- | --- |
| known shot windows reproduced by the two-layer vote | **5 / 10 = 50 %** |
| control seconds falsely called a shot (both layers) | **3 / 34 = 8.8 %** (same three as the primary layer: `ks-n-0244` t=249, `ks-n-0760` t=759,760) |
| agreement between the two layers, same second | **22.8 %** (13 / 57 pairs) |
| the layer alone | 10 / 10 windows — but 114 / 134 control seconds false (**85.1 %**) |
| discriminative power of the score | **AUC 0.481** (chance = 0.5; shot median 184.1 vs control 189.1) |
| thresholds in the 30–125 sweep that meet the bar | **0** |

Calibration bar: >= 8/10 shot windows, <= 2/35 control seconds. **The bar was
not met.** The failing number is reproduction: **5/10, not 8/10**. The layer
alone is not a candidate either — at every threshold in the sweep it either
reproduces everything (10/10) or nothing, with a false-shot rate of 83–85 %,
because its score is saturated.

Why the objective path fails on this cache, measured:

- **The change between two frames is texture/encoder noise, not motion.** On 20
  quiet seconds (static camera) the mean |Δ| is 26.7 luma, and global alignment
  recovers only 1.5 of it (25.2 residual) — a sub-pixel phase-correlation
  estimate returns (0, 0) throughout, so there is no camera motion left to
  remove. A ball is ~10 px wide at 1x (job-detail track bbox 0.016 of frame
  width), which is far below that noise floor.
- **The 2x frames add no resolution.** They are upscales of the 1x frames
  (mean |2x→1x resample − 1x| = 2.26 luma, gradient energy per pixel halves from
  7.0 to 3.8), so a 2x pass measures the same pixels.
- **Every statistic in the family is flat.** Max block residual, max−median,
  p95−median, hot-block fraction, block std and a 5-frame temporal median of the
  residual all land in **AUC 0.47–0.54**; the hot-pixel fraction saturates at
  1.00 for both classes.

So `detect_shot_motion.py` stays committed as the measured negative result and
as the reusable artefact (its whole-video read is
`results/shot_motion_whole.jsonl`, 777 s), but **nothing was promoted from it**
and `coverage` is unchanged: 15 goal / 22 non-goal / 10 shot-class windows.

Two things follow for AC-1, and neither is a second voter problem:

1. the unanimous vote cannot exceed the weaker layer's recall, so adding a voter
   cannot lift the 5/10 the primary layer reproduces — the primary read has to
   get better, not another vote;
2. the issue's fallback mechanism (a different prompt family / multi-frame strip
   as a separate layer) needs `SCAN_KEY` for `https://vllm.dpn.chat`, which was
   not present in this run's environment and is not in
   `GET /api/agents/me/secrets`. Until that key is provisioned as a Paperclip
   secret, no prompt-family layer can be calibrated — the deterministic path is
   the only one that runs offline, and it is now measured dead on this cache.

### Agent-vision single-frame layer, measured (2026-11-01)

A third reader was tried and measured this heartbeat: the agent's own vision tool
on the **1x** cached frames (`/tmp/hl7590_frames/f_<t:04d>.jpg`, 640x360), one
frame per request, `temperature=0`, plus a serial direct-endpoint reader
(`deepseek-v4.1-flash`, thinking on) cross-checking the same seconds. All reads
are committed in `results/agent_vision_reads.jsonl` (29 reads, each names the
frame second it was made on).

It is **better than the previous layers on static facts and still unusable for
shot labels**:

| fact class | behaviour |
| --- | --- |
| scoreboard digits, read on a 6x/8x crop of the score box | stable and correct: `0-1` at 144/147/148/149, `1-1` at 150/165/235/249/262/279/281/282/283/318, `1-1 -> 2-1` at 340/341, `2-1` at 351/366 |
| close-up vs open play vs replay inlay | stable (318 = close-up, 283 = replay with a running `00:05` inlay) |
| **"is a shot happening"** | **not reproducible**: t=456, identical frame, returned `SHOT=yes KIND=saved` and then `SHOT=no KIND=none` on the immediate repeat |

So the layer reproduces the *facts around* a shot (score, scene type) but not the
shot call itself — the same failure mode as the thinking-on 2x calibration
(5/10 windows reproduced). No window was promoted on it.

What the pass did establish, seconded by both readers:

- **t=235 is a real shot and window `ks-n-0237` (234–240) is the strongest AC-1
  promotion candidate**: both readers saw a white-kitted player airborne after
  striking, the ball in the air at the goalmouth past the blue keeper. It is not
  a goal (`SCOREBOARD 09:33 RMA 1-1 BAR`, unchanged at 236–237; by t=236 a player
  is sliding and the ball is back in play), so it is a shot-class non-goal. It
  stays unpromoted until a reproducible second read exists, per the AC-1 gate.
- The 1 s-scan hints that the previous runs treated as promotion candidates are
  **refuted** on the frames: t=51, 249, 255, 262, 318, 366 are open play, a
  close-up or a player on the ground — no shot. The 1 s scan's
  `goal_mouth_shot`/`keeper_save` labels are not evidence.
- t=165 (scan hint `ball_in_net`) is **not** a goal: scoreboard `11:59 RMA 1-1`
  and the ball is not visible; t=147/149 the same.

### Scoreboard deltas are not goal evidence on this reel

The reel is **not chronological and cuts between passages of the match**, so the
overlay clock and the score do not move together with video time:

- clock reads `01:36` (t=45), `02:39` (t=66), `04:06` (t=90), `06:10` (t=144),
  `11:59` (t=165), `09:33` (t=235), `11:26` (t=249), `15:00` (t=281), `16:57`
  (t=318), `20:00` (t=351), `19:47` (t=366) — it goes **backwards** after 351.
- the score reads `0-1` at 144–149 and `1-1` from 150 onward, while the labelled
  goal at t=280 sits inside that `1-1` stretch, and the `1-1 -> 2-1` flip
  happens at t=341.
- a score flip at t=149/150 (`0-1 -> 1-1`) has **no goal action** in 147–149, so
  a delta across a cut is a cut artifact, not a scored goal.

Consequence: the scoreboard corroboration the pipeline leans on ("scoreboard
update from X to Y") is weak on this clip — it is exactly the class that produced
the dominant FP set (see caveats). The manifest's own `frames` citations that
quote scoreboards from the earlier labelling pass (`1-3` at 351, `1-0` at 359,
`0-0` at 426) do **not** match the frames (`RMA 2-1 BAR` at 351/366); those
strings came from an unreliable read and should not be quoted as evidence. The
labels themselves stand on the ball-in-net frames, not on those strings.

### 686–776 s is a penalty shoot-out, so the score-diff catalogue does not apply

`f_0712` reads `REAL MADRID 4-4 FC BARCELONA / PENALTIS 4 5 6` — the tail of the
video is a penalty shoot-out, and the score-digit diff detector finds only one
candidate there (`710–712`, `maxdiff=64.5`, which is the shoot-out scoreboard
updating). Each penalty can be a goal, so the tail's goal count needs a
per-kick frame pass (kick → keeper/ball) rather than the scoreboard method used
for 336–777 s. Coverage gap for the catalogue remains **686–776 s**.

### Window count

The manifest carries **10** shot-class non-goal windows (AC-1 as restated in
*AC-1 status*; the `>= 20` target moved to the eval corpus). The 12 remaining
`evidence: "none"` windows were re-scanned at 24 s and 12 s contact-sheet
granularity; no shot could be *confirmed* inside them under the reads, so none
was promoted (see the reproducibility caveat below). The whole-clip census (§7)
bounds what is left on this video at three to four candidates.

Frame-level labelling is blocked on the read layer, not on the frames: all
777 frames are cached locally and the contact-sheet + scan helpers are
committed. What the endpoint does and does not support:

- Thinking **on, contact sheets**: every read runs away into reasoning tokens
  (`finish_reason=length` with `reasoning_tokens` = the whole budget — 8000
  tokens consumed on one 24-frame sheet with no answer emitted), 40–60 s per
  sheet. That is a sheet-size/budget effect, not a property of the model: a
  single 2x frame at `max_tokens=12000` terminates in 4–19 s (see the
  calibration table above).
- Thinking **off**: fast (4–6 s per sheet) but **not reproducible** — the same
  9-frame strip of t=126–134 s (a labelled save, `ks-n-0130`) returned
  "purple attacker shooting toward goal; the ball goes wide at t=128–129" on one
  read and "no strike, save/dive, post, wide or block is visible" on the next.
  Known-shot calibration windows t=628 (wide) and t=722 (blocked) both came
  back "none", and a known non-goal window came back as a goal.
- Thinking **on, single frames**: the most repeatable configuration measured
  (75 % class agreement, 87.5 % shot-vs-not agreement), but it still misses
  50 % of the known shot windows, so it screens shots rather than labelling
  them.
- The endpoint serves exactly one multimodal model (`GET /v1/models`), so there
  is no second model to vote with.

So promoting additional shot windows on these reads would be guesswork, and
AC-1 explicitly forbids labelling on decide's text. Clearing the old 20-window
form of AC-1 would have needed a second independent read layer or an objective
shot detector, then a dense 1 s pass (`build_contact_sheet.py --from … --to …
--per-sheet 12`, or `scan_goalmouth.py` for per-second reads). That layer was
built and measured dead ([ADAAAA-7643](/ADAAAA/issues/ADAAAA-7643), §4–§6), which
is what the scope decision above resolves.

## Native-resolution source measured (2026-11-01): resolution is not the blocker

The pipeline's frames are a downscale: the job detail records `frameScale = 640:360`
and `sampleFps = 3`, while `sourceUrl` points at
`/data/uploads/3f8e8d8d-f00d-410c-b4c1-1a781b2fffc7/kids-soccer.mp4` — the upload
itself is **1280x720 at 60 fps** (ffprobe: 46673 frames, 777.9 s, 330 MB). The
unblock earlier revisions of this document recorded — "needs a higher-resolution /
30 fps frame source" — was tested against that source this run, twice, with
deterministic readers that stream decoded frames straight out of ffmpeg. No
vision model, no key.

### 1. Motion layer at source resolution (`native_shot_motion.py`)

Same statistic as `detect_shot_motion.py` (max mean |cur − shift(prev)| over 8x8
blocks inside the pitch band, with the scoreboard strip masked and a cut rule),
but sampled at 1280x720 / 12 fps instead of the 640x360 / 3 fps cache:

| metric | 640x360 @ 3 fps (cache) | 1280x720 @ 12 fps (source) |
| --- | --- | --- |
| score AUC | 0.481 | **0.440** |
| shot median score | 184.1 | 210.9 |
| control median score | 189.1 | 217.6 |
| shot windows reproduced | 5/10 (two-layer vote) | 10/10 at every threshold >= 20 |
| control seconds falsely called | 3/34 | 116 |
| thresholds in the sweep meeting the bar | 0 | **0** |

The layer reproduces *everything* at every threshold — the score saturates at
210 of 255 — and ranks worse than chance. So resolution was not the limiting
factor for this statistic: a max over ~13000 8x8 blocks always finds at least one
moving player, and a kids' soccer pitch at 12 fps is full of them. Artefacts:
`results/native_shot_motion_summary.json`, `results/native_shot_motion_windows.jsonl`.

### 2. Scoreboard catalogue at source resolution (`native_scoreboard_timeline.py`)

The 16 candidates still marked "needs frame confirm" survived the 1x pass because
that detector diffs digits rendered at ~42x17 px on a **semi-transparent** red
bar, so scene changes bleed through as digit changes. At 1280x720 the digits are
84x34, so the catalogue was rebuilt as a per-second *state* timeline: a white-glyph
mask inside the bar, clustered into score states, with a whole-frame cut signal to
separate a real score update from a cut that re-renders the overlay.

| metric | value |
| --- | --- |
| seconds scanned | 778 |
| score bar on screen | 509 s |
| broadcast cuts | 107 s |
| glyph-mask changes | 312 |
| changes with **no** cut ("score change") | **259** |
| changes at a cut (artifact) | 53 |
| distinct score states | 59 |
| real goals in the manifest | 15 |

259 "no-cut score changes" against 15 real goals (~17x) means the mask moves with
the scene, not with the score — a translucent bar makes no pixel statistic of the
digits scene-independent. **The scoreboard catalogue method is measured dead at
source resolution too**, which is also the honest explanation for why the 1x
detector's small-diff candidates (8.0-9.7) never resolved either way.
Artefacts: `results/native_scoreboard_timeline.json`, `.jsonl`.

### 3. First native-res crop read (negative, and why)

The vision endpoint can read native-resolution frames; the 1x frames it was
calibrated on (`results/calib_thinking_on_summary.json`, 5/10) are 4x smaller in
ball area. A crop of the labelled save window `ks-n-0130` (native 640x360 region
x 320-960, y 300-660, upscaled 2x) was read twice and returned
`SHOT=no KIND=none BALL=no` both times — **self-consistent**, but disagreeing with
that window's `saved` label and with a full-frame read of the same second
(`BALL=yes`). So the fixed crop does not reliably contain the goal mouth: crop
localisation has to precede crop reads. Nothing was promoted, and the 8/10 +
<= 2/35 calibration on native crops is the next measurable step.

### 4. Region-first motion at native resolution (`localised_shot_motion.py`, 2026-11-01)

The crop-read negative in §3 said localisation has to come first. That insight
was applied to the **deterministic** layer instead of the model: build a 12x7
cell map of maximum per-pair residual inside each labelled goal window, derive a
goal-mouth region from the cells that are hot at goals and cool on quiet seconds
(goal windows only — the shot/control windows never inform the region), then score
every shot and control window as the max residual **inside that region**.

Result on the source video at 1280x720 / 12 fps (`results/localised_shot_motion_summary.json`):

- region = **3 of 84 cells** ([[5,0],[5,3],[6,0]] — bottom-centre / bottom-right band,
  3.6 % of the frame);
- **AUC 0.442** shot vs control (chance), shot median 74.64 vs control 76.66;
- best threshold on the sweep catches 5/10 shots with 6/12 controls also above it;
- the 15 goals themselves span 30–233 inside the same region, i.e. even a
  *confirmed* goal does not reliably light the goal-mouth cells at 12 fps.

Three independent deterministic settings now agree on chance: **0.481** (640x360
cache, whole pitch), **0.440** (1280x720 source, whole pitch), **0.442**
(1280x720 source, goal-mouth region). Resolution and a region prior are both
excluded as the limiting factor; the statistic is.

### 5. Local gemma frame read (`gemma_labeller_cal.py`, 2026-11-01)

The remote multimodal endpoint is not usable from a run (`SCAN_KEY` is not a
provisioned secret and the Hermes vision path timed out), but the box already
serves `cyankiwi/gemma-4-12B-it-qat-AWQ-INT4` at `http://gemma:8088` for the
pipeline itself — free, keyless, local. Calibrated on the same 10 shot-class
windows and 12 `evidence:none` controls at 1 s steps, 245 frames, **0.4 s per
frame** (`results/gemma_labeller_cal.json`):

- loose rule (any `SHOT=yes` in the window): **10/10** shot windows … and
  **12/12** control windows too (74 of 134 control frames), i.e. it answers yes
  to everything;
- strict rule (`SHOT=yes` **and** `KIND` in saved/post/wide/blocked):
  **6/10** shots against **4/12** controls falsely shot (bar: >= 8/10, <= 2).

So the local gemma read is not a labeller yet, but it is the cheapest layer to
iterate on: no key, ~0.4 s per frame, and the whole calibration re-runs in about
two minutes from the committed script plus an `ffmpeg fps=1` frame pass.

### 6. Prompt-family calibration (`labeller_variants.py`, 2026-11-01)

The one cheap lead left on §5 was the prompt itself, so five variants were
calibrated on the same 245 frames (10 shot windows vs 12 `evidence:none`
controls) with `results/labeller_variants.json` as the record. All reads are
`temperature=0`, `enable_thinking=false`; each variant replaces the single
yes/no question with a rubric (scene class, net/ball/keeper facts, an explicit
class-boundary definition, or the moment of contact), and the shot decision is
derived from those fields:

| variant | rule per frame | shot windows | control windows falsely shot |
|---|---|---|---|
| `v0_baseline` (1-line `BALL/SHOT/KIND`) | `SHOT=yes` + `KIND∈{saved,post,wide,blocked}` | 6/10 | 4/12 |
| `v1_scene` | `SCENE∈{shot_at_goal,save}` | 6/10 | 4/12 |
| `v2_facts` | `BALL=near_net` or `KEEPER∈{diving,collecting}` | **10/10** | **12/12** |
| `v3_defined` | `SHOT=yes` under an explicit class definition | **8/10** | 8/12 |
| `v4_moment` | `ON_TARGET=yes` or `WHERE=goalmouth`+ball visible | 7/10 | 8/12 |

`v3_defined` with a one-frame rule is the only variant that reaches the shot
side of the bar (8/10), and it fails the control side by a factor of four. Adding
a persistence rule (>= 2 consecutive flagged seconds, which is the natural
window-level rule for a 6–16 s window) moves it to 7/10 shots against 3/12
controls — closer, still outside the bar. `v2_facts` saturates at 10/10 and
12/12: at 960x540 the model reports "net visible, ball near net" almost always,
which is exactly the ~10 px ball problem, not a prompt problem.
`v0_baseline` reproduces §5's 6/10 vs 4/12 **exactly**, so the harness,
frame grid and decision rule are consistent with `gemma_labeller_cal.py`.

**Verdict:** the prompt family is excluded as the AC-1 fix. Iterating prompts on
a 12B model over 960x540 frames does not produce a labeller; the constraint is
the resolvable detail (ball ≈ 10 px, goal mouth a few pixels high at this
scale), which is the same constraint the deterministic motion layer already
failed on.

### 7. Whole-clip 1 s census (`whole_video_census.py`, 2026-11-01)

A per-window calibration cannot answer "how many shot-class windows does this
clip contain", so the same two best readers were run over **every second** of the
777 s clip: 778 frames at 1 fps straight from the 1280x720 upload, 1556 reads,
**0 read errors**, ~10 min on the box. `results/census.json` holds the summary and
`results/census_seconds.jsonl` the full 121-second fire list.

- any-reader fires on **121 s**, both readers on **56 s**, clustered into **38**
  both-reader runs.
- **Sensitivity check first** (otherwise a silent census proves nothing): the
  both-reader pair fires on **10 of the 15 labelled goal windows** and on 5 of
  the 10 shot-class windows. So the pair does track goalmouth action, but it is
  insensitive, and *absence* of a census hit is weak evidence — which is why the
  census is used as a bound and a candidate generator, never as a label.
- Both-reader hits inside the 22 non-goal windows: 9, of which 5 are windows
  already labelled shot-class (`ks-n-0178/0201/0351/0402/0622`) and 4 land in or
  adjacent to a goal window (`281` inside `ks-g-0280`; `696/703` with `703`
  inside `ks-g-0705`). The 12 `evidence:none` windows yield exactly one
  both-reader run of >= 2 s: `758–759`, i.e. the penalty shoot-out tail.
- Both-reader runs in **unlabelled** seconds: **168–170** (3 s), **370–371**,
  **598–599**, **737–738**. `598–599` is 1 s before the t=602 goal window, so it
  is the shot that produced that goal rather than a non-goal shot window.

That is the measured ceiling: at most three or four new non-goal shot windows
are even candidate-generating on this clip, and none of them can be promoted
without a full-resolution frame read (the promotion rule stays: both readers
agree on >= 2 consecutive seconds, the window is not inside or adjacent to a
goal window, **and** a native-resolution frame confirms it). The third condition
was unavailable this run: `vision_analyze` timed out twice on the 1x frames and
`SCAN_KEY` is still not a provisioned secret, so no window was promoted and the
manifest is unchanged.

### What this changes for the AC set

- AC-1's recorded unblock ("higher-resolution / 30 fps frame source") is
  **falsified for the deterministic layer**, and the prompt family is now
  **falsified as well** (§6). What remains is a *verification* channel, not a
  reader: the whole-clip census (§7) shows the clip offers at most three or four
  additional non-goal shot candidates, and promoting any of them needs a
  native-resolution frame check that no provisioned endpoint provides today.
- AC-2's remaining 16 candidates cannot be resolved by a pixel statistic; they
  need the same localised frame reads as AC-1, and `RESULTS.md` keeps them
  queued rather than judged.

Both readers are committed and re-runnable in about a minute each:

```bash
python3 evals/kids_soccer_near_miss/native_shot_motion.py \
  --video /data/uploads/<id>/kids-soccer.mp4 --manifest evals/kids_soccer_near_miss/label-manifest.json \
  --out results/native_shot_motion_windows.jsonl --json results/native_shot_motion_summary.json

python3 evals/kids_soccer_near_miss/native_scoreboard_timeline.py \
  --video /data/uploads/<id>/kids-soccer.mp4 --fps 1 \
  --out results/native_scoreboard_timeline.jsonl --json results/native_scoreboard_timeline.json
```

Self-check for both: `tests/test_native_readers.py` (6 tests, no ffmpeg, no
network) pins the block statistic, the cut rule, the sweep accounting and the
recorded verdicts, so an edit cannot silently change what the negative results
mean.

## AC-4 — shot-window false positives measured at the confirm stage (ADAAAA-7687)

`da2d21a` accepts 23 cards against 15 labelled goals: precision 78.26 %, recall
100 %, the five FPs at `178.1, 203.2, 252.6, 358.8, 401.7`. Four of the five sit
inside labelled shot-class windows (`ks-n-0178` blocked, `ks-n-0201` saved,
`ks-n-0359` saved, `ks-n-0402` saved); the fifth (`252.6`) sits in the
`evidence:none` window `ks-n-0244`.

Before writing any rule into `services/decide/app/confirm.py` the candidate
confirm-stage discriminators were measured against the real accepted set with
`shot_vs_goal_discrimination.py` (persisted job detail only — no GPU pass, no
re-inference). Full table: `results/shot_vs_goal_discrimination.json`.

| rule (reject at confirm)                            | accepted | precision | recall | rejects |
|---|---|---|---|---|
| baseline (accept everything `da2d21a` accepts)      | 23 | 78.26 % | 100 % | — |
| blanket `frame_attestation`                         | 11 | 90.91 % | 53.33 % | 8 goals + all 4 shot FPs |
| `score_change` trigger with no confirm dive         | 19 | 78.95 % | 86.67 % | 3 goals + `252.6` |
| window-cluster majority not-a-goal                  | 2 | 100 % | 13.33 % | 18 goals + all 5 FPs |
| no goal-shaped read in the prior 15 s               | 18 | 77.78 % | 80.00 % | 4 goals + `203.2` |
| ball track keeps travelling after the instant       | 8 | 100 % | 46.67 % | 13 goals + all 5 FPs |
| Stage-1 criteria recorded no crowd eruption         | 22 | 81.82 % | 100 % | `203.2` only |
| oracle (rejects exactly the five known FPs)         | 18 | 100 % | 100 % | the 5 FPs |

**No deterministic confirm-stage rule reaches 0.94 precision at recall 1.0.**
The reason is structural, not a tuning miss: all four shot-window FPs enter the
accept set through the same anchor — the deep dive's own
`ballInNet` + `ballTrajectoryCrossedLine` read (`corroborationSource:
frame_attestation`, ratified policy ADAAAA-7555 Option 1) — and the eight
labelled goals that also enter through it are textually and numerically
indistinguishable from them:

- the confirm `reason` of the FPs and the TPs both narrate a ball crossing the
  line and entering the net (no lexical separator),
- the per-window Stage-1 criteria are all-true for both (the model asserts
  `ballInNet`, `ballCrossedLineBetweenPosts`, `crowdErupted` for a blocked shot),
- the confirm verdict of the *neighbouring* windows does not separate them:
  the labelled goals at `545.4` (1 goal read out of 10 windows) and `580.3`
  (0 of 10) look exactly like a shot FP,
- the cached ball track does not separate them (§*Native-resolution source* §5:
  per-window max ball speed puts controls above shots; path length here is
  1.35-3.20 for TPs and 1.71-2.51 for the FPs).

The only full-recall rule found (`Stage-1 criteria recorded no crowd eruption`)
kills one FP (`203.2`) for +3.5 points at zero recall cost — recorded, **not
shipped**: it is n=1, it vetoes on a Stage-1 self-read the family has already
measured as unreliable, and a clip with no crowd would lose real goals. It stays
in the harness as a measured candidate until a re-run can A/B it.

### Native single-frame probe (negative)

The next lever was tested cheaply before committing to it: native
1280x720 frames were extracted from the source on the box (`ffmpeg -ss <t> -t 6
-vf fps=4,scale=1280:720`, 24 frames per window, `/tmp/shotgo_n`) around
`fp203` (save) and `tp280` (goal). Single native frames do not resolve the
question either — `f_020` of the `fp203` window reads ball in open play with no
net, and `f_015` of the `tp280` window reads open play with the ball not
visible, i.e. the read is still a coin flip at the frame level. Resolution plus
a *single instant* is not the missing ingredient; a dense sequence bracketing
the crossing instant is. That hypothesis was then tested and **refuted** —
see *AC-4b* below.

### Replay-inlay evidence is not a confirm-stage feature (measured, negative)

One candidate discriminator was still unmeasured: real goals get a replay inlay
in the reel, a saved or blocked shot does not. It is **not available to the
confirm stage**: the job detail mentions `replay` 261 times and every one of
those occurrences sits inside the decide *prompt* text persisted on each note
(`analysis.prompt`); the parsed Stage-1 response of all 261 notes contains
`replay` **0** times, no section/frame/`job.candidates` field carries a scene or
replay class, and no highlight field records one. A replay-presence rule would
therefore have to come from a new read, not from the persisted detail — outside
the confirm-stage, 0-added-sessions constraint on this issue.

### AC-1 precision scope decision (2026-11-01, [ADAAAA-7703](/ADAAAA/issues/ADAAAA-7703))

AC-1's original `>= 0.94` precision target for `da2d21a` is **withdrawn** and
restated by product-owner decision (Option 1 of
[ADAAAA-7703](/ADAAAA/issues/ADAAAA-7703), decision document on that issue).
The restated AC-1 for this clip and build:

1. **Precision at recall 1.0 is quoted, not targeted at 0.94.** Accepted-goal
   precision **>= 0.78** at **recall 1.0** on the 15-goal catalogue, with every
   accepted FP enumerated and classified. Measured: **0.7826 / 1.0** (23 accepted
   cards, 18 TP; the 5 FPs are `178.1`, `203.2`, `358.8`, `401.7` inside labelled
   shot-class windows and `252.6` in the `evidence:none` window `ks-n-0244`).
2. **The confirm stage is closed as a precision lever.** No `confirm.py` rule
   ships from this issue: the measured ceiling at recall 1.0 is **0.8182**
   (`reject_no_crowd_criteria`, rejects `203.2` only) and `usable_rules: []`
   (table above). The gap to 0.94 is a missing **evidence channel**, not a
   threshold.

The withdrawn `>= 0.94` target is carried forward as the success metric of the
evidence-channel work, not as an AC on this build: the per-clip shot-vs-goal FP
rate is a quoted limitation carried into the corpus increment
([ADAAAA-7690](/ADAAAA/issues/ADAAAA-7690)) and the precision target belongs to
the localisation + goal-mouth crop research item
([ADAAAA-7706](/ADAAAA/issues/ADAAAA-7706), parked behind a trigger, not
scheduled). Option 2 (ship the n=1 `crowdErupted == false` veto for +3.56 points)
was declined on reliability and content-class grounds (a quiet grassroots match
must not lose real goals); Option 3 (added inference) is not funded.

Nothing here treats 78.26 % as acceptable product quality — it is the measured
floor with a documented, classified FP class. No production code changed for this
issue, so there is no new scored build label: the guard A/B recorded in *AC-3*
remains the offline `ac6bf37f` / `cc06fb4a` pair and needs no re-run.

## AC-4b — dense native crossing-instant strip read (ADAAAA-7693)

The follow-up to *AC-4* ([ADAAAA-7687](/ADAAAA/issues/ADAAAA-7687)) tested the one
lever AC-4 left open: a **dense native sequence bracketing the crossing instant**
instead of a single frame. Measured on the same 12 `frame_attestation` accepted
cards of the `da2d21a` eval (8 labelled goals + the 4 shot-window FPs `178.1,
203.2, 358.8, 401.7`) and on the 12 `evidence:none` manifest windows as controls.
Harness: `native_crossing_strip.py` (subcommands `plan` / `strip` / `read` /
`summarize`), self-check `tests/test_native_crossing_strip.py` (15 tests).

Design (AC design, `dense30`): `ffmpeg fps=30` slice of +/-0.5 s around the
candidate instant from the 1280x720/60 upload, tiled 6x5 at 220x124 into ONE
numbered sheet per candidate (1334x650 = **0.867 MPix**, under the measured
~0.9 MPix channel limit), anchor tile outlined red. Read serially on the local
channel (`http://gemma:8088/v1/chat/completions`,
`cyankiwi/gemma-4-12B-it-qat-AWQ-INT4`, thinking off, temperature 0, mean
**0.35 s/read**), terse crossing prompt, 2 reads per candidate.

| class | n | ball visible | CROSS=yes | CROSS=no + ball visible (**refuted**) | ball not visible |
|---|---|---|---|---|---|
| labelled goals (`frame_attestation`) | 8 | 3 | 3 | **0** | 5 |
| shot-window FPs | 4 | 2 | 2 | **0** | 2 |
| `evidence:none` controls | 12 | 6 | 6 | 0 | 6 |

**The bar is not met: 0/4 shot-window FPs refuted, and the read also confirms
only 3/8 goals** — it separates nothing (goals 3/8, FPs 2/4, controls 6/12 are
the same rate). No guard was shipped. Raw reads:
`results/native_crossing_strip_reads.jsonl`; summary
`results/native_crossing_strip.json`; plan `results/native_crossing_strip_plan.json`;
per-sheet geometry + sha256 `results/native_crossing_strip_strip_manifest.json`;
five representative sheets in `results/native_crossing_strip_sheets/` (the full
24-sheet set is 6.5 MB and is regenerated by the `strip` command below).

### Why it fails: the channel cannot locate the ball, at any geometry

Two resolution variants isolate the cause (`results/native_crossing_strip_variants.json`,
raw reads `results/native_crossing_strip_reads_variants.jsonl`):

| variant | frames/sheet | cell px | sheet MPix | goals crossed | FPs crossed | controls crossed | refuted |
|---|---|---|---|---|---|---|---|
| `dense30` | 30 @ 30 fps | 220x124 | 0.867 | 3/8 | 2/4 | 6/12 | 0 |
| `dense4` | 4 (offsets -0.25/-0.125/0/+0.125 s) | 440x248 | 0.478 | 2/8 | 1/4 | 0/12 | 0 |
| `native1` | 1 (the instant) | 1240x698 | 0.896 | 1/8 | 0/4 | 0/12 | 0 |

Ball sighting *falls* as cells grow (11/24 → 3/24 → 1/24), so the failure is not
"too few pixels per frame": the channel reads a whole 1280x720 frame at 97 % of
native resolution and still reports `BALL=no` on 23 of 24 cards. A channel sanity
probe (same four sheets, a coarse-facts prompt) shows it *is* reading pixels —
`GRASS` / `GOALPOSTS` / `PEOPLE` vary correctly with the sheet — while
`BALL_VISIBLE=no` on the `dense30` and `native1` sheets and `yes` on `dense4`.
That is the recorded "localisation before crop" failure mode (see *Native
resolution*): a ~10 px ball in a 1280x720 frame is below what this channel
segments, so a crossing read has nothing to condition on. Note also that two of
the four sanity reads called the clip **American football**, i.e. the scene prior
is unreliable on this footage as well.

Reproducibility: 24/24 candidates returned identical verdicts on the repeat read
— trivially, because `temperature 0` makes the channel deterministic. The family
bar ("a non-reproducible read cannot be promoted") is therefore satisfied in form
but carries **no information** here; the failure is discrimination, not stability.
That is worth stating because AC-4's single-frame probe failed the *stability*
test, which made it easy to mistake stability for evidence.

Not excluded by this measurement: a per-window goal-mouth **crop** (which would
raise the ball to ~7 px/cell and needs the localisation step that *Native
resolution* records as a prerequisite), and a channel that segments a small ball
at all. What is excluded is the strip-vs-single-frame hypothesis itself: adding
temporal density inside the measured sheet budget does not create ball evidence.

## Not yet done (tracked as a follow-up)

1. ~~AC-1: extend the shot-class set from 10 to >= 20 windows~~ — **resolved by
   scope decision, not by labels** ([ADAAAA-7686](/ADAAAA/issues/ADAAAA-7686),
   recorded in *AC-1 status*). The clip is measured to hold no more than three
   to four further non-goal shot candidates (whole-clip census, §7), so the
   blocking evidence stays recorded for the corpus increment: the primary read
   layer reproduces 5/10 known shot windows, the objective motion layer carries
   no signal in three independent settings (AUC 0.481 at 640x360 whole-pitch,
   0.440 at the source's own 1280x720 whole-pitch, 0.442 at 1280x720 restricted
   to a goal-mouth region derived from the labelled goals — see
   *Native-resolution source* §4), and the five-variant prompt family peaks at
   8/10 shots against 8/12 false controls (§6). The corpus-level `>= 20`
   hard-negative target is carried by a second clip, escalated at
   [ADAAAA-7688](/ADAAAA/issues/ADAAAA-7688).
2. AC-2: confirm or refute the remaining catalogue evidence on 1 s frames. From
   `results/goal_catalogue_reconciliation.json` (re-run with
   `reconcile_goal_catalogue.py`):

   - **21** whole-video scoreboard candidates; **5** sit on a labelled goal,
     **16** are still unconfirmed (no goal class in the read layer);
   - **5** read-layer `celebration`/`ball_in_net` seconds fall outside every
     labelled goal (t=152–165 cluster and the t≈240 cluster) and need a frame
     check before they can be dismissed as crowd/CU cuts;
   - the dense read layer covers 0–685 s, so **686–776 s has no read coverage**
     (the scoreboard layer raises no candidate after t=712, and every goal in
     the 660–720 s segment is labelled).
3. ~~AC-3: the reverted-guard VOD A/B~~ — **done** from the recorded control job
   `cc06fb4a` (the reverted-guard build) against `ac6bf37f`, with
   `results/ac3_guard_ab.json` as the evidence and both FP lists in the AC-3
   section. A fresh current-build revert pass stays optional (production decide
   is in active QA use; see that section).
4. The read-layer reproducibility gate itself: one multimodal model is
   configured on the endpoint (`GET /v1/models` → `deepseek-v4.1-flash` only),
   so a second-model vote is not available; a second independent layer has to
   be built and calibrated (tracked as [ADAAAA-7643](/ADAAAA/issues/ADAAAA-7643)).
5. ~~AC-1 precision at the confirm stage~~ — **measured, not reachable from the
   confirm-stage signals** (*AC-4* section above): no deterministic rule lifts
   precision past 81.82 % at recall 1.0, because every shot-window FP and the
   eight `frame_attestation` goals enter through the same model self-read. The
   dense native crossing-instant strip ([ADAAAA-7693](/ADAAAA/issues/ADAAAA-7693))
   was then measured too and is also **negative** (*AC-4b* above): inside the
   ~0.9 MPix sheet budget the local channel sees the ball on only 11/24 `dense30`
   sheets and 1/24 full-frame sheets, so it refutes 0/4 shot-window FPs. The
   remaining lever on this family is a per-window goal-mouth **crop**
   (localisation first, then crop, then read twice — the prerequisite recorded in
   *Native resolution*), not more temporal density. **Resolved by scope decision**
   (Option 1, [ADAAAA-7703](/ADAAAA/issues/ADAAAA-7703), recorded in *AC-1
   precision scope decision*): AC-1 is restated as quoted precision >= 0.78 at
   recall 1.0, and the crop lever is parked in
   [ADAAAA-7706](/ADAAAA/issues/ADAAAA-7706).

## Reproduction

```bash
curl -sS "https://highlights-server.dpn.gg/jobs/ac6bf37f-6a03-4d14-a307-de5b9e200405/detail" \
  -H "Authorization: Bearer <admin token>" -o /tmp/detail_da2d21a.json
python3 evals/kids_soccer_near_miss/score_goal_precision.py \
  --manifest evals/kids_soccer_near_miss/label-manifest.json \
  --job-detail /tmp/detail_da2d21a.json --commit da2d21a
```

Read-layer evidence, all offline except the calibration reads:

```bash
# 1. reproducibility of the recorded thinking-off layer (no network)
python3 evals/kids_soccer_near_miss/audit_frame_reads.py \
  --primary evals/kids_soccer_near_miss/results/goalmouth_scan_1s.jsonl \
  --repeat evals/kids_soccer_near_miss/results/goalmouth_scan_cross_prompt.jsonl \
  --json evals/kids_soccer_near_miss/results/frame_read_audit.json

# 2. objective goal-candidate reconciliation (no network)
python3 evals/kids_soccer_near_miss/reconcile_goal_catalogue.py \
  --manifest evals/kids_soccer_near_miss/label-manifest.json \
  --scoreboard evals/kids_soccer_near_miss/results/scoreboard_candidates_whole_video.json \
  --scan evals/kids_soccer_near_miss/results/goalmouth_scan_1s.jsonl \
  --json evals/kids_soccer_near_miss/results/goal_catalogue_reconciliation.json

# 3. summary of the recorded thinking-on calibration (no network)
python3 evals/kids_soccer_near_miss/calibrate_shot_reader.py \
  --summarize evals/kids_soccer_near_miss/results/calib_thinking_on.jsonl \
  --json evals/kids_soccer_near_miss/results/calib_thinking_on_summary.json

# 4. record a fresh calibration (serial, ~12 s per frame, needs SCAN_KEY)
SCAN_KEY=... python3 evals/kids_soccer_near_miss/calibrate_shot_reader.py \
  --frames /tmp/x2frames --out evals/kids_soccer_near_miss/results/calib_thinking_on.jsonl
```

Dense crossing-instant strip read (ADAAAA-7693, box host → perceive container):

```bash
# 0. plan: the 12 frame_attestation cards (8 goals + 4 shot-window FPs) + the
#    12 evidence:none controls
python3 evals/kids_soccer_near_miss/native_crossing_strip.py plan \
  --discrimination evals/kids_soccer_near_miss/results/shot_vs_goal_discrimination.json \
  --manifest evals/kids_soccer_near_miss/label-manifest.json \
  --out /tmp/xstrip/plan.json

# 1. sheets (box HOST: needs ffmpeg + PIL; the upload is on the bind mount)
python3 evals/kids_soccer_near_miss/native_crossing_strip.py strip \
  --video /home/brad/highlights.live/docker/data/uploads/3f8e8d8d-f00d-410c-b4c1-1a781b2fffc7/kids-soccer.mp4 \
  --plan /tmp/xstrip/plan.json --out /tmp/xstrip/sheets            # 30 fps, 1.0 s, 0.867 MPix
#    resolution variants: --offsets=-0.25,-0.125,0,0.125 --cols 4 --rows 1 \
#      --cell-w 440 --cell-h 248     (dense4, 0.478 MPix)
#    ... --offsets=0 --cols 1 --rows 1 --cell-w 1240 --cell-h 698   (native1, 0.896 MPix)

# 2. serial read INSIDE the compose network (`gemma:8088` is not reachable from
#    the host or the agent container); failed reads are recorded as unmeasured
docker exec highlights-perceive mkdir -p /tmp/xstrip
docker cp /tmp/xstrip/sheets highlights-perceive:/tmp/xstrip/sheets
docker exec highlights-perceive python3 /tmp/xstrip/native_crossing_strip.py read \
  --sheets /tmp/xstrip/sheets --manifest /tmp/xstrip/sheets/strip_manifest.json \
  --out /tmp/xstrip/reads.jsonl --repeat 2

# 3. table + AC bar (offline; reproduces results/native_crossing_strip.json)
python3 evals/kids_soccer_near_miss/native_crossing_strip.py summarize \
  --reads /tmp/xstrip/reads.jsonl \
  --json evals/kids_soccer_near_miss/results/native_crossing_strip.json
# self-check: python3 -m pytest evals/kids_soccer_near_miss/tests/test_native_crossing_strip.py -q
```
