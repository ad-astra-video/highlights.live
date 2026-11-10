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
  // ADAAAA-8061: the unmeasured-settlement pair. The money half is the same
  // spend class as costUsd; the named reason is not money and stays visible so
  // an owner can tell "not measured" from a genuine zero.
  partialCostUsd: 0.0008,
  costUnavailable: "decide-count-not-persisted",
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
  // ADAAAA-7907: the per-job cost meter (ADAAAA-7821) is the same class of
  // spend diagnostic — filtered for a non-admin like costUsd/decideCalls.
  vodMeter: {
    wallClockS: 41.2,
    decideCalls: 7,
    sourceDurationS: 24,
    costUsd: 0.0187,
    decideFeeUsd: 0.0012,
    perVideoHourCostUsd: 2.8,
    rtf: 1.72,
  },
  // ADAAAA-7928: per-stage timings ride the same gate (perceiveSessionMs is
  // billable session time; the panel is admin-only).
  stageTimings: {
    version: 1,
    prerollMs: 400,
    extractMs: 1000,
    capacityWaitMs: 100,
    analyzeMs: 7500,
    clipEncodeMs: 1500,
    audioGateMs: 6400,
    finalizeMs: 2000,
    sourceProbeMs: 120,
    perceiveSessionMs: 7500,
    totalMs: 11000,
    measuredAt: "2026-11-04T00:00:00.000Z",
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

  it("hides the partial cost but keeps the unavailable REASON for the owner (ADAAAA-8061)", () => {
    const job = { id: "j2b", ...INTERNAL_FIELDS };
    const visible = jobForRole(job, "user");
    expect(visible).not.toHaveProperty("partialCostUsd");
    expect(visible.costUnavailable).toBe("decide-count-not-persisted");
    // Admin keeps the money half.
    expect(jobForRole(job, "admin").partialCostUsd).toBe(0.0008);
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

  // ADAAAA-7907 (AC8/AC9): the resume checkpoint's OPERABILITY half must reach
  // the owning user (that is what renders "resumed from T+12:30, attempt 2 of
  // 3"), while its SPEND half stays behind the ADAAAA-7727 gate.
  it("keeps the resume point and attempt trail for a non-admin but drops the accumulators", () => {
    const resume = {
      version: 1,
      phase: "analyze",
      analyze: { cursorTs: 750 },
      accumulators: { decideCalls: 42, perceiveSessionS: 900, costUsd: 1.23, wallClockS: 1200 },
      attempts: [
        { attempt: 1, startedAt: "t0", endedAt: "t1", failedAtPhase: "analyze", failureReason: "decide-unavailable", usdSpent: 0.4 },
        { attempt: 2, startedAt: "t2" },
      ],
      totalAttempts: 2,
      maxAttempts: 3,
      resumedFromTs: 750,
      nextAttemptAt: "2030-01-01T00:00:00.000Z",
    };
    const job = { id: "r1", source: "file", status: "queued", resume };
    const visible: any = jobForRole(job, "user");
    // Operability survives — the page needs the point, the attempt number and
    // the per-attempt attribution.
    expect(visible.resume.resumedFromTs).toBe(750);
    expect(visible.resume.totalAttempts).toBe(2);
    expect(visible.resume.maxAttempts).toBe(3);
    expect(visible.resume.phase).toBe("analyze");
    expect(visible.resume.attempts[0].failureReason).toBe("decide-unavailable");
    expect(visible.resume.nextAttemptAt).toBe("2030-01-01T00:00:00.000Z");
    // Spend does not.
    expect(visible.resume).not.toHaveProperty("accumulators");
    expect(visible.resume.attempts[0]).not.toHaveProperty("usdSpent");
    // The stored record is untouched.
    expect(resume.accumulators.costUsd).toBe(1.23);
    expect(resume.attempts[0].usdSpent).toBe(0.4);
    // Admin keeps the whole block (same identity).
    expect((jobForRole(job, "admin") as any).resume).toBe(resume);
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

describe("match-context evidence projection (ADAAAA-7889 AC2)", () => {
  it("keeps the explanation and drops the perceive session handle for a user", () => {
    const evidence = {
      scorebugOcrFrames: 30,
      sources: ["scorebug_ocr", "asr", "metadata"],
      sessionId: "130806c6",
      sessionEvidence: true,
      channelOutcomes: {
        scorebug_ocr: { frames: 30, lines: 30, teamLines: 0, rawLines: ["ETIHAD"] },
        asr: { chars: 967, mentions: [{ name: "Liverpool", snippet: "Liverpool press", start: 10, end: 24 }] },
      },
      unknownReason: "scorebug_ocr: 30 frames, 30 OCR lines, 0 with team text",
    };
    const visible = jobForRole({ id: "j-evidence", status: "done", matchContextEvidence: evidence }, "user");
    const ev = (visible as any).matchContextEvidence;
    expect(ev).toBeTruthy();
    expect(ev.channelOutcomes.scorebug_ocr.rawLines).toEqual(["ETIHAD"]);
    expect(ev.channelOutcomes.asr.mentions[0].snippet).toBe("Liverpool press");
    expect(ev.unknownReason).toContain("0 with team text");
    expect(ev).not.toHaveProperty("sessionId");
    // The stored record is never mutated by the projection.
    expect((evidence as any).sessionId).toBe("130806c6");
  });

  it("keeps the record untouched for an admin", () => {
    const evidence = { sessionId: "130806c6", sources: ["asr"] };
    const job = { id: "j-admin-evidence", matchContextEvidence: evidence };
    expect(jobForRole(job, "admin").matchContextEvidence).toBe(evidence);
  });

  it("drops the field when a record carries no evidence object", () => {
    const visible = jobForRole({ id: "j-none" } as any, "user");
    expect(visible).not.toHaveProperty("matchContextEvidence");
  });
});

// ADAAAA-8544: the frozen decide-knob stamp is a per-job SPEND prediction
// (`predictedUsdPerHour` + band), the same class as `costUsd`, so it never
// reaches a customer payload; the operator read (job header, window audit) keeps
// it. This pins the new key rather than relying on the shared key loop, whose
// fixture predates the field.
describe("the decide knob is an internal readout (ADAAAA-8544)", () => {
  it("drops decideKnob for role=user and keeps it for admin", () => {
    const job = {
      id: "job-8544",
      status: "done",
      costUsd: 1.04,
      decideKnob: {
        cadenceSec: 5,
        rateCapPer300s: null,
        resolvedSource: "default",
        opportunitiesPer300s: 50.3,
        usdPerDecide: 0.0033324,
        predictedUsdPerHour: 2.01143664,
        predictedBandUsdPerHour: [1.862146, 2.162905],
        estimateVersion: "est-v2",
      },
    };
    expect(jobForRole(job, "user")).not.toHaveProperty("decideKnob");
    expect(jobForRole(job, "admin").decideKnob).toEqual(job.decideKnob);
  });
});
