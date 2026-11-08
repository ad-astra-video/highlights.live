// ADAAAA-8108 (AC-E3): the live decide ENRICHMENT needs a runtime OFF arm.
//
// AC-E3 asks for a same-cell ON/OFF delta on the per-window perceive timeline
// (p50 <= 0.5 s at ~20-28 records). The shipped box could not run the OFF side at
// all: `LIVE_PERCEIVE_TIMELINE_SOURCE=observations|seeds` selects WHICH set the
// timeline is built from, and both produce an enriched timeline. This suite pins
// the lever that closes that gap:
//
//   1. ONE knob (`LIVE_DECIDE_ENRICH`) with `on` as the shipped posture, so an
//      unset env is byte-identical and a typo cannot ship a timeline-less leg.
//   2. `off` omits the `perceiveTimeline` text block from the decide request and
//      NOTHING else — same span, same observation set, same images, same cadence,
//      same in-flight depth, same keep ratio. That equality is what makes the
//      ON/OFF pair a measurement of the enrichment alone.
//   3. `alternate` allocates the arm per DECIDED window in content order starting
//      OFF, so one leg yields both arms at the SAME cell. OFF-first matters: an
//      ON-first leg reads the ON arm through the cold/warm image prefix and
//      overstates it (~+0.6 s is the false delta this order exists to avoid).
//   4. Every live row states its arm (`perceiveWindow.enrichmentArm`) and both
//      record counts (`timelineRecordsSent` / `timelineRecordsProjected`), so a
//      leg is graded off `decide_audit` instead of `printenv`.
import { describe, it, expect } from "vitest";
import { LiveObserver, assembleLiveWindow, buildObservePayload } from "../src/observe-loop";
import type { ObserveDecidePayload } from "../src/observe-loop";
import { LiveRunShared, buildObserveDecideRequest } from "../src/analyzer";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";
import { liveDecideBootLines } from "../src/live-decide-posture";

const T0 = 1_000;
const BASE_ENV = { PERCEIVE_URL: "http://p", DECIDE_URL: "http://d", LIVE_OBSERVE_LOOP: "1" };

function liveCfg(overrides: Record<string, string>) {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

function analyzerFor(overrides: Record<string, string>) {
  return buildLiveAnalyzerConfig({
    cfg: liveCfg(overrides),
    job: { id: "job-8108", gameHint: "soccer" } as any,
    clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 } as any,
  });
}

/** Funded-density delivery (~2.8 fps) inside the trailing window. */
function fundedFrames(nowTs: number, spanS: number, fps = 2.8): { ts: number; imageB64: string }[] {
  const out: { ts: number; imageB64: string }[] = [];
  const n = Math.floor(spanS * fps);
  for (let i = 0; i < n; i++) out.push({ ts: nowTs - spanS + i / fps, imageB64: `f${i}` });
  return out;
}

/** Build the shipped 7 s / 5 s / 4-image / 2-in-flight cell's payload. */
function cellPayload(arm?: "on" | "off"): ObserveDecidePayload {
  const analyzer = analyzerFor({
    LIVE_OBSERVE_WINDOW_S: "7",
    LIVE_OBSERVE_CADENCE_S: "5",
    LIVE_OBSERVE_MAX_FRAMES: "4",
    LIVE_OBSERVE_IN_FLIGHT: "2",
  });
  const win = assembleLiveWindow(fundedFrames(T0, 7), T0, {
    windowS: 7,
    maxFrames: 4,
    fps: 2.8,
    anchorTs: T0,
  });
  const payload = buildObservePayload(win, new Map());
  if (arm) payload.enrichmentArm = arm;
  return payload;
}

function request(payload: ObserveDecidePayload) {
  const analyzer = analyzerFor({
    LIVE_OBSERVE_WINDOW_S: "7",
    LIVE_OBSERVE_CADENCE_S: "5",
    LIVE_OBSERVE_MAX_FRAMES: "4",
    LIVE_OBSERVE_IN_FLIGHT: "2",
  });
  const run = new LiveRunShared({ jobId: "job-8108" });
  return buildObserveDecideRequest(analyzer, run, payload) as any;
}

function seed(ts: number) {
  return { ts, tracks: [], objects: [], ocr: [] };
}

describe("the live enrichment knob (ADAAAA-8108 AC-E3)", () => {
  it("defaults to the shipped `on` posture, including for an empty env", () => {
    expect(liveCfg({}).liveDecideEnrich).toBe("on");
    // compose passes `${X:-}`, which reaches the container as an EMPTY string.
    expect(liveCfg({ LIVE_DECIDE_ENRICH: "" }).liveDecideEnrich).toBe("on");
  });

  it("parses the two measurement arms and normalises anything else to `on`", () => {
    expect(liveCfg({ LIVE_DECIDE_ENRICH: "off" }).liveDecideEnrich).toBe("off");
    expect(liveCfg({ LIVE_DECIDE_ENRICH: "alternate" }).liveDecideEnrich).toBe("alternate");
    // A lever never becomes a posture by typo: `OFF`, `0`, `false`, `seeds` all
    // resolve to the shipped arm instead of shipping a timeline-less leg.
    for (const bad of ["OFF", "0", "false", "seeds", "yes"]) {
      expect(liveCfg({ LIVE_DECIDE_ENRICH: bad }).liveDecideEnrich).toBe("on");
    }
  });

  it("forwards the knob to the analyzer config both live rails build from", () => {
    for (const mode of ["off", "alternate"] as const) {
      expect(analyzerFor({ LIVE_DECIDE_ENRICH: mode }).liveDecideEnrich).toBe(mode);
    }
    expect(analyzerFor({}).liveDecideEnrich).toBe("on");
  });

  it("names the resolved arm at boot (a recreate that booted the wrong arm is readable)", () => {
    const lines = liveDecideBootLines(liveCfg({}));
    // ADAAAA-8377 added the live frame-scale line (six boot axes now).
    expect(lines).toHaveLength(6);
    expect(lines.join("\n")).toContain("[boot] live decide enrichment: on");
    const offLines = liveDecideBootLines(liveCfg({ LIVE_DECIDE_ENRICH: "alternate" }));
    expect(offLines.join("\n")).toContain("[boot] live decide enrichment: alternate");
  });
});

describe("the OFF arm of the decide request (ADAAAA-8108 AC-E3)", () => {
  it("sends the timeline on the shipped arm and states the arm on the ledger", () => {
    const on = request(cellPayload());
    expect(Array.isArray(on.evidence.perceiveTimeline)).toBe(true);
    expect(on.evidence.perceiveTimeline.length).toBeGreaterThan(0);
    const ledger = on.opts.perceiveWindow;
    expect(ledger.enrichmentArm).toBe("on");
    expect(ledger.timelineRecordsSent).toBe(on.evidence.perceiveTimeline.length);
    expect(ledger.timelineRecordsProjected).toBe(ledger.timelineRecordsSent);
    // An ABSENT arm is the same shipped request: no caller has to opt in.
    const absent = request(cellPayload());
    expect(absent.evidence.perceiveTimeline).toEqual(on.evidence.perceiveTimeline);
    expect(absent.opts.perceiveWindow.enrichmentArm).toBe("on");
  });

  it("omits the timeline on the OFF arm and nothing else in the cell", () => {
    const on = request(cellPayload("on"));
    const off = request(cellPayload("off"));
    // The one difference: the timeline block does not ride the request.
    expect(off.evidence.perceiveTimeline).toBeUndefined();
    expect(on.evidence.perceiveTimeline).toBeDefined();
    // Every other clause of the cell is identical, which is the AC-E3 "same cell"
    // requirement: span, cadence, images, budget, observation set.
    const onLed = on.opts.perceiveWindow;
    const offLed = off.opts.perceiveWindow;
    expect(offLed.spanSec).toBe(onLed.spanSec);
    expect(offLed.cadenceMs).toBe(onLed.cadenceMs);
    expect(offLed.imagesPerDecide).toBe(onLed.imagesPerDecide);
    expect(offLed.imageBudgetApplied).toBe(onLed.imageBudgetApplied);
    expect(offLed.observationsInSpan).toBe(onLed.observationsInSpan);
    expect(offLed.spanS).toBe(onLed.spanS);
    // The payload the model sees is otherwise byte-identical apart from the block.
    const onRest = { ...on.evidence };
    const offRest = { ...off.evidence };
    delete onRest.perceiveTimeline;
    expect(offRest).toEqual(onRest);
    // Frames are untouched: the image budget is a SELECTION knob, not an
    // enrichment knob, and the OFF arm must not silently ship fewer images.
    expect(off.opts.frames).toEqual(on.opts.frames);
  });

  it("keeps the projected density on the OFF row so the pair proves it measured one cell", () => {
    const ledger = request(cellPayload("off")).opts.perceiveWindow;
    expect(ledger.enrichmentArm).toBe("off");
    expect(ledger.timelineRecordsSent).toBe(0);
    // The observation set is still measured and still reported: the leg can show
    // both arms carried the same records WITHOUT paying for them.
    expect(ledger.timelineRecordsProjected).toBeGreaterThan(0);
    expect(ledger.timelineRecordsProjected).toBe(ledger.timelineRecords);
  });

  it("is inert on the VOD rail (an arm on a VOD payload changes nothing)", () => {
    // VOD has no enrichment at all; an arm flag must not resurrect it.
    const payload = cellPayload("on");
    const analyzer = analyzerFor({});
    const vod = { ...analyzer, decideWindowN: 1 } as typeof analyzer;
    const run = new LiveRunShared({ jobId: "vod-8108" });
    const req = buildObserveDecideRequest(vod, run, payload) as any;
    expect(req.evidence.perceiveTimeline).toBeUndefined();
    expect(req.opts.perceiveWindow).toBeUndefined();
  });
});

describe("the alternating arm allocation (ADAAAA-8108 AC-E3)", () => {
  /** Drive the observer's cadence on a pretend-real clock and collect the arm of
   *  every DECIDED window, in content order. */
  async function armsFor(
    enrichment: "on" | "off" | "alternate",
    from: number,
    to: number,
    step = 0.05
  ): Promise<(string | undefined)[]> {
    const arms: (string | undefined)[] = [];
    const observer = new LiveObserver({
      cadenceS: 0.2,
      windowS: 1,
      fps: 10,
      enrichment,
      onDecideStaged: (payload: ObserveDecidePayload) => {
        arms.push(payload.enrichmentArm);
        return { decide: async () => {}, accept: async () => true };
      },
    });
    for (let ts = from; ts <= to + 1e-9; ts += step) {
      const at = Number(ts.toFixed(6));
      observer.record(at, `f${at}`, seed(at) as any);
      await observer.maybeFire(at, false, 0);
    }
    await observer.flush();
    return arms;
  }

  it("starts OFF and alternates strictly, per decided window, in content order", async () => {
    const arms = await armsFor("alternate", 0, 2);
    // At least 3 windows per side is the AC's sample floor.
    expect(arms.length).toBeGreaterThanOrEqual(6);
    expect(arms.slice(0, 6)).toEqual(["off", "on", "off", "on", "off", "on"]);
    for (let i = 0; i < arms.length; i++) expect(arms[i]).toBe(i % 2 === 0 ? "off" : "on");
    expect(arms.filter((a) => a === "off").length).toBeGreaterThanOrEqual(3);
    expect(arms.filter((a) => a === "on").length).toBeGreaterThanOrEqual(3);
  });

  it("`off` stamps every decided window and `on` stamps none (shipped payload shape)", async () => {
    const offArms = await armsFor("off", 0, 1);
    expect(offArms.length).toBeGreaterThanOrEqual(3);
    expect(offArms.every((a) => a === "off")).toBe(true);
    const onArms = await armsFor("on", 0, 1);
    // Undefined, not "on": the shipped payload keeps no arm key at all, so the
    // request and the VOD rail stay byte-identical.
    expect(onArms.length).toBeGreaterThanOrEqual(3);
    expect(onArms.every((a) => a === undefined)).toBe(true);
  });

  it("does not spend a parity slot on a REFUSED tick (admission skip)", async () => {
    // A refused window (admission here: the shared live decide slot is held by
    // another share) returns BEFORE the arm is allocated, so it must not consume
    // a parity slot — otherwise the ON arm ends up with two neighbours and the
    // pair is no longer an alternation. Refuse every second opportunity.
    const arms: (string | undefined)[] = [];
    let asked = 0;
    const observer = new LiveObserver({
      cadenceS: 0.2,
      windowS: 1,
      fps: 10,
      enrichment: "alternate",
      canDecide: () => ++asked % 2 === 1,
      onDecideStaged: (payload: ObserveDecidePayload) => {
        arms.push(payload.enrichmentArm);
        return { decide: async () => {}, accept: async () => true };
      },
    });
    for (let ts = 0; ts <= 2 + 1e-9; ts += 0.05) {
      const at = Number(ts.toFixed(6));
      observer.record(at, `f${at}`, seed(at) as any);
      await observer.maybeFire(at, false, 0);
    }
    await observer.flush();
    // Half the opportunities were refused and produced no arm at all.
    expect(asked).toBeGreaterThan(arms.length);
    expect(arms.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < arms.length; i++) expect(arms[i]).toBe(i % 2 === 0 ? "off" : "on");
  });
});
