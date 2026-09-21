import { describe, it, expect } from "vitest";
import { isOverLimit, oversizedHelp } from "./vodUpload";
import { formatBytes, VOD_MAX_UPLOAD_BYTES } from "./api";

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
