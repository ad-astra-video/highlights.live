# INC-9 (ADAAAA-4496) §6 re-run — measured results (2fps, deployed inc9 pipeline)

Drive: evals/drive_inc8.py run on livepeer-ai-x99 against deployed perceive
`highlights-live-perceive-inc9` and decide, via the inc9-drive container
(--perceive http://perceive:8080 --decide http://decide:8081). Clips = INC-5
labeled set (10 clips).

Metrics (metrics_runner.py vs label-manifest.json):

| Metric | INC-7 | INC-8 | INC-9 (this run) | Bar | Status |
|---|---|---|---|---|---|
| Live recall       | 0%   | 66.7% | 100% | >=85% | PASS |
| VOD recall        | 0%   | 66.7% | 100% | >=90% | PASS |
| Precision         | -    | 57.1% | 60.0% | >=60.0% (descoped) | PASS |
| e2e latency max   | 2.0s | 2.0s  | 2.0s  | <=5s  | PASS |
| GOAL latency med  | -    | 0.25s | 0.0s  | <=3s  | PASS |
| Noise-trigger FP  | 0%   | 16.7% | 23.7% | <=60% | PASS |
| Reaction cited TP | -    | 25%   | 100%  | >=80% | PASS |

Trace: evals/inc9-trace-v2.json (76 events, stageA 38 candidates / 9 rejected).
Latency: evals/inc9-latency-v2.json (n=101, mean 0.311s, max 0.416s). A later
1fps frame-batch accounting across the same set measured noise-FP 36.7% (still
<=60% PASS).

**All §6 bars PASS on the descoped precision bar (see decision below).**

## What fixed recall + reaction (the two INC-9 root causes)

- Widen soccer goal-mouth Stage-A zones (~24% width) + ball-in-play-area trigger
  so near-goal clips (soc-near-02, which emitted NO candidate in INC-8) now
  always emit GOAL candidates. Recall live + VOD 66.7% -> 100%.
- Forward honest reaction evidence to decide: crowdEnergy/audioKind from the
  clip's real audio + humansInMotion from the anchor frame's track count + ball
  speed/possession (parity with buildReactionEvidence). Reaction-cited (TP)
  25% -> 100%. No ground-truth labels or manifest.reaction are pipeline input.
- Commits: 8b0ed0a, 56f7e6b (emission), bb2f2df (reaction), 423b04b (evidence),
  d82341b (celebration-cluster measurement).

## Precision 60% — documented measured ceiling (PO descope, ADAAAA-4621)

Precision recovered 0% -> 60% (INC-7 floor -> INC-9). Perceive emits GOAL for
every in-zone strike (required to keep recall at 100%), and all 4 negative
clips (soc-off-01/02, soc-warm-01/02) contain genuine shot sequences Gemma
accepts at score 95. Three independent honest signal families were measured
against the negatives and are **non-separating** (zero ground-truth leakage):

1. Audio crowd-energy proxy from clip audio — broadcast captures are ~0 /
   anti-correlated (uniform loudness; several clips are audio-less).
2. Spatial celebration-cluster + ball-in-goal-mouth from perceive detections
   (commit d82341b) — cluster 0-1 on every clip (perceive keeps ~2 track slots,
   so 2+ players in the tight goal region are rare); ball-in-goal-mouth overlaps
   P vs N; a hard/soft prompt rule over these weak signals forces Gemma to
   blanket-reject, dropping recall 100% -> 0% (measured regression), so the
   known-good decide baseline was kept.
3. Temporal 3-frame `frames` sequence forwarded to decide — precision unchanged
   at 60%.

The single decisive signal — did the ball CROSS the line (ball-outcome) — is
not produced by the current deployed perceive.

**Decision (PO, ADAAAA-4621, done):** Option B — descope. Accept precision
60.0% for this INC-9 acceptance run as a documented measured ceiling (not a
gap). Declined INC-10 funding now (Option A) and relabeling negatives (Option
C). This descope is for THIS acceptance run, not a permanent 60% cap.
Precision-v2 (ADAAAA-4622, backlog) tracks GOAL-vs-near-goal class definition +
ball-outcome feasibility + Livepeer cost estimate for gate-X (ADAAAA-27).

## Verification

- Measured on the deployed inc9 pipeline (livepeer-ai-x99, 2fps); metrics
  accounted by evals/metrics_runner.py; trace + latency JSON persisted above.
- Repo test suites green: services/perceive suite + evals/tests pass on the
  integrated branch feat/inc8-goal-vocab.
