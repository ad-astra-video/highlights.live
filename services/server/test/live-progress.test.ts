import { describe, it, expect } from "vitest";
import {
  LIVE_PROGRESS_CAUGHT_UP_S,
  deriveLiveProgress,
  liveContentAnchorMs,
  newestObservationTs,
  skippedWindowsFromSummaryLog,
  type LiveProgressInput,
} from "../src/live-progress";

// ADAAAA-7741: the customer-facing processing-lag projection. These tests pin
// the derivation (read-path only, stored data only) and the AC1 arithmetic:
// lagSec must equal (now - startedAt - processedThroughTs) and must move between
// two reads 5 s apart.

const T0 = Date.parse("2026-11-02T04:00:00.000Z");

/** A live job whose content clock started T0. */
function liveJob(over: Partial<LiveProgressInput["job"]> = {}): LiveProgressInput["job"] {
  return {
    status: "active",
    source: "rtmp",
    startedAt: new Date(T0).toISOString(),
    createdAt: new Date(T0).toISOString(),
    summaryLog: [
      { seq: 1, ts: new Date(T0 + 31_000).toISOString(), windowTs: 21 },
      { seq: 2, ts: new Date(T0 + 60_000).toISOString(), windowTs: 34 },
    ],
    ...over,
  };
}

describe("deriveLiveProgress (ADAAAA-7741 AC1)", () => {
  it("reports lagSec as liveEdgeTs - processedThroughTs from the stored pairs", () => {
    const p = deriveLiveProgress({ job: liveJob(), nowMs: T0 + 60_000 });
    expect(p.liveEdgeTs).toBe(60);
    expect(p.processedThroughTs).toBe(34);
    expect(p.lagSec).toBe(26);
    expect(p.state).toBe("behind");
    expect(p.updatedAt).toBe(new Date(T0 + 60_000).toISOString());
  });

  it("matches an independent (now - startedAt - processedThroughTs) recompute within 2 s", () => {
    const job = liveJob();
    const nowMs = T0 + 75_400;
    const p = deriveLiveProgress({ job, nowMs });
    // The AC recomputes from the SAME payload: now, job.startedAt, processedThroughTs.
    const independent = (nowMs - Date.parse(job.startedAt as string)) / 1000 - p.processedThroughTs;
    expect(Math.abs(p.lagSec - independent)).toBeLessThanOrEqual(2);
  });

  it("changes the lag between two reads 5 s apart", () => {
    const first = deriveLiveProgress({ job: liveJob(), nowMs: T0 + 60_000 });
    const second = deriveLiveProgress({ job: liveJob(), nowMs: T0 + 65_000 });
    expect(second.lagSec - first.lagSec).toBeCloseTo(5, 5);
  });

  it("reads caught_up when the newest decided window is within 5 s of the edge", () => {
    const p = deriveLiveProgress({
      job: liveJob({ summaryLog: [{ seq: 1, ts: new Date(T0 + 8_000).toISOString(), windowTs: 7 }] }),
      nowMs: T0 + 10_000,
    });
    expect(p.lagSec).toBe(3);
    expect(p.lagSec).toBeLessThanOrEqual(LIVE_PROGRESS_CAUGHT_UP_S);
    expect(p.state).toBe("caught_up");
  });

  it("uses the newest persisted observation as a live-edge estimate but never produces a negative lag", () => {
    // Observation content ts ahead of the wall estimate (clock skew) is clamped
    // UP to the edge, and the edge itself never trails the decided window.
    const p = deriveLiveProgress({
      job: liveJob({ summaryLog: [{ seq: 1, ts: new Date(T0 + 9_000).toISOString(), windowTs: 8 }] }),
      nowMs: T0 + 5_000,
      newestObservationTs: 30,
    });
    expect(p.liveEdgeTs).toBe(30);
    expect(p.lagSec).toBe(22);
    const clamped = deriveLiveProgress({
      job: liveJob({ summaryLog: [{ seq: 1, ts: new Date(T0 + 9_000).toISOString(), windowTs: 40 }] }),
      nowMs: T0 + 5_000,
    });
    expect(clamped.lagSec).toBe(0);
  });

  it("falls back to the summary-log wall/content pair when a legacy live row has no startedAt", () => {
    const job = liveJob({ startedAt: undefined });
    const anchor = liveContentAnchorMs(job);
    // The earliest entry carries the least decide latency: 31s wall - 21s content.
    expect(anchor).toBe(T0 + 10_000);
    const p = deriveLiveProgress({ job, nowMs: T0 + 60_000 });
    expect(p.liveEdgeTs).toBe(50);
    expect(p.lagSec).toBe(16); // 50 - 34
  });

  it("returns unknown before the first decided window (the arithmetic still holds)", () => {
    const p = deriveLiveProgress({ job: liveJob({ summaryLog: [] }), nowMs: T0 + 20_000 });
    expect(p.state).toBe("unknown");
    expect(p.processedThroughTs).toBe(0);
    // processedThroughTs is 0 because nothing has been decided, so the invariant
    // lagSec === liveEdgeTs - processedThroughTs is preserved; the UI renders
    // nothing for `unknown` rather than presenting this as a live lag reading.
    expect(p.lagSec).toBe(20);
  });

  it("returns unknown for an in-flight VOD job — there is no live edge to measure", () => {
    const p = deriveLiveProgress({ job: liveJob({ source: "file" }), nowMs: T0 + 60_000 });
    expect(p.state).toBe("unknown");
  });
});

describe("deriveLiveProgress terminal state (ADAAAA-7741 AC6)", () => {
  it("freezes the edge at the last landed window and reports unknown so no number keeps ticking", () => {
    const job = liveJob({
      status: "done",
      finishedAt: new Date(T0 + 95_000).toISOString(), // finalization ran 35 s after the last decide
      completedAt: new Date(T0 + 95_500).toISOString(),
    });
    const atFinish = deriveLiveProgress({ job, nowMs: T0 + 95_000 });
    const muchLater = deriveLiveProgress({ job, nowMs: T0 + 600_000 });
    expect(atFinish.state).toBe("unknown");
    expect(muchLater.state).toBe("unknown");
    // Frozen at the newest append (T0+60s) minus the newest window (34 s): the
    // completed lag the viewer experienced, not the finalize tail.
    expect(atFinish.liveEdgeTs).toBe(60);
    expect(atFinish.lagSec).toBe(26);
    expect(muchLater.liveEdgeTs).toBe(atFinish.liveEdgeTs);
    expect(muchLater.lagSec).toBe(atFinish.lagSec);
  });

  it("takes the completed run's recorded skip count as a floor, without surfacing observeMetrics", () => {
    const job = liveJob({
      status: "done",
      finishedAt: new Date(T0 + 120_000).toISOString(),
      // Cadence-grid windows: [0, 3, 9, 12] => 1 derived skip.
      summaryLog: [
        { seq: 1, ts: "", windowTs: 0 },
        { seq: 2, ts: "", windowTs: 3 },
        { seq: 3, ts: "", windowTs: 9 },
        { seq: 4, ts: "", windowTs: 12 },
      ],
      observeMetrics: { skippedStaleWindows: 4 },
    });
    const p = deriveLiveProgress({ job, nowMs: T0 + 120_000 });
    expect(p.skippedWindows).toBe(4); // persisted exact counter wins as the floor
    // ADAAAA-8121: `strideData: false` is the honest degrade for a record whose
    // consume block is absent — it says "no stride data" instead of a position.
    expect(p.strideData).toBe(false);
    expect(Object.keys(p).sort()).toEqual(
      ["lagSec", "liveEdgeTs", "processedThroughTs", "skippedWindows", "state", "strideData", "updatedAt"].sort()
    );
  });

  it("reports SUPPLY skips at completion, never the throttled windows (ADAAAA-7808)", () => {
    // The 2-stream ship row measured exactly this shape: the rate cap leaves
    // cadence gaps the gap heuristic reads as 33-35 skipped windows, while the
    // rail failed to serve 1 and 0 of them. `skippedWindows` is the supply
    // number, so the throttle must not leak into it.
    const job = liveJob({
      status: "done",
      finishedAt: new Date(T0 + 120_000).toISOString(),
      // Windows 3 s apart for the first two (no gap) then 33 s apart: the gap
      // heuristic alone would report 10 skips on this log.
      summaryLog: [
        { seq: 1, ts: "", windowTs: 0 },
        { seq: 2, ts: "", windowTs: 3 },
        { seq: 3, ts: "", windowTs: 36 },
      ],
      observeMetrics: { skippedStaleWindows: 0, supplySkippedWindows: 1 },
    });
    const p = deriveLiveProgress({ job, nowMs: T0 + 120_000 });
    expect(skippedWindowsFromSummaryLog(job.summaryLog as any)).toBe(10);
    expect(p.skippedWindows).toBe(1);
  });
});

describe("skippedWindowsFromSummaryLog (ADAAAA-7741 AC4)", () => {
  const entries = (windows: number[]) => windows.map((windowTs, i) => ({ seq: i + 1, ts: "", windowTs }));

  it("counts each whole extra cadence between decided windows", () => {
    // 3 s cadence: 3->6 and 12->15 are normal steps, 6->12 swallowed one,
    // 15->24 swallowed two.
    expect(skippedWindowsFromSummaryLog(entries([3, 6, 12, 15, 24]))).toBe(3);
  });

  it("does not treat the first window's offset from 0 as a skip", () => {
    // The observer anchors on the first stale frame and counts 0 skips there —
    // startup content must never be reported as dropped.
    expect(skippedWindowsFromSummaryLog(entries([9, 12, 15]))).toBe(0);
  });

  it("does not count an off-grid (audio-anchored) window as a skip", () => {
    expect(skippedWindowsFromSummaryLog(entries([3, 7.5, 10.5]))).toBe(0);
  });

  it("tolerates fractional grid centres and ignores entries without windowTs", () => {
    const log = [
      { seq: 1, ts: "", windowTs: 11.666666666666666 },
      { seq: 2, ts: "", windowTs: undefined },
      { seq: 3, ts: "", windowTs: 17.666666666666666 },
      { seq: 4, ts: "", windowTs: 20.666666666666666 },
    ];
    expect(skippedWindowsFromSummaryLog(log as any)).toBe(1);
  });

  it("returns 0 for an empty / single-window log", () => {
    expect(skippedWindowsFromSummaryLog([])).toBe(0);
    expect(skippedWindowsFromSummaryLog(entries([3]))).toBe(0);
    expect(skippedWindowsFromSummaryLog(undefined)).toBe(0);
  });
});

describe("newestObservationTs", () => {
  it("returns the max stored content ts, 0 when there is none", () => {
    expect(newestObservationTs([{ timestamp: 4 }, { timestamp: 12.5 }, { timestamp: 9 }])).toBe(12.5);
    expect(newestObservationTs([])).toBe(0);
    expect(newestObservationTs(undefined)).toBe(0);
  });
});
