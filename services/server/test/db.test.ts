import { describe, expect, it } from "vitest";
import { SqliteDb, type MediaSession, type DecideAuditRecord } from "../src/db";

describe("media_sessions persistence (SqliteDb)", () => {
  it("round-trips and upserts media sessions by jobId", async () => {
    const db = new SqliteDb(":memory:");
    const now = new Date().toISOString();
    const ms: MediaSession = {
      jobId: "job-1",
      sessionId: "sess-1",
      streamId: "stream-1",
      wsUrl: "wss://media.example.com/stream/sess-1",
      mediaOrigin: "https://media.example.com",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    expect(await db.getMediaSession("job-1")).toBeUndefined();

    await db.setMediaSession(ms);
    const got = await db.getMediaSession("job-1");
    expect(got).toEqual(ms);
    expect(got!.status).toBe("active");

    // Upsert replaces the session (e.g. a reroute re-provisions a fresh one).
    await db.setMediaSession({ ...ms, sessionId: "sess-2", wsUrl: "wss://media.example.com/stream/sess-2" });
    expect((await db.getMediaSession("job-1"))!.sessionId).toBe("sess-2");

    await db.clearMediaSession("job-1");
    expect(await db.getMediaSession("job-1")).toBeUndefined();
    await db.close();
  });

  // ADAAAA-6869 Phase 4: the node that carried a session is persisted so
  // Livepeer GPU spend is attributable per node; legacy rows stay unattributed.
  it("persists the media node id per session (and lists sessions for attribution)", async () => {
    const db = new SqliteDb(":memory:");
    const now = new Date().toISOString();
    const base = {
      sessionId: "sess-1",
      streamId: "stream-1",
      wsUrl: "wss://media.example.com/stream/sess-1",
      mediaOrigin: "https://media.example.com",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    await db.setMediaSession({ ...base, jobId: "job-node", nodeId: "media-0" });
    await db.setMediaSession({ ...base, jobId: "job-legacy" });

    expect((await db.getMediaSession("job-node"))!.nodeId).toBe("media-0");
    // A pre-node_id row round-trips without inventing a node.
    expect((await db.getMediaSession("job-legacy"))!.nodeId).toBeUndefined();

    const all = await db.listMediaSessions();
    expect(all.map((s) => s.jobId).sort()).toEqual(["job-legacy", "job-node"]);
    expect(all.find((s) => s.jobId === "job-node")!.nodeId).toBe("media-0");
    await db.close();
  });
});

function makeAudit(over: Partial<DecideAuditRecord> = {}): DecideAuditRecord {
  return {
    id: `s::g1`,
    sessionId: "sess-1",
    groupKey: "g1",
    frameCount: 3,
    candidateCount: 1,
    systemPromptVersion: "1",
    promptText: "user prompt",
    mediaHashes: [{ type: "image", sha256: "a".repeat(64), mime: "image/jpeg" }],
    params: { temperature: 0.0, max_tokens: 1200 },
    rawReply: '{"isHighlight":true}',
    verdicts: { isHighlight: true },
    timings: { elapsedMs: 12.3 },
    fallback: false,
    replayable: true,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe("decide_audit persistence (SqliteDb)", () => {
  it("upserts one row per (sessionId, groupKey) and indexes by group key", async () => {
    const db = new SqliteDb(":memory:");
    await db.saveDecideAudit(makeAudit());
    expect(await db.decideAuditForGroup("sess-1", "g1")).toMatchObject({
      sessionId: "sess-1",
      groupKey: "g1",
      frameCount: 3,
      rawReply: '{"isHighlight":true}',
      replayable: true,
    });

    // Same (sessionId, groupKey) upserts to exactly one row (one per frame group).
    await db.saveDecideAudit(makeAudit({ frameCount: 9, createdAt: new Date().toISOString() }));
    const rows = await db.listDecideAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0].frameCount).toBe(9);

    // A different group key is a distinct row.
    await db.saveDecideAudit(makeAudit({ id: "s::g2", groupKey: "g2", createdAt: new Date().toISOString() }));
    expect(await db.listDecideAudits()).toHaveLength(2);

    await db.close();
  });

  it("enforces the retention cap (keeps newest N)", async () => {
    const db = new SqliteDb(":memory:");
    for (let i = 1; i <= 5; i++) {
      await db.saveDecideAudit(
        makeAudit({ id: `s::g${i}`, groupKey: `g${i}`, createdAt: new Date(Date.UTC(2026, 0, i)).toISOString() })
      );
    }
    expect(await db.listDecideAudits()).toHaveLength(5);
    await db.trimDecideAudits(3);
    const remaining = await db.listDecideAudits();
    expect(remaining).toHaveLength(3);
    const keys = remaining.map((r) => r.groupKey).sort();
    expect(keys).toEqual(["g3", "g4", "g5"]);

    await db.close();
  });
});
