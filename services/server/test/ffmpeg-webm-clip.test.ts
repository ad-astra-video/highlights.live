// ADAAAA-7724: a browser share whose MediaRecorder fell back to webm
// (VP8/VP9 + opus — Firefox, older Chrome, or a client without H.264 encoding)
// used to yield an EMPTY clipUri for every highlight: `cutClip` always passed
// `-c copy`, and ffmpeg cannot mux VP8/opus into an .mp4 container — it exits
// leaving a 0-byte file. cutClip now probes the source and re-encodes when the
// output container cannot carry the source codecs, and never leaves a 0-byte
// clip behind.
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canStreamCopy, cutClip, probeMediaFormat } from "../src/ffmpeg";

const exec = promisify(execFile);
const FFMPEG = "ffmpeg";

// ffmpeg may be absent in a bare test environment; guard the real-binary tests
// so a missing binary skips rather than failing the suite.
const hasFfmpeg = await (async () => {
  try {
    await exec(FFMPEG, ["-version"]);
    return true;
  } catch {
    return false;
  }
})();

// The webm fixture needs libvpx (VP8) and libopus. Both ship with the repo's
// ffmpeg build; skip only if the local build really lacks them.
const hasVp8Webm = await (async () => {
  if (!hasFfmpeg) return false;
  try {
    const { stdout } = await exec(FFMPEG, ["-hide_banner", "-encoders"]);
    return /libvpx/.test(stdout) && /libopus/.test(stdout);
  } catch {
    return false;
  }
})();

/** A tiny VP8+opus webm — the exact container/codec pair a browser MediaRecorder
 * produces when `video/mp4;codecs=avc1` is unsupported. */
async function makeWebmSource(withAudio = true): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "hl-webm-"));
  const file = path.join(dir, "capture.webm");
  const args = ["-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=320x180:rate=10"];
  if (withAudio) args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=4");
  args.push("-c:v", "libvpx", "-b:v", "200k");
  if (withAudio) args.push("-c:a", "libopus", "-shortest");
  args.push(file);
  await exec(FFMPEG, args);
  return { dir, file };
}

/** An H.264/AAC mp4 — the existing happy path that must keep stream-copying. */
async function makeMp4Source(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "hl-mp4-"));
  const file = path.join(dir, "capture.mp4");
  await exec(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=4:size=320x180:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    file,
  ]);
  return { dir, file };
}

describe("cutClip container/codec handling (ADAAAA-7724)", () => {
  it.skipIf(!hasFfmpeg)("probeMediaFormat reports the webm container + VP8/opus codecs", async () => {
    if (!hasVp8Webm) return;
    const src = await makeWebmSource();
    try {
      const fmt = await probeMediaFormat(FFMPEG, src.file);
      expect(fmt).toBeTruthy();
      expect(fmt!.container).toContain("webm");
      expect(fmt!.videoCodec).toBe("vp8");
      expect(fmt!.audioCodec).toBe("opus");
      // A webm/VP8+opus source cannot be stream-copied into an mp4 container.
      expect(canStreamCopy(fmt, path.join(src.dir, "clip.mp4"))).toBe(false);
      // ...but it can be copied into a webm container.
      expect(canStreamCopy(fmt, path.join(src.dir, "clip.webm"))).toBe(true);
    } finally {
      await rm(src.dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasFfmpeg)("webm (VP8+opus) recording -> non-empty mp4 clip (the empty-clipUri regression)", async () => {
    if (!hasVp8Webm) return;
    const src = await makeWebmSource();
    const outDir = await mkdtemp(path.join(tmpdir(), "hl-clip-"));
    const out = path.join(outDir, "clip.mp4");
    try {
      // Exactly the call site: the browser recording (webm) is cut to .mp4.
      const cut = await cutClip(FFMPEG, src.file, out, 1, 2);
      expect(cut.mode).toBe("reencode");
      expect(cut.bytes).toBeGreaterThan(0);
      expect(existsSync(out)).toBe(true);
      expect((await stat(out)).size).toBeGreaterThan(0);
      // The delivered clip is genuinely playable mp4/H.264+AAC, not an empty file.
      const fmt = await probeMediaFormat(FFMPEG, out);
      expect(fmt!.container).toContain("mp4");
      expect(fmt!.videoCodec).toBe("h264");
      expect(fmt!.audioCodec).toBe("aac");
    } finally {
      await rm(src.dir, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasFfmpeg)("mp4 (H.264/AAC) recording still stream-copies — no regression", async () => {
    const src = await makeMp4Source();
    const outDir = await mkdtemp(path.join(tmpdir(), "hl-clip-"));
    const out = path.join(outDir, "clip.mp4");
    try {
      const cut = await cutClip(FFMPEG, src.file, out, 1, 2);
      expect(cut.mode).toBe("copy");
      expect(cut.bytes).toBeGreaterThan(0);
      const fmt = await probeMediaFormat(FFMPEG, out);
      expect(fmt!.videoCodec).toBe("h264");
    } finally {
      await rm(src.dir, { recursive: true, force: true });
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasFfmpeg)("a failed cut removes the output file — a 0-byte clip is never left on disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hl-bad-"));
    const src = path.join(dir, "capture.webm");
    const out = path.join(dir, "clip.mp4");
    try {
      // Not a real media file: ffprobe cannot identify it, and ffmpeg fails
      // after opening the output (the historical 0-byte-file case).
      await writeFile(src, Buffer.from("this is not a real webm recording"));
      // Pre-create the empty clip, mirroring the historical 0-byte artifact
      // ffmpeg left behind when it opened the output then failed to mux.
      await writeFile(out, Buffer.alloc(0));
      await expect(cutClip(FFMPEG, src, out, 0, 2)).rejects.toThrow(/ffmpeg/);
      expect(existsSync(out)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
