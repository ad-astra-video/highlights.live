// Dataset Curation sliding-window model (ADAAAA-5512, ADAAAA-5509).
//
// The curation UI curates a 30 s @ 10 fps "active window" (≈300 frames) at a
// time, not the whole clip. The window sits on the clip timeline and can be
// dragged left/right, jumped to a time, or auto-advanced to the next 30 s
// block. This module is the pure, browser-free model behind that interaction:
// window positioning/clamping, time→frame mapping, auto-advance stepping, and
// time-jump target selection. Unit-testable without ffmpeg or the DOM (mirrors
// the server's buildExtractArgs approach).

export const WINDOW_LEN = 30; // seconds
export const WINDOW_FPS = 10; // frames per second
export const WINDOW_FRAMES = WINDOW_LEN * WINDOW_FPS; // ≈300

/** Full state of the active curation window on the clip timeline. */
export interface WindowState {
  /** start of the active window on the clip timeline, in seconds */
  start: number;
  /** window length in seconds */
  len: number;
  /** extraction frame rate (frames/second) */
  fps: number;
  /** total clip duration in seconds (null until the clip is probed) */
  clipDuration: number | null;
}

export function defaultWindowState(clipDuration: number | null = null): WindowState {
  return { start: 0, len: WINDOW_LEN, fps: WINDOW_FPS, clipDuration };
}

/** Extract params (inSec/outSec/fps) for the /training/extract call. */
export function windowExtractParams(w: WindowState): { inSec: number; outSec: number; fps: number } {
  return { inSec: w.start, outSec: w.start + w.len, fps: w.fps };
}

/** The latest a window may start so it still fits inside the clip. */
export function maxWindowStart(w: WindowState): number {
  if (w.len <= 0) return 0;
  if (w.clipDuration == null) return Number.POSITIVE_INFINITY;
  return Math.max(0, w.clipDuration - w.len);
}

/** Clamp + quantize a candidate window start to a valid position (0.1 s steps
 * so frame alignment stays exact at 10 fps). */
export function clampWindowStart(w: WindowState, start: number): number {
  if (!Number.isFinite(start) || start < 0) start = 0;
  const max = maxWindowStart(w);
  if (Number.isFinite(max)) start = Math.min(start, max);
  return Math.round(start * 10) / 10;
}

/** wall time (seconds on the clip) of the i-th frame (0-indexed) in the window. */
export function frameTime(w: WindowState, i: number): number {
  return w.start + (w.fps > 0 ? i / w.fps : i);
}

/** Expected frame count for the current window parameters. */
export function windowFrameCount(w: WindowState): number {
  return Math.max(0, Math.round(w.len * w.fps));
}

/** Index of the frame nearest an absolute clip time `t` within the current
 * window, clamped to [0, frameCount-1]. Used to select the landed frame of a
 * time-jump and to map a timeline click to a frame. */
export function nearestFrameIndex(w: WindowState, t: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  const i = Math.round((t - w.start) * w.fps);
  return Math.max(0, Math.min(frameCount - 1, i));
}

/** Advance the window to the next block (sliding window / auto-advance). If
 * the clipDuration is known and the window is already at the end, it stays
 * put (no spurious empty extraction past the clip end). */
export function nextWindow(w: WindowState): WindowState {
  return { ...w, start: clampWindowStart(w, w.start + w.len) };
}

/** Is the given selected frame index at the very end of the window? Reaching
 * it without a time-jump triggers the auto-advance extraction of the next
 * 30 s block. */
export function isAtWindowEnd(w: WindowState, selIdx: number, frameCount: number): boolean {
  return frameCount > 0 && selIdx >= frameCount - 1;
}

/** Window state resulting from a time-jump to clip time `t`. The window is
 * anchored so the requested time is its start (landing frame within ±0.5 s of
 * t at 10 fps). Clamped to the clip. */
export function jumpWindowTo(w: WindowState, t: number): WindowState {
  return { ...w, start: clampWindowStart(w, t) };
}
