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

/**
 * ADAAAA-8018: the group SLOT one billed decide's row occupies.
 *
 * `decideGroupKey` buckets content time into 3 s groups, but a frame group can be
 * billed MORE THAN ONCE, and each of those calls is a separate paid decide: an
 * audio/whistle trigger fire can land in the same bucket as the cadence (or
 * another trigger) fire — measured on job `14e0af6e` (48 `decideCalls` =
 * 28 cadence + 20 trigger fires, 47 rows, `costUsd` -2.5%). The FIRST billed call
 * of a group keeps the canonical slot (`g59`) so every per-group read and the
 * decision-trail UI resolve unchanged; each additional billed call gets its own
 * slot (`g59:call2`) and is labelled in the row id + `params.auditOrdinal` /
 * `params.auditBaseGroupKey`. The suffix keeps the table's
 * UNIQUE(session_id, group_key) satisfied without a schema migration, and it
 * stays inside the webapp's `^g(\d+)(?::[a-z0-9_-]+)?$` group-key grammar, so the
 * in-video time still renders.
 */
export function decideAuditGroupSlot(groupKey: string, ordinal: number): string {
  const n = Number.isFinite(ordinal) ? Math.floor(ordinal) : 1;
  return n <= 1 ? groupKey : `${groupKey}:call${n}`;
}

/** Map a decide-service compact audit descriptor (as emitted by gemma.py
 * `_audit_descriptor`, read off the decision as `_audit`) to a
 * DecideAuditRecord. Returns null when the descriptor is absent or lacks
 * enough identity to index (no job/session identity and no groupKey).
 *
 * `ordinal` is the 1-based order of this decide CALL within its frame group
 * (ADAAAA-8018): 1 is the group's canonical row, 2+ is an additional billed
 * call for the same group (see {@link decideAuditGroupSlot}). */
export function decideAuditRecordFromDescriptor(desc: any, ordinal = 1): DecideAuditRecord | null {
  const ident = decideAuditIdentity(desc);
  if (!ident) return null;
  const slot = decideAuditGroupSlot(ident.groupKey, ordinal);
  const ordinalLabel = slot === ident.groupKey ? null : Math.floor(ordinal);
  const baseParams = desc.params && typeof desc.params === "object" ? desc.params : null;
  return {
    // ADAAAA-7626: job-scoped row id. Two jobs deciding the same in-video group
    // key now produce two disjoint rows instead of overwriting one another.
    // ADAAAA-8018: an extra billed call for the SAME group gets its own id, so
    // it appends a labelled row instead of overwriting the group's first row.
    id: `${ident.identity}::${slot}`,
    jobId: ident.jobId,
    // Identity first: for a post-fix row sessionId === jobId, which keeps the
    // UNIQUE(session_id, group_key) constraint job-scoped.
    sessionId: ident.identity,
    groupKey: slot,
    timestamp: typeof desc.timestamp === "number" ? desc.timestamp : null,
    frameCount: desc.frameCount ?? null,
    candidateCount: desc.candidateCount ?? null,
    systemPromptVersion: desc.systemPromptVersion ?? null,
    promptText: desc.promptText ?? null,
    mediaHashes: Array.isArray(desc.mediaHashes) ? desc.mediaHashes : [],
    params:
      ordinalLabel === null
        ? baseParams
        : { ...(baseParams ?? {}), auditOrdinal: ordinalLabel, auditBaseGroupKey: ident.groupKey },
    rawReply: desc.rawReply ?? null,
    verdicts: desc.verdicts ?? null,
    timings: desc.timings ?? null,
    fallback: !!desc.fallback,
    replayable: !!desc.replayable,
    createdAt: decideAuditCreatedAt(desc.createdAt),
  };
}

/** In-flight audit writes, keyed by the group's canonical identity. ADAAAA-8018:
 * two decides for the SAME frame group can settle close together (a whistle fire
 * landing in a cadence window's 3 s bucket), and both would otherwise read the
 * same "billed calls so far" and upsert onto the group's canonical row — exactly
 * the collision that lost one billed call's row on job `14e0af6e`. Chaining the
 * writes per group makes each call's ordinal distinct; the entry is dropped once
 * that group's chain drains, so the map stays bounded by in-flight groups. */
const inFlightGroupAudits = new Map<string, Promise<void>>();

/** Ingest one decide audit descriptor as its own billed call, enforcing the
 * retention cap (keep the `retention` newest rows). Side-effect-free on failure:
 * a bad descriptor or a DB error must never fail the decide call, so this never
 * throws to the decide-call path. */
export async function recordDecideAudit(db: Db, desc: any, retention: number): Promise<void> {
  const ident = decideAuditIdentity(desc);
  if (!ident) return;
  const groupId = `${ident.identity}::${ident.groupKey}`;
  const run = (inFlightGroupAudits.get(groupId) ?? Promise.resolve()).then(() =>
    ingestOneDecideCall(db, desc, retention, ident)
  );
  inFlightGroupAudits.set(groupId, run);
  try {
    await run;
  } finally {
    if (inFlightGroupAudits.get(groupId) === run) inFlightGroupAudits.delete(groupId);
  }
}

async function ingestOneDecideCall(
  db: Db,
  desc: any,
  retention: number,
  ident: NonNullable<ReturnType<typeof decideAuditIdentity>>
): Promise<void> {
  try {
    // ADAAAA-8018: how many billed decide calls already hold a row for this
    // group. Call 1 keeps the canonical slot; every later call appends a labelled
    // row, so `decide_audit` rows track `observeMetrics.decideCalls` 1:1.
    const billedCalls = await db.decideAuditCallsForGroup(ident.identity, ident.groupKey);
    const rec = decideAuditRecordFromDescriptor(desc, billedCalls + 1);
    if (!rec) return;
    await db.saveDecideAudit(rec);
    if (retention > 0) await db.trimDecideAudits(retention);
  } catch (e: any) {
    // Survivability: audit is best-effort; never break the decision pipeline.
    console.error(`[decide-audit:${(desc as any)?.groupKey ?? "?"}] ingest failed:`, String(e?.message || e));
  }
}
