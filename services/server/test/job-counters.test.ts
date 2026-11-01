import { describe, expect, it } from "vitest";
import type { StageAMetricsSnapshot } from "@highlights/events";
import { candidateCountForJob, completedCounterFields, completedLiveCounterFields, counterFieldsForJob, liveCandidateCountForJob, stageAMetricsForJob } from "../src/job-counters";

// ADAAAA-7624: honest per-job candidate + Stage-A counters.
//
// The reported job (`d61e52f6`) produced 24 accepted highlights through the VOD
// observe cadence but persisted `candidatesTriggered: 0` (the counter only saw
// legacy perceive `candidate` events) and an all-zero `stageAMetrics` snapshot
// (the audio Stage-A gate never judged a candidate), so the job detail read
// `0 candidates` for a stage that did not run.

const zeroSnapshot = (): StageAMetricsSnapshot => ({
  totalCandidates: 0,
  accepted: 0,
  rejected: 0,
  fpRate: 0,
  gemmaFpRate: 0,
  meanOnsetLatencyS: 0,
  maxOnsetLatencyS: 0,
  p50LatencyS: 0,
  p95LatencyS: 0,
  fpRateWithinBudget: true,
});

const measuredSnapshot = (total: number, rejected: number): StageAMetricsSnapshot => ({
  ...zeroSnapshot(),
  totalCandidates: total,
  accepted: total - rejected,
  rejected,
  fpRate: rejected / total,
});

describe("candidateCountForJob (ADAAAA-7624)", () => {
  it("counts the observe path's accepted candidates, not the raw event counter", () => {
    // The deployed bug: 24 observe-path highlights, 0 legacy candidate events.
    expect(candidateCountForJob(24, 0)).toEqual({ count: 24, path: "observe" });
  });

  it("prefers the observe count even when legacy candidate events also fired", () => {
    expect(candidateCountForJob(5, 11)).toEqual({ count: 5, path: "observe" });
  });

  it("falls back to the legacy perceive-gate counter when the observer did not run", () => {
    expect(candidateCountForJob(undefined, 3)).toEqual({ count: 3, path: "perceive_gate" });
  });

  it("reports none when neither path produced a candidate", () => {
    expect(candidateCountForJob(undefined, 0)).toEqual({ count: 0, path: "none" });
  });

  it("never emits a negative or fractional count", () => {
    expect(candidateCountForJob(-4, 0)).toEqual({ count: 0, path: "observe" });
    expect(candidateCountForJob(undefined, 2.9)).toEqual({ count: 2, path: "perceive_gate" });
  });
});

describe("stageAMetricsForJob (ADAAAA-7624)", () => {
  it("omits an all-zero snapshot and reports n/a (never a measured 0% FP rate)", () => {
    const out = stageAMetricsForJob(zeroSnapshot());
    expect(out.stageAMetrics).toBeUndefined();
    expect(out.stageAMetricsStatus).toBe("n/a");
  });

  it("persists a real measurement with status measured", () => {
    const snap = measuredSnapshot(4, 1);
    const out = stageAMetricsForJob(snap);
    expect(out.stageAMetricsStatus).toBe("measured");
    expect(out.stageAMetrics).toEqual(snap);
    expect(out.stageAMetrics?.fpRate).toBeCloseTo(0.25);
  });
});

describe("counterFieldsForJob (ADAAAA-7624 read-time projection)", () => {
  // The stored record of the reported job `d61e52f6` as written BEFORE the fix:
  // legacy counter 0, no candidatePath/stageAMetricsStatus, an all-zero Stage-A
  // snapshot, the observe cadence metrics present, and 24 persisted decision
  // rows (its distinct produced highlights).
  const legacyJob = () => ({
    candidatesTriggered: 0,
    highlightsFound: 24,
    candidates: Array.from({ length: 24 }, (_, i) => ({ seq: i, ts: i, eventType: "GOAL", decision: "scoring_play" })),
    vodObserveMetrics: { decideCalls: 261, accepted: 75, maxFrames: 16, subsampledCalls: 0, framesPerCall: [] },
    stageAMetrics: zeroSnapshot(),
  });

  it("derives 24 observe candidates and n/a Stage-A from a pre-fix record", () => {
    const fields = counterFieldsForJob(legacyJob());
    // 24 distinct produced candidates, NOT the observe observer's 75-window tally.
    expect(fields.candidatesTriggered).toBe(24);
    expect(fields.candidatePath).toBe("observe");
    expect(fields.stageAMetricsStatus).toBe("n/a");
    expect(fields.stageAMetrics).toBeUndefined();
  });

  it("leaves a record that already carries the fields untouched", () => {
    const snap = measuredSnapshot(4, 1);
    const fields = counterFieldsForJob({
      candidatesTriggered: 24,
      candidatePath: "observe",
      stageAMetrics: snap,
      stageAMetricsStatus: "measured",
      candidates: [],
      highlightsFound: 24,
    });
    expect(fields).toEqual({});
  });

  it("keeps a real Stage-A measurement when the snapshot judged candidates", () => {
    const snap = measuredSnapshot(4, 1);
    const fields = counterFieldsForJob({ ...legacyJob(), stageAMetrics: snap });
    expect(fields.stageAMetricsStatus).toBe("measured");
    expect(fields.stageAMetrics).toBeUndefined(); // nothing to override
  });

  it("falls back to the legacy perceive-gate counter when the observer never ran", () => {
    const fields = counterFieldsForJob({ candidatesTriggered: 7, highlightsFound: 7, stageAMetrics: zeroSnapshot() });
    expect(fields.candidatesTriggered).toBe(7);
    expect(fields.candidatePath).toBe("perceive_gate");
  });

  it("reports the trail's candidates for an in-flight job with no legacy counter", () => {
    // Mid-analyze: decisions persisted, completion counters not yet written.
    const fields = counterFieldsForJob({ candidatesTriggered: 0, candidates: [{ seq: 1 }, { seq: 9 }], highlightsFound: 2 });
    expect(fields.candidatesTriggered).toBe(2);
    expect(fields.candidatePath).toBe("observe");
  });

  it("reports none when no path produced a candidate", () => {
    const fields = counterFieldsForJob({ candidatesTriggered: 0, highlightsFound: 0, candidates: [] });
    expect(fields.candidatesTriggered).toBe(0);
    expect(fields.candidatePath).toBe("none");
  });

  it("uses highlightsFound when the decision trail predates it", () => {
    const fields = counterFieldsForJob({ highlightsFound: 9, vodObserveMetrics: { accepted: 30 } });
    expect(fields.candidatesTriggered).toBe(9);
    expect(fields.candidatePath).toBe("observe");
  });
});

// ADAAAA-7667: fixture live RTMP job 12927ed6 — 5 decide calls, 2 accepted
// observe decisions, no persisted highlight (`highlightsFound: 0`). The live
// record carries `observeMetrics` and NO `candidatePath` (the live completion
// patch never wrote the counters), so the VOD-only projection fell through to
// `0 / "none"` and the job-detail "Candidates" header read 0 next to a
// non-zero Decide-calls header.
describe("live candidate-count projection (ADAAAA-7667)", () => {
  // Stored record of the fixture job, as runLiveJob actually persisted it:
  // stageAMetrics absent, no candidates trail, decideCalls mirrored from the
  // observe pass (ADAAAA-7664) and no candidate counters at all.
  const liveFixture = () => ({
    status: "done" as const,
    highlightsFound: 0,
    decideCalls: 5,
    observeMetrics: {
      decideCalls: 5,
      accepted: 2,
      maxFrames: 30,
      meanE2eMs: 15204.8,
      maxE2eMs: 25862,
      meanCadenceMs: 2500,
      maxCadenceMs: 3000,
    },
  });

  it("reports the fixture live job as 2 observe candidates, not 0/none", () => {
    const fields = counterFieldsForJob(liveFixture());
    expect(fields.candidatesTriggered).toBe(2);
    expect(fields.candidatePath).toBe("observe");
    // The header renders `candidateCountLabel(job)` over the projected job.
    expect({ ...liveFixture(), ...fields }.candidatesTriggered).toBe(2);
  });

  it("prefers the deduped persisted highlight count over the per-window tally", () => {
    // Overlapping live windows can accept the same play twice (5 accepts, 3
    // distinct persisted highlights). The persisted count wins.
    const fields = counterFieldsForJob({
      highlightsFound: 3,
      observeMetrics: { decideCalls: 9, accepted: 5 },
    });
    expect(fields.candidatesTriggered).toBe(3);
    expect(fields.candidatePath).toBe("observe");
  });

  it("uses the decided trail when it is the only per-play evidence", () => {
    const fields = counterFieldsForJob({
      candidates: [{ seq: 1 }, { seq: 7 }],
      highlightsFound: 2,
      observeMetrics: { decideCalls: 6, accepted: 4 },
    });
    expect(fields.candidatesTriggered).toBe(2);
    expect(fields.candidatePath).toBe("observe");
  });

  it("reports a measured 0 from the observe path when it accepted nothing", () => {
    const fields = counterFieldsForJob({ observeMetrics: { decideCalls: 4, accepted: 0 } });
    expect(fields.candidatesTriggered).toBe(0);
    // The path that ran IS observe: never "none" for a live job whose observer ran.
    expect(fields.candidatePath).toBe("observe");
  });

  it("leaves a live record that already carries counters untouched", () => {
    expect(
      counterFieldsForJob({
        candidatesTriggered: 2,
        candidatePath: "observe",
        stageAMetricsStatus: "n/a",
        decideCalls: 5,
        observeMetrics: { decideCalls: 5, accepted: 2 },
      })
    ).toEqual({});
  });

  it("never emits a negative or fractional live count", () => {
    expect(liveCandidateCountForJob(-3, 0)).toEqual({ count: 0, path: "observe" });
    expect(liveCandidateCountForJob(2.9, 0)).toEqual({ count: 2, path: "observe" });
    expect(liveCandidateCountForJob(undefined, 0)).toEqual({ count: 0, path: "none" });
  });
});

describe("completedLiveCounterFields (ADAAAA-7667)", () => {
  it("persists the live accepted count with the observe path", () => {
    const fields = completedLiveCounterFields(zeroSnapshot(), { accepted: 2 }, 0);
    expect(fields.candidatesTriggered).toBe(2);
    expect(fields.candidatePath).toBe("observe");
    // A gate that judged nothing still reads n/a, never a measured 0%.
    expect(fields.stageAMetricsStatus).toBe("n/a");
    expect(fields.stageAMetrics).toBeUndefined();
  });

  it("persists the deduped highlight count when highlights already landed", () => {
    const fields = completedLiveCounterFields(zeroSnapshot(), { accepted: 4 }, 2);
    expect(fields.candidatesTriggered).toBe(2);
    expect(fields.candidatePath).toBe("observe");
  });

  it("reports none for a live job whose observer never ran", () => {
    const fields = completedLiveCounterFields(zeroSnapshot(), undefined, 0);
    expect(fields.candidatesTriggered).toBe(0);
    expect(fields.candidatePath).toBe("none");
  });
});

describe("completedCounterFields (ADAAAA-7624)", () => {
  it("persists the reported job shape as 24 observe candidates with n/a Stage-A", () => {
    // The deployed bug: 24 observe-path highlights persisted as `0 candidates`
    // plus a measured-looking all-zero Stage-A snapshot.
    const fields = completedCounterFields(zeroSnapshot(), 24, 0);
    expect(fields.candidatesTriggered).toBe(24);
    expect(fields.candidatePath).toBe("observe");
    expect(fields.stageAMetricsStatus).toBe("n/a");
    expect(fields.stageAMetrics).toBeUndefined();
  });

  it("keeps a measured Stage-A snapshot next to the legacy candidate fallback", () => {
    const snap = measuredSnapshot(4, 1);
    const fields = completedCounterFields(snap, undefined, 3);
    expect(fields.candidatesTriggered).toBe(3);
    expect(fields.candidatePath).toBe("perceive_gate");
    expect(fields.stageAMetricsStatus).toBe("measured");
    expect(fields.stageAMetrics).toEqual(snap);
  });
});

// ADAAAA-7664: the live observe pass counted its decide invocations in
// `observeMetrics.decideCalls` and never wrote the job-level `decideCalls`
// field, so a live job with 17 real decides (fixture 2118ea32) read
// `decideCalls: null` and every header rendered "Decide calls 0".
describe("decide-call count projection (ADAAAA-7664)", () => {
  it("reports the observe-pass count for a live job with no job-level field", () => {
    const live = { observeMetrics: { decideCalls: 17 }, candidatesTriggered: 0, candidatePath: "none" as const };
    const fields = counterFieldsForJob(live);
    expect(fields.decideCalls).toBe(17);
    // The header reads the projected job, so the count is >= the audit rows.
    expect({ ...live, ...fields }.decideCalls).toBe(17);
  });

  it("leaves a VOD job's job-level decideCalls untouched (including 0)", () => {
    expect(counterFieldsForJob({ decideCalls: 18 }).decideCalls).toBeUndefined();
    expect({ decideCalls: 18, ...counterFieldsForJob({ decideCalls: 18 }) }.decideCalls).toBe(18);
    expect({ decideCalls: 0, ...counterFieldsForJob({ decideCalls: 0 }) }.decideCalls).toBe(0);
  });

  it("prefers the job-level field when both are recorded", () => {
    const fields = counterFieldsForJob({ decideCalls: 4, observeMetrics: { decideCalls: 99 } });
    expect(fields.decideCalls).toBeUndefined();
    expect({ decideCalls: 4, ...fields }.decideCalls).toBe(4);
  });

  it("projects 0 for a live observer that fired no decide, and nothing when neither ran", () => {
    expect(counterFieldsForJob({ observeMetrics: { decideCalls: 0 } }).decideCalls).toBe(0);
    expect(counterFieldsForJob({}).decideCalls).toBeUndefined();
  });
});
