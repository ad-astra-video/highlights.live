// ADAAAA-8906 (fix for the D5 grade on ADAAAA-8893): a DIVE MOMENT is placed on
// its own picture, never on the score flip that precedes it.
//
// QA measured the defect on build `0685049` (grade on ADAAAA-8904): the option
// row stored the owner window `[1.6667, 16.6667]` and the dive moment at
// 12.6667 s, but the delivered `-recentered.mp4` opened at 0.4667 s, so the
// moment landed at 12.2 s of the file instead of 11.0 s — AC5.1's footage clause
// failing with every row field correct.
//
// The cause: the option cut reuses the ACCEPT-ANCHOR chain, which locates the
// score flip at-or-before the anchor and centers THERE. For an accept anchor
// that is the goal instant the card wants; for a dive moment it slides the whole
// window earlier by the flip→picture gap (1.0-1.2 s measured, ~6 s in this
// fixture). These tests pin the corrected rule on real footage.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { anchorCutOnEvidence, isMomentAnchor } from "../src/clip-anchor";
import { locateImageInSource, probeDuration } from "../src/ffmpeg";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const tmp = mkdtempSync(path.join(tmpdir(), "hl-moment-anchor-"));
const SC_SECONDS = 32;
const SC_FPS = 10;
const SC_W = 320;
const SC_H = 180;
/** Where the score digits flip in the fixture recording. */
const SC_FLIP_AT = 12.0;
/** Where the content clock's evidence picture is taken: 6 s AFTER the flip — the
 * same shape QA 8160 measured on the real leg, and the shape of the D5 failure. */
const MOMENT_AT = 18.0;
const BEFORE = 7;
const WINDOW = 15;
/** The window the option row stores: the owner's window, moment at 7 s of it. */
const CONTENT_START = MOMENT_AT - BEFORE;

const video = path.join(tmp, "moment-rec.webm");
const momentPicture = path.join(tmp, "moment-evidence.jpg");

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same fixture shape as `live-clip-anchor.test.ts`: a unique random-block
 * picture per frame (so the frame match is unambiguous) plus a scorebug whose
 * away digit widens once at SC_FLIP_AT. */
function makeFootage(): Buffer {
  const frames = SC_SECONDS * SC_FPS;
  const buf = Buffer.alloc(frames * SC_W * SC_H);
  const COLS = 8;
  const ROWS = 6;
  const bw = Math.floor(SC_W / COLS);
  const bh = Math.floor(SC_H / ROWS);
  const flipFrame = Math.round(SC_FLIP_AT * SC_FPS);
  for (let f = 0; f < frames; f++) {
    const base = f * SC_W * SC_H;
    const rnd = mulberry32(0x8906 + f * 104729);
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const v = Math.floor(rnd() * 256);
        for (let y = row * bh; y < (row + 1) * bh; y++) {
          const off = base + y * SC_W + col * bw;
          buf.fill(v, off, off + bw);
        }
      }
    }
    const rect = (x0: number, y0: number, x1: number, y1: number, v: number) => {
      for (let y = y0; y < y1; y++) {
        const off = base + y * SC_W;
        buf.fill(v, off + x0, off + x1);
      }
    };
    rect(8, 8, 170, 44, 40); // plate
    for (const x of [14, 22, 30]) rect(x, 20, x + 4, 28, 255); // static team token
    rect(60, 20, 63, 28, 255); // static home digit
    if (f >= flipFrame) rect(74, 20, 79, 28, 255); // away digit widens (the flip)
    else rect(74, 20, 77, 28, 255);
    const shift = Math.floor(f / 5) % 2; // clock glyphs toggle every 0.5 s
    for (const x of [100, 110, 120, 130]) rect(x + shift, 20, x + shift + 5, 28, 255);
  }
  return buf;
}

beforeAll(() => {
  if (!hasFfmpeg) return;
  execFileSync(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${SC_W}x${SC_H}`, "-r", String(SC_FPS), "-i", "-",
      "-c:v", "libvpx-vp9", "-b:v", "400k", "-deadline", "realtime", "-cpu-used", "8",
      "-pix_fmt", "yuv420p", video,
    ],
    { input: makeFootage(), maxBuffer: 32 * 1024 * 1024 }
  );
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-ss", String(MOMENT_AT), "-i", video,
    "-frames:v", "1", "-q:v", "2", momentPicture,
  ]);
}, 120_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("isMomentAnchor — one rule for both rails", () => {
  it("treats a >= 0.5 s drift from the accept anchor as a dive moment", () => {
    expect(isMomentAnchor(12.6667, 8.6667)).toBe(true);
    expect(isMomentAnchor(1, 3)).toBe(true);
    // the delivery gate is |drift| >= 1 s, but half a second already means the
    // moment is not the accept anchor.
    expect(isMomentAnchor(10.6, 10.0)).toBe(true);
  });

  it("leaves the accept anchor (and a missing anchor) on the accept-anchor path", () => {
    expect(isMomentAnchor(8.667, 8.667)).toBe(false);
    expect(isMomentAnchor(8.4, 8.667)).toBe(false);
    expect(isMomentAnchor(undefined, 8.667)).toBe(false);
    expect(isMomentAnchor(12.5, null)).toBe(false);
    expect(isMomentAnchor(Number.NaN, 8.667)).toBe(false);
  });
});

describe("cutMomentAnchoredClip via anchorCutOnEvidence (ADAAAA-8906)", () => {
  it("places the moment at moment - window.start and does NOT slide to the score flip", async () => {
    if (!hasFfmpeg) return;
    const out = path.join(tmp, "moment-anchored.mp4");
    const res = await anchorCutOnEvidence({
      ffmpegPath: "ffmpeg",
      source: video,
      outPath: out,
      contentStart: CONTENT_START,
      dur: WINDOW,
      evidenceTs: MOMENT_AT,
      evidenceFramePath: momentPicture,
      momentAnchor: true,
      tag: "test-moment-anchor",
      log: () => {},
    });

    // The moment's own picture is the anchor; the flip probe never ran.
    expect(res.placement.method).toBe("frame_match");
    expect(res.placement.flipPx).toBeNull();
    expect(res.placement.flipDigits).toBeNull();
    expect(Math.abs((res.placement.fileTs as number) - MOMENT_AT)).toBeLessThan(0.2);

    // AC: the delivered content start is the row's window start, not the flip's.
    // The pre-fix chain would have cut at SC_FLIP_AT - BEFORE = 5.0 s.
    expect(Math.abs(res.placement.cutStart - CONTENT_START)).toBeLessThan(0.2);

    // AC: the moment sits `moment - window.start` seconds from the option's
    // first frame, measured on the delivered file, within a frame or two.
    expect(res.placement.deliveredOffsetSec).not.toBeNull();
    expect(Math.abs((res.placement.deliveredOffsetSec as number) - BEFORE)).toBeLessThan(0.2);

    // Independent footage read of the delivered file (not the returned value).
    const inClip = await locateImageInSource("ffmpeg", out, momentPicture, 0, WINDOW);
    expect(inClip).not.toBeNull();
    const offset = (inClip as any).fileTs - (inClip as any).firstTs;
    expect(Math.abs(offset - BEFORE)).toBeLessThan(0.2);
    // ... and the file still covers the whole window (the head is not trimmed).
    const dur = await probeDuration("ffmpeg", out);
    expect(dur).not.toBeNull();
    expect(dur as number).toBeGreaterThanOrEqual(WINDOW - 0.2);
  }, 120_000);

  it("control: the accept-anchor chain slides the same window to the 6 s-earlier flip (the pre-fix defect)", async () => {
    if (!hasFfmpeg) return;
    const out = path.join(tmp, "accept-anchored.mp4");
    const res = await anchorCutOnEvidence({
      ffmpegPath: "ffmpeg",
      source: video,
      outPath: out,
      contentStart: CONTENT_START,
      dur: WINDOW,
      evidenceTs: MOMENT_AT,
      evidenceFramePath: momentPicture,
      // momentAnchor absent: the historical accept-anchor chain runs, which is
      // what shipped the head over-extension QA measured.
      tag: "test-accept-anchor",
      log: () => {},
    });
    expect(res.placement.method).toBe("score_flip");
    // Cut at the flip (12.0) minus `before` (7.0) = 5.0 s: the window opened 6 s
    // earlier in content than the row says, so the moment measured ~13 s of the
    // file instead of 7 s.
    expect(res.placement.cutStart).toBeLessThan(CONTENT_START - 1);
    expect(Math.abs((res.placement.cutStart as number) - (SC_FLIP_AT - BEFORE))).toBeLessThan(0.6);
  }, 120_000);

  it("falls back to the content-clock window when the moment picture is absent", async () => {
    if (!hasFfmpeg) return;
    const out = path.join(tmp, "moment-no-frame.mp4");
    const res = await anchorCutOnEvidence({
      ffmpegPath: "ffmpeg",
      source: video,
      outPath: out,
      contentStart: CONTENT_START,
      dur: WINDOW,
      evidenceTs: MOMENT_AT,
      evidenceFramePath: null,
      momentAnchor: true,
      tag: "test-moment-anchor-fallback",
      log: () => {},
    });
    expect(res.placement.method).toBe("content_clock");
    expect(res.placement.cutStart).toBeCloseTo(CONTENT_START, 3);
    expect(res.placement.flipPx).toBeNull();
  }, 60_000);
});
