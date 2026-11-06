// ffmpeg helpers: extract 1fps JPEG frames from a source file, and cut a clip.
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);

/** Probe a source's duration (seconds) via ffprobe. Used by the curation UI's
 * sliding-window carousel to bound the timeline. Returns null when the source
 * cannot be probed (non-fatal — the UI can keep extracting from an unbounded
 * timeline). */
export async function probeDuration(ffmpegPath: string, source: string): Promise<number | null> {
  const ffprobe = ffmpegPath.replace(/ffmpeg([^/]*)$/, "ffprobe$1") || "ffprobe";
  try {
    const { stdout } = await exec(ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      source,
    ]);
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/** The newest timestamp (seconds) the recording FILE on disk actually carries —
 * i.e. how much footage has been flushed to disk, as opposed to how far the
 * live rail has ANALYSED (ADAAAA-8113). A live recording is appended in ~1 s
 * chunks and a streamable webm/mp4 only writes its duration when it is
 * finalised, so `format=duration` reads N/A for the whole share and
 * `probeDuration` returns null — which left the live cut's completeness guard
 * blind and published a sub-floor clip. Demux the file (no decode) and report
 * the last packet's pts plus its own duration instead.
 *
 * Returns null when the file holds no readable packet yet (header-only capture,
 * a missing/empty file), so callers keep their previous, honest behaviour
 * instead of inventing footage. */

export async function probeFlushedDuration(ffmpegPath: string, source: string): Promise<number | null> {
  const ffprobe = ffmpegPath.replace(/ffmpeg([^/]*)$/, "ffprobe$1") || "ffprobe";
  const newestOf = async (select: string[]): Promise<number | null> => {
    let stdout = "";
    try {
      ({ stdout } = await exec(
        ffprobe,
        [
          "-v", "error",
          ...select,
          "-show_entries", "packet=pts_time,duration_time",
          "-of", "csv=p=0",
          source,
        ],
        { maxBuffer: 32 * 1024 * 1024 }
      ));
    } catch (e: any) {
      // A chunk still being appended ends mid-cluster: ffprobe exits non-zero
      // after printing every packet it could read. Keep what it read — that is
      // exactly the flushed coverage this helper measures.
      stdout = String(e?.stdout ?? "");
    }
    let newest = -1;
    let ownDur = 0;
    for (const line of stdout.split("\n")) {
      const [ptsS, durS] = line.trim().split(",");
      const pts = parseFloat(ptsS);
      if (!Number.isFinite(pts)) continue;
      if (pts > newest) {
        newest = pts;
        ownDur = parseFloat(durS) || 0;
      }
    }
    return newest >= 0 ? newest + Math.max(0, ownDur) : null;
  };
  // Video first (a browser share always carries one); fall back to every stream
  // so an audio-only recording still measures instead of reading as empty.
  return (await newestOf(["-select_streams", "v:0"])) ?? (await newestOf([]));
}

/** ADAAAA-8152: the result of locating one picture inside a recording.
 *
 * The live lane has TWO clocks: the media rail's content clock (which the
 * analyzer used to pick `localizedTs`) and the recording file's own timeline.
 * They are not the same axis — the rail timestamps frames when the media node
 * analyzes them (~1.5-6 s after capture on the 8159 leg), and the uploader's
 * chunks land late, so seeking a clip at the content instant lands the goal
 * seconds before the intended offset. Pixel-matching the evidence frame the
 * accept itself rested on is the one measurement that needs no clock model. */
export interface FrameMatch {
  /** The recording-file instant that carries the matched picture. */
  fileTs: number;
  /** Normalized mean-squared error at the match (0 = identical picture). */
  score: number;
  /** Best score at least one second away from the match — the uniqueness check. */
  runnerUp: number;
  /** Sampling rate of the (refined) probe. */
  fps: number;
  /** Frames the probe actually produced. */
  frames: number;
  /** Timestamp of the earliest sampled frame — a delivered file's own origin. */
  firstTs: number;
  searchStart: number;
  searchDur: number;
}

/** Mean-and-std normalise a gray frame so a codec/scale difference between the
 * evidence JPEG and the recording does not win the comparison. */
export function normalizeGray(frame: Uint8Array | Float32Array): Float32Array {
  const n = frame.length;
  const out = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += frame[i];
  const mean = n > 0 ? sum / n : 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = frame[i] - mean;
    sq += d * d;
  }
  const std = Math.sqrt(n > 0 ? sq / n : 0);
  const inv = 1 / (std > 1e-6 ? std : 1e-6);
  for (let i = 0; i < n; i++) out[i] = (frame[i] - mean) * inv;
  return out;
}

/** Pick the frame that best matches `query` plus the best score at least
 * `minGapFrames` away, so a caller can require a UNIQUE match instead of
 * accepting whichever of many near-identical frames sorted first. */
export function bestFrameMatch(
  vecs: Float32Array[],
  query: Float32Array,
  minGapFrames: number
): { index: number; score: number; runnerUp: number } {
  const dist = (v: Float32Array): number => {
    let acc = 0;
    const n = Math.min(v.length, query.length);
    for (let k = 0; k < n; k++) {
      const d = v[k] - query[k];
      acc += d * d;
    }
    return acc / (n || 1);
  };
  let index = -1;
  let score = Infinity;
  for (let i = 0; i < vecs.length; i++) {
    const d = dist(vecs[i]);
    if (d < score) {
      score = d;
      index = i;
    }
  }
  let runnerUp = Infinity;
  for (let i = 0; i < vecs.length; i++) {
    if (Math.abs(i - index) < minGapFrames) continue;
    const d = dist(vecs[i]);
    if (d < runnerUp) runnerUp = d;
  }
  return { index, score, runnerUp };
}

/** Decode one image file (the analyzer's evidence JPEG) to a normalized
 * SIZE×SIZE grayscale vector. Null when ffmpeg cannot read it. */
export async function imageGrayVector(
  ffmpegPath: string,
  imagePath: string,
  size = 64
): Promise<Float32Array | null> {
  const raw = await readGrayFrames(ffmpegPath, ["-i", imagePath], `scale=${size}:${size}:flags=bilinear,format=gray`, size);
  return raw && raw.vecs.length ? raw.vecs[0] : null;
}

/** Sample `source` in [startS, startS+durS) at `fps` into normalized
 * SIZE×SIZE grayscale vectors, with the ABSOLUTE source timestamp of every
 * frame. `-copyts` keeps the original timeline across the `-ss`, and
 * `showinfo` reports the pts each sampled frame actually carries, so the
 * caller never has to assume where a cue-less webm's seek landed. */
export async function sampleGrayStrip(
  ffmpegPath: string,
  source: string,
  startS: number,
  durS: number,
  fps: number,
  size = 64
): Promise<{ ts: number[]; vecs: Float32Array[] } | null> {
  const raw = await readGrayFrames(
    ffmpegPath,
    ["-copyts", "-ss", String(Math.max(0, startS)), "-t", String(Math.max(0.2, durS)), "-i", source],
    `fps=${fps},scale=${size}:${size}:flags=bilinear,format=gray,showinfo`,
    size
  );
  if (!raw || !raw.vecs.length) return null;
  const ts: number[] = [];
  for (let i = 0; i < raw.vecs.length; i++) {
    const reported = raw.pts[i];
    // A probe whose stderr lost a line still gets a usable grid.
    ts.push(Number.isFinite(reported) ? reported : startS + i / fps);
  }
  return { ts, vecs: raw.vecs };
}

/** Locate `imagePath`'s picture inside `source` within
 * [searchStartS, searchStartS + searchDurS). Two passes: an 8 fps sweep for the
 * neighbourhood, then a 20 fps refine around the winner. Returns null when the
 * probe or the evidence image cannot be read.

 * `minScoreGap` guards uniqueness: a picture that repeats (a static wide shot,
 * a replay) still matches, but the runner-up must sit clearly above the match
 * so the caller can tell "found it" from "found something similar". */
export async function locateImageInSource(
  ffmpegPath: string,
  source: string,
  imagePath: string,
  searchStartS: number,
  searchDurS: number,
  opts: { size?: number; coarseFps?: number; refineFps?: number } = {}
): Promise<FrameMatch | null> {
  const size = opts.size ?? 64;
  const coarseFps = opts.coarseFps ?? 8;
  const refineFps = opts.refineFps ?? 20;
  const query = await imageGrayVector(ffmpegPath, imagePath, size);
  if (!query) return null;
  const coarse = await sampleGrayStrip(ffmpegPath, source, searchStartS, searchDurS, coarseFps, size);
  if (!coarse) return null;
  const first = bestFrameMatch(coarse.vecs, query, coarseFps);
  if (first.index < 0) return null;
  const hitTs = coarse.ts[first.index];
  // Refine: re-probe ±0.6 s around the coarse hit at 20 fps. Cheap (a couple of
  // decoded frames) and it turns a ±125 ms sweep into a ±25 ms answer, which is
  // what makes the stored audit value worth reading.
  const refined = await sampleGrayStrip(ffmpegPath, source, Math.max(0, hitTs - 0.6), 1.2, refineFps, size);
  if (!refined || !refined.vecs.length) {
    return {
      fileTs: hitTs,
      score: first.score,
      runnerUp: first.runnerUp,
      fps: coarseFps,
      frames: coarse.vecs.length,
      firstTs: coarse.ts[0],
      searchStart: searchStartS,
      searchDur: searchDurS,
    };
  }
  const second = bestFrameMatch(refined.vecs, query, refineFps);
  if (second.index < 0 || second.score > first.score) {
    return {
      fileTs: hitTs,
      score: first.score,
      runnerUp: first.runnerUp,
      fps: coarseFps,
      frames: coarse.vecs.length,
      firstTs: coarse.ts[0],
      searchStart: searchStartS,
      searchDur: searchDurS,
    };
  }
  return {
    fileTs: refined.ts[second.index],
    score: second.score,
    runnerUp: Math.min(second.runnerUp, Math.max(first.runnerUp, second.score)),
    fps: refineFps,
    frames: coarse.vecs.length + refined.vecs.length,
    firstTs: coarse.ts[0],
    searchStart: searchStartS,
    searchDur: searchDurS,
  };
}

/** Shared raw-gray decode: one ffmpeg process, stdout = SIZE×SIZE gray frames,
 * stderr's showinfo lines = the pts of each frame in order. */
async function readGrayFrames(
  ffmpegPath: string,
  inputArgs: string[],
  filter: string,
  size: number
): Promise<{ vecs: Float32Array[]; pts: number[] } | null> {
  let stdout: Buffer = Buffer.alloc(0);
  let stderr = "";
  try {
    const res = await exec(ffmpegPath, ["-hide_banner", "-nostdin", "-loglevel", "info", ...inputArgs, "-an", "-vf", filter, "-f", "rawvideo", "-pix_fmt", "gray", "-"], {
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
    } as any);
    stdout = res.stdout as Buffer;
    stderr = String(res.stderr ?? "");
  } catch (e: any) {
    // A recording still mid-append can end a cluster short: keep what decoded.
    stdout = (e?.stdout as Buffer) ?? Buffer.alloc(0);
    stderr = String(e?.stderr ?? "");
    if (!stdout.length) return null;
  }
  const frameBytes = size * size;
  const count = Math.floor(stdout.length / frameBytes);
  if (!count) return null;
  const vecs: Float32Array[] = new Array(count);
  for (let i = 0; i < count; i++) {
    vecs[i] = normalizeGray(stdout.subarray(i * frameBytes, (i + 1) * frameBytes));
  }
  const pts: number[] = [];
  const re = /pts_time:(-?[0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) pts.push(parseFloat(m[1]));
  return { vecs, pts };
}

/** ADAAAA-8152: locate the evidence picture in `source`, cut so it sits `beforeS`
 * into the window, then VERIFY on the delivered file and re-cut once if the
 * seek landed somewhere else.
 *
 * Why verify at all: `-ss` is an INPUT option on purpose (ADAAAA-8106: seeking
 * after `-i` decodes the whole recording up to the in-point), and an input seek
 * starts the output at the preceding KEYFRAME, not at the requested instant — a
 * 24 s h264 recording cut at 1.0 s delivered a 16.2 s file starting at 0.2 s in
 * this repo's own fixture. That pre-roll is invisible to the caller but shifts
 * the goal's offset inside the clip, which is exactly what ACC-2 grades. So:
 * cut, re-locate the same picture in the delivered file, and if its offset is
 * off by more than `recutTolSec`, shift the start by the measured error and cut
 * once more. Costs one extra probe (~0.1-0.3 s) and at most one extra encode
 * (~0.2 s) — CPU only, no pipeline calls (AC4).
 *
 * Returns `mode: "content_clock"` (and does NOT cut) when the picture is not in
 * the recording or the match is not confident, so the caller keeps its existing
 * cut as the honest fallback. */
export interface CenteredCut {
  mode: "frame_match" | "content_clock";
  cutStart: number;
  dur: number;
  /** Position of the picture in the source recording. */
  fileTs: number | null;
  /** Offset of the picture inside the DELIVERED file, from its first frame —
   * the number ACC-2 grades and the row stores. */
  deliveredOffset: number | null;
  score: number | null;
  runnerUp: number | null;
  clamped: boolean;
  recuts: number;
  cut: ClipCutResult | null;
}

export async function centerClipOnEvidence(
  ffmpegPath: string,
  source: string,
  outPath: string,
  imagePath: string,
  beforeS: number,
  durS: number,
  opts: {
    searchStartS: number;
    searchDurS: number;
    maxScore?: number;
    strongScore?: number;
    minGap?: number;
    recutTolSec?: number;
  }
): Promise<CenteredCut> {
  const maxScore = opts.maxScore ?? 0.6;
  const strongScore = opts.strongScore ?? 0.1;
  const minGap = opts.minGap ?? 0.5;
  const recutTol = opts.recutTolSec ?? 1.2;
  const none: CenteredCut = {
    mode: "content_clock",
    cutStart: 0,
    dur: durS,
    fileTs: null,
    deliveredOffset: null,
    score: null,
    runnerUp: null,
    clamped: false,
    recuts: 0,
    cut: null,
  };
  const match = await locateImageInSource(
    ffmpegPath,
    source,
    imagePath,
    opts.searchStartS,
    opts.searchDurS
  ).catch(() => null);
  if (!match) return none;
  const confident =
    match.score <= maxScore && (match.score <= strongScore || match.runnerUp >= Math.max(minGap, match.score * 3));
  if (!confident) {
    return { ...none, fileTs: match.fileTs, score: match.score, runnerUp: match.runnerUp };
  }
  const wanted = match.fileTs - beforeS;
  const clamped = wanted < 0;
  let cutStart = Math.max(0, wanted);
  let cut = await cutClip(ffmpegPath, source, outPath, cutStart, durS);
  let recuts = 0;
  let deliveredOffset = await measureOffsetInFile(ffmpegPath, outPath, imagePath, durS, match.score);
  if (deliveredOffset != null && Math.abs(deliveredOffset - beforeS) > recutTol && recuts < 1) {
    const corrected = Math.max(0, cutStart + (deliveredOffset - beforeS));
    if (Math.abs(corrected - cutStart) > 0.01) {
      cutStart = corrected;
      cut = await cutClip(ffmpegPath, source, outPath, cutStart, durS);
      recuts += 1;
      const again = await measureOffsetInFile(ffmpegPath, outPath, imagePath, durS, match.score);
      if (again != null) deliveredOffset = again;
    }
  }
  return {
    mode: "frame_match",
    cutStart,
    dur: durS,
    fileTs: match.fileTs,
    deliveredOffset,
    score: match.score,
    runnerUp: match.runnerUp,
    clamped,
    recuts,
    cut,
  };
}

/** Where the picture sits inside `filePath`, measured from the file's own first
 * frame (a player starts there regardless of the container's `start_time`). */
async function measureOffsetInFile(
  ffmpegPath: string,
  filePath: string,
  imagePath: string,
  durS: number,
  _expectedScore: number
): Promise<number | null> {
  const m = await locateImageInSource(ffmpegPath, filePath, imagePath, 0, durS).catch(() => null);
  if (!m || m.firstTs == null) return null;
  return m.fileTs - m.firstTs;
}

/** Time window (seconds) to restrict a frame extraction to a sub-range of the
 * source. Omitted bounds mean "from the start" / "to the end". */
export interface FrameWindow {
  inSec?: number;
  outSec?: number;
}

// ffmpeg's stderr leads with a long version/config banner; the actionable error
// is buried at the tail. Pull out the lines that actually describe the failure
// (HTTP status, missing file, permissions, connection, decode errors) so the API
// can return a readable message instead of the raw CLI dump.
function meaningfulFfmpegError(stderr: string): string {
  const keep = /(error|not found|no such|invalid|permission|denied|unable|failed|cannot|server returned|http error|connection|timed|404|403|406|500|format not|bitrate not|illegal|invalid data|no vaapi|configure|unable to open)/i;
  const lines = (stderr || "").split("\n").filter((l) => {
    const s = l.trim();
    if (!s) return false;
    // drop the preamble banner + build config lines
    if (/^(ffmpeg version|built with|configuration:|libav|  )/.test(s)) return false;
    return keep.test(s) && !/error while writing|error_log|at /.test(s);
  });
  const tail = lines.slice(-6);
  if (!tail.length) return `ffmpeg failed (no detail)`;
  const msg = tail.map((l) => l.trim()).join("; ");
  return msg.length > 500 ? msg.slice(0, 500) + "…" : msg;
}

async function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  signal?: AbortSignal,
  opts?: { timeout?: number }
): Promise<void> {
  try {
    // ADAAAA-6625: an optional AbortSignal lets a cancelled VOD job kill the
    // ffmpeg child instead of letting it decode the rest of the file. execFile
    // reaps the child on abort and rejects with an AbortError.
    //
    // ADAAAA-7847: `opts.timeout` bounds the one-shot jersey-identify anchor
    // sample so a wedged decode can never hold an operator's request open.
    const execOpts: { signal?: AbortSignal; timeout?: number } = {};
    if (signal) execOpts.signal = signal;
    if (opts?.timeout) execOpts.timeout = opts.timeout;
    await exec(ffmpegPath, args, Object.keys(execOpts).length ? execOpts : undefined);
  } catch (e: any) {
    // A cancelled extraction is not an ffmpeg failure — surface it as such so
    // callers (the VOD stop path) can distinguish stop from a real decode error.
    if (signal?.aborted) {
      const aborted = new Error("ffmpeg: extraction aborted");
      aborted.name = "AbortError";
      throw aborted;
    }
    const stderr = String(e?.stderr || e?.message || "");
    const reason = meaningfulFfmpegError(stderr);
    throw new Error(`ffmpeg: ${reason}`);
  }
}

/** Probe whether `source` carries an audio stream. Used at clip-cut time so the
 * highlight can record `hasAudio` and the UI can surface an explicit
 * "no audio captured" state for a silent clip (ADAAAA-7248) instead of implying
 * sound. A source with no audio stream (e.g. a screen/window share, or an
 * audio-less VOD upload) yields `false`; an inevitable ffprobe failure returns
 * `null` so the caller can degrade to "unknown" rather than mislabeling audio. */
export async function probeHasAudio(ffmpegPath: string, source: string): Promise<boolean | null> {
  const ffprobe = ffmpegPath.replace(/ffmpeg([^/]*)$/, "ffprobe$1") || "ffprobe";
  try {
    const { stdout } = await exec(ffprobe, [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=codec_type",
      "-of", "default=noprint_wrappers=1:nokey=1",
      source,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return null;
  }
}

/** Probe a video stream's pixel size. Used by the jersey-identify anchor sample
 * (ADAAAA-7847) so the anchor scale is clamped to the source: a request must
 * never ask the decoder to upscale, because an upscaled jersey adds no detail
 * and only inflates the OCR pass. Returns null when the source cannot be
 * probed, in which case the caller uses the configured scale as-is. */
export async function probeVideoSize(
  ffmpegPath: string,
  source: string
): Promise<{ width: number; height: number } | null> {
  const ffprobe = ffmpegPath.replace(/ffmpeg([^/]*)$/, "ffprobe$1") || "ffprobe";
  try {
    const { stdout } = await exec(ffprobe, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      source,
    ]);
    const [w, h] = stdout.trim().split(",").map((v) => parseInt(v, 10));
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { width: w, height: h } : null;
  } catch {
    return null;
  }
}

/** Clamp a `W:H` (or `WxH`) frame scale to a source size so the anchor sample
 * never upscales (ADAAAA-7847). Returns ffmpeg's aspect-preserving
 * `min(W,iw):-2` form when the target is wider than the source, so the height
 * follows the source aspect instead of being forced to the target's.
 *
 * Pure + exported for unit tests. */
export function clampScaleToSource(
  scale: string,
  source: { width: number; height: number } | null
): string {
  const m = /^(\d+)\s*[:x]\s*(\d+)$/.exec(String(scale ?? "").trim());
  if (!m) return scale;
  const tw = parseInt(m[1], 10);
  const th = parseInt(m[2], 10);
  if (!source || source.width <= 0) return `${tw}:${th}`;
  if (tw > source.width || th > source.height) {
    // ffmpeg filter syntax: the comma inside min() must be escaped.
    return `min(${tw}\\,iw):-2`;
  }
  return `${tw}:${th}`;
}

/** Bounds for the jersey-identify anchor sample (ADAAAA-7847). Enforced where
 * the ffmpeg args are built, so no caller (env misconfiguration included) can
 * turn one operator request into a second streaming pass. */
export const ANCHOR_FRAME_MAX = 12;
export const ANCHOR_SPAN_MIN_S = 0.2;
export const ANCHOR_SPAN_MAX_S = 5;
/** How many bytes of a growing live recording are copied to read its tail. At a
 * typical 1.5-6 Mbit/s 720p recording this covers several seconds of content,
 * which is what `-sseof` needs behind it to land on the operator's moment. */
export const ANCHOR_TAIL_COPY_BYTES = 4 * 1024 * 1024;

/** Args for the ONE-SHOT jersey-identify anchor sample (ADAAAA-7847).
 *
 * One decode per request, from a `spanS`-long window that ENDS at the request
 * moment: `atSec` set means a VOD pass at a known position, absent means the
 * live edge (the tail of the recording passed in as `source`). `-frames:v count`
 * bounds it hard, so a request can never turn into a second streaming pass.
 * Exported for unit tests. */
export function buildAnchorFrameArgs(opts: {
  source: string;
  outDir: string;
  scale: string;
  count: number;
  fps?: number;
  spanS?: number;
  /** Anchor time in seconds (VOD). Omitted = the live edge of `source`. */
  atSec?: number;
  /** Seek AFTER `-i` (decode-and-discard) instead of at the demuxer. Needed for
   * a tail copy of a live recording: an input seek lands after the copy's last
   * keyframe and decodes zero frames, while an output-side seek starts at the
   * copy's first keyframe and drops to the target. */
  seekAfterInput?: boolean;
  /** Suppress decoder chatter (a tail copy legitimately starts mid-packet and
   * logs "non-existing PPS" errors before it resyncs on the next keyframe). */
  quiet?: boolean;
}): string[] {
  const count = Math.max(1, Math.min(ANCHOR_FRAME_MAX, Math.round(opts.count || 1)));
  const spanRaw = opts.spanS ?? 1.5;
  const span = Math.max(ANCHOR_SPAN_MIN_S, Math.min(ANCHOR_SPAN_MAX_S, Number.isFinite(spanRaw) ? spanRaw : 1.5));
  const fps = opts.fps ?? Math.max(1, count / span);
  const args: string[] = ["-y", "-hide_banner", "-loglevel", opts.quiet ? "quiet" : "error"];
  const hasAt = opts.atSec != null && Number.isFinite(opts.atSec);
  if (hasAt && opts.seekAfterInput) {
    // Output-side seek on a STATIC file (the tail copy): decode from its first
    // keyframe, drop until the target.
    args.push("-i", opts.source, "-ss", String(Math.max(0, (opts.atSec as number) - span)));
  } else if (hasAt) {
    // Fast demuxer seek to the START of the window, then decode `span` seconds.
    args.push("-ss", String(Math.max(0, (opts.atSec as number) - span)));
    args.push("-i", opts.source, "-t", String(span));
  } else {
    // Live edge: `-sseof` seeks relative to the CURRENT end of `source`.
    args.push("-sseof", `-${span}`, "-i", opts.source);
  }
  args.push(
    "-an",
    "-vf", `fps=${fps.toFixed(3)},scale=${opts.scale}`,
    "-q:v", "3",
    "-frames:v", String(count),
    path.join(opts.outDir, "anchor_%02d.jpg")
  );
  return args;
}

/**
 * Copy the last `maxBytes` of `src` to `dest` (ADAAAA-7847).
 *
 * Needed because the live ingest recording is GROWING while the request runs:
 * `-sseof`/`-ss` against it measure against a moving, non-zero `start_time`
 * timeline and decode ZERO frames (measured on a synthetic live MPEG-TS). A
 * bounded tail copy is a complete short file, so `-sseof` works on it.
 * Returns the byte count copied, or null when the source cannot be read.
 */
export async function copyTailBytes(src: string, dest: string, maxBytes: number): Promise<number | null> {
  const { stat, open, writeFile } = await import("node:fs/promises");
  try {
    const st = await stat(src);
    if (!st.size) return null;
    const start = Math.max(0, st.size - Math.max(1, maxBytes));
    const want = st.size - start;
    const fh = await open(src, "r");
    let bytesRead = 0;
    try {
      const buf = Buffer.alloc(want);
      bytesRead = (await fh.read(buf, 0, want, start)).bytesRead;
      if (!bytesRead) return null;
      await writeFile(dest, buf.subarray(0, bytesRead));
    } finally {
      await fh.close();
    }
    return bytesRead;
  } catch {
    return null;
  }
}

/** Sample the jersey-identify anchor frames for one request (ADAAAA-7847).
 *
 * Returns the frame files NEWEST-FIRST (the window is decoded oldest -> newest,
 * so the list is reversed before it is returned): the caller identifies against
 * them in that order so a match on the freshest frame wins and the seeded bbox
 * is as close to the operator's moment as the decode allows. A source that
 * cannot be decoded yields an empty list — the request then falls back to the
 * rail-scale anchor exactly as before this change.
 *
 * Live edge (`atSec` omitted): the extraction runs against a bounded COPY of
 * the recording's tail, because a growing MPEG-TS decodes zero frames from
 * `-sseof`/absolute seeks. When that copy yields nothing (a source that is not
 * decodable at all) the plain form on the original is tried once, which is what
 * a completed/static recording needs.
 */
export async function extractAnchorFrames(opts: {
  ffmpegPath: string;
  source: string;
  scale: string;
  count: number;
  spanS?: number;
  atSec?: number;
  outDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Tail-copy size for the live edge; defaults to ANCHOR_TAIL_COPY_BYTES. */
  tailCopyBytes?: number;
}): Promise<string[]> {
  const { mkdir, rm } = await import("node:fs/promises");
  await rm(opts.outDir, { recursive: true, force: true });
  await mkdir(opts.outDir, { recursive: true });
  const jpegs = async () =>
    (await readdir(opts.outDir)).filter((f) => f.endsWith(".jpg")).sort().map((f) => path.join(opts.outDir, f)).reverse();
  const run = (args: string[]) =>
    runFfmpeg(opts.ffmpegPath, args, opts.signal, opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined);

  const isLiveEdge = opts.atSec == null || !Number.isFinite(opts.atSec);
  if (isLiveEdge) {
    // A GROWING MPEG-TS recording decodes ZERO frames from `-sseof`/absolute
    // seeks (measured on a synthetic live MPEG-TS: both forms output nothing).
    // Read a bounded COPY of its tail instead — a static short file — then seek
    // the COPY from the output side, which only needs its first keyframe.
    const tail = path.join(opts.outDir, "tail.ts");
    const copied = await copyTailBytes(opts.source, tail, opts.tailCopyBytes ?? ANCHOR_TAIL_COPY_BYTES);
    if (copied) {
      const copiedSec = await probeDuration(opts.ffmpegPath, tail);
      if (copiedSec != null) {
        try {
          const frames = await (async () => {
            await run(buildAnchorFrameArgs({ ...opts, source: tail, atSec: copiedSec, seekAfterInput: true, quiet: true }));
            return jpegs();
          })();
          if (frames.length) return frames;
        } catch {
          /* fall through to the plain form on the original */
        }
      }
    }
  }
  // VOD position, or a completed/static recording (where `-sseof` is exact).
  await run(buildAnchorFrameArgs(opts));
  return jpegs();
}


/** Build ffmpeg args for a frame extraction. Pure + exported so the sliding
 * window positioning can be unit-tested without invoking ffmpeg. `-ss` before
 * `-i` fast-seeks at the demuxer; `-to` after `-i` stops decoding at outSec,
 * producing only frames inside the [inSec, outSec] window. */
export function buildExtractArgs(opts: {
  source: string;
  outDir: string;
  fps?: number;
  scale?: string;
  window?: FrameWindow;
}): string[] {
  const fps = opts.fps ?? 1;
  const scale = opts.scale ?? "320:180";
  const inSec = opts.window?.inSec ?? 0;
  const hasIn = inSec > 0;
  const hasOut = opts.window?.outSec != null;
  const args: string[] = ["-y"];
  // `-ss` before `-i` fast-seeks at the demuxer. When an in-point is set,
  // bound the decode with `-t <duration>` (outSec - inSec) rather than `-to
  // <outSec>`: with input seeking, `-to` is measured from the original stream
  // start, not the seek point, so it would over-run the window (ADAAAA-5512
  // time-jump accuracy). `-t` is a duration from the seek point, giving an
  // exact [inSec, inSec + (outSec - inSec)] window. With no in-point, `-to`
  // is correct (from the stream start).
  if (hasIn) args.push("-ss", String(inSec));
  args.push("-i", opts.source);
  if (hasOut && hasIn) args.push("-t", String(opts.window!.outSec! - inSec));
  else if (hasOut) args.push("-to", String(opts.window!.outSec!));
  args.push(
    "-vf", `fps=${fps},scale=${scale}`,
    "-q:v", "3",
    path.join(opts.outDir, "frame_%04d.jpg"),
  );
  return args;
}

export async function extractFrames(
  ffmpegPath: string,
  source: string,
  outDir: string,
  fps = 1,
  scale = "320:180",
  window?: FrameWindow,
  /** Optional cancel signal (ADAAAA-6625): a stopped VOD job kills the decode. */
  signal?: AbortSignal,
  /**
   * ADAAAA-7906 (VOD resume): `mode: "resume"` PRESERVES an existing frame
   * directory instead of wiping it. A resume must not `rm -rf` the frames the
   * previous attempt paid to produce; the caller decides reusable-vs-fresh via
   * `extractionReusable(...)` and passes `"fresh"` whenever it re-extracts.
   */
  opts: { mode?: "fresh" | "resume" } = {}
): Promise<string[]> {
  const { mkdir, rm } = await import("node:fs/promises");
  if (opts.mode !== "resume") {
    await rm(outDir, { recursive: true, force: true });
  }
  await mkdir(outDir, { recursive: true });
  await runFfmpeg(ffmpegPath, buildExtractArgs({ source, outDir, fps, scale, window }), signal);
  const files = (await readdir(outDir)).filter((f) => f.endsWith(".jpg")).sort();
  return files.map((f) => path.join(outDir, f));
}

/** Container + codecs of a media source, as far as a clip cut needs them. */
export interface MediaFormat {
  /** ffprobe `format_name`, e.g. "matroska,webm" or "mov,mp4,m4a,3gp,3g2,mj2". */
  container: string;
  videoCodec: string | null;
  audioCodec: string | null;
}

/** Probe a source's container + stream codecs. Returns null when the source
 * cannot be probed (a corrupt/partial file) — callers then degrade to the
 * historical stream-copy behaviour rather than failing before ffmpeg runs. */
export async function probeMediaFormat(ffmpegPath: string, source: string): Promise<MediaFormat | null> {
  const ffprobe = ffmpegPath.replace(/ffmpeg([^/]*)$/, "ffprobe$1") || "ffprobe";
  try {
    const { stdout } = await exec(ffprobe, [
      "-v", "error",
      "-show_entries", "format=format_name:stream=codec_type,codec_name",
      "-of", "json",
      source,
    ]);
    const j = JSON.parse(stdout) as {
      format?: { format_name?: string };
      streams?: { codec_type?: string; codec_name?: string }[];
    };
    const streams = j.streams ?? [];
    const video = streams.find((s) => s.codec_type === "video");
    const audio = streams.find((s) => s.codec_type === "audio");
    return {
      container: String(j.format?.format_name ?? ""),
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
    };
  } catch {
    return null;
  }
}

/** Codecs each output container can carry without re-encoding. A pair outside
 * these sets cannot be stream-copied: ffmpeg opens the output, then errors with
 * "codec not currently supported in container" and leaves a 0-byte file, which
 * is exactly the ADAAAA-7724 empty-`clipUri` bug (VP8/VP9+opus webm -> .mp4). */
const COPY_SAFE: Record<string, { video: string[]; audio: string[] }> = {
  mp4: {
    // Keep h264/av1 copyable: the H.264 browser path and AV1 VOD sources cut
    // today with `-c copy` and must not start paying for a re-encode.
    video: ["h264", "hevc", "av1", "mpeg4"],
    // VP9+opus *can* be muxed into mp4 by ffmpeg, but that container/codec
    // pair is not universally playable and it is precisely the pair a webm
    // MediaRecorder produces — re-encode those to h264/aac instead.
    audio: ["aac", "mp3", "ac3", "eac3", "alac"],
  },
  webm: {
    video: ["vp8", "vp9", "av1"],
    audio: ["opus", "vorbis"],
  },
};

function containerKind(outPath: string): "mp4" | "webm" | null {
  const ext = path.extname(outPath).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v" || ext === ".mov") return "mp4";
  if (ext === ".webm") return "webm";
  return null;
}

/** Whether `-c copy` can legally place `src` inside the container implied by
 * `outPath`. Unknown containers keep the historical copy behaviour. */
export function canStreamCopy(src: MediaFormat | null, outPath: string): boolean {
  const kind = containerKind(outPath);
  if (!kind || !src) return true;
  const safe = COPY_SAFE[kind];
  if (!src.videoCodec || !safe.video.includes(src.videoCodec)) return false;
  if (src.audioCodec && !safe.audio.includes(src.audioCodec)) return false;
  return true;
}

/** Re-encode args for a container ffmpeg cannot stream-copy into. H.264/AAC
 * into mp4 is the browser-safe target (every <video> plays it); VP9/opus into
 * webm mirrors what a MediaRecorder client produces.
 *
 * ADAAAA-8106: `-fps_mode vfr` is load-bearing, not cosmetic. A browser
 * MediaRecorder webm reports `r_frame_rate 1000/1` (its 1 ms timescale makes the
 * demuxer's smallest frame duration look like 1 ms), so ffmpeg's default CFR
 * output duplicates every real frame up to that nominal rate: a 15 s 1080p
 * window of a ~30 fps screen share encoded 15,030 frames instead of ~441 and
 * took ~20 s instead of ~2.5 s on the box. VFR passes the source frame timings
 * through, so the encode costs real frames only — same window, same duration,
 * same pictures, ~8x less CPU (measured: 20.3 s -> 2.5 s, 14.8 MB -> 10.1 MB). */
function reencodeArgs(kind: "mp4" | "webm"): string[] {
  if (kind === "webm") {
    return [
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0",
      "-c:a", "libopus", "-b:a", "96k",
      "-fps_mode", "vfr",
    ];
  }
  return [
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-fps_mode", "vfr",
    "-movflags", "+faststart",
  ];
}

/** The exact ffmpeg argument vector for a clip cut, split out from `cutClip` so
 * a unit test can pin the seek/encode strategy (ADAAAA-8106). Two properties
 * are contract, not taste:
 *   - `-ss`/`-t` stay BEFORE `-i` (fast demuxer seek); moving them after `-i`
 *     decodes the whole recording up to the in-point (measured 35 s vs 2.5 s
 *     on a 332 MB share) and changes nothing about the delivered window.
 *   - a re-encode keeps `-fps_mode vfr` (see `reencodeArgs`) so a source whose
 *     demuxer reports a bogus frame rate cannot inflate the encode.
 * A copy-mode cut must stay byte-for-byte the historical `-c copy` cut so the
 * h264/720p path keeps its exact bytes. */
export function buildClipArgs(opts: {
  source: string;
  outPath: string;
  startS: number;
  durationS: number;
  mode: "copy" | "reencode";
  kind: "mp4" | "webm";
}): string[] {
  const args: string[] = [
    "-y",
    "-ss", String(Math.max(0, opts.startS)),
    "-t", String(opts.durationS),
    "-i", opts.source,
  ];
  if (opts.mode === "copy") {
    args.push("-c", "copy", "-avoid_negative_ts", "make_zero");
  } else {
    args.push(...reencodeArgs(opts.kind));
  }
  args.push(opts.outPath);
  return args;
}

/** Time the demux/seek pass for the SAME window (stream copy into the null
 * muxer). It is the part of a cut spent seeking into a growing recording
 * rather than encoding, it costs ~2% of an encode, and measuring it separately
 * is what lets one log line split the cost (ADAAAA-8106 AC2). A probe failure
 * (a recording mid-append, a corrupt tail) returns null instead of failing the
 * cut — the cut itself is the operation that matters. */
async function probeSeekCost(
  ffmpegPath: string,
  source: string,
  startS: number,
  durationS: number
): Promise<number | null> {
  const t0 = Date.now();
  try {
    await runFfmpeg(ffmpegPath, [
      "-hide_banner", "-loglevel", "error",
      "-ss", String(Math.max(0, startS)),
      "-t", String(durationS),
      "-i", source,
      "-c", "copy",
      "-f", "null", "-",
    ]);
    return Date.now() - t0;
  } catch {
    return null;
  }
}

/** Result of a clip cut — the strategy actually used, so callers can log WHY a
 * webm recording was re-encoded instead of silently swallowing an empty clip.
 * `seekMs`/`encodeMs` split the cost (ADAAAA-8106): `seekMs` is the measured
 * demux/seek pass for the same window, `encodeMs` the ffmpeg encode itself. */
export interface ClipCutResult {
  mode: "copy" | "reencode";
  sourceFormat: MediaFormat | null;
  bytes: number;
  seekMs: number | null;
  encodeMs: number;
}

/**
 * Cut `[startS, startS + durationS]` of `source` to `outPath`.
 *
 * Stream-copies when the source codecs fit the output container (fast, and the
 * existing H.264 mp4 path). Otherwise re-encodes: a VP8/VP9+opus webm
 * recording cannot be copied into an mp4 container, and the copy attempt makes
 * ffmpeg exit with a 0-byte output (ADAAAA-7724 — every browser highlight then
 * had an empty clipUri). A failed or empty cut removes the output file so a
 * 0-byte clip is never left on disk, and the thrown error carries ffmpeg's
 * stderr so the caller can log the real reason.
 */
export async function cutClip(
  ffmpegPath: string,
  source: string,
  outPath: string,
  startS: number,
  durationS: number
): Promise<ClipCutResult> {
  const { mkdir, rm, stat } = await import("node:fs/promises");
  await mkdir(path.dirname(outPath), { recursive: true });
  const sourceFormat = await probeMediaFormat(ffmpegPath, source);
  const kind = containerKind(outPath);
  const mode: ClipCutResult["mode"] = canStreamCopy(sourceFormat, outPath) ? "copy" : "reencode";
  // Split the cost before spending it (ADAAAA-8106 AC2): a re-encode's seek
  // (demux into the growing recording) is measured separately from the encode
  // so one log line can say which half is slow. A copy-mode cut has no encode
  // worth separating, so it skips the probe and reports null.
  const seekMs = mode === "reencode" ? await probeSeekCost(ffmpegPath, source, startS, durationS) : null;
  const args = buildClipArgs({ source, outPath, startS, durationS, mode, kind: kind ?? "mp4" });
  const encodeT0 = Date.now();
  try {
    await runFfmpeg(ffmpegPath, args);
  } catch (e) {
    // ffmpeg creates the output file before it discovers it cannot mux the
    // stream, so a failed cut would otherwise leave a 0-byte clip behind.
    await rm(outPath, { force: true }).catch(() => {});
    throw e;
  }
  const encodeMs = Date.now() - encodeT0;
  let bytes = 0;
  try {
    bytes = (await stat(outPath)).size;
  } catch {
    bytes = 0;
  }
  if (bytes === 0) {
    await rm(outPath, { force: true }).catch(() => {});
    const fmt = sourceFormat
      ? `${sourceFormat.container} ${sourceFormat.videoCodec ?? "?"}/${sourceFormat.audioCodec ?? "none"}`
      : "unknown source format";
    throw new Error(`ffmpeg produced a 0-byte clip for ${path.basename(outPath)} (${mode} of ${fmt})`);
  }
  return { mode, sourceFormat, bytes, seekMs, encodeMs };
}

/** ADAAAA-7285: extract the audio for `[startS, startS + durationS]` of a job
 * source recording as a mono 16 kHz 16-bit PCM WAV Buffer. Used to serve a
 * per-window audio URI so the analysis-window player actually plays.
 * `-ss` before `-i` fast-seeks at the demuxer; `-t` after `-i` bounds the
 * decoded duration from the seek point (mirrors `cutClip`). `-map 0:a:0?`
 * tolerates a source with no audio stream (yields no audio, not a hard fail).
 * Throws on a decode/read failure — the caller maps that to 404 so a
 * missing/silent source never yields a bogus playable URI. */
export async function extractAudioWindow(
  ffmpegPath: string,
  source: string,
  startS: number,
  durationS: number
): Promise<Buffer> {
  const { stdout } = await exec(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-ss", String(Math.max(0, startS)),
    "-t", String(Math.max(0.1, durationS)),
    "-i", source,
    "-map", "0:a:0?",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    "-f", "wav",
    "-",
  ], { encoding: "buffer" });
  return stdout as Buffer;
}

/**
 * Re-sample a burst of HIGHER-fps frames around a trigger timestamp (I7 /
 * ADAAAA-6361). The decide window is otherwise sampled at the pass's low cadence
 * (detail-first VOD default 2 FPS, and the live/legacy 1 FPS), so the
 * ball-goal-crossing instant can fall between samples and be skipped. This
 * extracts frames from `source` within [ts - beforeS, ts + afterS] at `fps`,
 * returning them sorted with ABSOLUTE timestamps so the crossing is represented
 * in the decide window. Pure wrapper over the windowed `extractFrames`.
 *
 * Best-effort: any extraction failure returns [] so the caller degrades to the
 * rolling window and the decide call never dies (the re-sample is an
 * optimization, never a hard requirement).
 */
export async function extractBurstFrames(
  ffmpegPath: string,
  source: string,
  outDir: string,
  ts: number,
  beforeS: number,
  afterS: number,
  fps: number,
  scale = "640:360",
  /** Optional cancel signal (ADAAAA-6625): aborts a burst decode mid-window. */
  signal?: AbortSignal
): Promise<{ timestamp: number; imageB64: string }[]> {
  const inSec = Math.max(0, ts - beforeS);
  const outSec = ts + afterS;
  const burstDir = path.join(outDir, `burst_${Math.round(ts * 1000)}`);
  try {
    const files = await extractFrames(ffmpegPath, source, burstDir, fps, scale, { inSec, outSec }, signal);
    const { readFile } = await import("node:fs/promises");
    const out: { timestamp: number; imageB64: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const b64 = (await readFile(files[i])).toString("base64");
      out.push({ timestamp: +(inSec + i / fps).toFixed(3), imageB64: b64 });
    }
    return out;
  } catch {
    return [];
  }
}
