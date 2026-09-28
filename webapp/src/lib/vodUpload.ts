// Pure helpers for the VOD "Upload / file" source. Kept framework-free so the
// client-side pre-check and oversized-file help text are unit-testable without
// a DOM (see webapp/src/lib/vodUpload.test.ts).
import { formatBytes } from "./api";

/** True when a file of `size` bytes exceeds the server's upload cap. The client
 * rejects BEFORE any bytes are sent; the server enforces the same cap with 413. */
export function isOverLimit(size: number, limit: number): boolean {
  return size > limit;
}

/** The required oversized-file help text — points the user at the URL fallback
 * (which stays reachable via the "Paste a download URL instead" control). */
export function oversizedHelp(limit: number): string {
  return `File too large (max ${formatBytes(limit)}). Paste a download URL instead to process it.`;
}

/** Above this file size the browser uploads in chunks instead of one request
 * body. The deployed app is reached through a Cloudflare proxy/tunnel whose free
 * plan caps each proxied request body at ~100 MB (ADAAAA-5704); a smaller file
 * fits one request unchanged, a larger one is sliced so every part stays well
 * under the edge cap. 80 MiB ≈ 83.9 MB leaves headroom under 100 MB. */
export const VOD_SINGLE_SHOT_MAX = 80 * 1024 * 1024;

/** Byte ranges for slicing a `size`-byte file into `chunkBytes`-sized chunks
 * (last chunk is the remainder). Pure + unit-tested; the uploader feeds each
 * range to a separate POST /jobs/upload/:uploadId/chunk request. */
export function chunkRanges(size: number, chunkBytes: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  if (!(size > 0) || !(chunkBytes > 0)) return ranges;
  for (let start = 0; start < size; start += chunkBytes) {
    ranges.push({ start, end: Math.min(start + chunkBytes, size) });
  }
  return ranges;
}
