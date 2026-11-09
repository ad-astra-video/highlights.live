// ADAAAA-8492 (ATTEST-4): pin the `scoreBoardChanged`-hint-only accept.
//
// The ATTEST-1 QA re-grade read `liveGoalHasMeasuredEvidence` as accepting a
// change HINT with an UNREAD score span: `scoreChangeAttests(null, reads)` with
// fewer than two readings is "absent evidence, never a contradiction"
// (`scoreReadsContradictChange`), so `scoreReads: 0` attests. That would make the
// `reads === 0` copy branch in `liveUnattestedGoalRefusal` unreachable through
// the demote seam.
//
// Incidence census on the box DB (2026-11-09, `$0`, read-only psql) says the
// shape has never been stored, so the gate is NOT changed (AT4-AC1):
//
//   highlights with `attestationUsed`, status=accepted,
//   eventType=GOAL OR outcome=scoring_play               150 rows
//     scoreBoardChanged=true                               115 rows
//     scoreBoardChanged=true AND scoreReads=0                0 rows
//     scoreBoardChanged=true AND postSamples=0               6 rows (all also
//       goal-line attested; none has scoreReads=0)
//     scoreBoardChanged=true AND scoreReads<need(2)          0 rows
//   live legs only (jobs.record->>'source' in browser,rtmp)  43 rows
//     scoreBoardChanged=true                                  34 rows
//     scoreBoardChanged=true AND scoreReads=0                   0 rows
//
// So this file pins the CURRENT verdict (true => outcome stays `scoring_play`,
// guard declined on incidence 0) and the falsifiers that must keep demoting, and
// keeps the accepted row of leg `ec4c3e0e` attesting at `postSamples=2 need=2`.
import { describe, expect, it } from "vitest";
import {
  downgradeUnattestedLiveGoal,
  liveGoalAttestationUsed,
  liveGoalHasMeasuredEvidence,
  liveUnattestedGoalRefusal,
  scoreChangeAttests,
  scoreReadsContradictChange,
  type DecisionResult,
  type LiveGoalAttestationUsed,
  type ScoreReadDiagnostics,
} from "../src/analyzer.js";

/** The demote seam in `analyzeCandidate` (analyzer.ts:6471): a goal accept is
 * demoted only when the measured-attestation gate reads false. */
function liveSeamOutcome(attested: boolean): "scoring_play" | "big_play" {
  return attested ? "scoring_play" : "big_play";
}

const scoring: DecisionResult = {
  isHighlight: true,
  outcome: "scoring_play",
  eventType: "GOAL",
  score: 90,
  reason: "Scoreboard changes from 1-0 to 2-0.",
};

/** A pooled re-read span the scorebug produced NOTHING for. */
const UNREAD: ScoreReadDiagnostics = {
  scoreReads: 0,
  preSamples: 0,
  postSamples: 0,
  need: 2,
  scoreStates: 0,
  newestTransition: null,
};

describe("AT4-AC2: a scoreBoardChanged hint with scoreReads=0 (incidence 0 => guard declined)", () => {
  it("attests: the hint alone is measured evidence when the span carries no reads", () => {
    expect(scoreReadsContradictChange(UNREAD)).toBe(false);
    expect(scoreChangeAttests(null, UNREAD)).toBe(true);
    expect(liveGoalHasMeasuredEvidence({ scoreBoardChanged: true, scoreReads: UNREAD })).toBe(true);
  });

  it("keeps the outcome in the scoring lane — the demote seam never sees this shape", () => {
    const used = liveGoalAttestationUsed({
      attribution: { scoreBoardChanged: true },
      scoreReads: UNREAD,
    });
    expect(used).toMatchObject({ scoreBoardChanged: true, scoreReads: 0, postSamples: 0, need: 2 });
    // The gate reads the SAME fields the record discloses.
    const attested = liveGoalHasMeasuredEvidence({
      scoreBoardChanged: used.scoreBoardChanged,
      goalCrossed: used.goalCrossed,
      ballOutcome: used.ballOutcome,
      corroborated: used.corroborated,
      goalConfirmed: used.goalConfirmed,
      scoreReads: UNREAD,
    });
    expect(attested).toBe(true);
    expect(liveSeamOutcome(attested)).toBe("scoring_play");
  });

  it("pins the `reads === 0` copy branch as dead through the demote seam", () => {
    const used: LiveGoalAttestationUsed = {
      scoreBoardChanged: true,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
      scoreReads: 0,
      preSamples: 0,
      postSamples: 0,
      need: 2,
    };
    // The sentence exists (copy-only callers can reach it) ...
    expect(liveUnattestedGoalRefusal(used)).toContain("scorebug was never read in this span");
    // ... and would demote IF the seam called it ...
    expect(downgradeUnattestedLiveGoal(scoring, used).outcome).toBe("big_play");
    // ... but the gate attests this exact input, so the seam never reaches it.
    expect(liveGoalHasMeasuredEvidence({ scoreBoardChanged: true, scoreReads: UNREAD })).toBe(true);
  });
});

describe("AT4-AC3: the falsifiers keep failing closed", () => {
  it("demotes frame-only corroboration (no measured channel)", () => {
    expect(liveGoalHasMeasuredEvidence({})).toBe(false);
    expect(liveGoalHasMeasuredEvidence({ scoreBoardChanged: false })).toBe(false);
  });

  it("demotes a score-steady span even when the hint is true", () => {
    const steady: ScoreReadDiagnostics = {
      scoreReads: 5,
      preSamples: 5,
      postSamples: 0,
      need: 2,
      scoreStates: 1,
      newestTransition: null,
    };
    expect(scoreReadsContradictChange(steady)).toBe(true);
    expect(liveGoalHasMeasuredEvidence({ scoreBoardChanged: true, scoreReads: steady })).toBe(false);
  });

  it("demotes a backward or multi-goal boundary even when the hint is true", () => {
    const backward: ScoreReadDiagnostics = {
      scoreReads: 9,
      preSamples: 3,
      postSamples: 6,
      need: 2,
      scoreStates: 2,
      newestTransition: "2-2>1-1",
    };
    const multiGoal: ScoreReadDiagnostics = { ...backward, newestTransition: "1-1>3-1" };
    expect(liveGoalHasMeasuredEvidence({ scoreBoardChanged: true, scoreReads: backward })).toBe(false);
    expect(liveGoalHasMeasuredEvidence({ scoreBoardChanged: true, scoreReads: multiGoal })).toBe(false);
  });

  it("demotes a non-goal delta even when the counts look legible", () => {
    expect(
      liveGoalHasMeasuredEvidence({
        scoreBoardChanged: true,
        scoreBoardDelta: { pre: [1, 1], post: [1, 1], preTs: 0, postTs: 1, deltaTs: 1, preSamples: 2, postSamples: 2 },
      })
    ).toBe(false);
  });
});

describe("AT4-AC3: the measured transition of leg ec4c3e0e still attests", () => {
  // Stored row `1e56d981-3859-4f01-8c8f-bd0116b3271e` on live leg `ec4c3e0e`
  // (highlights.attestationUsed, verified 2026-11-09):
  //   scoreBoardChanged=true, scoreReads=13, preSamples=6, postSamples=2, need=2
  const stored: LiveGoalAttestationUsed = {
    scoreBoardChanged: true,
    goalCrossed: false,
    ballOutcome: null,
    corroborated: false,
    goalConfirmed: null,
    scoreReads: 13,
    preSamples: 6,
    postSamples: 2,
    need: 2,
  };
  // The disclosed support (6 pre / 2 post, need 2) is a legible single forward
  // step; the row credited it through the hint+span channel (no delta key).
  const span: ScoreReadDiagnostics = {
    scoreReads: 13,
    preSamples: 6,
    postSamples: 2,
    need: 2,
    scoreStates: 2,
    newestTransition: "1-1>2-1",
  };

  it("attests at postSamples=2 need=2", () => {
    expect(stored.postSamples).toBeGreaterThanOrEqual(stored.need ?? 0);
    expect(liveGoalHasMeasuredEvidence({ scoreBoardChanged: true, scoreReads: span })).toBe(true);
    expect(liveSeamOutcome(true)).toBe("scoring_play");
  });

  it("does not print a refusal sentence that contradicts its own counts", () => {
    expect(liveUnattestedGoalRefusal(stored)).not.toContain("never read");
    expect(liveUnattestedGoalRefusal(stored)).not.toContain("no measured attestation");
  });
});
