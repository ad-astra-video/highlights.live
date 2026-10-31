// ADAAAA-7028 Increment 2: durable decide_audit index + queryable surface.
//
// The decide service returns a compact `_audit` descriptor on each /highlight
// decision (group identity, prompt text, media content hashes, model params,
// raw reply, parsed verdicts, timings, fallback flag). This module maps that
// descriptor to a DecideAuditRecord and persists it (upsert on the row id so a
// frame group resolves to exactly one row), then enforces the retention cap on
// the write path so storage stays bounded.
//
// ADAAAA-7626: row identity is JOB-scoped. The adapter used to hardcode
// sessionId "job" on every decide payload, so two jobs deciding the same 3 s
// group upserted the SAME (session_id, group_key) row and the later job
// overwrote the earlier job's frameCount / promptText / job_id. The identity is
// now derived from the descriptor's jobId (falling back to sessionId for legacy
// callers with no job identity), and `sessionId` on the stored row is set to
// that same identity — so the table's UNIQUE(session_id, group_key) enforces
// per-job group uniqueness.
import type { Db, DecideAuditRecord } from "./db";

/** ADAAAA-7626: the job-scoped identity of one decide-audit descriptor.
 * Returns null when the descriptor carries neither a job/session identity nor a
 * group key (a descriptor we cannot index). */
export function decideAuditIdentity(desc: any): {
  /** The identity the row id is built from: the jobId, else the sessionId. */
  identity: string;
  jobId: string | null;
  groupKey: string;
} | null {
  if (!desc || typeof desc !== "object") return null;
  const jobId = typeof desc.jobId === "string" && desc.jobId.trim() ? desc.jobId.trim() : null;
  const sessionId = typeof desc.sessionId === "string" && desc.sessionId.trim() ? desc.sessionId.trim() : null;
  const groupKey = typeof desc.groupKey === "string" && desc.groupKey.trim() ? desc.groupKey.trim() : "g";
  const identity = jobId ?? sessionId;
  if (!identity && !desc.groupKey) return null;
  return { identity: identity ?? "anon", jobId, groupKey };
}

/** Map a decide-service compact audit descriptor (as emitted by gemma.py
 * `_audit_descriptor`, read off the decision as `_audit`) to a
 * DecideAuditRecord. Returns null when the descriptor is absent or lacks
 * enough identity to index (no job/session identity and no groupKey). */
export function decideAuditRecordFromDescriptor(desc: any): DecideAuditRecord | null {
  const ident = decideAuditIdentity(desc);
  if (!ident) return null;
  return {
    // ADAAAA-7626: job-scoped row id. Two jobs deciding the same in-video group
    // key now produce two disjoint rows instead of overwriting one another.
    id: `${ident.identity}::${ident.groupKey}`,
    jobId: ident.jobId,
    // Identity first: for a post-fix row sessionId === jobId, which keeps the
    // UNIQUE(session_id, group_key) constraint job-scoped.
    sessionId: ident.identity,
    groupKey: ident.groupKey,
    timestamp: typeof desc.timestamp === "number" ? desc.timestamp : null,
    frameCount: desc.frameCount ?? null,
    candidateCount: desc.candidateCount ?? null,
    systemPromptVersion: desc.systemPromptVersion ?? null,
    promptText: desc.promptText ?? null,
    mediaHashes: Array.isArray(desc.mediaHashes) ? desc.mediaHashes : [],
    params: desc.params ?? null,
    rawReply: desc.rawReply ?? null,
    verdicts: desc.verdicts ?? null,
    timings: desc.timings ?? null,
    fallback: !!desc.fallback,
    replayable: !!desc.replayable,
    createdAt: desc.createdAt ? String(desc.createdAt) : new Date().toISOString(),
  };
}

/** Ingest one decide audit descriptor and enforce the retention cap (keep the
 * `retention` newest rows). Side-effect-free on failure: a bad descriptor or a
 * DB error must never fail the decide call, so this never throws to the
 * decide-call path. */
export async function recordDecideAudit(db: Db, desc: any, retention: number): Promise<void> {
  try {
    const rec = decideAuditRecordFromDescriptor(desc);
    if (!rec) return;
    await db.saveDecideAudit(rec);
    if (retention > 0) await db.trimDecideAudits(retention);
  } catch (e: any) {
    // Survivability: audit is best-effort; never break the decision pipeline.
    console.error(`[decide-audit:${(desc as any)?.groupKey ?? "?"}] ingest failed:`, String(e?.message || e));
  }
}
