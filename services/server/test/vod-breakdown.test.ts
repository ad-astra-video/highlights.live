import { describe, it, expect } from "vitest";
import type { Job } from "@highlights/events";
import {
  buildVodBreakdown,
  collectVodBreakdownSample,
  normaliseDays,
  normaliseLimit,
  type VodBreakdownRates,
} from "../src/vod-breakdown";

// ADAAAA-7928 (spec §4.2) — the admin aggregate. Pure module: fixtures only.

const NOW = Date.parse("2026-11-04T00:00:00.000Z");
const RATES: VodBreakdownRates = { decideFeeUsd: 0.01, perceivePerHourUsd: 0.01 };

function at(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * 3_600_000).toISOString();
}

function mkJob(o: Partial<Job> & { id: string }): Job {
  return {
    source: o.source ?? "file",
    status: o.status ?? "done",
    createdAt: o.createdAt ?? at(1),
    completedAt: o.completedAt ?? at(1),
    ...o,
  } as Job;
}

function timings(o: {
  prerollMs: number;
  extractMs: number;
  capacityWaitMs: number;
  analyzeMs: number;
  clipEncodeMs: number;
  audioGateMs: number;
  finalizeMs: number;
  sourceProbeMs?: number;
}) {
  const totalMs =
    o.prerollMs + o.extractMs + o.capacityWaitMs + o.analyzeMs + o.finalizeMs;
  return {
    version: 1 as const,
    prerollMs: o.prerollMs,
    extractMs: o.extractMs,
    capacityWaitMs: o.capacityWaitMs,
    analyzeMs: o.analyzeMs,
    clipEncodeMs: o.clipEncodeMs,
    audioGateMs: o.audioGateMs,
    finalizeMs: o.finalizeMs,
    sourceProbeMs: o.sourceProbeMs ?? 0,
    perceiveSessionMs: o.analyzeMs,
    totalMs,
    measuredAt: "2026-11-04T00:00:00.000Z",
  };
}

/** Two metered+timed VOD jobs, one legacy metered job, one cost-less job, one
 * non-VOD (live) job and one failed VOD job. */
function fixture(): Job[] {
  return [
    mkJob({
      id: "a",
      completedAt: at(1),
      costUsd: 0.26,
      perceiveSessionS: 360, // 0.1 h * $0.01 = $0.001
      decideCalls: 26,
      confirmMetrics: { totalRuns: 6 } as any,
      framesAnalyzed: 360,
      highlightsFound: 4,
      stageAMetrics: { totalCandidates: 9 } as any,
      vodMeter: { wallClockS: 11, decideCalls: 26, sourceDurationS: 128, costUsd: 0.26, decideFeeUsd: 0.01, perVideoHourCostUsd: 7.35, rtf: 3.75 } as any,
      stageTimings: timings({ prerollMs: 400, extractMs: 1_000, capacityWaitMs: 100, analyzeMs: 7_500, clipEncodeMs: 1_500, audioGateMs: 6_400, finalizeMs: 2_000 }),
    }),
    mkJob({
      id: "b",
      completedAt: at(2),
      costUsd: 0.1,
      perceiveSessionS: 180, // 0.05 h * $0.01 = $0.0005
      decideCalls: 10,
      confirmMetrics: { totalRuns: 4 } as any,
      framesAnalyzed: 240,
      highlightsFound: 2,
      stageAMetrics: { totalCandidates: 5 } as any,
      vodMeter: { wallClockS: 7, decideCalls: 10, sourceDurationS: 90, costUsd: 0.1, decideFeeUsd: 0.01, perVideoHourCostUsd: 4.0, rtf: 2.5 } as any,
      stageTimings: timings({ prerollMs: 200, extractMs: 900, capacityWaitMs: 0, analyzeMs: 4_500, clipEncodeMs: 500, audioGateMs: 3_000, finalizeMs: 1_400 }),
    }),
    // Legacy record: cost recorded, no stageTimings -> cost lens only.
    mkJob({ id: "c", completedAt: at(3), costUsd: 0.05, perceiveSessionS: 0, decideCalls: 5, framesAnalyzed: 100, highlightsFound: 1 }),
    // Completed VOD with NO recorded cost -> excluded.noCost, never $0.
    mkJob({ id: "d", completedAt: at(4) }),
    // Non-VOD in the window -> excluded.live.
    mkJob({ id: "e", source: "browser", status: "done", completedAt: at(5), costUsd: 0.4 }),
    // Failed VOD -> not sampled at all, and created outside any short window.
    mkJob({ id: "f", status: "failed", createdAt: at(24 * 30), completedAt: at(6), costUsd: 0.02 }),
  ];
}

describe("collectVodBreakdownSample (scopes)", () => {
  it("recent = the newest `limit` VOD requests, live rows never displacing them", () => {
    const { scope, population } = collectVodBreakdownSample(fixture(), { limit: 2 }, NOW);
    expect(scope.kind).toBe("recent");
    expect(scope.limit).toBe(2);
    expect(population.map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("days = every job created inside the window (live rows included), job = one row", () => {
    const days = collectVodBreakdownSample(fixture(), { scope: "days", days: 5 }, NOW);
    expect(days.scope.kind).toBe("days");
    expect(days.scope.days).toBe(5);
    expect(days.population.map((j) => j.id).sort()).toEqual(["a", "b", "c", "d", "e"]);

    const job = collectVodBreakdownSample(fixture(), { scope: "job", jobId: "b" }, NOW);
    expect(job.scope.jobId).toBe("b");
    expect(job.population.map((j) => j.id)).toEqual(["b"]);
    // An unknown id is an empty population, not a throw.
    expect(collectVodBreakdownSample(fixture(), { scope: "job", jobId: "nope" }, NOW).population).toEqual([]);
  });

  it("clamps limit (1..50, default 20) and days (1..90, default 7)", () => {
    expect(normaliseLimit(undefined)).toBe(20);
    expect(normaliseLimit(0)).toBe(1);
    expect(normaliseLimit(999)).toBe(50);
    expect(normaliseLimit(2.7)).toBe(2);
    expect(normaliseDays(undefined)).toBe(7);
    expect(normaliseDays(-3)).toBe(1);
    expect(normaliseDays(9_999)).toBe(90);
  });
});

describe("buildVodBreakdown (§4.2 cost lens)", () => {
  const report = buildVodBreakdown(fixture(), { limit: 20 }, RATES, NOW);

  it("samples completed VOD requests and labels every denominator", () => {
    expect(report.scope.kind).toBe("recent");
    expect(report.sampled).toBe(4); // a, b, c, d (f is failed)
    expect(report.metered).toBe(3); // a, b, c (d has no cost)
    expect(report.timed).toBe(2); // a, b (c predates stageTimings)
    expect(report.excluded.noCost).toBe(1);
    expect(report.excluded.noStageTimings).toBe(1);
    expect(report.excluded.live).toBe(0); // recent scope never samples live rows
    expect(report.rates).toEqual(RATES);
  });

  it("splits the recorded meter into leaves exactly (no COGS node, no invented split)", () => {
    const byKey = Object.fromEntries(report.cost.nodes.map((n) => [n.key, n]));
    // Means over the 3 metered jobs.
    expect(byKey.perceive_gpu.usd).toBeCloseTo((0.001 + 0.0005 + 0) / 3, 6);
    expect(byKey.decide_observe.usd).toBeCloseTo((20 * 0.01 + 6 * 0.01 + 5 * 0.01) / 3, 6);
    expect(byKey.decide_confirm.usd).toBeCloseTo((6 * 0.01 + 4 * 0.01 + 0) / 3, 6);
    // CPU stages are reported, but at $0 and marked as CPU.
    for (const k of ["cpu_extract", "cpu_audio", "cpu_clip", "cpu_finalize"]) {
      expect(byKey[k].usd).toBe(0);
      expect(byKey[k].cpu).toBe(true);
      expect(byKey[k].share).toBe(0);
    }
    // Leaf shares use the billable denominator only and sum to 1.
    const shares = report.cost.nodes.filter((n) => !n.cpu).reduce((s, n) => s + n.share, 0);
    expect(shares).toBeCloseTo(1, 4);
    // No COGS / Livepeer node exists.
    expect(report.cost.nodes.map((n) => n.key).some((k) => /cogs|livepeer|invoice/i.test(k))).toBe(false);
  });

  it("conserves: flows sum to the parent within $0.0001", () => {
    const flowSum = report.cost.flows.reduce((s, f) => s + f.usd, 0);
    expect(Math.abs(flowSum - report.cost.totalUsd)).toBeLessThanOrEqual(0.0001);
    expect(report.cost.flows.every((f) => f.source === "total")).toBe(true);
    expect(report.cost.flows.map((f) => f.target)).toEqual(report.cost.nodes.map((n) => n.key));
    // Top band = the sum of the billable leaves.
    const leaves = report.cost.nodes.filter((n) => !n.cpu).reduce((s, n) => s + n.usd, 0);
    expect(Math.abs(leaves - report.cost.totalUsd)).toBeLessThanOrEqual(0.0001);
  });

  it("never counts a cost-less job as $0: dropping it changes no cost number", () => {
    const withoutD = fixture().filter((j) => j.id !== "d");
    const r2 = buildVodBreakdown(withoutD, { limit: 20 }, RATES, NOW);
    expect(r2.cost.totalUsd).toBe(report.cost.totalUsd);
    expect(r2.metered).toBe(report.metered);
    expect(r2.sampled).toBe(3);
    expect(r2.excluded.noCost).toBe(0);
  });

  it("averages cost over `metered`, not over `sampled`", () => {
    // 3 metered, 4 sampled: dividing by 4 would be 25% too low.
    const byKey = Object.fromEntries(report.cost.nodes.map((n) => [n.key, n]));
    const leaves = byKey.perceive_gpu.usd + byKey.decide_observe.usd + byKey.decide_confirm.usd;
    expect(leaves).toBeGreaterThan(0);
    expect(report.perRequest.costUsd).toBeCloseTo(report.cost.totalUsd, 6);
    // perceive 0.0005 + observe 0.31/3 + confirm 0.10/3 = 0.137167 per request.
    expect(report.cost.totalUsd).toBeCloseTo((0.001 + 0.0005) / 3 + (0.2 + 0.06 + 0.05) / 3 + (0.06 + 0.04) / 3, 5);
  });
});

describe("buildVodBreakdown (§4.2 time lens)", () => {
  const report = buildVodBreakdown(fixture(), { limit: 20 }, RATES, NOW);
  const byKey = Object.fromEntries(report.time.nodes.map((n) => [n.key, n]));

  it("uses measured stage timings and averages over `timed`", () => {
    // Means over a and b: total (11000 + 7000)/2 = 9 s.
    expect(report.time.totalS).toBe(9);
    expect(byKey.preroll.s).toBe(0.3); // (400 + 200)/2
    expect(byKey.extract.s).toBe(0.95); // (1000 + 900)/2 = 950 ms — visible at 2 dp
    expect(byKey.capacity_wait.s).toBe(0.05); // 50 ms — a 1 dp lens would print 0 beside a non-zero share
    expect(byKey.finalize.s).toBe(1.7); // (2000 + 1400)/2
  });

  it("analyze_net subtracts the cumulative clip encode (no double count)", () => {
    // mean analyze 6000 ms, mean clip 1000 ms -> 5000 ms = 5 s.
    expect(byKey.analyze_net.s).toBe(5);
    expect(byKey.clip_encode.s).toBe(1);
    // analyzeMs is NOT also reported as a node: the union of nodes is the total.
    expect(report.time.nodes.map((n) => n.key)).not.toContain("analyze");
  });

  it("reports the audio gate as CONCURRENT and never in the time total", () => {
    expect(report.time.concurrent.map((c) => c.key)).toEqual(["audio_gate"]);
    expect(report.time.concurrent[0].s).toBe(4.7); // (6400 + 3000)/2 ms
    expect(report.time.nodes.map((n) => n.key)).not.toContain("audio_gate");
    const flowSum = report.time.flows.reduce((s, f) => s + f.s, 0);
    expect(Math.abs(flowSum - report.time.totalS)).toBeLessThanOrEqual(1);
    // The concurrent band is NOT inside totalS.
    expect(report.time.totalS).toBeLessThan(report.time.concurrent[0].s + report.time.totalS);
    const nodeSum = report.time.nodes.reduce((s, n) => s + n.s, 0);
    expect(Math.abs(nodeSum - report.time.totalS)).toBeLessThanOrEqual(1);
  });

  it("a metered job without stageTimings contributes cost but not time", () => {
    const withC = fixture();
    const withoutC = withC.filter((j) => j.id !== "c");
    const r2 = buildVodBreakdown(withoutC, { limit: 20 }, RATES, NOW);
    expect(r2.time.totalS).toBe(report.time.totalS); // unchanged: c has no timings
    expect(r2.cost.totalUsd).not.toBe(report.cost.totalUsd); // cost changes: c is metered
    expect(r2.timed).toBe(2);
    expect(r2.excluded.noStageTimings).toBe(0);
  });

  it("conserves on the `job` scope too (single request)", () => {
    const one = buildVodBreakdown(fixture(), { scope: "job", jobId: "a" }, RATES, NOW);
    expect(one.sampled).toBe(1);
    expect(one.metered).toBe(1);
    expect(one.timed).toBe(1);
    expect(one.time.totalS).toBe(11);
    expect(Math.abs(one.time.flows.reduce((s, f) => s + f.s, 0) - one.time.totalS)).toBeLessThanOrEqual(1);
    expect(one.time.concurrent[0].s).toBe(6.4);
    expect(Math.abs(one.cost.flows.reduce((s, f) => s + f.usd, 0) - one.cost.totalUsd)).toBeLessThanOrEqual(0.0001);
  });
});

describe("buildVodBreakdown (exclusions, per-request strip, empty state)", () => {
  it("counts non-VOD rows as excluded.live without sampling them", () => {
    const r = buildVodBreakdown(fixture(), { scope: "days", days: 7 }, RATES, NOW);
    expect(r.excluded.live).toBe(1);
    expect(r.sampled).toBe(4);
    expect(r.metered).toBe(3);
  });

  it("perRequest uses the labelled denominators (metered for cost, timed for time)", () => {
    const r = buildVodBreakdown(fixture(), { limit: 20 }, RATES, NOW);
    // frames/req over 3 metered: (360 + 240 + 100)/3
    expect(r.perRequest.frames).toBeCloseTo(233.3, 1);
    expect(r.perRequest.decideCalls).toBeCloseTo((26 + 10 + 5) / 3, 2);
    expect(r.perRequest.confirmCalls).toBeCloseTo((6 + 4) / 2, 2); // only the 2 measured
    expect(r.perRequest.clips).toBeCloseTo((4 + 2 + 1) / 3, 2);
    expect(r.perRequest.sourceS).toBeCloseTo((128 + 90) / 2, 1);
    expect(r.perRequest.rtf).toBeCloseTo((3.75 + 2.5) / 2, 3);
    expect(r.perRequest.perVideoHourCostUsd).toBeCloseTo((7.35 + 4.0) / 2, 4);
    expect(r.perRequest.wallClockS).toBe(9); // timed denominator
  });

  it("zero metered jobs yields an explicit empty payload, not a zero-value sankey", () => {
    const onlyCostLess = [mkJob({ id: "d" }), mkJob({ id: "d2" })];
    const r = buildVodBreakdown(onlyCostLess, { limit: 20 }, RATES, NOW);
    expect(r.metered).toBe(0);
    expect(r.timed).toBe(0);
    expect(r.cost.totalUsd).toBe(0);
    expect(r.cost.nodes.every((n) => n.usd === 0 && n.share === 0)).toBe(true);
    expect(r.time.totalS).toBe(0);
    expect(r.time.concurrent).toEqual([]);
    expect(r.perRequest.costUsd).toBe(0);
    expect(r.perRequest.sourceS).toBeNull();
    expect(r.excluded.noCost).toBe(2);
  });

  it("is pure: the same input always produces the same payload", () => {
    const a = buildVodBreakdown(fixture(), { limit: 20 }, RATES, NOW);
    const b = buildVodBreakdown(fixture(), { limit: 20 }, RATES, NOW);
    expect(a).toEqual(b);
  });
});
