// What the live screen-share panel says when the job ends underneath it
// (ADAAAA-7700).
//
// The 22:16Z defect: the media node was recreated mid-share, the RTC session died,
// and the webapp surfaced NOTHING — the job just flipped to `failed` with 0 frames.
// The client cannot see the media node directly, but it CAN read its own job row:
// every terminal transition is attributed server-side (`failureReason`), so a
// short poll turns "silence" into "the media node restarted — reshare".
//
// Pure + dependency-free so it is unit-testable without a browser/DOM.

export interface CaptureJobSnapshot {
  status?: string | null;
  failureReason?: string | null;
  error?: string | null;
}

export interface CaptureEndedNotice {
  /** true when the panel must stop capturing (the job is over). */
  stop: boolean;
  /** actionable message to show, or null while the share is healthy. */
  message: string | null;
}

const MEDIA_LOST = "Media node restarted — the share stopped and this recording ended. Click Start to share again.";
const SERVER_RESTART = "The analyzer restarted during this share, so the run could not continue. Click Start to share again.";
const GENERIC_FAILED = "This share ended with an error. Click Start to share again.";

/**
 * Decide what the capture panel does for one poll of the job record.
 *
 * - `active`/`queued`/…: keep capturing, say nothing.
 * - terminal `failed`: stop, and explain WHY using the attributed reason (falling
 *   back to the server's own `error` text, then a generic line).
 * - terminal `done` while still capturing: the share ended server-side (session
 *   closed) — stop quietly; there is nothing to apologise for.
 */
export function captureEndedNotice(job: CaptureJobSnapshot | null | undefined): CaptureEndedNotice {
  if (!job || !job.status) return { stop: false, message: null };
  if (job.status === "failed") {
    const reason = job.failureReason ?? null;
    const message =
      reason === "media-session-lost"
        ? MEDIA_LOST
        : reason === "server-restart"
        ? SERVER_RESTART
        : job.error
        ? `${job.error} Click Start to share again.`
        : GENERIC_FAILED;
    return { stop: true, message };
  }
  if (job.status === "done" || job.status === "cancelled") {
    return { stop: true, message: null };
  }
  return { stop: false, message: null };
}
