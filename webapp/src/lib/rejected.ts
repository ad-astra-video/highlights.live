// Rejected-clip lifecycle helpers (ADAAAA-5163 frontend leg, ADAAAA-5204).
//
// The backend marks a rejected clip with `rejectedAt` (ISO string) and, after a
// configured TTL (`rejectTtlMs`, default 24h), hard-deletes the storage object
// and the DB row via an hourly sweep. The client derives everything from the
// two values the API already exposes: `rejectedAt` on the highlight and
// `rejectedClipTtlMs` from GET /config (falling back to the 24h default when a
// server predates the config field).

/** Default recovery window for rejected clips (24h), matching the server's
 * REJECTED_CLIP_TTL_MS default. Used only as a pre-config fallback so the UI
 * never claims recoverability past the server's actual purge point. */
export const DEFAULT_REJECTED_CLIP_TTL_MS = 24 * 60 * 60 * 1000;

/** The absolute recovery deadline for a rejected clip, or null when it was
 * never rejected (no rejectedAt). Computed from the API's own fields so the
 * indicator always tracks the server's lifecycle, never a hardcoded client
 * copy. */
export function recoverUntil(rejectedAt: string | undefined, ttlMs: number): number | null {
  if (!rejectedAt) return null;
  const at = Date.parse(rejectedAt);
  if (Number.isNaN(at)) return null;
  return at + ttlMs;
}

/** True while the clip is still within its undo/recovery window (before the
 * TTL purge), so we can render the deadline + Recover affordance. Once the
 * deadline passes — even if the server sweep hasn't reclaimed the row yet —
 * the UI stops claiming recoverability (zero false "recoverable" claims). */
export function isRecoverable(rejectedAt: string | undefined, ttlMs: number, now: number): boolean {
  const until = recoverUntil(rejectedAt, ttlMs);
  return until !== null && now < until;
}

/** Human "recover until <relative>" string, e.g. "Recover until 23h 12m from
 * now" / "Recover until 12m from now". Uses the same compact H/M/S style as
 * the upload-progress/formatBytes helpers elsewhere in the app. */
export function formatRelativeRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "less than a minute";
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h >= 1) return `${h}h ${m}m`;
  if (m >= 1) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Build the "recover until" label for a rejected clip, or null when it is no
 * longer recoverable (past TTL / not rejected). The caller should render
 * nothing (or an "expired" state) when this is null. */
export function recoverLabel(rejectedAt: string | undefined, ttlMs: number, now: number): string | null {
  const until = recoverUntil(rejectedAt, ttlMs);
  if (until === null) return null;
  const remain = until - now;
  if (remain <= 0) return null;
  return `Recover until ${formatRelativeRemaining(remain)} from now`;
}
