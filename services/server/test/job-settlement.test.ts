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
  billableConfirmCalls,
  buildTerminalAccountingPatch,
  computeCostUsd,
  PERCEIVE_PER_HOUR_USD,
} from "../src/job-settlement";
import { SqliteDb } from "../src/db";
import { Store } from "../src/store";

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

// ADAAAA-8242: the confirm METER and the confirm COST TERM must be the same
// number on the terminal patch — the level at which leg `0705e2b5` failed.
//
// That leg (cancelled, 362.5 s of perceive) stored `costUsd = 0.2485`, i.e.
// exactly 75 billable decide-service calls (`0.0033 * (73 + 2) + 362.5/3600 *
// 0.01`), while the SAME patch's `observeMetrics` carried no confirm key: the
// three counters were undeclared on the schema and were stripped on the way to
// the row (fixed additively by ADAAAA-8219). A stored-row grade read "no dives"
// for a leg that paid for two. These tests pin the structural rule that makes
// that impossible: a snapshot's `confirmCalls` is the ONE source for both the
// cost term and the persisted meter, and the identity
// `costUsd == decideFee*(decideCalls + observeMetrics.confirmCalls) + perceive`
// holds on the patch itself and on the row read back from the store.
describe("confirm term ↔ persisted meter identity (ADAAAA-8242)", () => {
  const DECIDE_FEE = 0.0033;
  /** The armed leg's own snapshot shape (73 decides, 2 confirm dives). */
  const armedSnapshot = {
    decideCalls: 73,
    accepted: 6,
    maxFrames: 4,
    meanE2eMs: 4662,
    maxE2eMs: 18987,
    meanCadenceMs: 4916.7,
    maxCadenceMs: 8000,
    triggerFires: 51,
    cadenceFires: 22,
    confirmCalls: 2,
    confirmDiveCount: 2,
    confirmDropped: 0,
  };

  it("bills exactly the count the patch persists, so the leg's row reconciles", () => {
    const patch = buildTerminalAccountingPatch({
      status: "cancelled",
      decideFee: DECIDE_FEE,
      decideCalls: armedSnapshot.decideCalls,
      perceiveSessionS: 362.5,
      observeMetrics: armedSnapshot,
      nowMs: NOW,
    });
    // The measured (not inferred) number QA read off the leg.
    expect(patch.costUsd).toBe(0.2485);
    // The identity, recomputed from the patch's OWN persisted meter.
    const m = patch.observeMetrics!;
    expect(patch.costUsd).toBe(
      computeCostUsd(m.decideCalls, patch.perceiveSessionS!, DECIDE_FEE, m.confirmCalls!)
    );
    expect(m.confirmCalls).toBe(2);
    expect(m.confirmDiveCount).toBe(2);
    expect(m.confirmDropped).toBe(0);
  });

  it("cannot bill a confirm count the persisted snapshot does not carry", () => {
    // A caller that computes its own count MUST NOT out-vote the snapshot: the
    // snapshot is the field a stored-row grade reads, so it decides the cost.
    const stale = { ...armedSnapshot, confirmCalls: 0, confirmDiveCount: 0 };
    const patch = buildTerminalAccountingPatch({
      status: "done",
      decideFee: DECIDE_FEE,
      decideCalls: 73,
      confirmCalls: 2,
      perceiveSessionS: 362.5,
      observeMetrics: stale,
      nowMs: NOW,
    });
    expect(patch.observeMetrics!.confirmCalls).toBe(0);
    expect(patch.costUsd).toBe(computeCostUsd(73, 362.5, DECIDE_FEE, 0));
  });

  it("stamps confirmCalls onto a snapshot that lost the block, never a fabricated split", () => {
    // The pre-8219 writer shape: a snapshot without the counter plus a measured
    // count. The cost term bills it, so the meter has to say so as well.
    const { confirmCalls: _c, confirmDiveCount: _d, confirmDropped: _dr, ...blockless } = armedSnapshot;
    const patch = buildTerminalAccountingPatch({
      status: "cancelled",
      decideFee: DECIDE_FEE,
      decideCalls: 73,
      confirmCalls: 2,
      perceiveSessionS: 362.5,
      observeMetrics: blockless,
      nowMs: NOW,
    });
    expect(patch.costUsd).toBe(0.2485);
    expect(patch.observeMetrics!.confirmCalls).toBe(2);
    // Only the call count is known here; the dive/dropped split belongs to the
    // pass snapshot and stays ABSENT rather than fabricated (ADAAAA-8223).
    expect(patch.observeMetrics!.confirmDiveCount).toBeUndefined();
    expect(patch.observeMetrics!.confirmDropped).toBeUndefined();
  });

  it("bills decides only when the lane never ran (legacy row unchanged)", () => {
    const { confirmCalls: _c, confirmDiveCount: _d, confirmDropped: _dr, ...legacy } = armedSnapshot;
    const patch = buildTerminalAccountingPatch({
      status: "cancelled",
      decideFee: DECIDE_FEE,
      decideCalls: 73,
      perceiveSessionS: 362.5,
      observeMetrics: legacy,
      nowMs: NOW,
    });
    // 73 * 0.0033 + 362.5/3600 * 0.01 — the leg's cost WITHOUT the confirm term.
    expect(patch.costUsd).toBe(0.2419);
    expect(patch.observeMetrics!.confirmCalls).toBeUndefined();
    expect(billableConfirmCalls(legacy)).toBe(0);
  });

  it("survives the store write on a `cancelled` row (the leg's status)", async () => {
    const db = new SqliteDb(":memory:");
    const store = new Store(db);
    const job = await store.createJob({ ownerId: "u1", source: "file", sourceUrl: "/data/clips/kids300_7935.mp4" });
    const patch = buildTerminalAccountingPatch({
      status: "cancelled",
      decideFee: DECIDE_FEE,
      decideCalls: 73,
      perceiveSessionS: 362.5,
      observeMetrics: armedSnapshot,
      error: "stopped (cancelled via API)",
      nowMs: NOW,
    });
    await store.patchJob(job.id, patch);

    const stored = await db.getJob(job.id);
    const m = stored!.observeMetrics!;
    // The meter QA reads off `record` exists and reconciles to the billed cost.
    expect(m.confirmCalls).toBe(2);
    expect(m.confirmDiveCount).toBe(2);
    expect(m.confirmDropped).toBe(0);
    expect(stored!.costUsd).toBe(
      computeCostUsd(m.decideCalls, stored!.perceiveSessionS!, DECIDE_FEE, m.confirmCalls!)
    );
    expect(JSON.stringify(m)).toContain("confirmCalls");
    await db.close();
  });
});
