import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteDb, type MediaSession } from "../src/db";
import { Store } from "../src/store";
import { buildMediaNodeReport } from "../src/media-node";
import { isStaleMediaSession, reconcileStaleMediaSessions } from "../src/media-session-reconcile";
import { buildTestApp } from "./helpers";

// ADAAAA-7764: a `media_sessions` row must stop reading `active` the moment its
// owning job is terminal. The box carried 13 rows reading `active` on FAILED
// jobs, which the deploy gate ([ADAAAA-7750]) read as 13 live screen shares.

function session(jobId: string, over: Partial<MediaSession> = {}): MediaSession {
  const at = new Date().toISOString();
  return {
    jobId,
    sessionId: `sess-${jobId}`,
    streamId: jobId,
    wsUrl: "ws://media.test/ingest",
    mediaOrigin: "http://media:4070",
    nodeId: "media-0",
    status: "active",
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

function tmpDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "hl-media-session-"));
  const db = new SqliteDb(path.join(dir, "test.db"));
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("media_sessions terminal-transition settle (ADAAAA-7764)", () => {
  it("settles the row to `closed` on done / failed / cancelled and keeps it (cost join preserved)", async () => {
    const { db, cleanup } = tmpDb();
    try {
      const store = new Store(db);
      for (const terminal of ["done", "failed", "cancelled"] as const) {
        const id = `job-${terminal}`;
        await store.createJob({ id, ownerId: "u1", source: "browser" });
        await db.setMediaSession(session(id));
        await store.patchJob(id, { status: "active" });
        // In flight: the row is still a live session.
        expect((await db.getMediaSession(id))?.status).toBe("active");

        await store.patchJob(id, { status: terminal });

        const row = await db.getMediaSession(id);
        expect(row, "row is kept, not deleted").toBeTruthy();
        expect(row!.status).toBe("closed");
        // The attribution fields the per-node cost join reads are untouched.
        expect(row!.nodeId).toBe("media-0");
        expect(row!.sessionId).toBe(`sess-${id}`);
      }
    } finally {
      cleanup();
    }
  });

  it("leaves the row `active` while the job is still in flight", async () => {
    const { db, cleanup } = tmpDb();
    try {
      const store = new Store(db);
      const j = await store.createJob({ id: "job-running", ownerId: "u1", source: "browser" });
      await db.setMediaSession(session(j.id));
      for (const status of ["active", "extracting", "analyzing", "finalizing"] as const) {
        await store.patchJob(j.id, { status });
        expect((await db.getMediaSession(j.id))?.status).toBe("active");
      }
    } finally {
      cleanup();
    }
  });

  it("settles through the boot sweep as well (a stranded share reaped to failed)", async () => {
    const { db, cleanup } = tmpDb();
    try {
      const store = new Store(db);
      const j = await store.createJob({ id: "job-stranded", ownerId: "u1", source: "browser" });
      await store.patchJob(j.id, { status: "active" });
      await db.setMediaSession(session(j.id));
      const reaped = await store.sweepStrandedJobs();
      expect(reaped).toBe(1);
      expect((await store.getJob(j.id))?.status).toBe("failed");
      expect((await db.getMediaSession(j.id))?.status).toBe("closed");
    } finally {
      cleanup();
    }
  });

  it("settles on a progress write that lands the terminal status", async () => {
    const { db, cleanup } = tmpDb();
    try {
      const store = new Store(db);
      const j = await store.createJob({ id: "job-progress", ownerId: "u1", source: "browser" });
      await store.patchJob(j.id, { status: "active" });
      await db.setMediaSession(session(j.id));
      await store.patchJobProgress(j.id, { status: "failed" });
      expect((await db.getMediaSession(j.id))?.status).toBe("closed");
    } finally {
      cleanup();
    }
  });

  it("closeMediaSession is idempotent and never touches a row that is already closed", async () => {
    const { db, cleanup } = tmpDb();
    try {
      await db.setMediaSession(session("job-a"));
      expect(await db.closeMediaSession("job-a")).toBe(true);
      expect(await db.closeMediaSession("job-a")).toBe(false);
      expect(await db.closeMediaSession("no-such-job")).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("media_sessions boot reconcile (ADAAAA-7764)", () => {
  it("classifies a row as stale when its job is terminal or gone", () => {
    expect(isStaleMediaSession({ status: "active" }, { status: "failed" })).toBe(true);
    expect(isStaleMediaSession({ status: "active" }, { status: "done" })).toBe(true);
    expect(isStaleMediaSession({ status: "active" }, { status: "cancelled" })).toBe(true);
    expect(isStaleMediaSession({ status: "active" }, undefined)).toBe(true);
    expect(isStaleMediaSession({ status: "active" }, { status: "active" })).toBe(false);
    expect(isStaleMediaSession({ status: "active" }, { status: "analyzing" })).toBe(false);
    expect(isStaleMediaSession({ status: "closed" }, { status: "failed" })).toBe(false);
  });

  it("closes active rows on terminal/missing jobs, keeps a genuinely in-flight one, and is re-runnable", async () => {
    const { db, cleanup } = tmpDb();
    try {
      const store = new Store(db);
      // The historical shape: a row left `active` on a FAILED job.
      const failed = await store.createJob({ id: "job-failed", ownerId: "u1", source: "browser" });
      await db.setMediaSession(session(failed.id));
      await store.patchJob(failed.id, { status: "failed" });
      // Simulate a pre-hook row: rewrite it back to `active` behind the hook.
      await db.setMediaSession(session(failed.id));
      // A row whose job row is gone entirely.
      await db.setMediaSession(session("job-vanished"));
      // A genuinely live share: the job is still in flight.
      const live = await store.createJob({ id: "job-live", ownerId: "u1", source: "browser" });
      await store.patchJob(live.id, { status: "active" });
      await db.setMediaSession(session(live.id));
      // An already-closed row stays closed and is not counted.
      await db.setMediaSession(session("job-old", { status: "closed" }));

      const first = await reconcileStaleMediaSessions({ db, getJob: (id) => store.getJob(id) });
      expect(first.scanned).toBe(3);
      expect(first.closed).toBe(2);
      expect(first.live).toBe(1);
      expect(first.closedJobIds.sort()).toEqual(["job-failed", "job-vanished"]);
      expect((await db.getMediaSession("job-failed"))?.status).toBe("closed");
      expect((await db.getMediaSession("job-vanished"))?.status).toBe("closed");
      expect((await db.getMediaSession("job-live"))?.status).toBe("active");

      // Re-run: nothing left to settle (safe to re-run, no data touched).
      const again = await reconcileStaleMediaSessions({ db, getJob: (id) => store.getJob(id) });
      expect(again.closed).toBe(0);
      expect(again.live).toBe(1);
      expect((await db.getMediaSession("job-live"))?.status).toBe("active");
    } finally {
      cleanup();
    }
  });

  it("bounds the number of rows it inspects", async () => {
    const rows = ["a", "b", "c"].map((id) => session(id));
    const closed: string[] = [];
    const fake = {
      listMediaSessions: async () => rows,
      closeMediaSession: async (jobId: string) => {
        closed.push(jobId);
        return true;
      },
    };
    const rec = await reconcileStaleMediaSessions({ db: fake, getJob: () => ({ status: "failed" }), maxRows: 2 });
    expect(rec.scanned).toBe(2);
    expect(rec.closed).toBe(2);
    expect(closed).toHaveLength(2);
  });
});

describe("closed rows keep the per-node cost attribution (ADAAAA-6869/7670)", () => {
  it("still maps a finished job's costUsd to the node that carried the stream", () => {
    const now = new Date("2026-11-02T00:00:00Z");
    const job = { id: "job-done", source: "browser", costUsd: 0.42 } as any;
    const row = session("job-done", { status: "closed" });
    const report = buildMediaNodeReport({
      origin: "http://media:4070",
      health: null,
      mediaSessions: [row],
      jobs: [job],
      now,
    });
    const node = report.cost.perNode.find((n) => n.nodeId === "media-0");
    expect(node).toBeTruthy();
    expect(node!.jobs).toBe(1);
    expect(node!.costUsd).toBe(0.42);
    expect(report.cost.total.costUsd).toBe(0.42);
  });
});

describe("GET /admin/inflight-jobs liveSessions (ADAAAA-7750 + ADAAAA-7764)", () => {
  it("reports a genuinely in-flight share and nothing for a terminal job", async () => {
    const { app, store, db, cfg } = await buildTestApp({ BETA_GATE: "0" });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: cfg.adminEmail, password: cfg.adminPassword },
    });
    expect(login.statusCode).toBe(200);
    const auth = { authorization: `Bearer ${login.json().token}` };

    const j = await store.createJob({ id: "job-share", ownerId: "u1", source: "browser" });
    await store.patchJob(j.id, { status: "active" });
    await db.setMediaSession(session(j.id));

    // Positive case: a share whose job is in flight IS a live session.
    const live = await app.inject({ method: "GET", url: "/admin/inflight-jobs", headers: auth });
    expect(live.statusCode).toBe(200);
    expect(live.json().liveSessions).toHaveLength(1);
    expect(live.json().liveSessions[0].jobId).toBe("job-share");
    expect(live.json().liveSessions[0].status).toBe("active");

    // Terminal: the row is settled, so the share drops out of the live signal.
    await store.patchJob(j.id, { status: "done", completedAt: new Date().toISOString() });
    expect((await db.getMediaSession(j.id))?.status).toBe("closed");
    const ended = await app.inject({ method: "GET", url: "/admin/inflight-jobs", headers: auth });
    expect(ended.statusCode).toBe(200);
    expect(ended.json().liveSessions).toHaveLength(0);
    expect(ended.json().inflight).toHaveLength(0);
  });
});
