# G6 — Watcher metrics + cost budget (ADAAAA-6743)

Follows the ADAAAA-6706 plan Part 3 / Part 4 gates. G5 (ADAAAA-6742) landed the
live watcher-first drive behind `LIVE_WATCHER_FIRST`; G6 applies + quantifies the
Part-4 cost knobs and records the measured metric targets.

## Metric targets measured (Part 3 / Part 4 gates)

Measured by the existing local gate harnesses (rule mode = the decision/routing
mechanics, not Gemma model quality; the model-quality gates need the GPU box and
are verified by QA — see the handoff note below).

| Gate | Bar | Measured | Verdict |
|---|---|---|---|
| Pass 1 — summary cadence (max gap) | <= 3 s | 3.0 s | PASS |
| Pass 1 — frame chunk | <= 30 frames / 10 s / 3 fps | 30 / 10.0 s | PASS |
| Pass 1 — overlap (steady state) | >= 50 % | 70 % | PASS |
| Pass 1 — event -> first summary | <= 5 s | 1.0 s | PASS |
| Pass 1 — summary context | >= 10 rows / last-30 s | 11 rows / 30 s | PASS |
| Pass 2 — depth-router recall | >= 80 % | 100 % | PASS |
| Pass 2 — flag rate | <= 5 flags/min | 3.00/min | PASS |
| Pass 2 — FP flags | bounded FP rate | 0.00/min | PASS |
| Deep — precision / recall | high, vs single-shot | 100 % / 100 % | PASS |
| Deep — discard on refute | no clip | 0 clips on discard | PASS |
| Noise-trigger — audio-only FP rate | bounded | 0.00/min | PASS |
| Noise-trigger — deep-call gated | gemma not fired on noise | 0 gated discards | PASS |

Run:

```bash
python3 evals/decide_watcher_pass1.py
python3 evals/decide_watcher_deep_investigation.py
```

## Cost knobs applied (plan Part 4) — and their effect quantified

New in G6 (all env-configurable, defaults preserve the G5 gate shape so a
flag-on live path is unchanged unless an operator opts into a cost-tuned profile):

| Knob | Default | Env | Implementation |
|---|---|---|---|
| Watcher chunk cadence | 3 s | `WATCHER_TICK_S` | forwarded to decide `tick_s` |
| Watcher chunk fps | 3 fps | `WATCHER_FPS` | forwarded to decide `fps` |
| Watcher chunk frame cap | 30 | `WATCHER_MAX_FRAME_COUNT` | forwarded to `max_frame_count` |
| Cost-gated tool policy | off | `WATCHER_TOOL_GATE` | deep tools only after a cheap CPU/audio pre-signal |
| Trace-write rate | 1.0 | `WATCHER_TRACE_WRITE_RATE` | downsample the analysis-session-trace write rate |

Already applied by G1–G5 (verified, no change needed):

- **Gate deep investigation on cheap CPU/audio signals** — `DeepInvestigationConfig`
  audio gate (`audio_peak_min` / `audio_rise_min`) + depth-router `require_corroboration`.
- **One watcher pass per live stream** — the live path starts one watcher session
  per stream; there is no per-viewer duplicate.
- **Size perceive persistent analysis to lowest workable frame rate** — perceive
  `capability()` feeds the ingest bus at the measured `sample_interval_s`, so the
  card is not over-fed.
- **Cap/batch persistence writes** — VOD analysis writes capped at
  `VOD_ANALYSIS_MAX_SAMPLES` and batched; `analysis_events` / `analysis_session_traces`
  are append-batched and retention-purged (`ANALYSIS_RETENTION_MS`).

### Quantified effect of each knob (rule-mode cost model)

`python3 evals/decide_watcher_cost_model.py` over a 120 s quiet-dominant stream:

```
PROFILE  | fps  maxF  toolGate  traceRate | frames/call  tools/tick  trace/tick
  A      | 3.0   30     no        1.00     |      29.18       4.00     4.000   (G5 gate default)
  B      | 2.0   20     no        1.00     |      19.40       4.00     4.000   (chunk downsample)
  C      | 2.0   20     yes       1.00     |      19.40       2.20     2.200   (+ tool gate)
  D      | 2.0   20     yes       0.25     |      19.40       2.20     0.550   (+ trace-write rate)
```

Knob effects (relative to profile A):

- Chunk downsample `3 fps/30 -> 2 fps/20` lowers **frames per brain call by 33.5 %**
  — frame count is the per-call KV-cost multiplier, so this is the headline cost
  lever on the watcher pass.
- **Cost-gated tool policy** lowers **tool calls per tick by 45 %** (and the deep
  perceive GPU work behind `get_tracked_players` / `detect_objects`) on a
  quiet-dominant stream — measured on the genuine quiet-dominant case after a
  QA follow-up (ADAAAA-6769) bounded the post-event tracked object to the event
  window (a persistent object had kept the gate open ~71s of the 120s and
  under-stated the effect at 20 %). Motion/audio windows still keep the full
  four-tool sweep when something is happening; hypotheses seeded is unchanged
  (event detection unaffected).
- Trace-write-rate `0.25` lowers **trace records per tick by 75 %** (persistence
  write rate), without dropping tool calls.

Hypotheses seeded is identical across A/B/C/D (the knobs change cost, not the
decide routing on this stream).

## Cost budget (locked)

The directive "lock the watcher + perceive-session + persistence cost budget" is
operationalized as: the live watcher-following profile is selected entirely by
env config, and the cost is bounded by these chartered ceilings:

- Watcher gemma calls: **1 per `tick_s` per live stream** (no per-viewer duplicate).
- Frames per watcher gemma call: `max_frame_count` (default 30; cost-tuned 20).
- Deep investigation gemma calls: bounded by the depth-router flag rate
  (<= 5 flags/min) and gated on a cheap audio/motion signal.
- Perceive persistent analysis: runs at the measured sustainable frame rate
  (never over-fed; CPU hard-capped at 1 fps).
- Persistence: analysis data + trace are append-batched; trace write rate is
  downsampled; rows are retention-purged.

The **compute decision (whether to run the live watcher + persistent perceive
session on all live streams or only operator-watched streams, and VRAM/concurrency
sizing)** remains a CEO cost call per plan Part 4 — flagging this in the G6 handoff
for the CEO, not something an operator env flag should silently decide.

## Handoff

- **Developer (this issue):** knobs applied + quantified (above), gate harnesses
  run, tests passing.
- **QA:** verify the metric targets on the GPU box (model-quality precision/recall,
  live latency, noise FPR on real media), since the local rule-mode harnesses
  measure the mechanics, not Gemma quality.
- **CEO:** owns the compute cost budget / whether the live watcher runs on all
  streams or only operator-watched streams (plan Part 6 decisions).

## Verification

- `services/decide` pytest: **197 passed** (incl. new cost-gate + trace-rate tests).
- `services/server` vitest (live-watcher-first 8 + clip-upload 9 + analysis-persistence 3):
  **20 passed**.
- `services/server` tsc: only the pre-existing unbuilt shared-package errors
  (`@highlights/events` / `@highlights/livepeer-session`) — none in the new code.
