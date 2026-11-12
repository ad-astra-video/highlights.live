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

type LaneAuthority = "scoreboard" | "frame" | "none";

/** ADAAAA-8774: what the DELIVERED card discloses about itself. `attestationUsed`
 *  and the row-level corroboration fields are the accept-time / dive-time
 *  disclosure the card renders, so they — not a re-derivation — are the primary
 *  basis for the lane's authority. Narrow structural type: a stored highlight
 *  row satisfies it, and a tombstone reader can still build one by hand. */
export interface DeliveredHighlightLike {
  /** `highlights.record.candidateId` — the link back to the lane row
   *  (ADAAAA-6798). A row without it cannot be attributed to a candidate. */
  candidateId?: string | null;
  /** Only a delivered (`accepted`) row contributes a disclosure. */
  status?: string | null;
  attestationUsed?: {
    /** ADAAAA-8728 (R7): the measured authority the accept/dive lane disclosed. */
    authority?: LaneAuthority | string | null;
    refusalReason?: string | null;
    /** ADAAAA-8774 (R3 offline): cited-frame count on a frame attestation. */
    frameRefCount?: number | null;
    /** The rest of the disclosure (score reads, transition, …) is not read here. */
    [extra: string]: unknown;
  } | null;
  corroborationSource?: string | null;
}

/** The authority the CANDIDATE record alone names (trigger signals + the dive
 *  verdict). Kept exported because it is a second, independent basis: the lane
 *  reports it beside the delivered one so a disagreement is visible.
 *
 *  ADAAAA-8728 (R7) derivation; ADAAAA-8774 keeps it as the FALLBACK only. */
export function candidateRowAuthority(c: JobCandidate): LaneAuthority {
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

/** ADAAAA-8774 (AC-5): the lane row's authority, preferring the disclosure the
 *  DELIVERED card itself carries.
 *
 *  Why the delivered row wins: the QA seed replay on ADAAAA-8768 found a card
 *  whose stored `attestationUsed.authority` says `frame` (`corroborated: true`,
 *  `goalConfirmed: confirmed_goal`, ball-in-net evidence) while its candidate
 *  record carried only `trigger: {kind: motion}` and a `confirm` block with a
 *  decision + request and no corroboration — so a candidate-only derivation said
 *  `none` and the AC-5 falsifier counted a delivered GOAL as unattested, i.e. it
 *  reported a violation the row itself refutes. The row's disclosure is the
 *  accept-time attestation (it is what the card renders), so the lane must never
 *  contradict it; the candidate derivation stays as the fallback for lanes
 *  written before R7 (no `attestationUsed.authority`) — never as the primary.
 *
 *  `none` is a real disclosure, not a missing one: a demoted row that says
 *  `none` keeps saying `none` here (the fallback must not re-credit it). */
export function laneRowAuthority(
  c: JobCandidate,
  delivered?: DeliveredHighlightLike | null
): LaneAuthority {
  const stored = delivered?.attestationUsed?.authority;
  if (stored === "scoreboard" || stored === "frame" || stored === "none") return stored;
  return candidateRowAuthority(c);
}

/** ADAAAA-8774: index the delivered rows' disclosures by candidate id, so a
 *  lane projection is one map lookup per row. Only `accepted` rows contribute:
 *  a rejected clip is not delivered and its disclosure never describes a lane
 *  accept. Later rows win (a re-attested/re-promoted row replaces the earlier
 *  one), which matches the store's single-row-per-candidate reality. */
export function deliveredAuthorityByCandidate(
  rows: ReadonlyArray<DeliveredHighlightLike>
): Map<string, DeliveredHighlightLike> {
  const byCandidate = new Map<string, DeliveredHighlightLike>();
  for (const r of rows) {
    const id = r?.candidateId;
    if (!id) continue;
    if (r.status != null && r.status !== "accepted") continue;
    if (!r.attestationUsed && !r.corroborationSource) continue;
    byCandidate.set(id, r);
  }
  return byCandidate;
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
 *
 * ADAAAA-8774: pass the candidate's delivered highlight row (when one exists)
 * so the row's `authority` is the DELIVERED disclosure, with the trigger-derived
 * value reported beside it as `candidateAuthority`.
 */
export function acceptanceLaneRow(
  c: JobCandidate,
  delivered?: DeliveredHighlightLike | null
): AcceptanceLaneRow {
  const storedAuthority = delivered?.attestationUsed?.authority;
  const fromRow =
    storedAuthority === "scoreboard" || storedAuthority === "frame" || storedAuthority === "none";
  const authority: LaneAuthority = fromRow ? storedAuthority : candidateRowAuthority(c);
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
    // ADAAAA-8728 (R7/AC-5) / ADAAAA-8774: the authority the DELIVERED row used,
    // falling back to the candidate's own signals, plus both bases so a
    // disagreement between the lane and the card is visible on one row.
    authority,
    authoritySource: fromRow ? "row" : "candidate",
    candidateAuthority: candidateRowAuthority(c),
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
 * same transaction as the deletion.
 *
 * ADAAAA-8774: `extra.delivered` carries the job's stored highlight rows. They
 * are still in the store at this point, so the tombstone keeps the DELIVERED
 * authority of each accepted row — otherwise the surviving lane would say `none`
 * about a card that shipped as a GOAL naming a measured authority. */
export function buildDeletedJobTombstone(
  job: Job,
  candidates: JobCandidate[],
  extra: {
    highlights: number;
    alternatives: number;
    observations: number;
    delivered?: ReadonlyArray<DeliveredHighlightLike>;
  },
  deletedBy: string | null,
  deletedAt: string = new Date().toISOString()
): DeletedJobTombstone {
  const delivered = deliveredAuthorityByCandidate(extra.delivered ?? []);
  const rows = candidates.map((c) => acceptanceLaneRow(c, delivered.get(c.id)));
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
