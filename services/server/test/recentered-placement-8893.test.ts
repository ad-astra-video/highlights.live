// ADAAAA-8906 (cleanup of the D5 option seam): a re-centered option's file is
// placed on the CARD's window + ACCEPT anchor (`recenteredCutSpec` in
// `recentered-alternative.ts`), so the only placement the delivery seam can run
// is the ACCEPT-ANCHOR chain below. The moment-anchored path added by `4f13ec2`
// (`cutMomentAnchoredClip` / `isMomentAnchor` / `MOMENT_ANCHOR_*` /
// `momentAnchor`) was measured wrong on the real D5 population — anchoring the
// shared window on the dive moment moved the delivered file 0.3-2.5 s per row
// (2.5 s on `-6787`) — and was removed. These tests pin the surviving chain on
// real footage.
//
// The fixture: a 32 s recording whose scorebug's away digit widens once at 12 s
// (the flip = the goal instant), with a unique random-block picture per frame so
// the frame match is unambiguous. The option row's window is the card's window
// `[11, 26]`, i.e. the flip sits 1 s into it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { anchorCutOnEvidence } from "../src/clip-anchor";
import { locateImageInSource, probeDuration } from "../src/ffmpeg";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const tmp = mkdtempSync(path.join(tmpdir(), "hl-accept-placement-"));
const SC_SECONDS = 32;
const SC_FPS = 10;
const SC_W = 320;
const SC_H = 180;
/** Where the score digits flip in the fixture recording. */
const SC_FLIP_AT = 12.0;
/** The card's ACCEPT anchor: the goal instant, i.e. the flip itself. */
const ACCEPT_AT = SC_FLIP_AT;
const BEFORE = 1;
const WINDOW = 15;
/** The window the option row stores: the card's own window. */
const CONTENT_START = ACCEPT_AT - BEFORE;
/** A picture 6 s AFTER the flip — the shape QA measured on the real leg, and
 *  the input the old moment-anchored path used to hand the chain. */
const MOMENT_AT = 18.0;

const video = path.join(tmp, "accept-rec.webm");
const acceptPicture = path.join(tmp, "accept-evidence.jpg");
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
    "-y", "-v", "error", "-ss", String(ACCEPT_AT), "-i", video,
    "-frames:v", "1", "-q:v", "2", acceptPicture,
  ]);
  execFileSync("ffmpeg", [
    "-y", "-v", "error", "-ss", String(MOMENT_AT), "-i", video,
    "-frames:v", "1", "-q:v", "2", momentPicture,
  ]);
}, 120_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("accept-anchor placement on real footage (ADAAAA-8906 cleanup)", () => {
  it("places the row's window.start when the anchor IS the card's accept anchor", async () => {
    if (!hasFfmpeg) return;
    const out = path.join(tmp, "accept-anchored.mp4");
    const res = await anchorCutOnEvidence({
      ffmpegPath: "ffmpeg",
      source: video,
      outPath: out,
      contentStart: CONTENT_START,
      dur: WINDOW,
      // The accept anchor the option seam passes (`recenteredCutSpec().anchorTs`).
      evidenceTs: ACCEPT_AT,
      evidenceFramePath: acceptPicture,
      tag: "test-accept-anchor",
      log: () => {},
    });

    // The chain located the flip in the recording and centred on it.
    expect(res.placement.method).toBe("score_flip");
    expect(res.placement.fileTs).not.toBeNull();
    expect(Math.abs((res.placement.fileTs as number) - SC_FLIP_AT)).toBeLessThan(0.6);

    // AC: the delivered window opens on the ROW's window.start — the same
    // footage instant the card opens on — not 1 s earlier.
    expect(Math.abs(res.placement.cutStart - CONTENT_START)).toBeLessThan(0.6);

    // AC: the accept anchor sits `before` seconds into the delivered file.
    expect(res.placement.deliveredOffsetSec).not.toBeNull();
    expect(Math.abs((res.placement.deliveredOffsetSec as number) - BEFORE)).toBeLessThan(0.6);

    // Independent footage read of the delivered file (not the returned value).
    const inClip = await locateImageInSource("ffmpeg", out, acceptPicture, 0, WINDOW);
    expect(inClip).not.toBeNull();
    const offset = (inClip as any).fileTs - (inClip as any).firstTs;
    expect(Math.abs(offset - BEFORE)).toBeLessThan(0.6);
    // ... and the file still covers the whole window (the head is not trimmed).
    const dur = await probeDuration("ffmpeg", out);
    expect(dur).not.toBeNull();
    expect(dur as number).toBeGreaterThanOrEqual(WINDOW - 0.2);
  }, 120_000);

  it("guard: a picture that is not the accept anchor slides the window by the flip gap", async () => {
    if (!hasFfmpeg) return;
    const out = path.join(tmp, "moment-as-anchor.mp4");
    const res = await anchorCutOnEvidence({
      ffmpegPath: "ffmpeg",
      source: video,
      outPath: out,
      contentStart: CONTENT_START,
      dur: WINDOW,
      // This is the input the removed moment-anchor path used to hand the
      // chain: a picture 6 s past the flip, with the same row window. The chain
      // centres on the flip, so the cut opens (6 - `before`) s before the row's
      // window — the 0.3-2.5 s shift measured per row on the D5 population.
      // No delivery call site passes this: the option names the card's accept
      // anchor, and `isMomentAnchor`/`cutMomentAnchoredClip` no longer exist.
      evidenceTs: MOMENT_AT,
      evidenceFramePath: momentPicture,
      tag: "test-non-accept-anchor",
      log: () => {},
    });
    expect(res.placement.method).toBe("score_flip");
    // Cut at the flip (12.0) minus `before` (7.0) = 5.0 s: the window opened 6 s
    // earlier in content than the row says.
    expect(res.placement.cutStart).toBeLessThan(CONTENT_START - 1);
    expect(Math.abs(res.placement.cutStart - (SC_FLIP_AT - (MOMENT_AT - CONTENT_START)))).toBeLessThan(0.6);
  }, 120_000);
});
