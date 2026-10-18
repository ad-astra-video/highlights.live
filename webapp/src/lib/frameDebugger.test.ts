import { describe, it, expect } from "vitest";
import {
  resolveTrackLabel,
  orderGallerySeqs,
  placeLabel,
  collectFrameSeqs,
  isTrackOnScreen,
} from "./frameDebugger";

// ADAAAA-6943/6946: click-to-enlarge + multi-select enlarge + legible
// detection-box labels. The FrameDebugger keeps the DOM-heavy rendering in its
// component; these pure helpers do selection ordering, label resolution and
// label placement, so the enlarge/multi-select/label behavior is unit-tested
// here in node with the repo's existing vitest helper-test pattern.

describe("resolveTrackLabel (ADAAAA-5056: legible detection-box labels)", () => {
  it("prefers the in-roster detector label over the coarse kind", () => {
    expect(resolveTrackLabel({ label: "player 0", kind: "unknown" })).toBe("player 0");
    expect(resolveTrackLabel({ label: "soccer ball 0", kind: "ball" })).toBe("soccer ball 0");
  });
  it("trims whitespace from the label before using it", () => {
    expect(resolveTrackLabel({ label: "  player 1  ", kind: "unknown" })).toBe("player 1");
  });
  it("falls back to kind when no label is present", () => {
    expect(resolveTrackLabel({ kind: "ball" })).toBe("ball");
  });
  it("never renders a blank/unknown fallback when a real label exists", () => {
    expect(resolveTrackLabel({ label: "unknown", kind: "unknown" })).toBe("unknown");
  });
  it("falls back to 'detection' only when neither label nor kind exists", () => {
    expect(resolveTrackLabel({ kind: "" })).toBe("detection");
  });
});

describe("orderGallerySeqs (multi-select enlarge gallery order)", () => {
  const frameSeqs = [10, 20, 30, 40];
  it("orders a selected set by filmstrip order for predictably prev/next", () => {
    expect(orderGallerySeqs(frameSeqs, [40, 10, 30])).toEqual([10, 30, 40]);
  });
  it("keeps >=2 selected frames for the multi-select gallery", () => {
    expect(orderGallerySeqs(frameSeqs, [20, 40])).toEqual([20, 40]);
    expect(orderGallerySeqs(frameSeqs, [20, 40]).length).toBeGreaterThanOrEqual(2);
  });
  it("returns a one-entry gallery for a single select", () => {
    expect(orderGallerySeqs(frameSeqs, [30])).toEqual([30]);
  });
  it("drops seqs not in the filmstrip and returns empty for none selected", () => {
    expect(orderGallerySeqs(frameSeqs, [99, 20])).toEqual([20]);
    expect(orderGallerySeqs(frameSeqs, [])).toEqual([]);
  });
});

describe("placeLabel (no off-canvas / clipped text at small sizes)", () => {
  const w = 320;
  const h = 180;
  const fontPx = 12;
  it("clamps a right-edge label inside the canvas", () => {
    const { lx } = placeLabel(200, 300, 90, w, h, fontPx);
    expect(lx + 200).toBeLessThanOrEqual(w);
    expect(lx).toBeGreaterThanOrEqual(2);
  });
  it("flips a top-edge label inside the box when there is no room above", () => {
    const { ly } = placeLabel(40, 100, 2, w, h, fontPx);
    expect(ly).toBeGreaterThan(2);
  });
  it("keeps a label below the box top when there is room above", () => {
    const { ly } = placeLabel(40, 100, 60, w, h, fontPx);
    expect(ly).toBeLessThan(60);
  });
  it("keeps the label within the bottom of the canvas", () => {
    const { ly } = placeLabel(40, 100, 179, w, h, fontPx);
    expect(ly).toBeLessThanOrEqual(h);
  });
});

describe("isTrackOnScreen (ADAAAA-6966/6967: stale detection boxes on post-exit frames)", () => {
  it("returns true for an object still present on the frame (lostFrames 0)", () => {
    expect(isTrackOnScreen({ lostFrames: 0 })).toBe(true);
  });
  it("returns false once the object has been lost for >=1 frame", () => {
    expect(isTrackOnScreen({ lostFrames: 1 })).toBe(false);
    expect(isTrackOnScreen({ lostFrames: 8 })).toBe(false);
  });
  it("returns false when the track is explicitly off screen", () => {
    expect(isTrackOnScreen({ onScreen: false })).toBe(false);
  });
  it("returns true for an explicitly on-screen track even if lostFrames is absent", () => {
    expect(isTrackOnScreen({ onScreen: true })).toBe(true);
  });
  it("preserves legacy behavior for tracks without loss/on-screen signals", () => {
    expect(isTrackOnScreen({})).toBe(true);
    expect(isTrackOnScreen({ lostFrames: undefined, onScreen: undefined })).toBe(true);
  });
});

describe("collectFrameSeqs (multi-select enlarge across per-job detail sections)", () => {
  it("collects every frame seq in section filmstrip order", () => {
    const sections = [
      { index: 0, frames: [{ seq: 1 }, { seq: 2 }] },
      { index: 1, frames: [{ seq: 3 }, { seq: 4 }] },
    ];
    expect(collectFrameSeqs(sections)).toEqual([1, 2, 3, 4]);
  });
  it("orders the multi-select gallery with orderGallerySeqs over collected seqs", () => {
    const sections = [
      { index: 0, frames: [{ seq: 1 }, { seq: 2 }] },
      { index: 1, frames: [{ seq: 3 }, { seq: 4 }] },
    ];
    const ordered = orderGallerySeqs(collectFrameSeqs(sections), [4, 2]);
    expect(ordered).toEqual([2, 4]);
  });
  it("returns empty when there are no sections", () => {
    expect(collectFrameSeqs([])).toEqual([]);
  });
});
