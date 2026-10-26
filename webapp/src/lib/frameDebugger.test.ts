import { describe, it, expect } from "vitest";
import {
  resolveTrackLabel,
  orderGallerySeqs,
  navigateGallery,
  placeLabel,
  collectFrameSeqs,
  drawFrameWithBoxes,
  coverTransform,
  coverPoint,
  drawFrameFullBleed,
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

// ADAAAA-7440: the enlarged-frame lightbox is a carousel over the whole window.
// navigateGallery decides which frame becomes enlarged when a bottom thumbnail
// is clicked: move the index within the current set if it already holds the
// target (e.g. a multi-select subset), else jump into the all-window carousel.
describe("navigateGallery (bottom-thumbnail carousel navigation)", () => {
  const allSeqs = [10, 20, 30, 40, 50];
  it("enters the all-window carousel at the clicked frame when opening single", () => {
    const nav = navigateGallery(allSeqs, null, 0, 30);
    expect(nav.gallery).toEqual(allSeqs);
    expect(nav.galIndex).toBe(2); // 30 is the 3rd frame
  });
  it("moves the index within the current subset when the target is already present", () => {
    const subset = [20, 40, 50];
    const nav = navigateGallery(allSeqs, subset, 0, 50);
    expect(nav.gallery).toBe(subset); // keeps the multi-select set
    expect(nav.galIndex).toBe(2);
  });
  it("jumps to the all-window carousel when clicking a frame outside the subset", () => {
    const subset = [20, 40];
    const nav = navigateGallery(allSeqs, subset, 1, 30);
    expect(nav.gallery).toEqual(allSeqs);
    expect(nav.galIndex).toBe(2);
  });
  it("starts at the first frame when a target seq is unknown (defensive)", () => {
    const nav = navigateGallery(allSeqs, null, 0, 999);
    expect(nav.gallery).toEqual(allSeqs);
    expect(nav.galIndex).toBe(0);
  });
  it("never mutates the all-window array passed in", () => {
    const nav = navigateGallery(allSeqs, null, 0, 30);
    expect(nav.gallery).not.toBe(allSeqs);
    expect(allSeqs).toEqual([10, 20, 30, 40, 50]);
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

// ADAAAA-6946 board feedback: thumbnails stay small with boxes only; the
// legible label is drawn only on the enlarged frame. drawFrameWithBoxes takes
// `withLabels` so the same renderer can suppress labels for the inline tile.
describe("drawFrameWithBoxes withLabels (labels only in the enlarged view)", () => {
  function fakeCtx() {
    const calls: string[] = [];
    const ctx: any = {
      setTransform: () => {},
      clearRect: () => {},
      drawImage: () => {},
      strokeRect: () => {},
      fillRect: () => {},
      fillText: () => calls.push("fillText"),
      measureText: (t: string) => ({ width: t.length * 6 }),
      font: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
    };
    const canvas = { getContext: () => ctx } as unknown as HTMLCanvasElement;
    return { canvas, calls };
  }
  const tracks = [{ bbox: [0.1, 0.1, 0.5, 0.5], slot: 0, kind: "ball", label: "soccer ball 0" }];
  it("draws the box but no label when withLabels=false (inline thumbnail)", () => {
    const { canvas, calls } = fakeCtx();
    drawFrameWithBoxes(canvas, {} as HTMLImageElement, tracks, 160, 90, 12, 2, false);
    expect(calls).not.toContain("fillText");
  });
  it("draws the legible label when withLabels defaults true (enlarged view)", () => {
    const { canvas, calls } = fakeCtx();
    drawFrameWithBoxes(canvas, {} as HTMLImageElement, tracks, 960, 540, 24, 2);
    expect(calls).toContain("fillText");
  });
});

// ADAAAA-6974: the enlarged lightbox must fill the full modal area (no
// letterbox bars). coverTransform is the canvas equivalent of object-fit:cover.
describe("coverTransform (full-bleed enlarge, no letterbox bars)", () => {
  // 16:9 source in a wider viewport → scale by width, crop the vertical overflow
  // (no horizontal bars). 
  it("fills a wide viewport by width and crops vertically", () => {
    const ct = coverTransform(1920, 1080, 3000, 1000);
    expect(ct.scale).toBeCloseTo(3000 / 1920, 5);
    // The drawn image spans the full width, so there are no horizontal bars:
    // dx centers the (equal-width) draw, dy shifts the cropped height.
    expect(ct.dx).toBeCloseTo(0, 3);
    expect(ct.dy).toBeLessThan(0); // vertical overflow cropped (centered)
  });
  it("fills a tall viewport by height and crops horizontally", () => {
    const ct = coverTransform(1920, 1080, 1000, 3000);
    expect(ct.scale).toBeCloseTo(3000 / 1080, 5);
    expect(ct.dy).toBeCloseTo(0, 3);
    expect(ct.dx).toBeLessThan(0); // horizontal overflow cropped (centered)
  });
  it("is a no-crop identity scale when the aspect ratios match", () => {
    const ct = coverTransform(1920, 1080, 1920, 1080);
    expect(ct.scale).toBeCloseTo(1, 5);
    expect(ct.dx).toBeCloseTo(0, 3);
    expect(ct.dy).toBeCloseTo(0, 3);
  });
  it("coverPoint maps a normalized image point into the cropped canvas space", () => {
    const ct = coverTransform(1920, 1080, 3000, 1000);
    // center of the image maps to the center of the canvas horizontally (no
    // horizontal offset) and stays vertically within the visible band.
    const p = coverPoint(ct, 0.5, 0.5);
    expect(p.x).toBeCloseTo(1500, 0);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(1000);
  });
});

describe("drawFrameFullBleed (boxes/labels aligned with the covered image)", () => {
  function fakeTrackCtx() {
    const strokes: number[][] = [];
    const texts: string[] = [];
    const ctx: any = {
      setTransform: () => {},
      clearRect: () => {},
      drawImage: () => {},
      strokeRect: (...a: number[]) => strokes.push(a),
      fillRect: () => {},
      fillText: (t: string) => texts.push(t),
      measureText: (t: string) => ({ width: t.length * 6 }),
      font: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
    };
    const canvas = { getContext: () => ctx } as unknown as HTMLCanvasElement;
    return { canvas, strokes, texts };
  }
  const tracks = [{ bbox: [0.5, 0.5, 0.6, 0.6], slot: 0, kind: "ball", label: "soccer ball 0" }];

  it("draws the box at the cover-mapped position (no letterbox offset)", () => {
    const { canvas, strokes, texts } = fakeTrackCtx();
    const img = { naturalWidth: 1920, naturalHeight: 1080 } as HTMLImageElement;
    drawFrameFullBleed(canvas, img, tracks, 3000, 1000, 28, 2);
    // For 3000x1000 viewport + 1920x1080 image: scale=3000/1920, dy=-343.75.
    // Box [0.5,0.5] -> (1500, 500); [0.6,0.6] -> (1800, 668.75).
    const r = strokes[0];
    expect(r[0]).toBeCloseTo(1500, 0);
    expect(r[1]).toBeCloseTo(500, 0);
    expect(r[2]).toBeCloseTo(300, 0);
    expect(r[3]).toBeCloseTo(168.75, 0);
    expect(texts.length).toBeGreaterThan(0); // labels drawn in the enlarged view
  });

  it("still draws the legible label over the full-bleed image", () => {
    const { canvas, texts } = fakeTrackCtx();
    const img = { naturalWidth: 1920, naturalHeight: 1080 } as HTMLImageElement;
    drawFrameFullBleed(canvas, img, tracks, 3000, 1000, 28, 2);
    expect(texts.join(" ")).toContain("soccer ball 0");
  });
});
