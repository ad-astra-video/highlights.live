import { describe, it, expect } from "vitest";
import { StageAMetrics } from "../src/stage-a-metrics";

describe("StageAMetrics (INC-2 / ADAAAA-4325 slice 5: noise-trigger FP-rate + latency)", () => {
  it("reports fpRate 0 until any candidate is recorded", () => {
    const m = new StageAMetrics();
    expect(m.totalCandidates).toBe(0);
    expect(m.fpRate()).toBe(0);
    expect(m.snapshot()).toMatchObject({ totalCandidates: 0, fpRate: 0, fpRateWithinBudget: true });
  });

  it("computes fpRate = rejected / total and flags when within the <= 60% budget", () => {
    const m = new StageAMetrics();
    // 2 accepted, 3 rejected of 5 -> fpRate 0.6, exactly on budget.
    m.recordOutcome(true);
    m.recordOutcome(false);
    m.recordOutcome(true);
    m.recordOutcome(false);
    m.recordOutcome(false);
    expect(m.totalCandidates).toBe(5);
    expect(m.acceptedCount).toBe(2);
    expect(m.rejectedCount).toBe(3);
    expect(m.fpRate()).toBeCloseTo(0.6, 10);
    expect(m.snapshot().fpRateWithinBudget).toBe(true);

    // One more rejection blows past 60% -> budget flag clears (cost guard).
    m.recordOutcome(false);
    expect(m.fpRate()).toBeCloseTo(4 / 6, 10);
    expect(m.snapshot().fpRateWithinBudget).toBe(false);
  });

  it("records and aggregates onset latency (mean/max) for latency budget verification", () => {
    const m = new StageAMetrics();
    m.recordOutcome(true, 0.5);
    m.recordOutcome(false, 1.5);
    m.recordOutcome(true, 3.0);
    const s = m.snapshot();
    expect(s.meanOnsetLatencyS).toBeCloseTo((0.5 + 1.5 + 3.0) / 3, 3);
    expect(s.maxOnsetLatencyS).toBe(3.0);
    // All within the live 1-5s gate budget at the gate level.
    expect(s.maxOnsetLatencyS).toBeLessThanOrEqual(5);
  });

  it("ignores undefined / invalid latency without skewing the mean", () => {
    const m = new StageAMetrics();
    m.recordOutcome(true); // no latency reported
    m.recordOutcome(false, -1); // invalid -> ignored
    const s = m.snapshot();
    expect(s.meanOnsetLatencyS).toBe(0);
    expect(s.maxOnsetLatencyS).toBe(0);
    expect(s.totalCandidates).toBe(2);
  });
});
