import { describe, it, expect } from "vitest";
import { deriveLiveProgress, type LiveProgressInput } from "../src/live-progress";

// ADAAAA-8121: the live analyse-position indicator's server half.
//
// The indicator is a READ of fields ADAAAA-8102 already publishes — the consume
// block (`observeMetrics.perceive`) and, while in flight, the rail's own consume
// clock / stored observation timestamps. These tests pin:
//   AC-1  the position is the newest ANALYSED content instant (never a count,
//         never the wall clock),
//   AC-2  the delay is `liveEdgeTs - analysedPositionTs` on the CONTENT clock, so
//         a 1 fps -> 2 fps consume-rate change leaves the number alone,
//   AC-3  strided frames surface as a COUNT only and never move the position,
//   AC-4  no position is invented when nothing has been analysed,
//   AC-6  a record with no `perceive` block degrades to "no stride data".
//
// The recorded shapes below are the ones measured on stored job `7a8b15a6`
// (live file-sim, contentFps 1, 1063 seen / 355 analysed / 708 strided).

const T0 = Date.parse("2026-11-06T16:40:00.000Z");

function liveJob(over: Partial<LiveProgressInput["job"]> = {}): LiveProgressInput["job"] {
  return {
    status: "active",
    source: "browser",
    startedAt: new Date(T0).toISOString(),
    createdAt: new Date(T0).toISOString(),
    summaryLog: [
      { seq: 1, ts: new Date(T0 + 40_000).toISOString(), windowTs: 30, text: "w1" },
      { seq: 2, ts: new Date(T0 + 70_000).toISOString(), windowTs: 60, text: "w2" },
    ],
    ...over,
  };
}

/** The measured consume block of stored job `7a8b15a6`. */
const PERCEIVE_1FPS = {
  framesSeen: 1063,
  framesAnalyzed: 355,
  framesStrided: 708,
  analysisFps: 1,
  analysedThroughTs: 214.5,
  tapThroughTs: 222,
};

describe("deriveLiveProgress analyse position (ADAAAA-8121)", () => {
  it("names the newest ANALYSED content instant from the rail clock (AC-1)", () => {
    const p = deriveLiveProgress({ job: liveJob(), newestObservationTs: 214.5, nowMs: T0 + 222_000 });
    expect(p.analysedPositionTs).toBe(214.5);
    // 222 - 214.5, both content seconds
    expect(p.analysedLagSec).toBe(7.5);
  });

  it("is the same delay at 1 fps and at 2 fps for the same content position (AC-2)", () => {
    const at1 = deriveLiveProgress({
      job: liveJob({ observeMetrics: { perceive: { ...PERCEIVE_1FPS, analysisFps: 1 } } }),
      newestObservationTs: 214.5,
      nowMs: T0 + 222_000,
    });
    // A 2 fps consume of the SAME content reaches the same position; only the
    // frame counts double. The delay must not move.
    const at2 = deriveLiveProgress({
      job: liveJob({
        observeMetrics: {
          perceive: {
            ...PERCEIVE_1FPS,
            analysisFps: 2,
            framesSeen: 1063,
            framesAnalyzed: 710,
            framesStrided: 353,
            analysedThroughTs: 214.5,
            tapThroughTs: 222,
          },
        },
      }),
      newestObservationTs: 214.5,
      nowMs: T0 + 222_000,
    });
    expect(at2.analysedPositionTs).toBe(at1.analysedPositionTs);
    expect(at2.analysedLagSec).toBe(at1.analysedLagSec);
    expect(at2.analysedLagSec).toBe(7.5);
    // lagSec (decide lag) is untouched by the consume rate as well.
    expect(at2.lagSec).toBe(at1.lagSec);
  });

  it("lists strided frames as a COUNT and never moves the position (AC-3)", () => {
    const p = deriveLiveProgress({
      job: liveJob({ observeMetrics: { perceive: PERCEIVE_1FPS } }),
      newestObservationTs: 214.5,
      nowMs: T0 + 222_000,
    });
    expect(p.strideData).toBe(true);
    expect(p.strideFramesSeen).toBe(1063);
    expect(p.strideFramesSkipped).toBe(708);
    expect(p.strideAnalysisFps).toBe(1);
    // The skipped count contributes NO position: the position is the analysed
    // instant only (708 skipped frames would otherwise read as ~708 content s).
    expect(p.analysedPositionTs).toBe(214.5);
    expect(p.analysedPositionTs).toBeLessThanOrEqual(p.liveEdgeTs);
  });

  it("uses the persisted consume clock on a stored record with no observation set (AC-6)", () => {
    // A stored/terminal-shape record: the in-memory observation window is gone,
    // but the rail persisted where it got to.
    const p = deriveLiveProgress({
      job: liveJob({ observeMetrics: { perceive: PERCEIVE_1FPS } }),
      newestObservationTs: 0,
      nowMs: T0 + 222_000,
    });
    expect(p.analysedPositionTs).toBe(214.5);
    expect(p.analysedLagSec).toBe(7.5);
  });

  it("degrades to 'no stride data' when the knob was unset on the run (AC-6)", () => {
    const p = deriveLiveProgress({
      job: liveJob({ observeMetrics: { skippedStaleWindows: 0 } }),
      newestObservationTs: 214.5,
      nowMs: T0 + 222_000,
    });
    expect(p.strideData).toBe(false);
    expect(p.strideFramesSkipped).toBeUndefined();
    expect(p.strideAnalysisFps).toBeUndefined();
  });

  it("invents no position when nothing has been analysed yet (AC-4)", () => {
    const p = deriveLiveProgress({ job: liveJob({ summaryLog: [] }), newestObservationTs: 0, nowMs: T0 + 4_000 });
    expect(p.analysedPositionTs).toBeUndefined();
    expect(p.analysedLagSec).toBeUndefined();
    expect(p.state).toBe("unknown");
  });

  it("keeps the position and delay content-clock clamped, never negative", () => {
    // A clock skew that puts the analysed frame AHEAD of the computed edge must
    // read 0, not a negative "behind live".
    const p = deriveLiveProgress({
      job: liveJob({
        observeMetrics: { perceive: { ...PERCEIVE_1FPS, analysedThroughTs: 300, tapThroughTs: undefined } },
      }),
      newestObservationTs: 0,
      nowMs: T0 + 120_000,
    });
    expect(p.analysedLagSec).toBe(0);
    expect(p.analysedLagSec).toBeGreaterThanOrEqual(0);
  });

  it("never re-exports the internal observe block besides the positions/counts", () => {
    const p = deriveLiveProgress({
      job: liveJob({ observeMetrics: { perceive: { ...PERCEIVE_1FPS, framesSeen: 1063 } } }),
      newestObservationTs: 214.5,
      nowMs: T0 + 222_000,
    });
    expect(p).not.toHaveProperty("observeMetrics");
    expect(p).not.toHaveProperty("costUsd");
    expect(Object.keys(p).sort()).toEqual(
      [
        "analysedLagSec",
        "analysedPositionTs",
        "lagSec",
        "liveEdgeTs",
        "processedThroughTs",
        "skippedWindows",
        "state",
        "strideAnalysisFps",
        "strideData",
        "strideFramesSeen",
        "strideFramesSkipped",
        "updatedAt",
      ].sort()
    );
  });
});
