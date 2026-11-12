import { describe, expect, it } from "vitest";
import {
  LiveRunShared,
  buildCandidateNote,
  formatGoalBurstSuppressionReason,
  liveGoalAttestationUsed,
  liveGoalHasMeasuredEvidence,
  scoreChangeAttests,
  scoreReadDiagnostics,
  scoreReadsContradictChange,
  scoreTransitionKey,
  type AnalyzerConfig,
  type CandidateSignal,
  type DecisionResult,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer";
import { JobCandidateSchema } from "@highlights/events";
import type { HighlightTrigger, JobCandidate } from "@highlights/events";

// ADAAAA-8140: the pre-accept loss path (goal-shaped candidates suppressed with
// no recorded reason) + the missing attestation disclosure on ACCEPTED goal
// rows. Regression fixture: live job `bca08173` —
//   * 23.95s GOAL-shaped accept demoted to a celebration still stamped the burst
//     reference, so the real goal at 49.99s was suppressed with no reason and no
//     delivered GOAL to point at;
//   * 160.55s "Scoreboard changes from 1-1 to 1-1 (OCR)" was ACCEPTED as a GOAL
//     (no-op transition), and it then suppressed the real 1-1 -> 2-1 goal at
//     176.28s.

type Reading = { ts: number; score: [number, number] };

const steady = (score: [number, number], n = 6, from = 0): Reading[] =>
  Array.from({ length: n }, (_, i) => ({ ts: from + i, score }));

function delta(pre: [number, number], post: [number, number]): ScoreboardDeltaEvidence {
  return { pre, post, preTs: 100, postTs: 104, deltaTs: 104, preSamples: 3, postSamples: 3 };
}

describe("scoreReadDiagnostics discloses what the span measured (ADAAAA-8140)", () => {
  it("reads a score-steady span as ONE state and no transition", () => {
    const diag = scoreReadDiagnostics(steady([1, 1], 8), { lo: 0, hi: 7 });
    expect(diag.scoreReads).toBe(8);
    expect(diag.scoreStates).toBe(1);
    expect(diag.newestTransition).toBeNull();
  });

  it("reads a forward transition and its support counts", () => {
    const readings = [...steady([1, 1], 4, 0), ...steady([2, 1], 4, 4)];
    const diag = scoreReadDiagnostics(readings, { lo: 0, hi: 7 });
    expect(diag.scoreStates).toBe(2);
    expect(diag.newestTransition).toBe("1-1>2-1");
    expect(diag.preSamples).toBe(4);
    expect(diag.postSamples).toBe(4);
  });

  it("reads a BACKWARD transition (2-2 -> 1-1) as a boundary, not a goal", () => {
    const readings = [...steady([2, 2], 3, 0), ...steady([1, 1], 3, 3)];
    expect(scoreReadDiagnostics(readings, { lo: 0, hi: 5 }).newestTransition).toBe("2-2>1-1");
  });
});

describe("scoreReadsContradictChange / scoreChangeAttests fail closed (AC3)", () => {
  it("contradicts a claim on a score-steady span (no-op 1-1 -> 1-1)", () => {
    const diag = scoreReadDiagnostics(steady([1, 1], 8), { lo: 0, hi: 7 });
    expect(scoreReadsContradictChange(diag)).toBe(true);
    expect(scoreChangeAttests(null, diag)).toBe(false);
  });

  it("contradicts a claim whose span moves BACKWARD (2-2 -> 1-1)", () => {
    const readings = [...steady([2, 2], 3, 0), ...steady([1, 1], 3, 3)];
    const diag = scoreReadDiagnostics(readings, { lo: 0, hi: 5 });
    expect(scoreReadsContradictChange(diag)).toBe(true);
    expect(scoreChangeAttests(null, diag)).toBe(false);
  });

  it("does not contradict a forward span, and a forward delta attests", () => {
    const readings = [...steady([1, 1], 4, 0), ...steady([2, 1], 4, 4)];
    const diag = scoreReadDiagnostics(readings, { lo: 0, hi: 7 });
    expect(scoreReadsContradictChange(diag)).toBe(false);
    expect(scoreChangeAttests(delta([1, 1], [2, 1]), diag)).toBe(true);
  });

  it("refuses an EQUAL delta and a BACKWARD delta even when the claim is true", () => {
    expect(scoreChangeAttests(delta([1, 1], [1, 1]))).toBe(false);
    expect(scoreChangeAttests(delta([2, 2], [1, 1]))).toBe(false);
  });

  it("an unreadable span (fewer than 2 readings) is absent evidence, not a contradiction", () => {
    const diag = scoreReadDiagnostics([{ ts: 0, score: [1, 1] }], { lo: 0, hi: 1 });
    expect(scoreReadsContradictChange(diag)).toBe(false);
    expect(scoreChangeAttests(null, diag)).toBe(true);
  });
});

describe("liveGoalHasMeasuredEvidence (AC3: no-op / backward produces no GOAL)", () => {
  it("refuses a scoreBoardChanged claim the measured span contradicts", () => {
    const diag = scoreReadDiagnostics(steady([1, 1], 8), { lo: 0, hi: 7 });
    expect(
      liveGoalHasMeasuredEvidence({ scoreBoardChanged: true, scoreReads: diag, scoreBoardDelta: null })
    ).toBe(false);
  });

  it("refuses a claim whose delta is a no-op or backward, whatever the span says", () => {
    expect(
      liveGoalHasMeasuredEvidence({ scoreBoardChanged: true, scoreBoardDelta: delta([1, 1], [1, 1]) })
    ).toBe(false);
    expect(
      liveGoalHasMeasuredEvidence({ scoreBoardChanged: true, scoreBoardDelta: delta([2, 2], [1, 1]) })
    ).toBe(false);
  });

  it("accepts a forward measured delta", () => {
    expect(
      liveGoalHasMeasuredEvidence({ scoreBoardChanged: true, scoreBoardDelta: delta([1, 1], [2, 1]) })
    ).toBe(true);
  });

  it("keeps the other measured channels independent of the score span", () => {
    const contradicted = scoreReadDiagnostics(steady([1, 1], 8), { lo: 0, hi: 7 });
    expect(
      liveGoalHasMeasuredEvidence({ scoreBoardChanged: true, scoreReads: contradicted, goalCrossed: true })
    ).toBe(true);
    expect(liveGoalHasMeasuredEvidence({ corroborated: true, scoreReads: contradicted })).toBe(false);
    // ADAAAA-8728 (R1): only a NAMED measured source attests; the same claim
    // with a scoreboard corroboration is still MEASURED evidence.
    expect(
      liveGoalHasMeasuredEvidence({ corroborated: true, corroborationSource: "scoreboard", scoreReads: contradicted })
    ).toBe(true);
  });
});

describe("accepted GOAL rows disclose the attestation they used (AC3)", () => {
  it("carries the five flags, the credited transition and the read counts", () => {
    const readings = [...steady([1, 1], 4, 0), ...steady([2, 1], 4, 4)];
    const used = liveGoalAttestationUsed({
      attribution: { scoreBoardChanged: true, scoreBoardDelta: delta([1, 1], [2, 1]) },
      goalConfirmed: null,
      scoreReads: scoreReadDiagnostics(readings, { lo: 0, hi: 7 }),
      transitionKey: scoreTransitionKey(delta([1, 1], [2, 1])),
    });
    expect(used).toMatchObject({
      scoreBoardChanged: true,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
      transitionKey: "1-1>2-1",
      scoreReads: 8,
      preSamples: 4,
      postSamples: 4,
      need: 2,
    });
  });
});

describe("suppressed candidate notes always name why (AC1/AC2)", () => {
  const cfg = (sink: JobCandidate[]): AnalyzerConfig =>
    ({ jobId: "job-8140", onDecision: (c: JobCandidate) => sink.push(c) }) as unknown as AnalyzerConfig;
  const candidate: CandidateSignal = { eventType: "GOAL", timestamp: 49.99, seq: 7 };
  const trigger: HighlightTrigger = { kind: "motion", timestamp: 49.99, eventType: "GOAL" };
  const decision: DecisionResult = {
    isHighlight: true,
    score: 85,
    eventType: "GOAL",
    outcome: "scoring_play",
    reason: "Ball enters net at t=-1.5s; keeper is beaten and players celebrate.",
  };

  it("writes a machine-readable suppressionReason + evidence on a goal-burst suppression", () => {
    const run = new LiveRunShared();
    run.noteAcceptedGoalEvent({
      highlightId: "hl-delivered",
      anchorTs: 158.5,
      start: 150,
      end: 165,
      candidateTs: 160.55,
      transitionKey: "1-1>2-1",
      idempotencyKey: "hl:job-8140:61:GOAL",
    });
    const sup = run.goalBurstSuppression({ ts: 168, eventType: "GOAL", transitionKey: "1-1>2-1" });
    expect(sup).toBeDefined();
    const reason = formatGoalBurstSuppressionReason(sup!);
    const out: JobCandidate[] = [];
    buildCandidateNote(
      cfg(out),
      { ...candidate, timestamp: 168 },
      decision,
      "suppressed",
      "cid-8140",
      trigger,
      undefined,
      undefined,
      { reason, evidence: { ...sup!, candidateTs: 168 } }
    );
    const row = JobCandidateSchema.parse(out[0]);
    expect(row.status).toBe("suppressed");
    expect(row.suppressionReason).toBe(reason);
    expect(row.suppressionReason).toContain("dedupeAgainst=hl-delivered@160.550s");
    expect(row.suppressionReason).toContain("idempotencyKey=hl:job-8140:61:GOAL");
    expect(row.suppressionReason).toContain("transition=1-1>2-1");
    expect(row.suppressionEvidence?.dedupeAgainstHighlightId).toBe("hl-delivered");
    expect(row.suppressionEvidence?.gapS).toBeCloseTo(7.45, 2);
    expect(row.suppressionEvidence?.burstSize).toBe(1);
  });

  it("never writes a silent suppressed row: a missing reason is recorded and logged", () => {
    const out: JobCandidate[] = [];
    buildCandidateNote(cfg(out), candidate, decision, "suppressed", "cid-silent", trigger);
    expect(out[0].suppressionReason).toBe("suppressed:unattributed");
  });

  it("leaves accepted / rejected notes without a suppressionReason", () => {
    const out: JobCandidate[] = [];
    buildCandidateNote(cfg(out), candidate, decision, "accepted", "cid-a", trigger);
    expect(out[0].suppressionReason).toBeUndefined();
    expect(out[0].suppressionEvidence).toBeUndefined();
  });
});
