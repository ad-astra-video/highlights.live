// ADAAAA-8425: client contract for the admin window audit
// (`GET /admin/jobs/:id/window-audit`). Mirrors the server projection locally
// (the webapp never imports server modules). Types are additive-only.
//
// The five causes are the whole point of the surface: a board reader must be
// able to tell "content arrived late" from "the decide pool had no slot" from
// "the funded rate cap dropped it" without a shell. The live chip keeps its
// ADAAAA-7808 supply semantics and is NOT fed from this payload.

export type WindowAuditCauseName = "stale" | "backpressure" | "admission" | "throttle" | "capacityDrop";

export interface WindowAuditCause {
  /** The `observeMetrics` field this count comes from. */
  field: string;
  cause: WindowAuditCauseName;
  label: string;
  count: number;
}

export interface WindowAuditCapacity {
  advertised: number;
  funded: number;
  effective: number;
  probeOk?: boolean;
  runners?: number;
  source?: "probe" | "last-known" | "funded";
  /** ADAAAA-8437: the `DECIDE_MAX_ADMISSION` safety bound `effective` was
   *  clamped to (absent on records written before the field existed). */
  cap?: number;
}

export interface WindowAuditPayload {
  jobId: string;
  status: string | null;
  source: string | null;
  /** False when the record carries no observe snapshot yet (in-flight job).
   *  The counts are null then — never fabricated zeros. */
  stored: boolean;
  causes: WindowAuditCause[];
  decideCalls: number | null;
  decideCallsCompleted: number | null;
  supplySkippedWindows: number | null;
  skippedWindows: number | null;
  accountedWindows: number | null;
  decideCapacity: WindowAuditCapacity | null;
}

/**
 * The ceiling pair as one readable string: `effective / funded`.
 *
 * AC3 wants the pool the job ACTUALLY ran at, so the first number is
 * `effective` (what the admission gate admitted, e.g. 6 discovered slots) and
 * the second is `funded` (`DECIDE_CONCURRENCY`, e.g. 8). A job latched at 6
 * with 8 funded reads `6 / 8`, never `8 / 8`.
 */
export function capacityPair(capacity: WindowAuditCapacity | null): { effective: number; funded: number; text: string } | null {
  if (!capacity) return null;
  const effective = Math.max(0, Math.round(Number(capacity.effective) || 0));
  const funded = Math.max(0, Math.round(Number(capacity.funded) || 0));
  return { effective, funded, text: `${effective} / ${funded}` };
}

/** True when the payload has a real stored split worth rendering. */
export function auditRenderable(audit?: WindowAuditPayload | null): audit is WindowAuditPayload {
  return !!audit && audit.stored === true && Array.isArray(audit.causes) && audit.causes.length > 0;
}
