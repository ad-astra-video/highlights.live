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

async function runFfmpeg(ffmpegPath: string, args: string[], signal?: AbortSignal): Promise<void> {
  try {
    // ADAAAA-6625: an optional AbortSignal lets a cancelled VOD job kill the
    // ffmpeg child instead of letting it decode the rest of the file. execFile
    // reaps the child on abort and rejects with an AbortError.
    await exec(ffmpegPath, args, signal ? { signal } : undefined);
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
  signal?: AbortSignal
): Promise<string[]> {
  const { mkdir, rm } = await import("node:fs/promises");
  await rm(outDir, { recursive: true, force: true });
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
 * webm mirrors what a MediaRecorder client produces. */
function reencodeArgs(kind: "mp4" | "webm"): string[] {
  if (kind === "webm") {
    return [
      "-map", "0:v:0", "-map", "0:a:0?",
      "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0",
      "-c:a", "libopus", "-b:a", "96k",
    ];
  }
  return [
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
  ];
}

/** Result of a clip cut — the strategy actually used, so callers can log WHY a
 * webm recording was re-encoded instead of silently swallowing an empty clip. */
export interface ClipCutResult {
  mode: "copy" | "reencode";
  sourceFormat: MediaFormat | null;
  bytes: number;
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
  const args: string[] = [
    "-y",
    "-ss", String(Math.max(0, startS)),
    "-t", String(durationS),
    "-i", source,
  ];
  if (mode === "copy") {
    args.push("-c", "copy", "-avoid_negative_ts", "make_zero");
  } else {
    args.push(...reencodeArgs(kind ?? "mp4"));
  }
  args.push(outPath);
  try {
    await runFfmpeg(ffmpegPath, args);
  } catch (e) {
    // ffmpeg creates the output file before it discovers it cannot mux the
    // stream, so a failed cut would otherwise leave a 0-byte clip behind.
    await rm(outPath, { force: true }).catch(() => {});
    throw e;
  }
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
  return { mode, sourceFormat, bytes };
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
