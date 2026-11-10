// ADAAAA-8487 (AC-B/AC-C): the leg grader's shape gates.
//
// These cases are the two hand-grade mistakes this ticket actually made, pinned
// so a monitor run cannot repeat them:
//
//   - the 8483 reference leg delivered 9 rows over 545.3 s, so a 320 s stop
//     truncates it to 7 rows and p95(n=7) must read UNMEASURED, not FAIL;
//   - a natural leg under 600 s lands ~4 rows, so it too must read UNMEASURED.
//
// The fixture is the real 8483 arm (`2c4124fe-…`) delivered rows, so the PASS /
// FAIL arithmetic is checked against numbers the ticket was opened from.
import { describe, it, expect } from "vitest";
import { gradeLiveLeg, LIVE_LEG_BARS } from "../src/live-leg-grade";
import { deliveredLatencySummary } from "../src/live-delivery";

// The nine delivered rows stored on arm 2c4124fe (ADAAAA-8483). They predate
// ADAAAA-8495, so none carries `localizeOffsetMs` — the stage sum therefore
// cannot reconstruct the total on its own, which is what the mismatch counter
// must report rather than hide.
const ARM_2C4124FE_ROWS = [
  { triggerTs: 101.66666666666666, deliveredLatencyMs: 17_531, fireLagMs: 0, decideE2eMs: 2_620, acceptWaitMs: 0, acceptMs: 1, persistAckMs: 17_910 },
  { triggerTs: 160.66666666666666, deliveredLatencyMs: 29_535, fireLagMs: 0, decideE2eMs: 2_245, acceptWaitMs: 0, acceptMs: 0, persistAckMs: 33_290 },
  { triggerTs: 169.66666666666666, deliveredLatencyMs: 39_691, fireLagMs: 0, decideE2eMs: 5_192, acceptWaitMs: 18_253, acceptMs: 2, persistAckMs: 19_244 },
  { triggerTs: 227.66666666666666, deliveredLatencyMs: 8_347, fireLagMs: 0, decideE2eMs: 2_308, acceptWaitMs: 0, acceptMs: 3, persistAckMs: 11_036 },
  { triggerTs: 286.66666666666663, deliveredLatencyMs: 9_605, fireLagMs: 0, decideE2eMs: 7_526, acceptWaitMs: 0, acceptMs: 1, persistAckMs: 5_078 },
  { triggerTs: 302.66666666666663, deliveredLatencyMs: 6_550, fireLagMs: 0, decideE2eMs: 2_180, acceptWaitMs: 0, acceptMs: 1, persistAckMs: 10_369 },
  { triggerTs: 315.66666666666663, deliveredLatencyMs: 11_306, fireLagMs: 324, decideE2eMs: 2_114, acceptWaitMs: 0, acceptMs: 2, persistAckMs: 11_866 },
  { triggerTs: 398.66666666666663, deliveredLatencyMs: 9_512, fireLagMs: 0, decideE2eMs: 2_317, acceptWaitMs: 0, acceptMs: 2, persistAckMs: 13_193 },
  { triggerTs: 456, deliveredLatencyMs: 12_044, fireLagMs: 0, decideE2eMs: 2_475, acceptWaitMs: 0, acceptMs: 1, persistAckMs: 18_568 },
];

// A quiet leg that meets every bar: 9 rows, p50 2.0 s, p95 4.0 s, 480 s funded.
const QUIET_ROWS = ARM_2C4124FE_ROWS.map((row, i) => ({
  ...row,
  deliveredLatencyMs: i === 8 ? 4_000 : 2_000,
  persistAckMs: i === 8 ? 4_000 : 2_000,
  fireLagMs: 0,
  decideE2eMs: 0,
  acceptWaitMs: 0,
  acceptMs: 0,
}));

describe("gradeLiveLeg shape gates (ADAAAA-8487)", () => {
  it("grades the 8483 reference leg FAIL on AC-B at n=9 and reports the stored p50/p95", () => {
    const g = gradeLiveLeg({
      mode: "funded",
      rows: ARM_2C4124FE_ROWS,
      startedAt: "2026-11-09T12:54:53.957Z",
      finishedAt: "2026-11-09T13:03:59.284Z",
      perceiveSessionS: 544.5,
      decideP50Ms: 1_389,
      accepted: 9,
      candidates: 9,
      deliveredGoalRows: 4,
    });

    expect(g.n).toBe(9);
    expect(g.p50Ms).toBe(11_306);
    expect(g.p95Ms).toBe(35_629);
    expect(g.maxMs).toBe(39_691);
    expect(g.durationS).toBeCloseTo(545.327, 2);
    expect(g.acB.status).toBe("FAIL");
    expect(g.acC?.status).toBe("FAIL");
    expect(g.acC?.reasons.some((r) => r.startsWith("delivered_goal_rows"))).toBe(true);
    expect(g.verdict).toBe("FAIL");
    // metered/wall is the 8483 inflation the funded cap must evidence.
    expect(g.meteredToWallRatio).toBeGreaterThan(0.99);
    expect(g.meteredToWallRatio).toBeLessThan(1.01);
  });

  it("a 320 s stop truncates the same leg to n=7 and must read UNMEASURED, not FAIL", () => {
    const truncated = ARM_2C4124FE_ROWS.filter((r) => r.triggerTs < 320);
    expect(truncated).toHaveLength(7);

    const g = gradeLiveLeg({
      mode: "funded",
      rows: truncated,
      durationS: 320,
      decideP50Ms: 1_389,
      accepted: 7,
      deliveredGoalRows: 0,
    });

    expect(g.acB.status).toBe("UNMEASURED");
    expect(g.acB.reasons.some((r) => r.startsWith("n_below_9"))).toBe(true);
    // p95 is still computed, but it is not a graded verdict.
    expect(g.p95Ms).toBeGreaterThan(LIVE_LEG_BARS.p95Ms);
    expect(g.verdict).toBe("UNMEASURED");
  });

  it("a natural leg under the 600 s floor is UNMEASURED even when its rows look good", () => {
    const g = gradeLiveLeg({
      mode: "natural",
      rows: ARM_2C4124FE_ROWS,
      durationS: 545.3,
      decideP50Ms: 2_196,
      accepted: 9,
      deliveredGoalRows: 0,
    });

    expect(g.floorS).toBe(LIVE_LEG_BARS.naturalFloorS);
    expect(g.acB.status).toBe("UNMEASURED");
    expect(g.acB.reasons.some((r) => r.startsWith("duration_below_floor"))).toBe(true);
  });

  it("the same 545.3 s leg is gradeable as a funded leg (480 s floor)", () => {
    const g = gradeLiveLeg({
      mode: "funded",
      rows: ARM_2C4124FE_ROWS,
      durationS: 545.3,
      decideP50Ms: 2_196,
      accepted: 9,
      deliveredGoalRows: 0,
    });

    expect(g.floorS).toBe(LIVE_LEG_BARS.fundedFloorS);
    expect(g.acB.status).toBe("FAIL");
  });

  it("an empty window is a re-arm: UNMEASURED, never FAIL", () => {
    const g = gradeLiveLeg({ mode: "natural", rows: [], durationS: 700, decideP50Ms: 2_200, accepted: 0, deliveredGoalRows: 0 });

    expect(g.n).toBe(0);
    expect(g.acB.status).toBe("UNMEASURED");
    expect(g.acB.reasons[0]).toMatch(/^empty_window/);
    expect(g.verdict).toBe("UNMEASURED");
  });

  it("a decide-bound leg (decide p50 > 3 s) is UNMEASURED: the delivery bar is the wrong stage", () => {
    const g = gradeLiveLeg({
      mode: "funded",
      rows: QUIET_ROWS,
      durationS: 480,
      decideP50Ms: 4_724,
      accepted: 9,
      deliveredGoalRows: 0,
    });

    expect(g.acB.status).toBe("UNMEASURED");
    expect(g.acB.reasons.some((r) => r.startsWith("decide_bound"))).toBe(true);
  });

  it("flags the decide p50 gate as not evaluated when no decide p50 is supplied", () => {
    const g = gradeLiveLeg({ mode: "funded", rows: QUIET_ROWS, durationS: 480, accepted: 9, deliveredGoalRows: 0 });

    expect(g.acB.reasons.some((r) => r.startsWith("decide_p50_not_evaluated"))).toBe(true);
  });

  it("PASSes a quiet funded leg that meets every bar", () => {
    const g = gradeLiveLeg({
      mode: "funded",
      rows: QUIET_ROWS,
      durationS: 480,
      decideP50Ms: 2_196,
      accepted: 9,
      candidates: 147,
      deliveredGoalRows: 0,
    });

    expect(g.p50Ms).toBe(2_000);
    // The percentile interpolates (live-delivery's own arithmetic): on n=9 the
    // p95 rank is 7.6, i.e. 2000 + 0.6 * (4000 - 2000) = 3200 — a p95 is not
    // required to land on a sample of the leg.
    expect(g.p95Ms).toBe(3_200);
    expect(g.p95Ms).toBe(deliveredLatencySummary(QUIET_ROWS as never).p95Ms);
    expect(g.acB.status).toBe("PASS");
    expect(g.acC?.status).toBe("PASS");
    expect(g.acC?.ratioAtLeastBaseline).toBe(true);
    expect(g.verdict).toBe("PASS");
  });

  it("fails AC-C on accepted < 9 even when delivery is inside the bar", () => {
    const g = gradeLiveLeg({
      mode: "funded",
      rows: QUIET_ROWS,
      durationS: 480,
      decideP50Ms: 2_196,
      accepted: 8,
      deliveredGoalRows: 0,
    });

    expect(g.acB.status).toBe("PASS");
    expect(g.acC?.status).toBe("FAIL");
    expect(g.verdict).toBe("FAIL");
  });

  it("omits AC-C when it has no accepted/GOAL inputs instead of inventing a pass", () => {
    const g = gradeLiveLeg({ mode: "funded", rows: QUIET_ROWS, durationS: 480, decideP50Ms: 2_196 });

    expect(g.acC).toBeUndefined();
    expect(g.verdict).toBe("PASS");
  });

  it("reads p50/p95 with deliveredLatencySummary's own percentile arithmetic", () => {
    const summary = deliveredLatencySummary(ARM_2C4124FE_ROWS as never);
    const g = gradeLiveLeg({ mode: "funded", rows: ARM_2C4124FE_ROWS, durationS: 545.3, decideP50Ms: 1_389 });

    expect(g.p50Ms).toBe(summary.p50Ms);
    expect(g.p95Ms).toBe(summary.p95Ms);
    expect(g.maxMs).toBe(summary.maxMs);
  });

  it("counts rows whose stage sum cannot reconstruct the total (pre-8495 schema strip)", () => {
    const stripped = gradeLiveLeg({ mode: "funded", rows: ARM_2C4124FE_ROWS, durationS: 545.3, decideP50Ms: 1_389 });
    expect(stripped.stageSumMismatchRows).toBe(9);

    const withOffset = gradeLiveLeg({
      mode: "funded",
      rows: [{ ...ARM_2C4124FE_ROWS[0], localizeOffsetMs: -3_000 }],
      durationS: 480,
      decideP50Ms: 1_389,
    });
    expect(withOffset.stageSumMismatchRows).toBe(0);
  });

  // ADAAAA-8487 / ADAAAA-8529 item 3: a live `done` record used to carry no end
  // stamp, so every funded leg graded `duration_unknown` against the 480 s floor
  // and the harness wall clock had to be pasted in by hand. The settlements now
  // stamp `endedAt`; the grader must read it, and must still grade a pre-fix leg
  // whose only duration is the harness's own clock.
  it("derives the duration from startedAt/endedAt and prefers endedAt over finishedAt", () => {
    const g = gradeLiveLeg({
      mode: "funded",
      rows: QUIET_ROWS,
      startedAt: "2026-11-09T22:28:08.000Z",
      endedAt: "2026-11-09T22:36:08.000Z",
      // finalization tail after accrual: must NOT be counted in the duration
      finishedAt: "2026-11-09T22:36:38.000Z",
      decideP50Ms: 2_274,
      accepted: 6,
      deliveredGoalRows: 0,
    });
    expect(g.durationS).toBeCloseTo(480, 3);
  });

  it("grades a pre-fix leg from the harness duration instead of duration_unknown", () => {
    const noStamps = gradeLiveLeg({ mode: "funded", rows: QUIET_ROWS, decideP50Ms: 1_400, accepted: 9, deliveredGoalRows: 0 });
    expect(noStamps.durationS).toBeNull();
    expect(noStamps.acB.reasons.some((r) => r.startsWith("duration_unknown"))).toBe(true);

    const harnessClock = gradeLiveLeg({ mode: "funded", rows: QUIET_ROWS, durationS: 480, decideP50Ms: 1_400, accepted: 9, deliveredGoalRows: 0 });
    expect(harnessClock.durationS).toBe(480);
    expect(harnessClock.acB.reasons.some((r) => r.startsWith("duration_unknown"))).toBe(false);
  });
});
