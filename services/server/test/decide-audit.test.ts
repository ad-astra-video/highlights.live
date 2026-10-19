import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { SqliteDb } from "../src/db";
import {
  decideAuditRecordFromDescriptor,
  recordDecideAudit,
  enforceDecideAuditRetention,
  redactSecrets,
  countSecretMatches,
  dedupeMediaHashes,
  decideAuditRecordBytes,
} from "../src/decide-audit";
import { buildTestApp } from "./helpers";

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

  // --- ADAAAA-7029 Increment 3: privacy -----------------------------------
  it("redacts credentials from prompt/reply so no secret enters a record", () => {
    const dirty = {
      ...descriptor,
      sessionId: "sess-secret",
      groupKey: "g-secret",
      promptText:
        'System prompt with an api_key="sk-live-abcdef123456" and Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123 and a ghp_abcdefghijklmnop token.',
      rawReply: '{"isHighlight":true,"auth":"Bearer abcdefghijklmnopqrs"}',
      params: { temperature: 0.0, clientSecret: "sk-secret-12345678" },
      verdicts: { isHighlight: true, note: "token=abcdefghijklmnop" },
    };
    const rec = decideAuditRecordFromDescriptor(dirty)!;
    // No credential pattern survives in any textual / JSON field.
    expect(countSecretMatches(rec)).toBe(0);
    expect(rec.promptText).not.toMatch(/sk-|Bearer|ghp_|eyJ/);
    expect(rec.rawReply).not.toMatch(/Bearer/);
    // Media content refs (data) are untouched / non-secret; still intact.
    expect(rec.mediaHashes).toHaveLength(1);
    expect(rec.promptText).toContain("[REDACTED]");
  });

  it("redactSecrets handles null/non-string gracefully", () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeNull();
    expect(redactSecrets("plain text no secret")).toBe("plain text no secret");
  });

  // --- ADAAAA-7029 Increment 3: retention byte cap + dedupe ----------------
  it("enforces the byte cap by dropping oldest rows under the budget", async () => {
    const db = new SqliteDb(":memory:");
    // Two records, same session, distinct groups. Give one a very large reply
    // so the byte totals differ.
    const big = {
      ...descriptor,
      groupKey: "gBig",
      rawReply: "x".repeat(2000),
    };
    const small = {
      ...descriptor,
      groupKey: "gSmall",
      createdAt: 1770000001.0,
      rawReply: "tiny",
    };
    await db.saveDecideAudit(decideAuditRecordFromDescriptor(big)!);
    await db.saveDecideAudit(decideAuditRecordFromDescriptor(small)!);
    const before = await db.listDecideAudits();
    const total = before.reduce((n, r) => n + decideAuditRecordBytes(r), 0);
    expect(total).toBeGreaterThan(0);

    // A byte budget just under the small record's size must drop the big
    // (older) record and keep the newer small one.
    await enforceDecideAuditRetention(db, 0, decideAuditRecordBytes(decideAuditRecordFromDescriptor(small)!));
    const after = await db.listDecideAudits();
    expect(after).toHaveLength(1);
    expect(after[0].groupKey).toBe("gSmall");
    await db.close();
  });

  it("dedupes media hashes content-addressed across groups", () => {
    const a = dedupeMediaHashes([
      { sha256: "h".repeat(64), mime: "image/jpeg", type: "image" },
      { sha256: "h".repeat(64), mime: "image/jpeg", type: "image" },
      { sha256: "i".repeat(64), mime: "image/jpeg", type: "image" },
    ]);
    expect(a).toHaveLength(2);
    expect(a[0].sha256).toBe("h".repeat(64));
    expect(a[1].sha256).toBe("i".repeat(64));
  });

  // --- ADAAAA-7029 Increment 3: access control -----------------------------
  it("serves the decide-audit surface to a full admin and an admin_readonly token, but not a non-owner user", async () => {
    const app = await buildTestApp();
    // Register two users.
    const regA = await app.app.inject({ method: "POST", url: "/auth/register", payload: { email: "owner@test.local", password: "pw123456" } });
    const regB = await app.app.inject({ method: "POST", url: "/auth/register", payload: { email: "other@test.local", password: "pw123456" } });
    expect(regA.statusCode).toBe(200);
    expect(regB.statusCode).toBe(200);
    const ownerToken = regA.json().token as string;
    const otherToken = regB.json().token as string;

    // Create a job owned by the first user.
    const job = await app.store.createJob({ ownerId: regA.json().user.id, source: "file", sourceUrl: "/tmp/v.mp4" });

    // Ingest a decide audit record for the job.
    await app.db.saveDecideAudit(
      decideAuditRecordFromDescriptor({ ...descriptor, jobId: job.id, sessionId: "sess-ac", groupKey: "g-ac" })!
    );

    // Owner reads own job's audit.
    const owner = await app.app.inject({ method: "GET", url: `/jobs/${job.id}/decide-audit`, headers: { authorization: `Bearer ${ownerToken}` } });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().audits).toHaveLength(1);

    // A non-owner regular user is forbidden.
    const other = await app.app.inject({ method: "GET", url: `/jobs/${job.id}/decide-audit`, headers: { authorization: `Bearer ${otherToken}` } });
    expect(other.statusCode).toBe(403);

    // Full admin reads any job.
    const adminLogin = await app.app.inject({ method: "POST", url: "/auth/login", payload: { email: "admin@test.local", password: "adminpass" } });
    const adminToken = adminLogin.json().token as string;
    const admin = await app.app.inject({ method: "GET", url: `/jobs/${job.id}/decide-audit`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(admin.statusCode).toBe(200);

    // A standalone admin_readonly service token reads any job (board read granule).
    const roToken = jwt.sign({ sub: "dev-readonly", email: "dev@adastra", role: "admin_readonly" }, app.cfg.jwtSecret, { expiresIn: "1h" });
    const ro = await app.app.inject({ method: "GET", url: `/jobs/${job.id}/decide-audit`, headers: { authorization: `Bearer ${roToken}` } });
    expect(ro.statusCode).toBe(200);
    expect(ro.json().audits).toHaveLength(1);

    await app.app.close();
  });
});
