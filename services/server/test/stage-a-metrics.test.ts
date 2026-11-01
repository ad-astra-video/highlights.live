import { describe, it, expect } from "vitest";
import { StageAMetrics, StageAOutcomeLedger, stageAEvidenceLine } from "../src/stage-a-metrics";

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

  it("reports explicit gemmaFpRate identical to fpRate (ADAAAA-4785)", () => {
    const m = new StageAMetrics();
    m.recordOutcome(true);
    m.recordOutcome(false);
    m.recordOutcome(true);
    m.recordOutcome(false);
    m.recordOutcome(false);
    const s = m.snapshot();
    expect(s.gemmaFpRate).toBe(s.fpRate);
    expect(s.gemmaFpRate).toBeCloseTo(0.6, 10);
  });

  it("computes p50/p95 latency percentiles over onset samples (ADAAAA-4785)", () => {
    const m = new StageAMetrics();
    for (const lat of [0.5, 1.0, 1.5, 3.0, 4.5]) m.recordOutcome(true, lat);
    const s = m.snapshot();
    // nearest-rank: sorted [0.5,1.0,1.5,3.0,4.5], n=5
    // p50: ceil(0.5*5)=3 -> sorted[2]=1.5 ; p95: ceil(0.95*5)=5 -> sorted[4]=4.5
    expect(s.p50LatencyS).toBe(1.5);
    expect(s.p95LatencyS).toBe(4.5);
    // Both within the live 1-5s budget.
    expect(s.p95LatencyS).toBeLessThanOrEqual(5);
  });

  it("returns p50/p95 0 when no latency sample observed (ADAAAA-4785)", () => {
    const m = new StageAMetrics();
    m.recordOutcome(true);
    const s = m.snapshot();
    expect(s.p50LatencyS).toBe(0);
    expect(s.p95LatencyS).toBe(0);
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

describe("StageAOutcomeLedger (ADAAAA-7694: trigger -> deciding-window verdict)", () => {
  it("records the verdict of the window whose span contains the onset, with the gate latency", () => {
    const m = new StageAMetrics();
    const led = new StageAOutcomeLedger(m);
    expect(led.recordTrigger({ onsetTs: 2.0, onsetLatencyS: 0.3 })).toBe(true);
    expect(led.pendingCount()).toBe(1);
    // A window that does NOT contain the onset judges nothing.
    expect(led.judgeWindow(4.0, 14.0, true)).toBe(0);
    expect(m.totalCandidates).toBe(0);
    // The covering window judges it once.
    expect(led.judgeWindow(-5.0, 5.0, true)).toBe(1);
    expect(led.pendingCount()).toBe(0);
    const s = m.snapshot();
    expect(s.totalCandidates).toBe(1);
    expect(s.accepted).toBe(1);
    expect(s.rejected).toBe(0);
    expect(s.fpRate).toBe(0);
    expect(s.meanOnsetLatencyS).toBeCloseTo(0.3, 3);
  });

  it("counts an overlapping re-produced window once (never re-counts one trigger)", () => {
    const m = new StageAMetrics();
    const led = new StageAOutcomeLedger(m);
    led.recordTrigger({ onsetTs: 6.0, onsetLatencyS: 0.2 });
    // Overlapping observe windows both contain 6.0 — only the FIRST judges it.
    expect(led.judgeWindow(1.0, 11.0, false)).toBe(1);
    expect(led.judgeWindow(4.0, 14.0, false)).toBe(0);
    expect(m.totalCandidates).toBe(1);
    expect(m.rejectedCount).toBe(1);
    expect(m.fpRate()).toBe(1);
  });

  it("coalesces re-fires of one audible event into one candidate", () => {
    const m = new StageAMetrics();
    const led = new StageAOutcomeLedger(m);
    expect(led.recordTrigger({ onsetTs: 4.0, onsetLatencyS: 0.2 })).toBe(true);
    // The gate's cooldown refire inside 2.5 s is the SAME audible event.
    expect(led.recordTrigger({ onsetTs: 4.3, onsetLatencyS: 1.9 })).toBe(false);
    expect(led.pendingCount()).toBe(1);
    led.judgeWindow(0, 8, true);
    expect(m.totalCandidates).toBe(1);
  });

  it("never records an unjudged trigger (dropped/gate-skipped is not a reject)", () => {
    const m = new StageAMetrics();
    const led = new StageAOutcomeLedger(m);
    led.recordTrigger({ onsetTs: 2.0 });
    // A stale-frame drop covers the span without a decide -> forget, don't count.
    expect(led.dropThrough(-8, 2)).toBe(1);
    expect(led.pendingCount()).toBe(0);
    expect(m.totalCandidates).toBe(0);
    expect(m.fpRate()).toBe(0);
  });

  it("judges the anchored trigger explicitly even when it sits outside the trailing span", () => {
    const m = new StageAMetrics();
    const led = new StageAOutcomeLedger(m);
    const t = { onsetTs: 1.0, onsetLatencyS: 0.5 };
    led.recordTrigger(t);
    // Stream lagged: the anchored fire's trailing span starts after the onset.
    expect(led.judgeWindow(9.0, 19.0, true)).toBe(0);
    expect(led.judgeTrigger(t, true)).toBe(true);
    expect(led.judgeTrigger(t, true)).toBe(false); // never re-counted
    expect(m.totalCandidates).toBe(1);
    expect(m.acceptedCount).toBe(1);
  });

  it("rejects an invalid trigger record instead of counting it", () => {
    const m = new StageAMetrics();
    const led = new StageAOutcomeLedger(m);
    expect(led.recordTrigger(null)).toBe(false);
    expect(led.recordTrigger({ onsetTs: Number.NaN })).toBe(false);
    expect(led.pendingCount()).toBe(0);
  });
});

describe("stageAEvidenceLine (ADAAAA-7694: the per-job evidence line)", () => {
  it("prints for a measured snapshot and stays silent for an unmeasured one", () => {
    const m = new StageAMetrics();
    expect(stageAEvidenceLine("live", "j1", m.snapshot())).toBeNull();
    m.recordOutcome(false, 0.2);
    m.recordOutcome(true, 0.4);
    expect(stageAEvidenceLine("live", "j1", m.snapshot())).toBe(
      "[live:j1] stageA fpRate=0.5 (1/2 rejected), latency mean/max=0.3/0.4s, withinBudget=true"
    );
    expect(stageAEvidenceLine("vod", "j2", m.snapshot(), ", costUsd=0.0100")).toContain(
      "[vod:j2] stageA fpRate=0.5 (1/2 rejected)"
    );
    expect(stageAEvidenceLine("vod", "j2", m.snapshot(), ", costUsd=0.0100")).toContain(", costUsd=0.0100");
  });
});
