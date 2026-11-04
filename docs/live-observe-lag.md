# Live observe lag: bounding the frame clock against the wall clock (ADAAAA-7676)

The live decide-observer runs on a *content* clock. A frame's
`timestamp` is `seq / sampleFps` — how much content the pipeline has processed —
while the capture (rtmp pull, screen grab, file-sim) produces frames in *real*
time. When the serial loop is slower than real time, the two clocks separate and
the gap grows without bound.

## The measured failure

One decide costs ~8–13 s wall (`meanE2eMs` 8.5–9.6 s on `7dae4773` /
`88772e20`) per ~3 s of content, so the loop fell behind by a fixed amount every
cadence tick. On job `11b90ebf` (`jobs.record.summaryLog`: wall `ts` vs content
`windowTs`):

| window content ts | wall elapsed at decide |
|---|---|
| 0 s | +9.6 s |
| 3 s | +26.4 s |
| 6 s | +43.3 s |
| 18 s | +106.7 s |
| 42 s | +242.5 s |

≈5.7x. The frames were genuinely content `T+42s`; the *result* reached the feed
~200 s late, so a live viewer saw moments from minutes ago. The subsequent
diagnosis on a 120 s rtmp run (`88772e20`) shows the same shape: `T+21s` decided
at wall `+109s`, and only ~30 s of a 120 s stream ever decided.

This is the observe-drain/cadence design, not the window-audio bug fixed in
ADAAAA-7671 — but the two interact: audio retention is anchored on the analysis
position, so an unbounded lag also means the tap buffer is asked to cover an
ever-widening span.

## The invariant

1. **Lag is measured against the wall clock.** The live loop anchors the content
   clock to `Date.now()` at the stream's first frame and measures
   `lag = wallElapsed - frameTs` for every later frame.
2. **A bound is enforced by DROPPING, never by deciding more often.** When
   `lag > budget - reserve`, the frame is not recorded and no decide is
   fired for it: `LiveObserver.noteStaleFrame` advances the cadence clock through
   the dropped content and counts the swallowed windows as
   `skippedStaleWindows`. The next fired window is still one `cadenceS` (3 s) of
   content after the drop, so `meanCadenceMs` stays ≤ 3 s and the billable decide
   rate does not rise.
3. **The budget is the landing lag, not the pick-up lag.** Before firing, the
   decide that has not landed yet is reserved out of the budget, because what a
   viewer experiences is `lag_at_fire + e2e`. The reserve is `max(worst decide
   seen so far, 1.5x the mean) + 1 s` (`liveLagReserveS`), not the mean:
   measured on job `4f8d47bd`, a mean-based reserve (8.5 s) let an 11.7 s decide
   land a window picked at 21.5 s at a completed lag of 33.0 s — past the budget
   the drop exists to enforce; and on job `8b88a472` a worst-only reserve
   (8.8 s + 1 s) still admitted a window at 19.3 s lag whose 12.8 s decide landed
   at 32.1 s, because the startup decides were still RAMMING up (the observed
   spread on the runner is 1.35–1.5x the mean). The reserve is capped at half the
   budget, so a very slow decide cannot starve the pass into deciding nothing. Default budget
   30 s (`LIVE_OBSERVE_LAG_BUDGET_S`) — the cadence + decide-E2E budget the spec
   quotes; `<= 0` disables the drop (legacy unbounded behaviour).
4. **The end-of-stream tail obeys the same budget.** The FORCE flush ignores the
   cadence, so an already-stale tail is dropped and counted like any other stale
   window instead of being decided `e2e` later (measured on `4f8d47bd`: the tail,
   content `T+104s`, landed at wall `+146s` and duplicated that window's summary
   entry). A tail inside the budget is still observed.
5. **Dropped frames carry no content into a window.** A stale frame is not
   `record`ed, so a window assembled after a drop contains only the frames that
   were actually analyzed (at the live edge), never the stale backlog.
6. **Audio alignment is preserved.** Retention pruning is anchored on
   `LiveRunShared.analysisPosTs` (ADAAAA-7671), which advances with the recorded
   frames; the tap keeps running in real time, so the window at the new position
   still finds its slice. The `[live-audio]` line's `audioB64Len > 0` invariant
   is unchanged. Audio triggers whose onset fell inside a dropped span are
   covered so they expire instead of anchoring an analysis on a window that no
   longer contains them.

## Observing it

Per decided window:

```
[live-lag:<job>] decide @42.00s lag=12.4s e2e=9611ms completed=22.0s staleSkips=4 budget=30s
```

and one summary at end of stream:

```
[live-lag:<job>] summary droppedFrames=312 skippedStaleWindows=97 maxLag=30.4s budget=30s frames=411
```

On the job record (`GET /jobs/:id`):

- `observeMetrics.skippedStaleWindows` — cadence windows dropped as stale (AC2).
- `observeMetrics.maxLagMs` / `meanLagMs` — worst/mean content-vs-wall lag on a
  dropped frame.
- `observeMetrics.maxCompletedLagMs` — worst lag at the moment a DECIDED window's
  result landed (the viewer-visible number; AC1).
- `observeMetrics.meanCadenceMs` / `meanE2eMs` — unchanged semantics (AC3).

Cross-check a decided window's pair the same way the original diagnosis did:
`jobs.record.summaryLog[].windowTs` (content seconds) vs its wall `ts`, measured
from the job's `createdAt`.

## Verification on a deployed image

A post-fix run (real rtmp live job, `LIVE_OBSERVE_LOOP=1`) should show the last
decided window inside the budget instead of ~5.7x behind, `skippedStaleWindows`
non-zero on a loaded box, `meanCadenceMs <= 3000`, `meanE2eMs` not grown, and
`[live-audio]` `audioB64Len > 0` for ≥90 % of windows. Unit coverage:
`services/server/test/live-observe-lag.test.ts` (drop accounting, dropped frames
never entering a window, bounded completed lag on a slow rail, and the
`budget <= 0` unbounded control).

## In-flight decide depth (ADAAAA-7771)

The lag budget above is a BACKSTOP, not the fix for coverage. Measured on the
deployed box (ADAAAA-7769): the decide pair sustains 1.56-1.60 decides/s against
0.33 decides/s per stream, yet coverage stayed at 33 % / 21-24 % / 15-16 % at
1/2/3 streams because the pass AWAITED each decide — one decide in flight, so
coverage = `cadence / decideWall` regardless of how much decide capacity exists.

`LIVE_OBSERVE_IN_FLIGHT` (default 4, `1` = the old serial pass) lets the pass keep
K windows in flight per stream:

- **Only the expensive half overlaps.** `observeDecideOnly` (gemma decide +
  on-demand recall + decide audit) runs K-wide; `observeAcceptOnly` (running
  summary, candidate build, `acceptVideoDecision`: clip cut, burst suppression,
  highlight record, decision-time billing) is applied strictly in CONTENT order,
  one at a time, so the accept path keeps its serial semantics.
- **The queue is bounded by K.** With all K slots busy the tick is not decided
  and the cadence stays due, so the next frame retries; refusals are counted as
  `observeMetrics.backpressureSkippedWindows` (never as stale skips, which mean
  late content, or admission skips, which mean another live job held the box
  slot).
- **`flush()` drains every outstanding decide** before the job reports, and
  rethrows a decide failure, so metrics/accepts are complete and a failed decide
  still fails the run.
- **Billing is unchanged per decide call**: one decide per window issued, no
  window is decided twice by the pipeline. `observeMetrics.maxDecideInFlight`
  reports the depth actually used (>1 proves the pipeline ran; the serial pass
  reads 0).

Unit coverage: `services/server/test/live-observe-inflight.test.ts` (K-wide
overlap, accept order with reversed completion, bounded backpressure, flush
drain, fail-through, and an end-to-end `analyzeJob` comparison against the serial
pass on a buffered realtime rail).

## Trigger -> DELIVERED latency: the pinned definition (ADAAAA-8005)

Gate 3 of the live media-rail replay is "trigger -> delivered p50 <= 5 s". Until
ADAAAA-8005 that number had no metric behind it: `observeMetrics
.triggerLatencyByFamily` measures onset -> *decided window* (stageA / judged /
stageB), which is entirely PRE-delivery, and the only figure that matched the AC
was a hand join of `[live-lag:<job>] decide @Ts lag` with
`[ingest-gap:<job>] decideE2eMs`. A hand join cannot be re-graded from the job
record, and it conflates two different populations (every decided window vs the
handful of accepted rows).

**Definition (pinned, and the one the AC is graded against).**

- The **trigger** is the delivered row's own `trigger.timestamp` (content
  seconds) - the same value `row.createdAt - (startedAt + trigger.timestamp)`
  subtracts, so the metric and the historical log-join arithmetic agree.
- **Delivered** is the instant the highlight row becomes READABLE on the
  delivered surface: the store write-through acked (`store.addHighlight`
  resolved - the in-memory store is written before the DB await, so a feed read
  on that tick already sees the row).
- `deliveredLatencyMs = persistAck - (contentOriginMs + triggerTs * 1000)`,
  where `contentOriginMs` is the wall epoch-ms of content t=0, derived once per
  run from the first fired window (`firedAt - lag - centerTs*1000`) so it shares
  the rail's own lag clock.

**Where the seconds sit** (one row per delivered highlight, so the AC needs no
log join):

```
[live-deliver:<job>] row @108s delivered=6776ms fire=2777ms decide=3839ms acceptWait=20ms accept=160ms persistAck=12ms
```

- `fireLagMs` - content ts -> cadence fire. This is the frame-arrival/relay lag
  (media node decode + perceive + observation relay). A relay that falls behind
  the sampling cadence shows up HERE, not in the accept path.
- `decideE2eMs` - fire -> decide settle (gemma E2E).
- `acceptWaitMs` - decide settle -> accept entry: the content-order head of line
  (a window cannot be accepted before every earlier window has been).
- `acceptMs` - the accept gate itself (localize, burst suppression, record,
  emit): O(100 ms), CPU-only.
- `persistAckMs` - emit -> store write-through ack.

The five stages sum to `deliveredLatencyMs` (plus `(centerTs - triggerTs)` when
localization moved the trigger inside the window), so a replay can attribute the
gap to one stage instead of guessing.

**On the job record** (`GET /jobs/:id`, admin - it rides the internal
`observeMetrics` block):

- `observeMetrics.deliveredLatency.samples` - delivered rows measured.
- `observeMetrics.deliveredLatency.p50Ms` / `p95Ms` / `maxMs` - the gate-3
  number and its tail.
- `observeMetrics.deliveredLatency.rows[]` - per-row `triggerTs`,
  `deliveredLatencyMs` and the five stages above (bounded at 200 rows).

Unit coverage: `services/server/test/live-delivery-latency.test.ts` (the
arithmetic and its exact decomposition, a localized trigger counted against the
row's own timestamp, negative-clock clamping, p50/p95/max, the tracker's
pending -> ack handshake incl. a retried persist not double-counting, and the
`LiveObserver -> observeMetrics.deliveredLatency` wiring for accepted vs rejected
windows).
