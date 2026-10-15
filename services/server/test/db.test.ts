import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { SqliteDb, type MediaSession } from "../src/db";
import { Store } from "../src/store";

const require = createRequire(import.meta.url);
// Load node:sqlite at runtime (Vite's external list doesn't include it).
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

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
});

describe("jobs.record robustness — a single malformed row must not block boot (ADAAAA-6713)", () => {
  it("Store.load() survives a corrupt job row and skips it", async () => {
    // On-disk SQLite so we can inject a mid-write/corrupt record directly.
    const dir = mkdtempSync(join(tmpdir(), "hl-db-"));
    const file = join(dir, "jobs.db");
    const db = new SqliteDb(file);
    const store = new Store(db);

    // One well-formed job.
    const good = await store.createJob({ source: "file", sourceUrl: "x.mp4" });

    // Inject a malformed job record straight into the jobs table, simulating a
    // row caught mid-write (the exact failure mode from the ADAAAA-6707 deploy).
    const raw = new DatabaseSync(file);
    raw
      .prepare(
        "INSERT INTO jobs (id, record, owner_id, status, created_at) VALUES (?,?,?,?,?)"
      )
      .run("corrupt-job", "{ this is not valid json", null, "active", new Date().toISOString());
    raw.close();

    // Boot path: hydrate the in-memory working set from a store that must not
    // throw on the bad row.
    const bootStore = new Store(db);
    await expect(bootStore.load()).resolves.toBeUndefined();

    // The corrupt row was skipped; the good job is present.
    expect(bootStore.getJob("corrupt-job")).toBeUndefined();
    expect(bootStore.getJob(good.id)).toEqual(good);

    // listJobs (used by /health monitoring) also skips the bad row instead of
    // throwing.
    const jobs = await db.listJobs();
    expect(jobs.map((j) => j.id)).toEqual([good.id]);

    // Single-row get for the corrupt id is a safe undefined, not a throw.
    await expect(db.getJob("corrupt-job")).resolves.toBeUndefined();

    await db.close();
  });
});
