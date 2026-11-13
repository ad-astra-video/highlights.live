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
// entry per EMITTED SUMMARY ROW: wall `ts` plus content `windowTs`), the newest
// applied decide and the newest persisted observation. Zero decide calls, zero
// GPU seconds, no stored-data mutation, no new field on the hot path.
//
// ADAAAA-8265: the `summaryLog` is NOT one entry per decided window. It is
// appended by `appendSummaryEntry` only when the running-summary pass kept a
// caption row, which on the live rail is a coarse cadence (~20 s p50, up to
// 105 s measured, and ZERO rows on a short leg). Using its newest `windowTs` as
// "processed through" therefore measured the SUMMARY cadence, not decide
// progress: on the 3 s hop / keep 0.69 cell with decide p50 2.0 s the meter read
// 28-46 s p50 while every per-window lag stayed under 20 s (and the two streams
// under an identical posture read 28 s vs 46 s purely on summary-row gaps). The
// watermark is now the newest APPLIED DECIDE — one `job_candidates` row per
// decided window, rejected ones included, carrying the content `timestamp` and
// the apply wall `createdAt` the read path already has in memory. The summary
// log stays the fallback for records written before this change so a legacy job
// keeps its old reading instead of losing one.
//
// It deliberately surfaces ONLY the live edge, the newest decided window, the
// delta between them, how many windows the lag budget swallowed and a coarse
// state. It never re-exports `observeMetrics`, `costUsd`, `decideCalls`,
// `stageAMetrics` or any other internal diagnostic — see job-visibility.ts.

import type { Job } from "@highlights/events";

/** Content seconds a decided window may trail the live edge and still read as
 * "caught up". The comparison is strict (`lagSec <` this), because the board's
 * ask is green when the feed is *less than* 10 s behind — exactly 10 s reads
 * `behind`.
 *
 * ADAAAA-8944: 10 s is the operating posture, not slack. One gemma decide costs
 * ~8-13 s of wall time per ~3 s of content, so a healthy live feed sits 5-10 s
 * behind the edge between decides: normal processing, not a warning. The old 5 s
 * boundary (the live tap's own sampling slack) painted that whole band yellow
 * and made a healthy run look broken. Anything at or past 10 s is a real lag
 * worth flagging. */
export const LIVE_PROGRESS_CAUGHT_UP_S = 10;

/** Decide cadence in content seconds. Mirrors `LIVE_OBSERVE_CADENCE_S` in
 * observe-loop.ts — the read path has no live AnalyzerConfig at hand, so keep
 * this in sync (same convention as DEFAULT_WINDOW_PRE_S in job-detail.ts).
 * ADAAAA-8676: the live cell cuts at 5 s on every path, so a legacy
 * summary-log skip count must step by 5 s, not 3. */
export const LIVE_PROGRESS_CADENCE_S = 5;

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
  /** Content ts of the newest window whose decide verdict has been APPLIED —
   * the newest `job_candidates.timestamp`, falling back to the newest
   * `summaryLog` windowTs on a record written before ADAAAA-8265. */
  processedThroughTs: number;
  /** liveEdgeTs - processedThroughTs, clamped >= 0. */
  lagSec: number;
  /** SUPPLY skip count: cadence windows the rail could not serve (stale lag
   * drops + admission + backpressure). The funded decide-rate throttle is NOT
   * included — it is a spend decision, not missing coverage (ADAAAA-7808, PO
   * ruling on ADAAAA-7802).
   *
   * ADAAAA-8636 contract:
   * - TERMINAL: always present. `observeMetrics.supplySkippedWindows` verbatim,
   *   with `skippedStaleWindows` as the floor for a record written before that
   *   field existed (ADAAAA-8526's 312/312 read is unchanged).
   * - IN FLIGHT: present ONLY when the live rail's own in-memory supply
   *   counters were handed in (`liveSupply`). It is NEVER synthesized from
   *   `summaryLog` caption gaps: that log holds one row per KEPT CAPTION
   *   (~24 s apart on the 02:34Z leg), so its gaps measure the summary writer,
   *   not missing coverage. Replaying the old formula against a continuous
   *   261-window / 8.6 s-max-step ledger invented 33 skipped windows.
   * - IN FLIGHT with no rail evidence (rail gone, process restarted): the field
   *   is OMITTED and `skipData` is `false`, so the chip renders no skip clause
   *   instead of a fabricated count (no invented zero). */
  skippedWindows?: number;
  /** ADAAAA-8636: `false` when an in-flight share has NO rail supply evidence,
   * i.e. `skippedWindows` is absent because the counters are not in memory.
   * Omitted on a terminal record (the count is always known there) and omitted
   * while the live counters are available. */
  skipData?: boolean;
  state: "caught_up" | "behind" | "unknown";
  /** Wall clock this projection was derived at. */
  updatedAt: string;
  /** ADAAAA-8121: content ts of the newest frame the run ANALYSED — where the
   * analysis currently is inside the live stream. Sourced from the job's own
   * consume evidence (in-memory observation rows / the rail's consume clock
   * while in flight, `observeMetrics.perceive.analysedThroughTs` on a stored
   * record), never a client estimate and never the wall clock. Omitted when no
   * analysed position is known (AC-4: no invented zero). */
  analysedPositionTs?: number;
  /** ADAAAA-8121: `liveEdgeTs - analysedPositionTs` on the CONTENT clock,
   * clamped >= 0. Both endpoints are content timestamps, so a 1 fps -> 2 fps
   * consume rate change leaves the number untouched. */
  analysedLagSec?: number;
  /** ADAAAA-8121: frames the ingest delivered (`perceive.framesSeen`). Count. */
  strideFramesSeen?: number;
  /** ADAAAA-8121: frames the stride SKIPPED (`perceive.framesStrided`). A COUNT
   * only — a strided window is content the analysis never reached, so it is
   * never a position marker on the track (AC-3). */
  strideFramesSkipped?: number;
  /** ADAAAA-8121: the resolved content consume rate (`perceive.analysisFps`). */
  strideAnalysisFps?: number;
  /** ADAAAA-8121: `false` when the record carries NO consume/stride evidence
   * (`observeMetrics.perceive` absent — the content-fps knob was unset on that
   * run). The indicator then degrades to "no stride data" instead of inventing a
   * position (AC-6). */
  strideData?: boolean;
}

/** ADAAAA-8121: the consume/stride evidence a record may carry. Read
 * server-side only — the counts are surfaced as counts and the timestamps are
 * content-clock positions; nothing else from `observeMetrics` is re-exported. */
export interface LiveConsumeEvidence {
  framesSeen?: number;
  framesAnalyzed?: number;
  framesStrided?: number;
  analysisFps?: number;
  /** ADAAAA-8419: content ts of the frames the consume stride REFUSED (newest
   *  240, ascending). Display evidence for the admin window audit only: no `seq`,
   *  no stored image, nothing persisted. Server-side only — `deriveLiveProgress`
   *  never copies it onto the customer `liveProgress` object. */
  skippedTimestamps?: number[];
  analysedThroughTs?: number;
  tapThroughTs?: number;
}

/** ADAAAA-8636: the live rail's in-memory SUPPLY counters, read mid-share by
 * the ADAAAA-8250 pattern. Same names the completion report publishes into
 * `observeMetrics`, so the in-flight number and the settled number are the SAME
 * definition (stale + admission + backpressure; throttle excluded per
 * ADAAAA-7808). Counts only — no timestamps, no decide inference, no GPU. */
export interface LiveSupplyEvidence {
  skippedStaleWindows?: number;
  admissionSkippedWindows?: number;
  backpressureSkippedWindows?: number;
}

export interface LiveProgressInput {
  /** The stored job record (in-flight or terminal). */
  job: Partial<
    Pick<Job, "status" | "source" | "startedAt" | "finishedAt" | "completedAt" | "createdAt" | "summaryLog">
  > & {
    /** Read server-side only to honour the exact skip count a COMPLETED run
     * recorded; never surfaced as `observeMetrics`. ADAAAA-8121 also reads the
     * `perceive` consume block from here (positions + counts). */
    observeMetrics?:
      | { skippedStaleWindows?: number; supplySkippedWindows?: number; perceive?: LiveConsumeEvidence | null }
      | null;
  };
  /** Content ts of the newest persisted observation for this job, if any. */
  newestObservationTs?: number | null;
  /** ADAAAA-8121: the rail's live consume clock (content ts of the newest
   * ANALYSED frame) for an in-flight job. Used when the observation set is not
   * at hand (e.g. a resumed process) and, with `newestObservationTs`, keeps the
   * position sourced from the job's own consume evidence. */
  analysedThroughTs?: number | null;
  /** ADAAAA-8250: the rail's LIVE consume/stride evidence for an in-flight job —
   * the same `perceive` block the rail publishes into `observeMetrics` at share
   * end, read MID-SHARE from the in-memory rail. Without it a live share had no
   * consume block until completion (and the chip hides itself on a terminal
   * job), so the analyse-position label read `no stride data` for the whole
   * share. Counts + content-clock positions only: no new meter, no new
   * inference. Ignored for a terminal job (AC-4). */
  liveConsume?: LiveConsumeEvidence | null;
  /** ADAAAA-8636: the rail's LIVE supply counters for an in-flight job — the
   *  `skippedStaleWindows + admissionSkippedWindows + backpressureSkippedWindows`
   *  triple the completion report already publishes, read MID-SHARE from the
   *  in-memory rail. This is the ONLY in-flight source for `skippedWindows`; the
   *  summary-log gap heuristic is terminal-legacy-only (it measures the caption
   *  cadence, and on the 02:34Z leg it invented 33 skips against a continuous
   *  261-window ledger). `null`/absent = no rail evidence in memory, so the
   *  projection omits the count instead of guessing. Ignored for a terminal job
   *  (AC-2: the settled record's exact field wins). */
  liveSupply?: LiveSupplyEvidence | null;
  /** ADAAAA-8265: content ts of the newest window whose verdict the run has
   * APPLIED (one row per decided window, rejected included). This is the
   * processed-through watermark — the `summaryLog` cadence measured the summary
   * writer, not decide progress. Absent on a job with no applied window yet, and
   * on records written before this change (fallback = summaryLog). */
  decidedThroughTs?: number | null;
  /** ADAAAA-8265: wall clock (ms) the newest applied decide landed — the moment
   * its verdict reached the feed. Freezes the live edge of a TERMINAL job at the
   * last applied window instead of the last summary row (which can be a whole
   * minute earlier). */
  decidedAtMs?: number | null;
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
 * ADAAAA-8265: the processed-through watermark and its wall clock, read off the
 * job's own candidate rows.
 *
 * `job_candidates` holds exactly ONE row per decided window — rejected windows
 * included — each stamped with the content ts the decide reasoned over
 * (`timestamp`) and the wall clock the verdict was APPLIED (`createdAt`), so it
 * is the honest "what content has this run processed" ledger. It replaced the
 * `summaryLog` newest `windowTs`, which tracks the running-summary writer (a
 * caption row every ~20 s, sometimes none at all) and made the lag chip read
 * the summary cadence: 28-46 s p50 on a leg whose decides were 2 s.
 *
 * Zero decide calls, zero GPU: the rows are already in memory. Both fields are
 * read independently (a row with an unparseable `createdAt` still contributes
 * its content ts, and vice versa) so one malformed legacy row cannot blank the
 * whole watermark.
 */
export function appliedDecideWatermark(
  candidates: Array<{ timestamp?: number; createdAt?: string }> | undefined
): { ts: number; atMs: number | null } {
  let ts = 0;
  let atMs: number | null = null;
  for (const c of candidates ?? []) {
    const contentTs = finiteNumber(c?.timestamp);
    if (contentTs !== null && contentTs > ts) ts = contentTs;
    const wall = parseMs(c?.createdAt);
    if (wall !== null && (atMs === null || wall > atMs)) atMs = wall;
  }
  return { ts, atMs };
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
 * ADAAAA-8636: the SUPPLY skip total from the live rail's in-memory counters —
 * `skippedStaleWindows + admissionSkippedWindows + backpressureSkippedWindows`,
 * the same definition `observeMetrics.supplySkippedWindows` publishes at share
 * end (ADAAAA-7808). Never includes the funded throttle.
 *
 * Returns `null` when NO counter was supplied, so the caller can omit the field
 * rather than assert an unmeasured 0. A negative/non-finite counter is ignored
 * (never allowed to reduce another cause's real count).
 */
export function liveSupplySkippedWindows(live?: LiveSupplyEvidence | null): number | null {
  if (!live) return null;
  let sum = 0;
  let seen = false;
  for (const raw of [live.skippedStaleWindows, live.admissionSkippedWindows, live.backpressureSkippedWindows]) {
    const n = finiteNumber(raw);
    if (n === null) continue;
    seen = true;
    sum += Math.max(0, n);
  }
  return seen ? Math.max(0, Math.round(sum)) : null;
}

/**
 * Cadence windows swallowed between two consecutive DECIDED windows.
 *
 * ADAAAA-8636: TERMINAL-LEGACY ONLY. Use this exclusively as the fallback for a
 * record written before `observeMetrics.supplySkippedWindows` existed; it must
 * never be called for an in-flight job. `summaryLog` is appended only when the
 * running-summary pass KEPT a caption (its own header says so; ~24 s apart on
 * the 02:34Z leg, empty on short legs), so its gaps measure the summary writer,
 * not decide progress — and each gap that happens to land on the 3 s grid is
 * then read as missing coverage. On job `22ff6ca2` this reproduced 33 "skipped"
 * windows against a continuous 261-window ledger (max step 8.6 s), and the two
 * LARGEST summary gaps (106.6 s / 238.0 s) scored zero because they were
 * off-grid. The in-flight count now comes from the rail's own supply counters
 * (ADAAAA-8636, `liveSupply`) or is omitted.
 *
 * The arithmetic itself is unchanged for the legacy terminal fallback:
 * a stale drop advances the cadence clock through the dropped content, so the
 * next decided window's content ts jumps by a WHOLE number of cadences. A delta
 * of one cadence is the normal step (0 skips); each extra full cadence is one
 * window the budget swallowed.
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
 * Wall clock of the newest summary-log append, if any — the moment the newest
 * decided window's result reached the feed. A terminal job freezes its live edge
 * here (see {@link deriveLiveProgress}).
 */
function lastSummaryAppendMs(entries: Array<{ ts?: string }> | undefined): number | null {
  let latest: number | null = null;
  for (const entry of entries ?? []) {
    const wall = parseMs(entry?.ts);
    if (wall !== null && (latest === null || wall > latest)) latest = wall;
  }
  return latest;
}

/**
 * Derive the customer-facing live-progress object from stored data only.
 *
 * - in-flight: liveEdge is wall elapsed since the content-clock anchor; state is
 *   `caught_up` when the newest APPLIED decide is within
 *   LIVE_PROGRESS_CAUGHT_UP_S of that edge, else `behind`.
 * - terminal: the edge freezes at the moment the newest applied decide landed
 *   (never a number that keeps ticking after the job ended) and state is
 *   `unknown`, because "how live is this" no longer means anything.
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
  // ADAAAA-8265: the processed-through watermark is the newest APPLIED DECIDE,
  // not the newest summary row. `summaryLog` is appended only when the running
  // summary emitted a caption (coarse, and empty on short legs), so grading it as
  // decide progress read the summary cadence and inflated the lag 3-5x on a leg
  // whose decides were 2 s. `decidedThroughTs` is absent on a legacy record and
  // on a share with no applied window, where the summary log is still the only
  // evidence — so take the max of the two rather than preferring one blindly.
  const appliedThroughTs = Math.max(0, finiteNumber(input.decidedThroughTs) ?? 0);
  const processedThroughTs = Math.max(
    appliedThroughTs,
    windows.length > 0 ? Math.max(...windows) : 0
  );

  const anchorMs = liveContentAnchorMs(job);
  // A terminal job has no live edge; freeze it at the moment the newest decided
  // window's result reached the feed, so the frozen lag is exactly the completed
  // lag the viewer experienced — never a number inflated by clip finalization,
  // and never a number that keeps ticking after the run ended. ADAAAA-8265: the
  // freeze uses the newest APPLIED DECIDE wall when known (a summary row can be
  // a whole minute older), then the summary append, then the job's own end.
  // `finishedAt`/`completedAt` are only a fallback for a job with no entries.
  const decidedAtMs = finiteNumber(input.decidedAtMs);
  const edgeWallMs = terminal
    ? (decidedAtMs ?? lastSummaryAppendMs(entries) ?? parseMs(job.finishedAt) ?? parseMs(job.completedAt) ?? nowMs)
    : nowMs;
  const elapsedS = anchorMs !== null ? Math.max(0, (edgeWallMs - anchorMs) / 1000) : 0;
  const observationS = Math.max(0, finiteNumber(input.newestObservationTs) ?? 0);
  // ADAAAA-8121: the consume evidence on the record, read for the POSITION and
  // the COUNTS only. `perceive` absent = the content-fps knob was unset on that
  // run, and the indicator must say "no stride data" rather than invent one.
  // ADAAAA-8250: in flight the rail only publishes that block at share end, so
  // the stored record carries null for the whole share and the chip could never
  // name the stride count. The caller now hands the SAME counters in from the
  // live rail (`liveConsume`); the stored block stays the terminal source, so a
  // completed record still reads exactly what it did before. A terminal job
  // ignores the live block outright (AC-4: the chip hides itself there).
  const storedPerceive = job.observeMetrics?.perceive ?? null;
  const perceive = (terminal ? null : input.liveConsume ?? null) ?? storedPerceive;
  const consumeTs = Math.max(0, finiteNumber(input.analysedThroughTs) ?? 0);
  const storedAnalysedTs = Math.max(0, finiteNumber(perceive?.analysedThroughTs) ?? 0);
  const tapTs = Math.max(0, finiteNumber(perceive?.tapThroughTs) ?? 0);
  // ADAAAA-8121: the analysed POSITION — the newest content instant this run
  // actually analysed. Three server-side sources, all content clock: the stored
  // observation rows, the live rail clock, and the persisted consume clock on a
  // stored record. A strided frame is never among them (the rails only advance
  // the analysed clock on CONSUMED frames), so a skipped window can never read
  // as a position (AC-3).
  const analysedPositionTs = Math.max(observationS, consumeTs, storedAnalysedTs);
  // Clamp to the newest decided window so a clock skew can never produce a
  // negative lag (a "behind live -4 s" reading would be worse than none).
  // ADAAAA-8121: the tap's own content clock (`tapThroughTs`) is a third live
  // edge source — the newest DELIVERED frame, strided frames included, so the
  // edge stays ahead of a strided analysed position.
  const liveEdgeTs = Math.max(elapsedS, observationS, processedThroughTs, tapTs);
  const lagSec = Math.max(0, round3(liveEdgeTs - processedThroughTs));
  // ADAAAA-8121 (AC-2): the delay of the ANALYSED position, on the content
  // clock: both terms are content timestamps, so the value is identical at 1 fps
  // and 2 fps for the same content position. No frame count enters the number.
  const analysedLagSec =
    analysedPositionTs > 0 ? Math.max(0, round3(liveEdgeTs - analysedPositionTs)) : undefined;

  // ADAAAA-8636: `skippedWindows` is a SUPPLY fact, so in flight it may only
  // come from a supply COUNTER — never from summary-log gap arithmetic (that
  // log measures the caption cadence; it invented 33 skips on the 02:34Z leg's
  // continuous ledger). Terminal keeps the exact record contract: the run's own
  // `supplySkippedWindows` verbatim, else the legacy gap heuristic floored by
  // the recorded stale counter. The heuristic is therefore TERMINAL-LEGACY-ONLY.
  const derivedSkips = skippedWindowsFromSummaryLog(entries, input.cadenceS);
  let skippedWindows: number | undefined;
  let skipData: boolean | undefined;
  if (terminal) {
    const recordedSkips = Math.max(0, Math.round(finiteNumber(job.observeMetrics?.skippedStaleWindows) ?? 0));
    // ADAAAA-7808 (PO ruling on ADAAAA-7802): on the shipped rail
    // `skippedWindows` is the SUPPLY count — stale drops + admission +
    // backpressure — and NEVER the throttle, which is a funded rate decision. A
    // terminal record now carries that exact number, so it wins over the gap
    // heuristic: with the rate cap on, the throttled windows leave cadence gaps
    // the heuristic reads as skipped SUPPLY (measured 35 and 33 on the 2-stream
    // ship row against a true supply of 1 and 0). The heuristic stays the
    // fallback for records written before the field existed.
    const exactSupply = finiteNumber(job.observeMetrics?.supplySkippedWindows);
    skippedWindows =
      exactSupply !== null && exactSupply >= 0
        ? Math.max(0, Math.round(exactSupply))
        : Math.max(derivedSkips, recordedSkips);
  } else {
    // In flight the rail's in-memory counters are the ONLY honest source. When
    // the rail is not in memory (process restart / evidence not wired), omit the
    // count and say so via `skipData: false` — the chip renders no skip clause
    // rather than a synthesized number or an invented zero.
    const liveSkips = liveSupplySkippedWindows(input.liveSupply);
    if (liveSkips !== null) skippedWindows = liveSkips;
    else skipData = false;
  }

  const state: LiveProgress["state"] =
    !LIVE_SOURCES.has(String(job.source ?? "")) || anchorMs === null || processedThroughTs <= 0
      ? "unknown"
      : lagSec < LIVE_PROGRESS_CAUGHT_UP_S
        ? "caught_up"
        : "behind";

  // A terminal job has no live edge, so it always reads `unknown`; the lag is
  // kept (frozen) for an operator inspecting the API, never for the chip.
  return {
    liveEdgeTs: round3(liveEdgeTs),
    processedThroughTs: round3(processedThroughTs),
    lagSec,
    // ADAAAA-8636: omitted in flight when no rail supply evidence is at hand;
    // always present on a terminal record (unchanged contract).
    ...(skippedWindows !== undefined ? { skippedWindows } : {}),
    ...(skipData !== undefined ? { skipData } : {}),
    state: terminal ? "unknown" : state,
    updatedAt: new Date(nowMs).toISOString(),
    // ADAAAA-8121: present only when the position is actually known, so a
    // customer surface never renders a fabricated 0 (AC-4).
    ...(analysedPositionTs > 0 ? { analysedPositionTs: round3(analysedPositionTs) } : {}),
    ...(analysedLagSec !== undefined ? { analysedLagSec } : {}),
    // ADAAAA-8121: the stride counts ride the record's own consume block. They
    // are COUNTS; no position or window marker is derived from them (AC-3).
    ...(perceive
      ? {
          strideData: true,
          ...(finiteNumber(perceive.framesSeen) !== null
            ? { strideFramesSeen: Math.max(0, Math.round(perceive.framesSeen as number)) }
            : {}),
          ...(finiteNumber(perceive.framesStrided) !== null
            ? { strideFramesSkipped: Math.max(0, Math.round(perceive.framesStrided as number)) }
            : {}),
          ...(finiteNumber(perceive.analysisFps) !== null
            ? { strideAnalysisFps: Math.max(0, perceive.analysisFps as number) }
            : {}),
        }
      : { strideData: false }),
  };
}
