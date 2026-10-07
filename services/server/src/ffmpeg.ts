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

async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  try {
    await exec(ffmpegPath, args);
  } catch (e: any) {
    const stderr = String(e?.stderr || e?.message || "");
    const reason = meaningfulFfmpegError(stderr);
    throw new Error(`ffmpeg: ${reason}`);
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
  window?: FrameWindow
): Promise<string[]> {
  const { mkdir, rm } = await import("node:fs/promises");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await runFfmpeg(ffmpegPath, buildExtractArgs({ source, outDir, fps, scale, window }));
  const files = (await readdir(outDir)).filter((f) => f.endsWith(".jpg")).sort();
  return files.map((f) => path.join(outDir, f));
}

export async function cutClip(
  ffmpegPath: string,
  source: string,
  outPath: string,
  startS: number,
  durationS: number
): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(outPath), { recursive: true });
  await runFfmpeg(ffmpegPath, [
    "-y",
    "-ss", String(Math.max(0, startS)),
    "-t", String(durationS),
    "-i", source,
    "-c", "copy",
    "-avoid_negative_ts", "make_zero",
    outPath,
  ]);
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
  scale = "640:360"
): Promise<{ timestamp: number; imageB64: string }[]> {
  const inSec = Math.max(0, ts - beforeS);
  const outSec = ts + afterS;
  const burstDir = path.join(outDir, `burst_${Math.round(ts * 1000)}`);
  try {
    const files = await extractFrames(ffmpegPath, source, burstDir, fps, scale, { inSec, outSec });
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
