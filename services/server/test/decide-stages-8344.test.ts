// ADAAAA-8344 AC1: the decide-call stage instrument must have a PINNED stage
// vocabulary and a CLOSED sum, and its summary must survive persistence.
//
// Why this test exists: the whole ticket rests on the stage numbers adding up to
// the measured call wall time. A drift in a key name (or a new stage added on
// one side only) would silently make an attribution report that does not close,
// which is exactly the failure mode ADAAAA-8300 phase 1 hit ("a non-model
// pre-decide residual of 787-5 315 ms that cannot be split from stored rows").
// So the keys are pinned literally, the sum identity is asserted on a synthetic
// record, and the persisted-row path is exercised end to end (Store.patchJob ->
// JobSchema.parse -> stored record), because a zod object STRIPS undeclared keys.
import { describe, expect, it } from "vitest";
import {
  DECIDE_STAGE_KEYS,
  DECIDE_STAGE_RING,
  DecideStageRecorder,
  decideStageSum,
  type DecideStageTimings,
} from "../src/decide-stage-timings.js";
import { buildTestApp } from "./helpers";

function sample(over: Partial<DecideStageTimings> = {}): DecideStageTimings {
  // On-chain unpaid-first shape: one 402 probe, one signer mint, one paid POST.
  const t: DecideStageTimings = {
    jobId: "job-stages",
    groupKey: "g103",
    payloadBytes: 48_000,
    payloadBuildMs: 3,
    serializeMs: 2,
    probeMs: 210,
    probeStatus: 402,
    probeSkipped: false,
    signerMs: 95,
    signerRetries: 0,
    paidMs: 2_400,
    paidTtfbMs: 1_850,
    paidQueueMs: 0,
    paidBodyMs: 540,
    paidParseMs: 10,
    probeCount: 1,
    paidRetries: 1,
    totalMs: 2_710,
    residualMs: 0,
    ...over,
  };
  t.residualMs =
    t.totalMs - (t.payloadBuildMs + t.serializeMs + t.probeMs + t.signerMs + t.paidMs);
  return t;
}

describe("decide stage instrument (ADAAAA-8344)", () => {
  it("pins the stage vocabulary a report table may rely on", () => {
    // Adding a stage is a report-contract change: update the work product too.
    expect([...DECIDE_STAGE_KEYS]).toEqual([
      "payloadBuildMs",
      "serializeMs",
      "probeMs",
      "signerMs",
      "paidMs",
      "residualMs",
    ]);
  });

  it("closes the sum on the measured call wall time", () => {
    const t = sample();
    expect(decideStageSum(t)).toBe(t.totalMs);
    // And the named stages + residual are the same total, by construction.
    const named = t.payloadBuildMs + t.serializeMs + t.probeMs + t.signerMs + t.paidMs;
    expect(named + t.residualMs).toBe(t.totalMs);
    // The paid stage's sub-stages stay inside it (they are NOT additive).
    expect(t.paidTtfbMs + t.paidQueueMs + t.paidBodyMs + t.paidParseMs).toBeLessThanOrEqual(t.paidMs);
  });

  it("reports the securing leg separately from the paid request", () => {
    const rec = new DecideStageRecorder();
    rec.record(sample({ totalMs: 2_710 }));
    rec.record(sample({ totalMs: 3_000, probeMs: 300, signerMs: 100 }));
    const s = rec.summary("job-stages")!;
    expect(s.calls).toBe(2);
    // p50 probe/signer over two samples of 210/300 and 95/100 (nearest rank).
    expect(s.stages.probeMs.p50).toBe(210);
    expect(s.stages.signerMs.p50).toBe(95);
    expect(s.stages.probeMs.max).toBe(300);
    expect(s.stages.totalMs.p50).toBe(2_710);
    expect(s.probesPerDecide).toBe(1);
    expect(s.paidShare).toBeGreaterThan(0.8);
    // securing = (210 + 95) / 2 710
    expect(s.securingShare).toBeCloseTo(305 / 2_710, 3);
    expect(s.closureP50).toBeCloseTo(1, 6);
  });

  it("counts a second probe (TicketParams expiry) in probesPerDecide", () => {
    const rec = new DecideStageRecorder();
    rec.record(sample({ probeCount: 1 }));
    rec.record(sample({ probeCount: 2, probeMs: 420, probeStatus: 402 }));
    expect(rec.summary("job-stages")!.probesPerDecide).toBeCloseTo(1.5, 3);
  });

  it("keeps the per-job ring bounded (last N calls only)", () => {
    const rec = new DecideStageRecorder();
    for (let i = 0; i < DECIDE_STAGE_RING + 25; i++) rec.record(sample({ groupKey: `g${i}` }));
    const xs = rec.samples("job-stages");
    expect(xs.length).toBe(DECIDE_STAGE_RING);
    // The oldest samples were dropped, the newest kept.
    expect(xs[0].groupKey).toBe(`g25`);
    expect(xs[xs.length - 1].groupKey).toBe(`g${DECIDE_STAGE_RING + 24}`);
  });

  it("never persists a negative residual (the stop-patch regression)", () => {
    // Leg `ab00b316` failed its stop patch because one call's stage clocks
    // overlapped its outer wall by a few ms and `residualMs` came out negative,
    // which `min(0)` rejected for the WHOLE record (job stayed `active`).
    // Clamping is asserted here, and the over-count is reported by closure > 1.
    const rec = new DecideStageRecorder();
    rec.record(sample({ totalMs: 10, payloadBuildMs: 8, serializeMs: 3, probeMs: 5, signerMs: 1, paidMs: 2 }));
    const s = rec.summary("job-stages")!;
    expect(s.stages.residualMs.max).toBe(0);
    expect(s.stages.residualMs.p50).toBe(0);
    expect(s.closureP50).toBeGreaterThan(1);
  });

  it("returns undefined for a job with no instrumented decide", () => {
    expect(new DecideStageRecorder().summary("job-nope")).toBeUndefined();
  });

  it("survives the stored job record (decideStages is not stripped)", async () => {
    const { store } = await buildTestApp();
    const job = await store.createJob({ ownerId: "owner-1", source: "file" });
    const rec = new DecideStageRecorder();
    rec.record(sample({ jobId: job.id }));
    rec.record(sample({ jobId: job.id, totalMs: 2_900 }));
    const decideStages = rec.summary(job.id)!;
    await store.patchJob(job.id, {
      status: "done",
      observeMetrics: {
        decideCalls: 2,
        accepted: 1,
        maxFrames: 4,
        meanE2eMs: 2_800,
        maxE2eMs: 2_900,
        meanCadenceMs: 3_000,
        maxCadenceMs: 3_000,
        decideStages,
      },
    });
    const stored = store.getJob(job.id)!;
    expect(stored.observeMetrics?.decideStages).toBeDefined();
    expect(stored.observeMetrics!.decideStages!.calls).toBe(2);
    expect(stored.observeMetrics!.decideStages!.stages.probeMs.p50).toBe(210);
    expect(stored.observeMetrics!.decideStages!.probesPerDecide).toBe(1);
    // An OLD record (no decideStages) still parses — the field is optional.
    await store.patchJob(job.id, {
      observeMetrics: {
        decideCalls: 1,
        accepted: 0,
        maxFrames: 4,
        meanE2eMs: 1_000,
        maxE2eMs: 1_000,
        meanCadenceMs: 3_000,
        maxCadenceMs: 3_000,
      },
    });
    expect(store.getJob(job.id)!.observeMetrics!.decideStages).toBeUndefined();
  });
});
