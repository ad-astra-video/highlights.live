import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteDb } from "../src/db";
import { Store } from "../src/store";
import { buildTestApp, fakePipeline, waitForJob } from "./helpers";
import type { JobCandidate } from "@highlights/events";
import { buildDeletedJobTombstone } from "../src/acceptance-lane";

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
      // ADAAAA-8286: a delete with no tombstone keeps none (opt-in, no phantom row).
      expect(await db.getJobTombstone(j.id)).toBeUndefined();

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

/** ADAAAA-8286: a candidate row carrying the acceptance-lane signals the tombstone
 * must keep — trigger provenance, suppression reason, and the Stage-2 `confirm`
 * block (goalConfirmed / confidence / corroboration). */
function makeCandidate(jobId: string, over: Partial<JobCandidate> = {}): JobCandidate {
  return {
    id: "c0",
    jobId,
    seq: 1,
    timestamp: 12.5,
    eventType: "GOAL",
    score: 84,
    isHighlight: true,
    outcome: "scoring_play",
    status: "accepted",
    reason: "ball enters net",
    trigger: {
      kind: "score_change",
      timestamp: 12.5,
      eventType: "GOAL",
      scoreBoardChanged: true,
      goalCrossed: true,
      ballOutcome: "in_net",
    },
    createdAt: "2026-11-07T14:20:00.000Z",
    ...over,
  } as JobCandidate;
}

describe("acceptance-lane tombstone on deleteJob (ADAAAA-8286)", () => {
  it("keeps status/trigger/confirm in the tombstone while the cascade still removes the rows", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hl-deljob-lane-"));
    try {
      const db = new SqliteDb(path.join(dir, "test.db"));
      const store = new Store(db);
      const job = await store.createJob({ ownerId: "u1", source: "file", sourceUrl: "/tmp/v.mp4" });
      await store.patchJob(job.id, { status: "done" });
      await store.addHighlight(makeHighlight(job.id, "hA"));

      // accepted-with-confirm, suppressed (burst dedupe), and a plain reject.
      const c1 = makeCandidate(job.id, { id: "c1" });
      const c2 = makeCandidate(job.id, {
        id: "c2",
        timestamp: 40.5,
        status: "suppressed",
        isHighlight: true,
        suppressionReason: "goal_burst_same_transition:1-0>2-0:30s:8s",
      });
      const c3: any = makeCandidate(job.id, { id: "c3", timestamp: 77 });
      c3.confirm = {
        // the request half (prompt + frames) is deliberately dropped by the
        // tombstone projection — only the decision half is kept.
        request: { prompt: "PROMPT_SHOULD_NOT_BE_COPIED", dataItems: [], frames: [], keyframes: [], trajectories: [], audioLevels: [] },
        decision: { goalConfirmed: "confirmed_goal", confidence: 0.82, stage1Disagreed: false, corroborated: true, corroborationSource: "scoreboard" },
      };
      const c4 = makeCandidate(job.id, { id: "c4", timestamp: 101, status: "rejected", isHighlight: false, outcome: "near_miss" });
      for (const c of [c1, c2, c3, c4]) await store.recordJobCandidate(c);
      expect(store.candidatesForJob(job.id)).toHaveLength(4);

      const tombstone = buildDeletedJobTombstone(
        store.getJob(job.id)!,
        store.candidatesForJob(job.id),
        { highlights: store.highlightsForJob(job.id).length, alternatives: 0, observations: store.observationsForJob(job.id).length },
        "u1",
        "2026-11-07T15:00:00.000Z"
      );
      expect(tombstone.counts).toEqual({
        candidates: 4,
        accepted: 2,
        suppressed: 1,
        rejected: 1,
        confirmed: 1,
        // ADAAAA-8728 (AC-5): the lane reports delivered GOALs with no authority.
        goalsWithNoAuthority: 0,
        highlights: 1,
        alternatives: 0,
        observations: 0,
      });

      expect(await store.deleteJob(job.id, { tombstone })).toBe(true);

      // The cascade still removes the evidence rows and the job itself.
      expect(await db.getJob(job.id)).toBeUndefined();
      expect(await db.jobCandidatesForJob(job.id)).toEqual([]);
      expect(await db.getHighlight("hA")).toBeUndefined();

      // ...but the lane survives, self-contained and owner-scoped.
      const kept = await db.getJobTombstone(job.id);
      expect(kept).toBeTruthy();
      expect(kept!.jobId).toBe(job.id);
      expect(kept!.ownerId).toBe("u1");
      expect(kept!.status).toBe("done");
      expect(kept!.source).toBe("file");
      expect(kept!.deletedBy).toBe("u1");
      expect(kept!.deletedAt).toBe("2026-11-07T15:00:00.000Z");
      expect(kept!.counts).toEqual(tombstone.counts);
      expect(kept!.candidates.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);

      const byId = Object.fromEntries(kept!.candidates.map((c) => [c.id, c]));
      expect(byId.c1.status).toBe("accepted");
      expect(byId.c1.trigger).toEqual({ kind: "score_change", scoreBoardChanged: true, goalCrossed: true, ballOutcome: "in_net" });
      expect(byId.c1.confirm).toBeNull();
      expect(byId.c2.status).toBe("suppressed");
      expect(byId.c2.suppressionReason).toBe("goal_burst_same_transition:1-0>2-0:30s:8s");
      expect(byId.c3.confirm).toEqual({
        goalConfirmed: "confirmed_goal",
        confidence: 0.82,
        stage1Disagreed: false,
        corroborated: true,
        corroborationSource: "scoreboard",
      });
      expect(byId.c4.status).toBe("rejected");
      expect(byId.c4.outcome).toBe("near_miss");

      // Size guard: the heavy analysis/confirm request payload is NOT copied.
      const stored = JSON.stringify(kept);
      expect(stored).not.toContain("PROMPT_SHOULD_NOT_BE_COPIED");
      expect(stored).not.toContain("dataItems");

      // Retention is not a second delete: an already-deleted job stays a no-op
      // and its tombstone is not lost.
      expect(await store.deleteJob(job.id)).toBe(false);
      expect((await db.getJobTombstone(job.id))!.counts.candidates).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /jobs/:id/acceptance-lane (ADAAAA-8286)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hl-vod-lane-"));
  const videoPath = path.join(tmp, "vod.mp4");

  beforeAll(() => {
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x180:rate=2",
      "-pix_fmt", "yuv420p", videoPath,
    ]);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("serves the live lane, then the identical lane from the tombstone after DELETE", async () => {
    const { app, store } = await buildTestApp({}, { adapter: fakePipeline() });
    const token = await register(app, "lane-owner@test.dev", "password123");
    const otherToken = await register(app, "lane-other@test.dev", "password123");
    const adminToken = await login(app, "admin@test.local", "adminpass");

    const res = await app.inject({
      method: "POST", url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    expect(res.statusCode).toBe(202);
    const jobId = res.json().job.id as string;
    const done = await waitForJob(app, jobId, token);
    expect(done.job.status).toBe("done");

    // Seed the acceptance lane explicitly: this suite grades the delete/read
    // projection, not how many decide calls the fake pipeline happens to make.
    // The three lanes the board's question needs are all represented.
    await store.recordJobCandidate(makeCandidate(jobId, { id: "lane-a", timestamp: 12.5 }));
    await store.recordJobCandidate(
      makeCandidate(jobId, {
        id: "lane-b",
        timestamp: 40.5,
        status: "suppressed",
        suppressionReason: "goal_burst_same_transition:1-0>2-0:30s:8s",
      })
    );
    const confirmCand: any = makeCandidate(jobId, { id: "lane-c", timestamp: 77 });
    confirmCand.confirm = {
      request: { prompt: "PROMPT_SHOULD_NOT_BE_COPIED", dataItems: [], frames: [], keyframes: [], trajectories: [], audioLevels: [] },
      decision: { goalConfirmed: "confirmed_goal", confidence: 0.82, stage1Disagreed: false, corroborated: true, corroborationSource: "scoreboard" },
    };
    await store.recordJobCandidate(confirmCand);

    const hdr = (t: string) => ({ authorization: `Bearer ${t}` });

    // Live lane: the job exists, so the rows come from the Store.
    const live = await app.inject({ method: "GET", url: `/jobs/${jobId}/acceptance-lane`, headers: hdr(token) });
    expect(live.statusCode).toBe(200);
    const liveBody = live.json();
    expect(liveBody.jobId).toBe(jobId);
    expect(liveBody.deleted).toBe(false);
    expect(liveBody.counts.highlights).toBe((done.highlights as any[]).length);
    expect(liveBody.counts.candidates).toBe(3);
    expect(liveBody.counts.accepted).toBe(2);
    expect(liveBody.counts.suppressed).toBe(1);
    expect(liveBody.counts.confirmed).toBe(1);
    expect(liveBody.candidates.length).toBe(liveBody.counts.candidates);
    expect((liveBody.candidates.find((c: any) => c.id === "lane-c").confirm as any).goalConfirmed).toBe("confirmed_goal");
    expect(JSON.stringify(liveBody)).not.toContain("PROMPT_SHOULD_NOT_BE_COPIED");

    // Owner scope: another user is forbidden, an unknown id is 404.
    const forbidden = await app.inject({ method: "GET", url: `/jobs/${jobId}/acceptance-lane`, headers: hdr(otherToken) });
    expect(forbidden.statusCode).toBe(403);
    const missing = await app.inject({ method: "GET", url: "/jobs/does-not-exist/acceptance-lane", headers: hdr(token) });
    expect(missing.statusCode).toBe(404);

    // Delete: the response echoes what the tombstone kept.
    const del = await app.inject({ method: "DELETE", url: `/jobs/${jobId}`, headers: hdr(token) });
    expect(del.statusCode).toBe(200);
    expect(del.json().deleted).toBe(jobId);
    expect(del.json().evidence).toEqual(liveBody.counts);

    // The job is gone from the normal read routes...
    const gone = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: hdr(token) });
    expect(gone.statusCode).toBe(404);
    const goneDetail = await app.inject({ method: "GET", url: `/jobs/${jobId}/detail`, headers: hdr(token) });
    expect(goneDetail.statusCode).toBe(404);

    // ...but the acceptance lane is still answerable, row for row.
    const after = await app.inject({ method: "GET", url: `/jobs/${jobId}/acceptance-lane`, headers: hdr(token) });
    expect(after.statusCode).toBe(200);
    const afterBody = after.json();
    expect(afterBody.deleted).toBe(true);
    expect(afterBody.deletedBy).toBeTruthy();
    expect(afterBody.deletedAt).toBeTruthy();
    expect(afterBody.status).toBe("done");
    expect(afterBody.counts).toEqual(liveBody.counts);
    expect(afterBody.candidates).toEqual(liveBody.candidates);

    // Owner scope + admin override survive the delete; unknown ids still 404.
    const forbiddenAfter = await app.inject({ method: "GET", url: `/jobs/${jobId}/acceptance-lane`, headers: hdr(otherToken) });
    expect(forbiddenAfter.statusCode).toBe(403);
    const adminAfter = await app.inject({ method: "GET", url: `/jobs/${jobId}/acceptance-lane`, headers: hdr(adminToken) });
    expect(adminAfter.statusCode).toBe(200);
    expect(adminAfter.json().deleted).toBe(true);
    const missingAfter = await app.inject({ method: "GET", url: "/jobs/does-not-exist/acceptance-lane", headers: hdr(token) });
    expect(missingAfter.statusCode).toBe(404);

    // The delete left an actor trail in the admin audit log.
    const audit = await app.inject({ method: "GET", url: "/admin/audit?limit=50", headers: hdr(adminToken) });
    expect(audit.statusCode).toBe(200);
    const entry = (audit.json().entries as any[]).find((e) => e.action === "job.delete" && e.targetId === jobId);
    expect(entry).toBeTruthy();
    expect(entry.detail.counts.accepted).toBe(liveBody.counts.accepted);
  });
});

describe("GET /jobs/:id/acceptance-lane serves the DELIVERED authority (ADAAAA-8774)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hl-lane-auth-"));
  const videoPath = path.join(tmp, "vod.mp4");

  beforeAll(() => {
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x180:rate=2",
      "-pix_fmt", "yuv420p", videoPath,
    ]);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("agrees with the card on the live lane and keeps that disclosure in the tombstone", async () => {
    const { app, store } = await buildTestApp({}, { adapter: fakePipeline() });
    const token = await register(app, "lane-auth@test.dev", "password123");
    const hdr = (t: string) => ({ authorization: `Bearer ${t}` });

    const res = await app.inject({
      method: "POST", url: "/jobs",
      headers: hdr(token),
      payload: { videoPath, gameHint: "valorant" },
    });
    expect(res.statusCode).toBe(202);
    const jobId = res.json().job.id as string;
    const done = await waitForJob(app, jobId, token);
    expect(done.job.status).toBe("done");

    // The ADAAAA-8768 seed shape: a motion-only candidate the decide record
    // cannot attest, beside a delivered card whose own disclosure says `frame`.
    await store.recordJobCandidate({
      ...makeCandidate(jobId, { id: "lane-motion", timestamp: 17 }),
      trigger: { kind: "motion", timestamp: 17, eventType: "GOAL" },
      confirm: {
        request: { prompt: "P", dataItems: [], frames: [], keyframes: [], trajectories: [], audioLevels: [] },
        decision: { goalConfirmed: "confirmed_goal", confidence: 0.8 },
      },
    } as any);
    await store.addHighlight({
      ...makeHighlight(jobId, "h-lane-motion", 16),
      status: "accepted",
      eventType: "GOAL",
      outcome: "scoring_play",
      candidateId: "lane-motion",
      corroborationSource: "frame_attestation",
      attestationUsed: {
        scoreBoardChanged: false,
        goalCrossed: true,
        ballOutcome: "in_net",
        corroborated: true,
        goalConfirmed: "confirmed_goal",
        authority: "frame",
        frameRefCount: 1,
      },
    });

    const live = await app.inject({ method: "GET", url: `/jobs/${jobId}/acceptance-lane`, headers: hdr(token) });
    expect(live.statusCode).toBe(200);
    const liveBody = live.json();
    const row = (liveBody.candidates as any[]).find((c) => c.id === "lane-motion");
    expect(row.authority).toBe("frame");
    expect(row.authoritySource).toBe("row");
    expect(row.candidateAuthority).toBe("none");
    // The falsifier is computed from the same projection: it must agree with a
    // recomputation over the rows it serves (no lane/card divergence).
    const recomputed = (liveBody.candidates as any[]).filter(
      (c) =>
        c.status === "accepted" &&
        /^(GOAL|GOL)$/i.test(c.eventType ?? "") &&
        c.authority !== "scoreboard" &&
        c.authority !== "frame"
    ).length;
    expect(liveBody.counts.goalsWithNoAuthority).toBe(recomputed);

    const del = await app.inject({ method: "DELETE", url: `/jobs/${jobId}`, headers: hdr(token) });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/jobs/${jobId}/acceptance-lane`, headers: hdr(token) });
    expect(after.statusCode).toBe(200);
    const afterBody = after.json();
    expect(afterBody.deleted).toBe(true);
    // The tombstone outlives the highlight row, so it must carry the disclosure
    // it inherited — otherwise a deleted job's lane would contradict its card.
    expect(afterBody.candidates).toEqual(liveBody.candidates);
    expect(afterBody.counts).toEqual(liveBody.counts);
    expect((afterBody.candidates as any[]).find((c) => c.id === "lane-motion").authority).toBe("frame");
  });
});
