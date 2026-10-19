import { describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db";
import { decideAuditRecordFromDescriptor, recordDecideAudit } from "../src/decide-audit";

const descriptor = {
  version: 1,
  systemPromptVersion: "1",
  mode: "single",
  sessionId: "sess-1",
  jobId: "job-1",
  groupKey: "g7",
  frameCount: 3,
  candidateCount: 1,
  promptText: "system\nuser prompt",
  mediaHashes: [{ type: "image", sha256: "b".repeat(64), mime: "image/jpeg" }],
  params: { temperature: 0.0, max_tokens: 1200 },
  rawReply: '{"isHighlight":true}',
  verdicts: { isHighlight: true },
  timings: { elapsedMs: 8.1 },
  fallback: false,
  replayable: true,
  createdAt: 1770000000.0,
};

describe("decide_audit ingestion (decide-audit.ts)", () => {
  it("maps a decide descriptor to a DecideAuditRecord", () => {
    const rec = decideAuditRecordFromDescriptor(descriptor)!;
    expect(rec).not.toBeNull();
    expect(rec.sessionId).toBe("sess-1");
    expect(rec.jobId).toBe("job-1");
    expect(rec.groupKey).toBe("g7");
    expect(rec.systemPromptVersion).toBe("1");
    expect(rec.promptText).toBe("system\nuser prompt");
    expect(rec.mediaHashes).toEqual([{ type: "image", sha256: "b".repeat(64), mime: "image/jpeg" }]);
    expect(rec.rawReply).toBe('{"isHighlight":true}');
    expect(rec.verdicts).toEqual({ isHighlight: true });
    expect(rec.replayable).toBe(true);
    expect(rec.fallback).toBe(false);
  });

  it("returns null for a missing / identity-less descriptor (no-op ingestion)", () => {
    expect(decideAuditRecordFromDescriptor(null)).toBeNull();
    expect(decideAuditRecordFromDescriptor({ promptText: "x" })).toBeNull();
    expect(decideAuditRecordFromDescriptor(undefined)).toBeNull();
  });

  it("recordDecideAudit persists + enforces retention, and never throws", async () => {
    const db = new SqliteDb(":memory:");
    await recordDecideAudit(db, descriptor, 100);
    expect(await db.listDecideAudits()).toHaveLength(1);
    expect((await db.decideAuditForGroup("sess-1", "g7"))!.jobId).toBe("job-1");

    // A degenerate descriptor is a no-op and must not throw.
    await expect(recordDecideAudit(db, null, 100)).resolves.toBeUndefined();

    // Retention: keep 1 — after two records only the newest survives.
    await recordDecideAudit(
      db,
      { ...descriptor, groupKey: "g8", createdAt: 1770000001.0 },
      1
    );
    const rows = await db.listDecideAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0].groupKey).toBe("g8");

    await db.close();
  });
});
