// ADAAAA-7028 Increment 2: durable decide_audit index + queryable surface.
//
// The decide service returns a compact `_audit` descriptor on each /highlight
// decision (group identity, prompt text, media content hashes, model params,
// raw reply, parsed verdicts, timings, fallback flag). This module maps that
// descriptor to a DecideAuditRecord and persists it (upsert on
// (sessionId, groupKey) so a frame group resolves to exactly one row), then
// enforces the retention cap on the write path so storage stays bounded.
import type { Db, DecideAuditRecord } from "./db";

/** Map a decide-service compact audit descriptor (as emitted by gemma.py
 * `_audit_descriptor`, read off the decision as `_audit`) to a
 * DecideAuditRecord. Returns null when the descriptor is absent or lacks
 * enough identity to index (no sessionId/groupKey and no fallback). */
export function decideAuditRecordFromDescriptor(desc: any): DecideAuditRecord | null {
  if (!desc || typeof desc !== "object") return null;
  const sessionId = desc.sessionId ?? null;
  const groupKey = desc.groupKey ?? null;
  if (!sessionId && !groupKey) return null;
  return {
    id: `${sessionId ?? "anon"}::${groupKey ?? desc.groupKey ?? "g"}`,
    jobId: desc.jobId ?? null,
    sessionId: sessionId ?? "anon",
    groupKey: groupKey ?? "g",
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
