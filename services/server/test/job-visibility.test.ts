import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildTestApp, type TestApp } from "./helpers";
import {
  INTERNAL_JOB_KEYS,
  isAdminRole,
  jobDetailForRole,
  jobEventForRole,
  jobForRole,
  jobsForRole,
} from "../src/job-visibility";

// ADAAAA-7727 (Inc 1 of ADAAAA-7726): a customer session must never receive the
// internal pipeline / media-server / cost diagnostics. These tests pin the rule
// in two layers: the pure projection helpers, and the HTTP responses that carry
// a job (list, detail, composite detail) plus the admin-only media-node readout.

const SNAPSHOT = {
  totalCandidates: 4,
  accepted: 2,
  rejected: 2,
  fpRate: 0.5,
  meanOnsetLatencyS: 1.2,
  maxOnsetLatencyS: 2.4,
  fpRateWithinBudget: true,
};

/** A completed job record carrying every internal diagnostic field. */
const INTERNAL_FIELDS = {
  costUsd: 0.0187,
  decideCalls: 7,
  perceiveSessionS: 12.4,
  stageAMetrics: SNAPSHOT,
  stageAMetricsStatus: "measured" as const,
  observeMetrics: {
    decideCalls: 7,
    accepted: 2,
    maxFrames: 24,
    meanE2eMs: 900,
    maxE2eMs: 1400,
    meanCadenceMs: 3000,
    maxCadenceMs: 3200,
  },
  vodObserveMetrics: {
    decideCalls: 7,
    accepted: 2,
    maxFrames: 24,
    subsampledCalls: 3,
    framesPerCall: [24, 24, 18],
  },
};

describe("job-visibility projection", () => {
  it("treats only the exact `admin` role as internal-visible", () => {
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("user")).toBe(false);
    // The standalone read-only measurement token owns only the read-only
    // /admin/* routes; it is filtered like any other non-admin principal here.
    expect(isAdminRole("admin_readonly")).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
    expect(isAdminRole(null)).toBe(false);
  });

  it("omits every internal key for a non-admin and keeps the work counters", () => {
    const job = { id: "j1", ownerId: "u1", status: "done", framesAnalyzed: 240, highlightsFound: 2, ...INTERNAL_FIELDS };
    const visible = jobForRole(job, "user");
    for (const key of INTERNAL_JOB_KEYS) expect(visible).not.toHaveProperty(key);
    // Customer-facing work counters survive — the gate must not blank the tile.
    expect(visible.framesAnalyzed).toBe(240);
    expect(visible.highlightsFound).toBe(2);
    expect(visible.status).toBe("done");
  });

  it("never mutates the stored record", () => {
    const job = { id: "j2", ...INTERNAL_FIELDS };
    jobForRole(job, "user");
    expect(job.costUsd).toBe(INTERNAL_FIELDS.costUsd);
    expect(job.observeMetrics.decideCalls).toBe(7);
  });

  it("returns the record untouched for an admin (same identity, all keys)", () => {
    const job = { id: "j3", ...INTERNAL_FIELDS };
    const visible = jobForRole(job, "admin");
    expect(visible).toBe(job);
    expect(visible.costUsd).toBe(INTERNAL_FIELDS.costUsd);
    expect(visible.decideCalls).toBe(7);
  });

  it("filters a job list and leaves the admin list untouched", () => {
    const jobs = [
      { id: "a", ...INTERNAL_FIELDS },
      { id: "b", ...INTERNAL_FIELDS },
    ];
    const userJobs = jobsForRole(jobs, "user");
    expect(userJobs).toHaveLength(2);
    for (const j of userJobs) for (const key of INTERNAL_JOB_KEYS) expect(j).not.toHaveProperty(key);
    expect(jobsForRole(jobs, "admin")).toBe(jobs);
  });

  it("filters only the embedded job on the composite detail payload", () => {
    const payload = { job: { id: "d1", ...INTERNAL_FIELDS }, highlights: [{ id: "h1" }], sections: [], traces: [] };
    const visible = jobDetailForRole(payload, "user");
    expect(visible.job).not.toHaveProperty("costUsd");
    expect(visible.job).not.toHaveProperty("observeMetrics");
    // The customer's own clip/analysis surfaces are untouched.
    expect(visible.highlights).toEqual([{ id: "h1" }]);
  });

  it("filters an SSE event that embeds a job", () => {
    const ev = { type: "done", seq: 3, timestamp: 9.5, job: { id: "s1", ...INTERNAL_FIELDS } };
    const visible = jobEventForRole(ev, "user");
    expect(visible).not.toHaveProperty("costUsd");
    expect(visible.job).not.toHaveProperty("costUsd");
    expect(visible.seq).toBe(3); // frame/stream identity is not spend data
  });

  it("keeps the deliberate liveProgress exception while dropping every internal diagnostic (ADAAAA-7741)", () => {
    const liveProgress = {
      liveEdgeTs: 60,
      processedThroughTs: 34,
      lagSec: 26,
      skippedWindows: 2,
      state: "behind" as const,
      updatedAt: "2026-11-02T04:01:00.000Z",
    };
    const payload = { job: { id: "l1", ...INTERNAL_FIELDS }, highlights: [], sections: [], traces: [], liveProgress };
    const visible = jobDetailForRole(payload, "user") as Record<string, any>;
    // The customer's own "how live is this" reading survives untouched …
    expect(visible.liveProgress).toEqual(liveProgress);
    // … and it is still not a side door to the diagnostics it projects.
    for (const key of INTERNAL_JOB_KEYS) expect(visible.job).not.toHaveProperty(key);
    for (const key of ["observeMetrics", "costUsd", "decideCalls", "stageAMetrics"]) {
      expect(visible.liveProgress).not.toHaveProperty(key);
      expect(visible.job).not.toHaveProperty(key);
    }
  });
});

describe("job responses are role-filtered end to end", () => {
  let t: TestApp;
  let userToken: string;
  let adminToken: string;
  let jobId: string;

  async function login(email: string, password: string): Promise<string> {
    const r = await t.app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }

  beforeAll(async () => {
    t = await buildTestApp();
    const reg = await t.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "customer@test.dev", password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    userToken = reg.json().token as string;
    const user = reg.json().user as { id: string };
    adminToken = await login("admin@test.local", "adminpass");

    // Seed a COMPLETED job carrying every internal field, exactly as the VOD/live
    // completion path writes them. No pipeline runs (no GPU, no ffmpeg).
    const job = await t.store.createJob({ ownerId: user.id, source: "file", gameHint: "soccer" });
    jobId = job.id;
    await t.store.patchJob(job.id, {
      status: "done",
      framesAnalyzed: 240,
      highlightsFound: 2,
      ...INTERNAL_FIELDS,
    } as any);
  });

  afterAll(async () => {
    await t.app.close();
  });

  it("GET /jobs/:id omits every internal key for role=user and keeps them for admin", async () => {
    const asUser = await t.app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${userToken}` } });
    expect(asUser.statusCode).toBe(200);
    const userJob = asUser.json().job;
    for (const key of INTERNAL_JOB_KEYS) expect(userJob).not.toHaveProperty(key);
    expect(userJob.framesAnalyzed).toBe(240);

    const asAdmin = await t.app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${adminToken}` } });
    expect(asAdmin.statusCode).toBe(200);
    const adminJob = asAdmin.json().job;
    expect(adminJob.costUsd).toBe(INTERNAL_FIELDS.costUsd);
    expect(adminJob.decideCalls).toBe(7);
    expect(adminJob.perceiveSessionS).toBe(12.4);
    expect(adminJob.stageAMetrics.totalCandidates).toBe(4);
    expect(adminJob.observeMetrics.decideCalls).toBe(7);
    expect(adminJob.vodObserveMetrics.subsampledCalls).toBe(3);
  });

  it("GET /jobs list omits the internal keys for role=user and keeps them for admin", async () => {
    const asUser = await t.app.inject({ method: "GET", url: "/jobs", headers: { authorization: `Bearer ${userToken}` } });
    expect(asUser.statusCode).toBe(200);
    const userJobs = asUser.json().jobs as Record<string, any>[];
    expect(userJobs.length).toBeGreaterThan(0);
    for (const j of userJobs) for (const key of INTERNAL_JOB_KEYS) expect(j).not.toHaveProperty(key);

    const asAdmin = await t.app.inject({ method: "GET", url: "/jobs", headers: { authorization: `Bearer ${adminToken}` } });
    expect(asAdmin.statusCode).toBe(200);
    const adminJob = (asAdmin.json().jobs as Record<string, any>[]).find((j) => j.id === jobId)!;
    expect(adminJob.costUsd).toBe(INTERNAL_FIELDS.costUsd);
    expect(adminJob.decideCalls).toBe(7);
  });

  it("GET /jobs/:id/detail cannot be used as a side door to the same fields", async () => {
    const asUser = await t.app.inject({
      method: "GET",
      url: `/jobs/${jobId}/detail`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(asUser.statusCode).toBe(200);
    for (const key of INTERNAL_JOB_KEYS) expect(asUser.json().job).not.toHaveProperty(key);

    const asAdmin = await t.app.inject({
      method: "GET",
      url: `/jobs/${jobId}/detail`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json().job.costUsd).toBe(INTERNAL_FIELDS.costUsd);
  });

  it("GET /jobs/:id and /detail return liveProgress to a non-admin without the diagnostics (ADAAAA-7741 AC2)", async () => {
    // A live job mid-run: content clock started 60 s ago, newest decided window
    // 34 s of content. No pipeline runs — the derivation is pure read-path.
    const startedAt = new Date(Date.now() - 60_000);
    const live = await t.store.createJob({ ownerId: t.store.getJob(jobId)!.ownerId!, source: "rtmp" });
    await t.store.patchJob(live.id, {
      status: "active",
      startedAt: startedAt.toISOString(),
      summaryLog: [
        { seq: 1, ts: new Date(startedAt.getTime() + 35_000).toISOString(), windowTs: 21, text: "a" },
        { seq: 2, ts: new Date(startedAt.getTime() + 62_000).toISOString(), windowTs: 34, text: "b" },
      ],
      ...INTERNAL_FIELDS,
    } as any);

    for (const url of [`/jobs/${live.id}`, `/jobs/${live.id}/detail`]) {
      const res = await t.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${userToken}` } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, any>;
      expect(body.liveProgress).toBeTruthy();
      expect(body.liveProgress.processedThroughTs).toBe(34);
      // AC1: lagSec agrees with an independent recompute from the same payload.
      const independent = (Date.now() - Date.parse(body.job.startedAt)) / 1000 - body.liveProgress.processedThroughTs;
      expect(Math.abs(body.liveProgress.lagSec - independent)).toBeLessThanOrEqual(2);
      expect(body.liveProgress.state).toBe("behind");
      // AC2: the projection is not a side door to the internal diagnostics.
      for (const key of ["observeMetrics", "costUsd", "decideCalls", "stageAMetrics"]) {
        expect(body.job).not.toHaveProperty(key);
        expect(body.liveProgress).not.toHaveProperty(key);
      }
    }
  });

  it("GET /media/node is admin-only (403 for role=user, 200 for admin)", async () => {
    const asUser = await t.app.inject({ method: "GET", url: "/media/node", headers: { authorization: `Bearer ${userToken}` } });
    expect(asUser.statusCode).toBe(403);
    const asAdmin = await t.app.inject({ method: "GET", url: "/media/node", headers: { authorization: `Bearer ${adminToken}` } });
    expect(asAdmin.statusCode).toBe(200);
  });
});
