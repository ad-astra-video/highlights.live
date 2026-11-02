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
 * The lag chip copy for an in-flight job, or `null` when there is nothing
 * honest to show yet (no decided window, or a terminal job whose completion
 * state belongs in the status chip).
 *
 * - behind:    `Processing - 26 s behind live`
 * - caught up: `Live - caught up (3 s)`
 * - skipped:   `… · 2 windows skipped past the 30 s budget`
 */
export function liveProgressChipLabel(progress?: LiveProgress | null): string | null {
  if (!progress || progress.state === "unknown") return null;
  const lag = Math.max(0, Math.round(Number(progress.lagSec) || 0));
  const head = progress.state === "caught_up" ? `Live - caught up (${lag} s)` : `Processing - ${lag} s behind live`;
  const skipped = Math.max(0, Math.round(Number(progress.skippedWindows) || 0));
  if (skipped === 0) return head;
  return `${head} · ${skipped} window${skipped === 1 ? "" : "s"} skipped past the ${LIVE_PROGRESS_BUDGET_S} s budget`;
}
