// ADAAAA-8636: the live chip's `skippedWindows` is a SUPPLY counter, not a
// summary-log artifact.
//
// Measured on job `22ff6ca2` (live 02:27:18Z): the chip read 33 skipped windows
// while the applied-window ledger was continuous — 261 `job_candidates` windows
// over 1319.8 s, mean step 5.08 s, MAX step 8.6 s against a 10 s trailing span,
// 0 steps over 10 s. No stored skip counter was non-zero; in flight they are not
// even recorded (`stored: false`). The 33 came from replaying
// `skippedWindowsFromSummaryLog` over 54 caption rows ~24 s apart: the summary
// log is one entry per KEPT CAPTION, so its gaps measure the summary writer, not
// missing coverage (and the two largest gaps, 106.6 s / 238.0 s, scored zero
// because they were off-grid).
//
// The fix, pinned here:
//   AC-1  in flight the count comes ONLY from the rail's in-memory supply
//         counters (stale + admission + backpressure, read mid-share like
//         ADAAAA-8250's `liveConsume`); with no rail evidence the field is
//         absent (`skipData: false`) and the chip renders no skip clause,
//   AC-2  the terminal path is unchanged: `observeMetrics.supplySkippedWindows`
//         verbatim, floor `skippedStaleWindows` when absent (ADAAAA-8526),
//   AC-3  both arms are pinned below, and the gap heuristic is marked
//         terminal-legacy-only,
//   AC-4  no decide/perceive call, no GPU, no new stored field — the same
//         in-memory counters the completion record already publishes.
import { describe, it, expect } from "vitest";
import {
  deriveLiveProgress,
  liveSupplySkippedWindows,
  skippedWindowsFromSummaryLog,
  type LiveProgressInput,
} from "../src/live-progress";
import { MediaRailObserver } from "../src/media-rail";

const T0 = Date.parse("2026-11-11T02:27:18.000Z");

/** The 02:34Z leg's summary-log shape: ~54 kept-caption rows, ~24 s apart,
 *  over ~1320 s of content (261 decided windows underneath). */
function captionLog(): Array<{ seq: number; ts: string; windowTs: number; text: string }> {
  return Array.from({ length: 54 }, (_, i) => ({
    seq: i + 1,
    ts: new Date(T0 + i * 24_000).toISOString(),
    windowTs: i * 24,
    text: `caption ${i + 1}`,
  }));
}

function inFlightJob(over: Partial<LiveProgressInput["job"]> = {}): LiveProgressInput["job"] {
  return {
    status: "active",
    source: "browser",
    startedAt: new Date(T0).toISOString(),
    createdAt: new Date(T0).toISOString(),
    summaryLog: captionLog(),
    ...over,
  };
}

function terminalJob(over: Partial<LiveProgressInput["job"]> = {}): LiveProgressInput["job"] {
  return inFlightJob({
    status: "done",
    finishedAt: new Date(T0 + 1_320_000).toISOString(),
    completedAt: new Date(T0 + 1_320_500).toISOString(),
    ...over,
  });
}

const NOW_IN_FLIGHT = T0 + 1_320_000; // ~1320 s into the share

describe("in-flight skippedWindows comes from the rail, never the caption cadence (ADAAAA-8636 AC-1)", () => {
  it("renders NO skip count when the rail has no in-memory evidence — never the 33 (AC-3a)", () => {
    const job = inFlightJob();
    // The old formula on this exact log, at the 3 s cadence it was written for:
    // every 24 s caption gap is 8 cadences of 3 s, so each gap scored 7
    // "skipped" windows. Positive, arbitrary, and not missing coverage — the
    // reason the field must be absent rather than derived. (The shipped live
    // cadence is 5 s since ADAAAA-8676; at 5 s this 24 s log is off-grid and the
    // legacy heuristic reads 0, which is why the AC is "absent", not "0".)
    expect(skippedWindowsFromSummaryLog(job.summaryLog as any, 3)).toBeGreaterThan(0);

    const p = deriveLiveProgress({ job, newestObservationTs: 1319.8, nowMs: NOW_IN_FLIGHT });
    expect(p).not.toHaveProperty("skippedWindows");
    expect(p.skipData).toBe(false);
    expect(p.skippedWindows).not.toBe(33);
    // The lag reading itself is untouched: this ticket is the skip clause only.
    expect(p.state).toBe("behind");
    expect(p.lagSec).toBe(48); // 1320 s edge - 1272 s newest caption
  });

  it("reports the rail's LIVE supply counters mid-share, ignoring the caption gaps (AC-1)", () => {
    const p = deriveLiveProgress({
      job: inFlightJob(),
      newestObservationTs: 1319.8,
      nowMs: NOW_IN_FLIGHT,
      liveSupply: { skippedStaleWindows: 0, admissionSkippedWindows: 0, backpressureSkippedWindows: 0 },
    });
    // A measured zero IS a number: the rail says it served every window.
    expect(p.skippedWindows).toBe(0);
    expect(p.skipData).toBeUndefined();
  });

  it("sums the three supply causes exactly like the completion report (AC-1/AC-4)", () => {
    const p = deriveLiveProgress({
      job: inFlightJob(),
      newestObservationTs: 1319.8,
      nowMs: NOW_IN_FLIGHT,
      // The ADAAAA-8634 verdict's shape: no stored counters while in flight, but
      // the rail is counting. 2 stale + 1 admission + 3 backpressure = 6.
      liveSupply: { skippedStaleWindows: 2, admissionSkippedWindows: 1, backpressureSkippedWindows: 3 },
    });
    expect(p.skippedWindows).toBe(6);
  });

  it("keeps the throttle out of the in-flight number (ADAAAA-7808)", () => {
    // The rail evidence carries no throttle field at all; a caller cannot fold
    // the funded rate decision into the supply count.
    const supply = { skippedStaleWindows: 1, admissionSkippedWindows: 0, backpressureSkippedWindows: 0 };
    const p = deriveLiveProgress({ job: inFlightJob(), nowMs: NOW_IN_FLIGHT, liveSupply: supply });
    expect(p.skippedWindows).toBe(1);
  });
});

describe("terminal skippedWindows is unchanged (ADAAAA-8636 AC-2)", () => {
  it("uses observeMetrics.supplySkippedWindows verbatim, ignoring any live block", () => {
    const p = deriveLiveProgress({
      job: terminalJob({ observeMetrics: { supplySkippedWindows: 2, skippedStaleWindows: 0 } }),
      nowMs: T0 + 600_000,
      // A stale rail block must never override the settled record.
      liveSupply: { skippedStaleWindows: 9, admissionSkippedWindows: 9, backpressureSkippedWindows: 9 },
    });
    expect(p.skippedWindows).toBe(2);
    expect(p.skipData).toBeUndefined();
    // AC-2 keeps the settled key set byte-identical to ADAAAA-7741/8121.
    expect(Object.keys(p).sort()).toEqual(
      ["lagSec", "liveEdgeTs", "processedThroughTs", "skippedWindows", "state", "strideData", "updatedAt"].sort()
    );
  });

  it("keeps the recorded stale counter as the floor for a pre-supply-field legacy record", () => {
    // Cadence-grid windows [0, 5, 15, 20] => exactly 1 derived skip (the 5 s
    // live grid, ADAAAA-8676), floored UP by the recorded stale counter (the
    // legacy behaviour AC-2 preserves).
    const legacyLog = [
      { seq: 1, ts: "", windowTs: 0, text: "" },
      { seq: 2, ts: "", windowTs: 5, text: "" },
      { seq: 3, ts: "", windowTs: 15, text: "" },
      { seq: 4, ts: "", windowTs: 20, text: "" },
    ];
    const p = deriveLiveProgress({
      job: terminalJob({ summaryLog: legacyLog, observeMetrics: { skippedStaleWindows: 4 } }),
      nowMs: T0 + 600_000,
    });
    expect(skippedWindowsFromSummaryLog(legacyLog as any)).toBe(1);
    expect(p.skippedWindows).toBe(4);
  });
});

describe("liveSupplySkippedWindows helper (ADAAAA-8636 AC-1)", () => {
  it("returns null when no counter is supplied, so the field is absent not fabricated", () => {
    expect(liveSupplySkippedWindows(undefined)).toBeNull();
    expect(liveSupplySkippedWindows(null)).toBeNull();
    expect(liveSupplySkippedWindows({})).toBeNull();
    expect(liveSupplySkippedWindows({ skippedStaleWindows: undefined })).toBeNull();
  });

  it("sums present counters and ignores negatives / non-finite values", () => {
    expect(liveSupplySkippedWindows({ skippedStaleWindows: 2 })).toBe(2);
    expect(liveSupplySkippedWindows({ skippedStaleWindows: 2, admissionSkippedWindows: 1 })).toBe(3);
    expect(
      liveSupplySkippedWindows({
        skippedStaleWindows: -4 as number,
        admissionSkippedWindows: Number.NaN,
        backpressureSkippedWindows: 2,
      })
    ).toBe(2);
  });
});

describe("the rail exposes the same supply counters it publishes at share end (AC-4)", () => {
  it("liveSupplyEvidence() reads the counters already kept for observeMetrics", () => {
    const ts0 = Date.now() / 1000;
    const rail = new MediaRailObserver({
      jobId: "job-8636-rail",
      fps: 3,
      contentFps: 1,
      windowS: 7,
      cadenceS: 5,
      maxFrames: 4,
      onDecide: async () => false,
    });
    const live = rail.liveSupplyEvidence();
    expect(live).toEqual({
      skippedStaleWindows: 0,
      admissionSkippedWindows: 0,
      backpressureSkippedWindows: 0,
    });
    // The mid-share triple is the SAME evidence the terminal snapshot carries:
    // the accessor adds no meter, no decide call, no stored field.
    const published = rail.observeMetrics();
    expect(live.skippedStaleWindows).toBe(published.skippedStaleWindows);
    expect(live.admissionSkippedWindows).toBe(published.admissionSkippedWindows);
    expect(live.backpressureSkippedWindows).toBe(published.backpressureSkippedWindows);
    // Fed a frame, the accessor still reflects the live counter state.
    rail.onObservation(
      { timestamp: ts0, tracks: [], objects: [], ocr: [] } as any,
      Buffer.from("jpeg-8636").toString("base64")
    );
    expect(rail.liveSupplyEvidence().skippedStaleWindows).toBe(rail.observeMetrics().skippedStaleWindows);
  });
});
