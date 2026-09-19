import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteDb, type Db } from "../../server/src/db";
import { WaitlistAllocator } from "../src/allocator";

async function testDb(): Promise<Db> {
  const dir = mkdtempSync(path.join(tmpdir(), "hl-alloc-"));
  const db = new SqliteDb(path.join(dir, "test.db"));
  await db.migrate();
  return db;
}

const mk = (db: Db, publicBaseUrl = "http://127.0.0.1:3000", batchSize = 50, maxAttempts = 3) =>
  new WaitlistAllocator({ db, batchSize, maxAttempts, publicBaseUrl });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("waitlist allocator (ADAAAA-2555)", () => {
  it("allocates new signups in FIFO order and enqueues one invite each", async () => {
    const db = await testDb();
    // Distinct, increasing created_at so FIFO order is unambiguous.
    await db.addWaitlistEmail("first@example.com");
    await sleep(6);
    await db.addWaitlistEmail("second@example.com");
    await sleep(6);
    await db.addWaitlistEmail("third@example.com");

    const alloc = mk(db);
    const res = await alloc.tick();

    expect(res.suppressed).toBe(false);
    expect(res.allocated).toBe(3);
    expect(res.sendIds).toHaveLength(3);

    // FIFO: the invite sends were created in signup order (oldest first).
    const sentTo: string[] = [];
    for (const id of res.sendIds) sentTo.push((await db.getEmailSend(id))!.toEmail);
    expect(sentTo).toEqual(["first@example.com", "second@example.com", "third@example.com"]);

    // Each queued send carries the shared invite copy (with invite link) and
    // enters the standard queue lifecycle (status queued => worker sends/retries).
    const first = (await db.getEmailSend(res.sendIds[0]))!;
    expect(first.subject).toContain("invited");
    expect(first.body).toContain("http://127.0.0.1:3000/auth");
    expect(first.status).toBe("queued");
    expect(first.maxAttempts).toBe(3);

    // Claimed signups are flipped to invited (allocated exactly once); a
    // second tick does not re-allocate them.
    expect((await db.getWaitlist("first@example.com"))!.status).toBe("invited");
    const again = await alloc.tick();
    expect(again.allocated).toBe(0);
    expect(again.sendIds).toHaveLength(0);
  });

  it("respects the admin gate: closed suppresses, clearing resumes", async () => {
    const db = await testDb();
    await db.addWaitlistEmail("gated@example.com");

    await db.setWaitlistGate(false, "admin@test.local");
    const alloc = mk(db);
    const suppressed = await alloc.tick();
    expect(suppressed.suppressed).toBe(true);
    expect(suppressed.allocated).toBe(0);
    expect(suppressed.sendIds).toHaveLength(0);
    // Signup is NOT consumed while the gate is closed.
    expect((await db.getWaitlist("gated@example.com"))!.status).toBe("waitlisted");

    // Gate state persisted and reads back.
    const gate = await db.getWaitlistGate();
    expect(gate.allocationOpen).toBe(false);
    expect(gate.setBy).toBe("admin@test.local");

    // Clearing resumes polling + allocation.
    await db.setWaitlistGate(true, "admin@test.local");
    const resumed = await alloc.tick();
    expect(resumed.suppressed).toBe(false);
    expect(resumed.allocated).toBe(1);
    expect((await db.getWaitlist("gated@example.com"))!.status).toBe("invited");
    expect((await db.getEmailSend(resumed.sendIds[0]))!.toEmail).toBe("gated@example.com");
  });

  it("defaults to open when the gate was never set", async () => {
    const db = await testDb();
    await db.addWaitlistEmail("defaultopen@example.com");
    expect((await db.getWaitlistGate()).allocationOpen).toBe(true);
    const res = await mk(db).tick();
    expect(res.allocated).toBe(1);
  });

  it("allocates only up to batchSize per tick, oldest first", async () => {
    const db = await testDb();
    for (const e of ["a@example.com", "b@example.com", "c@example.com"]) {
      await db.addWaitlistEmail(e);
      await sleep(4);
    }
    const alloc = mk(db, "http://x", 2);
    const res = await alloc.tick();
    expect(res.allocated).toBe(2);
    expect(res.sendIds).toHaveLength(2);
    // Oldest two taken; one (newest) remains for a later tick.
    const left = await db.listWaitlist();
    expect(left.filter((w) => w.status === "waitlisted")).toHaveLength(1);
  });
});
