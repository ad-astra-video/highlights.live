// ADAAAA-7734: bounded frame retention for the media (screen-share) rail.
//
// The rail persists the JPEG the media node already relayed, named by the frame's
// GLOBAL seq (`frame_<seq>.jpg`) so a decide note's `/jobs/<id>/frames/<seq>` uri
// resolves to the exact frame that was in its window — even after the oldest
// frames were decimated to keep the job bounded. These tests pin the naming,
// the retention policy and the non-blocking write contract.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LIVE_FRAME_CAP,
  LiveFrameWriter,
  decimationVictims,
  liveFrameFileName,
  parseLiveFrameSeq,
} from "../src/live-frames";

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "hl-live-frames-"));
}

describe("frame naming (seq <-> file)", () => {
  it("zero-pads so a lexicographic sort is the seq order", () => {
    expect(liveFrameFileName(0)).toBe("frame_000000.jpg");
    expect(liveFrameFileName(7)).toBe("frame_000007.jpg");
    expect(liveFrameFileName(1234)).toBe("frame_001234.jpg");
    const names = [liveFrameFileName(10), liveFrameFileName(2), liveFrameFileName(1000)].sort();
    expect(names.map((n) => parseLiveFrameSeq(n))).toEqual([2, 10, 1000]);
  });

  it("parses the seq back out of a file name, and rejects foreign names", () => {
    expect(parseLiveFrameSeq("frame_000000.jpg")).toBe(0);
    expect(parseLiveFrameSeq("frame_001799.jpg")).toBe(1799);
    expect(parseLiveFrameSeq("capture.webm")).toBeNull();
    expect(parseLiveFrameSeq("frame_x.jpg")).toBeNull();
  });
});

describe("decimation policy", () => {
  it("does nothing while the job is inside its retention cap", () => {
    expect(decimationVictims([0, 1, 2], LIVE_FRAME_CAP)).toEqual([]);
    expect(decimationVictims([], 4)).toEqual([]);
  });

  it("drops the OLDEST frames first, strided so the timeline keeps coverage", () => {
    // 6 retained, cap 4: shed 2, taking every other one from the oldest end.
    expect(decimationVictims([0, 1, 2, 3, 4, 5], 4)).toEqual([0, 2]);
    // Never proposes more victims than needed to get back under the cap.
    expect(decimationVictims([0, 1, 2, 3, 4], 3)).toEqual([0, 2]);
    // A pathological over-run still converges (second pass takes the rest).
    const big = Array.from({ length: 40 }, (_, i) => i);
    const victims = decimationVictims(big, 5);
    expect(big.length - victims.length).toBe(5);
    expect(victims).toContain(0);
  });
});

describe("LiveFrameWriter", () => {
  it("writes the relayed JPEG bytes and records the observation row", async () => {
    const dataDir = tmpDir();
    const seen: any[] = [];
    const w = new LiveFrameWriter({
      dataDir,
      jobId: "job-a",
      recordObservation: (_jobId, obs) => seen.push(obs),
    });
    for (let i = 0; i < 3; i++) {
      w.enqueue({
        seq: i,
        timestamp: i,
        frameB64: Buffer.from(`frame-${i}`).toString("base64"),
        tracks: i === 1 ? [{ trackId: "p1", label: "player" }] : [],
      });
    }
    await w.drain();

    const dir = path.join(dataDir, "live", "job-a", "frames");
    expect(readdirSync(dir).sort()).toEqual(["frame_000000.jpg", "frame_000001.jpg", "frame_000002.jpg"]);
    expect(readFileSync(path.join(dir, "frame_000001.jpg")).toString()).toBe("frame-1");
    expect(seen.map((o) => o.seq)).toEqual([0, 1, 2]);
    expect(seen[1].tracks).toHaveLength(1);
    expect(seen[2].timestamp).toBe(2);
    expect(w.count()).toBe(3);
    expect(w.stats()).toMatchObject({ enqueued: 3, written: 3, decimated: 0, failed: 0 });
  });

  it("bounds retained frames at the cap and leaves the surviving seqs servable", async () => {
    const dataDir = tmpDir();
    const w = new LiveFrameWriter({ dataDir, jobId: "job-cap", cap: 4 });
    for (let i = 0; i < 6; i++) {
      w.enqueue({ seq: i, timestamp: i, frameB64: Buffer.from(`f${i}`).toString("base64"), tracks: [] });
    }
    await w.drain();

    const dir = path.join(dataDir, "live", "job-cap", "frames");
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(4);
    // The relayed count is still the honest one the job reports.
    expect(w.count()).toBe(6);
    const retained = files.map((f) => parseLiveFrameSeq(f)!);
    expect(retained).toEqual(w.retainedSeqs());
    // Retained frames are the newest ones (oldest-first decimation), contiguous.
    expect(retained).toEqual([2, 3, 4, 5]);
    // Deleted frames are really gone from disk, so no tile 404s or shifts.
    expect(existsSync(path.join(dir, liveFrameFileName(0)))).toBe(false);
    expect(readFileSync(path.join(dir, liveFrameFileName(5))).toString()).toBe("f5");
  });

  it("never throws on a malformed enqueue (off the observe callback path)", async () => {
    const w = new LiveFrameWriter({ dataDir: tmpDir(), jobId: "job-bad" });
    expect(() => w.enqueue({ seq: NaN, timestamp: 0, frameB64: "abc", tracks: [] })).not.toThrow();
    expect(() => w.enqueue({ seq: 1, timestamp: 0, frameB64: "", tracks: [] })).not.toThrow();
    await w.drain();
    expect(w.count()).toBe(0);
  });
});
