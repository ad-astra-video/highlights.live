// ADAAAA-8064 (B+e′ construction fix): the decide perceive timeline must be a
// projection of the window's FULL observation set, not of the images the decide
// call ships.
//
// Deployed symptom (ladder ADAAAA-8049, 100% of rows):
// `perceiveTimeline.records == ledger.seeds == frameCount`. With the timeline
// built off the capped image seeds, 4 images over a ~10 s span could only carry
// 0.40 records/s, so AC-E1 (>= 1/s) forced >= 12 images — where decide p50 was
// 7 166 ms against the 5 500 ms gate. The two criteria were mutually exclusive
// as built, not as configured.
//
// This file pins the plumbing: the live window keeps its PRE-CAP in-window frame
// list, the payload carries the perceive seeds for that set, and every frame the
// image cap dropped still reaches the timeline. The VOD symmetric window keeps
// no observation set, so the VOD payload stays byte-identical.
import { describe, it, expect } from "vitest";
import { assembleLiveWindow, assembleObserveWindow, buildObservePayload } from "../src/observe-loop";
import type { PerFrameSeed } from "../src/observe-loop";

/** A dense live rail: ~2.8 perceived frames/s over 10 s (28 frames). */
function denseFrames(n = 28, spanS = 10): { ts: number; imageB64: string }[] {
  return Array.from({ length: n }, (_, i) => ({ ts: Number((i * (spanS / (n - 1))).toFixed(2)), imageB64: `f${i}` }));
}

function findingsFor(frames: { ts: number }[]): Map<number, PerFrameSeed> {
  const m = new Map<number, PerFrameSeed>();
  for (const f of frames) {
    m.set(f.ts, {
      ts: f.ts,
      tracks: [{ trackId: "t0", label: "player" }],
      objects: [{ label: "player", confidence: 0.8, bbox: [0.1, 0.2, 0.3, 0.4] }],
      signal: { ballVelocity: { speedMps: 0.12 } },
    } as PerFrameSeed);
  }
  return m;
}

describe("live window observation set (ADAAAA-8064)", () => {
  it("keeps the pre-cap in-window frame list when the image cap subsamples", () => {
    const frames = denseFrames(28);
    const win = assembleLiveWindow(frames, 10, { windowS: 10, maxFrames: 4, fps: 2 });
    // The image side is capped...
    expect(win.frames.length).toBe(4);
    expect(win.capped).toBe(true);
    expect(win.droppedCount).toBeGreaterThan(0);
    // ...while the observation side is the whole span, in order, ts-only.
    expect(win.observedFrames?.length).toBe(28);
    const ts = (win.observedFrames ?? []).map((f) => f.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(ts).toEqual(frames.map((f) => f.ts));
    // Every shipped image is also an observation (the shipped set is a subset).
    for (const f of win.frames) expect(ts).toContain(f.ts);
  });

  it("is a no-op when the window already fits the cap (no behaviour change)", () => {
    const frames = denseFrames(8, 4);
    const win = assembleLiveWindow(frames, 4, { windowS: 10, maxFrames: 30, fps: 2 });
    expect(win.capped).toBe(false);
    expect(win.frames.length).toBe(win.observedFrames?.length);
  });

  it("carries the observation seeds on the decide payload, cap-independent", () => {
    const frames = denseFrames(28);
    const findings = findingsFor(frames);
    const win = assembleLiveWindow(frames, 10, { windowS: 10, maxFrames: 4, fps: 2 });
    const payload = buildObservePayload(win, findings);
    expect(payload.seeds.length).toBe(4);
    expect(payload.observations?.length).toBe(28);
    // Perceive findings survive for frames the image cap dropped.
    const dropped = (win.observedFrames ?? []).filter((f) => !win.frames.some((s) => s.ts === f.ts));
    expect(dropped.length).toBe(24);
    for (const f of dropped) {
      const obs = payload.observations?.find((o) => o.ts === f.ts);
      expect(obs?.tracks?.length).toBe(1);
    }
  });

  it("leaves the VOD symmetric window without an observation set (VOD unchanged)", () => {
    const win = assembleObserveWindow(denseFrames(28), 5, { windowS: 10, maxFrames: 4, fps: 2 });
    expect(win.frames.length).toBe(4);
    expect(win.observedFrames).toBeUndefined();
    const payload = buildObservePayload(win, new Map());
    expect("observations" in payload).toBe(false);
  });
});
