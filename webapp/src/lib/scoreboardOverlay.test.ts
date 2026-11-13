// ADAAAA-8886 (Inc 3): geometry + provenance for the score-bug box on the Live
// Stage video.
//
// The box is only correct when it is mapped through the video CONTENT rect.
// The stage is a fixed `aspect-video` container and the share can be any aspect,
// so these tests pin the two cases that a percentage-of-container box gets
// wrong: 16:9 in 16:9 (bars are zero — a container box passes by accident) and
// 4:3 in the same stage (letterboxed — a container box is off by the bar width).
//
// Pure functions, node env (this package deliberately has no jsdom).
import { describe, expect, it } from "vitest";
import {
  contentRect,
  formatOverlayBox,
  nativeOverlayBox,
  overlayBox,
  overlayBoxClass,
  overlayLabel,
  overlayLabelClass,
  overlayRoiText,
  overlaySourceText,
} from "./scoreboardOverlay";
import type { ScoreboardSurface } from "./scoreboardSurface";

const STAGE_W = 960;
const STAGE_H = 540;

const ROI: [number, number, number, number] = [0.1, 0.05, 0.6, 0.2];

const SURFACE: ScoreboardSurface = {
  roi: ROI,
  source: "explicit",
  seqFirstSeen: 41,
  verified: true,
};

describe("contentRect (AC3.2 — the video content rect, not the container)", () => {
  it("fills a 16:9 stage with a 16:9 stream: no bars, no offset", () => {
    const rect = contentRect(STAGE_W, STAGE_H, 1920, 1080)!;
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
    expect(rect.width).toBe(960);
    expect(rect.height).toBe(540);
  });

  it("centres a 4:3 stream and leaves horizontal letterbox bars", () => {
    // 1440x1080 is 4:3; contain-fit into 960x540 is height-limited.
    const rect = contentRect(STAGE_W, STAGE_H, 1440, 1080)!;
    expect(rect.height).toBe(540);
    expect(rect.width).toBe(720);
    expect(rect.x).toBe(120);
    expect(rect.y).toBe(0);
  });

  it("centres a wide (2.4:1) stream with vertical pillarbox bars", () => {
    const rect = contentRect(STAGE_W, STAGE_H, 1920, 800)!;
    expect(rect.width).toBe(960);
    expect(rect.height).toBe(400);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(70);
  });

  it("is null while either the rendered or the intrinsic size is unknown", () => {
    expect(contentRect(0, 0, 1920, 1080)).toBeNull();
    expect(contentRect(STAGE_W, STAGE_H, 0, 0)).toBeNull();
    expect(contentRect(STAGE_W, STAGE_H, NaN, 1080)).toBeNull();
    expect(contentRect(undefined, STAGE_H, 1920, 1080)).toBeNull();
  });
});

describe("overlayBox (AC3.2 — edges = offset + roi x contentSize, +/-2 px)", () => {
  it("maps a 16:9 stream in the 16:9 stage to the naive box (control)", () => {
    const box = overlayBox(contentRect(STAGE_W, STAGE_H, 1920, 1080), ROI)!;
    expect(Math.abs(box.left - 0.1 * 960)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.top - 0.05 * 540)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.width - 0.5 * 960)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.height - 0.15 * 540)).toBeLessThanOrEqual(2);
    expect(box.left).toBeCloseTo(96, 6);
    expect(box.top).toBeCloseTo(27, 6);
    expect(box.width).toBeCloseTo(480, 6);
    expect(box.height).toBeCloseTo(81, 6);
  });

  it("shifts a 4:3 stream by the horizontal letterbox bars", () => {
    const box = overlayBox(contentRect(STAGE_W, STAGE_H, 1440, 1080), ROI)!;
    // content rect x=120, width=720 -> left = 120 + 0.1*720 = 192, and the box
    // is 0.5*720 = 360 wide (a container-percentage box would say 96 / 480).
    expect(Math.abs(box.left - 192)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.top - 27)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.width - 360)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.height - 81)).toBeLessThanOrEqual(2);
    // The container-percentage box is outside tolerance: this is the defect.
    expect(Math.abs(0.1 * STAGE_W - box.left)).toBeGreaterThan(2);
  });

  it("maps at native resolution with no stage scaling (AC3.3 comparison)", () => {
    const box = nativeOverlayBox(1920, 1080, ROI)!;
    expect(box.left).toBeCloseTo(192, 6);
    expect(box.top).toBeCloseTo(54, 6);
    expect(box.width).toBeCloseTo(960, 6);
    expect(box.height).toBeCloseTo(162, 6);
  });

  it("renders no box rather than a guessed one", () => {
    expect(overlayBox(null, ROI)).toBeNull();
    expect(overlayBox(contentRect(STAGE_W, STAGE_H, 1920, 1080), undefined)).toBeNull();
    expect(formatOverlayBox(null)).toBe("");
  });

  it("formats the rendered geometry for the DOM hook", () => {
    const box = overlayBox(contentRect(STAGE_W, STAGE_H, 1440, 1080), ROI)!;
    expect(formatOverlayBox(box)).toBe("192,27,360,81");
  });
});

describe("provenance (AC3.4 — an honest source, a prior never reads as a pin)", () => {
  it("labels a pin `pinned`, a discovery `auto-detected`", () => {
    expect(overlaySourceText("explicit")).toBe("pinned");
    expect(overlaySourceText("discovery")).toBe("auto-detected");
  });

  it("labels default_top_band as a PRIOR that was not measured", () => {
    expect(overlaySourceText("default_top_band")).toBe("prior — not measured");
    expect(overlaySourceText("default_top_band")).not.toContain("pinned");
  });

  it("styles the prior differently from a pin", () => {
    const pin = overlayBoxClass("explicit");
    const prior = overlayBoxClass("default_top_band");
    expect(pin).toBe("border-neon");
    expect(prior).toContain("border-dashed");
    expect(prior).not.toBe(pin);
    expect(overlayLabelClass("default_top_band")).toBe("text-yellow");
    expect(overlayLabelClass("explicit")).toBe("text-neon");
  });

  it("reads a contradicted identity as `different match`", () => {
    const label = overlayLabel({
      ...SURFACE,
      identity: { verdict: "contradicted", kitDistance: 0.51, threshold: 0.35 },
    });
    expect(label).toContain("different match");
    expect(label).toContain("kits Δ=0.51 > 0.35");
  });

  it("never claims a match for an absent (unreadable) identity", () => {
    const label = overlayLabel({ ...SURFACE, identity: { verdict: "absent" } });
    expect(label).toContain("unreadable surface");
    expect(label).not.toContain("this match");
  });

  it("says `this match` only for a consistent identity", () => {
    expect(overlayLabel({ ...SURFACE, identity: { verdict: "consistent" } })).toContain("this match");
  });

  it("keeps the normalized box in the display form", () => {
    expect(overlayRoiText(SURFACE)).toBe("0.1,0.05,0.6,0.2");
    expect(overlayRoiText(undefined)).toBe("");
  });
});
