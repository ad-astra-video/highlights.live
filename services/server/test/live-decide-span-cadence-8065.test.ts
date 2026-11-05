// ADAAAA-8065 (rev 7): the decide WINDOW SPAN and CADENCE must be configurable,
// named at boot, and STAMPED on the payload.
//
// Rev 7's cell is "7 s of frames run every 5 s" (R18). Before this ticket the
// span was a hard constant (`LIVE_OBSERVE_WINDOW_S` = 10 in observe-loop.ts with
// no env read) and the media rail — the rail the funded legs run on — never read
// the cadence knob at all, so a configured cell measured on that rail would have
// been a no-op. That is the ADAAAA-8074 class: a value one rail reads while the
// shipped rail keeps the default, and nothing on the audit row says which value
// ran.
//
// These tests pin the three clauses of Step 1:
//   1. ONE live span knob (`LIVE_OBSERVE_WINDOW_S`) + the existing cadence knob
//      (`LIVE_OBSERVE_CADENCE_S`), both defaulting to today's 10 s / 3 s so
//      merging changes nothing on a running box.
//   2. Both live rails (analyzer pass + media rail) read those knobs.
//   3. Every live payload states `spanSec` + `cadenceMs` — a non-default
//      configured cell is what the audit row carries.
import { describe, it, expect } from "vitest";
import { assembleLiveWindow, buildObservePayload } from "../src/observe-loop";
import { LiveRunShared, buildObserveDecideRequest } from "../src/analyzer";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";
import { liveDecideBootLines } from "../src/live-decide-posture";

const T0 = 1_000;

/** A funded-density delivery (~2.8 fps) inside the trailing window. */
function fundedFrames(nowTs: number, spanS: number, fps = 2.8): { ts: number; imageB64: string }[] {
  const out: { ts: number; imageB64: string }[] = [];
  const n = Math.floor(spanS * fps);
  for (let i = 0; i < n; i++) out.push({ ts: nowTs - spanS + i / fps, imageB64: `f${i}` });
  return out;
}

const BASE_ENV = { PERCEIVE_URL: "http://p", DECIDE_URL: "http://d", LIVE_OBSERVE_LOOP: "1" };

function liveCfg(overrides: Record<string, string>) {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

function analyzerFor(overrides: Record<string, string>) {
  return buildLiveAnalyzerConfig({
    cfg: liveCfg(overrides),
    job: { id: "job-8065", gameHint: "soccer" } as any,
    clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 } as any,
  });
}

/** Build one live decide request exactly as the shipped rail does and return the
 *  `perceiveWindow` ledger the decide service copies into `decide_audit`. */
function stampFor(overrides: Record<string, string>): any {
  const analyzer = analyzerFor(overrides);
  const span = analyzer.liveObserveWindowS ?? analyzer.observeWindowS ?? 10;
  const frames = fundedFrames(T0, span);
  const win = assembleLiveWindow(frames, T0, {
    windowS: span,
    maxFrames: analyzer.observeMaxFrames ?? 4,
    fps: 2.8,
  });
  const payload = buildObservePayload(win, new Map());
  const run = new LiveRunShared({ jobId: "job-8065" });
  const req = buildObserveDecideRequest(analyzer, run, payload);
  return (req.opts as any).perceiveWindow;
}

describe("the live decide span/cadence knobs (ADAAAA-8065 AC-SPAN-1)", () => {
  it("defaults are today's cell: 10 s span, 3000 ms cadence", () => {
    const cfg = liveCfg({});
    expect(cfg.liveObserveWindowS).toBeUndefined(); // unset => the 10 s constant
    expect(cfg.liveObserveCadenceS).toBeUndefined(); // unset => the 3 s constant
    expect(stampFor({}).spanSec).toBe(10);
    expect(stampFor({}).cadenceMs).toBe(3000);
  });

  it("an empty env cannot collapse the span or the cadence to zero", () => {
    // compose passes `${X:-}`, which reaches the container as an EMPTY string;
    // `Number("")` is 0 — a zero-second window would fire empty decides.
    const cfg = liveCfg({ LIVE_OBSERVE_WINDOW_S: "", LIVE_OBSERVE_CADENCE_S: "" });
    expect(cfg.liveObserveWindowS).toBeUndefined();
    expect(cfg.liveObserveCadenceS).toBeUndefined();
    expect(stampFor({ LIVE_OBSERVE_WINDOW_S: "", LIVE_OBSERVE_CADENCE_S: "" }).spanSec).toBe(10);
  });

  it("honours a non-default configured cell (7 s span / 5 s cadence)", () => {
    const overrides = { LIVE_OBSERVE_WINDOW_S: "7", LIVE_OBSERVE_CADENCE_S: "5" };
    const cfg = liveCfg(overrides);
    expect(cfg.liveObserveWindowS).toBe(7);
    expect(cfg.liveObserveCadenceS).toBe(5);
    const stamp = stampFor(overrides);
    expect(stamp.spanSec).toBe(7);
    expect(stamp.cadenceMs).toBe(5000);
    // The image budget is still the ruled 4-image cell, stated alongside.
    expect(stamp.imagesPerDecide).toBeLessThanOrEqual(4);
    expect(stamp.imageBudgetApplied).toBe(true);
  });

  it("projects BOTH knobs onto the analyzer config the media rail builds from", () => {
    const analyzer = analyzerFor({ LIVE_OBSERVE_WINDOW_S: "7", LIVE_OBSERVE_CADENCE_S: "5" });
    // The analyzer live pass and the media rail both read these two fields, so a
    // configured cell is not a no-op on either rail.
    expect(analyzer.liveObserveWindowS).toBe(7);
    expect(analyzer.liveObserveCadenceS).toBe(5);
    // VOD's own window knob is untouched by the live span.
    expect(analyzer.observeWindowS).toBeUndefined();
  });

  it("a 7 s window really carries ~7 s of frames, not 10", () => {
    const frames = fundedFrames(T0, 10); // a 10 s supply
    const seven = assembleLiveWindow(frames, T0, { windowS: 7, maxFrames: 4, fps: 2.8 });
    const oldest = Math.min(...seven.frames.map((f) => f.ts));
    expect(T0 - oldest).toBeLessThanOrEqual(7.001);
    expect(T0 - oldest).toBeGreaterThan(6);
    // Fewer observations in the span is the density change the cell trades for.
    const ten = assembleLiveWindow(frames, T0, { windowS: 10, maxFrames: 4, fps: 2.8 });
    expect((seven.observedFrames?.length ?? 0)).toBeLessThan(ten.observedFrames?.length ?? 0);
  });
});

describe("the boot posture readout names all four cell values (ADAAAA-8065 Step 3)", () => {
  it("names the default cell: 4 images, 4 in flight, 10 s span, 3000 ms cadence", () => {
    const lines = liveDecideBootLines(liveCfg({}));
    const text = lines.join("\n");
    // ADAAAA-8102 added the content-consume axis as a fourth line, so a grade
    // greps the axis it measured. ADAAAA-8108 adds the enrichment-arm axis as the
    // fifth, for the same reason: the AC-E3 leg's ON/OFF split is graded off the
    // decide rows, and the boot line states which arm this process resolved.
    expect(lines).toHaveLength(5);
    expect(text).toContain("4 image(s)/decide");
    expect(text).toContain("4 decide(s) in flight");
    expect(text).toContain("10 s span / 3000 ms cadence");
  });

  it("names the shipped 7 s / 5 s cell with the 4-image, 2-in-flight budget", () => {
    // Step 3 of the ticket: the recreate must name images, in-flight, span AND
    // cadence. `printenv` alone is not evidence.
    const cfg = liveCfg({
      LIVE_OBSERVE_WINDOW_S: "7",
      LIVE_OBSERVE_CADENCE_S: "5",
      LIVE_OBSERVE_MAX_FRAMES: "4",
      LIVE_OBSERVE_IN_FLIGHT: "2",
    });
    const text = liveDecideBootLines(cfg).join("\n");
    expect(text).toContain("4 image(s)/decide");
    expect(text).toContain("2 decide(s) in flight");
    expect(text).toContain("7 s span / 5000 ms cadence");
  });

  it("an empty env cannot print a 0 s span or a 0 ms cadence", () => {
    const text = liveDecideBootLines(liveCfg({ LIVE_OBSERVE_WINDOW_S: "", LIVE_OBSERVE_CADENCE_S: "" })).join("\n");
    expect(text).toContain("10 s span / 3000 ms cadence");
  });
});
