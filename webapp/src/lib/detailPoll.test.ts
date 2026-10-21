import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDetailPoll, VOD_DETAIL_POLL_MS } from "./detailPoll";

// ADAAAA-6984: the open VOD job-detail view polls the server every VOD_DETAIL_POLL_MS
// (5 s) as the reconciling fallback behind the SSE fast path. `startDetailPoll`
// is the DOM-free timer-controller the page uses, so the cadence, terminal-stop
// and cleanup behaviour are unit-tested here in the node environment (no React,
// no jsdom) with vitest fake timers.

describe("startDetailPoll (ADAAAA-6984)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ticks onTick every VOD_DETAIL_POLL_MS (5 s) — the realtime cadence", () => {
    const onTick = vi.fn();
    const poll = startDetailPoll({ shouldContinue: () => true, onTick });
    vi.advanceTimersByTime(VOD_DETAIL_POLL_MS);
    expect(onTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(VOD_DETAIL_POLL_MS);
    expect(onTick).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it("stops itself once shouldContinue() returns false (terminal reached) — no post-terminal fetch", () => {
    const onTick = vi.fn();
    let inFlight = true;
    const poll = startDetailPoll({ shouldContinue: () => inFlight, onTick });
    vi.advanceTimersByTime(VOD_DETAIL_POLL_MS);
    expect(onTick).toHaveBeenCalledTimes(1);
    // job hits done/failed between ticks -> stop polling for it
    inFlight = false;
    vi.advanceTimersByTime(VOD_DETAIL_POLL_MS * 5);
    expect(onTick).toHaveBeenCalledTimes(1);
    poll.stop();
  });

  it("stop() clears the timer — no ticks after close/unmount (no leaked interval)", () => {
    const onTick = vi.fn();
    const poll = startDetailPoll({ shouldContinue: () => true, onTick });
    poll.stop();
    vi.advanceTimersByTime(VOD_DETAIL_POLL_MS * 4);
    expect(onTick).not.toHaveBeenCalled();
  });

  it("is idempotent across multiple stop() calls", () => {
    const onTick = vi.fn();
    const poll = startDetailPoll({ shouldContinue: () => true, onTick });
    poll.stop();
    poll.stop();
    vi.advanceTimersByTime(VOD_DETAIL_POLL_MS * 2);
    expect(onTick).not.toHaveBeenCalled();
  });

  it("honours a custom intervalMs", () => {
    const onTick = vi.fn();
    const poll = startDetailPoll({ intervalMs: 1000, shouldContinue: () => true, onTick });
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it("a throwing onTick does not kill the timer (transient error retries next tick)", () => {
    const onTick = vi.fn(() => {
      throw new Error("network 5xx");
    });
    const poll = startDetailPoll({ shouldContinue: () => true, onTick });
    expect(() => vi.advanceTimersByTime(VOD_DETAIL_POLL_MS)).not.toThrow();
    vi.advanceTimersByTime(VOD_DETAIL_POLL_MS);
    expect(onTick).toHaveBeenCalledTimes(2);
    poll.stop();
  });
});
