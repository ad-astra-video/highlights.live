// ADAAAA-8425: the STORED-RECORD answer to "why are live windows missing while
// the decide cards read idle" (the question ADAAAA-8418 could not self-serve).
//
// The rail persists five different skip causes and one aggregate, and until this
// module nothing surfaced them: the board saw one supply number and had to shell
// into the box to learn which cause produced it. This module is the single, pure
// derivation of the admin readout — read-only, no IO, no counter re-computation
// (the five numbers are read as stored) and no GPU.
//
// What it deliberately does NOT do:
// - It never folds the throttle or a capacity drop into `skippedWindows`: the
//   supply total is stale + backpressure + admission, fixed by the PO ruling on
//   ADAAAA-7808, and the customer live chip keeps that meaning.
// - It never invents a number for a record that carries no observe snapshot:
//   `observeRecorded: false` says "not measured", which is NOT a measured zero.
import type { Job, WindowSkipAudit } from "@highlights/events";

/** The subset of the stored job record the audit reads. Typed explicitly rather
 *  than via `Pick` so a route can pass a partially-projected record. */
type AuditableJob = {
  id: string;
  status: string;
  source: string;
  observeMetrics?: Job["observeMetrics"];
};

function count(value: number | undefined | null): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Build the admin window-audit readout from one stored job record.
 *
 * `skippedWindows` is the SUPPLY number the customer chip shows, preferring the
 * record's own `supplySkippedWindows` (written at completion) and falling back to
 * the sum of its three causes for a record written before that field existed —
 * the same derivation `deriveLiveProgress` uses, so the two surfaces can never
 * disagree about the supply total.
 */
export function windowSkipAudit(job: AuditableJob): WindowSkipAudit {
  const obs = job.observeMetrics;
  const stale = count(obs?.skippedStaleWindows);
  const backpressure = count(obs?.backpressureSkippedWindows);
  const admission = count(obs?.admissionSkippedWindows);
  const throttle = count(obs?.throttleSkippedWindows);
  // NULL, not 0, when the row predates the counter: "no capacity drop" and
  // "capacity drops were never counted" are different answers.
  const capacityDropped = obs && obs.capacityDroppedWindows !== undefined
    ? count(obs.capacityDroppedWindows)
    : null;
  const storedSupply = obs?.supplySkippedWindows;
  const supply =
    storedSupply !== undefined && storedSupply !== null && Number.isFinite(storedSupply)
      ? count(storedSupply)
      : stale + backpressure + admission;
  const capacity = obs?.decideCapacity;
  return {
    jobId: job.id,
    status: String(job.status ?? "unknown"),
    source: String(job.source ?? "unknown"),
    decideCalls: count(obs?.decideCalls),
    skippedWindows: supply,
    staleSkippedWindows: stale,
    backpressureSkippedWindows: backpressure,
    admissionSkippedWindows: admission,
    throttleSkippedWindows: throttle,
    capacityDroppedWindows: capacityDropped,
    observeRecorded: !!obs,
    decideCapacity: capacity ? { ...capacity } : null,
  };
}
