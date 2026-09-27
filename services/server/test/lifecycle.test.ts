import { describe, it, expect } from "vitest";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { buildTestApp, type TestApp } from "./helpers";
import { selectRejectedCandidates, runRejectSweep, clipStoragePath } from "../src/lifecycle";
import { Store } from "../src/store";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

async function freshApp(): Promise<TestApp> {
  return buildTestApp({ REJECTED_CLIP_TTL_MS: String(DAY), REJECTED_CLIP_SWEEP_INTERVAL_MS: String(HOUR) });
}

/** Seed a highlight with a controlled rejectedAt plus a real 100 KB storage
 * object so the sweep reclaims real bytes. */
async function seed(
  store: Store,
  cfg: any,
  id: string,
  opts: { status: string; rejectedAt?: string; clipUri?: string }
) {
  await store.addHighlight({
    id,
    ownerId: "u1",
    jobId: "job-" + id,
    clipUri: opts.clipUri ?? `/clips/${id}.mp4`,
    start: 0,
    end: 5,
    score: 90,
    reason: "seed",
    status: opts.status as any,
    rejectedAt: opts.rejectedAt,
    createdAt: new Date().toISOString(),
  } as any);
  const p = clipStoragePath(cfg, opts.clipUri ?? `/clips/${id}.mp4`);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, Buffer.alloc(1024 * 100, 1)); // 100 KB
}

describe("rejected-clip TTL lifecycle (ADAAAA-5163)", () => {
  const now = new Date();

  it("reject marks status=rejected + rejectedAt; reject->accept clears it (undo guard)", async () => {
    const s = new Store();
    await s.addHighlight({
      id: "undo1",
      jobId: "j-undo1",
      clipUri: "/clips/undo1.mp4",
      start: 0,
      end: 2,
      score: 70,
      status: "pending" as any,
      createdAt: new Date().toISOString(),
    } as any);

    const rej = await s.reviewHighlight("undo1", "rejected");
    expect(rej.status).toBe("rejected");
    expect(rej.rejectedAt).toBeTruthy();

    const acc = await s.reviewHighlight("undo1", "accepted");
    expect(acc.status).toBe("accepted");
    expect(acc.rejectedAt).toBeUndefined();
  });

  it("purge candidates are EXACTLY rejected && age>=TTL (0 non-targets)", async () => {
    const app = await freshApp();
    try {
      const { store, cfg } = app;
      await seed(store, cfg, "old-rej", { status: "rejected", rejectedAt: new Date(now.getTime() - 2 * DAY).toISOString() });
      await seed(store, cfg, "fresh-rej", { status: "rejected", rejectedAt: new Date().toISOString() });
      await seed(store, cfg, "acc", { status: "accepted" });
      await seed(store, cfg, "pend", { status: "pending" });

      const cands = selectRejectedCandidates(store, cfg, now).map((c) => c.id).sort();
      expect(cands).toEqual(["old-rej"]);
    } finally {
      await app.app.close();
    }
  });

  it("dry-run reports candidates/bytes and deletes nothing", async () => {
    const app = await freshApp();
    try {
      const { store, cfg } = app;
      await seed(store, cfg, "dry1", { status: "rejected", rejectedAt: new Date(now.getTime() - 2 * DAY).toISOString() });
      const report = await runRejectSweep(store, cfg, { now, dryRun: true });
      expect(report.candidates).toBe(1);
      expect(report.dryRun).toBe(true);
      expect(report.rowsRemoved).toBe(0);
      expect(report.objectsRemoved).toBe(0);
      expect(store.getHighlight("dry1")).toBeDefined();
    } finally {
      await app.app.close();
    }
  });

  it("run-mode hard-deletes DB row + storage object and reports bytes reclaimed", async () => {
    const app = await freshApp();
    try {
      const { store, cfg } = app;
      await seed(store, cfg, "purge1", { status: "rejected", rejectedAt: new Date(now.getTime() - 3 * DAY).toISOString() });
      const filePath = clipStoragePath(cfg, "/clips/purge1.mp4");
      const before = (await stat(filePath)).size;

      const report = await runRejectSweep(store, cfg, { now });
      expect(report.candidates).toBe(1);
      expect(report.rowsRemoved).toBe(1);
      expect(report.objectsRemoved).toBe(1);
      expect(report.bytesReclaimed).toBe(before);
      expect(store.getHighlight("purge1")).toBeUndefined();
      await expect(stat(filePath)).rejects.toThrow();
      // DB row is gone too (persistence).
      expect(await app.db.getHighlight("purge1")).toBeUndefined();
    } finally {
      await app.app.close();
    }
  });

  it("undo within window cancels pending deletion (concurrent-safety)", async () => {
    const app = await freshApp();
    try {
      const { store, cfg } = app;
      await seed(store, cfg, "undo-win", { status: "rejected", rejectedAt: new Date(now.getTime() - 2 * DAY).toISOString() });
      await store.reviewHighlight("undo-win", "accepted");
      const cands = selectRejectedCandidates(store, cfg, now);
      expect(cands.some((c) => c.id === "undo-win")).toBe(false);
      const report = await runRejectSweep(store, cfg, { now });
      expect(report.candidates).toBe(0);
      expect(store.getHighlight("undo-win")).toBeDefined();
      await expect(stat(clipStoragePath(cfg, "/clips/undo-win.mp4"))).resolves.toBeDefined();
    } finally {
      await app.app.close();
    }
  });
});
