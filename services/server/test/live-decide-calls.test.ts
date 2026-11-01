import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers";

// ADAAAA-7664: the job-detail header "Decide calls" read 0 for a live
// observe-path job (fixture 2118ea32) that made 17 decide calls and wrote 16
// decide-audit rows. The live pass recorded its count only in
// `observeMetrics.decideCalls`; the job-level `decideCalls` field (written by
// the VOD pass) stayed absent, so every reader fell back to `?? 0`.
//
// The route-level contract: GET /jobs/:id, GET /jobs (tile) and
// GET /jobs/:id/detail (header) must all report `job.decideCalls = N` for such
// a record, must leave a VOD record's own value untouched, and must not invent a
// count for a job that never ran a decide pass.

async function register(app: any, email: string, pw: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

const LIVE_OBSERVE_METRICS = {
  decideCalls: 17,
  accepted: 6,
  maxFrames: 30,
  meanE2eMs: 9120.6,
  maxE2eMs: 10697,
  meanCadenceMs: 2895.8,
  maxCadenceMs: 3000,
};

async function seedLiveJob(store: any, ownerId: string) {
  const job = await store.createJob({
    ownerId,
    source: "rtmp",
    sourceUrl: "rtmp://example.invalid/live/x",
    gameHint: "soccer",
  });
  // The completion patch as written by the PRE-fix live path: observeMetrics
  // only, no job-level decideCalls.
  await store.patchJob(job.id, { status: "done", observeMetrics: LIVE_OBSERVE_METRICS });
  return job;
}

describe("live job decide-call count in the job API (ADAAAA-7664)", () => {
  it("reports the observe-pass count on GET /jobs/:id, /jobs and /jobs/:id/detail", async () => {
    const { app, store } = await buildTestApp();
    const token = await register(app, "live-decides@test.dev", "password123");
    const job = await seedLiveJob(store, (await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    })).json().user.id);
    const headers = { authorization: `Bearer ${token}` };

    const single = await app.inject({ method: "GET", url: `/jobs/${job.id}`, headers });
    expect(single.statusCode).toBe(200);
    expect(single.json().job.decideCalls).toBe(17);
    // Server truth is preserved: the snapshot still carries the raw counters.
    expect(single.json().job.observeMetrics.decideCalls).toBe(17);

    const list = await app.inject({ method: "GET", url: "/jobs", headers });
    expect(list.statusCode).toBe(200);
    const listed = list.json().jobs.find((j: any) => j.id === job.id);
    expect(listed.decideCalls).toBe(17);

    const detail = await app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().job.decideCalls).toBe(17);
  });

  it("leaves a VOD job's decideCalls untouched (18, and 0 when no decide ran)", async () => {
    const { app, store } = await buildTestApp();
    const token = await register(app, "vod-decides@test.dev", "password123");
    const headers = { authorization: `Bearer ${token}` };
    const ownerId = (await app.inject({ method: "GET", url: "/auth/me", headers })).json().user.id;

    const vod = await store.createJob({ ownerId, source: "file", sourceUrl: "/data/clips/x.mp4" });
    await store.patchJob(vod.id, { status: "done", decideCalls: 18 });
    const vodZero = await store.createJob({ ownerId, source: "file", sourceUrl: "/data/clips/y.mp4" });
    await store.patchJob(vodZero.id, { status: "done", decideCalls: 0 });

    expect((await app.inject({ method: "GET", url: `/jobs/${vod.id}`, headers })).json().job.decideCalls).toBe(18);
    expect((await app.inject({ method: "GET", url: `/jobs/${vodZero.id}`, headers })).json().job.decideCalls).toBe(0);
  });

  it("does not invent a count for a job whose observer never ran", async () => {
    const { app, store } = await buildTestApp();
    const token = await register(app, "nododecide@test.dev", "password123");
    const headers = { authorization: `Bearer ${token}` };
    const ownerId = (await app.inject({ method: "GET", url: "/auth/me", headers })).json().user.id;
    const job = await store.createJob({ ownerId, source: "rtmp" });
    await store.patchJob(job.id, { status: "done" });
    // Absent (not fabricated 0): the webapp header falls back to 0 itself.
    expect((await app.inject({ method: "GET", url: `/jobs/${job.id}`, headers })).json().job.decideCalls).toBeUndefined();
  });
});
