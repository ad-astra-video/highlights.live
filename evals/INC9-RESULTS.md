# INC-9 (ADAAAA-4496) §6 re-run — measured results (2fps, deployed inc9 pipeline)

Drive: evals/drive_inc8.py (humansInMotion reaction parity, commit bb2f2df) run
on livepeer-ai-x99 against deployed perceive `highlights-live-perceive-inc9` and
decide, via the inc9-drive container (--perceive http://perceive:8080
--decide http://decide:8081). Clips = INC-5 labeled set (10 clips).

Metrics (metrics_runner.py vs label-manifest.json):

| Metric | INC-8 (66.7/66.7/57.1) | INC-9 (this run) | Bar | Status |
|---|---|---|---|---|
| Live recall       | 66.7% | 100% | >=85% | PASS |
| VOD recall        | 66.7% | 100% | >=90% | PASS |
| Precision         | 57.1% | 60.0% | >=70% | FAIL |
| e2e latency max   | 2.0s  | 2.0s  | <=5s  | PASS |
| GOAL latency med  | 0.25s | 0.0s  | <=3s  | PASS |
| Noise-trigger FP  | 16.7% | 23.7% | <=60% | PASS |
| Reaction cited TP | 25%   | 100%  | >=80% | PASS |

Trace: evals/inc9-trace-v2.json (76 events, stageA 38 candidates / 9 rejected).
Latency: evals/inc9-latency-v2.json (n=101, mean 0.311s, max 0.416s).

What fixed recall + reaction (the two INC-9 root causes):
- Widen soccer goal-mouth Stage-A zones (~24% width) + ball-in-play-area trigger
  so near-goal clips (soc-near-02) now emit GOAL candidates.
- Forward honest reaction evidence to decide: crowdEnergy/audioKind from the
  clip's real audio + humansInMotion from the anchor frame's track count +
  ball speed/possession (parity with buildReactionEvidence).

Remaining gap (precision 60% < 70%): the reaction evidence does not yet separate
real goals from off-target/warm-up shots. The drive's crowd-energy proxy is a
crude mean-volume diff (~0 on these clips; most are broadcast captures with no
separable loudness burst and several are audio-less), and humansInMotion is ~2-3
tracks on both positives and negatives, so Gemma falls back to accepting any
in-zone strike as GOAL. Precision is the INC-10 slice.
