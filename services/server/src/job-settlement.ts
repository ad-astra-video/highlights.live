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
import type { Job } from "@highlights/events";

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
export function computeCostUsd(decideCalls: number, perceiveSessionS: number, decideFee: number, confirmCalls = 0): number {
  // ADAAAA-8205: confirm dives are decide-service calls, so they are metered in
  // the same term: `decideFee * (decideCalls + confirmCalls) + perceive`.
  const billableCalls = Math.max(0, decideCalls) + Math.max(0, confirmCalls);
  const cost = decideFee * billableCalls + (Math.max(0, perceiveSessionS) / 3600) * PERCEIVE_PER_HOUR_USD;
  return Number(cost.toFixed(4));
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
    const cost = computeCostUsd(decideCalls, perceiveS ?? 0, input.decideFee, confirmCalls);
    patch.decideCalls = decideCalls;
    if (perceiveS !== null) patch.perceiveSessionS = Number(perceiveS.toFixed(1));
    patch.costUsd = cost;
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
