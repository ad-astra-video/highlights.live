// ADAAAA-8495 (AC1/item 2): the flush wait stops demuxing the growing recording
// per 250 ms poll.
//
// ADAAAA-8487 AC-A measured `LiveIngest.waitForFlushedCoverage` as the dominant
// single bucket inside the live accept stage: one `ffprobe` of the growing
// 292 MB MPEG-TS on every 250 ms iteration, 25,425 ms of the 51,737 ms accept
// stage on the 7 separable rows of leg `2c4124fe`. The recorder itself already
// knows how much it has muxed (`ffmpeg -progress` reports `out_time_us` every
// ~0.5 s), so that is the watermark the cut waits on; the demux survives only
// as a ONE-per-second cross-check and as the fallback when no progress arrives.
//
// These tests pin: the parser (complete blocks only), the watermark moving on a
// real recording, a cut that spends at most a couple of demuxes instead of one
// per poll, and the unchanged timeout refusal.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiveIngest, parseRecorderProgress } from "../src/live";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const tmp = mkdtempSync(path.join(tmpdir(), "hl-flush-wm-"));
const dataDir = path.join(tmp, "data");
const sourcePath = path.join(tmp, "source.mp4");

beforeAll(() => {
  if (!hasFfmpeg) return;
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc=duration=8:size=320x180:rate=10",
    "-pix_fmt", "yuv420p",
    "-c:v", "libx264", "-preset", "veryfast",
    sourcePath,
  ]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function cfg() {
  return {
    ffmpegPath: "ffmpeg",
    dataDir,
    clipBeforeS: 1.5,
    clipAfterS: 1.5,
    clipWindowMinSec: 3,
    liveFrameScale: "320:180",
  } as any;
}

describe("parseRecorderProgress (ADAAAA-8495)", () => {
  it("reads the newest COMPLETE block and keeps the in-flight tail", () => {
    const chunk =
      "frame=10\nout_time_us=1000000\nprogress=continue\n" +
      "frame=20\nout_time_us=2500000\nprogress=continue\n" +
      "frame=30\nout_time_us=4000000\n";
    const r = parseRecorderProgress(chunk);
    // 2.5 s is the newest block closed by a `progress=` line; the 4.0 s block is
    // still being written and must NOT be read as flushed.
    expect(r.outTimeSec).toBe(2.5);
    expect(r.end).toBe(false);
    expect(r.rest).toContain("frame=30");
    expect(r.rest).not.toContain("out_time_us=1000000");
    // Feeding the rest of that block moves the watermark.
    const next = parseRecorderProgress(r.rest + "progress=continue\n");
    expect(next.outTimeSec).toBe(4);
  });

  it("accepts the `out_time_ms` spelling (same microseconds) and the clock form", () => {
    expect(parseRecorderProgress("out_time_ms=1250000\nprogress=continue\n").outTimeSec).toBe(1.25);
    expect(parseRecorderProgress("out_time=00:00:02.500000\nprogress=continue\n").outTimeSec).toBe(2.5);
  });

  it("reports the end marker and ignores garbage", () => {
    expect(parseRecorderProgress("out_time_us=3000000\nprogress=end\n").end).toBe(true);
    expect(parseRecorderProgress("no progress lines yet").outTimeSec).toBeNull();
  });
});

describe("LiveIngest flush watermark (ADAAAA-8495)", () => {
  it("advances on a real recording and a cut spends at most a couple of demuxes", async () => {
    if (!hasFfmpeg) return;
    const ingest = new LiveIngest(cfg(), "job-wm", {
      kind: "file-sim",
      url: sourcePath,
      sampleInterval: 0.5,
    });
    let probes = 0;
    (ingest as any).probeFlushed = async (ffmpegPath: string, file: string) => {
      probes++;
      const { probeFlushedDuration } = await import("../src/ffmpeg");
      return probeFlushedDuration(ffmpegPath, file);
    };
    try {
      await ingest.start();
      // Wait for the recorder's own watermark to reach the window end.
      const deadline = Date.now() + 20_000;
      while ((ingest.flushedSec() ?? 0) < 6.4 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // The watermark came from `-progress`, not from a demux.
      expect(ingest.flushedSec()).toBeGreaterThanOrEqual(6.4);
      expect(probes).toBe(0);
      const clip = await ingest.cut(2);
      expect(clip.clipUri).toMatch(/\/clips\/.+\.mp4$/);
      // The cut published a file. (What is IN it — the score-flip anchor, the
      // >= window floor — is `live-ingest-anchor.test.ts`'s job; this fixture is
      // a synthetic 8 s source and asserts the FLUSH path, not delivery.)
      expect(existsSync(path.join(dataDir, "clips", `${clip.clipId}.mp4`))).toBe(true);
      // One cut = at most a confirm demux (plus the probe inside the cut's own
      // duration check), never one per 250 ms poll.
      expect(probes).toBeLessThanOrEqual(2);
    } finally {
      await ingest.stop();
    }
  }, 40_000);

  it("still refuses a window the recorder has not flushed (45 s bound and refusal intact)", async () => {
    if (!hasFfmpeg) return;
    // A 2 s session file, and a recorder still marked running: the window asks
    // for footage that is not there yet, so the cut must refuse rather than
    // publish a truncated clip.
    const jobId = "job-wm-short";
    const liveDir = path.join(dataDir, "live", jobId);
    mkdirSync(liveDir, { recursive: true });
    execFileSync("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=10",
      "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast",
      "-f", "mpegts",
      path.join(liveDir, "session.ts"),
    ]);
    const ingest = new LiveIngest(cfg(), jobId, {
      kind: "file-sim",
      url: sourcePath,
      sampleInterval: 0.5,
    });
    ingest.running = true; // the recorder is still writing
    await expect(ingest.cut(14, { maxFlushWaitMs: 400 })).rejects.toThrow(/not flushed within/);
  }, 20_000);
});
