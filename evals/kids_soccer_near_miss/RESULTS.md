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
  no-goal windows without a shot at goal (`evidence: "none"`). The near-miss
  shot-class count is **10, not the 20 AC-1 asks for** — see *AC-1 status*.
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
evals/kids_soccer_near_miss/tests/test_score_goal_precision.py` — 7 tests,
including a synthetic "reverted guard" acceptance set whose precision drops to
66.7 %, so the harness's red/green signal for the post-bounce class is proven.

## Measured numbers

Numbers below are scored against the **exhaustive 336–777 s goal catalogue**
(15 goals — the original 14 labelled goals plus the t=341 goal discovered by the
catalogue scan; see *Goal catalogue*). The pre-superseded labelled-set numbers
(14 goals) were `da2d21a` = 73.91 % / 100 % and pre-fix = 76.19 % / 92.86 %.

| build | job | accepted GOAL cards | precision | recall (15-goal catalogue) | false positives |
|---|---|---|---|---|---|
| `da2d21a` (post-fix) | `ac6bf37f` | 23 | **78.26 %** (18/23) | 100 % (15/15) | 5 |
| pre-fix control | `cc06fb4a` | 21 | **80.95 %** (17/21) | 93.33 % (14/15) | 4 |

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

## AC-1 status (shot-class non-goal windows: 10 of >= 20)

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

The manifest carries **10** shot-class non-goal windows, not the 20 AC-1 asks
for. The 12 remaining `evidence: "none"` windows were re-scanned this run at
24 s and 12 s contact-sheet granularity; no shot could be *confirmed* inside
them under the reads, so none was promoted (see the reproducibility caveat
below). New shot windows have to be found elsewhere on the video.

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
AC-1 explicitly forbids labelling on decide's text. Clearing AC-1 needs a second
independent read layer or an objective shot detector, then a dense 1 s pass
(`build_contact_sheet.py --from … --to … --per-sheet 12`, or
`scan_goalmouth.py` for per-second reads).

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

### What this changes for the AC set

- AC-1's recorded unblock ("higher-resolution / 30 fps frame source") is
  **falsified for the deterministic layer**. The remaining candidate is a
  perception labeller over native-resolution, per-window localised crops.
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

## Not yet done (tracked as a follow-up)

1. AC-1: extend the shot-class set from 10 to >= 20 windows. Measured blocker
   (see *AC-1 status*): the primary read layer reproduces 5/10 known shot
   windows, the objective motion layer carries no signal (AUC 0.481 at 640x360
   and 0.440 at the source's own 1280x720 — see *Native-resolution source*), and
   the unanimous vote is capped by the primary layer, so no window can be
   promoted under the bar (>= 8/10, <= 2/35). The "higher-resolution / 30 fps
   frame source" unblock is **falsified**; the remaining path is a perception
   labeller over native-resolution crops localised per window, which needs
   `SCAN_KEY` provisioned as a Paperclip secret for a prompt-family layer, or a
   vision calibration on localised native crops under the same bar.
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
3. AC-3: the reverted-guard VOD A/B, which needs a decide image deploy and one
   GPU VOD pass (blocked while the Komodo manager endpoint is unreachable from
   the agent container; tracked as [ADAAAA-7628](/ADAAAA/issues/ADAAAA-7628)).
4. The read-layer reproducibility gate itself: one multimodal model is
   configured on the endpoint (`GET /v1/models` → `deepseek-v4.1-flash` only),
   so a second-model vote is not available; a second independent layer has to
   be built and calibrated (tracked as [ADAAAA-7643](/ADAAAA/issues/ADAAAA-7643)).

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
