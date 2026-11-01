// Failure attribution for a job that ends without a user stop (ADAAAA-7700).
//
// The 22:16Z incident: the media node was recreated mid-share, the RTC session
// died with it, and the browser job landed as a bare `status: failed` with 0
// frames and no reason — indistinguishable from "the pipeline never ran". The
// webapp surfaced nothing at all.
//
// This module is the single mapping from "why did the session end" to "what does
// the job record say", kept pure so it is unit-testable without a media node:
//
//   - `outcomeForMediaCloseReason(reason)`   media node close reason -> job outcome
//   - `outcomeForStrandedJob(source, hadMediaSession)` boot sweep -> job outcome
//
// Messages are the user-facing text: they must name the cause AND the next action
// ("click Start to share again"), never just "failed".

import type { Job } from "@highlights/events";

/** Machine-readable reasons carried on `job.failureReason`. */
export type JobFailureReason = NonNullable<Job["failureReason"]>;

export type JobOutcome =
  | { status: "done" }
  | { status: "failed"; failureReason: JobFailureReason; error: string };

/** The media node restarted (or the RTC session was dropped) under a live share. */
export const MEDIA_SESSION_LOST_MESSAGE =
  "Media node restarted — the screen share stopped on the media side, so this recording ended. Click Start to share again.";

/** The control plane itself restarted mid-share; the in-flight run cannot resume. */
export const SERVER_RESTART_MESSAGE =
  "The analyzer restarted while this share was live, so the run could not continue. Click Start to share again.";

/** Close reasons that mean "the operator ended the share", not a failure. */
const USER_CLOSE_REASONS = new Set(["client-closed", "control-close"]);

/**
 * Map a media-node session-close reason (ADAAAA-7689 AC3 callback) to the job's
 * outcome. Only a session that died WITH the node is a failure; a client or
 * control close is the normal end of a share and stays `done`.
 */
export function outcomeForMediaCloseReason(reason: string): JobOutcome {
  if (reason === "media-node-restart" || reason === "session-lost" || reason === "media-node-crash") {
    return { status: "failed", failureReason: "media-session-lost", error: MEDIA_SESSION_LOST_MESSAGE };
  }
  // `client-closed`, `control-close`, `no-client-timeout`, `payment-failure` and
  // anything unknown keep the pre-7700 behaviour: the share is over, the job is
  // finalized as done (clips are still cut from whatever was recorded).
  if (!USER_CLOSE_REASONS.has(reason) && reason !== "no-client-timeout" && reason !== "payment-failure") {
    // Unknown reason: treat as an ordinary end, never invent a failure.
    return { status: "done" };
  }
  return { status: "done" };
}

/**
 * Map a job stranded at server boot (no in-flight run survives a restart) to its
 * failure attribution. A browser share whose `media_sessions` row still exists
 * was carried by a media node that went away in the same window — the honest
 * reason is `media-session-lost`, not "the pipeline never ran".
 */
export function outcomeForStrandedJob(source: Job["source"], hadMediaSession: boolean): JobOutcome {
  if (source === "browser") {
    return hadMediaSession
      ? { status: "failed", failureReason: "media-session-lost", error: MEDIA_SESSION_LOST_MESSAGE }
      : { status: "failed", failureReason: "server-restart", error: SERVER_RESTART_MESSAGE };
  }
  return { status: "failed", failureReason: "server-restart", error: SERVER_RESTART_MESSAGE };
}
