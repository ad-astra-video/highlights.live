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
