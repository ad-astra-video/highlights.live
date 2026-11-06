// ADAAAA-8152 (ACC-2): the live lane has TWO clocks — the media rail's content
// clock (where `localizedTs` lives) and the recording file's own timeline. A cut
// on the content instant put the accepted goal 3.4 s into a 15 s clip on leg
// `f60932ca` (QA 8159: 0.23 d instead of the promised 0.47 d), because the rail
// timestamps a picture ~1.7-6 s after the recording carries it. These tests pin
// the fix's mechanism: locate the evidence frame the accept rested on INSIDE the
// recording and cut around it, so the delivered file centers the goal even when
// the two clocks disagree.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bestFrameMatch,
  centerClipOnEvidence,
  cutClip,
  locateImageInSource,
  normalizeGray,
  probeDuration,
} from "../src/ffmpeg";

/* A test fixture is imported by the suite only when ffmpeg is present; a bare
 * environment skips rather than failing on a missing binary. */
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const tmp = mkdtempSync(path.join(tmpdir(), "hl-clip-anchor-"));
const video = path.join(tmp, "rec-24s.webm");
const evidence = path.join(tmp, "evidence-8s.jpg");
const foreign = path.join(tmp, "foreign.jpg");
/** The picture's real position in the recording. The highlight's content-clock
 * instant is deliberately set 4 s LATER (12 s), i.e. exactly the skew QA
 * measured: the clip must follow the picture, not the clock. */
const PICTURE_AT = 8.0;
const CLOCK_SAYS = 12.0;
const BEFORE = 7;
const WINDOW = 15;
const W = 320;
const H = 180;
const FPS = 10;
const SECONDS = 24;

/** Deterministic PRNG so every run builds byte-identical footage. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 8x8 blocks of random gray per FRAME: a picture that is unique at 64x64 while
 * surviving h264 compression, so the locator's match is unambiguous. A bare
 * `testsrc` is nearly static in most of its area and matches 1 s-wide plateaus,
 * which would make this suite measure the fixture rather than the fix. */
function makeFootage(): Buffer {
  const frames = SECONDS * FPS;
  const buf = Buffer.alloc(frames * W * H);
  const COLS = 8;
  const ROWS = 6;
  const bw = Math.floor(W / COLS);
  const bh = Math.floor(H / ROWS);
  for (let f = 0; f < frames; f++) {
    const rnd = mulberry32(0x8152 + f * 7919);
    const base = f * W * H;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const v = Math.floor(rnd() * 256);
        for (let y = row * bh; y < (row + 1) * bh; y++) {
          const off = base + y * W + col * bw;
          buf.fill(v, off, off + bw);
        }
      }
    }
  }
  return buf;
}

beforeAll(() => {
  if (!hasFfmpeg) return;
  execFileSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-",
      // VP9 webm — the codec a browser MediaRecorder actually produces, and the
      // path the live lane takes (re-encode into mp4). An h264 mp4 fixture would
      // exercise the stream-copy path instead, whose seek behaviour is a
      // different subject.
      "-c:v", "libvpx-vp9", "-b:v", "400k", "-deadline", "realtime", "-cpu-used", "8",
      "-pix_fmt", "yuv420p", video,
    ],
    { input: makeFootage(), maxBuffer: 32 * 1024 * 1024 }
  );
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-ss", String(PICTURE_AT), "-i", video,
    "-frames:v", "1", "-q:v", "2", evidence,
  ]);
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:size=320x180:duration=1",
    "-frames:v", "1", "-q:v", "2", foreign,
  ]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("normalizeGray / bestFrameMatch", () => {
  it("matches on mean/std-normalised vectors and reports a uniqueness margin", () => {
    const a = normalizeGray(Uint8Array.from([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]));
    const b = normalizeGray(Uint8Array.from([150, 140, 130, 120, 110, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0]));
    // The same picture twice inside the match neighbourhood, then two clearly
    // different ones more than a second away.
    const vecs = [b, a, b, normalizeGray(new Uint8Array(16).fill(255)), normalizeGray(new Uint8Array(16).fill(0))];
    const m = bestFrameMatch(vecs, a, 2);
    expect(m.index).toBe(1);
    expect(m.score).toBeCloseTo(0, 6);
    expect(m.runnerUp).toBeGreaterThan(0.5);
  });

  it("returns index -1 for an empty probe instead of throwing", () => {
    const m = bestFrameMatch([], normalizeGray(new Uint8Array(4).fill(1)), 1);
    expect(m.index).toBe(-1);
  });
});

describe("locateImageInSource (ADAAAA-8152)", () => {
  it("finds the accepted picture in the recording and measures the clock lag", async () => {
    if (!hasFfmpeg) return;
    const searchStart = Math.max(0, CLOCK_SAYS - BEFORE - 2);
    const searchDur = WINDOW + 6;
    const m = await locateImageInSource("ffmpeg", video, evidence, searchStart, searchDur);
    expect(m).not.toBeNull();
    expect(Math.abs((m as any).fileTs - PICTURE_AT)).toBeLessThan(0.2);
    // Near-identical picture => tiny normalized MSE, and no other second of the
    // recording is anywhere near as close (the confidence gate's uniqueness arm).
    expect((m as any).score).toBeLessThan(0.3);
    expect((m as any).runnerUp).toBeGreaterThan(0.5);
  }, 30_000);

  it("reports a non-match for a picture that is not in the recording", async () => {
    if (!hasFfmpeg) return;
    const m = await locateImageInSource("ffmpeg", video, foreign, 1, 12);
    // A solid black frame is not in this footage: the match is far above the
    // confidence floor the cut path applies (CLIP_ANCHOR_MAX_SCORE = 0.6).
    expect(m === null || (m as any).score > 0.6).toBe(true);
  }, 30_000);
});

describe("clip placement (ACC-2 footage proof)", () => {
  it("cuts around the located picture, verifies the delivered file, and centers the goal", async () => {
    if (!hasFfmpeg) return;
    const out = path.join(tmp, "delivered.mp4");
    const centered = await centerClipOnEvidence("ffmpeg", video, out, evidence, BEFORE, WINDOW, {
      searchStartS: Math.max(0, CLOCK_SAYS - BEFORE - 2),
      searchDurS: WINDOW + 6,
    });
    expect(centered.mode).toBe("frame_match");
    expect(Math.abs((centered.fileTs as number) - PICTURE_AT)).toBeLessThan(0.2);
    // It cut the window and then MEASURED where the picture landed.
    expect(centered.deliveredOffset).not.toBeNull();
    // AC1: 7 s of a 15 s clip is 0.467 d — the middle third [5, 10] ACC-2 grades
    // and the number the row's clipGoalOffsetSec promises.
    expect(Math.abs((centered.deliveredOffset as number) - BEFORE)).toBeLessThan(0.4);

    const dur = await probeDuration("ffmpeg", out);
    expect(dur).not.toBeNull();
    // AC2: the delivered file is the whole window, not "whatever was there".
    expect(dur as number).toBeGreaterThanOrEqual(15.0);

    // Independent re-check from the file itself (not the returned value).
    const inClip = await locateImageInSource("ffmpeg", out, evidence, 0, WINDOW);
    expect(inClip).not.toBeNull();
    expect(Math.abs((inClip as any).fileTs - (inClip as any).firstTs - BEFORE)).toBeLessThan(0.4);
  }, 60_000);

  it("falls back to content_clock (and does not cut) when the picture is not in the recording", async () => {
    if (!hasFfmpeg) return;
    const out = path.join(tmp, "should-not-exist.mp4");
    const centered = await centerClipOnEvidence("ffmpeg", video, out, foreign, BEFORE, WINDOW, {
      searchStartS: 1,
      searchDurS: WINDOW + 6,
    });
    expect(centered.mode).toBe("content_clock");
    expect(centered.cut).toBeNull();
    expect(centered.deliveredOffset).toBeNull();
  }, 40_000);

  it("cuts on the content clock would have put the picture OUTSIDE the middle third", async () => {
    if (!hasFfmpeg) return;
    // The pre-fix behaviour, reproduced: cut at the content instant.
    const out = path.join(tmp, "content-clock.mp4");
    await cutClip("ffmpeg", video, out, CLOCK_SAYS - BEFORE, WINDOW);
    const inClip = await locateImageInSource("ffmpeg", out, evidence, 0.5, 8);
    expect(inClip).not.toBeNull();
    // A real match, not the least-bad frame of a wrong search.
    expect((inClip as any).score).toBeLessThan(0.3);
    // 7 - 4 = ~3 s of a 15 s clip, i.e. OUTSIDE [d/3, 2d/3] — the QA 8159
    // failure (measured 3.6 s) in one test.
    expect((inClip as any).fileTs - (inClip as any).firstTs).toBeLessThan(5);
  }, 40_000);
});
