import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { buildTestApp } from "./helpers";
import { RejectedClipCleanup } from "../src/cleanup";

// TTL window used by these tests (1s). "old" clips are rejected 10 minutes ago
// (well past TTL), "fresh" clips are rejected now (inside the grace window).
const TTL_MS = 1000;
const oldIso = () => new Date(Date.now() - 10 * 60_000).toISOString();
const freshIso = () => new Date().toISOString();

/** Create a highlight whose clipUri maps to a real on-disk file in dataDir/clips. */
async function seed(store: any, dataDir: string, id: string, over: Record<string, any> = {}) {
  const clipFile = path.join(dataDir, "clips", `${id}.mp4`);
  mkdirSync(path.dirname(clipFile), { recursive: true });
  writeFileSync(clipFile, `fake-mp4-bytes-${id}`);
  await store.addHighlight({
    id,
    ownerId: "u1",
    jobId: "j1",
    clipUri: `/clips/${id}.mp4`,
    start: 1,
    end: 5,
    eventType: "KILL",
    score: 90,
    reason: "t",
    status: over.status ?? "pending",
    createdAt: oldIso(),
    rejectedAt: over.rejectedAt,
  });
  return clipFile;
}

describe("rejected-clip TTL sweep (ADAAAA-5168)", () => {
  it("selects ONLY rejected clips aged >= TTL as candidates (accepted/pending/fresh never)", async () => {
    const { app, store, cfg } = await buildTestApp({ REJECTED_CLIP_TTL_MS: String(TTL_MS) });
    await seed(store, cfg.dataDir, "hl-accepted", { status: "accepted" });
    await seed(store, cfg.dataDir, "hl-pending", { status: "pending" });
    await seed(store, cfg.dataDir, "hl-rej-old", { status: "rejected", rejectedAt: oldIso() });
    await seed(store, cfg.dataDir, "hl-rej-fresh", { status: "rejected", rejectedAt: freshIso() });

    const cleanup = new RejectedClipCleanup(store, cfg);
    const report = await cleanup.run(new Date(), true /* dry-run */);

    // Exact purge filter: candidates is only the expired rejected clip.
    expect(report.candidates).toBe(1);
    expect(store.rejectedExpired(TTL_MS).map((h: any) => h.id)).toEqual(["hl-rej-old"]);
    await app.close();
  });

  it("hard-deletes DB row + storage object for an expired rejected clip and reports bytes", async () => {
    const { app, store, cfg } = await buildTestApp({ REJECTED_CLIP_TTL_MS: String(TTL_MS) });
    const clipFile = await seed(store, cfg.dataDir, "hl-rej-old", { status: "rejected", rejectedAt: oldIso() });
    await seed(store, cfg.dataDir, "hl-accepted", { status: "accepted" });
    expect(existsSync(clipFile)).toBe(true);

    const cleanup = new RejectedClipCleanup(store, cfg);
    const report = await cleanup.run(new Date(), false);

    expect(report.purged).toBe(1);
    expect(report.objectsDeleted).toBe(1);
    expect(report.bytesReclaimed).toBeGreaterThan(0);
    expect(store.getHighlight("hl-rej-old")).toBeUndefined();
    // Storage object gone -> /clips/<id>.mp4 resolves as gone, not a broken ref.
    expect(existsSync(clipFile)).toBe(false);
    // The accepted clip is untouched.
    expect(store.getHighlight("hl-accepted")).toBeDefined();
    expect(existsSync(path.join(cfg.dataDir, "clips", "hl-accepted.mp4"))).toBe(true);
    await app.close();
  });

  it("dry-run reports candidates + reclaimable bytes and deletes nothing", async () => {
    const { app, store, cfg } = await buildTestApp({ REJECTED_CLIP_TTL_MS: String(TTL_MS) });
    const clipFile = await seed(store, cfg.dataDir, "hl-rej-old", { status: "rejected", rejectedAt: oldIso() });

    const cleanup = new RejectedClipCleanup(store, cfg);
    const report = await cleanup.run(new Date(), true);

    expect(report.dryRun).toBe(true);
    expect(report.candidates).toBe(1);
    expect(report.purged).toBe(0);
    expect(report.objectsDeleted).toBe(0);
    expect(report.bytesReclaimed).toBeGreaterThan(0); // reclaimable, not yet reclaimed
    expect(store.getHighlight("hl-rej-old")).toBeDefined();
    expect(existsSync(clipFile)).toBe(true);
    await app.close();
  });

  it("undo guard: reject -> accept within the window restores the clip and cancels deletion", async () => {
    const { app, store, cfg } = await buildTestApp({ REJECTED_CLIP_TTL_MS: String(TTL_MS) });
    const clipFile = await seed(store, cfg.dataDir, "hl-undo", { status: "rejected", rejectedAt: oldIso() });

    // Undo within the window: accept the clip back (clears rejectedAt).
    const restored = await store.reviewHighlight("hl-undo", "accepted");
    expect(restored.status).toBe("accepted");
    expect(restored.rejectedAt).toBeUndefined();

    const cleanup = new RejectedClipCleanup(store, cfg);
    const report = await cleanup.run(new Date(), false);

    // Accepted (even with an old original rejectedAt) is never a purge target.
    expect(report.candidates).toBe(0);
    expect(report.purged).toBe(0);
    expect(store.getHighlight("hl-undo")).toBeDefined();
    expect(existsSync(clipFile)).toBe(true);
    await app.close();
  });

  it("idempotent: a second sweep purges nothing already gone", async () => {
    const { app, store, cfg } = await buildTestApp({ REJECTED_CLIP_TTL_MS: String(TTL_MS) });
    await seed(store, cfg.dataDir, "hl-rej-old", { status: "rejected", rejectedAt: oldIso() });

    const cleanup = new RejectedClipCleanup(store, cfg);
    const first = await cleanup.run(new Date(), false);
    const second = await cleanup.run(new Date(), false);

    expect(first.purged).toBe(1);
    expect(second.candidates).toBe(0);
    expect(second.purged).toBe(0);
    await app.close();
  });

  it("reviewing a clip already purged does not resurrect or error loudly", async () => {
    const { app, store, cfg } = await buildTestApp({ REJECTED_CLIP_TTL_MS: String(TTL_MS) });
    await seed(store, cfg.dataDir, "hl-rej", { status: "rejected", rejectedAt: oldIso() });
    const cleanup = new RejectedClipCleanup(store, cfg);
    await cleanup.run(new Date(), false);

    // Post-purge review of the deleted id fails cleanly (no dangling row to reach).
    await expect(store.reviewHighlight("hl-rej", "accepted")).rejects.toThrow("no highlight");
    await app.close();
  });
});
