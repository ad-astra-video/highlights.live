// ADAAAA-8074: the decide image budget must BIND the payload.
//
// Evidence (ADAAAA-8070, job f757a56b on 458e301): the box booted
// `LIVE_OBSERVE_MAX_FRAMES=4` (verified in `printenv`) and still sent 27.4
// images per decide — max 29, 31/32 windows above 4 — because the budget was a
// value one rail read while the payload's selection step never consulted it, and
// nothing on the audit row said what the payload carried.
//
// These tests pin the three clauses of the fix:
//   1. ONE budget, consulted in the selection step (`assembleLiveWindow`), read
//      by every live payload build, default 4, clamped to the 30-image ceiling.
//   2. Deterministic, TRIGGER-ANCHORED selection: the frame nearest the trigger
//      onset is always carried and the rest are spread across the span (no
//      first-N / last-N truncation), so the witness gap stays ~span/budget.
//   3. Every payload records `imagesPerDecide` + `imageBudgetApplied` (+ the
//      budget it consulted) so a leg grades the row, not `printenv`.
import { describe, it, expect } from "vitest";
import {
  LIVE_DECIDE_IMAGE_BUDGET,
  LIVE_DECIDE_IMAGE_CEILING,
  assembleLiveWindow,
  assembleObserveWindow,
  buildObservePayload,
  resolveDecideImageBudget,
  subsampleAroundAnchor,
} from "../src/observe-loop";
import { MediaRailObserver } from "../src/media-rail";
import { loadConfig } from "../src/config";
import { buildLiveAnalyzerConfig } from "../src/api";

const T0 = 1_000;

/** A funded-density delivery: ~28 frames inside the trailing 10 s window (the
 *  leg's 2.78 fps supply), each carrying an image. */
function fundedWindow(nowTs: number, fps = 2.8): { ts: number; imageB64: string }[] {
  const out: { ts: number; imageB64: string }[] = [];
  const n = Math.floor(10 * fps);
  for (let i = 0; i < n; i++) out.push({ ts: nowTs - 10 + i / fps, imageB64: `f${i}` });
  return out;
}

const jpeg = (i: number) => Buffer.from(`img-${i}`).toString("base64");

describe("the live decide image budget (ADAAAA-8074 AC-CAP-1)", () => {
  it("defaults to 4 and can never exceed the 30-image ceiling", () => {
    expect(LIVE_DECIDE_IMAGE_BUDGET).toBe(4);
    expect(LIVE_DECIDE_IMAGE_CEILING).toBe(30);
    // Absent / empty / zero / garbage all fall back to the ruled cell instead of
    // turning the cap off (an empty env used to parse as 0).
    expect(resolveDecideImageBudget(undefined)).toBe(4);
    expect(resolveDecideImageBudget("")).toBe(4);
    expect(resolveDecideImageBudget("0")).toBe(4);
    expect(resolveDecideImageBudget("nope")).toBe(4);
    expect(resolveDecideImageBudget("-3")).toBe(4);
    // An explicit budget is honoured, and never raised past the ceiling.
    expect(resolveDecideImageBudget("6")).toBe(6);
    expect(resolveDecideImageBudget(99)).toBe(30);
    expect(resolveDecideImageBudget(2.7)).toBe(2);
  });

  it("loadConfig resolves 4 by default (the shipped posture) and honours the env", () => {
    const base = { PERCEIVE_URL: "http://p", DECIDE_URL: "http://d" };
    expect(loadConfig({ ...base }).liveObserveMaxFrames).toBe(4);
    expect(loadConfig({ ...base, LIVE_OBSERVE_MAX_FRAMES: "4" }).liveObserveMaxFrames).toBe(4);
    expect(loadConfig({ ...base, LIVE_OBSERVE_MAX_FRAMES: "6" }).liveObserveMaxFrames).toBe(6);
    // A typo cannot switch the cap off, and cannot raise it past the ceiling.
    expect(loadConfig({ ...base, LIVE_OBSERVE_MAX_FRAMES: "" }).liveObserveMaxFrames).toBe(4);
    expect(loadConfig({ ...base, LIVE_OBSERVE_MAX_FRAMES: "99" }).liveObserveMaxFrames).toBe(30);
  });

  it("projects the budget onto BOTH live rails' config (analyzer + media rail)", () => {
    const cfg = loadConfig({
      PERCEIVE_URL: "http://p",
      DECIDE_URL: "http://d",
      LIVE_OBSERVE_LOOP: "1",
      LIVE_OBSERVE_MAX_FRAMES: "4",
    });
    const analyzer = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-8074", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    });
    expect(analyzer.observeMaxFrames).toBe(4);
    // ...and the same value is what the media rail hands its LiveObserver.
    expect(cfg.liveObserveMaxFrames).toBe(4);
  });

  it("binds a funded-density window to <= budget, and says so on the window", () => {
    const frames = fundedWindow(T0);
    expect(frames.length).toBeGreaterThan(LIVE_DECIDE_IMAGE_BUDGET);
    const win = assembleLiveWindow(frames, T0, { windowS: 10, maxFrames: 4, fps: 2.8 });
    expect(win.frames.length).toBeLessThanOrEqual(4);
    expect(win.imageBudget).toBe(4);
    expect(win.imageBudgetApplied).toBe(true);
    expect(win.capped).toBe(true);
    // The observation set is untouched by the image budget (density is 8069's).
    expect(win.observedFrames?.length).toBeGreaterThan(win.frames.length);
  });

  it("spreads the budget across the span instead of truncating to newest frames", () => {
    const frames = fundedWindow(T0);
    const newest = frames[frames.length - 1].ts;
    const win = assembleLiveWindow(frames, T0, { windowS: 10, maxFrames: 4, fps: 2.8 });
    const ts = win.frames.map((f) => f.ts);
    expect(ts.length).toBe(4);
    expect(ts[0]).toBeCloseTo(frames[0].ts, 6); // oldest in-window frame
    expect(ts[ts.length - 1]).toBeCloseTo(newest, 6); // newest delivered frame
    // No first-N / last-N collapse: every gap is ~span/(budget-1).
    const span = ts[ts.length - 1] - ts[0];
    const ideal = span / (ts.length - 1);
    for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBeLessThanOrEqual(ideal * 1.5);
    expect(span).toBeGreaterThan(8); // a 10 s span, not a 1 s burst
  });
});

describe("trigger-anchored, deterministic selection (ADAAAA-8074 clause 2)", () => {
  it("always carries the frame nearest the trigger onset", () => {
    const frames = fundedWindow(T0);
    const newest = frames[frames.length - 1].ts;
    // An onset in a spot no evenly spaced slot would pick.
    const onset = T0 - 6.13;
    const win = assembleLiveWindow(frames, T0, { windowS: 10, maxFrames: 4, fps: 2.8, anchorTs: onset });
    expect(win.frames.length).toBeLessThanOrEqual(4);
    expect(win.anchorTs).toBeCloseTo(onset, 9);
    const nearest = frames.reduce((a, b) => (Math.abs(b.ts - onset) < Math.abs(a.ts - onset) ? b : a));
    expect(win.frames.some((f) => f.ts === nearest.ts)).toBe(true);
    // ...without losing the span endpoints.
    expect(win.frames[0].ts).toBeCloseTo(frames[0].ts, 6);
    expect(win.frames[win.frames.length - 1].ts).toBeCloseTo(newest, 6);
  });

  it("is deterministic: the same window always yields the same images", () => {
    const frames = fundedWindow(T0);
    const a = assembleLiveWindow(frames, T0, { windowS: 10, maxFrames: 4, fps: 2.8, anchorTs: T0 - 4.4 });
    const b = assembleLiveWindow([...frames].reverse(), T0, { windowS: 10, maxFrames: 4, fps: 2.8, anchorTs: T0 - 4.4 });
    expect(a.frames.map((f) => f.ts)).toEqual(b.frames.map((f) => f.ts));
  });

  it("subsampleAroundAnchor keeps exactly `max` items and the anchor", () => {
    const ordered = Array.from({ length: 29 }, (_, i) => ({ ts: i / 2.9 }));
    for (const max of [1, 2, 3, 4, 6, 12]) {
      const { items, capped } = subsampleAroundAnchor(ordered, max, ordered[17].ts);
      expect(items.length).toBeLessThanOrEqual(max);
      expect(capped).toBe(true);
      if (max > 1) expect(items.some((i) => i.ts === ordered[17].ts)).toBe(true);
      // Ordered oldest -> newest, no duplicates.
      const ts = items.map((i) => i.ts);
      expect(ts).toEqual([...ts].sort((x, y) => x - y));
      expect(new Set(ts).size).toBe(ts.length);
    }
    // An input already within the budget is carried whole.
    expect(subsampleAroundAnchor(ordered, 30, ordered[17].ts).capped).toBe(false);
  });

  it("an in-cap window is carried whole and reports capped=false", () => {
    const frames = fundedWindow(T0, 0.3); // 3 frames in 10 s
    const win = assembleLiveWindow(frames, T0, { windowS: 10, maxFrames: 4, fps: 2.8, anchorTs: T0 - 5 });
    expect(win.frames.length).toBe(frames.length);
    expect(win.capped).toBe(false);
    expect(win.imageBudgetApplied).toBe(true);
  });
});

describe("the payload records what it carried (ADAAAA-8074 clause 3)", () => {
  it("a live window's payload states imagesPerDecide / imageBudget / imageBudgetApplied", () => {
    const frames = fundedWindow(T0);
    const win = assembleLiveWindow(frames, T0, { windowS: 10, maxFrames: 4, fps: 2.8 });
    const payload = buildObservePayload(win, new Map());
    expect(payload.imagesPerDecide).toBe(payload.frames.length);
    expect(payload.imagesPerDecide).toBeLessThanOrEqual(4);
    expect(payload.imageBudget).toBe(4);
    expect(payload.imageBudgetApplied).toBe(true);
  });

  it("a VOD (symmetric) window states nothing — it has no image budget", () => {
    const frames = fundedWindow(T0).map((f) => ({ ...f, ts: f.ts - 5 }));
    const win = assembleObserveWindow(frames, T0, { windowS: 10, maxFrames: 30, fps: 2 });
    const payload = buildObservePayload(win, new Map());
    expect(payload.imageBudgetApplied).toBeUndefined();
    expect(payload.imagesPerDecide).toBeUndefined();
  });

  it("the media rail's payloads carry the budget too (the shipped live rail)", async () => {
    const calls: any[] = [];
    // The rail rebases to epoch-second content clocks (a non-epoch ts is
    // evidence-only and fires no decide), so drive it with real epochs.
    const now = Math.floor(Date.now() / 1000);
    const rail = new MediaRailObserver({
      jobId: "j-8074",
      maxFrames: 4,
      fps: 3,
      cadenceS: 3,
      onDecide: async (p) => (calls.push(p), false),
    });
    for (let i = 0; i < 30; i++) rail.onFrameTick(now - 10 + i / 3);
    for (let i = 0; i < 30; i++) rail.onObservation({ seq: i, timestamp: now - 10 + i / 3, tracks: [] }, jpeg(i));
    await rail.finish();
    expect(calls.length).toBeGreaterThan(0);
    const p = calls[calls.length - 1];
    expect(p.frames.length).toBeLessThanOrEqual(4);
    expect(p.imagesPerDecide).toBe(p.frames.length);
    expect(p.imageBudget).toBe(4);
    expect(p.imageBudgetApplied).toBe(true);
  });
});
