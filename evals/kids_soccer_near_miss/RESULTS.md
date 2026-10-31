# kids_soccer goal-acceptance precision (ADAAAA-7590)

Measured precision/recall for the accepted-GOAL path on `kids_soccer.mp4`
(777 s, multi-goal compilation), scored against frame-derived labels. This is
the number the ADAAAA-7477 post-bounce fix was missing: the earlier
"0 accepted windows whose own read refutes a goal (was 1)" is a
**self-consistency** metric, not precision.

## What is labelled

`label-manifest.json` holds **36 windows** (14 goal, 22 no-goal), each with
`t_start`/`t_end`, a `ground_truth`, an `evidence` value and the frame
timestamps that carry the proof:

- 14 goal windows — ball in the net, the broadcast `GOL` graphic, or a
  scoreboard change, each cited at 1 s frames.
- 22 no-goal windows — of which **9 are shot-class** (`saved` / `wide` /
  `blocked`: t=130, 201, 351, 359, 402, 426, 622, 628, 722) and 13 are
  no-goal windows without a shot at goal (`evidence: "none"`). The near-miss
  shot-class count is **9, not the 20 AC-1 asks for** — see *Not yet done*.
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

| build | job | accepted GOAL cards | precision | recall (labelled set) | false positives |
|---|---|---|---|---|---|
| `da2d21a` (post-fix) | `ac6bf37f` | 23 | **73.91 %** (17/23) | 100 % (14/14) | 6 |
| pre-fix control | `cc06fb4a` | 21 | **76.19 %** (16/21) | 92.86 % (13/14) | 5 |

Post-fix false positives (`t` = card `localizedTs`), all near-miss class:

- t=178.1 — accepted as "ball clearly enters the net"; frames 175–185 and the
  full-resolution frames 178/180/184 show a sliding challenge in open play with
  the scoreboard at RMA 1–1 BAR (06:50–06:57). Saved/blocked, not a goal.
- t=203.2 — frames 196–211: ball out by the advertising boards, player down; at
  full-res t=201 the keeper is on the ground with the ball outside the net by
  the left post (RMA 1–1, 08:12).
- t=252.6 — claims a scoreboard change 1–1→2–1; frames 244–262 show an empty
  net and midfield play, scoreboard 1–1 at 09:36 then 2–1 with no goalmouth event.
- t=348.8 — frames 342–356 show a yellow card (343) and a shot saved by a diving
  keeper (351–352); scoreboard 1–3 unchanged.
- t=358.8 — same save, no ball in the net; 1–0 unchanged through 366.
- t=401.7 — frames 395–409: keeper saves and holds the ball 400–405; 1–0 both
  ends of the window. The goal in that match is at t=413 (card 417).

The one pre-fix card that refuted its own read (t=695, `outcome=near_miss` yet
accepted) is gone post-fix: self-refuting count 1 → 0. But precision did not
improve — the fix added accepted card t=178 (a false positive) and t=625 (a true
positive, goal at t=616), so precision moved 76.19 % → 73.91 % while recall
moved 92.86 % → 100 %. The dominant false-positive class (saves/blocks accepted
with a confident "ball clearly enters the net" reason) is **unchanged**: 5 → 6.

## Caveats (read before quoting these numbers)

- **Recall is recall on the labelled set.** The goal catalogue was seeded from
  the pipeline's candidate neighbourhoods and verified frame by frame, so a goal
  the pipeline never surfaced outside those neighbourhoods may be missing from
  the denominator. Whole-video 3 s scanning found no additional goal outside the
  labelled windows between 0–333 s, but 336–777 s was not scanned densely outside
  the labelled windows. An exhaustive whole-video goal catalogue is the next
  step, and only then should recall be quoted as pipeline recall.
- Goal instants are ±1 s (1 s frame grid); a card within 10 s of an instant
  counts as crediting that goal (by design, see the scorer's matching rule).
- AC-3 (reverted `stage1_contradicts` guard makes precision drop) is **not
  reproduced** by the pre-fix control job: reverting the guard raised precision
  in this run. The harness's ability to detect such a drop is proven by the unit
  test, but a real reverted-guard VOD job (deploy reverted image, run, score) has
  not been run yet.

## Not yet done (tracked as a follow-up)

1. Extend the shot-class non-goal windows from 9 to the >=20 AC-1 asks for
   (dense 1 fps passes over the remaining non-goal candidate windows).
2. Exhaustive whole-video goal catalogue (dense scan of 336–777 s) so recall is
   pipeline recall rather than labelled-set recall.
3. The reverted-guard VOD A/B for AC-3, which needs a decide image deploy and one
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
