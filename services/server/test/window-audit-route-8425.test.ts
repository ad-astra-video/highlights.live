// ADAAAA-8425 route contract: GET /admin/jobs/:id/window-audit is admin-only
// and returns the stored 5-way skip split + the decide ceiling. The customer
// session must get 403 (never a trimmed 200), and the customer job payload must
// still carry none of the internal counters (ADAAAA-7727 / QA AC-3).
import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers";

const OBSERVE = {
  decideCalls: 96,
  accepted: 12,
  maxFrames: 8,
  meanE2eMs: 2000,
  maxE2eMs: 3000,
  meanCadenceMs: 3000,
  maxCadenceMs: 3200,
  triggerFires: 0,
  cadenceFires: 96,
  skippedStaleWindows: 0,
  backpressureSkippedWindows: 11,
  admissionSkippedWindows: 0,
  throttleSkippedWindows: 4,
  capacityDroppedWindows: 2,
  droppedFrames: 0,
  supplySkippedWindows: 11,
  decideQueued: 3,
  decideDropped: 2,
  decide503: 5,
  decidePauses: 1,
  capacityProbeErrors: 0,
  decideCapacity: { advertised: 6, funded: 8, effective: 6, probeOk: true, runners: 3, source: "probe" },
};

async function seed(app: any, ownerId?: string) {
  const job = await app.store.createJob({ id: "job-2stream-8425", ownerId, source: "rtmp" });
  // Goes through `store.patchJob` (JobSchema.parse) exactly like the pass's own
  // settle write, so this also proves the new counter survives the zod schema.
  await app.store.patchJob(job.id, { status: "done", observeMetrics: OBSERVE } as any);
}

describe("GET /admin/jobs/:id/window-audit (ADAAAA-8425)", () => {
  it("serves the five causes, decideCalls/supply and effective/funded to an admin", async () => {
    const app = await buildTestApp();
    await seed(app);

    const login = await app.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "admin@test.local", password: "adminpass" },
    });
    expect(login.statusCode).toBe(200);
    const headers = { authorization: `Bearer ${login.json().token}` };

    const res = await app.app.inject({ method: "GET", url: "/admin/jobs/job-2stream-8425/window-audit", headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jobId).toBe("job-2stream-8425");
    expect(body.stored).toBe(true);
    expect(Object.fromEntries(body.causes.map((c: any) => [c.cause, c.count]))).toEqual({
      stale: 0,
      backpressure: 11,
      admission: 0,
      throttle: 4,
      capacityDrop: 2,
    });
    expect(body.decideCalls).toBe(96);
    expect(body.supplySkippedWindows).toBe(11);
    // 96 issued + 0 stale + 11 backpressure + 0 admission + 4 throttle
    expect(body.accountedWindows).toBe(111);
    // The decide the runner refused is inside decideCalls, so "completed" is
    // the number that produced a verdict.
    expect(body.decideCallsCompleted).toBe(94);
    expect(body.skippedWindows).toBe(17);
    expect(body.decideCapacity).toMatchObject({ advertised: 6, funded: 8, effective: 6 });
    await app.app.close();
  });

  it("401s anonymous and 403s a role=user session, and the customer payload carries no counters", async () => {
    const app = await buildTestApp();
    const reg = await app.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "plain@example.com", password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    const userHeaders = { authorization: `Bearer ${reg.json().token}` };
    const userId = reg.json().user?.id ?? reg.json().user?.userId;
    await seed(app, userId);

    const anon = await app.app.inject({ method: "GET", url: "/admin/jobs/job-2stream-8425/window-audit" });
    expect(anon.statusCode).toBe(401);

    const denied = await app.app.inject({ method: "GET", url: "/admin/jobs/job-2stream-8425/window-audit", headers: userHeaders });
    expect(denied.statusCode).toBe(403);
    // The 403 body carries no split, no cause counts, no capacity.
    expect(denied.json()).not.toHaveProperty("causes");
    expect(denied.json()).not.toHaveProperty("decideCapacity");
    expect(JSON.stringify(denied.json())).not.toContain("capacityDroppedWindows");

    // The owning customer's job read is unchanged: no observe snapshot keys.
    const job = await app.app.inject({ method: "GET", url: "/jobs/job-2stream-8425", headers: userHeaders });
    expect(job.statusCode).toBe(200);
    expect(job.json().job).not.toHaveProperty("observeMetrics");
    expect(job.json().job).not.toHaveProperty("decideCalls");
    expect(JSON.stringify(job.json())).not.toContain("capacityDroppedWindows");
    expect(JSON.stringify(job.json())).not.toContain("backpressureSkippedWindows");
    await app.app.close();
  });
});
