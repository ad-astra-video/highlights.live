// ADAAAA-9016: the ingest frame rail is 1-based, the frame loader was 0-based.
//
// Found while answering ADAAAA-8982 on job a0e60cc2-3119-40f2-981c-a5c8a315e0d8.
// The label clock in that job is correct (`label(seq) = seq * sampleSec`, flat to
// ±1/6 s from t = 7.8 s to t = 675.8 s), but the picture the dive re-read was one
// sample tick early: measured -0.167 s uniform (MSE match of the cited JPEG
// against the recording decoded at fps=30), because
//
//   live.ts            writes the rail 1-based — ffmpeg `image2` starts at
//                      `frame_000001.jpg` while the rail's own seq is 0-based;
//   live-frame-reread  named the file 0-based (`frame_${seq}.jpg`).
//
// One loader cannot serve both rails by assumption: the media/browser rail
// (live-frames.ts, `LiveFrameWriter`) names every file by the frame's GLOBAL seq
// (0-based, dense, and decimated), so there the suffix IS the seq. These tests
// pin the mapping for BOTH rails — feed a 1-based dir and a 0-based dir and
// assert the loaded bytes are the frame whose label the row cites, plus that the
// loader and the served `/jobs/:id/frames/:seq` route agree on the picture.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLiveFrameReread } from "../src/api.js";
import { diskFrameLoader, liveFrameFileBase, liveRereadFrameFileName } from "../src/live-frame-reread.js";

/** The ingest rail's sampled cadence on the graded job (3 fps -> 1/3 s a frame). */
const SAMPLE_SEC = 1 / 3;

const root = mkdtempSync(path.join(tmpdir(), "hl9016-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Seed one rail's frame dir. The rail's own FILE index is encoded in the bytes,
 *  so a wrong base is a byte mismatch instead of a plausible picture. */
function seedRail(jobId: string, rail: string, fileIndexes: number[]): string[] {
  const dir = path.join(root, "live", jobId, "frames");
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const i of fileIndexes) {
    const file = `frame_${String(i).padStart(6, "0")}.jpg`;
    writeFileSync(path.join(dir, file), Buffer.from(`${rail}:file_${i}`));
    files.push(file);
  }
  return files.sort();
}

/** The bytes a loaded frame carries, as the rail's own file index + rail name. */
function decodeFrame(b64: string | null): { rail: string; fileIndex: number; text: string } {
  expect(b64).not.toBeNull();
  const text = Buffer.from(b64!, "base64").toString();
  const m = /^([a-z]+):file_(\d+)$/.exec(text);
  expect(m, `unexpected frame payload ${text}`).toBeTruthy();
  return { rail: m![1], fileIndex: Number(m![2]), text };
}

/**
 * The file the served `GET /jobs/:id/frames/:seq` route hands out — the mapping
 * `jobFrameList` (api.ts) implements: sorted POSITION for every ffmpeg rail,
 * numeric SUFFIX for the browser rail (the position stops meaning anything once
 * old frames are decimated away).
 */
function servedFile(files: string[], seq: number, seqIsAbsolute: boolean): string | undefined {
  if (!seqIsAbsolute) return files[seq];
  return files.find((f) => Number(/^frame_(\d+)\.jpg$/.exec(f)?.[1]) === seq);
}

describe("liveFrameFileBase — the two rails' file bases (ADAAAA-9016)", () => {
  it("is 1 for every ffmpeg ingest rail and 0 for the browser/media rail", () => {
    for (const source of ["rtmp", "webrtc", "screenshare", "screen", "file-sim", "file"]) {
      expect(liveFrameFileBase(source)).toBe(1);
    }
    expect(liveFrameFileBase("browser")).toBe(0);
    // A job without a source gets the ffmpeg convention, exactly like
    // `jobFrameList`'s non-browser branch.
    expect(liveFrameFileBase(undefined)).toBe(1);
  });

  it("names the file `seq + base`", () => {
    expect(liveRereadFrameFileName(0, 1)).toBe("frame_000001.jpg");
    expect(liveRereadFrameFileName(23, 1)).toBe("frame_000024.jpg");
    expect(liveRereadFrameFileName(23, 0)).toBe("frame_000023.jpg");
  });
});

describe("ingest rail (1-based ffmpeg series): row seq k is file k+1 (ADAAAA-9016)", () => {
  const files = seedRail("ingest01", "ingest", [1, 2, 3, 4, 5, 6]);

  it("loads the picture of `seq + 1`, never the `seq - 1` picture the old naming opened", async () => {
    const load = diskFrameLoader(root, "ingest01", { fileBase: liveFrameFileBase("rtmp") });
    for (const seq of [0, 1, 2, 3, 4, 5]) {
      const frame = decodeFrame(await load(seq));
      expect(frame.text).toBe(`ingest:file_${seq + 1}`);
    }
    // The regression, stated as a byte fact: for every seq whose 0-based name
    // exists, the loader must NOT return that file any more.
    for (const seq of [1, 2, 3, 4, 5]) {
      const staleName = liveRereadFrameFileName(seq, 0);
      expect(files).toContain(staleName);
      const frame = decodeFrame(await load(seq));
      expect(frame.text).not.toBe(`ingest:file_${seq}`);
    }
  });

  it("fails closed past the end of the rail instead of shifting onto a neighbour", async () => {
    const load = diskFrameLoader(root, "ingest01", { fileBase: liveFrameFileBase("rtmp") });
    expect(await load(6)).toBeNull(); // file 7 was never written
  });

  it("loads the same bytes the served /frames/:seq route serves", async () => {
    const load = diskFrameLoader(root, "ingest01", { fileBase: liveFrameFileBase("rtmp") });
    for (const seq of [0, 1, 2, 3, 4, 5]) {
      const served = servedFile(files, seq, false)!;
      expect(decodeFrame(await load(seq)).text).toBe(`ingest:file_${seq + 1}`);
      expect(served).toBe(liveRereadFrameFileName(seq, 1));
    }
  });

  it("the loaded picture's own tick IS the label the row cites", async () => {
    const load = diskFrameLoader(root, "ingest01", { fileBase: liveFrameFileBase("rtmp") });
    for (const seq of [0, 3, 5]) {
      const { fileIndex } = decodeFrame(await load(seq));
      // ffmpeg's file `i` is the rail's frame `i - 1`, so its tick is (i-1)*sec.
      expect((fileIndex - 1) * SAMPLE_SEC).toBeCloseTo(seq * SAMPLE_SEC, 9);
    }
  });
});

describe("browser/media rail (0-based, suffix == seq): row seq k is file k (ADAAAA-9016)", () => {
  // Gappy on purpose: decimation removes old frames, so position != seq here.
  const files = seedRail("browser01", "browser", [0, 2, 4, 5]);

  it("still loads the file whose SUFFIX is the seq", async () => {
    const load = diskFrameLoader(root, "browser01", { fileBase: liveFrameFileBase("browser") });
    for (const seq of [0, 2, 4, 5]) {
      const frame = decodeFrame(await load(seq));
      expect(frame.text).toBe(`browser:file_${seq}`);
    }
    // A decimated seq is absent evidence, not the next picture along.
    expect(await load(1)).toBeNull();
    expect(await load(3)).toBeNull();
  });

  it("loads the same bytes the served /frames/:seq route serves after decimation", async () => {
    const load = diskFrameLoader(root, "browser01", { fileBase: liveFrameFileBase("browser") });
    for (const seq of [0, 2, 4, 5]) {
      const served = servedFile(files, seq, true)!;
      expect(decodeFrame(await load(seq)).text).toBe(`browser:file_${seq}`);
      expect(served).toBe(liveRereadFrameFileName(seq, 0));
    }
  });

  it("the loaded picture's own tick IS the label the row cites", async () => {
    const load = diskFrameLoader(root, "browser01", { fileBase: liveFrameFileBase("browser") });
    for (const seq of [0, 2, 4, 5]) {
      const { fileIndex } = decodeFrame(await load(seq));
      // The browser rail's file `i` IS frame `i` (global seq), so tick = i*sec.
      expect(fileIndex * SAMPLE_SEC).toBeCloseTo(seq * SAMPLE_SEC, 9);
    }
  });
});

describe("production wiring derives the base from the job's source (ADAAAA-9016)", () => {
  const cfg = { dataDir: root, liveFrameReread: true, perceiveRunnerUrl: "http://perceive:8080" } as any;
  const wiringFor = (jobId: string, source: string) =>
    buildLiveFrameReread({
      cfg,
      jobId,
      store: { observationsForJob: () => [], getJob: () => ({ source }) } as any,
    })!;

  seedRail("wired-ingest", "ingest", [1, 2, 3, 4]);
  seedRail("wired-browser", "browser", [0, 1, 2, 3]);

  it("an rtmp/file-sim job reads the 1-based ingest rail", async () => {
    for (const source of ["rtmp", "file-sim"]) {
      const wiring = wiringFor("wired-ingest", source);
      expect(decodeFrame(await wiring.io.loadFrame(3)).text).toBe("ingest:file_4");
      expect(decodeFrame(await wiring.io.loadFrame(0)).text).toBe("ingest:file_1");
    }
  });

  it("a browser job keeps reading the 0-based media rail", async () => {
    const wiring = wiringFor("wired-browser", "browser");
    expect(decodeFrame(await wiring.io.loadFrame(3)).text).toBe("browser:file_3");
    expect(decodeFrame(await wiring.io.loadFrame(0)).text).toBe("browser:file_0");
  });
});
