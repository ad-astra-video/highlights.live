import { describe, it, expect } from "vitest";
import type { Job } from "@highlights/events";
import { buildTestApp } from "./helpers";

// ADAAAA-7928 (spec §4.2, AC8): GET /admin/vod-breakdown is admin-only. A
// non-admin must get 403 — a trimmed 200 would leak internal cost/perceive data
// (ADAAAA-7727), so the status itself is the assertion.

const NOW = Date.now();

function at(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * 3_600_000).toISOString();
}

function mkJob(o: Partial<Job> & { id: string }): Job {
  return {
    source: "file",
    status: "done",
    createdAt: at(1),
    completedAt: at(1),
    ...o,
  } as Job;
}

async function seedCompletedVod(db: any) {
  await db.saveJob(
    mkJob({
      id: "job-a",
      costUsd: 0.26,
      perceiveSessionS: 360,
      decideCalls: 26,
      confirmMetrics: { totalRuns: 6 } as any,
      framesAnalyzed: 360,
      highlightsFound: 4,
      stageAMetrics: { totalCandidates: 9 } as any,
      vodMeter: { wallClockS: 11, decideCalls: 26, sourceDurationS: 128, costUsd: 0.26, decideFeeUsd: 0.01, perVideoHourCostUsd: 7.35, rtf: 3.75 },
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
        measuredAt: new Date().toISOString(),
      },
    })
  );
  // Legacy metered row (no stageTimings) and a cost-less completed row.
  await db.saveJob(mkJob({ id: "job-legacy", costUsd: 0.05, decideCalls: 5 }));
  await db.saveJob(mkJob({ id: "job-nocost" }));
}

describe("GET /admin/vod-breakdown", () => {
  it("403s a non-admin session and 401s an anonymous one (never a trimmed 200)", async () => {
    const app = await buildTestApp();
    await seedCompletedVod(app.db);

    const anon = await app.app.inject({ method: "GET", url: "/admin/vod-breakdown" });
    expect(anon.statusCode).toBe(401);

    const reg = await app.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "plain@example.com", password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    const userHeaders = { authorization: `Bearer ${reg.json().token}` };

    const denied = await app.app.inject({ method: "GET", url: "/admin/vod-breakdown", headers: userHeaders });
    expect(denied.statusCode).toBe(403);
    // The 403 body carries no sample, no nodes, no cost.
    expect(denied.json()).not.toHaveProperty("cost");
    expect(denied.json()).not.toHaveProperty("perRequest");
    await app.app.close();
  });

  it("serves the §4.2 payload to the admin over the seeded records", async () => {
    const app = await buildTestApp();
    await seedCompletedVod(app.db);
    const login = await app.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "admin@test.local", password: "adminpass" },
    });
    expect(login.statusCode).toBe(200);
    const admin = { authorization: `Bearer ${login.json().token}` };

    const res = await app.app.inject({ method: "GET", url: "/admin/vod-breakdown?limit=5", headers: admin });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Scope + denominators.
    expect(body.scope).toMatchObject({ kind: "recent", limit: 5 });
    expect(typeof body.scope.from).toBe("string");
    expect(typeof body.scope.to).toBe("string");
    expect(body.sampled).toBe(3);
    expect(body.metered).toBe(2);
    expect(body.timed).toBe(1);
    expect(body.excluded).toMatchObject({ noCost: 1, noStageTimings: 1, live: 0 });

    // Cost lens: three billable leaves + four CPU leaves, conserved.
    expect(body.cost.nodes.map((n: any) => n.key)).toEqual([
      "perceive_gpu",
      "decide_observe",
      "decide_confirm",
      "cpu_extract",
      "cpu_audio",
      "cpu_clip",
      "cpu_finalize",
    ]);
    const flowSum = body.cost.flows.reduce((s: number, f: any) => s + f.usd, 0);
    expect(Math.abs(flowSum - body.cost.totalUsd)).toBeLessThanOrEqual(0.0001);
    expect(body.cost.nodes.filter((n: any) => n.cpu).every((n: any) => n.usd === 0)).toBe(true);

    // Time lens: partition nodes + the concurrent audio band.
    expect(body.time.nodes.map((n: any) => n.key)).toEqual([
      "capacity_wait",
      "extract",
      "analyze_net",
      "clip_encode",
      "preroll",
      "finalize",
    ]);
    expect(body.time.concurrent.map((c: any) => c.key)).toEqual(["audio_gate"]);
    const timeFlowSum = body.time.flows.reduce((s: number, f: any) => s + f.s, 0);
    expect(Math.abs(timeFlowSum - body.time.totalS)).toBeLessThanOrEqual(1);
    expect(body.time.totalS).toBe(11);

    // Per-request strip uses the labelled denominators.
    expect(body.perRequest.frames).toBeCloseTo((360 + 0) / 2, 1);
    expect(body.perRequest.decideCalls).toBeCloseTo((26 + 5) / 2, 2);
    expect(body.perRequest.wallClockS).toBe(11);
    expect(body.rates).toEqual({ decideFeeUsd: expect.any(Number), perceivePerHourUsd: 0.01 });

    // Default payload is small (AC11 budgets the sibling UI at 64 KB).
    expect(res.body.length).toBeLessThan(64 * 1024);
    await app.app.close();
  });

  it("honours scope=job and rejects malformed queries with 400", async () => {
    const app = await buildTestApp();
    await seedCompletedVod(app.db);
    const login = await app.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "admin@test.local", password: "adminpass" },
    });
    const admin = { authorization: `Bearer ${login.json().token}` };

    const one = await app.app.inject({
      method: "GET",
      url: "/admin/vod-breakdown?scope=job&jobId=job-a",
      headers: admin,
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().scope).toMatchObject({ kind: "job", jobId: "job-a" });
    expect(one.json().metered).toBe(1);
    expect(one.json().timed).toBe(1);

    for (const url of [
      "/admin/vod-breakdown?scope=nope",
      "/admin/vod-breakdown?scope=job",
      "/admin/vod-breakdown?limit=abc",
      "/admin/vod-breakdown?days=abc",
    ]) {
      const bad = await app.app.inject({ method: "GET", url, headers: admin });
      expect(bad.statusCode, url).toBe(400);
      expect(bad.json()).toHaveProperty("error");
    }
    await app.app.close();
  });

  it("an empty company returns the explicit empty payload, not a 404", async () => {
    const app = await buildTestApp();
    const login = await app.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "admin@test.local", password: "adminpass" },
    });
    const admin = { authorization: `Bearer ${login.json().token}` };
    const res = await app.app.inject({ method: "GET", url: "/admin/vod-breakdown", headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sampled: 0, metered: 0, timed: 0 });
    expect(res.json().cost.totalUsd).toBe(0);
    expect(res.json().time.totalS).toBe(0);
    expect(res.json().time.concurrent).toEqual([]);
    await app.app.close();
  });
});
