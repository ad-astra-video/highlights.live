import { describe, it, expect } from "vitest";
import { isOverLimit, oversizedHelp, chunkRanges, VOD_SINGLE_SHOT_MAX } from "./vodUpload";
import { formatBytes, VOD_MAX_UPLOAD_BYTES } from "./api";

describe("chunkRanges (Cloudflare ~100MB edge-cap workaround, ADAAAA-5714)", () => {
  it("slices a file into chunkBytes-sized ranges with the last one as remainder", () => {
    expect(chunkRanges(100, 30)).toEqual([
      { start: 0, end: 30 },
      { start: 30, end: 60 },
      { start: 60, end: 90 },
      { start: 90, end: 100 },
    ]);
  });
  it("a file exactly one chunk yields a single range", () => {
    expect(chunkRanges(30, 30)).toEqual([{ start: 0, end: 30 }]);
  });
  it("a file smaller than one chunk yields a single full-range chunk", () => {
    expect(chunkRanges(10, 30)).toEqual([{ start: 0, end: 10 }]);
  });
  it("rejects non-positive size or chunk size", () => {
    expect(chunkRanges(0, 30)).toEqual([]);
    expect(chunkRanges(100, 0)).toEqual([]);
  });
  it("a 454MB file at the default 64MiB chunk size stays under the edge cap per chunk", () => {
    // 454 MiB file, 64 MiB chunks -> 8 parts, each <= 64 MiB (~67.1MB) << 100MB.
    const sizes = chunkRanges(454 * 1024 * 1024, 64 * 1024 * 1024).map((r) => r.end - r.start);
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBe(64 * 1024 * 1024);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(454 * 1024 * 1024);
  });
  it("the single-shot threshold is safely under the ~100MB Cloudflare edge cap", () => {
    // 80 MiB ≈ 83.9 MB < 100 MB, so single-shot bodies below the threshold never
    // trip Cloudflare's own 413.
    expect(VOD_SINGLE_SHOT_MAX).toBe(80 * 1024 * 1024);
    expect(VOD_SINGLE_SHOT_MAX).toBeLessThan(100 * 1024 * 1024);
  });
});

const TWO_GB = 2147483648;
const UNDER = TWO_GB - 1;
const OVER = TWO_GB + 1;

describe("VOD upload client-side size pre-check (2 GB default)", () => {
  it("accepts a file at or under the cap and rejects one over it", () => {
    expect(isOverLimit(TWO_GB, TWO_GB)).toBe(false); // exactly at the cap is fine
    expect(isOverLimit(UNDER, TWO_GB)).toBe(false);
    expect(isOverLimit(OVER, TWO_GB)).toBe(true); // > cap -> reject BEFORE upload
  });
});

describe("oversized-file help text (URL-fallback conversion point)", () => {
  it("points the user to paste a download URL when the file exceeds the cap", () => {
    const msg = oversizedHelp(TWO_GB);
    expect(msg).toContain("File too large");
    expect(msg).toContain("max 2 GB");
    expect(msg).toContain("Paste a download URL instead to process it.");
  });

  it("reflects a custom server cap", () => {
    const msg = oversizedHelp(50 * 1024 * 1024);
    expect(msg).toContain("max 50 MB");
    expect(msg).toContain("Paste a download URL instead");
  });
});

describe("formatBytes", () => {
  it("formats common sizes", () => {
    expect(formatBytes(TWO_GB)).toBe("2 GB");
    expect(formatBytes(5 * 1024 * 1024)).toContain("MB");
    expect(formatBytes(0)).toBe("0 B");
  });
});

describe("default cap constant", () => {
  it("mirrors the server default of 2 GB", () => {
    expect(VOD_MAX_UPLOAD_BYTES).toBe(TWO_GB);
  });
});
