// ONE canvas + ONE 2d context per share, reused on every WS/HTTP fallback tick
// (ADAAAA-8848 F4).
//
// The old sampler created a canvas and a 2d context per tick (every second) and
// let them be garbage-collected, plus fired a fire-and-forget ingest POST with no
// in-flight cap. One reused canvas removes the per-tick allocation, and the
// caller's single-flight gate (see `createTickGate`) keeps at most one ingest
// POST pending so a slow uplink cannot stack requests.

/** Frame the fallback rails sample. Decide reads a bounded frame budget, so a
 *  320x180 JPEG is the evidence size; more pixels are not used. */
export const SAMPLE_WIDTH = 320;
export const SAMPLE_HEIGHT = 180;
export const SAMPLE_JPEG_QUALITY = 0.6;

export interface FrameSamplerOptions {
  width?: number;
  height?: number;
  quality?: number;
  /** Injectable for tests; production uses `document.createElement`. */
  createCanvas?: () => HTMLCanvasElement;
}

export interface FrameSampler {
  /** The single canvas this sampler owns for the whole share. */
  readonly canvas: HTMLCanvasElement;
  /** Draws the source's current frame and returns the JPEG payload (no data-URL
   *  prefix). `null` when the source has no pixels yet. */
  capture(source: HTMLVideoElement): string | null;
  dispose(): void;
}

/** Build a sampler that owns exactly one canvas + one 2d context. */
export function createFrameSampler(options: FrameSamplerOptions = {}): FrameSampler {
  const width = options.width ?? SAMPLE_WIDTH;
  const height = options.height ?? SAMPLE_HEIGHT;
  const quality = options.quality ?? SAMPLE_JPEG_QUALITY;
  const createCanvas = options.createCanvas ?? (() => document.createElement("canvas"));
  const canvas = createCanvas();
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  return {
    canvas,
    capture(source: HTMLVideoElement): string | null {
      if (!source || !source.videoWidth || !context) return null;
      context.drawImage(source, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", quality).split(",")[1] ?? null;
    },
    dispose() {
      // Drop the backing store promptly instead of waiting for GC.
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

/** Single-flight gate for a fire-and-forget POST: `tryEnter()` returns false
 *  while one request is still pending, so ticks are SKIPPED rather than queued.
 *  The WS rail does not need it (a WS send is not an HTTP request), but the HTTP
 *  ingest rail does. */
export function createTickGate(): { tryEnter: () => boolean; leave: () => void; get inFlight(): boolean } {
  let inFlight = false;
  return {
    tryEnter() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    leave() {
      inFlight = false;
    },
    get inFlight() {
      return inFlight;
    },
  };
}
