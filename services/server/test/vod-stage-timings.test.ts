import { describe, it, expect } from "vitest";
import { buildStageTimings, stageTimingsViolations, type VodStageTimingInput } from "../src/vod-stage-timings";

// ADAAAA-7928 (spec §4.1) — the persisted `stageTimings` block and its four
// invariants. Fixtures only: these assert the CONTRACT, not one machine's noise.

const MEASURED_AT = "2026-11-04T00:00:00.000Z";

/** A representative unqueued run: claim -> extract -> reserve -> analyze -> done. */
function normalRun(over: Partial<VodStageTimingInput> = {}): VodStageTimingInput {
  const base: VodStageTimingInput = {
    runStartedMs: 1_000,
    extractStartMs: 1_100, // 100 ms of claim/setup before decode
    extractEndMs: 2_100, // 1 000 ms decode
    reserveStartMs: 2_400, // 300 ms inter-stage gap folds into preroll
    reserveEndMs: 2_500, // 100 ms capacity wait
    analyzeStartMs: 2_500, // analyze window == perceive session window
    analyzeEndMs: 10_000, // 7 500 ms analyze
    clipEncodeMs: 1_500, // cumulative cuts, subset of analyze
    audioGateStartMs: 2_600,
    audioGateEndMs: 9_000, // 6 400 ms concurrent audio loop
    sourceProbeMs: 120,
    perceiveSessionMs: 7_500, // acquisition -> release (== analyze window)
    finalizeEndMs: 12_000, // 2 000 ms finalize
    measuredAt: MEASURED_AT,
  };
  return { ...base, ...over };
}

describe("buildStageTimings (§4.1 invariants)", () => {
  it("partitions the run exactly: preroll + extract + capacityWait + analyze + finalize == totalMs", () => {
    const t = buildStageTimings(normalRun());
    const partition = t.prerollMs + t.extractMs + t.capacityWaitMs + t.analyzeMs + t.finalizeMs;
    expect(partition).toBe(t.totalMs);
    expect(t.totalMs).toBe(11_000);
    // The measured stages are the measured windows, not padded values.
    expect(t.extractMs).toBe(1_000);
    expect(t.capacityWaitMs).toBe(100);
    expect(t.analyzeMs).toBe(7_500);
    expect(t.finalizeMs).toBe(2_000);
    // The residual (claim setup + the 300 ms inter-stage gap) is preroll.
    expect(t.prerollMs).toBe(400);
    expect(t.version).toBe(1);
    expect(t.measuredAt).toBe(MEASURED_AT);
  });

  it("keeps the three nested measures as subsets of their parents", () => {
    const t = buildStageTimings(normalRun());
    expect(t.clipEncodeMs).toBe(1_500);
    expect(t.audioGateMs).toBe(6_400);
    expect(t.sourceProbeMs).toBe(120);
    expect(t.clipEncodeMs).toBeLessThanOrEqual(t.analyzeMs);
    expect(t.audioGateMs).toBeLessThanOrEqual(t.analyzeMs);
    expect(t.sourceProbeMs).toBeLessThanOrEqual(t.finalizeMs);
    expect(stageTimingsViolations(t, 11)).toEqual([]);
  });

  it("clamps a subset that overruns its parent instead of reporting a lying split", () => {
    const t = buildStageTimings(
      normalRun({
        clipEncodeMs: 99_000, // never possible, but a bad clock must not escape
        audioGateStartMs: 0, // audio loop predating analyze -> clipped to the window
        audioGateEndMs: 99_000,
        sourceProbeMs: 99_000,
      })
    );
    expect(t.clipEncodeMs).toBe(t.analyzeMs);
    expect(t.audioGateMs).toBe(t.analyzeMs);
    expect(t.sourceProbeMs).toBe(t.finalizeMs);
    expect(stageTimingsViolations(t, 11)).toEqual([]);
  });

  it("F1: the capacity queue wait is NOT inside perceiveSessionMs", () => {
    // A VOD queued 90 s behind the capacity-1 perceive slot. The pre-fix meter
    // started its clock before the reserve, so this wait became billed GPU time.
    const QUEUE_WAIT_MS = 90_000;
    const acquiredMs = 2_500 + QUEUE_WAIT_MS;
    const analyzeEndMs = acquiredMs + 7_500; // same 7.5 s analyze
    const input = normalRun({
      reserveStartMs: 2_500,
      reserveEndMs: acquiredMs,
      analyzeStartMs: acquiredMs,
      analyzeEndMs,
      perceiveSessionMs: analyzeEndMs - acquiredMs,
      finalizeEndMs: analyzeEndMs + 2_000,
      audioGateStartMs: acquiredMs + 100,
      audioGateEndMs: analyzeEndMs - 500,
    });
    const t = buildStageTimings(input);
    expect(t.capacityWaitMs).toBe(QUEUE_WAIT_MS);
    expect(t.analyzeMs).toBe(7_500);
    expect(t.perceiveSessionMs).toBe(7_500);
    // Invariant 4: bounded by the analyze window, and the wait is separate.
    expect(t.perceiveSessionMs).toBeLessThanOrEqual(t.analyzeMs + t.capacityWaitMs);
    expect(t.perceiveSessionMs).toBe(t.analyzeMs);
    expect(stageTimingsViolations(t, (t.totalMs / 1000))).toEqual([]);

    // The billing difference this fix buys: meter the same job with the old
    // clock (analyze end - reserve start) and compare `costUsd`.
    const fee = 0.01;
    const rate = 0.01;
    const decideCalls = 26;
    const postFixCost = fee * decideCalls + (t.perceiveSessionMs / 1000 / 3600) * rate;
    const preFixCost = fee * decideCalls + ((analyzeEndMs - 2_500) / 1000 / 3600) * rate;
    expect(postFixCost).toBeLessThan(preFixCost);
    // 90 s of queue wait was being billed: 0.00025 USD of GPU at list price.
    expect(preFixCost - postFixCost).toBeCloseTo((QUEUE_WAIT_MS / 1000 / 3600) * rate, 9);
  });

  it("folds a resumed job's prior attempts into preroll so invariant 3 still closes", () => {
    // Attempt 1 burned 60 s before failing; this attempt claims at T.
    const priorAttemptsMs = 60_000;
    const t = buildStageTimings(normalRun({ priorAttemptsMs }));
    expect(t.totalMs).toBe(11_000 + priorAttemptsMs);
    // The partition is still exact and preroll carries the prior attempts.
    expect(t.prerollMs + t.extractMs + t.capacityWaitMs + t.analyzeMs + t.finalizeMs).toBe(t.totalMs);
    expect(t.prerollMs).toBe(400 + priorAttemptsMs);
    // vodMeter.wallClockS covers both attempts -> invariant 3 holds.
    expect(stageTimingsViolations(t, t.totalMs / 1000)).toEqual([]);
  });

  it("invariant 3 tolerance is ±100 ms on vodMeter.wallClockS", () => {
    const t = buildStageTimings(normalRun());
    // The meter rounds wall clock to 0.1 s; 11.0 s matches within tolerance.
    expect(stageTimingsViolations(t, 11.0)).toEqual([]);
    expect(stageTimingsViolations(t, 11.05)).toEqual([]); // 50 ms off
    // A meter that disagrees by more than the tolerance is a contract breach.
    expect(stageTimingsViolations(t, 11.2).some((v) => v.includes("vodMeter.wallClockS"))).toBe(true);
  });

  it("surfaces each broken invariant rather than silently repairing it", () => {
    const t = buildStageTimings(normalRun());
    const partitionBroken = { ...t, prerollMs: t.prerollMs + 5_000 };
    expect(stageTimingsViolations(partitionBroken).some((v) => v.includes("partition"))).toBe(true);
    const clipBroken = { ...t, clipEncodeMs: t.analyzeMs + 1 };
    expect(stageTimingsViolations(clipBroken).some((v) => v.includes("clipEncodeMs"))).toBe(true);
    const probeBroken = { ...t, sourceProbeMs: t.finalizeMs + 1 };
    expect(stageTimingsViolations(probeBroken).some((v) => v.includes("sourceProbeMs"))).toBe(true);
    // A legacy record has no meter to check rule 3 against -> no false failure.
    expect(stageTimingsViolations(t, null)).toEqual([]);
  });

  it("never emits a negative or non-finite stage (clock skew degrades to 0)", () => {
    const t = buildStageTimings(
      normalRun({ extractEndMs: 900, reserveEndMs: 100, analyzeEndMs: 0, finalizeEndMs: 0 })
    );
    for (const v of [t.prerollMs, t.extractMs, t.capacityWaitMs, t.analyzeMs, t.finalizeMs, t.perceiveSessionMs]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
