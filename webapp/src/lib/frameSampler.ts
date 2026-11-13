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
export interface TickGate {
  tryEnter: () => boolean;
  leave: () => void;
  readonly inFlight: boolean;
}

export function createTickGate(): TickGate {
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

export interface IngestTickOptions {
  gate: TickGate;
  sampler: FrameSampler;
  /** The share's sample video; a tick before its first frame does nothing. */
  source: HTMLVideoElement | null | undefined;
  /** Starts the ingest POST for one frame. The tick owns the gate for the
   *  request's lifetime and releases it when the request settles. */
  post: (image: string) => Promise<unknown>;
  /** Called with the frame only when a POST was actually started. */
  onFrame?: (image: string) => void;
}

/** Run ONE ingest tick against the single-flight gate.
 *
 *  Splitting this out of the interval callback is deliberate: an early return
 *  between `tryEnter()` and the POST used to leave the gate entered forever, so
 *  one frame-less tick silently stopped the whole HTTP ingest rail for the rest
 *  of the share. The gate is now released on every path that does not hand it to
 *  a request (ADAAAA-8848 F4).
 *
 *  Returns true when a POST was started. */
export function runIngestTick({ gate, sampler, source, post, onFrame }: IngestTickOptions): boolean {
  if (!source || !source.videoWidth || !gate.tryEnter()) return false;
  let image: string | null = null;
  try {
    image = sampler.capture(source);
  } catch {
    image = null;
  }
  if (!image) {
    // No pixels (or a dead 2d context): release the gate so the NEXT tick can
    // still run. This was the stall path.
    gate.leave();
    return false;
  }
  onFrame?.(image);
  try {
    void post(image)
      .catch(() => {})
      .finally(() => gate.leave());
  } catch {
    gate.leave();
    return false;
  }
  return true;
}
