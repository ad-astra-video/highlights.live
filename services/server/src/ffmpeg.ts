// ffmpeg helpers: extract 1fps JPEG frames from a source file, and cut a clip.
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);

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
  if (hasIn) args.push("-ss", String(inSec));
  args.push("-i", opts.source);
  if (hasOut) args.push("-to", String(opts.window!.outSec!));
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
