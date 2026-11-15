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

// ---------------------------------------------------------------------------
// ADAAAA-8529 item 3: the duration of a live leg.
//
// A live `done` record carries NO startedAt/endedAt/finishedAt (bundle
// `recordTimestamps` of job 7d99d651: all three null) while the harness stopped
// the leg at exactly 480 s. Grade the record alone and every funded live leg
// reads `duration_unknown` against the 480 s floor.
//
// These six rows are that leg's stored `deliveredLatency.rows`; `persistAckMs 0`
// on 6/6 is the ADAAAA-8495 deferred-cut fix, and `localizeOffsetMs 0` means the
// stage sum reconstructs the total.
// ---------------------------------------------------------------------------
const LEG_8516_ROWS = [
  { triggerTs: 104.597, deliveredLatencyMs: 4_228, fireLagMs: 444, decideE2eMs: 3_774, acceptWaitMs: 0, acceptMs: 10, persistAckMs: 0, localizeOffsetMs: 0 },
  { triggerTs: 157.129, deliveredLatencyMs: 3_644, fireLagMs: 888, decideE2eMs: 2_749, acceptWaitMs: 1, acceptMs: 6, persistAckMs: 0, localizeOffsetMs: 0 },
  { triggerTs: 283.931, deliveredLatencyMs: 3_764, fireLagMs: 735, decideE2eMs: 3_027, acceptWaitMs: 0, acceptMs: 2, persistAckMs: 0, localizeOffsetMs: 0 },
  { triggerTs: 404.762, deliveredLatencyMs: 2_724, fireLagMs: 538, decideE2eMs: 2_182, acceptWaitMs: 0, acceptMs: 4, persistAckMs: 0, localizeOffsetMs: 0 },
  { triggerTs: 463.664, deliveredLatencyMs: 3_041, fireLagMs: 768, decideE2eMs: 2_268, acceptWaitMs: 0, acceptMs: 5, persistAckMs: 0, localizeOffsetMs: 0 },
  { triggerTs: 477.13, deliveredLatencyMs: 2_592, fireLagMs: 354, decideE2eMs: 2_235, acceptWaitMs: 0, acceptMs: 3, persistAckMs: 0, localizeOffsetMs: 0 },
];

describe("gradeLiveLeg duration (ADAAAA-8529 item 3)", () => {
  it("a live record with no timestamps reads duration_unknown, not a FAIL", () => {
    const g = gradeLiveLeg({
      mode: "funded",
      rows: LEG_8516_ROWS,
      // The record carries none of these:
      startedAt: undefined,
      finishedAt: undefined,
      decideP50Ms: 2_696,
      accepted: 6,
      deliveredGoalRows: 4,
    });

    expect(g.durationS).toBeNull();
    expect(g.durationSource).toBe("unknown");
    expect(g.acB.reasons.some((r) => r.startsWith("duration_unknown"))).toBe(true);
    expect(g.verdict).toBe("UNMEASURED");
  });

  it("the harness leg window supplies the duration the record cannot", () => {
    const g = gradeLiveLeg({
      mode: "funded",
      rows: LEG_8516_ROWS,
      durationS: 480,
      durationSource: "harness_evidence",
      decideP50Ms: 2_696,
      accepted: 6,
      deliveredGoalRows: 4,
    });

    expect(g.durationS).toBe(480);
    expect(g.durationSource).toBe("harness_evidence");
    // The duration gate no longer blocks: 480 s is exactly the funded floor.
    expect(g.acB.reasons.some((r) => r.startsWith("duration_unknown"))).toBe(false);
    expect(g.acB.reasons.some((r) => r.startsWith("duration_below_floor"))).toBe(false);
    // The leg is still UNMEASURED — on n=6, which is the honest reason.
    expect(g.acB.reasons.some((r) => r.startsWith("n_below_9"))).toBe(true);
    expect(g.verdict).toBe("UNMEASURED");
  });

  it("an explicit --duration-s is published as source input", () => {
    const g = gradeLiveLeg({
      mode: "funded",
      rows: QUIET_ROWS,
      durationS: 480,
      durationSource: "input",
      decideP50Ms: 2_196,
      accepted: 9,
      deliveredGoalRows: 0,
    });

    expect(g.durationSource).toBe("input");
    expect(g.durationS).toBe(480);
    expect(g.verdict).toBe("PASS");
  });

  it("record timestamps are still used, and say so", () => {
    const g = gradeLiveLeg({
      mode: "funded",
      rows: QUIET_ROWS,
      startedAt: "2026-11-09T12:54:53.957Z",
      finishedAt: "2026-11-09T13:03:59.284Z",
      decideP50Ms: 2_196,
      accepted: 9,
      deliveredGoalRows: 0,
    });

    expect(g.durationSource).toBe("timestamps");
    expect(g.durationS).toBeCloseTo(545.327, 2);
  });

  it("a supplied duration outranks a stale record timestamp pair", () => {
    // The harness window is authoritative when both exist: the record's
    // create-to-settle span is not the authorized window (the 8516 leg metered
    // 484 s inside a 480 s window).
    const g = gradeLiveLeg({
      mode: "funded",
      rows: QUIET_ROWS,
      durationS: 480,
      durationSource: "harness_evidence",
      startedAt: "2026-11-09T22:28:03Z",
      finishedAt: "2026-11-09T22:36:11Z",
      decideP50Ms: 2_196,
      accepted: 9,
      deliveredGoalRows: 0,
    });

    expect(g.durationS).toBe(480);
    expect(g.durationSource).toBe("harness_evidence");
  });
});

// ADAAAA-8487 AC-B, as amended by CEO ruling A on ADAAAA-8528 (`cap-record` rev
// `ed4cfb59`): the leg reports p50 against BOTH bars — 3,000 ms legacy and
// 4,000 ms in force — and the AC-B verdict uses the bar in force. These cases
// pin the delta read so a leg that passes only because of the amendment says so
// instead of looking like it cleared the original bar.
describe("AC-B dual p50 bars (ADAAAA-8528 ruling A)", () => {
  const flatRows = (ms: number, n = 9) =>
    Array.from({ length: n }, (_, i) => ({
      triggerTs: 100 + i * 40,
      deliveredLatencyMs: ms,
      fireLagMs: 0,
      decideE2eMs: 0,
      acceptWaitMs: 0,
      acceptMs: 0,
      persistAckMs: ms,
    }));

  const gradeAt = (ms: number) =>
    gradeLiveLeg({
      mode: "funded",
      rows: flatRows(ms),
      durationS: 480,
      decideP50Ms: 2_196,
      accepted: 9,
      deliveredGoalRows: 0,
    });

  it("states both bars on every graded leg and keeps the legacy bar unmoved", () => {
    expect(LIVE_LEG_BARS.p50Ms).toBe(3_000);
    expect(LIVE_LEG_BARS.p50MsInForce).toBe(4_000);

    const g = gradeAt(2_800);
    expect(g.acB.p50Bars).toEqual({
      inForceMs: 4_000,
      legacyMs: 3_000,
      inForcePass: true,
      legacyPass: true,
      delta: "both",
    });
    expect(g.acB.status).toBe("PASS");
  });

  it("a p50 between the bars PASSes on the bar in force and reports the legacy FAIL", () => {
    // 3,343 ms is the standing funded measurement from the pre-change leg.
    const g = gradeAt(3_343);

    expect(g.p50Ms).toBe(3_343);
    expect(g.acB.status).toBe("PASS");
    expect(g.acB.p50Bars).toMatchObject({ inForcePass: true, legacyPass: false, delta: "legacy_only" });
    expect(g.verdict).toBe("PASS");
    // Both numbers are on the reason line, so the result comment cannot quote
    // one bar and quietly drop the other.
    const reason = g.acB.reasons.join(" ");
    expect(reason).toContain("4000 ms (in force)");
    expect(reason).toContain("3000 ms (legacy)");
    expect(reason).toContain("legacy read: FAIL");
  });

  it("a p50 over the amended bar FAILs, not UNMEASURED, and names the bar in force", () => {
    const g = gradeAt(4_400);

    expect(g.acB.status).toBe("FAIL");
    expect(g.acB.p50Bars).toMatchObject({ inForcePass: false, legacyPass: false, delta: "neither" });
    expect(g.verdict).toBe("FAIL");
    const reason = g.acB.reasons.join(" ");
    expect(reason).toContain("over_bar");
    expect(reason).toContain("4400 ms vs 4000 ms (in force)");
  });

  it("a shape-blocked leg reports the bars but still grades UNMEASURED", () => {
    const g = gradeLiveLeg({
      mode: "funded",
      rows: flatRows(2_000, 7),
      durationS: 320,
      decideP50Ms: 2_196,
      accepted: 7,
      deliveredGoalRows: 0,
    });

    expect(g.acB.status).toBe("UNMEASURED");
    expect(g.acB.p50Bars.inForcePass).toBe(true);
    expect(g.acB.p50Bars.delta).toBe("both");
  });
});

// ADAAAA-8487 AC-B shape amendment: a delivered row only counts toward `n` if it
// OWNS its anchor. The deployed-build leg `d251ceaa` is the case that forced
// this: it read 9 delivered rows (p95 4,414 ms, inside the bar) but two of them
// localized to the same fixture anchor (w01), so the row count was 9 and the
// anchored count was 8 — UNMEASURED, not a pass.
const SHAPE2_ANCHORS = [
  // 12 windows of 34 s, round-robin over the 4 physical transitions (ADAAAA-8571).
  { id: "w01", atS: 17, transition: 117 },
  { id: "w02", atS: 51, transition: 149 },
  { id: "w03", atS: 85, transition: 340 },
  { id: "w04", atS: 119, transition: 399 },
  { id: "w05", atS: 155, transition: 117 },
  { id: "w06", atS: 189, transition: 149 },
  { id: "w07", atS: 223, transition: 340 },
  { id: "w08", atS: 257, transition: 399 },
  { id: "w09", atS: 287, transition: 117 },
  { id: "w10", atS: 321, transition: 149 },
  { id: "w11", atS: 355, transition: 340 },
  { id: "w12", atS: 389, transition: 399 },
];

const anchored = (localizedTs: number[], triggerTs?: number[]) =>
  localizedTs.map((ts, i) => ({
    highlightId: `h${i + 1}`,
    triggerTs: triggerTs?.[i] ?? ts,
    localizedTs: ts,
  }));

describe("AC-B anchor accounting (ADAAAA-8487 shape amendment)", () => {
  const flatRows = (ms: number, n = 9) =>
    Array.from({ length: n }, (_, i) => ({
      triggerTs: 100 + i * 40,
      deliveredLatencyMs: ms,
      fireLagMs: 0,
      decideE2eMs: 0,
      acceptWaitMs: 0,
      acceptMs: 0,
      persistAckMs: ms,
    }));

  it("counts an anchor once when two rows land on it, and names the duplicate", () => {
    const rows = anchored([15.7, 30, 48.67, 82.4, 149.67, 181.67, 214.67, 250, 313.67]);
    const g = gradeLiveLeg({
      mode: "funded",
      rows: flatRows(2_000, rows.length),
      durationS: 410,
      authorizedDurationS: 410,
      decideP50Ms: 1_982,
      fixtureAnchors: SHAPE2_ANCHORS,
      rowAnchors: rows,
    });

    // The `d251ceaa` shape: 9 delivered rows, w01 delivered twice.
    expect(g.nRows).toBe(9);
    expect(g.n).toBe(8);
    expect(g.anchors?.nAnchored).toBe(8);
    expect(g.anchors?.duplicateAnchors).toEqual([{ id: "w01", transition: 117, rows: ["h1", "h2"] }]);
    expect(g.anchors?.uncoveredAnchors).toEqual(["w04", "w09", "w11", "w12"]);
    expect(g.verdict).toBe("UNMEASURED");
    expect(g.acB.reasons.some((r) => r.startsWith("n_below_9: 8 anchored rows"))).toBe(true);
  });

  it("keeps a row count from being read as anchored coverage", () => {
    const g = gradeLiveLeg({
      mode: "funded",
      rows: flatRows(2_000, 9),
      durationS: 410,
      authorizedDurationS: 410,
      decideP50Ms: 1_982,
    });

    expect(g.nRows).toBe(9);
    expect(g.n).toBe(9);
    expect(g.anchors).toBeUndefined();
    expect(
      g.acB.reasons.some((r) => r.startsWith("anchor_accounting_absent"))
    ).toBe(true);
  });

  it("PASSes at n >= 9 anchored rows and reports N, distinctMoments and the content ceiling", () => {
    const rows = anchored([17, 51, 85, 119, 155, 189, 223, 257, 287]);
    const g = gradeLiveLeg({
      mode: "funded",
      rows: flatRows(2_000, rows.length),
      durationS: 410,
      authorizedDurationS: 410,
      decideP50Ms: 1_982,
      fixtureAnchors: SHAPE2_ANCHORS,
      rowAnchors: rows,
    });

    expect(g.n).toBe(9);
    expect(g.anchors?.anchors).toBe(12);
    expect(g.anchors?.distinctMoments).toBe(4);
    expect(g.anchors?.physicalTransitions).toBe(4);
    expect(g.anchors?.duplicateAnchors).toEqual([]);
    expect(g.acB.status).toBe("PASS");
    expect(g.acB.reasons.join(" ")).toContain("anchored rows over N=12");
  });

  it("closes N of N when the census itself is under 9 anchors — the leg cannot answer the bar", () => {
    const rows = anchored([17, 51, 85, 119]);
    const g = gradeLiveLeg({
      mode: "funded",
      rows: flatRows(2_000, rows.length),
      durationS: 410,
      authorizedDurationS: 410,
      decideP50Ms: 1_982,
      fixtureAnchors: SHAPE2_ANCHORS.slice(0, 4),
      rowAnchors: rows,
    });

    expect(g.verdict).toBe("UNMEASURED");
    expect(g.acB.reasons.some((r) => r.startsWith("fixture_below_9_anchors: N=4"))).toBe(true);
  });

  it("grades a 410 s shape-2 leg against its own authorized window, not the 480 s default", () => {
    const rows = anchored([17, 51, 85, 119, 155, 189, 223, 257, 287]);
    const base = {
      mode: "funded" as const,
      rows: flatRows(2_000, rows.length),
      decideP50Ms: 1_982,
      fixtureAnchors: SHAPE2_ANCHORS,
      rowAnchors: rows,
    };

    // `cap-record-2` authorized 410 s: without the cap record's own window the
    // leg reads duration_below_floor on a leg that ran its shape exactly.
    const withoutCap = gradeLiveLeg({ ...base, durationS: 410 });
    expect(withoutCap.acB.reasons.some((r) => r.startsWith("duration_below_floor"))).toBe(true);
    expect(withoutCap.floorS).toBe(LIVE_LEG_BARS.fundedFloorS);

    const withCap = gradeLiveLeg({ ...base, durationS: 410, authorizedDurationS: 410 });
    expect(withCap.floorS).toBe(410);
    expect(withCap.acB.reasons.some((r) => r.startsWith("duration_below_floor"))).toBe(false);
    expect(withCap.acB.status).toBe("PASS");
  });

  it("reports a row that sits outside every anchor instead of snapping it on", () => {
    // 420 s is past w12's anchor (389 s) by 31 s: outside the 17 s half-window, so
    // the row is reported rather than snapped onto w12.
    const rows = anchored([17, 420]);
    const g = gradeLiveLeg({
      mode: "funded",
      rows: flatRows(2_000, rows.length),
      durationS: 410,
      authorizedDurationS: 410,
      decideP50Ms: 1_982,
      fixtureAnchors: SHAPE2_ANCHORS,
      rowAnchors: rows,
    });

    expect(g.anchors?.resolvedRows).toBe(1);
    expect(g.anchors?.unresolvedRows).toEqual(["h2"]);
    expect(g.anchors?.nAnchored).toBe(1);
  });
});

// ADAAAA-8487 AC-C on the goal-dense shape-2 fixture: the fixture re-presents 4
// REAL score transitions, so delivering GOAL rows is correct and the 8483
// "0 delivered GOAL" count is the wrong instrument. The bar is goal FALSE
// POSITIVES — a delivered GOAL whose own attestation measured no scoreboard
// change. `0cade089` delivered 10 GOAL / 0 FP and the PO graded AC-C PASS; the
// grader has to read that the same way instead of failing a leg for content.
describe("AC-C goal false positives (ADAAAA-8487)", () => {
  const gradeAcC = (goalFalsePositiveRows?: number) =>
    gradeLiveLeg({
      mode: "funded",
      rows: flatRowsForAcC(2_000, 9),
      durationS: 410,
      authorizedDurationS: 410,
      decideP50Ms: 2_386,
      accepted: 12,
      candidates: 130,
      deliveredGoalRows: 10,
      ...(goalFalsePositiveRows !== undefined ? { goalFalsePositiveRows } : {}),
    });

  const flatRowsForAcC = (ms: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      triggerTs: 100 + i * 40,
      deliveredLatencyMs: ms,
      fireLagMs: 0,
      decideE2eMs: 0,
      acceptWaitMs: 0,
      acceptMs: 0,
      persistAckMs: ms,
    }));

  it("PASSes a goal-dense leg with 0 false positives and reports the GOAL count as context", () => {
    const g = gradeAcC(0);

    expect(g.acC?.status).toBe("PASS");
    expect(g.acC?.goalFalsePositiveRows).toBe(0);
    expect(g.acC?.deliveredGoalRows).toBe(10);
    const reason = g.acC?.reasons.join(" ") ?? "";
    expect(reason).toContain("delivered_goal_rows: 10 (context");
    expect(reason).not.toContain("goal_false_positives:");
  });

  it("FAILs on false positives when the attestation did not measure a change", () => {
    const g = gradeAcC(3);

    expect(g.acC?.status).toBe("FAIL");
    expect(g.acC?.reasons.some((r) => r.startsWith("goal_false_positives: 3"))).toBe(true);
    expect(g.reasons.join(" ")).not.toContain("delivered_goal_rows: 10 (context");
  });

  it("keeps the 8483 behaviour when no FP read is supplied", () => {
    const g = gradeAcC(undefined);

    expect(g.acC?.status).toBe("FAIL");
    expect(g.acC?.reasons.some((r) => r.startsWith("delivered_goal_rows: 10 > 0"))).toBe(true);
    expect(g.reasons.join(" ")).toContain("delivered_goal_rows: 10 > 0");
  });
});

// ADAAAA-8487 leg a7d61806 (the shape-2 leg of record, 410 s, n=12 of N=12).
// Its deliveredLatencyMs, verbatim from the attached bundle. Eleven rows sit
// between 2,458 and 3,727 ms; the last window of the stream paid 5,630 ms.
const LEG_A7D61806_ROWS = [
  3_147, 3_709, 3_727, 2_458, 2_778, 3_095, 2_858, 2_814, 2_682, 2_834, 2_555, 5_630,
];

describe("AC-B estimator disclosure (ADAAAA-8487 leg a7d61806)", () => {
  const grade = () =>
    gradeLiveLeg({
      mode: "funded",
      rows: LEG_A7D61806_ROWS.map((deliveredLatencyMs, i) => ({
        triggerTs: i * 30,
        deliveredLatencyMs,
        fireLagMs: 0,
        decideE2eMs: 2_400,
        acceptWaitMs: 0,
        acceptMs: 10,
        persistAckMs: 0,
      })),
      startedAt: "2026-11-11T04:11:42Z",
      finishedAt: "2026-11-11T04:18:32Z",
      authorizedDurationS: 410,
      perceiveSessionS: 413.6,
      decideP50Ms: 1_959,
      accepted: 25,
      deliveredGoalRows: 10,
      goalFalsePositiveRows: 0,
    });

  it("keeps p95 on the metric of record — the product's interpolated percentile", () => {
    const g = grade();

    // rank 10.45 of a 12-row sample: 3727 + 0.45 * (5630 - 3727) = 4583.
    expect(g.p95Ms).toBe(4_583);
    expect(g.p95Ms).toBe(deliveredLatencySummary(LEG_A7D61806_ROWS.map((ms) => ({ deliveredLatencyMs: ms })) as never).p95Ms);
    expect(g.acB.status).toBe("PASS");
  });

  it("publishes the nearest-rank p95 so the one over-bar row is not averaged away", () => {
    const g = grade();

    expect(g.maxMs).toBe(5_630);
    // n=12 -> ceil(0.95 * 12) - 1 = 11, i.e. the last row: nearest-rank p95 IS the max.
    expect(g.p95NearestRankMs).toBe(5_630);
    expect(g.acB.p95NearestRankMs).toBe(5_630);
    expect(g.p95NearestRankMs).toBeGreaterThan(LIVE_LEG_BARS.p95Ms);
  });

  it("names the tail row in the PASS reasons instead of leaving the in-bar p95 bare", () => {
    const g = grade();
    const reason = g.acB.reasons.find((r) => r.startsWith("tail_over_bar:"));

    expect(g.acB.status).toBe("PASS");
    expect(reason).toContain("nearest-rank p95 5630 ms > 5000 ms on 12 rows");
    expect(reason).toContain("interpolated p95 4583 ms is the metric of record");
    expect(reason).toContain("stated not discounted");
  });

  it("stays silent when the whole sample is inside the bar", () => {
    const g = gradeLiveLeg({
      mode: "funded",
      rows: QUIET_ROWS,
      startedAt: "2026-11-09T12:54:53.957Z",
      finishedAt: "2026-11-09T13:03:59.284Z",
      perceiveSessionS: 544.5,
      decideP50Ms: 1_389,
      accepted: 9,
      deliveredGoalRows: 0,
      goalFalsePositiveRows: 0,
    });

    expect(g.acB.reasons.some((r) => r.startsWith("tail_over_bar:"))).toBe(false);
  });
});

// ADAAAA-8943: the funded harness can now be stopped from outside its guard (an
// operator `POST /jobs/{id}/stop`), and the 8924 rev-8 leg proves why that must
// not grade: nothing bound it to its authorized shape and it settled $1.4537
// against a $1.30 cap. These cases pin the refusal and the breach.
describe("stop source and outside-guard refusal (ADAAAA-8943)", () => {
  const fundedLeg = (over: Record<string, unknown> = {}) =>
    gradeLiveLeg({
      mode: "funded",
      rows: QUIET_ROWS,
      durationS: 480,
      decideP50Ms: 1_000,
      accepted: 9,
      deliveredGoalRows: 0,
      ...over,
    });

  it("grades a harness-stopped leg and records the stop source", () => {
    const g = fundedLeg({ stopSource: "authorized_duration", stopSourceClass: "harness" });

    expect(g.acB.status).toBe("PASS");
    expect(g.verdict).toBe("PASS");
    expect(g.stopSource).toBe("authorized_duration");
    expect(g.stopSourceClass).toBe("harness");
    expect(g.capBreach).toBeUndefined();
  });

  it("refuses a leg an operator stopped and carries the overspend as a field", () => {
    const g = fundedLeg({
      stopSource: "operator_api",
      stopSourceClass: "external",
      settledCostUsd: 1.4537,
      capUsd: 1.3,
    });

    // The rows look perfect, and that is exactly why the refusal has to be a
    // shape gate: a grade over an unguarded leg grades an unknown shape.
    expect(g.verdict).toBe("UNMEASURED");
    expect(g.acB.status).toBe("UNMEASURED");
    expect(g.stopSource).toBe("operator_api");
    expect(g.stopSourceClass).toBe("external");
    expect(g.capBreach).toEqual({
      capUsd: 1.3,
      settledCostUsd: 1.4537,
      overspendUsd: 0.1537,
      stopSource: "operator_api",
      cause: expect.stringContaining("stopped from outside the harness"),
    });
    const reasons = g.acB.reasons.join(" ; ");
    expect(reasons).toContain("stopped_outside_guard");
    expect(reasons).toContain("NOT gradable");
    expect(reasons).toContain("CAP BREACH: settled $1.4537 vs cap $1.3000 = overspend $0.1537");
  });

  it("refuses the same outside stop without inventing a breach under the cap", () => {
    const g = fundedLeg({
      stopSource: "operator_api",
      stopSourceClass: "external",
      settledCostUsd: 0.98,
      capUsd: 1.3,
    });

    expect(g.verdict).toBe("UNMEASURED");
    expect(g.capBreach).toBeUndefined();
    expect(g.acB.reasons.join(" ; ")).toContain("no cap breach on the settled figure");
  });

  it("reads a bare operator_api stopSource as external even without the class", () => {
    const g = fundedLeg({ stopSource: "operator_api" });

    expect(g.verdict).toBe("UNMEASURED");
    expect(g.stopSourceClass).toBeUndefined();
  });

  it("leaves a leg with no stop provenance graded as before", () => {
    const g = fundedLeg();

    expect(g.verdict).toBe("PASS");
    expect(g.stopSource).toBeUndefined();
    expect(g.capBreach).toBeUndefined();
  });
});
