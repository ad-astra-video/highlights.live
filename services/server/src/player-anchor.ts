// ADAAAA-7847: the jersey-identify ANCHOR sample.
//
// The one-shot `track-player` identification pass reads the anchor frame the
// perceive session last saw, and that frame is a RAIL sample: 320:180 on the
// live rail (`services/server/src/live.ts`), 640:360 on the VOD detail rail
// (`VOD_FRAME_SCALE`). Jersey OCR needs the number large and sharp, and a
// broadcast wide shot leaves it a few pixels tall at those scales — measured on
// clip `397294f3` (native 1280:720): jersey `11` is read on 14/311 census frames
// at 1280:720, on 13 of those 14 at 960:540, and on 0/311 at either rail scale.
//
// So a jersey request samples its OWN anchor at request time, above the rail
// scale, exactly once:
//
//   * one ffmpeg decode per request (`extractAnchorFrames`, hard-capped by
//     `-frames:v`), from a `spanS` window that ENDS at the operator's moment —
//     the live edge of the recording, or the VOD pass's current position;
//   * frames are handed to perceive newest-first so a match on the freshest
//     frame wins and the seeded bbox is as close to "now" as the decode allows;
//   * the streaming rail, the observation cadence, and the per-frame detection
//     path are NOT touched, and nothing is sampled when no request is made.
//
// A single frame lands on a legible jersey only ~4.5% of the time on the
// measured clip (14/311 frames in four sub-second windows), which is why the
// sample is a short burst rather than one frame: an operator asks for a jersey
// while the player is large in frame, and the burst covers that moment.
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ANCHOR_FRAME_MAX,
  ANCHOR_SPAN_MAX_S,
  ANCHOR_SPAN_MIN_S,
  clampScaleToSource,
  extractAnchorFrames,
  probeVideoSize,
} from "./ffmpeg";

/** One request's anchor sample, as forwarded to the perceive session. */
export interface PlayerAnchorSample {
  /** JPEG data URIs, NEWEST FIRST. Empty when nothing could be sampled. */
  frames: string[];
  /** Effective ffmpeg scale actually used (clamped to the source). */
  scale: string;
  /** Configured scale before clamping. */
  requestedScale: string;
  /** Source pixel size when it could be probed. */
  sourceSize: { width: number; height: number } | null;
  /** Anchor window end (seconds into a VOD source); null = the live edge. */
  atSec: number | null;
  /** Where the sample came from, for the operator-visible diagnostics. */
  origin: "vod-source" | "live-recording";
  /** Wall-clock cost of the sample (decode + read), milliseconds. */
  ms: number;
}

/** Bounds on the sample so a misconfigured env value cannot turn one operator
 * request into a streaming pass (enforced in `buildAnchorFrameArgs`). */
export const PLAYER_ANCHOR_MAX_FRAMES = ANCHOR_FRAME_MAX;
export const PLAYER_ANCHOR_MAX_SPAN_S = ANCHOR_SPAN_MAX_S;
export const PLAYER_ANCHOR_MIN_SPAN_S = ANCHOR_SPAN_MIN_S;
/** Ceiling on the decode itself: a jersey request must answer within seconds
 * even when the source is wedged (the perceive retry window still covers the
 * "not legible yet" case). */
export const PLAYER_ANCHOR_DECODE_TIMEOUT_MS = 8000;

/**
 * Where a `track-player` request decodes its anchor sample from, in priority
 * order (ADAAAA-7847). Pure: the caller checks for an existing, non-empty file.
 *
 * * A VOD (`file`) job samples the uploaded/local source file.
 * * Every live/browser rail samples the FULL-RESOLUTION session recording
 *   (`data/live/<jobId>/session.ts`, or the assembled browser capture) — never
 *   `job.sourceUrl`, which for an rtmp job is the ingest URL: re-opening it to
 *   read one frame would start a SECOND pull of the stream.
 */
export function anchorSourceCandidates(
  job: { id: string; source?: string; sourceUrl?: string } | null | undefined,
  dataDir: string
): string[] {
  if (!job) return [];
  if (job.source === "file") return job.sourceUrl ? [job.sourceUrl] : [];
  const root = path.join(dataDir, "live", job.id);
  return [path.join(root, "session.ts"), path.join(root, "capture.webm"), path.join(root, "capture.mp4")];
}

/** How many frames the configured burst samples, bounded. Pure. */
export function anchorFrameCount(configured: number): number {
  const n = Number.isFinite(configured) ? Math.round(configured) : 8;
  return Math.max(1, Math.min(PLAYER_ANCHOR_MAX_FRAMES, n));
}

/** Anchor window length, bounded. Pure. */
export function anchorSpanSeconds(configured: number): number {
  const s = Number.isFinite(configured) ? configured : 1;
  return Math.max(PLAYER_ANCHOR_MIN_SPAN_S, Math.min(PLAYER_ANCHOR_MAX_SPAN_S, s));
}

/**
 * Anchor time for a VOD pass: the position the pass has reached
 * (`framesAnalyzed` / sampling fps), or null when the pass has not sampled
 * anything yet (queued, or a live/browser job where the live edge is the
 * anchor). Never negative, never past the end of what has been processed.
 *
 * Pure + exported for unit tests.
 */
export function vodAnchorAtSec(
  job: { source?: string; framesAnalyzed?: number } | null | undefined,
  sampleFps: number
): number | null {
  if (!job || job.source !== "file") return null;
  const frames = Number(job.framesAnalyzed ?? 0);
  const fps = Number(sampleFps) > 0 ? Number(sampleFps) : 1;
  if (!Number.isFinite(frames) || frames <= 0) return null;
  return frames / fps;
}

/**
 * Sample the jersey-identify anchor frames for one `track-player` request.
 *
 * Returns null when there is no source to decode (a browser/relay job with no
 * recording on disk, or a source that has gone away). Callers then forward the
 * request WITHOUT an anchor, and perceive falls back to the rail-scale frame —
 * i.e. exactly the pre-ADAAAA-7847 behaviour, never a fabricated anchor.
 */
export async function samplePlayerAnchor(opts: {
  ffmpegPath: string;
  /** Recording / source file to sample from; null when none is on disk. */
  source: string | null;
  /** Configured `PLAYER_ANCHOR_FRAME_SCALE` (default 1280:720). */
  scale: string;
  /** Configured `PLAYER_ANCHOR_FRAMES`. */
  count: number;
  /** Configured `PLAYER_ANCHOR_SPAN_S`. */
  spanS: number;
  /** VOD anchor time (seconds); null/undefined = live edge. */
  atSec?: number | null;
  /** Scratch dir for the decoded frames (removed after the read). */
  outDir: string;
  /** Max decode time; defaults to PLAYER_ANCHOR_DECODE_TIMEOUT_MS. */
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<PlayerAnchorSample | null> {
  const started = Date.now();
  if (!opts.source) return null;
  const frames = anchorFrameCount(opts.count);
  const span = anchorSpanSeconds(opts.spanS);
  const atSec = opts.atSec != null && Number.isFinite(opts.atSec) ? Math.max(0, opts.atSec) : null;
  const origin: PlayerAnchorSample["origin"] = atSec == null ? "live-recording" : "vod-source";
  const sourceSize = await probeVideoSize(opts.ffmpegPath, opts.source);
  const scale = clampScaleToSource(opts.scale || "1280:720", sourceSize);
  let files: string[];
  try {
    files = await extractAnchorFrames({
      ffmpegPath: opts.ffmpegPath,
      source: opts.source,
      scale,
      count: frames,
      spanS: span,
      atSec: atSec ?? undefined,
      outDir: opts.outDir,
      timeoutMs: opts.timeoutMs ?? PLAYER_ANCHOR_DECODE_TIMEOUT_MS,
      signal: opts.signal,
    });
  } catch (e: any) {
    // A failed decode is not a failed request: the identify pass still runs on
    // the rail-scale anchor and the console reports the honest outcome.
    console.error(`[player-anchor] sample failed (${path.basename(opts.source)}):`, e?.message || e);
    return null;
  }
  const encoded: string[] = [];
  try {
    for (const f of files) {
      try {
        const buf = await readFile(f);
        if (buf.length) encoded.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
      } catch {
        /* a frame we cannot read is simply not offered */
      }
    }
  } finally {
    // The decoded JPEGs are only ever read into the control payload; drop them
    // so repeated requests cannot fill the data dir.
    const { rm } = await import("node:fs/promises");
    await rm(opts.outDir, { recursive: true, force: true }).catch(() => {});
  }
  if (!encoded.length) return null;
  return {
    frames: encoded,
    scale,
    requestedScale: opts.scale || "1280:720",
    sourceSize,
    atSec,
    origin,
    ms: Date.now() - started,
  };
}
