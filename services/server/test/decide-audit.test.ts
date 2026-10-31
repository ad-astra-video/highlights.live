import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { SqliteDb } from "../src/db";
import {
  decideAuditIdentity,
  decideAuditRecordFromDescriptor,
  recordDecideAudit,
} from "../src/decide-audit";
import { confirmAuditDescriptor, type ConfirmDecision } from "../src/analyzer";
import { DirectAdapter } from "../src/livepeer-adapter";
import { loadConfig } from "../src/config";

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
    // ADAAAA-7626: the stored session identity IS the job identity, which keeps
    // the table's UNIQUE(session_id, group_key) constraint job-scoped.
    expect(rec.sessionId).toBe("job-1");
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
    expect((await db.decideAuditForGroup("job-1", "g7"))!.jobId).toBe("job-1");

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

// ADAAAA-7626: the audit row identity is the JOB, not the shared "job" session
// sentinel the adapter used to hardcode on every decide payload.
describe("decide_audit job-scoped identity (ADAAAA-7626, AC2)", () => {
  it("derives the row identity from the jobId, falling back to sessionId", () => {
    expect(decideAuditIdentity({ jobId: "job-a", sessionId: "job", groupKey: "g7" })).toEqual({
      identity: "job-a",
      jobId: "job-a",
      groupKey: "g7",
    });
    // Legacy descriptor with no job identity keeps the session-scoped behaviour.
    expect(decideAuditIdentity({ sessionId: "sess-1", groupKey: "g7" })).toEqual({
      identity: "sess-1",
      jobId: null,
      groupKey: "g7",
    });
  });

  it("two jobs deciding the same group key produce two disjoint rows (no overwrite)", async () => {
    const db = new SqliteDb(":memory:");
    await recordDecideAudit(
      db,
      { ...descriptor, jobId: "job-a", sessionId: "job-a", groupKey: "g7", frameCount: 3, promptText: "prompt A" },
      0
    );
    await recordDecideAudit(
      db,
      { ...descriptor, jobId: "job-b", sessionId: "job-b", groupKey: "g7", frameCount: 7, promptText: "prompt B" },
      0
    );

    const a = await db.decideAuditsForJob("job-a");
    const b = await db.decideAuditsForJob("job-b");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    // Disjoint: different row ids, and neither row is attributable to the other job.
    expect(a[0].id).not.toBe(b[0].id);
    expect(a[0].jobId).toBe("job-a");
    expect(b[0].jobId).toBe("job-b");
    // The later job's write did NOT overwrite the earlier job's detail.
    expect(a[0].frameCount).toBe(3);
    expect(a[0].promptText).toBe("prompt A");
    expect(b[0].frameCount).toBe(7);
    expect(b[0].promptText).toBe("prompt B");
    expect(await db.listDecideAudits()).toHaveLength(2);

    await db.close();
  });

  it("a Stage-1 row appears for its own job and no other job's read", async () => {
    const db = new SqliteDb(":memory:");
    await recordDecideAudit(db, { ...descriptor, jobId: "job-s1", sessionId: "job-s1", groupKey: "g12" }, 0);
    const rows = await db.decideAuditsForJob("job-s1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId: "job-s1", groupKey: "g12", replayable: true });
    expect(rows[0].promptText).toContain("system");
    expect(rows[0].mediaHashes).toHaveLength(1);
    expect(rows[0].timings).toEqual({ elapsedMs: 8.1 });
    expect(await db.decideAuditsForJob("job-other")).toHaveLength(0);
    await db.close();
  });
});

// ADAAAA-7626: a Stage-2 confirm row must describe itself (AC3).
describe("confirm audit descriptor (ADAAAA-7626, AC3)", () => {
  const frame = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

  const confirm: ConfirmDecision = {
    enabled: true,
    goalConfirmed: "confirmed_goal",
    confidence: 0.9,
    reason: "ball in net",
    evidence: { ballInNet: true },
    stage1Disagreed: false,
    corroborated: true,
    corroborationSource: "scoreboard",
    decision: { isHighlight: true, score: 85, eventType: "GOAL", outcome: "scoring_play" },
  };

  const desc = confirmAuditDescriptor(
    { jobId: "job-c" },
    {
      timestamp: 342.5,
      frames: [
        { role: "full", base64: frame("frame-1") },
        { role: "full", base64: frame("frame-2") },
      ],
      elapsedMs: 1234,
      confirm,
    }
  );

  it("records timestamp / frameCount / candidateCount / mediaHashes / elapsedMs", () => {
    expect(desc.jobId).toBe("job-c");
    expect(desc.sessionId).toBe("job-c");
    expect(desc.groupKey).toBe("g114:confirm"); // floor(342.5 / 3) = 114
    expect(desc.timestamp).toBe(342.5);
    expect(desc.frameCount).toBe(2);
    expect(desc.candidateCount).toBe(1);
    expect(desc.timings).toEqual({ elapsedMs: 1234 });
    const hashes = desc.mediaHashes as { sha256: string; type: string }[];
    expect(hashes).toHaveLength(2);
    expect(hashes[0].type).toBe("image");
    // Content-addressed: sha256 of the DECODED frame bytes.
    expect(hashes[0].sha256).toBe(sha("frame-1"));
    expect(hashes[1].sha256).toBe(sha("frame-2"));
    expect((desc.verdicts as any).runConfirmationPass).toBe(true);
  });

  it("persists the confirm row with its timestamp and frame count for its job", async () => {
    const db = new SqliteDb(":memory:");
    await recordDecideAudit(db, desc, 0);
    const rows = await db.decideAuditsForJob("job-c");
    expect(rows).toHaveLength(1);
    expect(rows[0].timestamp).toBe(342.5);
    expect(rows[0].frameCount).toBe(2);
    expect(rows[0].candidateCount).toBe(1);
    expect(rows[0].timings).toEqual({ elapsedMs: 1234 });
    expect(rows[0].groupKey).toBe("g114:confirm");
    await db.close();
  });
});

// ADAAAA-7626 root-cause guard: the adapter is the ONLY place the audit identity
// enters the decide payload, and it used to hardcode sessionId "job" on every
// job's decide/confirm call. Without this test the "two jobs, one row" bug can
// silently come back even while the db-level identity tests stay green.
describe("adapter decide payload identity (ADAAAA-7626, AC2)", () => {
  const cfg = loadConfig({ PERCEIVE_URL: "http://p", DECIDE_URL: "http://d" });
  afterEach(() => vi.restoreAllMocks());

  const stubFetch = (body: object = {}) =>
    vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status: 200 }));

  const lastBody = (fetchMock: any) => JSON.parse((fetchMock.mock.calls[0] as any)[1].body);

  it("sends the job as sessionId + jobId + groupKey on decide (two jobs => two identities)", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new DirectAdapter(cfg);
    await adapter.decide(
      { eventType: "GOAL", trackCount: 1, maxVelocity: 1, ocrHits: 0 },
      { jobId: "job-a", groupKey: "g7" }
    );
    const a = lastBody(fetchMock);
    expect(a.sessionId).toBe("job-a");
    expect(a.jobId).toBe("job-a");
    expect(a.groupKey).toBe("g7");

    fetchMock.mockClear();
    await adapter.decide(
      { eventType: "GOAL", trackCount: 1, maxVelocity: 1, ocrHits: 0 },
      { jobId: "job-b", groupKey: "g7" }
    );
    const b = lastBody(fetchMock);
    // Same in-video group key, DIFFERENT audit identity: the decide service now
    // emits a descriptor the server indexes as two disjoint rows.
    expect(b.groupKey).toBe(a.groupKey);
    expect(b.sessionId).toBe("job-b");
    expect(b.sessionId).not.toBe(a.sessionId);
  });

  it("sends the job as sessionId on confirm and on the merged group review", async () => {
    const fetchMock = stubFetch({ verdicts: [] });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new DirectAdapter(cfg);
    await adapter.confirm(
      { eventType: "GOAL", timestamp: 12.5, gameHint: "", stage1: { isHighlight: true } } as any,
      { jobId: "job-c" }
    );
    expect(lastBody(fetchMock).sessionId).toBe("job-c");

    fetchMock.mockClear();
    await adapter.decideGroup({ candidates: [{ eventType: "GOAL", timestamp: 12.5 } as any], jobId: "job-c", groupKey: "g4" });
    const group = lastBody(fetchMock);
    expect(group.sessionId).toBe("job-c");
    expect(group.jobId).toBe("job-c");
    expect(group.groupKey).toBe("g4");
  });

  it("keeps the pre-existing identity when a caller passes no jobId (no regression)", async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new DirectAdapter(cfg);
    await adapter.decide({ eventType: "GOAL", trackCount: 1, maxVelocity: 1, ocrHits: 0 });
    // DirectAdapter's dev session is unchanged for job-less callers.
    expect(lastBody(fetchMock).sessionId).toBe("local-dev");
  });
});
