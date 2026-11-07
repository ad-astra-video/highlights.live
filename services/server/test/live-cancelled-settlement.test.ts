// ADAAAA-8310: a stopped LIVE stream must settle with the SAME observe fields
// whichever writer wins the stop race.
//
// Leg 8299 (content-fps 2, 2 streams, both `file-sim`, both stopped via
// `POST /jobs/:id/stop` at 18:36Z) stored two different record shapes:
//
//   216e586e  cancelled, decideCalls 70, costUsd 0.2319, progressLabel
//             "stopped (drain timeout)" — NO `observeMetrics`, NO `liveWatchMinutes`
//   d85aca45  cancelled, decideCalls 73, costUsd 0.2418, progressLabel "stopped"
//             — full `observeMetrics` (meanE2eMs 5 883.2 / maxE2eMs 15 656 /
//             throttle 32 / supply 1 / bp 1 / in-flight 4) + `liveWatchMinutes` 5.329
//
// Cause: the stop route waits `JOB_STOP_DRAIN_MS` (10 s) for the pass to unwind
// and settle itself; the drained sibling took 9.2 s, the other lost that race,
// so the route's fallback (`markJobCancelled`) settled it from the durable
// per-decide rows only. AC4's spend clause then had no stored-field denominator
// on half the leg.
//
// This suite pins the settlement module both writers now share:
//   - the drained and drain-timeout patches carry the same field set;
//   - `liveWatchMinutes` (the AC4 denominator) is on EVERY live cancelled row;
//   - `observeMetrics` is the pass's own snapshot, never a reconstruction;
//   - `costUsd` and the decide/confirm meter read from ONE source;
//   - the row survives `JobSchema.parse` (store.patchJob strips undeclared keys,
//     the ADAAAA-8242 failure mode that made fields vanish on the stored row).
import { describe, it, expect } from "vitest";
import { JobSchema, type Job } from "@highlights/events";
import { computeCostUsd, liveCancelledSettlement } from "../src/job-settlement";

const DECIDE_FEE = 0.0033;

/** The pass's own observe snapshot for one stream, shaped like the stored
 * `observeMetrics` block leg 8299 kept on stream 2. `decideCalls` is the decide
 * term the settlement bills. */
function passSnapshot(decideCalls: number, confirmCalls?: number): Job["observeMetrics"] {
  return {
    decideCalls,
    accepted: 0,
    maxFrames: 4,
    meanE2eMs: 5_883.2,
    maxE2eMs: 15_656,
    meanCadenceMs: 3_009.4,
    maxCadenceMs: 3_120,
    triggerFires: 0,
    cadenceFires: decideCalls,
    skippedStaleWindows: 0,
    admissionSkippedWindows: 0,
    maxDecideInFlight: 4,
    backpressureSkippedWindows: 1,
    throttleSkippedWindows: 32,
    supplySkippedWindows: 1,
    droppedFrames: 0,
    ...(confirmCalls !== undefined ? { confirmCalls, confirmDiveCount: confirmCalls, confirmDropped: 0 } : {}),
  } as Job["observeMetrics"];
}

const STAGE_A = {
  totalCandidates: 0,
  accepted: 0,
  rejected: 0,
  fpRate: 0,
  meanOnsetLatencyS: 0,
  maxOnsetLatencyS: 0,
  p50LatencyS: 0,
  p95LatencyS: 0,
  gemmaFpRate: 0,
  fpRateWithinBudget: true,
};

/** Strip the fields whose difference is the POINT (which writer settled) so the
 * remaining key set can be compared field for field. */
function shapeOf(patch: Record<string, unknown>): Record<string, unknown> {
  const { progressLabel: _label, ...rest } = patch;
  return rest;
}

describe("live cancelled settlement (ADAAAA-8310)", () => {
  const snapshot = passSnapshot(73, 2);
  const common = {
    decideFee: DECIDE_FEE,
    perceiveSessionS: 319.8,
    observeMetrics: snapshot,
    decideRows: 73,
    stageA: STAGE_A,
    persistedHighlights: 3,
    perceiveSessionId: "perceive-session-1",
    error: "stopped (cancelled via API)",
  };

  it("writes the same field set from the drained path and the drain-timeout path", () => {
    // Stream 2 of the leg: its pass unwound inside the grace and settled itself.
    const drained = liveCancelledSettlement({ ...common, progressLabel: "stopped" });
    // Stream 1: the route's fallback settled it with the snapshot the pass
    // published before it was pre-empted.
    const drainTimeout = liveCancelledSettlement({ ...common, progressLabel: "stopped (drain timeout)" });

    expect(Object.keys(shapeOf(drainTimeout)).sort()).toEqual(Object.keys(shapeOf(drained)).sort());
    expect(drainTimeout.observeMetrics).toEqual(drained.observeMetrics);
    expect(drainTimeout.liveWatchMinutes).toBe(drained.liveWatchMinutes);
    expect(drainTimeout.decideCalls).toBe(drained.decideCalls);
    expect(drainTimeout.costUsd).toBe(drained.costUsd);
    // The ONLY difference is the label that says which writer settled.
    expect(drained.progressLabel).toBe("stopped");
    expect(drainTimeout.progressLabel).toBe("stopped (drain timeout)");

    // Read both back through the store's schema (what `GET /jobs/:id` grades).
    const base = {
      ownerId: "owner-1",
      source: "file-sim",
      status: "cancelled",
      createdAt: "2026-11-07T18:31:54.446Z",
      startedAt: "2026-11-07T18:31:54.450Z",
    };
    const stored = [
      JobSchema.parse({ id: "216e586e-01a8-409b-881a-25fe12370961", ...base, ...drainTimeout }),
      JobSchema.parse({ id: "d85aca45-948e-45d0-af57-f3d9751a2c1c", ...base, ...drained }),
    ];
    const observeKeys = (j: Job) => Object.keys(j.observeMetrics ?? {}).sort();
    expect(observeKeys(stored[0])).toEqual(observeKeys(stored[1]));
    expect(stored[0].observeMetrics).toEqual(stored[1].observeMetrics);
    expect(stored[0].liveWatchMinutes).toBe(stored[1].liveWatchMinutes);
  });

  it("carries the AC4 stored-field denominator on a hard stop", () => {
    const row = liveCancelledSettlement({ ...common, progressLabel: "stopped (drain timeout)" });
    // 319.8 s of measured session = 5.33 live watch-minutes, written even though
    // the pass never reached its own completion branch.
    expect(row.liveWatchMinutes).toBe(5.33);
    expect(row.perceiveSessionS).toBe(319.8);
    expect(row.observeMetrics?.maxE2eMs).toBe(15_656);
    // Spend reconciles on the stored row alone: the decide term bills
    // decideCalls + the snapshot's confirmCalls, and the perceive term bills
    // perceiveSessionS — so $/decide is flat at the fee when confirm is 0.
    expect(row.costUsd).toBe(computeCostUsd(73, 319.8, DECIDE_FEE, 2));
    const noConfirm = liveCancelledSettlement({
      ...common,
      observeMetrics: passSnapshot(73),
      progressLabel: "stopped (drain timeout)",
    });
    // The stored-field rate a leg grades: costUsd / liveWatchMinutes is derivable
    // from the row with no collect-time echo.
    const ratePerHour = ((noConfirm.costUsd as number) / (noConfirm.liveWatchMinutes as number)) * 60;
    expect(ratePerHour).toBeCloseTo(2.722, 2);
    expect((noConfirm.costUsd as number) / (noConfirm.decideCalls as number)).toBeCloseTo(0.003312, 6);
  });

  it("never fabricates the observe block when the pass published no snapshot", () => {
    // A pass that never armed its decide observer (or died before it did).
    const row = liveCancelledSettlement({
      ...common,
      observeMetrics: undefined,
      decideRows: 70,
      progressLabel: "stopped (drain timeout)",
    });
    expect(row.observeMetrics).toBeUndefined();
    // ...but the watch clock and the measured decide rows are still durable.
    expect(row.liveWatchMinutes).toBe(5.33);
    expect(row.decideCalls).toBe(70);
    expect(row.costUsd).toBe(computeCostUsd(70, 319.8, DECIDE_FEE));
  });

  it("bills exactly the decide count the stored meter carries (one source)", () => {
    // A late decide row can land after the pass published its snapshot; the
    // stored meter is what a reader grades, so the cost term must agree with it.
    const row = liveCancelledSettlement({
      ...common,
      observeMetrics: passSnapshot(70, 2),
      decideRows: 71,
      progressLabel: "stopped (drain timeout)",
    });
    expect(row.decideCalls).toBe(70);
    expect(row.observeMetrics?.decideCalls).toBe(70);
    expect(row.observeMetrics?.confirmCalls).toBe(2);
    expect(row.costUsd).toBe(computeCostUsd(70, 319.8, DECIDE_FEE, 2));
  });

  it("claims no watch-minutes when the session clock never started", () => {
    const row = liveCancelledSettlement({
      ...common,
      perceiveSessionS: null,
      progressLabel: "stopped (drain timeout)",
    });
    expect(row.liveWatchMinutes).toBeUndefined();
    expect(row.perceiveSessionS).toBeUndefined();
  });

  it("survives the store's schema parse (patchJob strips undeclared keys)", () => {
    const parsed = JobSchema.parse({
      id: "216e586e-01a8-409b-881a-25fe12370961",
      ownerId: "owner-1",
      source: "file-sim",
      status: "cancelled",
      createdAt: "2026-11-07T18:31:54.446Z",
      startedAt: "2026-11-07T18:31:54.450Z",
      ...liveCancelledSettlement({ ...common, progressLabel: "stopped (drain timeout)" }),
    });
    expect(parsed.liveWatchMinutes).toBe(5.33);
    expect(parsed.observeMetrics?.decideCalls).toBe(73);
    expect(parsed.stage).toBe("cancelled");
    expect(parsed.progressLabel).toBe("stopped (drain timeout)");
  });
});
