import { describe, it, expect } from "vitest";
import { clipWindow, validateClipWindow, CLIP_WINDOW_MAX_SIDE_S } from "../src/config";
import {
  localizeHighlightInstant,
  localizeHighlightInstantFrame,
  localizeHighlightInstantVod,
  frameLocalizationScore,
  acceptVideoDecision,
  LiveRunShared,
  type LocalizeFrameInput,
  type AnalyzerConfig,
} from "../src/analyzer";
import type { PerFrameSignal } from "../src/observe-loop";

describe("clipWindow (ADAAAA-7232)", () => {
  it("defaults to a 15s window centered on the event (7s before, 8s after)", () => {
    const w = clipWindow(100, 7, 8, 15);
    expect(w.start).toBe(93);
    expect(w.end).toBe(108);
    expect(w.end - w.start).toBe(15);
  });

  it("pads the after side to honor the >=15s floor when tuned shorter", () => {
    const w = clipWindow(100, 2, 2, 15);
    expect(w.end - w.start).toBe(15);
    // padding goes to the after side, pre-roll is preserved
    expect(w.start).toBe(98);
    expect(w.end).toBe(113);
  });

  it("does not shrink a window that already meets the floor", () => {
    const w = clipWindow(100, 10, 10, 15);
    expect(w.start).toBe(90);
    expect(w.end).toBe(110);
    expect(w.end - w.start).toBe(20);
  });

  it("clamps the start at 0 around a very early event", () => {
    const w = clipWindow(3, 7, 8, 15);
    expect(w.start).toBe(0);
    expect(w.end - w.start).toBe(15);
  });
});

describe("localizeHighlightInstant (ADAAAA-7232)", () => {
  it("picks the highest-RMS audio tap strictly after the trigger within lookahead", () => {
    const taps = [
      { ts: 9.0, rms: 0.1 },
      { ts: 10.5, rms: 0.9 },
      { ts: 12.0, rms: 0.5 },
    ];
    const loc = localizeHighlightInstant(9.5, taps, 8);
    expect(loc).toEqual({ ts: 10.5, signal: "peak_audio" });
  });

  it("ignores taps at or before the trigger and beyond the lookahead", () => {
    const taps = [
      { ts: 9.4, rms: 1.0 }, // <= trigger (9.5) -> ignored
      { ts: 9.6, rms: 0.3 },
      { ts: 20.0, rms: 1.0 }, // beyond lookahead -> ignored
    ];
    const loc = localizeHighlightInstant(9.5, taps, 8);
    expect(loc).toEqual({ ts: 9.6, signal: "peak_audio" });
  });

  it("falls back to the trigger when no post-trigger tap is buffered", () => {
    const loc = localizeHighlightInstant(12, [{ ts: 11, rms: 0.9 }], 8);
    expect(loc).toEqual({ ts: 12, signal: "trigger" });
    expect(localizeHighlightInstant(12, undefined, 8)).toEqual({ ts: 12, signal: "trigger" });
    expect(localizeHighlightInstant(12, [], 8)).toEqual({ ts: 12, signal: "trigger" });
  });
});

describe("validateClipWindow (ADAAAA-7247 / ACC-7)", () => {
  it("accepts whole-second values and returns the nominal window", () => {
    const v = validateClipWindow(7, 8, 15);
    expect(v.ok).toBe(true);
    expect(v.clipBeforeS).toBe(7);
    expect(v.clipAfterS).toBe(8);
    expect(v.windowSec).toBe(15);
  });

  it("accepts any non-negative whole-second pair (even < minSec; clipWindow pads at assembly)", () => {
    const v = validateClipWindow(1, 2, 15);
    expect(v.ok).toBe(true);
    expect(v.windowSec).toBe(3);
  });

  it("rejects a missing / non-numeric value with a clear message", () => {
    const v = validateClipWindow(undefined, 8, 15);
    expect(v.ok).toBe(false);
    expect(v.error).toContain("clipBeforeS must be a number");
    const v2 = validateClipWindow("7", 8, 15);
    expect(v2.ok).toBe(false);
    expect(v2.error).toContain("clipBeforeS must be a number");
  });

  it("rejects fractional seconds", () => {
    const v = validateClipWindow(7.5, 8, 15);
    expect(v.ok).toBe(false);
    expect(v.error).toContain("whole number of seconds");
  });

  it("rejects negative values with a clear message", () => {
    const v = validateClipWindow(-1, 8, 15);
    expect(v.ok).toBe(false);
    expect(v.error).toContain("0 or more seconds");
  });

  it("rejects out-of-range (per-side > cap) values with a clear message", () => {
    const v = validateClipWindow(7, CLIP_WINDOW_MAX_SIDE_S + 1, 15);
    expect(v.ok).toBe(false);
    expect(v.error).toContain("capped at");
  });

  it("never lets an invalid pair break the >=15s floor (clipWindow pads)", () => {
    // Even a 1/1 setting still yields a >=15s delivered window via clipWindow.
    const w = clipWindow(100, 1, 1, 15);
    expect(w.end - w.start).toBe(15);
  });
});

describe("frameLocalizationScore (ADAAAA-7253 / ACC-3)", () => {
  const sig = (over: PerFrameSignal): PerFrameSignal => over;
  it("ranks ball-in-net above goal-crossed above scoreboard-change", () => {
    expect(frameLocalizationScore({ ts: 1, signal: sig({ ballInNet: true }) })).toBeGreaterThan(
      frameLocalizationScore({ ts: 1, signal: sig({ goalCrossed: true }) })
    );
    expect(frameLocalizationScore({ ts: 1, signal: sig({ goalCrossed: true }) })).toBeGreaterThan(
      frameLocalizationScore({ ts: 1, signal: sig({ scoreBoardChanged: true }) })
    );
  });

  it("scores a goal-valued ballOutcome above a plain scoreboard change", () => {
    const goal = frameLocalizationScore({ ts: 1, signal: sig({ ballOutcome: "goal" }) });
    const sb = frameLocalizationScore({ ts: 1, signal: sig({ scoreBoardChanged: true }) });
    expect(goal).toBeGreaterThan(sb);
  });

  it("falls through to tracking-detection confidence when no goal signal is present", () => {
    const none = frameLocalizationScore({ ts: 1, signal: undefined, detectionConfidence: 0 });
    const conf = frameLocalizationScore({ ts: 1, signal: undefined, detectionConfidence: 0.9 });
    expect(conf).toBeGreaterThan(none);
    expect(conf).toBeGreaterThan(0);
  });
});

describe("localizeHighlightInstantFrame (ADAAAA-7253 / ACC-3)", () => {
  const frame = (ts: number, signal?: PerFrameSignal, detectionConfidence?: number): LocalizeFrameInput => ({
    ts,
    signal,
    detectionConfidence,
  });
  const ballInNet = (ts: number): LocalizeFrameInput => frame(ts, { ballInNet: true });

  it("picks the peak ball-in-net frame deterministically after the trigger", () => {
    const frames = [
      frame(9.6, { scoreBoardChanged: true }), // scoreboard change
      frame(10.5, { ballInNet: true }), // peak (ball-in-net)
      frame(11.0, { goalCrossed: true }),
    ];
    const loc = localizeHighlightInstantFrame(frames, 9.5, 8);
    expect(loc).toEqual({ ts: 10.5, signal: "peak_frame" });
  });

  it("tie-breaks to the earliest qualifying frame (deterministic)", () => {
    const frames = [ballInNet(10.5), ballInNet(11.0)];
    const loc = localizeHighlightInstantFrame(frames, 9.5, 8);
    expect(loc).toEqual({ ts: 10.5, signal: "peak_frame" });
  });

  it("ignores frames at/before the trigger and beyond the lookahead", () => {
    const frames = [
      ballInNet(9.4), // <= trigger -> ignored
      ballInNet(9.6),
      ballInNet(20.0), // beyond lookahead -> ignored
    ];
    const loc = localizeHighlightInstantFrame(frames, 9.5, 8);
    expect(loc).toEqual({ ts: 9.6, signal: "peak_frame" });
  });

  it("falls back to detection-confidence peak when no goal signal is present", () => {
    const frames = [
      frame(10.0, undefined, 0.5),
      frame(11.0, undefined, 0.9),
      frame(12.0, undefined, 0.7),
    ];
    const loc = localizeHighlightInstantFrame(frames, 9.5, 8);
    expect(loc).toEqual({ ts: 11.0, signal: "peak_frame" });
  });

  it("falls back to the trigger when no qualifying signal-bearing frame exists", () => {
    const loc = localizeHighlightInstantFrame([frame(10.0)], 9.5, 8);
    expect(loc).toEqual({ ts: 9.5, signal: "trigger" });
    expect(localizeHighlightInstantFrame([], 9.5, 8)).toEqual({ ts: 9.5, signal: "trigger" });
    expect(localizeHighlightInstantFrame([frame(3, { ballInNet: true })], 9.5, 8)).toEqual({ ts: 9.5, signal: "trigger" });
  });
});

describe("localizeHighlightInstantVod (ADAAAA-7253 / ACC-3)", () => {
  const taps = [{ ts: 10.5, rms: 0.9 }];
  const frames: LocalizeFrameInput[] = [{ ts: 10.5, signal: { ballInNet: true } }];

  it("prefers the frame-based peak over peak-audio when a frame signal is present", () => {
    const loc = localizeHighlightInstantVod(9.5, frames, taps, 8);
    expect(loc).toEqual({ ts: 10.5, signal: "peak_frame" });
  });

  it("falls back to peak-audio when no frame signal qualifies", () => {
    const loc = localizeHighlightInstantVod(9.5, [], taps, 8);
    expect(loc).toEqual({ ts: 10.5, signal: "peak_audio" });
  });

  it("falls back to the trigger when neither frame nor audio signal is present", () => {
    const loc = localizeHighlightInstantVod(9.5, undefined, undefined, 8);
    expect(loc).toEqual({ ts: 9.5, signal: "trigger" });
  });
});

describe("acceptVideoDecision frame-localized record (ADAAAA-7253 / ACC-3)", () => {
  const seedCfg = {
    jobId: "job-1",
    confirmEnabled: false,
    clipBeforeS: 7,
    clipAfterS: 8,
    clipWindowMinSec: 15,
  } as unknown as AnalyzerConfig;

  it("records localizeSignal=peak_frame and localizedTs on the highlight, with no new decide/confirm call", async () => {
    const run = new LiveRunShared({ goalBurstWindowS: 30 });
    let cutTs: number | undefined;
    const cut = async (ts: number) => {
      cutTs = ts;
      return { clipId: "clip-1", clipUri: "uri-1" };
    };
    // Any decide/confirm invocation would throw — proves the frame-based accept
    // path makes NO new decide/inference call (Acc-6).
    const client = {
      decide: () => {
        throw new Error("decide should NOT be called during frame-based accept");
      },
      confirm: () => {
        throw new Error("confirm should NOT be called when confirmEnabled=false");
      },
    } as any;

    const frameSignals: LocalizeFrameInput[] = [
      { ts: 10.6, signal: { scoreBoardChanged: true } },
      { ts: 11.4, signal: { ballInNet: true } }, // peak
      { ts: 12.0, signal: { goalCrossed: true } },
    ];

    await acceptVideoDecision(
      client,
      run,
      cut,
      seedCfg,
      undefined,
      { seq: 1, timestamp: 10.0 },
      { eventType: "GOAL", timestamp: 10.0 },
      { isHighlight: true, outcome: "scoring_play", score: 88 },
      frameSignals
    );

    expect(cutTs).toBe(11.4);
    expect(run.highlights).toHaveLength(1);
    const rec = run.highlights[0];
    expect(rec.localizedTs).toBe(11.4);
    expect(rec.localizeSignal).toBe("peak_frame");
    // The delivered clip is centered on the localized instant (ACC-2 centering).
    expect(rec.start).toBe(11.4 - 7);
    expect(rec.end).toBe(11.4 + 8);
  });

  it("falls back to the trigger signal on the record when no frame signal is present", async () => {
    const run = new LiveRunShared({ goalBurstWindowS: 30 });
    const cut = async () => ({ clipId: "clip-1", clipUri: "uri-1" });
    const client = {} as any;

    await acceptVideoDecision(
      client,
      run,
      cut,
      seedCfg,
      undefined,
      { seq: 1, timestamp: 42.0 },
      { eventType: "GOAL", timestamp: 42.0 },
      { isHighlight: true, outcome: "scoring_play", score: 90 }
    );

    expect(run.highlights).toHaveLength(1);
    const rec = run.highlights[0];
    expect(rec.localizeSignal).toBe("trigger");
    expect(rec.localizedTs).toBe(42.0);
  });
});
