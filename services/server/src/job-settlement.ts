// ADAAAA-8061: terminal accounting for a job that ends without a clean
// completion.
//
// Before this, only the VOD/live *success* paths wrote `costUsd` / `decideCalls`
// / `finishedAt`. A job that was stopped, that lost its decide runner, or that
// was swept at boot ended as a bare `failed`/`cancelled`: no `endedAt`, no
// `decideCalls`, no `costUsd`. The GPU had been spent, but the record read
// exactly like a job that never ran, so Livepeer spend could not be attributed
// (per-level cost, per-stream class, node attribution all read `costUsd`).
//
// This module owns the ONE settlement shape every terminal path uses, so the
// three states a reader must be able to tell apart stay distinct:
//   * measured       -> `decideCalls` + `costUsd`
//   * partially      -> `costUnavailable` + `partialCostUsd` (perceive leg only)
//   * never measured -> `costUnavailable` only (never `costUsd: 0`)
//
// Pure functions only: no store/db access, so the shape is unit-testable and
// every caller (boot sweep, stop, failure) settles identically.
import type { Job, StageAMetricsSnapshot } from "@highlights/events";
import { resolveSummaryFee } from "@highlights/events";
import { completedLiveCounterFields } from "./job-counters";

/** Perceive persistent-session list price per hour (docker/runners.json
 * perceives `$0.01/hr`). Flat hour unit, so session billing is proportional to
 * `perceiveSessionS` — mirrors the constant the completed-record paths use. */
export const PERCEIVE_PER_HOUR_USD = 0.01;

/** Why a settlement could not measure the decide count. Named (not a free-form
 * sentence) so downstream readers and tests can distinguish causes. */
export type CostUnavailableReason =
  /** The pass died before any decide count reached the durable record. */
  | "decide-count-not-persisted"
  /** The sweep/stop ran after the perceive session was already gone. */
  | "perceive-session-lost";

export interface TerminalAccountingInput {
  /** Terminal status this settlement belongs to. `done` also stamps
   * `completedAt`, mirroring the success paths. */
  status: "done" | "failed" | "cancelled";
  /** `DECIDE_FEE` list price per decide call. */
  decideFee: number;
  /** MEASURED decide invocations, or `null` when the count was never recorded.
   * Never pass 0 to mean "unknown". */
  decideCalls: number | null;
  /** ADAAAA-8692: MEASURED summary (body-copy) calls to bill in this settlement.
   *  Default 0 keeps every pre-8692 caller byte-identical; a stopped stream that
   *  already produced copy bills it here, so `costUsd` and `costPerStreamHour`
   *  are two projections of ONE price instead of two additions. */
  summaryCalls?: number;
  /** ADAAAA-8692: the per-call summary fee (`SUMMARY_FEE`, clamped to 1.5x
   *  `DECIDE_FEE` by {@link computeCostUsd}). Absent => the clamped ceiling. */
  summaryFee?: number;
  /** ADAAAA-8692: the STREAM clock in seconds — live: the perceived session
   *  length; VOD/file: the probed source duration. `costPerStreamHour` is priced
   *  from it, so a caller that does not know the denominator passes nothing and
   *  the field stays absent (never inferred from the other clock). */
  streamSeconds?: number | null;
  /** ADAAAA-8205: MEASURED confirm dives (decide-service calls), metered in the
   * same term. Default 0 keeps every existing caller byte-identical.
   *
   * ADAAAA-8242: this is only the FALLBACK for a caller with no snapshot. When
   * `observeMetrics` is supplied its own `confirmCalls` is authoritative (see
   * {@link billableConfirmCalls}) — the persisted meter is the field a stored-row
   * read grades, so the cost term must never be built from a second expression. */
  confirmCalls?: number;
  /** Seconds the perceive session was paid for. Omitted/null when unknown. */
  perceiveSessionS?: number | null;
  nowMs?: number;
  /** Failure/stop text for `job.error`. */
  error?: string;
  /** Named reason written to `costUnavailable` when `decideCalls` is null. */
  costUnavailableReason?: CostUnavailableReason;
  observeMetrics?: Job["observeMetrics"];
  vodObserveMetrics?: Job["vodObserveMetrics"];
  /** Extra fields (failureReason, resume checkpoint, progress label, …). */
  extra?: Partial<Omit<Job, "id">>;
}

/** Seconds between an ISO timestamp and `nowMs` (never negative), or `null`
 * when the timestamp is missing/unparseable. Used to settle the perceive leg of
 * a job whose process died before it could close its own clock. */
export function accruedSecondsSince(iso: string | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (nowMs - t) / 1000);
}

/** List cost of `decideCalls` decide invocations plus `perceiveSessionS` of
 * paid perceive session, rounded to the 4dp the record stores. */
export function computeCostUsd(
  decideCalls: number,
  perceiveSessionS: number,
  decideFee: number,
  confirmCalls = 0,
  /** ADAAAA-8668: the `summary` lane's own fee TERM. Additive positional arg, so
   *  every pre-change caller keeps its exact price. */
  summaryCalls = 0,
  /** Per-call summary fee. Defaults to the AC5 ceiling (`1.5x DECIDE_FEE`). */
  summaryFee?: number
): number {
  // ADAAAA-8205: confirm dives are decide-service calls, so they are metered in
  // the same term: `decideFee * (decideCalls + confirmCalls) + perceive`.
  // ADAAAA-8668: the body-copy lane is its OWN fee class, never folded into the
  // decide term: `+ summaryFee * summaryCalls`, with the fee clamped to 1.5x
  // `DECIDE_FEE` so a misconfigured override cannot breach the cost model.
  const billableCalls = Math.max(0, decideCalls) + Math.max(0, confirmCalls);
  const summaryTerm = Math.max(0, summaryCalls) * resolveSummaryFee(decideFee, summaryFee ?? null);
  const cost = decideFee * billableCalls + summaryTerm + (Math.max(0, perceiveSessionS) / 3600) * PERCEIVE_PER_HOUR_USD;
  return Number(cost.toFixed(4));
}

/**
 * ADAAAA-8692: `costUsd` normalised to ONE HOUR OF STREAM — the observable the
 * CEO chose instead of a dive cap (ADAAAA-8518 AC5) and an AC5 clause of the
 * caption-depth spec ("the fee appears in both `costUsd` and `costPerStreamHour`").
 *
 * Two jobs in a row stored `null` here for a structural reason, not a pricing
 * one: the readout only existed INSIDE `observeMetrics`, and the VOD/file
 * completion path writes no `observeMetrics` at all, so the field had no writer.
 * The denominator is the STREAM clock the caller passes (live: perceived session
 * seconds; VOD/file: probed source duration) — never inferred — and `null`/
 * zero means the denominator is unknown, in which case the field stays absent
 * rather than dividing by nothing.
 */
export function costPerStreamHour(costUsd: number, streamSeconds: number | null | undefined): number | undefined {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) return undefined;
  if (typeof streamSeconds !== "number" || !Number.isFinite(streamSeconds) || streamSeconds <= 0) return undefined;
  return Number((costUsd / (streamSeconds / 3600)).toFixed(4));
}

/** ADAAAA-8668 (AC5): the ONE source of the summary term's call count. Same rule
 *  as `billableConfirmCalls`: when a stored `observeMetrics` snapshot carries the
 *  meter it is AUTHORITATIVE (it is the field a stored-row read grades), and only
 *  a caller with no snapshot passes a measured count derived from the rows. */
export function billableSummaryCalls(
  observeMetrics: Job["observeMetrics"] | undefined,
  explicit?: number
): number {
  const fromSnapshot = observeMetrics?.summaryCalls;
  if (typeof fromSnapshot === "number" && Number.isFinite(fromSnapshot)) return Math.max(0, Math.trunc(fromSnapshot));
  if (typeof explicit === "number" && Number.isFinite(explicit)) return Math.max(0, Math.trunc(explicit));
  return 0;
}

/** ADAAAA-8668: the summary calls a job actually billed, summed off its stored
 *  rows. `patchHighlightSummary` writes `summaryCalls` on every row that was
 *  attempted, so a row-granular read and the job meter cannot disagree about the
 *  same call. */
export function summaryCallsForRows(rows: { summaryCalls?: number | undefined }[] | undefined): number {
  let total = 0;
  for (const row of rows ?? []) {
    if (typeof row.summaryCalls === "number" && Number.isFinite(row.summaryCalls)) total += Math.max(0, Math.trunc(row.summaryCalls));
  }
  return total;
}

/**
 * ADAAAA-8242: the ONE source of the confirm term.
 *
 * QA leg `0705e2b5` stored `costUsd = 0.2485` — exactly 75 billable calls
 * (`0.0033 * (73 + 2) + 362.5/3600 * 0.01`) — while its stored `observeMetrics`
 * carried no confirm key at all, because the three counters were undeclared on
 * `ObserveMetricsSnapshotSchema` and `JobSchema.parse` (store.patchJob) stripped
 * them before persistence (added additively by ADAAAA-8219, `7800a11`). The
 * lesson is structural, not one missing field: a cost term and a meter read from
 * TWO expressions can disagree about the same dive on one row.
 *
 * The snapshot is the field a stored-row read grades, so it is AUTHORITATIVE:
 * when a caller supplies `observeMetrics`, the billed count comes from that
 * snapshot and a separately-passed `confirmCalls` cannot out-vote it. Callers
 * with no snapshot (boot sweep / synchronous stop) may pass the measured count
 * explicitly. Legacy rows (lane never armed) bill 0 and keep their record.
 */
export function billableConfirmCalls(
  observeMetrics: Job["observeMetrics"] | undefined,
  explicit?: number
): number {
  const fromSnapshot = observeMetrics?.confirmCalls;
  if (typeof fromSnapshot === "number" && Number.isFinite(fromSnapshot)) {
    return Math.max(0, Math.trunc(fromSnapshot));
  }
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(0, Math.trunc(explicit));
  }
  return 0;
}

/** Build the terminal patch: end stamps + accounting, honest about what was
 * measured. Callers merge `extra` for their own reason/label fields. */
export function buildTerminalAccountingPatch(input: TerminalAccountingInput): Partial<Omit<Job, "id">> {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  // ADAAAA-8242: bill the SAME confirm count the patch persists. The meter block
  // is stamped onto the snapshot when a caller knew a count the snapshot lost, so
  // the terminal patch is self-consistent by construction: `costUsd` reconciles
  // against `observeMetrics.confirmCalls` on the stored row. Only `confirmCalls`
  // is known in that case (the dive/dropped split belongs to the pass snapshot),
  // so those stay absent rather than fabricated — the ADAAAA-8223 rule.
  const confirmCalls = billableConfirmCalls(input.observeMetrics, input.confirmCalls);
  const observeMetrics = input.observeMetrics
    ? input.observeMetrics.confirmCalls === undefined && confirmCalls > 0
      ? { ...input.observeMetrics, confirmCalls }
      : input.observeMetrics
    : undefined;
  const patch: Partial<Omit<Job, "id">> = {
    status: input.status,
    endedAt: now,
    finishedAt: now,
    ...(input.status === "done" ? { completedAt: now } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(observeMetrics ? { observeMetrics } : {}),
    ...(input.vodObserveMetrics ? { vodObserveMetrics: input.vodObserveMetrics } : {}),
  };
  const perceiveS = input.perceiveSessionS ?? null;
  if (input.decideCalls !== null && Number.isFinite(input.decideCalls)) {
    const decideCalls = Math.max(0, Math.trunc(input.decideCalls));
    const cost = computeCostUsd(
      decideCalls,
      perceiveS ?? 0,
      input.decideFee,
      confirmCalls,
      input.summaryCalls ?? 0,
      input.summaryFee
    );
    patch.decideCalls = decideCalls;
    if (perceiveS !== null) patch.perceiveSessionS = Number(perceiveS.toFixed(1));
    patch.costUsd = cost;
    // ADAAAA-8692: the terminal settlement is the ONLY writer some rows ever get
    // (a stop, a decide-runner death, a boot sweep). Stamp the per-stream-hour
    // readout from the SAME `cost` it bills, so a cancelled/failed row carries
    // what a completed row carries and the AC5 clause is not a per-path lottery.
    const perStreamHour = costPerStreamHour(cost, input.streamSeconds);
    if (perStreamHour !== undefined) patch.costPerStreamHour = perStreamHour;
    // A measured record never carries a stale "unavailable" marker.
    patch.costUnavailable = undefined;
    patch.partialCostUsd = undefined;
  } else {
    // Not measured. Write the perceive leg we DO know as a partial, name the
    // reason, and never write `costUsd` (so "not measured" can never be read as
    // a genuine zero).
    if (perceiveS !== null) {
      patch.perceiveSessionS = Number(perceiveS.toFixed(1));
      patch.partialCostUsd = computeCostUsd(0, perceiveS, input.decideFee);
    }
    patch.costUnavailable = input.costUnavailableReason ?? "decide-count-not-persisted";
    patch.costUsd = undefined;
  }
  return { ...patch, ...(input.extra ?? {}) };
}

/**
 * ADAAAA-8310: the ONE settlement shape for a live stream that ends `cancelled`.
 *
 * A live stop has TWO writers, and before this they disagreed about the record:
 *
 *   * the pass itself (`runLiveJob`'s `stoppedMidPass` branch) settles from the
 *     outcome it just produced — `observeMetrics`, `liveWatchMinutes`, the live
 *     counters and the perceive session id;
 *   * the stop route's drain-timeout fallback (`markJobCancelled`) settles when
 *     the pass could not unwind inside `JOB_STOP_DRAIN_MS` — it wrote the decide
 *     count and `costUsd` from the durable per-decide rows and NOTHING else.
 *
 * Which writer won was a timing coin flip, and the fallback's window is not
 * rare: on leg `8299` (content-fps 2) the drained sibling took 9.2 s against a
 * 10 s grace. Stream `216e586e` lost that race and stored `decideCalls` 70 /
 * `costUsd` 0.2319 with **no** `observeMetrics` and **no** `liveWatchMinutes`,
 * while sibling `d85aca45` stored the full block — so AC4's spend clause could
 * not be graded on the stored-field denominator for half the leg.
 *
 * Both writers now call THIS function, so the two paths differ only in the
 * `progressLabel` that says which one settled (`stopped` vs
 * `stopped (drain timeout)`). Two rules fall out of it:
 *
 *   1. `liveWatchMinutes` is written on EVERY live terminal row — it is derived
 *      from the same `perceiveSessionS` the patch bills, so a hard stop cannot
 *      lose the watch clock (the AC4 denominator).
 *   2. `decideCalls`, `costUsd` and `observeMetrics.confirmCalls` read from ONE
 *      source (ADAAAA-8242): the pass snapshot when one was published, else the
 *      durable per-decide rows. A snapshot that disagrees with the rows cannot
 *      produce a row whose cost term and meter contradict each other.
 *
 * `observeMetrics` is only ever the pass's OWN measured snapshot (published live
 * via `onObserveSnapshot`), never a reconstruction — when no snapshot exists the
 * field stays absent (the ADAAAA-8223 rule: absent ≠ fabricated).
 */
export interface LiveCancelledSettlementInput {
  /** `DECIDE_FEE` list price per decide call. */
  decideFee: number;
  /** Seconds the perceive session was paid for; null when the clock never
   * started (no `startedAt`), in which case no watch-minutes are claimed. */
  perceiveSessionS: number | null;
  /** The live pass's observe snapshot — its final outcome on the drained path,
   * the last published snapshot on the drain-timeout path. */
  observeMetrics?: Job["observeMetrics"];
  /** Durable per-decide rows, the measured fallback when no snapshot exists. */
  decideRows: number;
  /** ADAAAA-8692: MEASURED summary (body-copy) calls this stream billed. The
   *  same count the caller folds into `observeMetrics.summaryCalls`, so the
   *  settlement's `costUsd` and its `costPerStreamHour` price one bill. */
  summaryCalls?: number;
  /** Per-call summary fee (`SUMMARY_FEE`; clamped to 1.5x `DECIDE_FEE`). */
  summaryFee?: number;
  /** Stage-A audio-gate snapshot (for `completedLiveCounterFields`). */
  stageA?: StageAMetricsSnapshot;
  /** Store's DEDUPED highlight count for the job. */
  persistedHighlights: number;
  perceiveSessionId?: string;
  /** `stopped` (pass settled itself) or `stopped (drain timeout)` (route settled). */
  progressLabel: string;
  error?: string;
  nowMs?: number;
}

export function liveCancelledSettlement(input: LiveCancelledSettlementInput): Partial<Omit<Job, "id">> {
  const { observeMetrics, perceiveSessionS } = input;
  // ONE source for the decide term (ADAAAA-8242): the snapshot the pass
  // published wins, the durable rows are the fallback. `null` (never 0) when
  // neither exists, so the row settles `costUnavailable` instead of a false $0.
  const decideCalls =
    observeMetrics?.decideCalls ?? (input.decideRows > 0 ? input.decideRows : null);
  return buildTerminalAccountingPatch({
    status: "cancelled",
    decideFee: input.decideFee,
    decideCalls,
    perceiveSessionS,
    // ADAAAA-8692: bill the stop's own copy calls in the settlement and price
    // `costPerStreamHour` off the LIVE stream clock (the perceived session), so a
    // `cancelled` leg carries the AC5 readout a completed leg carries — QA-D
    // measured `null` on `5cc78c08` for exactly this reason.
    summaryCalls: input.summaryCalls,
    summaryFee: input.summaryFee,
    streamSeconds: perceiveSessionS,
    nowMs: input.nowMs,
    observeMetrics,
    error: input.error ?? "stopped (cancelled via API)",
    costUnavailableReason: "decide-count-not-persisted",
    extra: {
      stage: "cancelled",
      progressLabel: input.progressLabel,
      // ADAAAA-8310/7722: the watch clock is the measured session clock the
      // patch bills on — written by BOTH writers, so a stopped stream always
      // carries the AC4 stored-field denominator.
      ...(perceiveSessionS !== null
        ? { liveWatchMinutes: Number((perceiveSessionS / 60).toFixed(3)) }
        : {}),
      ...(input.perceiveSessionId ? { perceiveSessionId: input.perceiveSessionId } : {}),
      // ADAAAA-7624/7667: Stage-A status + live candidate counters. Absent only
      // when the route could not read a Stage-A snapshot (then the row keeps
      // whatever the running pass already persisted — never a fabricated n/a).
      ...(input.stageA
        ? completedLiveCounterFields(input.stageA, observeMetrics, input.persistedHighlights)
        : {}),
    },
  });
}
