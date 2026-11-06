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
  cutCenteredOnInstant,
  cutClip,
  locateImageInSource,
  locateScoreboardFlip,
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

/* ------------------------------------------------------------------------- *
 * ADAAAA-8152 (fourth pass): the ACCEPTED PICTURE IS NOT THE GOAL INSTANT.
 *
 * QA verdict ADAAAA-8160 measured it on leg `a5de612a`: the recording's score
 * flip sits 2.2 s (clip A) and 8.3 s (clip B) BEFORE the evidence frame the
 * accept rested on, because the media rail re-emits a stale pre-score picture
 * across the transition (clip B's 27 consecutive observation frames from
 * 65.96 s to 72.18 s all read `22:12 RMA 2-1` while the recording showed 2-2).
 * Centering on the picture therefore ships the play at 2-4 s of a 15 s card.
 *
 * These tests pin the footage probe that replaces it: find the frame where the
 * scorebug's DIGIT changes (once) inside the recording, and center on that.
 * ------------------------------------------------------------------------- */
const SC_SECONDS = 24;
const SC_FPS = 10;
const SC_W = 320;
const SC_H = 180;
/** Where the score digits flip in the fixture recording. */
const SC_FLIP_AT = 12.0;
/** Where the content clock's evidence picture is taken: 6 s AFTER the flip,
 * which is the shape QA 8160 measured on the real leg. */
const SC_PICTURE_AT = 18.0;
const scoreVideo = path.join(tmp, "score-rec.webm");
const scoreEvidence = path.join(tmp, "score-evidence.jpg");

/** A recording with a scorebug in the top band. Every frame's background is a
 * fresh random block grid (so a picture is unique and no background component
 * is stable), plus: a dark plate, three static team glyphs, a static home
 * digit, an away digit that WIDENS at `SC_FLIP_AT` (a real glyph substitution),
 * and four clock glyphs that toggle every 0.5 s (many changes — the probe must
 * not mistake them for the score). */
function makeScoreFootage(): Buffer {
  const frames = SC_SECONDS * SC_FPS;
  const buf = Buffer.alloc(frames * SC_W * SC_H);
  const COLS = 8;
  const ROWS = 6;
  const bw = Math.floor(SC_W / COLS);
  const bh = Math.floor(SC_H / ROWS);
  const flipFrame = Math.round(SC_FLIP_AT * SC_FPS);
  for (let f = 0; f < frames; f++) {
    const base = f * SC_W * SC_H;
    const rnd = mulberry32(0x51f0 + f * 104729);
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
    // away digit: narrow before the goal, full width after it
    if (f >= flipFrame) rect(74, 20, 79, 28, 255);
    else rect(74, 20, 77, 28, 255);
    const shift = Math.floor(f / 5) % 2; // clock: toggles every 0.5 s
    for (const x of [100, 110, 120, 130]) rect(x + shift, 20, x + shift + 5, 28, 255);
  }
  return buf;
}

describe("locateScoreboardFlip (ACC-2 footage instant)", () => {
  beforeAll(() => {
    if (!hasFfmpeg) return;
    execFileSync(
      "ffmpeg",
      [
        "-y", "-v", "error",
        "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${SC_W}x${SC_H}`, "-r", String(SC_FPS), "-i", "-",
        "-c:v", "libvpx-vp9", "-b:v", "400k", "-deadline", "realtime", "-cpu-used", "8",
        "-pix_fmt", "yuv420p", scoreVideo,
      ],
      { input: makeScoreFootage(), maxBuffer: 32 * 1024 * 1024 }
    );
    execFileSync("ffmpeg", [
      "-y", "-v", "error", "-ss", String(SC_PICTURE_AT), "-i", scoreVideo,
      "-frames:v", "1", "-q:v", "2", scoreEvidence,
    ]);
  }, 120_000);

  it("finds the score flip in the recording, 6 s BEFORE the accepted picture", async () => {
    if (!hasFfmpeg) return;
    const flip = await locateScoreboardFlip("ffmpeg", scoreVideo, scoreEvidence, {
      anchorFileTs: SC_PICTURE_AT,
      maxLookbackS: 14,
    });
    expect(flip).not.toBeNull();
    // The instant ACC-2 grades: the first frame showing the new score.
    expect(Math.abs((flip as any).fileTs - SC_FLIP_AT)).toBeLessThan(0.3);
    expect((flip as any).digits).toBeGreaterThanOrEqual(1);
    expect((flip as any).changedPx).toBeGreaterThanOrEqual(10);
    // The clock glyphs (four, toggling every 0.5 s) must not win: their change
    // instants are all over the scan, so the winner has no near competitor.
    expect((flip as any).runnerUpTs === null || Math.abs((flip as any).runnerUpTs - SC_FLIP_AT) > 1).toBe(true);
  }, 60_000);

  it("fails closed on a recording with no scorebug (the random-block fixture)", async () => {
    if (!hasFfmpeg) return;
    const flip = await locateScoreboardFlip("ffmpeg", video, evidence, {
      anchorFileTs: PICTURE_AT,
      maxLookbackS: 8,
    });
    expect(flip).toBeNull();
  }, 60_000);

  it("centers the delivered clip on the flip and measures the delivered offset (AC1/AC3)", async () => {
    if (!hasFfmpeg) return;
    const flip = await locateScoreboardFlip("ffmpeg", scoreVideo, scoreEvidence, {
      anchorFileTs: SC_PICTURE_AT,
      maxLookbackS: 14,
    });
    expect(flip).not.toBeNull();
    const out = path.join(tmp, "score-delivered.mp4");
    const recut = await cutCenteredOnInstant("ffmpeg", scoreVideo, out, (flip as any).fileTs, BEFORE, WINDOW, {
      recutTolSec: 0.6,
      measureOffset: async (file) => {
        const again = await locateScoreboardFlip("ffmpeg", file, scoreEvidence, {
          anchorFileTs: BEFORE + 0.5,
          maxLookbackS: Math.min(WINDOW, BEFORE + 1.5),
        });
        return again ? again.fileTs - again.firstTs : null;
      },
    });
    // AC1: the flip sits 7 s into a 15 s card = 0.467 d, inside [d/3, 2d/3].
    expect(recut.deliveredOffset).not.toBeNull();
    expect(Math.abs((recut.deliveredOffset as number) - BEFORE)).toBeLessThan(0.6);
    // AC2: the delivered file is the whole window.
    const dur = await probeDuration("ffmpeg", out);
    expect(dur as number).toBeGreaterThanOrEqual(15.0);
    // AC3: the placement is recomputable from the cut start + the flip instant.
    expect(Math.abs(recut.cutStart + BEFORE - ((flip as any).fileTs))).toBeLessThan(0.6);
  }, 120_000);

  it("centering on the ACCEPTED PICTURE puts the goal outside the middle third (the QA 8160 failure)", async () => {
    if (!hasFfmpeg) return;
    // The pre-fix path: cut around the evidence picture (6 s after the flip).
    const out = path.join(tmp, "score-picture-centered.mp4");
    const centered = await centerClipOnEvidence("ffmpeg", scoreVideo, out, scoreEvidence, BEFORE, WINDOW, {
      searchStartS: Math.max(0, SC_PICTURE_AT - BEFORE - 2),
      searchDurS: WINDOW + 6,
    });
    expect(centered.mode).toBe("frame_match");
    // The goal instant in that file, read from the footage: the flip lands
    // BEFORE the card's lower bound (0.4 s in), which is exactly the 0/2 QA saw.
    const inClip = await locateScoreboardFlip("ffmpeg", out, scoreEvidence, {
      anchorFileTs: Math.min(WINDOW, BEFORE + 1.5),
      maxLookbackS: Math.min(WINDOW, BEFORE + 1.5),
    });
    expect(inClip === null || (inClip as any).fileTs - (inClip as any).firstTs < 5).toBe(true);
  }, 120_000);
});
