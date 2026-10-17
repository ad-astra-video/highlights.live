import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteDb } from "../src/db";
import { Store } from "../src/store";
import { buildTestApp, fakePipeline, waitForJob } from "./helpers";

async function register(app: any, email: string, pw: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

async function login(app: any, email: string, pw: string) {
  const r = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

function makeHighlight(jobId: string, id: string, start = 1): any {
  return {
    id,
    jobId,
    clipUri: `/clips/${id}.mp4`,
    start,
    end: start + 4,
    status: "pending",
    score: 86,
    createdAt: new Date().toISOString(),
  };
}

describe("deleteJob cascade (ADAAAA-6838)", () => {
  it("removes the job row + its highlights + media_session from SQLite in one batch", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hl-deljob-"));
    try {
      const db = new SqliteDb(path.join(dir, "test.db"));
      const store = new Store(db);
      const j = await store.createJob({ ownerId: "u1", source: "file", sourceUrl: "/tmp/v.mp4" });
      await store.addHighlight(makeHighlight(j.id, "hA"));
      await store.addHighlight(makeHighlight(j.id, "hB", 10));
      await db.setMediaSession({ jobId: j.id, sessionId: "s1", streamId: "st", wsUrl: "ws://x", mediaOrigin: "http://x", status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

      // Preconditions: rows present.
      expect(await db.getJob(j.id)).toBeTruthy();
      expect(await db.getHighlight("hA")).toBeTruthy();
      expect(await db.getMediaSession(j.id)).toBeTruthy();

      await store.deleteJob(j.id);

      // Job, highlights, and media session all gone; a second delete is a no-op.
      expect(await db.getJob(j.id)).toBeUndefined();
      expect(await db.getHighlight("hA")).toBeUndefined();
      expect(await db.getHighlight("hB")).toBeUndefined();
      expect(await db.getMediaSession(j.id)).toBeUndefined();
      expect(store.getJob(j.id)).toBeUndefined();
      expect(store.highlightsForJob(j.id)).toHaveLength(0);
      expect(await store.deleteJob(j.id)).toBe(false);

      // Unrelated records survive.
      const other = await store.createJob({ ownerId: "u1", source: "file" });
      expect(await db.getJob(other.id)).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DELETE /jobs/:id (ADAAAA-6838)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hl-vod-del-"));
  const videoPath = path.join(tmp, "vod.mp4");

  beforeAll(() => {
    // Minimal valid video for the async file-job path so the job reaches done.
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x180:rate=2",
      "-pix_fmt", "yuv420p", videoPath,
    ]);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("404 on an unknown job, 403 for a non-owner, 200 for the owner + highlights cascade", async () => {
    let stopCalls = 0;
    const adapter = fakePipeline();
    const origStop = adapter.stopPerceive.bind(adapter);
    adapter.stopPerceive = async (sid: string) => { stopCalls++; return origStop(sid); };
    const { app, store } = await buildTestApp({}, { adapter });
    const token = await register(app, "del-owner@test.dev", "password123");
    const otherToken = await register(app, "del-other@test.dev", "password123");
    const adminToken = await login(app, "admin@test.local", "adminpass");

    // 404 on a missing job.
    const missing = await app.inject({ method: "DELETE", url: "/jobs/does-not-exist", headers: { authorization: `Bearer ${token}` } });
    expect(missing.statusCode).toBe(404);

    // Create a file job via the async path and wait for it to finish (done).
    const res = await app.inject({
      method: "POST", url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    expect(res.statusCode).toBe(202);
    const jobId = res.json().job.id as string;
    const done = await waitForJob(app, jobId, token);
    expect(done.job.status).toBe("done");
    expect((done.highlights as any[]).length).toBeGreaterThan(0);

    // A non-owner gets 403.
    const forbidden = await app.inject({ method: "DELETE", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${otherToken}` } });
    expect(forbidden.statusCode).toBe(403);

    // Admin can delete another user's job (second job the owner still has).
    const res2 = await app.inject({
      method: "POST", url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    const job2 = res2.json().job.id as string;
    const done2 = await waitForJob(app, job2, token);
    expect(done2.job.status).toBe("done");
    const adminDel = await app.inject({ method: "DELETE", url: `/jobs/${job2}`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(adminDel.statusCode).toBe(200);
    expect(adminDel.json().deleted).toBe(job2);
    expect(store.getJob(job2)).toBeUndefined();

    // Owner deletes their own done job -> 200, and the job + highlights disappear.
    const del = await app.inject({ method: "DELETE", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
    expect(del.statusCode).toBe(200);
    expect(del.json().deleted).toBe(jobId);
    expect(store.getJob(jobId)).toBeUndefined();
    expect(store.highlightsForJob(jobId)).toHaveLength(0);

    // The perceive session was released (adapter stopPerceive called for the job).
    expect(stopCalls).toBeGreaterThan(0);

    // GET /jobs/:id now 404s and GET /jobs no longer lists it.
    const gone = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
    expect(gone.statusCode).toBe(404);
    const list = await app.inject({ method: "GET", url: "/jobs", headers: { authorization: `Bearer ${token}` } });
    const ids = (list.json().jobs as any[]).map((j) => j.id);
    expect(ids).not.toContain(jobId);
  });
});
