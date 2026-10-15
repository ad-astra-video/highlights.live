import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeAnalysisBatcher, type AnalysisEvent } from "./analysisRelay";

const ev = (kind: string): AnalysisEvent => ({ timestamp: 0, kind, data: {} });

describe("makeAnalysisBatcher (ADAAAA-6746 G1b batch-flush)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("buffers events and flushes them as one batch after the interval", () => {
    const post = vi.fn();
    const b = makeAnalysisBatcher(post, { intervalMs: 2000, maxBatch: 200 });
    b.push(ev("a"));
    b.push(ev("b"));
    expect(post).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toHaveLength(2);
    b.stop();
  });

  it("caps each batch at maxBatch and never exceeds it, flushing overflow", () => {
    const post = vi.fn();
    const b = makeAnalysisBatcher(post, { intervalMs: 2000, maxBatch: 200 });
    for (let i = 0; i < 500; i++) b.push(ev("x"));
    // 200-cap flush fires as the buffer crosses the cap (sync during the loop).
    expect(post).toHaveBeenCalled();
    // Let the overflow timer(s) run out fully.
    vi.advanceTimersByTime(10_000);
    const batches = post.mock.calls.map((c) => c[0] as AnalysisEvent[]);
    const total = batches.reduce((n, c) => n + c.length, 0);
    expect(total).toBe(500);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(200);
    b.stop();
  });

  it("flush() with an empty buffer posts nothing and clears the timer", () => {
    const post = vi.fn();
    const b = makeAnalysisBatcher(post, { intervalMs: 2000, maxBatch: 200 });
    b.push(ev("a"));
    b.flush();
    vi.advanceTimersByTime(2000);
    expect(post).toHaveBeenCalledTimes(1); // only the explicit flush
    expect(post.mock.calls[0][0]).toHaveLength(1);
    b.stop();
    b.flush();
    expect(post).toHaveBeenCalledTimes(1); // nothing new after stop
  });
});
