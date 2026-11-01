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

/** ADAAAA-7626: normalize a descriptor `createdAt` to an ISO-8601 UTC string.
 *
 * The decide service stamps `createdAt` as an epoch NUMBER (`round(time.time(),3)`),
 * while Stage-2 confirm descriptors are stamped server-side as ISO. The table's
 * `created_at` is TEXT and BOTH the retention trim and every read path
 * `ORDER BY created_at` lexicographically — an epoch string ("1762…") sorts BELOW
 * every ISO timestamp ("2026-…"). With the table at its retention cap every
 * insert triggers a trim, so a freshly written Stage-1 row was classified as the
 * OLDEST row and deleted in the same write path; only the confirm rows survived.
 * That is why a job showed `gNNN:confirm` rows and no Stage-1 rows even after the
 * identity fix. Normalize to ISO so retention is real wall-clock order. */
export function decideAuditCreatedAt(v: unknown, now: number = Date.now()): string {
  let ms: number | null = null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    // seconds (< 1e11) vs milliseconds (>= 1e11) — epoch seconds now ~1.7e9.
    ms = v >= 1e11 ? v : v * 1000;
  } else if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) ms = n >= 1e11 ? n : n * 1000;
    else {
      const parsed = Date.parse(v);
      if (!Number.isNaN(parsed)) ms = parsed;
    }
  }
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return new Date(now).toISOString();
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? new Date(now).toISOString() : d.toISOString();
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
    createdAt: decideAuditCreatedAt(desc.createdAt),
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
