// ADAAAA-8395 (LFR-1 AC-5): the perceive ROI-pass fire counter on the job record.
//
// The LFR-1 640:360 cell could not grade its ROI-pass clause (AC-5) because no
// rail published a fire count: `observeMetrics.perceive` carried
// `framesAnalyzed` and friends but nothing said how often the bounded cropped
// second pass (ADAAAA-6395) actually fired. This file pins the instrument:
//
//   1. a rail fed ROI-reporting observations publishes `roiPasses` / `roiTiles` /
//      `roiEnabled` / `roiPassesPerAnalysedFrame` beside the existing keys;
//   2. `roiPasses <= framesAnalyzed` on every shape, including a strided rail
//      (only CONSUMED frames count) and evidence-only relays;
//   3. a relay that does NOT report the pass publishes nothing new — the
//      perceive block stays byte-identical to today (no invented zero);
//   4. the derived rate is fires per ANALYSED frame, and every pre-existing key
//      keeps its meaning.
import { describe, it, expect } from "vitest";
import { MediaRailObserver } from "../src/media-rail";

function rail(opts: { jobId?: string; contentFps?: number } = {}) {
  return new MediaRailObserver({
    jobId: opts.jobId ?? "job-8395-rail",
    fps: 3,
    ...(opts.contentFps !== undefined ? { contentFps: opts.contentFps } : {}),
    windowS: 7,
    cadenceS: 5,
    maxFrames: 4,
    onDecide: async () => false,
  });
}

/** Relay `n` observations at 1 per second; `roi(i)` decides what each one
 *  reports (undefined = the field is absent, i.e. a pre-instrument runner). */
function feed(
  r: MediaRailObserver,
  n: number,
  roi: (i: number) => { roiPasses?: number; roiTiles?: number; roiEnabled?: boolean } | undefined
) {
  const T0 = Date.now() / 1000;
  for (let i = 0; i < n; i++) {
    const extra = roi(i) ?? {};
    r.onObservation(
      { timestamp: T0 + i, tracks: [], objects: [], ocr: [], ...extra } as any,
      Buffer.from(`jpeg-${i}`).toString("base64")
    );
  }
}

describe("perceive ROI-pass counter lands on the job record (ADAAAA-8395 AC-5)", () => {
  it("publishes roiPasses / roiTiles / roiEnabled beside framesAnalyzed", () => {
    const r = rail();
    feed(r, 10, (i) => ({ roiPasses: i % 2 === 0 ? 1 : 0, roiTiles: i % 2 === 0 ? 4 : 0, roiEnabled: true }));
    const perceive = r.observeMetrics().perceive!;
    expect(perceive.framesAnalyzed).toBe(10);
    expect(perceive.roiPasses).toBe(5);
    expect(perceive.roiTiles).toBe(20);
    expect(perceive.roiEnabled).toBe(true);
    expect(perceive.roiPassesPerAnalysedFrame).toBe(0.5);
    // the pre-existing keys keep their meaning
    expect(perceive.framesSeen).toBe(10);
    expect(perceive.framesStrided).toBe(0);
    expect(perceive.perceiveCalls).toBe(10);
    expect(perceive.analysisFps).toBe(0);
  });

  it("never exceeds framesAnalyzed — a strided rail only counts consumed frames", () => {
    const r = rail({ contentFps: 1 });
    // every relayed frame's runner fired the pass, but the rail consumes 1/s
    feed(r, 30, () => ({ roiPasses: 1, roiTiles: 2, roiEnabled: true }));
    const perceive = r.observeMetrics().perceive!;
    expect(perceive.framesSeen).toBe(30);
    expect(perceive.framesAnalyzed).toBe(30);
    expect(perceive.framesStrided).toBe(0); // 1 relay/s at 1 content fps
    expect(perceive.roiPasses).toBe(30);
    expect(perceive.roiPasses).toBeLessThanOrEqual(perceive.framesAnalyzed!);

    // now relay twice as fast: half the frames are strided, so at most one fire
    // per consumed frame can be counted
    const fast = rail({ contentFps: 1 });
    const T0 = Date.now() / 1000;
    for (let i = 0; i < 30; i++) {
      fast.onObservation(
        {
          timestamp: T0 + i * 0.5,
          tracks: [],
          objects: [],
          ocr: [],
          roiPasses: 1,
          roiTiles: 3,
          roiEnabled: true,
        } as any,
        Buffer.from(`jpeg-${i}`).toString("base64")
      );
    }
    const p2 = fast.observeMetrics().perceive!;
    expect(p2.framesStrided).toBeGreaterThan(0);
    expect(p2.roiPasses).toBeLessThanOrEqual(p2.framesAnalyzed!);
    expect(p2.roiTiles).toBe(p2.roiPasses! * 3);
  });

  it("counts nothing for evidence-only relays (no pixels, no analyse)", () => {
    const r = rail();
    const T0 = Date.now() / 1000;
    // one real analysed frame, then three evidence-only relays that claim fires
    r.onObservation(
      { timestamp: T0, tracks: [], objects: [], ocr: [], roiPasses: 1, roiTiles: 2, roiEnabled: true } as any,
      Buffer.from("jpeg").toString("base64")
    );
    for (let i = 1; i <= 3; i++) {
      r.onObservation(
        { timestamp: T0 + i, tracks: [], objects: [], ocr: [], roiPasses: 5, roiTiles: 99 } as any,
        undefined
      );
    }
    const perceive = r.observeMetrics().perceive!;
    expect(perceive.framesAnalyzed).toBe(1);
    expect(perceive.roiPasses).toBe(1);
    expect(perceive.roiTiles).toBe(2);
  });

  it("publishes nothing when the relay does not report the pass (no invented zero)", () => {
    // A stride-less rail whose relay reports no ROI field publishes no perceive
    // block at all — exactly today's record.
    const r = rail();
    feed(r, 8, () => undefined);
    expect(r.observeMetrics().perceive).toBeUndefined();

    // And WITH a stride the block is published but carries no ROI key, so an
    // older media node/perceive pair stays byte-identical.
    const strided = rail({ contentFps: 1 });
    feed(strided, 8, () => undefined);
    const perceive = strided.observeMetrics().perceive!;
    expect(perceive.framesAnalyzed).toBe(8);
    expect("roiPasses" in perceive).toBe(false);
    expect("roiTiles" in perceive).toBe(false);
    expect("roiEnabled" in perceive).toBe(false);
    expect("roiPassesPerAnalysedFrame" in perceive).toBe(false);
  });

  it("reports roiEnabled=false honestly when the pass is armed off", () => {
    const r = rail();
    feed(r, 5, () => ({ roiPasses: 0, roiTiles: 0, roiEnabled: false }));
    const perceive = r.observeMetrics().perceive!;
    expect(perceive.roiPasses).toBe(0);
    expect(perceive.roiEnabled).toBe(false);
    expect(perceive.roiPassesPerAnalysedFrame).toBe(0);
  });

  it("persists on a stored job row (observeMetrics.perceive.roiPasses non-null)", async () => {
    // IN-3: the block must survive a round trip through the job record, which is
    // how the live routes persist `observeMetrics`.
    const { SqliteDb } = await import("../src/db");
    const db = new SqliteDb(":memory:");
    const r = rail();
    feed(r, 12, (i) => ({ roiPasses: i % 3 === 0 ? 1 : 0, roiTiles: i % 3 === 0 ? 4 : 0, roiEnabled: true }));
    const observeMetrics = r.observeMetrics();
    await db.saveJob({
      id: "job-8395-roi",
      ownerId: null,
      status: "done",
      createdAt: new Date().toISOString(),
      observeMetrics,
    } as any);
    const stored = await db.getJob("job-8395-roi");
    const perceive = (stored as any).observeMetrics.perceive;
    expect(perceive.roiPasses).toBe(4);
    expect(perceive.roiPasses).not.toBeNull();
    expect(perceive.roiPasses).toBeLessThanOrEqual(perceive.framesAnalyzed!);
    expect(perceive.roiTiles).toBe(16);
    expect(perceive.roiEnabled).toBe(true);
  });
});
