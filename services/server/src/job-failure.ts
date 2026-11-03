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

// ---------------------------------------------------------------------------
// ADAAAA-7906 (VOD resume, Increment 2): failure classification + retry policy.
//
// `classifyVodFailure(e)` is the SINGLE mapping from a thrown VOD pipeline error
// to `{ reason, resumable }` implementing plan §2.3. It is pure so the table is
// unit-testable without a GPU. Every caller of `markJobFailed` must reach a row
// of this table — a path left unclassified falls through to
// `pipeline-error`/non-resumable and silently disables the retry for that
// incident class, so add the row here when a new failure path appears.
//
// Resumable classes (auto-retry, status `queued` + stage `retry-scheduled`):
//   decide-unavailable      decide call failed (5xx/timeout/fallback exhausted)
//   perceive-session-lost   perceive re-reserve exhausted / runner recreated
//   capacity-exhausted      no capacity for runner after the bounded backoff
//   server-restart          crash/restart mid-pass (Increment 4 wires the boot path)
// Non-resumable (terminal `failed` immediately):
//   pipeline-error          ffmpeg decode / missing or corrupt source / schema
//   user-stop               operator stop (markJobCancelled owns that transition)
// ---------------------------------------------------------------------------

export interface VodFailureClassification {
  reason: JobFailureReason;
  resumable: boolean;
}

/** Error names/markers that mean "the perceive session was lost, not the job". */
function errorName(e: unknown): string {
  return e && typeof e === "object" && "name" in e ? String((e as { name?: unknown }).name ?? "") : "";
}

/** Messages matching these are a broken INPUT, never a transient failure: a
 * retry would fail the same way and burn the budget. */
const NON_RESUMABLE_INPUT =
  /ffmpeg|invalid data|moov atom|corrupt|unsupported codec|decode error|no such file|ENOENT|schema|validation|zod/i;

const CAPACITY = /no capacity available for runner/i;
const DECIDE = /decide/i;
const DECIDE_TRANSIENT = /HTTP 5\d\d|HTTP 429|timed? ?out|timeout|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|fallback/i;
const RESTART = /server restart|restarted|restart mid-pass|process exit/i;

/**
 * Map a thrown VOD pipeline error to its `failureReason` and whether a resume
 * may retry it.
 */
export function classifyVodFailure(e: unknown): VodFailureClassification {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const name = errorName(e);
  const statusCode = (e as { statusCode?: number; status?: number } | undefined)?.statusCode ?? (e as any)?.status;
  // Operator stop: never resurrected, never retried.
  if (name === "VodCancelledError" || /cancelled|canceled|user stop/i.test(msg)) {
    return { reason: "user-stop", resumable: false };
  }
  // Perceive session/runner loss after the bounded re-reserve (SessionLostError)
  // or a deploy-recreate interruption — both are transient and retriable.
  if (name === "SessionLostError" || name === "DeployRecreateInterruptedError") {
    return { reason: "perceive-session-lost", resumable: true };
  }
  // Capacity-1 perceive runner still saturated after `reservePerceiveWithBackoff`.
  if (CAPACITY.test(msg) || statusCode === 503) {
    return { reason: "capacity-exhausted", resumable: true };
  }
  // Decide service unavailable (5xx/timeout/fallback exhausted).
  if (DECIDE.test(msg) && DECIDE_TRANSIENT.test(msg)) {
    return { reason: "decide-unavailable", resumable: true };
  }
  // Control plane restarted mid-pass (boot recovery, Increment 4).
  if (RESTART.test(msg)) {
    return { reason: "server-restart", resumable: true };
  }
  // Broken input / decode / schema: terminal, no retry.
  if (NON_RESUMABLE_INPUT.test(msg)) {
    return { reason: "pipeline-error", resumable: false };
  }
  // Unknown: the historical attribution, and NOT resumable. Retrying an
  // unexplained failure risks a loop that masks a real defect.
  return { reason: "pipeline-error", resumable: false };
}
