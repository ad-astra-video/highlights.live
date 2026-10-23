import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cutClip, probeHasAudio } from "../src/ffmpeg";

const exec = promisify(execFile);
const FFMPEG = "ffmpeg";

// ffmpeg may be absent in a bare test environment; guard the real-binary tests
// so a missing binary skips rather than failing the suite (the pipeline always
// has ffmpeg, but the unit suite must not hard-depend on the PATH).
const hasFfmpeg = await (async () => {
  try {
    await exec(FFMPEG, ["-version"]);
    return true;
  } catch {
    return false;
  }
})();

async function makeSource(withAudio: boolean): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "hl-audio-"));
  const file = path.join(dir, "src.mp4");
  // Video always; audio only when requested. Use a short 4s clip so tests are fast.
  const base = ["-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x180:rate=10"];
  const audioIn = ["-f", "lavfi", "-i", "sine=frequency=440:duration=4"];
  const args = withAudio
    ? [...base, ...audioIn, "-c:v", "libx264", "-c:a", "aac", "-shortest", file]
    : [...base, "-c:v", "libx264", file];
  await exec(FFMPEG, args);
  return { dir, file };
}

describe("cutClip / probeHasAudio audio preservation (ADAAAA-7248)", () => {
  it.skipIf(!hasFfmpeg)("probeHasAudio is true for an audio-bearing source and false for a silent source", async () => {
    const withA = await makeSource(true);
    const noA = await makeSource(false);
    try {
      expect(await probeHasAudio(FFMPEG, withA.file)).toBe(true);
      expect(await probeHasAudio(FFMPEG, noA.file)).toBe(false);
    } finally {
      await rm(withA.dir, { recursive: true, force: true });
      await rm(noA.dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasFfmpeg)("cutClip (same args as the server) preserves the audio track when the source has one", async () => {
    const src = await makeSource(true);
    const outDir = await mkdtemp(path.join(tmpdir(), "hl-clip-"));
    const out = path.join(outDir, "clip.mp4");
    try {
      // Exactly the args used at the browser/live clip-cut call site.
      await cutClip(FFMPEG, src.file, out, 1, 2);
      // The delivered clip retains an audio stream => playback is audible.
      expect(await probeHasAudio(FFMPEG, out)).toBe(true);
    } finally {
      await rm(src.dir, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasFfmpeg)("cutClip yields a clip with NO audio stream when the source is audio-less (ACC-2)", async () => {
    const src = await makeSource(false);
    const outDir = await mkdtemp(path.join(tmpdir(), "hl-clip-"));
    const out = path.join(outDir, "clip.mp4");
    try {
      await cutClip(FFMPEG, src.file, out, 1, 2);
      expect(await probeHasAudio(FFMPEG, out)).toBe(false);
    } finally {
      await rm(src.dir, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
