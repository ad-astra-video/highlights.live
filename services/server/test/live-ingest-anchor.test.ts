// ADAAAA-8168: the INGEST rail (`LiveIngest.cut`) used to cut straight from the
// content clock and publish whatever bytes the still-growing recording held —
// the ACC-2 shape ADAAAA-8152 fixed on the browser rail (play sits wherever the
// clock says, not at the goal instant in the footage) plus no flush guard, so a
// window cut at the live edge could ship a sub-floor file.
//
// These tests pin both halves of the fix on a synthetic session, deterministically
// (the recording and the frame rail are written directly, so no real-time capture
// and no decode of a live stream is needed):
//  1. a cut centers the delivered file on the SCORE FLIP in the footage and
//     stamps the audit fields on what it returns (score_flip, >= 15 s, goal at
//     [d/3, 2d/3]);
//  2. a window the recorder has not flushed is REFUSED while the recorder is
//     still writing (no truncated live clip is published);
//  3. a finished recording still publishes the short share honestly (the
//     stop-time case, mirroring the browser rail's requireFullWindow: false);
//  4. the content instant maps onto the rail's own `frame_%06d.jpg` numbering.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiveIngest } from "../src/live";
import { locateScoreboardFlip, probeDuration } from "../src/ffmpeg";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const tmp = mkdtempSync(path.join(tmpdir(), "hl-ingest-anchor-"));
const dataDir = path.join(tmp, "data");
const W = 320;
const H = 180;
const FPS = 10;
/** Slightly longer than the 15 s window so the anchor can sit mid-recording. */
const SECONDS = 30;
/** Where the score digits flip in the session footage. */
const FLIP_AT = 12.0;
/** The content-clock instant the accept rests on: 6 s AFTER the flip, exactly
 * the shape QA 8160 measured (the rail's evidence picture is late). */
const PICTURE_AT = 18.0;
const BEFORE = 7;
const WINDOW = 15;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A recording with a scorebug in the top band: per-frame random block
 * background (so the accepted picture is unique and no background component is
 * stable), a dark plate, static team glyphs, a static home digit, an away digit
 * that WIDENS at FLIP_AT (a real glyph substitution) and four clock glyphs that
 * toggle every 0.5 s (many changes — the probe must not mistake them). */
function makeScoreFootage(): Buffer {
  const frames = SECONDS * FPS;
  const buf = Buffer.alloc(frames * W * H);
  const COLS = 8;
  const ROWS = 6;
  const bw = Math.floor(W / COLS);
  const bh = Math.floor(H / ROWS);
  const flipFrame = Math.round(FLIP_AT * FPS);
  for (let f = 0; f < frames; f++) {
    const base = f * W * H;
    const rnd = mulberry32(0x5168 + f * 104729);
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const v = Math.floor(rnd() * 256);
        for (let y = row * bh; y < (row + 1) * bh; y++) {
          const off = base + y * W + col * bw;
          buf.fill(v, off, off + bw);
        }
      }
    }
    const rect = (x0: number, y0: number, x1: number, y1: number, v: number) => {
      for (let y = y0; y < y1; y++) {
        const off = base + y * W;
        buf.fill(v, off + x0, off + x1);
      }
    };
    rect(8, 8, 170, 44, 40); // plate
    for (const x of [14, 22, 30]) rect(x, 20, x + 4, 28, 255); // static team token
    rect(60, 20, 63, 28, 255); // static home digit
    if (f >= flipFrame) rect(74, 20, 79, 28, 255); // away digit: wide after the goal
    else rect(74, 20, 77, 28, 255);
    const shift = Math.floor(f / 5) % 2; // clock: toggles every 0.5 s
    for (const x of [100, 110, 120, 130]) rect(x + shift, 20, x + shift + 5, 28, 255);
  }
  return buf;
}

/** Paths a LiveIngest instance derives from (cfg.dataDir, jobId). */
function sessionPathFor(jobId: string): string {
  return path.join(dataDir, "live", jobId, "session.ts");
}
function frameDirFor(jobId: string): string {
  return path.join(dataDir, "live", jobId, "frames");
}

let footage: Buffer;
let fullSession: string;
let shortSession: string;

function cfg() {
  return {
    ffmpegPath: "ffmpeg",
    dataDir,
    clipBeforeS: BEFORE,
    clipAfterS: WINDOW - BEFORE,
    clipWindowMinSec: WINDOW,
  } as any;
}

/** Write a session recording of `seconds` from the fixture footage. */
function writeSession(file: string, seconds: number) {
  const frames = seconds * FPS;
  execFileSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", String(FPS),
      "-i", "-",
      "-frames:v", String(frames),
      "-c:v", "libx264", "-preset", "veryfast", "-g", String(FPS), "-pix_fmt", "yuv420p",
      "-f", "mpegts",
      file,
    ],
    { input: footage.subarray(0, frames * W * H), maxBuffer: 64 * 1024 * 1024 }
  );
}

/** Write the rail's sampled frame JPEGs (1 s cadence, `frame_%06d.jpg`, numbered
 * from 1 exactly like the live ffmpeg segmenter). */
function writeFrames(jobId: string) {
  const dir = frameDirFor(jobId);
  mkdirSync(dir, { recursive: true });
  execFileSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${W}x${H}`, "-r", String(FPS),
      "-i", "-",
      "-vf", "fps=1,scale=320:180",
      "-q:v", "3",
      path.join(dir, "frame_%06d.jpg"),
    ],
    { input: footage, maxBuffer: 64 * 1024 * 1024 }
  );
}

beforeAll(() => {
  if (!hasFfmpeg) return;
  footage = makeScoreFootage();
  fullSession = path.join(tmp, "full.ts");
  shortSession = path.join(tmp, "short.ts");
  writeSession(fullSession, SECONDS);
  writeSession(shortSession, 10);
}, 180_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("LiveIngest.cut (ADAAAA-8168 ingest rail)", () => {
  it("maps a content instant onto the rail's own frame numbering", async () => {
    if (!hasFfmpeg) return;
    const ing = new LiveIngest(cfg(), "map", { kind: "file-sim", url: "x", sampleInterval: 1 });
    writeFrames("map");
    // frames() timestamps seq * sampleSec, the ffmpeg segmenter names from 1.
    expect(ing.evidenceFramePath(18)).toBe(path.join(frameDirFor("map"), "frame_000019.jpg"));
    expect(ing.evidenceFramePath(0)).toBe(path.join(frameDirFor("map"), "frame_000001.jpg"));
  }, 60_000);

  it("centers the delivered clip on the score flip in the footage and audits it", async () => {
    if (!hasFfmpeg) return;
    const jobId = "anchor";
    const sess = sessionPathFor(jobId);
    mkdirSync(path.dirname(sess), { recursive: true });
    execFileSync("cp", [fullSession, sess]);
    writeFrames(jobId);
    const ing = new LiveIngest(cfg(), jobId, { kind: "file-sim", url: "x", sampleInterval: 1 });
    // The recorder is "still writing" for a full session; the fixture file
    // already holds the whole window.
    ing.running = true;

    const clip = await ing.cut(PICTURE_AT);
    const evidence = path.join(frameDirFor(jobId), "frame_000019.jpg");
    const out = path.join(dataDir, "clips", `${clip.clipId}.mp4`);
    expect(existsSync(out)).toBe(true);

    // AC1: the goal instant is centered in the delivered card...
    const delivered = (await probeDuration("ffmpeg", out)) as number;
    expect(delivered).toBeGreaterThanOrEqual(15.0);
    const inClip = await locateScoreboardFlip("ffmpeg", out, evidence, {
      anchorFileTs: BEFORE + 0.5,
      maxLookbackS: Math.min(WINDOW, BEFORE + 1.5),
    });
    expect(inClip).not.toBeNull();
    const flipOffset = (inClip as any).fileTs - (inClip as any).firstTs;
    expect(flipOffset).toBeGreaterThanOrEqual(WINDOW / 3);
    expect(flipOffset).toBeLessThanOrEqual((2 * WINDOW) / 3);

    // AC3: the row audit says HOW it was placed — the same fields the browser
    // rail writes — and the measured offset agrees with the file.
    expect(clip.clipAudit?.clipAnchorMethod).toBe("score_flip");
    // The cut asks for a hair past the window because a stream-COPY cut from
    // the MPEG-TS session lands short of what it was asked for; the ROW window
    // (15 s) is what the delivered length is graded against, below.
    expect(clip.clipAudit?.clipCutDurSec).toBeGreaterThanOrEqual(WINDOW);
    expect(clip.clipAudit?.clipCutStartSec).toBeGreaterThanOrEqual(0);
    expect(clip.clipAudit?.clipAnchorFileTs).toBeGreaterThan(0);
    expect(clip.clipAudit?.clipAnchorEvidenceTs).toBe(PICTURE_AT);
    expect(clip.clipAudit?.clipDeliveredSec as number).toBeGreaterThanOrEqual(15.0);
    expect(Math.abs((clip.clipAudit?.clipAnchorDeliveredOffsetSec as number) - flipOffset)).toBeLessThan(0.7);
  }, 180_000);

  it("refuses to publish a window the recorder has not flushed", async () => {
    if (!hasFfmpeg) return;
    const jobId = "short-live";
    const sess = sessionPathFor(jobId);
    mkdirSync(path.dirname(sess), { recursive: true });
    execFileSync("cp", [shortSession, sess]);
    writeFrames(jobId);
    const ing = new LiveIngest(cfg(), jobId, { kind: "file-sim", url: "x", sampleInterval: 1 });
    ing.running = true; // recorder still writing: more bytes may still land
    // 10 s recording, 15 s window: never flushed, and the budget is short here.
    await expect(ing.cut(5, { maxFlushWaitMs: 1_500 })).rejects.toThrow(/not flushed within/);
    // Nothing was published.
    expect(existsSync(path.join(dataDir, "clips", `${jobId}-50.mp4`))).toBe(false);
  }, 120_000);

  it("publishes the short share honestly once the recording is finished", async () => {
    if (!hasFfmpeg) return;
    const jobId = "short-ended";
    const sess = sessionPathFor(jobId);
    mkdirSync(path.dirname(sess), { recursive: true });
    execFileSync("cp", [shortSession, sess]);
    writeFrames(jobId);
    const ing = new LiveIngest(cfg(), jobId, { kind: "file-sim", url: "x", sampleInterval: 1 });
    ing.running = false; // nothing more will ever land: the stop-time case
    const clip = await ing.cut(5, { maxFlushWaitMs: 1_500 });
    const out = path.join(dataDir, "clips", `${clip.clipId}.mp4`);
    expect(existsSync(out)).toBe(true);
    const delivered = (await probeDuration("ffmpeg", out)) as number;
    // The share itself was short: publish what exists (never a silently
    // truncated 15 s window), and say so in the audit.
    expect(delivered).toBeLessThan(WINDOW);
    expect(delivered).toBeGreaterThan(8);
    expect(clip.clipAudit?.clipAnchorMethod).not.toBeUndefined();
    expect(clip.clipAudit?.clipDeliveredSec as number).toBeGreaterThan(8);
  }, 120_000);
});
