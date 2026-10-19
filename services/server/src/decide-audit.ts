// ADAAAA-7028 Increment 2: durable decide_audit index + queryable surface.
// ADAAAA-7029 Increment 3: retention (bounded count OR byte cap + cleanup job),
// privacy (no credential ever enters a record), and access control.
//
// The decide service returns a compact `_audit` descriptor on each /highlight
// decision (group identity, prompt text, media content hashes, model params,
// raw reply, parsed verdicts, timings, fallback flag). This module maps that
// descriptor to a DecideAuditRecord and persists it (upsert on
// (sessionId, groupKey) so a frame group resolves to exactly one row), then
// enforces the retention cap on the write path so storage stays bounded.
import type { Db, DecideAuditRecord } from "./db";

// --- Secret redaction (ADAAAA-7029 Inc 3, privacy) ---------------------------
// Credential-shaped patterns are scrubbed from every free-text field before a
// record is persisted or returned, so no API key / token / Bearer credential
// ever enters a decide_audit record (acceptance metric: secret-pattern
// matches = 0). Pattern classes: Bearer headers, key=value assignments, and
// well-known token prefixes (sk-/pk- Stripe or vLLM, ghp_ GitHub, AKIA AWS,
// eyJ JWT, xoxb Slack).
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|auth[_-]?token|client[_-]?secret|refresh[_-]?token|password|passwd|token)\b\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9]{8,}\b/g,
  /\b(?:pk|rk)_[A-Za-z0-9]{8,}\b/g,
  /\bghp_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
];

export function redactSecrets(text: string | null | undefined): string | null {
  if (text == null) return text ?? null;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

/** Deep-redact every string value in a JSON-ish object (params/verdicts). */
export function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

/** Count credential-pattern matches across a record's free-text/JSON fields
 * (used by the acceptance test that the sample shows 0 matches). */
export function countSecretMatches(rec: DecideAuditRecord): number {
  let n = 0;
  const scan = (v: unknown) => {
    if (typeof v === "string") {
      for (const re of SECRET_PATTERNS) {
        re.lastIndex = 0;
        const m = v.match(re);
        if (m) n += m.length;
      }
    } else if (Array.isArray(v)) {
      v.forEach(scan);
    } else if (v && typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(scan);
    }
  };
  scan(rec.promptText);
  scan(rec.rawReply);
  scan(rec.params);
  scan(rec.verdicts);
  return n;
}

/** Content-addressed dedupe across groups: collapse a media list to one entry
 * per distinct sha256, so identical frame bytes across groups are referenced
 * once (the bytes live content-addressed in the audit dir / blobs). */
export function dedupeMediaHashes(media: { sha256?: string; mime?: string; type?: string }[]): { sha256: string; mime?: string; type?: string }[] {
  const seen = new Set<string>();
  const out: { sha256: string; mime?: string; type?: string }[] = [];
  for (const m of media ?? []) {
    const key = m.sha256 || `${m.type ?? ""}:${m.mime ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sha256: m.sha256 ?? "", mime: m.mime, type: m.type });
  }
  return out;
}

/** Map a decide-service compact audit descriptor (as emitted by gemma.py
 * `_audit_descriptor`, read off the decision as `_audit`) to a
 * DecideAuditRecord. Returns null when the descriptor is absent or lacks
 * enough identity to index (no sessionId/groupKey and no fallback). */
export function decideAuditRecordFromDescriptor(desc: any): DecideAuditRecord | null {
  if (!desc || typeof desc !== "object") return null;
  const sessionId = desc.sessionId ?? null;
  const groupKey = desc.groupKey ?? null;
  if (!sessionId && !groupKey) return null;
  // Privacy (Inc 3): scrub credentials from all free-text / JSON fields before
  // the record is persisted or surfaced. Media hashes are content refs, not
  // secrets, and are left intact (content-addressed dedupe applied below).
  return {
    id: `${sessionId ?? "anon"}::${groupKey ?? desc.groupKey ?? "g"}`,
    jobId: desc.jobId ?? null,
    sessionId: sessionId ?? "anon",
    groupKey: groupKey ?? "g",
    frameCount: desc.frameCount ?? null,
    candidateCount: desc.candidateCount ?? null,
    systemPromptVersion: desc.systemPromptVersion ?? null,
    promptText: redactSecrets(desc.promptText ?? null),
    mediaHashes: dedupeMediaHashes(Array.isArray(desc.mediaHashes) ? desc.mediaHashes : []),
    params: (redactDeep(desc.params ?? null) as Record<string, unknown> | null),
    rawReply: redactSecrets(desc.rawReply ?? null),
    verdicts: redactDeep(desc.verdicts ?? null),
    timings: desc.timings ?? null,
    fallback: !!desc.fallback,
    replayable: !!desc.replayable,
    createdAt: desc.createdAt ? String(desc.createdAt) : new Date().toISOString(),
  };
}

/** Approximate serialized byte size of one record (for the byte-cap trim). */
export function decideAuditRecordBytes(rec: DecideAuditRecord): number {
  try {
    return Buffer.byteLength(
      JSON.stringify({
        id: rec.id,
        jobId: rec.jobId,
        sessionId: rec.sessionId,
        groupKey: rec.groupKey,
        frameCount: rec.frameCount,
        candidateCount: rec.candidateCount,
        systemPromptVersion: rec.systemPromptVersion,
        promptText: rec.promptText,
        mediaHashes: rec.mediaHashes,
        params: rec.params,
        rawReply: rec.rawReply,
        verdicts: rec.verdicts,
        timings: rec.timings,
        fallback: rec.fallback,
        replayable: rec.replayable,
        createdAt: rec.createdAt,
      }),
      "utf8"
    );
  } catch {
    return 0;
  }
}

/** Ingest one decide audit descriptor and enforce the retention cap (keep the
 * `maxRecords` newest rows; when `maxBytes` > 0, additionally drop the oldest
 * rows until the total lives under the byte budget). Side-effect-free on
 * failure: a bad descriptor or a DB error must never fail the decide call, so
 * this never throws to the decide-call path. */
export async function recordDecideAudit(db: Db, desc: any, maxRecords: number, maxBytes = 0): Promise<void> {
  try {
    const rec = decideAuditRecordFromDescriptor(desc);
    if (!rec) return;
    await db.saveDecideAudit(rec);
    await enforceDecideAuditRetention(db, maxRecords, maxBytes);
  } catch (e: any) {
    // Survivability: audit is best-effort; never break the decision pipeline.
    console.error(`[decide-audit:${(desc as any)?.groupKey ?? "?"}] ingest failed:`, String(e?.message || e));
  }
}

/** Enforce the retention quota (count and/or byte cap) and run the content-
 * addressed dedupe. Called on the write path and by the scheduled cleanup job
 * (Inc 3) so storage stays bounded even without new writes. */
export async function enforceDecideAuditRetention(db: Db, maxRecords: number, maxBytes = 0): Promise<void> {
  // Count cap (Inc 2 behaviour).
  if (maxRecords > 0) await db.trimDecideAudits(maxRecords);
  // Byte cap (Inc 3): least-recently-written rows are dropped until the total
  // serialized size fits the budget.
  if (maxBytes > 0) {
    const rows = await db.listDecideAudits(); // newest-first
    let total = 0;
    for (const r of rows) total += decideAuditRecordBytes(r);
    const dropped: string[] = [];
    // Walk oldest-first (end of newest-first list), accumulating the budget.
    for (let i = rows.length - 1; i >= 0; i--) {
      if (total <= maxBytes) break;
      dropped.push(rows[i].id);
      total -= decideAuditRecordBytes(rows[i]);
    }
    if (dropped.length) await db.deleteDecideAudits(dropped);
  }
}
