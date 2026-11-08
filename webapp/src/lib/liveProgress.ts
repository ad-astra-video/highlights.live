// ADAAAA-7741: presentation of the customer-facing processing-lag chip.
//
// Pure + testable (no React) so the exact copy the board asked for is pinned in
// a unit test: a missing analysis window has to read as a BOUNDED lag budget,
// never as a silent failure, and a caught-up live job has to say so.
//
// The inputs are the server's read-time projection (`liveProgress`), which
// carries no pipeline or spend internals.
import type { LiveProgress } from "./jobDetail";

/**
 * The live observe lag budget (content seconds). Mirrors
 * `LIVE_OBSERVE_LAG_BUDGET_S` in services/server/src/observe-loop.ts — the
 * customer copy names the default budget so "2 windows skipped" reads as
 * budgeted behaviour rather than a dropped failure.
 */
export const LIVE_PROGRESS_BUDGET_S = 30;

/**
 * ADAAAA-7759: the chip goes stale after this many seconds without a successful
 * light `GET /jobs/:id` read. The light poll runs every 5 s, so 10 s is two
 * missed cycles — long enough that a single dropped read is not alarming, short
 * enough that a persistent failure is stated instead of leaving a stale lag
 * number ticking on screen with no explanation.
 */
export const LIVE_PROGRESS_STALE_MIN_SEC = 10;

/**
 * ADAAAA-7759: how many CONSECUTIVE failed light reads (5 s apart) before the
 * page also surfaces the failure on the existing error-banner path. 3 reads =
 * 15 s of failed refresh, which is the point where "one flaky read" stops being
 * a plausible explanation.
 */
export const LIVE_PROGRESS_STALE_AFTER_FAILED_READS = 3;

/**
 * Health of the light 5 s job read that feeds the lag chip (ADAAAA-7759).
 *
 * The chip holds the last honest projection by design (holding a number beats
 * blanking it), but a persistent failure must not be silent: this tracks how
 * long the last successful read is stale for so the chip can say so.
 */
export interface LiveReadHealth {
  /** Consecutive failed reads; reset to 0 by a successful read. */
  consecutiveFailures: number;
  /** Epoch ms of the last successful read; 0 when none has succeeded yet. */
  lastOkAt: number;
  /** Epoch ms of the first failure in the current failing streak; 0 while healthy. */
  failingSince: number;
  /** Whole seconds the reading has been stale (0 while healthy). */
  staleSec: number;
  /** Message from the most recent failure, for the stated-failure banner. */
  lastError: string | null;
}

export const LIVE_READ_HEALTH_FRESH: LiveReadHealth = {
  consecutiveFailures: 0,
  lastOkAt: 0,
  failingSince: 0,
  staleSec: 0,
  lastError: null,
};

/**
 * Fold one light-read outcome into the health state.
 *
 * A success resets everything. A failure ages the reading from the last
 * success — or, when no light read has ever succeeded, from the first failure
 * in the streak — so the chip can state how stale its number is even on a page
 * that has never had a healthy light read.
 */
export function nextLiveReadHealth(
  prev: LiveReadHealth,
  outcome: { ok: boolean; at: number; error?: string | null },
): LiveReadHealth {
  if (outcome.ok) {
    return { consecutiveFailures: 0, lastOkAt: outcome.at, failingSince: 0, staleSec: 0, lastError: null };
  }
  const failingSince = prev.failingSince || outcome.at;
  const anchor = prev.lastOkAt || failingSince;
  const staleSec = Math.max(0, Math.round((outcome.at - anchor) / 1000));
  return {
    consecutiveFailures: prev.consecutiveFailures + 1,
    lastOkAt: prev.lastOkAt,
    failingSince,
    staleSec,
    lastError: outcome.error ?? "read failed",
  };
}

/**
 * ADAAAA-7759: the stated-failure banner copy for a persistent failed light
 * read, or `null` while the failure is still within the transient window.
 *
 * Below LIVE_PROGRESS_STALE_AFTER_FAILED_READS the chip alone carries the stale
 * clause (a single dropped read is normal); at/after it the page also says which
 * read failed and how old the number on screen is, so a long outage is never a
 * silent freeze.
 */
export function liveProgressFailureNotice(health: LiveReadHealth): string | null {
  if (health.consecutiveFailures < LIVE_PROGRESS_STALE_AFTER_FAILED_READS) return null;
  const age = Math.max(0, Math.round(health.staleSec));
  return `Live lag refresh failing (${health.lastError ?? "read failed"}) — the chip shows the last reading from ${age} s ago. The job keeps processing.`;
}

/**
 * The lag chip copy for an in-flight job, or `null` when there is nothing
 * honest to show yet (no decided window, or a terminal job whose completion
 * state belongs in the status chip).
 *
 * - behind:    `Processing - 26 s behind live`
 * - caught up: `Live - caught up (3 s)`
 * - skipped:   `… · 2 windows skipped past the 30 s budget`
 * - stale:     `Processing - 36 s behind live (stale: last read 21 s ago)`
 *              ADAAAA-7759: a failed light read keeps the last honest number,
 *              but once it is older than LIVE_PROGRESS_STALE_MIN_SEC the chip
 *              states that it is stale instead of freezing silently.
 */
export function liveProgressChipLabel(progress?: LiveProgress | null, staleSec = 0): string | null {
  const stale = Number.isFinite(staleSec) ? Math.max(0, Math.round(staleSec)) : 0;
  const staleClause = stale >= LIVE_PROGRESS_STALE_MIN_SEC ? ` (stale: last read ${stale} s ago)` : "";
  if (!progress || progress.state === "unknown") {
    // ADAAAA-7759: no projection yet AND the refresh is failing — say the lag is
    // unavailable rather than rendering nothing (which would be a silent freeze).
    return staleClause ? `Processing - live lag unavailable${staleClause}` : null;
  }
  const lag = Math.max(0, Math.round(Number(progress.lagSec) || 0));
  const head = progress.state === "caught_up" ? `Live - caught up (${lag} s)` : `Processing - ${lag} s behind live`;
  const skipped = Math.max(0, Math.round(Number(progress.skippedWindows) || 0));
  const skippedClause =
    skipped === 0 ? "" : ` · ${skipped} window${skipped === 1 ? "" : "s"} skipped past the ${LIVE_PROGRESS_BUDGET_S} s budget`;
  return `${head}${skippedClause}${staleClause}`;
}

/**
 * ADAAAA-8121: a content-clock position as `T+3:42` (or `T+42s` under a minute).
 *
 * The position is content seconds read off the job record, never a wall clock
 * and never a client-side estimate, so the label is the same on every reader.
 */
export function formatAnalysePosition(ts: number): string {
  const total = Math.max(0, Math.round(Number(ts) || 0));
  if (total < 60) return `T+${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `T+${m}:${String(s).padStart(2, "0")}`;
}

/**
 * ADAAAA-8121 / ADAAAA-8419: the live analyse-position readout, or `null` when
 * there is nothing honest to show.
 *
 * - position + delay: `Analysing T+3:42 · 8 s behind live`
 *
 * The stride clause family (`N frames skipped (stride R fps)`,
 * `no frames skipped`, `no stride data`) is GONE (ADAAAA-8419): the chip is the
 * latency surface and a cumulative skip counter there reads as a fault. The same
 * evidence now lives in the admin window audit as greyed `skipped` tiles. The
 * machine attributes (`data-analyze-position-stride` / `-skipped`) and the
 * `title` still carry the counts for QA.
 *
 * A skipped window is content the analysis never reached, so it is never
 * rendered as a position or as "analysed" (AC-3 of ADAAAA-8121) — the readout
 * names the analysed position only.
 *
 * Terminal jobs and a job with no decided window yet have no live edge, so they
 * render nothing at all (AC-4): no zero, no stale last value.
 */
export function analysePositionLabel(progress?: LiveProgress | null): string | null {
  if (!progress || progress.state === "unknown") return null;
  const position = Number(progress.analysedPositionTs);
  if (!Number.isFinite(position) || position <= 0) return null;
  const lag = Math.max(0, Math.round(Number(progress.analysedLagSec) || 0));
  return `Analysing ${formatAnalysePosition(position)} · ${lag} s behind live`;
}
