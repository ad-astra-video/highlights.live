# Live decide-observer latency & flag budget (ADAAAA-7008)

Status: live path · owner Developer · documents how the live decide-observer
latency is budgeted, measured, and reported on the Livepeer runner. Pairs with
[`08-tracking-plan-latency-cost.md`](08-tracking-plan-latency-cost.md) (the
perceive detect/latency lens) and the VOD observer contract in
[`03-decide-runner.md`](03-decide-runner.md).

## 1. The flag budget: ~30 s (board-set)

The live "flag" budget — the wall-clock lag between a moment happening in the
stream and the decide-observer flagging it as a highlight/`scoring_play` — is
**~30 s**, set by the board / CEO and locked in the running integration, not
tunable per stream. It is the sum of two things the server controls and one it
does not control per-call:

```
flag budget (~30 s)  ≈  decide cadence (OBSERVE_CADENCE_S = 3 s)
                          +  gemma end-to-end latency per decide invocation
```

- **Cadence (3 s of content time)** — the decide-observer fires at most once per
  `OBSERVE_CADENCE_S`, i.e. a new decide can be scheduled every ~3 s of stream
  time. This bounds how stale the *previous* decision can be when a new moment
  arrives.
- **Gemma end-to-end latency** — the wall-clock time from the tick being
  scheduled to the decide verdict returning (`e2eMs`). This is the dominant,
  per-invocation term and is what makes ~30 s the right budget: a single
  decide round-trip (image frames across the vLLM /livepeer path) is well under
  the leftover after the 3 s cadence, and the budget gives headroom for a
  transient retry (503 no-capacity / 404 session-lost) without the flag deadline
  slipping.

The budget is a **budget, not a timer**: the observer does not sleep to hit
exactly 30 s. It lays an upper bound so that cadence + latency always fits; if
gemma latency ever pushed a decision near the budget, that would be surfaced by
the report (§3), not silently absorbed.

## 2. How it is measured (LiveObserver latency surface)

`services/server/src/observe-loop.ts` `LiveObserver` records one
`LiveObserveLatencySample` **per fired decide invocation**:

```ts
interface LiveObserveLatencySample {
  centerTs: number;   // content time this decide was observed at
  frameCount: number; // frames actually sent to decide for this invocation
  e2eMs: number;      // wall-clock ms from tick-scheduled to decide verdict returned
  cadenceMs: number;  // content-time cadence delta from the previous fired tick (ms)
}
```

- `e2eMs` is measured around the caller's `onDecide` callback (`tick-scheduled →
  verdict returned`), so it includes the full gemma round-trip (the per-invocation
  term the ~30 s budget accounts for).
- `cadenceMs` is the content-time gap since the previous fired tick (from
  `shouldFireObserve`), i.e. the observed cadence, not the nominal 3 s.
- `frameCount` is the per-call decide input size (what the <=30-frame cap bound
  to).

The observer exposes the aggregated report surface the Livepeer runner reads:

| Accessor | Meaning |
|----------|---------|
| `latencySamples()` | the full `LiveObserveLatencySample[]` (cadence + E2E per invoke) |
| `maxE2eMs()` | max observed gemma end-to-end latency (ms; 0 when no sample) |
| `meanE2eMs()` | mean observed gemma end-to-end latency (ms; 0 when no sample) |
| `inputSizeSamples()` | per-call decide input size (frame counts) |
| `decideCalls()` | number of decide invocations (each a `unit: fixed` billable call) |
| `maxFrameCount()` | max frames sent in one call |
| `acceptedCount()` | decide invocations accepted as highlight |

## 3. How it is reported on the Livepeer runner

The report is produced by pulling the `LiveObserver` accessors (§2) — it is not
computed inside the runner, and no separate telemetry/observability channel is
involved. Per decide invocation the runner reports the **cadence delta** and the
**gemma E2E latency**, and as the run progresses:

- **Per invocation**: `cadenceMs` (observed cadence) and `e2eMs` (gemma
  end-to-end) from `latencySamples()`.
- **Run summary**: `maxE2eMs()` / `meanE2eMs()` (does latency stay inside the
  ~30 s budget?), `maxFrameCount()` (was the 30-frame cap hit? how often did a
  window subsample?), and `decideCalls()` vs `acceptedCount()` (the cost lens —
  every invocation is a paid fixed-price decide call, so the observer cadence
  directly drives live decide spend).

A decision whose `e2eMs` exceeds the leftover after the cadence term is the
signal that the live path is no longer meeting the ~30 s flag budget; the
`meanE2eMs` / `maxE2eMs` report makes that visible to the operator.

## 4. Relationship to the frozen vocabulary

The latency/report surface carries **no candidate/event vocabulary**: it only
records cadence, frame count, and timing. The candidate/event vocabulary stays
frozen in `packages/events` (outcome enum `scoring_play` / `near_miss` /
`big_play` / `not_highlight`, `eventTypeForOutcome`, `isAcceptedHighlight`).
A live decide that returns `isHighlight` + `scoring_play` is the board `GOAL`;
`near_miss` / `big_play` are never published as a `GOAL`.
