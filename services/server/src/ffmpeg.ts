// ffmpeg helpers: extract 1fps JPEG frames from a source file, and cut a clip.
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);

export async function extractFrames(
  ffmpegPath: string,
  source: string,
  outDir: string,
  fps = 1,
  scale = "320:180"
): Promise<string[]> {
  const { mkdir, rm } = await import("node:fs/promises");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await exec(ffmpegPath, [
    "-y",
    "-i", source,
    "-vf", `fps=${fps},scale=${scale}`,
    "-q:v", "3",
    path.join(outDir, "frame_%04d.jpg"),
  ]);
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
  await exec(ffmpegPath, [
    "-y",
    "-ss", String(Math.max(0, startS)),
    "-t", String(durationS),
    "-i", source,
    "-c", "copy",
    "-avoid_negative_ts", "make_zero",
    outPath,
  ]);
}
