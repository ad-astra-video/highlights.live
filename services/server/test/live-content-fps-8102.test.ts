// ADAAAA-8102 (parent ADAAAA-8101): LIVE CONTENT consumes at 1 fps on BOTH live
// rails — knob reach, audit stamp, and the stride evidence a funded leg grades.
//
// The measured defect: `LIVE_OBSERVE_CONTENT_FPS` reached the analyzer live pass
// but NOT the shipped media/RTC rail, which constructed its `MediaRailObserver`
// with `fps: railFps` (the ingest `sampleFps`) and no content rate at all. Job
// `8024a341` therefore analysed 833 frames / 300 s (2.78 fps) with
// `LIVE_OBSERVE_MAX_FRAMES=4` boot-verified, and `observeMetrics.perceive` was
// absent on that rail by construction — the rate could only be read off
// `printenv`. At a measured ~0.36 s of blocking `client.analyze` per frame that
// is ~100 % of wall clock in perceive before a decide runs, which is the "cannot
// keep up with realtime" the board saw on a real share.
//
// Step 1 (this file) pins the five clauses that must hold WITHOUT moving a
// running box:
//   1. ONE knob drives both rails; unset/empty cannot collapse it to a 0 fps
//      stride (ADAAAA-7808 empty-means-unset guard).
//   2. The media rail consumes at the CONTENT rate while `sampleFps` stays the
//      ingest clock (~300 consumed frames / 300 s at 1 fps, not ~833).
//   3. The media rail publishes `observeMetrics.perceive`, so the leg grades the
//      rate from the job record.
//   4. Every live payload stamps `contentFps` next to `spanSec`/`cadenceMs`, the
//      value `decide_audit` copies (§`render_perceive_timeline` passthrough).
//   5. Unset (the shipped default) leaves both rails byte-identical: the media
//      rail consumes every relayed frame and publishes no stride block.
import { describe, it, expect } from "vitest";
import { buildLiveAnalyzerConfig } from "../src/api";
import { MediaRailObserver } from "../src/media-rail";
import { LiveRunShared, buildObserveDecideRequest } from "../src/analyzer";
import { assembleLiveWindow, buildObservePayload } from "../src/observe-loop";
import { loadConfig } from "../src/config";

const BASE_ENV = { PERCEIVE_URL: "http://p", DECIDE_URL: "http://d", LIVE_OBSERVE_LOOP: "1" };
const cfgFor = (overrides: Record<string, string> = {}) => loadConfig({ ...BASE_ENV, ...overrides });
const analyzerFor = (overrides: Record<string, string> = {}) =>
  buildLiveAnalyzerConfig({
    cfg: cfgFor(overrides),
    job: { id: "job-8102", gameHint: "soccer" } as any,
    clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 } as any,
  });

/** Relay a share's worth of media-node observations at the funded ingest clock
 *  (2.78 fps = the measured 833 frames / 300 s) and hand back the rail. */
function feedMediaRail(opts: { contentFps?: number; ingestFps?: number; seconds?: number }) {
  const ingestFps = opts.ingestFps ?? 2.78;
  const seconds = opts.seconds ?? 300;
  const T0 = Date.now() / 1000;
  const decided: any[] = [];
  const rail = new MediaRailObserver({
    jobId: "job-8102-rail",
    fps: 3, // the ingest clock the shipped rail passes (job.sampleFps)
    ...(opts.contentFps !== undefined ? { contentFps: opts.contentFps } : {}),
    windowS: 7,
    cadenceS: 5,
    maxFrames: 4,
    onDecide: async (payload) => {
      decided.push(payload);
      return false;
    },
  });
  const n = Math.floor(seconds * ingestFps);
  for (let i = 0; i < n; i++) {
    rail.onObservation(
      { timestamp: T0 + i / ingestFps, tracks: [], objects: [], ocr: [] } as any,
      Buffer.from(`jpeg-${i}`).toString("base64")
    );
  }
  return { rail, ingestFrames: n, decided };
}

describe("LIVE_OBSERVE_CONTENT_FPS reaches both rails (ADAAAA-8102 AC-8101-1)", () => {
  it("one knob drives the analyzer pass and the media rail", () => {
    expect(analyzerFor({ LIVE_OBSERVE_CONTENT_FPS: "1" }).liveObserveContentFps).toBe(1);
    // The media rail is handed the SAME resolved value (api.ts passes
    // `cfg.liveObserveContentFps`), and its consume rate is that value.
    const { rail } = feedMediaRail({ contentFps: 1, seconds: 1, ingestFps: 2.78 });
    expect(rail.observeMetrics().perceive?.analysisFps).toBe(1);
  });

  it("unset keeps the default 2 fps and never collapses it", () => {
    expect(cfgFor().liveObserveContentFps).toBeUndefined();
    expect(analyzerFor().liveObserveContentFps).toBeUndefined();
    // compose passes `${LIVE_OBSERVE_CONTENT_FPS:-}`, i.e. an EMPTY string, and
    // `Number("")` is 0 — a 0 fps stride would starve every decide window.
    expect(cfgFor({ LIVE_OBSERVE_CONTENT_FPS: "" }).liveObserveContentFps).toBeUndefined();
    expect(cfgFor({ LIVE_OBSERVE_CONTENT_FPS: "   " }).liveObserveContentFps).toBeUndefined();
    expect(cfgFor({ LIVE_OBSERVE_CONTENT_FPS: "not-a-number" }).liveObserveContentFps).toBeUndefined();
    // An explicit 0 keeps its DOCUMENTED meaning (stride off), it is not silently
    // rewritten to the default either.
    expect(cfgFor({ LIVE_OBSERVE_CONTENT_FPS: "0" }).liveObserveContentFps).toBe(0);
  });

  it("the unset payload still states the resolved 2 fps rate", () => {
    const analyzer = analyzerFor();
    const win = assembleLiveWindow(
      [{ ts: 1000, imageB64: "a" }, { ts: 1000.5, imageB64: "b" }],
      1000,
      { windowS: 10, maxFrames: 4, fps: 2 }
    );
    const payload = buildObservePayload(win, new Map());
    const req = buildObserveDecideRequest(analyzer, new LiveRunShared({ jobId: "job-8102" }), payload);
    expect((req.opts as any).perceiveWindow.contentFps).toBe(2);
  });
});

describe("media rail consumes at the content rate, not the ingest rate (AC-8101-2)", () => {
  it("1 fps over 300 s of 2.78 fps ingest analyses ~300 frames, not ~833", () => {
    const { rail, ingestFrames } = feedMediaRail({ contentFps: 1 });
    expect(ingestFrames).toBe(833);
    // AC-8101-2's band: [280, 320] consumed frames per 300 s. A hard floor on
    // frame spacing would read 278 here (0.36 s ingest vs a 1 s floor), which is
    // why the rail uses the analyzer pass's credit accumulator.
    expect(rail.frameCount()).toBeGreaterThanOrEqual(280);
    expect(rail.frameCount()).toBeLessThanOrEqual(320);
    // and it is a ~1/3 of the ingest, so the evidence is unambiguous
    expect(rail.frameCount()).toBeLessThan(ingestFrames / 2);
  });

  it("stays at the configured rate on a different ingest clock (2 fps)", () => {
    const { rail } = feedMediaRail({ contentFps: 1, ingestFps: 2 });
    expect(rail.frameCount()).toBeGreaterThanOrEqual(280);
    expect(rail.frameCount()).toBeLessThanOrEqual(320);
  });

  it("a BURSTY relay (fast-forward gaps) still consumes ~1 frame per content second", () => {
    // Regression source: funded leg 95622028 (300 s, 1 fps, cell 8065 applied).
    // The relay fast-forwards, so observations arrive in bursts separated by gaps
    // of up to 4.94 s (27 gaps > 2 s). With the analyzer pass's 2-frame credit cap
    // the rail silently discarded 51.6 s of content time and consumed 243 frames
    // instead of ~295 — outside AC-8101-2's 280-320 band. The media rail's credit
    // is bounded far above a relay burst instead.
    const T0 = Date.now() / 1000;
    const rail = new MediaRailObserver({
      jobId: "job-8102-bursty",
      fps: 3,
      contentFps: 1,
      windowS: 7,
      cadenceS: 5,
      maxFrames: 4,
      onDecide: async () => false,
    });
    // 2 fps ingest with a ~3.9 s fast-forward gap every 12th frame: 27 gaps over
    // 300 s, exactly the shape leg 95622028 relayed (its gaps ran to 4.94 s).
    let ts = 0;
    let n = 0;
    while (ts < 299) {
      rail.onObservation({ timestamp: T0 + ts, tracks: [], objects: [], ocr: [] } as any, "a");
      n++;
      ts += n % 12 === 0 ? 3.9 : 0.5;
    }
    // Consumed count tracks CONTENT seconds (~299), not the 2-frame-cap count
    // (which would read ~248 — the leg's 243).
    expect(rail.frameCount()).toBeGreaterThanOrEqual(280);
    expect(rail.frameCount()).toBeLessThanOrEqual(320);
    const perceive = rail.observeMetrics().perceive!;
    expect(perceive.framesSeen).toBeGreaterThan(rail.frameCount());
  });
});

describe("media rail publishes the stride block (AC-8101-1 evidence)", () => {
  it("observeMetrics.perceive proves the rate and the counts from the job record", () => {
    const { rail, ingestFrames } = feedMediaRail({ contentFps: 1 });
    const perceive = rail.observeMetrics().perceive!;
    expect(perceive.analysisFps).toBe(1);
    expect(perceive.framesSeen).toBe(ingestFrames);
    expect(perceive.framesAnalyzed).toBe(rail.frameCount());
    expect(perceive.framesStrided).toBe(perceive.framesSeen - perceive.framesAnalyzed);
    expect(perceive.framesStrided).toBeGreaterThan(0);
    // perceive runs in the media node on this rail; stated, not implied.
    expect(perceive.perceiveSource).toBe("media_node");
  });

  it("an unset knob keeps the shipped rail: every frame consumed, no stride block", () => {
    const { rail, ingestFrames } = feedMediaRail({});
    expect(rail.frameCount()).toBe(ingestFrames);
    expect(rail.observeMetrics().perceive).toBeUndefined();
  });
});

describe("contentFps is stamped on the live decide payload (AC-8101-1)", () => {
  it("a configured non-default value lands in perceiveWindow next to span/cadence", () => {
    const analyzer = analyzerFor({ LIVE_OBSERVE_CONTENT_FPS: "1", LIVE_OBSERVE_WINDOW_S: "7", LIVE_OBSERVE_CADENCE_S: "5" });
    const frames = Array.from({ length: 7 }, (_, i) => ({ ts: 1000 + i, imageB64: `f${i}` }));
    const win = assembleLiveWindow(frames, 1006, { windowS: 7, maxFrames: 4, fps: 1 });
    const payload = buildObservePayload(win, new Map());
    const req = buildObserveDecideRequest(analyzer, new LiveRunShared({ jobId: "job-8102" }), payload);
    const winBlock = (req.opts as any).perceiveWindow;
    // DecidePerceiveWindow: the ledger the decide service copies into
    // decide_audit.timings (services/decide/app/gemma.py render_perceive_timeline).
    expect(winBlock.contentFps).toBe(1);
    expect(winBlock.spanSec).toBe(7);
    expect(winBlock.cadenceMs).toBe(5000);
  });
});

describe("the timeline is the CONSUME set at a content rate (AC-8101-5 density)", () => {
  /** Relay a share the way the media node does on the funded rail: observations
   *  at the ingest clock (~2.78 fps) PLUS the batched published-frame tick clock
   *  (~3/s) that ADAAAA-8069 added for the RTC arm. */
  async function feedShare(opts: { contentFps?: number; seconds?: number; ingestFps?: number; tickFps?: number }) {
    const ingestFps = opts.ingestFps ?? 2.78;
    const tickFps = opts.tickFps ?? 3;
    const seconds = opts.seconds ?? 120;
    const T0 = Date.now() / 1000;
    const decided: any[] = [];
    const rail = new MediaRailObserver({
      jobId: "job-8102-share",
      fps: 3,
      ...(opts.contentFps !== undefined ? { contentFps: opts.contentFps } : {}),
      windowS: 7,
      cadenceS: 5,
      maxFrames: 4,
      onDecide: async (payload) => {
        decided.push(payload);
        return false;
      },
    });
    const ingestN = Math.floor(seconds * ingestFps);
    const tickN = Math.floor(seconds * tickFps);
    // Interleave both clocks in timestamp order, the way the two callbacks land.
    let i = 0;
    let j = 0;
    while (i < ingestN || j < tickN) {
      const obsTs = T0 + i / ingestFps;
      const tickTs = T0 + j / tickFps;
      if (i < ingestN && (j >= tickN || obsTs <= tickTs)) {
        rail.onObservation({ timestamp: obsTs, tracks: [], objects: [], ocr: [] } as any, "a");
        i++;
      } else {
        rail.onFrameTick(tickTs);
        j++;
      }
      // The rail decides on an async serial chain; yield so the window is
      // assembled while the frame buffer still holds this moment (a tight feed
      // loop would let the observer trim to the last ~10 s before the chain
      // reached the first window — a harness artifact, not rail behaviour).
      await new Promise((r) => setImmediate(r));
    }
    return { rail, ingestN, tickN, decided };
  }

  it("reads 7-9 records per 7 s span — one record per content second, not the tick clock", async () => {
    const { rail, decided } = await feedShare({ contentFps: 1, seconds: 120 });
    await rail.finish();
    expect(decided.length).toBeGreaterThanOrEqual(20);
    const perSpan = decided.map((p: any) => (p.observations ?? []).length);
    // Funded leg 977294d7 read ~20 records/span because the published clock and
    // the consumed frames were both in the set. The consume set is ~1/s.
    // Window 0 is the bootstrap fire and window 1 is the first span truncated by
    // the stream start; every steady-state span reads 7-8 records.
    const steady = decided.slice(2);
    expect(steady.length).toBeGreaterThanOrEqual(15);
    for (const p of steady) {
      const records = (p.observations ?? []).length;
      expect(records).toBeGreaterThanOrEqual(7);
      expect(records).toBeLessThanOrEqual(9);
      expect(p.frames.length).toBeLessThanOrEqual(4);
      // records still exceed the image budget (the clause AC-8101-5 grades)
      expect(records).toBeGreaterThan(p.frames.length);
    }
    // The tick clock kept running (the clip clock), it just left the timeline.
    expect(rail.stats().frameTicks).toBeGreaterThan(rail.frameCount());
  });

  it("unset keeps ADAAAA-8069: the published tick clock IS the observation set", async () => {
    const { rail, decided } = await feedShare({ seconds: 60 });
    await rail.finish();
    expect(decided.length).toBeGreaterThanOrEqual(8);
    // No content rate: every relayed frame is consumed and every tick is an
    // observation, so each span carries the ~3/s published clock.
    const perSpan = decided.map((p: any) => (p.observations ?? []).length);
    // Unset: both clocks join the set (the published tick ~3/s AND every relayed
    // frame), so a steady span carries ~40 records — the 1 fps cell above reads
    // 7-8 on the same feed, which is the difference the change makes.
    expect(Math.min(...perSpan.slice(1))).toBeGreaterThanOrEqual(30);
  });
});

describe("the boot readout names the content consume rate (ADAAAA-8102 Step 4)", () => {
  it("names the resolved rate on both the default and the 1 fps posture", async () => {
    const { liveDecideBootLines } = await import("../src/live-decide-posture");
    expect(liveDecideBootLines(cfgFor({})).join("\n")).toContain("live content consume: 2 fps");
    expect(liveDecideBootLines(cfgFor({ LIVE_OBSERVE_CONTENT_FPS: "1" })).join("\n")).toContain(
      "live content consume: 1 fps"
    );
    // compose's `${X:-}` empty string must not print a 0 fps posture.
    expect(liveDecideBootLines(cfgFor({ LIVE_OBSERVE_CONTENT_FPS: "" })).join("\n")).toContain(
      "live content consume: 2 fps"
    );
  });
});

describe("a post-gap credit burst cannot stack timeline records (leg b8fb4aa4, AC-8101-5)", () => {
  /** The funded 1 fps leg (`b8fb4aa4`) read 10 records in three gap-free 7 s
   *  spans: the relay fast-forwards across a 4.5-4.7 s gap, the stride then
   *  spends banked credit in a burst, and every consumed frame joined the timed
   *  observation set — so two seconds of records landed inside one content
   *  second. The burst must still be ANALYSED; only the record set is bucketed. */
  it("takes one record per content second while still consuming the burst", async () => {
    const T0 = Date.now() / 1000;
    const decided: any[] = [];
    const rail = new MediaRailObserver({
      jobId: "job-8102-burst",
      fps: 3,
      contentFps: 1,
      windowS: 7,
      cadenceS: 5,
      maxFrames: 4,
      onDecide: async (payload) => {
        decided.push(payload);
        return false;
      },
    });
    const ts: number[] = [];
    for (let t = 0; t < 20; t += 1 / 2.6) ts.push(T0 + t);
    const gapEnd = 24.6;
    // the relay's fast-forward: three frames delivered inside 0.2 s after a gap
    ts.push(T0 + gapEnd + 0.02, T0 + gapEnd + 0.09, T0 + gapEnd + 0.17);
    for (let t = gapEnd + 1; t < 40; t += 1 / 2.6) ts.push(T0 + t);
    for (const t of ts) {
      rail.onObservation({ timestamp: t, tracks: [], objects: [], ocr: [] } as any, "a");
      await new Promise((r) => setImmediate(r));
    }
    await rail.finish();

    const perSpan = decided.slice(2).map((p: any) => (p.observations ?? []).length);
    expect(perSpan.length).toBeGreaterThanOrEqual(3);
    // The clause: 7-9 records at a 7 s span, never a burst-inflated 10.
    expect(Math.max(...perSpan)).toBeLessThanOrEqual(9);
    // One record per content second, whatever the ingest did inside it: no two
    // records may share a content second INSIDE one window (windows overlap, so
    // the same record legitimately appears in consecutive spans).
    for (const p of decided) {
      const buckets = (p.observations ?? []).map((o: any) => Math.floor(Number(o.ts)));
      for (let i = 1; i < buckets.length; i++) {
        expect(buckets[i]).toBeGreaterThan(buckets[i - 1]);
      }
    }
    // The burst frames were still analysed (consumption is NOT throttled).
    expect(rail.stats().frames).toBeGreaterThanOrEqual(38);
  });
});
