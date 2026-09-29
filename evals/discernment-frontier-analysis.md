# Decide-layer discernment frontier — INC-10 real-feed eval set (ADAAAA-5778)

Author: Developer (agent) · Date: 2026-09-29 · Context: follow-up to ADAAAA-5786
(deploy + gemma-path FP confirmation) and the INC-9/INC-10 precision work.

## Purpose

Determine whether ANY decide-layer change (threshold or corroboration predicate)
can reduce the false-positive rate on the real-feed §6 eval set without
regressing recall below the bar. This is the question that decides whether the
"notable-only density" goal is a decide bug or a signal/data gap.

## Data

- Source: `evals/inc10-decisions.jsonl` (staralized from the deployed
  `perceive:8080` + `decide:8081` over the 12 INC-5 clips, fps=1, --decide-frames 3).
- 44 candidates: 23 labeled true (goal 18, near_goal 5), 21 labeled false
  (off_target 8, warm_up 7, commentary_lull 4, replay_loop 2).
- Per candidate: gemma verdict (isHighlight, score 0/10/85/95, eventType),
  reaction block (crowdEnergy, audioKind, humansInMotion, celebrationCluster,
  ballInGoalMouth) derived from perceive detections + clip audio (honest, never
  ground-truth).

## Headline result

- Current gate reject rate: 16/44 = 36.4% (budget <= 60%) — PASS.
- Gate-added rejections: **0 of 16** — every rejection came from Gemma itself
  (scores 0/10, "standard play" reasons). Gate is inert on this set.
- Metrics (set by Gemma's own verdicts, unchanged by the gate):
  precision 17/28 = 60.7%, recall 17/23 = 73.9%.

## Empirical frontier (no rule beats current)

For every candidate decide "yes" already carries corroboration and is classified
GOAL with score 85-95. The 11 false positives (off_target 4, warm_up 4,
commentary_lull 2, replay_loop 1) are signal-identical to true positives that
surfaced: humansInMotion 2-3, crowdEnergy ~0, and overlapping
ballInGoalMouth/celebrationCluster. Brute-force evaluation of simple rules:

| Rule (surface if …)                     | TP | FP | Precision | Recall |
|------------------------------------------|----|----|-----------|--------|
| current (gemma + evidence gate)          | 17 | 11 | 0.607     | 0.739  |
| ballInGoalMouth                          |  9 |  7 | 0.562     | 0.391  |
| celebrationCluster >= 1                  |  5 |  5 | 0.500     | 0.217  |
| ballMouth OR celebration >= 1            | 12 | 11 | 0.522     | 0.522  |
| crowdEnergy > 0.01                       |  8 |  7 | 0.533     | 0.348  |
| (crowd OR ballMouth OR celebration)      | 16 | 12 | 0.571     | 0.696  |

No predicate is Pareto-better than the current operating point: rejecting the 11
false positives necessarily rejects an equal or greater share of true positives,
because the negatives are in-zone near-miss scenarios (off-target shots, warm-up
drills near goal) with identical `humansInMotion`/score and overlapping
goal-region cues.

## Root cause

The labeled negatives are semantically ambiguous near-goal plays. Gemma over-
classifies them as GOAL with 95 confidence, and the objective signals (player
motion count, ball-in-goal-mouth region, celebration cluster, crowd energy) do
not discriminate — the INC-9 run already added `celebrationCluster` +
`ballInGoalMouth` for precisely this reason and still measured 60% precision at
~2fps (see `evals/drive_inc8.py` header + `INC9-RESULTS.md`).

## Conclusion for the decide layer

ADAAAA-5778's hard acceptance criteria are met and tested:

1. Scene/audio change with no notable content → rejected (bare trigger:
   trackCount 0, maxVelocity 0, ocrHits 0, no reaction). Unit + gemma-path
   tests cover this.
2. Threshold is config-driven (`DECIDE_NOTABILITY_MIN`, default 60 landed from
   the §6 eval set via `evals/decide_discernment.py`), not hand-picked.
3. No GPU cost increase: `apply_gate` only ever REJECTS (yes→no), adding no
   inference.

The remaining "notable-only density" gap (ambiguous in-zone negatives surfacing)
is a **signal/data** problem, not a decide-threshold problem. The unblock is an
objective ball-OUTCOME / scoring-event signal (did the ball actually cross the
line — a perceive-side capability), or a less-ambiguous negative eval subset.
Neither lives in the decide gate.

## Follow-up

- Re-route: parent [ADAAAA-5772](/ADAAAA/issues/ADAAAA-5772) is the umbrella for
  a perceive ball-outcome / scoring-event corroboration signal.
- QA [ADAAAA-5779](/ADAAAA/issues/ADAAAA-5779) should verify the deployed gate's
  real-feed behavior (junk/bare-trigger suppression is live).
