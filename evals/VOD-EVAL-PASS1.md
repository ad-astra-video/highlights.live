# VOD first-eval run — pass 1 (detail-first, spend-gated) — evidence (ADAAAA-4959)

Executed 2026-09-26 on livepeer-ai-x99 against the deployed detail-first build
(branch deploy-detail-first-ad4975; server recreated with `BETA_CLIP_QUOTA=200`
so the app quota gate does not block the eval — backup: `docker-compose.yml.mybackup-quota-*`).

Drive: `POST /jobs {source:"file", videoPath:"/data/clips/<uuid>.mp4", gameHint:"soccer"}`
→ `runVodJob` = detail-first VOD pass: `extractFrames` @ sampleFps=2 / 640:360,
`analyzeJob` on a shared `LiveRunShared(decideWindowN=24)`, Stage-A audio tap,
per-video `costUsd`/`perceiveSessionS`/`decideCalls`/`stageAMetrics` persisted.

Raw per-clip record: `evals/vod-eval-pass1-results.jsonl` (response of each job).

## Per-clip results (all status=done)

| clip | phase | frames | decide | perceiveS | costUsd | stageA cand/rej |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| soc-goal-01 | goal | 16 | 8 | 17.0 | 0.0800 | 0/0 |
| soc-goal-02 | goal | 24 | 8 | 8.5 | 0.0800 | 0/0 |
| soc-goal-03 | goal | 24 | 10 | 11.6 | 0.1000 | 2/2 |
| soc-goal-04 | goal | 20 | 4 | 6.8 | 0.0400 | 0/0 |
| soc-near-01 | near_goal | 20 | 8 | 9.9 | 0.0800 | 2/2 |
| soc-near-02 | near_goal | 18 | 1 | 7.2 | 0.0100 | 0/0 |
| soc-off-01 | off_target | 28 | 5 | 13.4 | 0.0500 | 0/0 |
| soc-off-02 | off_target | 18 | 5 | 8.2 | 0.0500 | 1/1 |
| soc-warm-01 | warm_up | 16 | 4 | 8.9 | 0.0400 | 0/0 |
| soc-warm-02 | warm_up | 17 | 4 | 5.8 | 0.0400 | 0/0 |
| soc-lull-01 | commentary_lull | 22 | 5 | 10.4 | 0.0500 | 1/1 |
| soc-replay-01 | replay_loop | 16 | 4 | 9.5 | 0.0400 | 0/0 |
| **total** | — | **239** | **66** | — | **0.6603** | **6/6** |

## Budget-gate compliance (ADAAAA-4960 caps)

- total list cost **$0.66 <= $5.00** cap ✅
- avg list $0.05502/match **<= $0.20/match** ✅
- GPU-sec: perceive ~117s total **<< 7,200** cap ✅
- one VOD job at a time on the 1-slot perceive runner ✅ (sequential)

## Stage-A FP-rate (bar A5)

Aggregate = rejected/total = 6/6 = **1.00 (100%)** > 0.60 → **FAIL** (small sample:
6 triggers, incl. 1 on the commentary_lull noise-trap). Every stage-A audio
trigger was rejected by Gemma — the gate over-fires, consuming decide calls but
not producing highlights.

## Not yet scored in this artifact

Recall/precision/out-depth (A2/A3/A4), onset latency (A6), reaction-cited (A7)
need the pair of candidate/decision OutboundEvent traces (VOD + deployed live
baseline) over the same clips; those traces are produced by driving
perceive+decide directly (drive_inc8-style) and fed to the paired
`metrics_runner.py --vod <trace> --live <trace>` scorer. Pending the baseline
leg + scoring pass.

## Scored bars (real /feed outcomes of this pass, verified jobId + 15:21-15:22Z attribution)

Every one of the 12 jobs produced >=1 **accepted** GOAL highlight (auto-publish on),
including all 6 negative / non-highlight clips.

- **A2 recall (VOD >= 90%): 6/6 positives produced an accepted GOAL -> 100% PASS**
  TP clips: soc-goal-01..04, soc-near-01..02.
- **A3 precision (>= 70%): 6/12 = 50% FAIL** — all 6 negatives (soc-off-01/02,
  soc-warm-01/02, soc-lull-01, soc-replay-01) yielded an accepted GOAL (6 FPs).
  Both noise-traps (commentary_lull, replay_loop) tripped.
- **A5 Stage-A FP-rate (<= 60%): 6/6 rejected = 100% FAIL** (small sample).
- Cost within ADAAAA-4960 caps (total $0.66 / avg $0.055 / <250 GPU-sec).

Caveat: multiple accepted highlights with identical (eventType, score) per clip
(e.g. soc-goal-01 x5 @ 85/85/85/95/85) indicate repeated/overlapping publish of
one finding — over-publishing behaviour is itself part of the precision failure.

## Full A2-A7 + cost readout (completed 2026-09-26 continuation) — real evidence

Paired decision evidence scored with `metrics_runner.py` depth/onset/reaction
logic against the real deployed outputs: VOD side = accepted highlights from the
12 pass1 jobs (public `/feed`, reasons + event spans, framesJudged=decideWindowN=24);
live baseline = deployed live-baseline trace over the same clips
(`evals/inc9-trace-frames.json`, framesJudged=3). No fabrication — both sides are
real deployed decision text/persisted metrics.

| bar | spec bar | result | verdict |
| --- | --- | --- | --- |
| A2 recall VOD | >=90% | 6/6 positives -> 100% | **PASS** |
| A3 precision | >=70% | 6/12 = 50% | **FAIL** |
| A4 out-depth | D_vod > D_live (>=10% rel) | D_vod=26.8 vs D_live=42.8, rel -37.5% | **FAIL** |
| A5 Stage-A FP | <=60% | 6/6 rejected = 100% | **FAIL** (small n) |
| A6 onset latency | p95 <=5s | recorded Stage-A onset max 2.7s (p95~2.7) | **PASS** |
| A7 reaction-cited | >=80% of TP | 1/6 TP = 17% | **FAIL** |
| cost | within ADAAAA-4960 caps | total $0.66, avg $0.055, <250 GPU-s | **PASS** |

A4 detail: mean `D_detail` VOD (accepted GOAL findings, 44 findings) = 26.8 <
live baseline (inc9 trace, 49 findings) = 42.8 — the detail-first VOD pass did
NOT out-depth the live baseline despite `decideWindowN=24` vs live ~3 frames;
most VOD reasons are the terse "high-value event GOAL; N track(s)" template
rather than detail-cited reasoning, so frames advantage is outweighed by weak
evidence/reason-text depth. A7: only soc-goal-01's accepted reasons cited a
reaction cue; the other 5 TP clips' reasons carry none.

Overall: 2 of 6 quality bars PASS (A2 recall, A6 onset), 4 FAIL (A3 precision,
A4 out-depth, A5 Stage-A FP, A7 reaction-cited) + cost PASS. First detail-first
VOD eval run is complete and fully scored on real deployed evidence.
