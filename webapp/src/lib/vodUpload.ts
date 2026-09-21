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
