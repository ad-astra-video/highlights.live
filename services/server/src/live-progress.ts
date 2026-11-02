// ADAAAA-7741: the customer-facing "how live is this" projection.
//
// The board reported that live analysis does not appear to stream "as it is
// done" and asked for an indicator of how far behind the processing is. The lag
// is real but structural: one gemma decide costs ~8-13 s wall per ~3 s of
// content, so the live feed is ~25-30 s behind the live edge. ADAAAA-7676 bounded
// that lag at 30 s by DROPPING stale windows instead of deciding them late, so a
// live job legitimately has windows that never appear. Nothing surfaced any of
// this: the only lag numbers live in `observeMetrics`, which is written at
// completion and admin-gated by ADAAAA-7727, so a customer session could not
// read a lag number at all.
//
// This module derives the projection at READ time from data that is already
// stored — the job's content-clock anchor, the append-only `summaryLog` (one
// entry per decided window: wall `ts` plus content `windowTs`) and the newest
// persisted observation. Zero decide calls, zero GPU seconds, no stored-data
// mutation, no new field on the hot path.
//
// It deliberately surfaces ONLY the live edge, the newest decided window, the
// delta between them, how many windows the lag budget swallowed and a coarse
// state. It never re-exports `observeMetrics`, `costUsd`, `decideCalls`,
// `stageAMetrics` or any other internal diagnostic — see job-visibility.ts.

import type { Job } from "@highlights/events";

/** Content seconds a decided window may trail the live edge and still read as
 * "caught up". 5 s = the live tap's own sampling slack (AC3). */
export const LIVE_PROGRESS_CAUGHT_UP_S = 5;

/** Decide cadence in content seconds. Mirrors `OBSERVE_CADENCE_S` in
 * observe-loop.ts — the read path has no live AnalyzerConfig at hand, so keep
 * this in sync (same convention as DEFAULT_WINDOW_PRE_S in job-detail.ts). */
export const LIVE_PROGRESS_CADENCE_S = 3;

/** Sources whose frames arrive in real time — the only ones with a "live edge"
 * to measure a lag against. A VOD (`file`) job's content clock is the source
 * timeline, not wall time, so comparing the two would fabricate a lag: those
 * jobs read `unknown` and the UI renders no chip. */
const LIVE_SOURCES = new Set(["rtmp", "screen", "file-sim", "browser", "webrtc", "screenshare"]);

/** Jobs in one of these states have no live edge any more; the projection
 * freezes at the completion wall clock and the UI renders the completion state
 * instead of a lag chip. */
const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

/** The customer-safe live-progress object returned on GET /jobs/:id and
 * GET /jobs/:id/detail. Field-for-field the contract in ADAAAA-7741 — nothing
 * internal may be added here. */
export interface LiveProgress {
  /** Content seconds available at the tap (wall elapsed since the content-clock
   * anchor for an in-flight job). */
  liveEdgeTs: number;
  /** Content ts of the newest DECIDED window (newest `summaryLog` windowTs). */
  processedThroughTs: number;
  /** liveEdgeTs - processedThroughTs, clamped >= 0. */
  lagSec: number;
  /** Cadence windows dropped past the lag budget on this run. */
  skippedWindows: number;
  state: "caught_up" | "behind" | "unknown";
  /** Wall clock this projection was derived at. */
  updatedAt: string;
}

export interface LiveProgressInput {
  /** The stored job record (in-flight or terminal). */
  job: Partial<
    Pick<Job, "status" | "source" | "startedAt" | "finishedAt" | "completedAt" | "createdAt" | "summaryLog">
  > & {
    /** Read server-side only to honour the exact skip count a COMPLETED run
     * recorded; never surfaced as `observeMetrics`. */
    observeMetrics?: { skippedStaleWindows?: number } | null;
  };
  /** Content ts of the newest persisted observation for this job, if any. */
  newestObservationTs?: number | null;
  /** Injected reference time (ms) so the derivation is unit-testable. */
  nowMs?: number;
  /** Override the decide cadence (defaults to LIVE_PROGRESS_CADENCE_S). */
  cadenceS?: number;
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseMs(v?: string | null): number | null {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function round3(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(3)) : 0;
}

/** Content ts of the newest persisted observation (0 when none). The read path
 * uses this as a second live-edge estimate: stored frames are content that has
 * already reached the tap. */
export function newestObservationTs(observations: Array<{ timestamp?: number }> | undefined): number {
  let newest = 0;
  for (const o of observations ?? []) {
    const ts = finiteNumber(o?.timestamp);
    if (ts !== null && ts > newest) newest = ts;
  }
  return newest;
}

/**
 * Wall clock (ms) at which the job's content ts 0 was captured — the anchor the
 * lag is measured against.
 *
 * `startedAt` is exact when present. A live ingest/share only recently began
 * stamping it, so for older in-flight rows recover the same anchor the analyzer
 * builds (`streamWallStartMs = Date.now() - frameTs * 1000`) from the summary
 * log: `entry.ts - windowTs`. Later entries carry that window's decide E2E and
 * append latency on top, so the EARLIEST estimate is the closest one. That
 * fallback is conservative — it can only UNDER-state the lag by the first
 * decide's latency, never invent lag that is not there.
 */
export function liveContentAnchorMs(job: LiveProgressInput["job"] | undefined): number | null {
  if (!job) return null;
  const started = parseMs(job.startedAt);
  if (started !== null) return started;

  let earliest: number | null = null;
  for (const entry of job.summaryLog ?? []) {
    const wall = parseMs(entry?.ts);
    const windowTs = finiteNumber(entry?.windowTs);
    if (wall === null || windowTs === null) continue;
    const estimate = wall - windowTs * 1000;
    if (earliest === null || estimate < earliest) earliest = estimate;
  }
  if (earliest !== null) return earliest;

  // A job that never produced a decided window falls back to its creation time:
  // the UI renders "unknown" until the first window lands, so this only feeds a
  // live-edge estimate (never a lag claim).
  return parseMs(job.createdAt);
}

/**
 * Cadence windows swallowed between two consecutive DECIDED windows.
 *
 * The live observer fires one decide per cadence (3 s of content) and appends
 * exactly one summary entry per decided window. A stale drop advances the
 * cadence clock through the dropped content, so the next decided window's
 * content ts jumps by a WHOLE number of cadences. A delta of one cadence is the
 * normal step (0 skips); each extra full cadence is one window the budget
 * swallowed.
 *
 * Conservative by design: a delta that is not (near) an exact cadence multiple
 * is not counted — an audio-trigger-anchored window can sit off the blind
 * cadence grid, and a customer-facing "N skipped" must never over-claim. A
 * counted skip therefore requires `delta >= 2 * cadence` and a within-0.2
 * cadence of the grid.
 */
export function skippedWindowsFromSummaryLog(
  entries: Array<{ ts?: string; windowTs?: number }> | undefined,
  cadenceS: number = LIVE_PROGRESS_CADENCE_S
): number {
  const cadence = cadenceS > 0 && Number.isFinite(cadenceS) ? cadenceS : LIVE_PROGRESS_CADENCE_S;
  const windows = (entries ?? [])
    .map((e) => finiteNumber(e?.windowTs))
    .filter((w): w is number => w !== null)
    .sort((a, b) => a - b);
  let skipped = 0;
  for (let i = 1; i < windows.length; i++) {
    const delta = windows[i] - windows[i - 1];
    if (!Number.isFinite(delta) || delta <= 0) continue;
    const steps = Math.floor((delta + 1e-6) / cadence);
    if (steps < 2) continue;
    if (Math.abs(delta / cadence - steps) > 0.2) continue;
    skipped += steps - 1;
  }
  return skipped;
}

/**
 * Derive the customer-facing live-progress object from stored data only.
 *
 * - in-flight: liveEdge is wall elapsed since the content-clock anchor; state is
 *   `caught_up` when the newest decided window is within LIVE_PROGRESS_CAUGHT_UP_S
 *   of that edge, else `behind`.
 * - terminal: the edge freezes at `finishedAt`/`completedAt` (never a number
 *   that keeps ticking after the job ended) and state is `unknown`, because
 *   "how live is this" no longer means anything.
 * - no anchor or no decided window yet: state `unknown` — the UI renders nothing
 *   rather than a fabricated "caught up". `processedThroughTs` is 0 because
 *   nothing has been decided, so `lagSec` still satisfies
 *   `liveEdgeTs - processedThroughTs` (it is NOT presented as a lag reading).
 */
export function deriveLiveProgress(input: LiveProgressInput): LiveProgress {
  const job = input.job ?? {};
  const nowMs = finiteNumber(input.nowMs) ?? Date.now();
  const terminal = TERMINAL_STATUSES.has(String(job.status ?? ""));

  const entries = job.summaryLog ?? [];
  const windows = entries
    .map((e: { windowTs?: number }) => finiteNumber(e?.windowTs))
    .filter((w: number | null): w is number => w !== null);
  const processedThroughTs = windows.length > 0 ? Math.max(...windows) : 0;

  const anchorMs = liveContentAnchorMs(job);
  const edgeWallMs = terminal
    ? (parseMs(job.finishedAt) ?? parseMs(job.completedAt) ?? nowMs)
    : nowMs;
  const elapsedS = anchorMs !== null ? Math.max(0, (edgeWallMs - anchorMs) / 1000) : 0;
  const observationS = Math.max(0, finiteNumber(input.newestObservationTs) ?? 0);
  // Clamp to the newest decided window so a clock skew can never produce a
  // negative lag (a "behind live -4 s" reading would be worse than none).
  const liveEdgeTs = Math.max(elapsedS, observationS, processedThroughTs);
  const lagSec = Math.max(0, round3(liveEdgeTs - processedThroughTs));

  // In flight the summary-log gaps are the only customer-safe skip evidence. At
  // completion the run's own exact counter takes over as a floor — still only
  // the COUNT is surfaced, never the observe snapshot it came from.
  const derivedSkips = skippedWindowsFromSummaryLog(entries, input.cadenceS);
  const recordedSkips = terminal ? Math.max(0, Math.round(finiteNumber(job.observeMetrics?.skippedStaleWindows) ?? 0)) : 0;
  const skippedWindows = Math.max(derivedSkips, recordedSkips);

  const state: LiveProgress["state"] =
    !LIVE_SOURCES.has(String(job.source ?? "")) || anchorMs === null || windows.length === 0
      ? "unknown"
      : lagSec <= LIVE_PROGRESS_CAUGHT_UP_S
        ? "caught_up"
        : "behind";

  // A terminal job has no live edge, so it always reads `unknown`; the lag is
  // kept (frozen) for an operator inspecting the API, never for the chip.
  return {
    liveEdgeTs: round3(liveEdgeTs),
    processedThroughTs: round3(processedThroughTs),
    lagSec,
    skippedWindows,
    state: terminal ? "unknown" : state,
    updatedAt: new Date(nowMs).toISOString(),
  };
}
