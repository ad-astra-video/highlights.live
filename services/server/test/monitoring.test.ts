import { describe, it, expect, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import { SqliteDb, type Db } from "../src/db";
import { reportMonitoring, RELIABILITY_FLOOR } from "../src/monitoring";
import { recordSubscribeFunnel } from "../src/funnel";
import { buildTestApp } from "./helpers";
import type { Job, HighlightRecord } from "@highlights/events";

async function mkUser(db: Db, channel: string | null) {
  return db.createUser({
    id: `u-${Math.random().toString(36).slice(2)}`,
    email: `${Math.random().toString(36).slice(2)}@test.local`,
    passwordHash: "x",
    role: "user",
    stripeCustomerId: null,
    betaActivatedAt: new Date().toISOString(),
    channel,
  });
}

function mkJob(o: Partial<Job> & { id: string }): Job {
  return {
    id: o.id,
    source: o.source ?? "file",
    status: o.status ?? "done",
    createdAt: o.createdAt ?? new Date().toISOString(),
    ownerId: o.ownerId,
    costUsd: o.costUsd,
  } as Job;
}

function mkHighlight(o: Partial<HighlightRecord> & { id: string; jobId: string }): HighlightRecord {
  return {
    id: o.id,
    jobId: o.jobId,
    clipUri: o.clipUri ?? "/clips/x.mp4",
    start: o.start ?? 1,
    end: o.end ?? 2,
    score: o.score ?? 90,
    status: o.status ?? "accepted",
    createdAt: o.createdAt ?? new Date().toISOString(),
  } as HighlightRecord;
}

describe("reliability + Livepeer cost monitoring (ADAAAA-6369)", () => {
  let db: Db;
  const now = new Date().toISOString();
  beforeEach(() => {
    db = new SqliteDb(":memory:");
  });

  it("derives new-job reliability, per-clip inference cost, and CAC-with-inference", async () => {
    const meta = await mkUser(db, "meta");
    const google = await mkUser(db, "google");
    await recordSubscribeFunnel(db, meta.id);
    await recordSubscribeFunnel(db, google.id);
    await db.recordChannelSpend("meta", 60, "Meta campaign");
    await db.recordChannelSpend("google", 120, "Google Search");

    // j1 (meta): done + produced a usable clip, cost 0.02
    // j2 (meta): done + NO clip (failed reliability), cost 0.01
    // j3 (google): failed, no clip, cost 0
    await db.saveJob(mkJob({ id: "j1", ownerId: meta.id, status: "done", costUsd: 0.02, createdAt: now }));
    await db.saveJob(mkJob({ id: "j2", ownerId: meta.id, status: "done", costUsd: 0.01, createdAt: now }));
    await db.saveJob(mkJob({ id: "j3", ownerId: google.id, status: "failed", costUsd: 0, createdAt: now }));
    await db.saveHighlight(mkHighlight({ id: "h1", jobId: "j1", clipUri: "/clips/a.mp4", status: "accepted", createdAt: now }));

    const r = await reportMonitoring(db, { days: 7 });

    expect(r.newJobs).toBe(3);
    expect(r.completedJobs).toBe(3);
    expect(r.usableClipJobs).toBe(1);
    expect(r.reliabilityPct).toBe(33.33);
    expect(r.reliabilityOk).toBe(false);
    // 33.33% < 95% floor -> spend-pause (hard-stop) condition.
    expect(r.spendPaused).toBe(true);
    expect(r.totalInferenceCostUsd).toBe(0.03);
    expect(r.usableClips).toBe(1);
    expect(r.perClipInferenceCostUsd).toBe(0.03);

    const metaRow = r.perChannel.find((c) => c.channel === "meta")!;
    expect(metaRow).toMatchObject({ spendUsd: 60, subscribers: 1, cacUsd: 60, cacWithInferenceUsd: 60.03 });
    // inference 0.02 (j1) + 0.01 (j2) = 0.03 attributed to meta.
    expect(metaRow.inferenceUsd).toBe(0.03);
    const googleRow = r.perChannel.find((c) => c.channel === "google")!;
    expect(googleRow).toMatchObject({ spendUsd: 120, inferenceUsd: 0, subscribers: 1, cacUsd: 120, cacWithInferenceUsd: 120 });
  });

  it("reports reliability OK when >= 95% of completed jobs produce a usable clip", async () => {
    const u = await mkUser(db, "organic");
    for (let i = 0; i < 4; i++) {
      await db.saveJob(mkJob({ id: `ok-${i}`, ownerId: u.id, status: "done", costUsd: 0.01, createdAt: now }));
      await db.saveHighlight(mkHighlight({ id: `h-${i}`, jobId: `ok-${i}`, status: "accepted", createdAt: now }));
    }
    const r = await reportMonitoring(db, { days: 7 });
    expect(r.completedJobs).toBe(4);
    expect(r.usableClipJobs).toBe(4);
    expect(r.reliabilityPct).toBe(100);
    expect(r.reliabilityOk).toBe(true);
    expect(r.spendPaused).toBe(false);
    expect(r.reliabilityFloor).toBe(RELIABILITY_FLOOR);
  });

  it("returns null reliability until any job has completed", async () => {
    const u = await mkUser(db, "meta");
    await db.saveJob(mkJob({ id: "q1", ownerId: u.id, status: "queued", createdAt: now }));
    const r = await reportMonitoring(db, { days: 7 });
    expect(r.newJobs).toBe(1);
    expect(r.completedJobs).toBe(0);
    expect(r.inFlightJobs).toBe(1);
    expect(r.reliabilityPct).toBeNull();
    expect(r.reliabilityOk).toBe(false);
    expect(r.spendPaused).toBe(false);
  });
});

describe("monitoring readout route (api-level)", () => {
  it("serves /admin/monitoring for the admin and reports the live gate flags", async () => {
    const app = await buildTestApp({ BILLING_WIREFRAME: "1" });

    const adminLogin = await app.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "admin@test.local", password: "adminpass" },
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminHeaders = { authorization: `Bearer ${adminLogin.json().token}` };

    // Seed one completed job that produced a usable clip.
    const u = await app.db.createUser({
      id: "mon-user",
      email: "mon@test.local",
      passwordHash: "x",
      role: "user",
      stripeCustomerId: null,
      betaActivatedAt: new Date().toISOString(),
      channel: "meta",
    });
    await app.db.saveJob({
      id: "mon-j1",
      ownerId: u.id,
      source: "file",
      status: "done",
      createdAt: new Date().toISOString(),
      costUsd: 0.02,
    } as Job);
    await app.db.saveHighlight({
      id: "mon-h1",
      jobId: "mon-j1",
      clipUri: "/clips/mon.mp4",
      start: 1,
      end: 2,
      score: 90,
      status: "accepted",
      createdAt: new Date().toISOString(),
    } as HighlightRecord);

    const res = await app.app.inject({ method: "GET", url: "/admin/monitoring", headers: adminHeaders });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.newJobs).toBe(1);
    expect(body.completedJobs).toBe(1);
    expect(body.usableClipJobs).toBe(1);
    expect(body.reliabilityPct).toBe(100);
    expect(body.spendPaused).toBe(false);
    expect(body.totalInferenceCostUsd).toBe(0.02);
    expect(body.perClipInferenceCostUsd).toBe(0.02);

    // Admin gate: an unauthenticated request must be rejected.
    const noAuth = await app.app.inject({ method: "GET", url: "/admin/monitoring" });
    expect(noAuth.statusCode).toBe(401);

    await app.app.close();
  });

  it("read-only admin token reads /admin/monitoring but cannot write (ADAAAA-6388)", async () => {
    const app = await buildTestApp({ BILLING_WIREFRAME: "1" });

    const roToken = jwt.sign(
      { sub: "dev-readonly", email: "dev@adastra", role: "admin_readonly" },
      app.cfg.jwtSecret,
      { expiresIn: "1h" }
    );
    const ro = { authorization: `Bearer ${roToken}` };

    // Read succeeds.
    const res = await app.app.inject({ method: "GET", url: "/admin/monitoring", headers: ro });
    expect(res.statusCode).toBe(200);
    expect(res.json().newJobs).toBeDefined();

    // Write routes reject the read-only token with 403.
    const writeSpend = await app.app.inject({ method: "POST", url: "/admin/spend", headers: ro, payload: { channel: "meta", spendUsd: 50 } });
    expect(writeSpend.statusCode).toBe(403);
    const gate = await app.app.inject({ method: "PUT", url: "/admin/waitlist/gate", headers: ro, payload: { allocationOpen: false } });
    expect(gate.statusCode).toBe(403);

    await app.app.close();
  });
});
