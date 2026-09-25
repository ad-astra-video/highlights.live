# INC-9 (ADAAAA-4496) §6 re-run — measured results (2fps, deployed inc9 pipeline)

Drive: evals/drive_inc8.py run on livepeer-ai-x99 against deployed perceive
`highlights-live-perceive-inc9` and decide (`highlights-live-decide-inc9-4496`,
DECIDE_MODE=gemma), via the inc9-drive container (--perceive http://perceive:8080
--decide http://decide:8081). Clips = INC-5 labeled set (10 clips).

Metrics (metrics_runner.py vs label-manifest.json):

| Metric | INC-8 (66.7/66.7/57.1) | INC-9 final (2fps, frames) | Bar | Status |
|---|---|---|---|---|
| Live recall       | 66.7% | 100% | >=85% | PASS |
| VOD recall        | 66.7% | 100% | >=90% | PASS |
| Precision         | 57.1% | 60.0% | >=70% | FAIL |
| e2e latency max   | 2.0s  | 2.0s  | <=5s  | PASS |
| GOAL latency med  | 0.25s | 0.0s  | <=3s  | PASS |
| Noise-trigger FP  | 16.7% | 36.7% | <=60% | PASS |
| Reaction cited TP | 25%   | 100%  | >=80% | PASS |

Final trace: evals/inc9-trace-frames.json (98 events, stageA 49 cand / 18
rejected). Latency: mean 0.309s, max 0.457s.

## What fixed recall + reaction (the two INC-9 root causes) — DONE
- Widen soccer goal-mouth Stage-A zones (~24% width) + ball-in-play-area trigger
  so near-goal clips (soc-near-02) now emit GOAL candidates -> recall
  live/VOD 66.7% -> 100%.
- Forward honest reaction evidence to decide: crowdEnergy/audioKind from the
  clip's real audio + humansInMotion from the anchor frame's track count + ball
  speed/possession (parity with buildReactionEvidence) -> reaction cited
  (TP) 25% -> 100%.

## Precision (60% vs 70%) — measured NOT achievable with honest in-scope signals
The final run forwards the candidate's temporal frame SEQUENCE (--decide-frames 3,
honest clip frames from the candidate moment) as the first-class `frames` input
the deployed decide prompt is built to reason across ("Reason across the frame
sequence: motion, position, ball/foot/player location"). This is the strongest
honest signal the deployed pipeline can feed Gemma, yet precision is UNCHANGED
at 60%: the 4 negative clips (soc-off-01/02, soc-warm-01/02) each still have at
least one GOAL candidate Gemma accepts at 95, because the off-target/warm-up
clips contain real shot sequences that are visually near-identical to goals in
a short window, and perceive emits GOAL for every in-zone strike.

Independent honest signals measured and found non-separating (no ground-truth
leakage in any):
1. Audio crowd-energy proxy from clip audio — ~0 / anti-correlated (higher on
   negatives) on broadcast-commentary captures.
2. Spatial celebration cluster + ball-in-goal-mouth (from perceive detections) —
   cluster 0-1 on every clip; ball-mouth overlaps P vs N.
3. Temporal 3-frame sequence to Gemma — no precision gain (this run).

=> The labeled negatives are indistinguishable from real goals via any honest
signal the current deployed pipeline produces. Raising precision >=70% needs a
stronger signal (e.g. perceive ball-goal-crossing/ball-outcome detection, or a
real crowd-eruption audio source), which is beyond the INC-9 scope of
"reaction evidence + near-goal emission". Escalated to Product Owner as a
scope decision.
