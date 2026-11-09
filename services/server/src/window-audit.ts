// ADAAAA-8425: the admin window audit — WHY the live pass left windows
// undecided, read off the job's persisted observe snapshot. This is the
// read-time projection behind `GET /admin/jobs/:id/window-audit`; it makes the
// 5-way cause split self-serve instead of needing a container log join.
//
//   stale          window ready late, past the 30 s lag budget
//   backpressure   every in-flight decide slot of the stream was busy
//   admission      another live job held the box's single decide slot
//   throttle       the funded decide-rate cap dropped the opportunity
//   capacityDrop   the runner REFUSED the decide (503 / queue budget expired)
//
// `supplySkippedWindows` keeps its ADAAAA-7808 meaning (stale + backpressure +
// admission) and is NOT widened here: the ruling is unchanged, this readout
// only surfaces the causes. Purely derived from stored counters — zero decide
// calls, zero GPU, no write.
import type { LiveObserveMetricsSnapshot } from "./analyzer";

/** One cause row: the record's own field name and the count it carries. */
export interface WindowAuditCause {
  /** The `observeMetrics` field this count comes from. */
  field: keyof LiveObserveMetricsSnapshot;
  /** Short stable name for UI/QA selectors (`stale`, `capacityDrop`, ...). */
  cause: "stale" | "backpressure" | "admission" | "throttle" | "capacityDrop";
  label: string;
  /** Null when the record carries no observe snapshot (never a fabricated 0). */
  count: number | null;
}

/** The decide pool ceiling the job ran at, from ADAAAA-8254/8262/8437. */
export interface WindowAuditCapacity {
  /** Slots the runner fleet advertised (discovery probe). */
  advertised: number;
  /** Funded value (`DECIDE_CONCURRENCY`) — reporting only since ADAAAA-8437. */
  funded: number;
  /** What the gate actually admitted: `advertised` clamped to [1, cap], never 0. */
  effective: number;
  /** False = the last probe failed (distinct from an empty fleet). */
  probeOk?: boolean;
  /** ADAAAA-8504: decide REGISTRATIONS in the last well-formed answer (one
   *  `highlights-decide` app however wide the worker set is). */
  decideRegistrations?: number;
  /** LEGACY: the pre-8504 name of `decideRegistrations` (older rows only). */
  runners?: number;
  /** Provenance of `advertised`. */
  source?: "probe" | "last-known" | "funded";
  /** ADAAAA-8437: the `DECIDE_MAX_ADMISSION` safety bound `effective` was
   * clamped to (absent on records written before the field existed). */
  cap?: number;
  /** ADAAAA-8504: ISO wall clock the snapshot was taken (latched at job start). */
  at?: string;
}

export interface WindowAuditPayload {
  jobId: string;
  status: string | null;
  source: string | null;
  /** False when the record carries no observe snapshot yet (in-flight job, or a
   *  record settled by a route that wrote none). The counts are then null —
   *  never fabricated zeros. */
  stored: boolean;
  /** The four pre-existing causes + the ADAAAA-8425 capacity-drop cause, with
   *  the record's own field names so a reader can match `record->'observeMetrics'`
   *  field for field. */
  causes: WindowAuditCause[];
  /** Decide invocations the pass actually made. NOTE: the observer records a
   *  latency sample for every ISSUED window, so a window whose decide was
   *  refused for capacity is included here (it is the cost meter's basis). */
  decideCalls: number | null;
  /** Decides that produced a verdict: `decideCalls - capacityDroppedWindows`.
   *  This is the number that, together with the four non-fired causes, accounts
   *  for the pass's decide opportunities. */
  decideCallsCompleted: number | null;
  /** Supply skips (stale + backpressure + admission, throttle excluded). */
  supplySkippedWindows: number | null;
  /** Every window that produced NO verdict: the four non-fired causes plus the
   *  capacity drop. Distinct from `accountedWindows`, which counts issued calls. */
  skippedWindows: number | null;
  /** Decide opportunities accounted for: `decideCalls + stale + backpressure +
   *  admission + throttle`. A dropped decide is inside `decideCalls` (issued,
   *  refused), so it is NOT added again here. */
  accountedWindows: number | null;
  /** `{advertised, funded, effective}` latched by the decide admission gate;
   *  null when the record predates the field or the client has no gate. */
  decideCapacity: WindowAuditCapacity | null;
}

type AuditJob = {
  id: string;
  status?: string | null;
  source?: string | null;
  observeMetrics?: LiveObserveMetricsSnapshot | null;
};

/** Non-negative integer from a stored counter; null when the field is absent. */
function counter(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

/**
 * Project one stored job record into the window audit. Pure: no I/O, no clock,
 * no counters — the same record always produces the same payload, which is what
 * makes it gradeable field for field against `record->'observeMetrics'`.
 */
export function windowAuditForJob(job: AuditJob): WindowAuditPayload {
  const obs = job.observeMetrics ?? null;
  const stored = obs !== null;
  const causes: WindowAuditCause[] = [
    { field: "skippedStaleWindows", cause: "stale", label: "Stale (past lag budget)", count: counter(obs?.skippedStaleWindows) },
    { field: "backpressureSkippedWindows", cause: "backpressure", label: "Backpressure (in-flight slots busy)", count: counter(obs?.backpressureSkippedWindows) },
    { field: "admissionSkippedWindows", cause: "admission", label: "Admission (other live job held the slot)", count: counter(obs?.admissionSkippedWindows) },
    { field: "throttleSkippedWindows", cause: "throttle", label: "Throttle (funded rate cap)", count: counter(obs?.throttleSkippedWindows) },
    { field: "capacityDroppedWindows", cause: "capacityDrop", label: "Capacity drop (runner refused)", count: counter(obs?.capacityDroppedWindows) },
  ];
  const decideCalls = counter(obs?.decideCalls);
  // ADAAAA-7808: the persisted supply number wins when present; a record that
  // predates it derives the same value from its three causes.
  const supplySkippedWindows = stored
    ? counter(obs?.supplySkippedWindows) ??
      causes.slice(0, 3).reduce((sum, c) => sum + (c.count ?? 0), 0)
    : null;
  const causeSum = causes.reduce((sum, c) => sum + (c.count ?? 0), 0);
  const capacityDropped = counter(obs?.capacityDroppedWindows) ?? 0;
  // `decideCalls` counts ISSUED windows (a capacity-refused decide was issued
  // and recorded at settle), so the opportunity identity is
  // decideCalls + the four non-fired causes. Adding capacityDropped again would
  // double-count the same window.
  const nonFired = causes.slice(0, 4).reduce((sum, c) => sum + (c.count ?? 0), 0);
  const accountedWindows = stored && decideCalls !== null ? decideCalls + nonFired : null;
  const decideCallsCompleted = stored && decideCalls !== null ? Math.max(0, decideCalls - capacityDropped) : null;
  const skippedWindows = stored ? causeSum : null;
  const rawCapacity = obs?.decideCapacity;
  const decideCapacity: WindowAuditCapacity | null = rawCapacity
    ? {
        advertised: counter(rawCapacity.advertised) ?? 0,
        funded: counter(rawCapacity.funded) ?? 0,
        effective: counter(rawCapacity.effective) ?? 0,
        ...(rawCapacity.probeOk !== undefined ? { probeOk: rawCapacity.probeOk } : {}),
        // ADAAAA-8504: `decideRegistrations` is the written name; `runners` is
        // only read back from rows written before the rename.
        ...(rawCapacity.decideRegistrations !== undefined
          ? { decideRegistrations: counter(rawCapacity.decideRegistrations) ?? 0 }
          : rawCapacity.runners !== undefined
            ? { runners: counter(rawCapacity.runners) ?? 0 }
            : {}),
        ...(rawCapacity.source !== undefined ? { source: rawCapacity.source } : {}),
        ...(rawCapacity.cap !== undefined ? { cap: Math.max(1, counter(rawCapacity.cap) ?? 1) } : {}),
        ...(rawCapacity.at !== undefined ? { at: rawCapacity.at } : {}),
      }
    : null;
  return {
    jobId: job.id,
    status: job.status ?? null,
    source: job.source ?? null,
    stored,
    causes,
    decideCalls,
    decideCallsCompleted,
    supplySkippedWindows,
    skippedWindows,
    accountedWindows,
    decideCapacity,
  };
}
