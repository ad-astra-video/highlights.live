// ADAAAA-7847: unit tests for the jersey-identify ANCHOR sample (request-time,
// above the streaming rail scale). These pin the pure decisions so the cost and
// the "never upscale / never a second streaming pass" bounds cannot regress.
import { describe, it, expect } from "vitest";
import { buildAnchorFrameArgs, clampScaleToSource, copyTailBytes } from "../src/ffmpeg";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  anchorFrameCount,
  anchorSourceCandidates,
  anchorSpanSeconds,
  vodAnchorAtSec,
  PLAYER_ANCHOR_MAX_FRAMES,
  PLAYER_ANCHOR_MAX_SPAN_S,
  PLAYER_ANCHOR_MIN_SPAN_S,
} from "../src/player-anchor";

describe("anchor scale clamping (ADAAAA-7847)", () => {
  it("uses the configured scale when the source is at least that big", () => {
    expect(clampScaleToSource("1280:720", { width: 1920, height: 1080 })).toBe("1280:720");
    expect(clampScaleToSource("1280:720", { width: 1280, height: 720 })).toBe("1280:720");
  });

  it("never upscales a smaller source (aspect-preserving ffmpeg form)", () => {
    expect(clampScaleToSource("1280:720", { width: 320, height: 180 })).toBe("min(1280\\,iw):-2");
    // one axis over the source is enough to clamp
    expect(clampScaleToSource("1280:1080", { width: 1280, height: 720 })).toBe("min(1280\\,iw):-2");
  });

  it("passes the configured scale through when the source cannot be probed", () => {
    expect(clampScaleToSource("1280:720", null)).toBe("1280:720");
  });

  it("accepts the x separator and a non-numeric value", () => {
    expect(clampScaleToSource("640x360", { width: 1280, height: 720 })).toBe("640:360");
    expect(clampScaleToSource("iw:ih", { width: 1280, height: 720 })).toBe("iw:ih");
  });
});

describe("anchor frame args (ADAAAA-7847)", () => {
  const base = { source: "/data/clips/clip.mp4", outDir: "/tmp/anchor", scale: "1280:720", count: 6 };

  it("samples the LIVE EDGE of the recording when no anchor time is given", () => {
    const args = buildAnchorFrameArgs(base);
    expect(args).toContain("-sseof");
    expect(args[args.indexOf("-sseof") + 1]).toBe("-1.5");
    expect(args).not.toContain("-ss");
    // one decode, hard-capped frame count, the anchor scale on the filter chain
    expect(args[args.indexOf("-frames:v") + 1]).toBe("6");
    expect(args[args.indexOf("-vf") + 1]).toBe("fps=4.000,scale=1280:720");
    expect(args[args.length - 1]).toBe("/tmp/anchor/anchor_%02d.jpg");
    // audio is not decoded: the identify pass needs pixels only
    expect(args).toContain("-an");
  });

  it("seeks a VOD pass to the window ENDING at the current position", () => {
    const args = buildAnchorFrameArgs({ ...base, atSec: 60 });
    expect(args[args.indexOf("-ss") + 1]).toBe("58.5"); // 60 - span 1.5
    expect(args[args.indexOf("-t") + 1]).toBe("1.5");
    expect(args).not.toContain("-sseof");
  });

  it("seeks a tail copy from the OUTPUT side (needs only its first keyframe)", () => {
    const args = buildAnchorFrameArgs({ ...base, atSec: 4, seekAfterInput: true, quiet: true });
    // -ss comes AFTER -i: decode-and-discard from the copy's first keyframe
    const iIdx = args.indexOf("-i");
    const ssIdx = args.indexOf("-ss");
    expect(ssIdx).toBeGreaterThan(iIdx);
    expect(args[ssIdx + 1]).toBe("2.5");
    expect(args).not.toContain("-t");
    expect(args[args.indexOf("-loglevel") + 1]).toBe("quiet");
  });

  it("clamps a window that would start before the file", () => {
    const args = buildAnchorFrameArgs({ ...base, atSec: 0.4 });
    expect(args[args.indexOf("-ss") + 1]).toBe("0");
  });

  it("bounds the burst so a request can never become a streaming pass", () => {
    expect(anchorFrameCount(0)).toBe(1);
    expect(anchorFrameCount(6)).toBe(6);
    expect(anchorFrameCount(999)).toBe(PLAYER_ANCHOR_MAX_FRAMES);
    expect(anchorFrameCount(Number.NaN)).toBe(8);
    const args = buildAnchorFrameArgs({ ...base, count: 999 });
    expect(args[args.indexOf("-frames:v") + 1]).toBe(String(PLAYER_ANCHOR_MAX_FRAMES));
  });

  it("bounds the window length", () => {
    expect(anchorSpanSeconds(0)).toBe(PLAYER_ANCHOR_MIN_SPAN_S);
    expect(anchorSpanSeconds(999)).toBe(PLAYER_ANCHOR_MAX_SPAN_S);
    expect(anchorSpanSeconds(Number.NaN)).toBe(1);
    const args = buildAnchorFrameArgs({ ...base, spanS: 999 });
    expect(args[args.indexOf("-sseof") + 1]).toBe(`-${PLAYER_ANCHOR_MAX_SPAN_S}`);
  });
});

describe("tail copy (ADAAAA-7847)", () => {
  it("copies only the last maxBytes of a source, and the whole file when small", async () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } = await import("node:fs");
    const tmp = mkdtempSync(path.join(tmpdir(), "hl-anchor-tail-"));
    try {
      const src = path.join(tmp, "src.ts");
      const dest = path.join(tmp, "tail.ts");
      writeFileSync(src, Buffer.from("0123456789"));
      const n = await copyTailBytes(src, dest, 4);
      expect(n).toBe(4);
      expect(readFileSync(dest, "utf8")).toBe("6789");
      // a source smaller than the budget is copied whole
      const n2 = await copyTailBytes(src, dest, 1024);
      expect(n2).toBe(10);
      expect(readFileSync(dest, "utf8")).toBe("0123456789");
      // an empty/missing source yields null (no fabricated anchor)
      expect(await copyTailBytes(path.join(tmp, "nope.ts"), dest, 1024)).toBeNull();
      writeFileSync(src, "");
      expect(await copyTailBytes(src, dest, 1024)).toBeNull();
      expect(statSync(dest).size).toBe(10);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("anchor source (ADAAAA-7847)", () => {
  const dataDir = "/data";

  it("samples a VOD job's source file", () => {
    expect(anchorSourceCandidates({ id: "j1", source: "file", sourceUrl: "/data/uploads/j1/a.mp4" }, dataDir))
      .toEqual(["/data/uploads/j1/a.mp4"]);
  });

  it("samples the live recording, never the ingest URL, on an rtmp rail", () => {
    const cands = anchorSourceCandidates({ id: "j2", source: "rtmp", sourceUrl: "rtmp://edge/live/abc" }, dataDir);
    expect(cands[0]).toBe("/data/live/j2/session.ts");
    expect(cands.some((c) => c.startsWith("rtmp://"))).toBe(false);
  });

  it("prefers a LOCAL ingest file over its lossy re-encode (file-sim rail)", () => {
    const cands = anchorSourceCandidates(
      { id: "j5", source: "file-sim", sourceUrl: "/data/clips/clip.mp4" },
      dataDir
    );
    expect(cands[0]).toBe("/data/clips/clip.mp4");
    expect(cands).toContain("/data/live/j5/session.ts");
  });

  it("falls back to the assembled browser capture", () => {
    const cands = anchorSourceCandidates({ id: "j3", source: "browser" }, dataDir);
    expect(cands).toEqual(["/data/live/j3/session.ts", "/data/live/j3/capture.webm", "/data/live/j3/capture.mp4"]);
  });

  it("has no candidate for a job with no source", () => {
    expect(anchorSourceCandidates(null, dataDir)).toEqual([]);
    expect(anchorSourceCandidates({ id: "j4", source: "file" }, dataDir)).toEqual([]);
  });
});

describe("VOD anchor time (ADAAAA-7847)", () => {
  it("anchors on the position the VOD pass has reached", () => {
    expect(vodAnchorAtSec({ source: "file", framesAnalyzed: 90 }, 3)).toBe(30);
  });

  it("is null for a live/browser job (the live edge is the anchor)", () => {
    expect(vodAnchorAtSec({ source: "rtmp", framesAnalyzed: 90 }, 3)).toBeNull();
    expect(vodAnchorAtSec({ source: "browser", framesAnalyzed: 90 }, 3)).toBeNull();
  });

  it("is null before the pass has sampled anything, and never divides by zero", () => {
    expect(vodAnchorAtSec({ source: "file", framesAnalyzed: 0 }, 3)).toBeNull();
    expect(vodAnchorAtSec({ source: "file" }, 3)).toBeNull();
    expect(vodAnchorAtSec(null, 3)).toBeNull();
    expect(vodAnchorAtSec({ source: "file", framesAnalyzed: 6 }, 0)).toBe(6);
  });
});
