import { describe, it, expect } from "vitest";
import {
  defaultWindowState,
  windowExtractParams,
  maxWindowStart,
  clampWindowStart,
  frameTime,
  windowFrameCount,
  nearestFrameIndex,
  nextWindow,
  isAtWindowEnd,
  jumpWindowTo,
  WINDOW_LEN,
  WINDOW_FPS,
  WINDOW_FRAMES,
} from "./datasetWindow";

describe("datasetWindow (ADAAAA-5512 sliding-window model)", () => {
  it("default window is first 30 s @ 10 fps (≈300 frames)", () => {
    const w = defaultWindowState(120);
    expect(w.start).toBe(0);
    expect(w.len).toBe(WINDOW_LEN);
    expect(w.fps).toBe(WINDOW_FPS);
    expect(windowFrameCount(w)).toBe(WINDOW_FRAMES);
  });

  it("extract params mirror the server inSec/outSec/fps contract", () => {
    const w = { ...defaultWindowState(120), start: 15 };
    expect(windowExtractParams(w)).toEqual({ inSec: 15, outSec: 45, fps: 10 });
  });

  it("clamps a window start to fit inside the clip", () => {
    const w = defaultWindowState(60); // 30 s window in a 60 s clip
    expect(maxWindowStart(w)).toBe(30);
    expect(clampWindowStart(w, 50)).toBe(30); // would overrun
    expect(clampWindowStart(w, -5)).toBe(0);
    expect(clampWindowStart(w, 12.34)).toBe(12.3); // quantized to 0.1 s
  });

  it("unbounded clip lets the window advance freely", () => {
    const w = defaultWindowState(null);
    expect(maxWindowStart(w)).toBe(Number.POSITIVE_INFINITY);
    expect(clampWindowStart(w, 500)).toBe(500);
  });

  it("maps frame index -> clip time at 10 fps", () => {
    const w = { ...defaultWindowState(120), start: 10 };
    expect(frameTime(w, 0)).toBe(10);
    expect(frameTime(w, 1)).toBe(10.1);
    expect(frameTime(w, 100)).toBe(20);
  });

  it("finds the nearest frame index for a time (time-jump landing)", () => {
    const w = { ...defaultWindowState(120), start: 10 };
    expect(nearestFrameIndex(w, 10, 300)).toBe(0);
    expect(nearestFrameIndex(w, 10.1, 300)).toBe(1);
    expect(nearestFrameIndex(w, 9.5, 300)).toBe(0); // clamps before start
    expect(nearestFrameIndex(w, 500, 300)).toBe(299); // clamps past end
  });

  it("auto-advances to the next 30 s block", () => {
    const w = defaultWindowState(120);
    expect(nextWindow(w).start).toBe(30);
    // does not advance past the end of a finite clip
    const near = { ...w, start: 90 }; // window would run to 120, exactly the end
    expect(nextWindow(near).start).toBe(90); // already at max, stays put
  });

  it("flags reaching the end of the window (auto-advance trigger)", () => {
    const w = defaultWindowState(120);
    expect(isAtWindowEnd(w, 298, 300)).toBe(false);
    expect(isAtWindowEnd(w, 299, 300)).toBe(true);
  });

  it("time-jump anchors the window at the requested time", () => {
    const w = defaultWindowState(120);
    const jumped = jumpWindowTo(w, 42);
    expect(jumped.start).toBe(42);
    // landing frame within ±1 s (at 10 fps the requested time is frame 0)
    expect(Math.abs(frameTime(jumped, nearestFrameIndex(jumped, 42, windowFrameCount(jumped))) - 42)).toBeLessThanOrEqual(1);
  });
});
