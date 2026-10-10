# Increment E (ADAAAA-6468) — TrackingPlan QA: per-increment acceptance + §8 metric instrumentation

QA/Reviewer deliverable for the ADAAAA-6441 what-to-track refactor (plan §7
acceptance, §8 metrics, §14.9 verification gate). This directory is the
reproducible measurement/acceptance tool. It is a **handoff artifact**: the
mechanism-level (no-GPU) acceptance criteria are verified here on the integrated
tree, and the runtime §8 metrics are instrumented + scored from a pipeline trace.

## What this delivers (issue ask)

- **Per-increment acceptance tests (plan §7 / §14.9)** → mechanism-level suites
  shipped by the developer increments A–F, re-verified green on the integrated
  tree A+B+C+D+F, plus `--mechanism` offline run (below).
- **§8 metric instrumentation — which counters/harness, how each metric is
  measured** → `METRICS` table in `eval_trackplan_metrics.py` and the table
  below. Each metric names its trace counter/harness field and measurement
  method; `score_trace` computes it from a pipeline trace and PASS/FAILs it
  against the §8 target.

## Run

```bash
# Offline per-increment mechanism acceptance (pytest suites A–F on integrated tree)
python3 evals/increment-e/eval_trackplan_metrics.py --mechanism

# §8 metric scoring from a real live/VOD pipeline trace (needs a deployed run)
python3 evals/increment-e/eval_trackplan_metrics.py --trace <trace.json> --mode live

# Accounting self-test (no GPU; validates the scorer, NOT pipeline evidence)
python3 -m pytest evals/increment-e/test_eval_trackplan_metrics.py -q
```

## Integrated tree

A+B+C+D+F are on separate increment branches and merged into the QA branch
`qa/ad-6468-increment-e` (ST-F merged into the ST-D line; one resolve in
`services/server/src/api.ts` kept both the ST-D `planMode`/warmup/recheck and
ST-F `analysisFps`/`maxFramesPerAnalysis` field sets). Baseline verification on
that tree:

- `services/perceive/tests` — 271 passed
- `services/decide/tests` — 111 passed
- `services/train/tests` — 2 passed
- `services/server/test` (tracking-plan + analyzer + stage-a-metrics) — 58 passed

## §8 metric catalog (counter/harness + measurement method)

| Metric (§8) | Target | Harness counter (trace field, emitted by) | Measurement |
|---|---|---|---|
| Latency (live) | p95 within 1–5 s | `decision.latencyS` (perceive trigger onset → decide verdict) | p95 of decision latencies across run |
| Re-plan/discovery latency | p95 << budget, never per-frame | `plan.latencyS` (planner/discovery call wall time) | p95 of plan latencies; assert `plan.perFrame==0` |
| Target precision | ≥ 90 % | `plan.trackableTargets`/`plan.targets` (perceive consumed roster → SAM track) | trackable / total plan targets |
| Detection alignment | plan-scoped, off-plan dropped | `detection.offPlanTracked` (closed-vocab gate rej.) | off-plan tracked count must be 0 |
| Discovery usefulness | measured | `discovery.promoted`/`discovery.candidates` (perception discovery pass) | promoted / candidates |
| Category coverage | all 8 categories | `plan.category` + `plan.targets>0` (each category one valid plan) | count of 8 with valid roster |
| Noise-trigger FP rate | minimized | `candidate.gatedIn` + later `notHighlight` (noise gate → gemma) | gated-in-but-not-highlight / gated-in |
| Audio-evidence use | crowd-alone = 0 | `decision.crowdAloneScoring` (reason cites audio+frames) | crowd-alone scoring verdicts = 0 |
| Frame cap (live) | ≤ ~5 fps, cap never exceeded | `framewatch.mode=live.violated` (frame-watch assembler) | calls exceeding `maxFramesPerAnalysis` = 0 |
| Frame cap (VOD) | higher than live, config-doc | `framewatch.mode=vod.violated` | violations = 0 AND vod cap > live cap |
| Near-miss recall | ≥ 80 % | `nearmiss` labeled set (truth/verdict) | true near-miss emitted / labeled near-miss |
| Near-miss precision | ≥ 80 % | `nearmiss` verdict set | genuine / near-miss verdicts |
| Near-miss vs scoring confusion | = 0 | `nearmiss.confused` | cross-emitted verdicts = 0 |
| Audio-misled rate | audio-following = 0 | `decision.followedAudio` (frames-vs-audio conflict) | followed misleading audio = 0 |
| Tracking accuracy | no regression, 3/8 count | `tracking.total/correct` (+ `track_count` vs mode cap) | precision = correct/total; count ≤ mode cap |
| VOD depth | out-deep live | `depth.live`/`depth.vod` (per-finding D_detail) | mean(D_vod)/mean(D_live) ≥ 1.10 |
| Warm-up time | ≤ ~3 s | `plan.warmupS` (stream start → plan applied) | max over warm-up plans |
| Re-check interval | ≤ ~10 s | `plan.recheckS` (out-of-band re-check swap) | max over re-check plans |
| Per-frame planner calls | 0 | `plan.perFrame` (origin of planner/discovery call) | count of per-frame-origin calls = 0 |
| Cost bound | bounded, documented cadence | `plan` event count, non-per-frame | extra decide-class calls (never per-frame) |

## Trace emission contract

The trace JSON consumed by `score_trace` is a list of `events` with the types
above. `services/*` emit the decision/candidate/detection/tracking/depth events
already (perceive `OutboundEvent`, decide `HighlightDecision`, the frame-watch
assembler, the warm-up/re-check planner). The plan-scoped fields
(`plan`, `discovery`, `nearmiss`, `framewatch`, `plan.perFrame`) reflect the
increment A–F instrumentation. Where a §8 metric has no trace field yet,
`score_trace` returns `not_captured` (never a fabricated pass).
