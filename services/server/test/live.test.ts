import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { rm, readdir } from "node:fs/promises";
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

    // Frames are produced asynchronously by the ffmpeg child (which pays an
    // ~800ms open/encode startup before the first frame is written), so a fixed
    // sleep races with first-frame production and intermittently yields 0.
    // Deterministically wait for at least one observed frame (bounded), THEN
    // stop, so we are testing "the iterator ends on stop" and not timing.
    const deadline = Date.now() + 20000;
    while (count === 0 && Date.now() < deadline) await sleep(100);
    await ing.stop();
    await t;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("stops yielding buffered frames promptly after stop() (ADAAAA-6556)", async () => {
    // Regression: before the ADAAAA-6556 fix, `frames()` drained every
    // already-captured frame in the directory before re-checking `running`.
    // On a live job stopped mid-stream, the buffered batch (e.g. 37 frames at
    // 1fps over ~40s of capture) would each trigger a ~10s GPU /analyze call,
    // delaying the perceive-session release in analyzeJob()'s finally by
    // minutes — the capacity-1 slot stayed reserved with its payment refiller
    // still running (HTTP 480/482 spam). This test proves that stop() now
    // bounds the number of frames consumed AFTER the call by the current
    // in-flight batch (at most the frames already on disk), not the whole
    // directory.
    await rm(dataDir, { recursive: true, force: true });
    // A longer source so the buffered batch has meaningful size; 0.5s sample
    // over 40s of capture = ~80 frames by the time we stop.
    await rm(path.dirname(src), { recursive: true, force: true });
    mkdirSync(path.dirname(src), { recursive: true });
    execFileSync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=40:size=160x90:rate=10",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      src,
    ]);

    const ing = new LiveIngest(cfg(), "j4", { kind: "file-sim", url: src, sampleInterval: 0.5 });
    await ing.start();

    let count = 0;
    const t = (async () => {
      for await (const _f of ing.frames()) {
        count++;
      }
    })();

    // Wait until at least 10 frames are buffered on disk (ffmpeg has caught
    // up to ~10s of the source) so the buffered batch is non-trivial.
    const frameCount = async () => {
      try {
        const entries = await readdir(path.join(dataDir, "live", "j4", "frames"), { withFileTypes: true });
        return entries.filter((e) => e.name.startsWith("frame_")).length;
      } catch {
        return 0;
      }
    };
    const deadline = Date.now() + 30000;
    let bufferedBefore = 0;
    while (Date.now() < deadline) {
      bufferedBefore = await frameCount();
      if (bufferedBefore >= 10) break;
      await sleep(100);
    }
    expect(bufferedBefore).toBeGreaterThanOrEqual(10);

    // Stop. With the fix, the frames() generator exits at the next inner-loop
    // iteration — meaning it may finish the CURRENT on-disk batch (at most
    // `bufferedBefore` frames) and no more. Without the fix it would keep
    // draining the entire directory (which keeps growing while ffmpeg is
    // still writing) until the ffmpeg child exits (~40s of source).
    const stopAt = Date.now();
    await ing.stop();
    const stopMs = Date.now() - stopAt;

    // The stop() call itself must not block on the frame drain: the ffmpeg
    // child is SIGKILLed, and the frames() loop is only allowed to finish the
    // already-on-disk batch. Bound to well under the 40s source length.
    expect(stopMs).toBeLessThan(5000);

    await t;
    const afterStopMs = Date.now() - stopAt;

    // Total frames consumed by the generator MUST be bounded by the batch
    // that was on disk at the moment stop() ran (plus the one frame in flight
    // when we read the directory). This is the acceptance criterion: the
    // buffered batch does NOT grow to the full 40s-of-source count.
    // (Without the fix, `count` would be ~80 = 40s / 0.5s; with the fix,
    // `count <= bufferedBefore + 1`.)
    expect(count).toBeLessThanOrEqual(bufferedBefore + 1);
    // Sanity: we did consume the batch we waited for.
    expect(count).toBeGreaterThanOrEqual(Math.min(9, bufferedBefore));
    // The whole teardown (stop + iterator resolution) completes quickly.
    expect(afterStopMs).toBeLessThan(10000);
  });
});
