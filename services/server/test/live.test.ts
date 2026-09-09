import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { LiveIngest } from "../src/live";

const dataDir = path.join(tmpdir(), "hl-live-test");
// Source lives OUTSIDE dataDir (tests delete dataDir between cases).
const src = path.join(tmpdir(), "hl-live-src.mp4");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cfg() {
  return { ffmpegPath: "ffmpeg", dataDir, clipBeforeS: 1, clipAfterS: 1 } as any;
}

beforeAll(() => {
  mkdirSync(path.dirname(src), { recursive: true });
  execFileSync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc=duration=6:size=160x90:rate=10",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    src,
  ]);
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("LiveIngest", () => {
  it("file-sim streams frames in order on the sampling cadence", async () => {
    await rm(dataDir, { recursive: true, force: true });
    const ing = new LiveIngest(cfg(), "j1", { kind: "file-sim", url: src, sampleInterval: 0.5 });
    await ing.start();

    const seen: { seq: number; timestamp: number }[] = [];
    for await (const f of ing.frames()) {
      seen.push({ seq: f.seq, timestamp: f.timestamp });
      expect(f.imageB64.length).toBeGreaterThan(0);
      if (seen.length >= 3) break;
    }
    await ing.stop();

    expect(seen.map((s) => s.seq)).toEqual([0, 1, 2]);
    // timestamps follow the sample interval (0.5s), tolerant of encode timing
    expect(Math.abs(seen[1].timestamp - seen[0].timestamp - 0.5)).toBeLessThan(0.5);
  });

  it("records the session to a seekable file and cuts a clip from it", async () => {
    await rm(dataDir, { recursive: true, force: true });
    const ing = new LiveIngest(cfg(), "j2", { kind: "file-sim", url: src, sampleInterval: 0.5 });
    await ing.start();

    // let the recording accumulate to at least the clip window
    await sleep(2600);
    await ing.stop();

    expect(existsSync(ing.sessionPath)).toBe(true);

    const { clipId, clipUri } = await ing.cut(0.8);
    expect(clipUri).toMatch(/^\/clips\//);
    const clipFile = path.join(dataDir, "clips", `${clipId}.mp4`);
    expect(existsSync(clipFile)).toBe(true);
  });

  it("ends the frame iterator when stopped (analyzeJob can return)", async () => {
    await rm(dataDir, { recursive: true, force: true });
    const ing = new LiveIngest(cfg(), "j3", { kind: "file-sim", url: src, sampleInterval: 0.5 });
    await ing.start();

    let count = 0;
    const t = (async () => {
      for await (const _f of ing.frames()) count++;
    })();

    await sleep(900);
    await ing.stop();
    await t;
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
