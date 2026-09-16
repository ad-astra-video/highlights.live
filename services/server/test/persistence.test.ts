import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteDb, type Db } from "../src/db";
import { Store } from "../src/store";

// Durable persistence across a "restart": write through the Store + Db, close,
// reopen the same on-disk DB file, and confirm jobs + highlights come back.
// This is the core acceptance criterion for ADAAAA-22 ("stateful data must
// survive restarts").

function tempDbFile(): { file: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), `hl-persist-`));
  return { file: path.join(dir, "highlights.db"), dir };
}

async function reopen(dbFile: string): Promise<Db> {
  const db = new SqliteDb(dbFile);
  await db.migrate();
  return db;
}

describe("persistence: jobs + highlights survive restarts", () => {
  it("round-trips job + highlight through a reopen of the DB file", async () => {
    const { file, dir } = tempDbFile();

    // First "boot".
    let db: Db = await reopen(file);
    let store = new Store(db);
    await store.load();
    const job = await store.createJob({ source: "file", sourceUrl: "/tmp/v.mp4", gameHint: "valorant" });
    await store.patchJob(job.id, { status: "active" });
    await store.addHighlight({
      id: "h-persist",
      jobId: job.id,
      ownerId: "user-1",
      clipUri: "/clips/h-persist.mp4",
      start: 2,
      end: 6,
      score: 88,
      status: "accepted",
      createdAt: new Date().toISOString(),
    });
    await db.close();
    store = null as any;

    // Simulated process restart: reopen the same file, fresh Store.
    db = await reopen(file);
    store = new Store(db);
    await store.load();

    const restoredJob = store.getJob(job.id);
    expect(restoredJob).toBeDefined();
    expect(restoredJob!.status).toBe("active");
    expect(restoredJob!.gameHint).toBe("valorant");
    expect(store.highlightsForJob(job.id)).toHaveLength(1);
    expect(store.getHighlight("h-persist")!.status).toBe("accepted");

    // The DB row itself is independently re-readable.
    expect((await db.getJob(job.id))!.ownerId).toBeUndefined();
    expect((await db.getHighlight("h-persist"))!.clipUri).toBe("/clips/h-persist.mp4");

    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not duplicate rows on a second load (idempotent hydration)", async () => {
    const { file, dir } = tempDbFile();
    let db: Db = await reopen(file);
    let store = new Store(db);
    await store.load();
    const job = await store.createJob({ source: "browser" });
    await store.addHighlight({
      id: "h-hyd",
      jobId: job.id,
      clipUri: "",
      start: 0,
      end: 2,
      score: 70,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    await db.close();

    db = await reopen(file);
    store = new Store(db);
    await store.load();
    await store.load(); // repeated load must be idempotent
    expect([...store.allHighlights()]).toHaveLength(1);
    expect(store.highlightsForJob(job.id)).toHaveLength(1);
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
