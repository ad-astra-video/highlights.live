import { describe, it, expect } from "vitest";
import { clipWindow } from "../src/config";
import { localizeHighlightInstant } from "../src/analyzer";

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
