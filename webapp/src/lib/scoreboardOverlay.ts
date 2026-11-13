/**
 * ADAAAA-8886 (Inc 3): geometry for drawing the score-bug box over the Live
 * Stage video.
 *
 * The served `scoreboardSurface.roi` is NORMALIZED to the analyzed frame (0..1),
 * so it can only be drawn correctly through the video's CONTENT rect. The live
 * stage is a fixed `aspect-video` box while the share can be any aspect (a 4:3
 * screen share is letterboxed inside it), so a percentage-of-container box is
 * wrong by the bar width: it is right only when intrinsic and stage aspects
 * match.
 *
 * Two pure steps, both measured rather than asserted:
 *
 *   contentRect(stageW, stageH, videoW, videoH) -> the rect the video pixels
 *     actually occupy inside the stage element (contain fit, centred) — the
 *     same fit the UA applies to a <video>.
 *   overlayBox(rect, roi) -> `offset + roi × contentSize` in stage-local px.
 *
 * Dependency-free and DOM-free so it is unit-testable in the node vitest
 * environment (this package deliberately has no jsdom).
 */
import {
  describeSurfaceIdentity,
  formatScoreboardRoi,
  scoreboardSourceLabel,
  type ScoreboardRoi,
  type ScoreboardSurface,
} from "./scoreboardSurface";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const positive = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * The rect a `videoW × videoH` frame occupies inside a `stageW × stageH` box at
 * `object-fit: contain` (uniform scale, centred): `min(stage/frame)` scale, then
 * the leftover split evenly as letterbox/pillarbox bars.
 *
 * `null` until both the rendered size and the intrinsic size are known — the
 * overlay renders no box rather than a guessed one.
 */
export function contentRect(
  stageW: number | null | undefined,
  stageH: number | null | undefined,
  videoW: number | null | undefined,
  videoH: number | null | undefined
): Rect | null {
  if (!positive(stageW) || !positive(stageH) || !positive(videoW) || !positive(videoH)) return null;
  const scale = Math.min(stageW / videoW, stageH / videoH);
  const width = videoW * scale;
  const height = videoH * scale;
  return { x: (stageW - width) / 2, y: (stageH - height) / 2, width, height };
}

/** AC3.2: box edges = `offset + roi × contentSize`, stage-local px. */
export function overlayBox(rect: Rect | null, roi: ScoreboardRoi | undefined): OverlayBox | null {
  if (!rect || !roi || roi.length !== 4) return null;
  const [x0, y0, x1, y1] = roi;
  if (![x0, y0, x1, y1].every((v) => Number.isFinite(v))) return null;
  return {
    left: rect.x + x0 * rect.width,
    top: rect.y + y0 * rect.height,
    width: (x1 - x0) * rect.width,
    height: (y1 - y0) * rect.height,
  };
}

/**
 * The box at the frame's own resolution (no stage, no bars): the pixel region
 * perceive's crop covers for the same normalized numbers. Used to compare the
 * overlay against a stored crop observation (AC3.3).
 */
export function nativeOverlayBox(videoW: number, videoH: number, roi: ScoreboardRoi): OverlayBox | null {
  return overlayBox(contentRect(videoW, videoH, videoW, videoH), roi);
}

/** `left,top,width,height` at 2 dp — the rendered geometry, for the DOM hook. */
export function formatOverlayBox(box: OverlayBox | null): string {
  if (!box) return "";
  return [box.left, box.top, box.width, box.height]
    .map((v) => Number(v.toFixed(2)))
    .join(",");
}

/** `x,y,width,height` of the measured content rect, for the DOM hook. */
export function formatContentRect(rect: Rect | null): string {
  if (!rect) return "";
  return [rect.x, rect.y, rect.width, rect.height].map((v) => Number(v.toFixed(2))).join(",");
}

/**
 * AC3.4: provenance class per source. `default_top_band` is a PRIOR, not a
 * measurement, so it is dashed + yellow and can never read as the solid neon pin.
 */
export function overlayBoxClass(source: ScoreboardSurface["source"] | undefined): string {
  switch (source) {
    case "explicit":
      return "border-neon";
    case "discovery":
      return "border-purple";
    case "default_top_band":
      return "border-yellow border-dashed";
    default:
      return "border-mut";
  }
}

/** Text colour that matches the provenance class above. */
export function overlayLabelClass(source: ScoreboardSurface["source"] | undefined): string {
  switch (source) {
    case "explicit":
      return "text-neon";
    case "discovery":
      return "text-purple";
    case "default_top_band":
      return "text-yellow";
    default:
      return "text-mut";
  }
}

/**
 * One honest phrase for the provenance, drawn on the box itself.
 * A prior says so in as many words: it is not a measurement of this frame.
 */
export function overlaySourceText(source: ScoreboardSurface["source"] | undefined): string {
  if (source === "default_top_band") return "prior — not measured";
  return scoreboardSourceLabel(source);
}

/** The verdict phrase when the served block carries one; `""` when it does not. */
export function overlayIdentityText(surface: ScoreboardSurface | undefined): string {
  return surface?.identity ? describeSurfaceIdentity(surface.identity) : "";
}

/**
 * The whole label: provenance first, then (when measured) the surface identity.
 * `contradicted` reads "different match"; `absent` reads "unreadable surface"
 * and never claims this is the match's surface.
 */
export function overlayLabel(surface: ScoreboardSurface): string {
  const identity = overlayIdentityText(surface);
  const text = `score bug: ${overlaySourceText(surface.source)}`;
  return identity ? `${text} · ${identity}` : text;
}

/** The normalized box as the display string (`0,0,0.55,0.18`). */
export function overlayRoiText(surface: ScoreboardSurface | undefined): string {
  return formatScoreboardRoi(surface?.roi);
}
