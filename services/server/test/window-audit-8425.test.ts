// ADAAAA-8425: decompose skipped live windows by CAUSE on the admin readout +
// count decide capacity drops. $0: no inference, no GPU, no live leg.
//
// The three legs pinned here:
//   1. AC1 — `observeMetrics.capacityDroppedWindows` counts a decide the RUNNER
//      refused (the `isDecideCapacityError` path) once per window, survives
//      `JobSchema.parse` (the ADAAAA-8219 trap: an undeclared counter is stripped
//      by `store.patchJob`) and is NOT folded into `supplySkippedWindows`.
//   2. AC2 — the admin window-audit readout shows the five causes side by side
//      with `decideCalls` and the supply total, on BOTH the composite detail
//      payload and the dedicated admin route; a `role=user` payload and route are
//      unchanged (absent field / 403).
//   3. AC3 — the same readout carries the decide ceiling the job ran at
//      (`advertised` vs `effective` from the ADAAAA-8254/8262 snapshot).
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db";
import { Store } from "../src/store";
import { buildLiveObserveMetrics } from "../src/analyzer";
import { LiveObserver } from "../src/observe-loop";
import { windowSkipAudit } from "../src/window-audit";
import { buildTestApp } from "./helpers";

const CAPACITY = { advertised: 8, funded: 8, effective: 6, probeOk: true, runners: 2, source: "probe" as const };

/** A stored live observe snapshot: 24 decides, 1 stale, 2 backpressure, 0
 * admission, 5 throttle (a funded rate decision) and 3 capacity drops. */
const SNAPSHOT = {
  decideCalls: 24,
  accepted: 2,
  maxFrames: 4,
  meanE2eMs: 5_602,
  maxE2eMs: 9_000,
  meanCadenceMs: 3_001,
  maxCadenceMs: 3_120,
  triggerFires: 0,
  cadenceFires: 24,
  skippedStaleWindows: 1,
  admissionSkippedWindows: 0,
  backpressureSkippedWindows: 2,
  throttleSkippedWindows: 5,
  capacityDroppedWindows: 3,
  supplySkippedWindows: 3,
  maxDecideInFlight: 2,
  droppedFrames: 4,
  decideCapacity: CAPACITY,
};

describe("AC1: the capacity-drop counter is its own persisted cause", () => {
  it("counts once per window and never double-counts the same window", () => {
    const obs = new LiveObserver({ cadenceS: 3, windowS: 10, maxFrames: 30, fps: 2, onDecide: async () => true });
    expect(obs.capacityDropCount()).toBe(0);
    obs.noteCapacityDropWindow(12);
    obs.noteCapacityDropWindow(12); // a retry re-reporting the SAME window
    expect(obs.capacityDropCount()).toBe(1);
    obs.noteCapacityDropWindow(15);
    obs.noteCapacityDropWindow(18);
    expect(obs.capacityDropCount()).toBe(3);
  });

  it("rides the observe snapshot beside the other four and leaves supply untouched", () => {
    const obs = new LiveObserver({ cadenceS: 3, windowS: 10, maxFrames: 30, fps: 2, onDecide: async () => true });
    obs.noteCapacityDropWindow(12);
    obs.noteCapacityDropWindow(15);
    const m = buildLiveObserveMetrics(obs);
    expect(m.capacityDroppedWindows).toBe(2);
    // The PO ruling on ADAAAA-7808: supply = stale + backpressure + admission.
    // A runner refusal is NOT a rail shortfall, so it must not move this number.
    expect(m.supplySkippedWindows).toBe(0);
    expect(m.decideCalls).toBe(0);
  });

  it("survives persistence (declared on the contract, not stripped by JobSchema.parse)", async () => {
    const db = new SqliteDb(":memory:");
    const s = new Store(db);
    const job = await s.createJob({ ownerId: "u1", source: "rtmp", sourceUrl: "rtmp://test/cap" });
    await s.patchJob(job.id, { status: "done", completedAt: new Date().toISOString(), observeMetrics: SNAPSHOT });
    const stored = await db.getJob(job.id);
    expect(stored!.observeMetrics!.capacityDroppedWindows).toBe(3);
    // And a restart hydrates it back onto the row.
    const reloaded = new Store(db);
    await reloaded.load();
    expect(reloaded.getJob(job.id)!.observeMetrics!.capacityDroppedWindows).toBe(3);
  });
});

describe("AC2/AC3: the derivation behind the admin readout", () => {
  const job = {
    id: "job-8425",
    status: "done" as const,
    source: "rtmp" as const,
    observeMetrics: SNAPSHOT as any,
  };

  it("shows the five causes side by side with decideCalls and the supply total", () => {
    const audit = windowSkipAudit(job);
    expect(audit.jobId).toBe("job-8425");
    expect(audit.decideCalls).toBe(24);
    expect(audit.staleSkippedWindows).toBe(1);
    expect(audit.backpressureSkippedWindows).toBe(2);
    expect(audit.admissionSkippedWindows).toBe(0);
    expect(audit.throttleSkippedWindows).toBe(5);
    expect(audit.capacityDroppedWindows).toBe(3);
    // The chip's number: stale + backpressure + admission, never the throttle or
    // the capacity drop.
    expect(audit.skippedWindows).toBe(3);
    expect(audit.observeRecorded).toBe(true);
  });

  it("shows the decide ceiling the job actually ran at", () => {
    const audit = windowSkipAudit(job);
    expect(audit.decideCapacity).toEqual(CAPACITY);
    expect(audit.decideCapacity!.advertised).toBe(8);
    expect(audit.decideCapacity!.effective).toBe(6);
  });

  it("reports NOT MEASURED for a record with no observe snapshot", () => {
    const audit = windowSkipAudit({ id: "legacy", status: "done", source: "file" });
    expect(audit.observeRecorded).toBe(false);
    expect(audit.decideCapacity).toBeNull();
    expect(audit.capacityDroppedWindows).toBeNull();
    // The supply total falls back to the sum of its causes on a record written
    // before `supplySkippedWindows` existed (same derivation as live-progress).
  });

  it("reports a pre-counter row's capacity-drop as null, never a measured 0", () => {
    const { capacityDroppedWindows: _drop, ...withoutCounter } = SNAPSHOT;
    const audit = windowSkipAudit({ id: "old", status: "done", source: "rtmp", observeMetrics: withoutCounter as any });
    // The other four WERE recorded on that row; only this cause was never counted,
    // so it must not read as "the runner refused nothing".
    expect(audit.capacityDroppedWindows).toBeNull();
    expect(audit.staleSkippedWindows).toBe(1);
    expect(audit.throttleSkippedWindows).toBe(5);
  });

  it("falls back to the cause sum for a pre-`supplySkippedWindows` record", () => {
    const { supplySkippedWindows: _drop, ...withoutSupply } = SNAPSHOT;
    const audit = windowSkipAudit({ id: "old", status: "done", source: "rtmp", observeMetrics: withoutSupply as any });
    expect(audit.skippedWindows).toBe(1 + 2 + 0);
  });
});

async function register(app: any, email: string): Promise<{ token: string; user: any }> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "password123" } });
  expect(r.statusCode).toBe(200);
  const body = r.json();
  return { token: body.token as string, user: body.user };
}

async function login(t: any, email: string, password: string): Promise<string> {
  const r = await t.app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

describe("AC2: the route-level readout and its role gate", () => {
  it("carries the audit on the admin detail payload and serves the admin route", async () => {
    const t = await buildTestApp();
    const { user } = await register(t.app, "audit8425-admin@test.dev");
    const admin = await login(t as any, t.cfg.adminEmail, t.cfg.adminPassword);
    const job = await t.store.createJob({ ownerId: user.id, source: "rtmp", sourceUrl: "rtmp://test/a" });
    await t.store.patchJob(job.id, { status: "done", completedAt: new Date().toISOString(), observeMetrics: SNAPSHOT });

    const route = await t.app.inject({
      method: "GET",
      url: `/jobs/${job.id}/window-audit`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(route.statusCode).toBe(200);
    const body = route.json();
    expect(body.jobId).toBe(job.id);
    expect(body.decideCalls).toBe(24);
    expect(body.staleSkippedWindows).toBe(1);
    expect(body.backpressureSkippedWindows).toBe(2);
    expect(body.admissionSkippedWindows).toBe(0);
    expect(body.throttleSkippedWindows).toBe(5);
    expect(body.capacityDroppedWindows).toBe(3);
    expect(body.skippedWindows).toBe(3);
    expect(body.decideCapacity).toEqual(CAPACITY);

    const detail = await t.app.inject({
      method: "GET",
      url: `/jobs/${job.id}/detail`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().windowAudit).toEqual(body);
    await t.app.close();
  });

  it("leaves the role=user payload and route unchanged", async () => {
    const t = await buildTestApp();
    const { token, user } = await register(t.app, "audit8425-user@test.dev");
    const job = await t.store.createJob({ ownerId: user.id, source: "rtmp", sourceUrl: "rtmp://test/b" });
    await t.store.patchJob(job.id, { status: "done", completedAt: new Date().toISOString(), observeMetrics: SNAPSHOT });

    const detail = await t.app.inject({
      method: "GET",
      url: `/jobs/${job.id}/detail`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detail.statusCode).toBe(200);
    const owner = detail.json();
    // The customer payload carries NO audit block and NO observe snapshot — the
    // live chip keeps its supply-only semantics.
    expect(owner.windowAudit).toBeUndefined();
    expect(owner.job.observeMetrics).toBeUndefined();
    expect(owner.liveProgress).toBeDefined();

    const route = await t.app.inject({
      method: "GET",
      url: `/jobs/${job.id}/window-audit`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(route.statusCode).toBe(403);

    const anon = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/window-audit` });
    expect(anon.statusCode).toBe(401);
    await t.app.close();
  });
});
