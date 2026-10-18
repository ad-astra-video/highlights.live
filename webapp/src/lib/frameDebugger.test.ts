import { describe, it, expect } from "vitest";
import {
  resolveTrackLabel,
  orderGallerySeqs,
  placeLabel,
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
