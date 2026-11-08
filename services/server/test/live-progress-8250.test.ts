// ADAAAA-8250 (follow-up to ADAAAA-8121 AC-3): the analyse-position chip's
// stride count for a share that is STILL RUNNING.
//
// The gap: the media rail publishes `observeMetrics.perceive` only at share end,
// and the chip hides itself once a job is terminal. An in-flight share therefore
// read `no stride data` for its whole duration — the `...frames skipped (stride
// 1 fps)` text was unreachable on a live viewer, even though the rail was
// counting the frames all along. Nothing was wrong with the position; only the
// count was invisible.
//
// The fix reads the SAME counters mid-share (`MediaRailObserver.liveConsumeEvidence`)
// and hands them to `deriveLiveProgress` through `liveConsume`. These tests pin:
//   AC-1  an in-flight share names the live count (no stored `perceive` block),
//   AC-2  a strided frame still never becomes a position (8121 AC-3),
//   AC-3  no decide/perceive call is added — the block is the rail's own counters,
//   AC-4  a terminal job ignores the live block and keeps hiding the chip.
import { describe, it, expect } from "vitest";
import { deriveLiveProgress, type LiveProgressInput } from "../src/live-progress";
import { MediaRailObserver, SKIPPED_FRAME_TS_RING_CAP } from "../src/media-rail";

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

/** The rail's live block 60 s into a 1 fps share: 180 frames offered, 60
 *  analysed, 120 skipped — the shape ADAAAA-8102 measured on job `7a8b15a6`. */
const LIVE_CONSUME_60S = {
  framesSeen: 180,
  framesAnalyzed: 60,
  framesStrided: 120,
  analysisFps: 1,
  analysedThroughTs: 60.5,
  tapThroughTs: 64.5,
};

describe("live stride count on an in-flight share (ADAAAA-8250)", () => {
  it("names the live count while the share is in flight (AC-1)", () => {
    // No `observeMetrics` at all: this is the state a real in-flight share is in
    // (the record's perceive block is written at completion only).
    const p = deriveLiveProgress({
      job: liveJob(),
      newestObservationTs: 60.5,
      liveConsume: LIVE_CONSUME_60S,
      nowMs: T0 + 64_500,
    });
    expect(p.state).not.toBe("unknown"); // the chip renders at all
    expect(p.strideData).toBe(true);
    expect(p.strideFramesSeen).toBe(180);
    expect(p.strideFramesSkipped).toBe(120);
    expect(p.strideAnalysisFps).toBe(1);
    // The position is still the ANALYSED instant from the live consume clock.
    expect(p.analysedPositionTs).toBe(60.5);
  });

  it("tracks the counters as the share advances, without a 'no stride data' flake (AC-1)", () => {
    const early = deriveLiveProgress({
      job: liveJob(),
      newestObservationTs: 12.5,
      liveConsume: { ...LIVE_CONSUME_60S, framesSeen: 39, framesAnalyzed: 13, framesStrided: 26, analysedThroughTs: 12.5, tapThroughTs: 13.5 },
      nowMs: T0 + 13_500,
    });
    const later = deriveLiveProgress({
      job: liveJob(),
      newestObservationTs: 60.5,
      liveConsume: LIVE_CONSUME_60S,
      nowMs: T0 + 64_500,
    });
    expect(early.strideData).toBe(true);
    expect(later.strideData).toBe(true);
    expect(later.strideFramesSeen).toBeGreaterThan(early.strideFramesSeen!);
    expect(later.strideFramesSkipped).toBeGreaterThan(early.strideFramesSkipped!);
    expect(later.analysedPositionTs).toBeGreaterThan(early.analysedPositionTs!);
  });

  it("never derives a position from a strided frame (AC-2, 8121 AC-3)", () => {
    // The tap is 4 s ahead of the analysed position and 120 frames were skipped:
    // neither the skipped count nor the tap clock may move the position.
    const p = deriveLiveProgress({
      job: liveJob(),
      newestObservationTs: 60.5,
      liveConsume: LIVE_CONSUME_60S,
      nowMs: T0 + 64_500,
    });
    expect(p.analysedPositionTs).toBe(60.5);
    expect(p.analysedPositionTs).toBeLessThan(p.liveEdgeTs);
    // 120 skipped frames at 1 fps would read as 120 content s if the count were
    // ever treated as content.
    expect(p.analysedPositionTs).not.toBe(60.5 + 120);
    expect(p.analysedLagSec).toBe(4);
  });

  it("ignores the live block on a terminal job so the chip stays hidden (AC-4)", () => {
    const p = deriveLiveProgress({
      job: liveJob({ status: "done", finishedAt: new Date(T0 + 70_000).toISOString() }),
      newestObservationTs: 0,
      liveConsume: LIVE_CONSUME_60S,
      nowMs: T0 + 200_000,
    });
    expect(p.state).toBe("unknown");
    expect(p.strideData).toBe(false);
    expect(p.strideFramesSkipped).toBeUndefined();
  });

  it("keeps 'no stride data' honest when the rail runs no stride (AC-4)", () => {
    // `liveConsumeEvidence()` returns null when no content rate is configured —
    // the accessor's own contract, asserted again here at the read shape.
    const p = deriveLiveProgress({
      job: liveJob({ observeMetrics: null }),
      newestObservationTs: 60.5,
      liveConsume: null,
      nowMs: T0 + 64_500,
    });
    expect(p.strideData).toBe(false);
    expect(p.strideFramesSkipped).toBeUndefined();
  });

  it("reads the counters the rail already keeps — no new meter (AC-3)", () => {
    // 3 relayed observations 0.5 s apart at a 1 fps content rate: the first and
    // third are consumed, the second is strided.
    const ts0 = Date.now() / 1000;
    const rail = new MediaRailObserver({
      jobId: "job-8250-rail",
      fps: 3,
      contentFps: 1,
      windowS: 7,
      cadenceS: 5,
      maxFrames: 4,
      onDecide: async () => false,
    });
    for (let i = 0; i < 3; i++) {
      rail.onObservation(
        { timestamp: ts0 + i * 0.5, tracks: [], objects: [], ocr: [] } as any,
        Buffer.from(`jpeg-${i}`).toString("base64")
      );
    }
    const live = rail.liveConsumeEvidence();
    expect(live).not.toBeNull();
    expect(live!.framesSeen).toBe(3);
    expect(live!.framesStrided).toBe(1);
    expect(live!.framesAnalyzed).toBe(2);
    expect(live!.analysisFps).toBe(1);
    // The mid-share block is the SAME evidence the terminal snapshot publishes —
    // the accessor adds no counter the record did not already carry.
    const published = rail.observeMetrics().perceive!;
    expect(live!.framesSeen).toBe(published.framesSeen);
    expect(live!.framesStrided).toBe(published.framesStrided);
    expect(live!.framesAnalyzed).toBe(published.framesAnalyzed);
    expect(live!.analysisFps).toBe(published.analysisFps);
    expect(live!.analysedThroughTs).toBe(published.analysedThroughTs);
    expect(live!.tapThroughTs).toBe(published.tapThroughTs);

    // No content rate => no stride ran => no block, and the chip degrades to
    // "no stride data" rather than inventing zeros.
    const unset = new MediaRailObserver({ jobId: "job-8250-rail-unset", fps: 3, onDecide: async () => false });
    unset.onObservation({ timestamp: ts0, tracks: [], objects: [], ocr: [] } as any, Buffer.from("jpg").toString("base64"));
    expect(unset.liveConsumeEvidence()).toBeNull();
  });

  it("keeps a bounded ring of skipped content ts for the window audit (ADAAAA-8419)", () => {
    const ts0 = Date.now() / 1000;
    const rail = new MediaRailObserver({
      jobId: "job-8419-rail",
      fps: 100,
      contentFps: 1,
      windowS: 7,
      cadenceS: 5,
      maxFrames: 4,
      onDecide: async () => false,
    });
    // 300 relayed frames 10 ms apart (3 content seconds) at a 1 fps content rate:
    // ~3 are consumed, the rest are refused by the consume gate.
    for (let i = 0; i < 300; i++) {
      rail.onObservation(
        { timestamp: ts0 + i * 0.01, tracks: [], objects: [], ocr: [] } as any,
        Buffer.from(`jpeg-${i}`).toString("base64")
      );
    }
    const live = rail.liveConsumeEvidence()!;
    const skipped = live.skippedTimestamps!;
    expect(live.framesStrided).toBeGreaterThan(200);
    // Bounded ring, newest wins, ascending.
    expect(skipped).toHaveLength(SKIPPED_FRAME_TS_RING_CAP);
    expect(skipped[0]).toBeLessThan(skipped[skipped.length - 1]);
    // The ring is evidence, not a position: the analysed clock stays on consumed
    // frames only, so it can never be dragged forward by a skipped timestamp.
    expect(live.analysedThroughTs!).toBeLessThan(live.tapThroughTs!);
    expect(live.skippedTimestamps).not.toBe(rail.liveConsumeEvidence()!.skippedTimestamps);
  });
});
