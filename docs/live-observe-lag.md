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
   viewer experiences is `lag_at_fire + e2e`. The reserve is the WORST decide
   seen so far plus 1 s of measurement margin (`liveLagReserveS`), not the mean:
   measured on job `4f8d47bd`, a mean-based reserve (8.5 s) let an 11.7 s decide
   land a window picked at 21.5 s at a completed lag of 33.0 s — past the budget
   the drop exists to enforce. The reserve is capped at half the budget, so a
   very slow decide cannot starve the pass into deciding nothing. Default budget
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
