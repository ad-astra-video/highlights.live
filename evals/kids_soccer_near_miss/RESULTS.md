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
  goal it confirmed is labelled, but 19 of its 22 candidates are still awaiting
  a committed 1 s frame pass. 0–335 s was only scanned at 24 s contact-sheet
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

The manifest carries **10** shot-class non-goal windows, not the 20 AC-1 asks
for. The 12 remaining `evidence: "none"` windows were re-scanned this run at
24 s and 12 s contact-sheet granularity; no shot could be *confirmed* inside
them under the reads, so none was promoted (see the reproducibility caveat
below). New shot windows have to be found elsewhere on the video.

Frame-level labelling is blocked on the vision model, not on the frames: all
777 frames are cached locally and the contact-sheet + scan helpers are
committed, but the model endpoint at `vllm.dpn.chat` is not usable as a
labeller in this environment right now:

- Thinking **on**: every read runs away into reasoning tokens
  (`finish_reason=length` with `reasoning_tokens` = the whole budget — 8000
  tokens consumed on one 24-frame sheet with no answer emitted), 40–60 s per
  sheet.
- Thinking **off**: fast (4–6 s per sheet) but **not reproducible** — the same
  9-frame strip of t=126–134 s (a labelled save, `ks-n-0130`) returned
  "purple attacker shooting toward goal; the ball goes wide at t=128–129" on one
  read and "no strike, save/dive, post, wide or block is visible" on the next.
  Known-shot calibration windows t=628 (wide) and t=722 (blocked) both came
  back "none", and a known non-goal window came back as a goal.
- A three-way read of a goal window would fix the variance, but at 40–60 s per
  thinking-on read that is hours of wall clock for a whole-video pass.

So promoting additional shot windows on these reads would be guesswork, and
AC-1 explicitly forbids labelling on decide's text. The next run should resume
the dense 1 s pass once the endpoint produces reproducible reads (or when a
second VL model is available for a vote), using
`build_contact_sheet.py --from … --to … --per-sheet 12`.

## Not yet done (tracked as a follow-up)

1. AC-1: extend the shot-class set from 10 to >= 20 windows (blocked on
   reproducible frame reads — see *AC-1 status*).
2. Verify the 19 remaining goal-catalogue candidates on 1 s frames, so recall
   can be quoted as pipeline recall.
3. AC-3: the reverted-guard VOD A/B, which needs a decide image deploy and one
   GPU VOD pass (blocked while the Komodo manager endpoint is unreachable from
   the agent container).

## Reproduction

```bash
curl -sS "https://highlights-server.dpn.gg/jobs/ac6bf37f-6a03-4d14-a307-de5b9e200405/detail" \
  -H "Authorization: Bearer <admin token>" -o /tmp/detail_da2d21a.json
python3 evals/kids_soccer_near_miss/score_goal_precision.py \
  --manifest evals/kids_soccer_near_miss/label-manifest.json \
  --job-detail /tmp/detail_da2d21a.json --commit da2d21a
```
