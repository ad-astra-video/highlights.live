/**
 * ADAAAA-8286: the acceptance lane of a job, and the tombstone that keeps it
 * after `DELETE /jobs/:id`.
 *
 * `DELETE /jobs/:id` cascade-deletes `job_candidates` (the per-candidate decide
 * record: `status`, `trigger.scoreBoardChanged` / `goalCrossed` / `ballOutcome`,
 * the Stage-2 `confirm` block), plus `highlights` and the job row itself. Those
 * rows are exactly the evidence behind "why was this highlight never
 * confirmed?", so a job delete used to leave a half-evidence state: the
 * window-level `decide_audit` rows survived but could not be joined back to
 * candidate ids, acceptance decisions or suppression reasons.
 *
 * This module builds the compact lane projection that the delete transaction
 * writes to `deleted_jobs`, and that `GET /jobs/:id/acceptance-lane` serves for
 * both a live job (from the Store) and a deleted one (from the tombstone).
 * Pure functions only — no DB, no inference — so the projection is testable on
 * its own.
 */
import type { Job, JobCandidate } from "@highlights/events";
import type { AcceptanceLaneRow, DeletedJobCounts, DeletedJobTombstone } from "./db";

/** ADAAAA-8728 (R7): the measured authority one candidate row names. Reads only
 *  the fields the accept gate itself stored (trigger signals + the dive verdict),
 *  so the projection cannot disagree with the row it describes. */
export function laneRowAuthority(c: JobCandidate): "scoreboard" | "frame" | "none" {
  if (c.trigger?.scoreBoardChanged === true) return "scoreboard";
  if (c.trigger?.goalCrossed === true) return "frame";
  if (/^goal$/i.test((c.trigger?.ballOutcome ?? "").trim())) return "frame";
  const dive = c.confirm?.decision;
  if (dive?.corroborated === true) {
    if (dive.corroborationSource === "scoreboard") return "scoreboard";
    if (dive.corroborationSource === "frame_attestation") return "frame";
  }
  return "none";
}

/** ADAAAA-8728 (AC-5): delivered GOAL rows that name no measured authority. The
 *  contract requires 0 over a job's acceptance lane; this is the falsifier that
 *  counts them instead of trusting the gate. Fail-closed: an ABSENT field counts
 *  too — a delivered GOAL that cannot name its authority is the defect, whether
 *  it says `none` or says nothing (every row written before R7 landed). */
export function countDeliveredGoalsWithoutAuthority(
  rows: ReadonlyArray<{ status: string; eventType?: string | null; authority?: string | null }>
): number {
  return rows.filter(
    (r) =>
      r.status === "accepted" &&
      /^(GOAL|GOL)$/i.test((r.eventType ?? "").trim()) &&
      r.authority !== "scoreboard" &&
      r.authority !== "frame"
  ).length;
}

/**
 * Project one stored candidate onto the compact acceptance-lane row.
 *
 * Deliberately drops the heavy `analysis` payload (full prompt, ordered data
 * items, media refs, raw reply): it is what would make a 260-candidate
 * tombstone megabytes, and the lane question never needs it — the prompt text
 * already survives in `decide_audit`. Everything the lane question DOES need is
 * copied: `status`, the trigger signals the accept gate read, the suppression
 * reason, and the confirm dive outcome.
 */
export function acceptanceLaneRow(c: JobCandidate): AcceptanceLaneRow {
  return {
    id: c.id,
    seq: c.seq ?? 0,
    timestamp: c.timestamp,
    eventType: c.eventType,
    score: c.score,
    isHighlight: c.isHighlight,
    outcome: c.outcome ?? null,
    status: c.status,
    reason: c.reason ?? null,
    suppressionReason: c.suppressionReason ?? null,
    trigger: c.trigger
      ? {
          kind: c.trigger.kind ?? null,
          scoreBoardChanged: c.trigger.scoreBoardChanged ?? null,
          goalCrossed: c.trigger.goalCrossed ?? null,
          ballOutcome: c.trigger.ballOutcome ?? null,
        }
      : null,
    // `confirm.decision` is the Stage-2 dive verdict; the request half of the
    // record (prompt + frames) is dropped for the same size reason.
    confirm: c.confirm
      ? {
          goalConfirmed: c.confirm.decision?.goalConfirmed ?? null,
          confidence: c.confirm.decision?.confidence ?? null,
          stage1Disagreed: c.confirm.decision?.stage1Disagreed ?? null,
          corroborated: c.confirm.decision?.corroborated ?? null,
          corroborationSource: c.confirm.decision?.corroborationSource ?? null,
        }
      : null,
    // ADAAAA-8728 (R7/AC-5): the authority the row used, from the same fields.
    authority: laneRowAuthority(c),
  };
}

/** Counts over one acceptance lane: the lane tallies plus the row counts of the
 * other artifacts the delete removes (highlights / alternatives /
 * observations), so the tombstone is self-describing. */
export function acceptanceLaneCounts(
  rows: { status: string; eventType?: string | null; authority?: string | null; confirm?: unknown }[],
  extra: { highlights?: number; alternatives?: number; observations?: number } = {}
): DeletedJobCounts {
  return {
    candidates: rows.length,
    accepted: rows.filter((r) => r.status === "accepted").length,
    suppressed: rows.filter((r) => r.status === "suppressed").length,
    rejected: rows.filter((r) => r.status === "rejected").length,
    confirmed: rows.filter((r) => r.confirm != null).length,
    // ADAAAA-8728 (AC-5): the metric the contract pins at 0.
    goalsWithNoAuthority: countDeliveredGoalsWithoutAuthority(rows),
    highlights: extra.highlights ?? 0,
    alternatives: extra.alternatives ?? 0,
    observations: extra.observations ?? 0,
  };
}

/** Build the tombstone written by `DELETE /jobs/:id`. Call it BEFORE the
 * cascade: the lane is read from the live working set and then committed in the
 * same transaction as the deletion. */
export function buildDeletedJobTombstone(
  job: Job,
  candidates: JobCandidate[],
  extra: { highlights: number; alternatives: number; observations: number },
  deletedBy: string | null,
  deletedAt: string = new Date().toISOString()
): DeletedJobTombstone {
  const rows = candidates.map(acceptanceLaneRow);
  return {
    jobId: job.id,
    ownerId: job.ownerId ?? null,
    status: job.status ?? null,
    source: job.source ?? null,
    deletedAt,
    deletedBy,
    counts: acceptanceLaneCounts(rows, extra),
    candidates: rows,
  };
}
