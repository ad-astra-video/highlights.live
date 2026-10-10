# Tracking-plan → perceive: latency & cost accounting (increment D)

Status: increment ADAAAA-6467 · owner Developer · applies to the live and VOD
perceive detect path and the worker-side what-to-track planner orchestration.

This document records the **OD-vs-caption cadence** decision and the **Livepeer
GPU cost lens** so the slow caption / region task and the LLM planner stay OFF
the per-frame hot path. It is the audit trail for the acceptance criterion
"live end-to-end detection latency stays within the 1–5 s budget (re-plan and
caption/region discovery never on the per-frame path)".

## 1. The per-frame path (what every sampled frame runs)

On every sampled frame the perceive runner runs, on GPU 0:

- **Florence-2 `<OD>`** (object detection) — closed-vocabulary, cheap, the only
  inference on the per-frame path. It is what produces the bboxes that seed
  SAM3 tracking.
- SAM3 tracker step (box-seeded from the `<OD>` boxes).
- The cheap _zero-GPU_ Stage-A gates (motion burst / audio-energy / detection-
  in-zone) which only ever mark a *candidate*.

This is the 1 fps (live) / 2–5 fps (VOD) sampled detect cadence. It must stay
inside the 1–5 s live detection budget.

## 2. What is explicitly NOT on the per-frame path

Three heavy/LLM operations are deliberately excluded and run **out of band**:

| Operation                 | Cadence                        | Why it is off the per-frame path |
|---------------------------|--------------------------------|----------------------------------|
| what-to-track **planner** | stream-start warm-up (1 call) + out-of-band re-check (default 10 s) + immediate re-plan on a candidate | LLM single-shot, priced like a `/highlight` call |
| caption / region **discovery** | plan / re-plan cadence only (never per-frame) | `<CAPTION>` / `<DENSE_REGION_CAPTION>` are the slow, heavy Florence-2 tasks |
| **decide** (Gemma highlight verdict) | only on a *candidate* event | LLM, never per-frame already (pre-existing) |

The worker's `TrackingPlanController` enforces this by construction: it calls
`client.plan()` **only** from `warmUp()` (once), the re-check `setInterval`
(default `recheckIntervalSeconds` = 10 s), and `onCandidate()` (a candidate
event). The per-frame `/analyze` loop never calls the planner — it only
*reads* the already-produced plan and forwards it to perceive.

## 3. OD vs caption cadence (the cost lens)

Florence-2 task cost / latency, from cheapest to most expensive:

1. `<OD>` — per-frame, closed-vocab, fast. Bounded because it is gated to the
   plan's (or canned/safe-default) label set (closed-vocabulary gate), so it
   does not degrade into open-domain set detection.
2. `<CAPTION>` / `<DETAILED_CAPTION>` — an order of magnitude slower and more
   token-expensive than `<OD>`. Used only by the discovery pass at plan/re-plan
   cadence.
3. `<DENSE_REGION_CAPTION>` — the heaviest; also discovery-only.

The rule (plan §7 D / §8 / §14.4): **"the slow caption/region task stays off
the per-frame path"**. A caption/region run costs the same Livepeer GPU seconds
as a decide call, so it is scheduled at the same slow cadence as the planner —
never multiplied by frame count. Per-frame planner/discovery invocations = 0.

## 4. Livepeer GPU cost lens

The Livepeer GPU runner is priced per-second on GPU 0. The planner and the
discovery pass are **dominant-count bounded**, not per-frame:

- **Warm-up**: exactly 1 planner call (+ at most 1 discovery pass) per stream.
- **Re-check**: 1 planner call per `recheckIntervalSeconds` (default 10 s),
  i.e. ~6 calls/min per stream, ~N× the per-minute rate of the per-frame model.
- **Candidate re-plan**: 1 planner call per candidate event (candidates are
  already scarce — they are Stage-A gated).

So the marginal planner cost is a small adder to the existing per-candidate
`/highlight` (decide) calls, and it is independent of the sampled frame rate.
Clamping `maxTracks` (3 live / 8 VOD) keeps SAM3 slot memory / VRAM on the 24 GB
GPU 0 from growing with plan size.

## 5. Guardrails enforced

| Guardrail | Where | Effect |
|-----------|-------|--------|
| `maxTracks` hard clamp (3 live / 8 VOD) | perceive `clamp_max_tracks` + worker `TrackingPlanController.apply` + decide runner | a plan can never exceed the mode cap |
| LLM-over-request guard (narrow-only) | perceive closed-vocab / `plan_vocabulary` + worker narrow-only drop | a plan can only narrow to what is detectable; it cannot widen past the closed-vocab gate |
| degrade-to-canned / safe-default | perceive `resolve_vocabulary` (plan roster → preferLabels → canned `gameHint` map → `SAFE_DEFAULT_VOCABULARY`) + worker keeps last good plan on failure | absent/invalid planner reply never kills a stream |

## 6. Config knobs

| Env | Default | Meaning |
|-----|---------|---------|
| `WARMUP_SECONDS` | 3 | stream-start warm-up window — one planner call must deliver a plan within it |
| `RECHECK_INTERVAL_SECONDS` | 10 | out-of-band re-check cadence |
| `PLANNER_TIMEOUT_S` | 180 | single planner call timeout |

## 7. Verification

The worker unit tests (`services/server/test/tracking-plan.test.ts`) lock:
- warm-up fires exactly one planner call;
- `maxTracks` is clamped to the mode cap even on an over-request;
- a re-check returning an empty roster does not wipe the active plan;
- a planner failure degrades to a safe default (never a dead stream);
- the re-check cadence applies a new plan and a later `stop()` stops the timer.

The latency/cost acceptance ("re-plan + discovery never on the per-frame path",
"per-frame planner/discovery invocations = 0") is verified by the increment E
measurement harness (see [ADAAAA-6468](/ADAAAA/issues/ADAAAA-6468)).
