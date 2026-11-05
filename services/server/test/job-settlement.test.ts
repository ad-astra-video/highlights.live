// ADAAAA-8061: the terminal accounting shape every end-of-job path uses.
//
// The contract under test: a job that ends without a clean completion still
// carries a spend record, and the record distinguishes three states —
//   measured       (`decideCalls` + `costUsd`)
//   partially      (`costUnavailable` + `partialCostUsd`)
//   never measured (`costUnavailable` only, NEVER `costUsd: 0`)
// — so Livepeer spend is attributable from the row alone.
import { describe, it, expect } from "vitest";
import {
  accruedSecondsSince,
  buildTerminalAccountingPatch,
  computeCostUsd,
  PERCEIVE_PER_HOUR_USD,
} from "../src/job-settlement";

const NOW = Date.parse("2026-11-05T06:00:00.000Z");

describe("computeCostUsd", () => {
  it("prices decide calls at DECIDE_FEE and perceive seconds at the list rate", () => {
    // 65 decides @ $0.01 = $0.65; 300 s of perceive @ $0.01/hr = $0.000833…
    expect(computeCostUsd(65, 300, 0.01)).toBe(0.6508);
  });

  it("is exactly the perceive leg when no decide was made", () => {
    expect(computeCostUsd(0, 3600, 0.01)).toBe(0.01);
    expect(PERCEIVE_PER_HOUR_USD).toBe(0.01);
  });

  it("never returns a negative cost for junk inputs", () => {
    expect(computeCostUsd(-5, -100, 0.01)).toBe(0);
  });
});

describe("buildTerminalAccountingPatch", () => {
  it("writes endedAt + measured decideCalls + costUsd when the count is known", () => {
    const patch = buildTerminalAccountingPatch({
      status: "failed",
      decideFee: 0.01,
      decideCalls: 65,
      perceiveSessionS: 300,
      nowMs: NOW,
      error: "media-session-lost (boot sweep)",
    });
    expect(patch.status).toBe("failed");
    expect(patch.endedAt).toBe("2026-11-05T06:00:00.000Z");
    expect(patch.finishedAt).toBe("2026-11-05T06:00:00.000Z");
    expect(patch.decideCalls).toBe(65);
    expect(patch.perceiveSessionS).toBe(300);
    expect(patch.costUsd).toBe(0.6508);
    expect(patch.costUnavailable).toBeUndefined();
    expect(patch.partialCostUsd).toBeUndefined();
    expect(patch.error).toContain("media-session-lost");
    // A failed/cancelled row is not a completed row.
    expect(patch.completedAt).toBeUndefined();
  });

  it("settles a swept job as cancelled-with-cost rather than a bare failed", () => {
    const patch = buildTerminalAccountingPatch({
      status: "cancelled",
      decideFee: 0.01,
      decideCalls: 77,
      perceiveSessionS: 229,
      nowMs: NOW,
      extra: { stage: "cancelled", progressLabel: "stopped" },
    });
    expect(patch.decideCalls).toBe(77);
    expect(patch.costUsd).toBe(0.7706);
    expect(patch.endedAt).toBe("2026-11-05T06:00:00.000Z");
    expect(patch.stage).toBe("cancelled");
  });

  it("writes costUnavailable + partialCostUsd (never costUsd) when the count is unmeasured", () => {
    const patch = buildTerminalAccountingPatch({
      status: "failed",
      decideFee: 0.01,
      decideCalls: null,
      perceiveSessionS: 300,
      nowMs: NOW,
      costUnavailableReason: "decide-count-not-persisted",
    });
    // "Not measured" must never be readable as a genuine zero.
    expect(patch.costUsd).toBeUndefined();
    expect(patch.costUnavailable).toBe("decide-count-not-persisted");
    // …but the perceive leg we DO know is still recorded.
    expect(patch.partialCostUsd).toBe(0.0008);
    expect(patch.perceiveSessionS).toBe(300);
    expect(patch.endedAt).toBe("2026-11-05T06:00:00.000Z");
  });

  it("writes only costUnavailable when neither leg is known", () => {
    const patch = buildTerminalAccountingPatch({
      status: "failed",
      decideFee: 0.01,
      decideCalls: null,
      perceiveSessionS: null,
      nowMs: NOW,
    });
    expect(patch.costUsd).toBeUndefined();
    expect(patch.partialCostUsd).toBeUndefined();
    expect(patch.costUnavailable).toBe("decide-count-not-persisted");
    expect(patch.endedAt).toBe("2026-11-05T06:00:00.000Z");
  });

  it("a measured settlement clears any stale unavailable markers", () => {
    const patch = buildTerminalAccountingPatch({
      status: "done",
      decideFee: 0.01,
      decideCalls: 10,
      perceiveSessionS: 120,
      nowMs: NOW,
    });
    expect(patch.costUsd).toBe(0.1003);
    // `undefined` (not a stale string) so the persisted row cannot contradict
    // its own measured `costUsd`.
    expect(patch.costUnavailable).toBeUndefined();
    expect(patch.completedAt).toBe("2026-11-05T06:00:00.000Z");
  });

  it("carries the observe-metrics snapshots through when supplied", () => {
    const observeMetrics = {
      decideCalls: 12,
      accepted: 2,
      maxFrames: 30,
      meanE2eMs: 1,
      maxE2eMs: 2,
      meanCadenceMs: 3000,
      maxCadenceMs: 3100,
    };
    const patch = buildTerminalAccountingPatch({
      status: "cancelled",
      decideFee: 0.01,
      decideCalls: 12,
      perceiveSessionS: 200,
      observeMetrics,
      nowMs: NOW,
    });
    expect(patch.observeMetrics).toEqual(observeMetrics);
  });
});

describe("accruedSecondsSince", () => {
  it("measures the accrual window from an ISO stamp", () => {
    expect(accruedSecondsSince("2026-11-05T05:55:00.000Z", NOW)).toBe(300);
  });

  it("returns null for a missing or unparseable stamp and never goes negative", () => {
    expect(accruedSecondsSince(undefined, NOW)).toBeNull();
    expect(accruedSecondsSince("not-a-date", NOW)).toBeNull();
    expect(accruedSecondsSince("2026-11-05T07:00:00.000Z", NOW)).toBe(0);
  });
});
