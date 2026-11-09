import { describe, expect, it } from "vitest";
import {
  LiveRunShared,
  buildCandidateNote,
  formatGoalBurstSuppressionReason,
  type AnalyzerConfig,
  type CandidateSignal,
  type DecisionResult,
} from "../src/analyzer";
import { JobCandidateSchema } from "@highlights/events";
import type { HighlightTrigger, JobCandidate } from "@highlights/events";

// ADAAAA-8491 (ATTEST-3 candidate): a live leg measured TWO GOAL transitions
// 17 s apart (`ec4c3e0e-aa74-4068-949f-d263b9a824d9`):
//   * delivered GOAL 1e56d981 @125.667s (`scoreReads=13 pre=6 post=2 need=2`,
//     its pooled reads split `2-1` -> `2-2`, i.e. the credited transition is
//     `2-1>2-2`); its stored `attestationUsed` cannot name that key because the
//     events schema does not declare the field (see the disclosure note below);
//   * the GOAL candidate at 142.667s measured the SAME `2-1>2-2` and was
//     suppressed with
//     `goal_burst_same_transition:dedupeAgainst=1e56d981-...@125.667s(scoring_goal);
//      idempotencyKey=hl:ec4c3e0e-...:628:GOAL;gap=17.000s;window=30s;
//      transition=2-1>2-2;burst=1`
//
// This fixture pins WHY the suppression happened instead of escalating: the
// shipped gate suppresses only when the candidate's own key EQUALS the
// delivered GOAL's ledger key (`analyzer.ts` goalBurstSuppression, the
// `key !== prevKey` / `key && !prevKey` refusals). So the stored row is
// reproducible only from a delivered-ledger key of `2-1>2-2`; a null or
// `1-1>2-1` ledger key escalates (the two falsifiers below). That is the
// verdict recorded on ADAAAA-8491: correct same-transition dedupe, not a
// distinct transition swallowed by the 30 s window.
//
// Disclosure gap (tracked separately, not a suppression defect): the analyzer
// types the credited transition as `LiveGoalAttestationUsed.transitionKey` and
// `liveGoalAttestationUsed()` sets it on ACCEPTED rows too, but
// `HighlightRecordSchema.attestationUsed` (`packages/events/src/index.ts`)
// declares only the five flags + `scoreReads/preSamples/postSamples/need`, and
// zod strips undeclared keys — `store.upsertHighlight` parses every row through
// that schema before it is stored. Hence the delivered row shows the read split
// (pre=6/post=2) but not the key its ledger entry carries.

const JOB = "ec4c3e0e-aa74-4068-949f-d263b9a824d9";
const DELIVERED = {
  highlightId: "1e56d981-3859-4f01-8c8f-bd0116b3271e",
  candidateTs: 125.66666666666666,
  idempotencyKey: `hl:${JOB}:628:GOAL`,
};
const REREAD_TS = 142.66666666666666;

/** The DELIVERED scoring GOAL's ledger entry, as the accept path records it. */
function deliveredGoal(run: LiveRunShared, transitionKey: string | null): void {
  run.noteAcceptedGoalEvent({
    highlightId: DELIVERED.highlightId,
    anchorTs: 123,
    start: 116,
    end: 131,
    candidateTs: DELIVERED.candidateTs,
    transitionKey,
    idempotencyKey: DELIVERED.idempotencyKey,
  });
}

describe("goal-burst same-transition dedupe on leg ec4c3e0e (ADAAAA-8491)", () => {
  it("reproduces the stored 142.667 s suppression from a delivered 2-1>2-2 transition", () => {
    const run = new LiveRunShared();
    deliveredGoal(run, "2-1>2-2");

    const sup = run.goalBurstSuppression({
      ts: REREAD_TS,
      eventType: "GOAL",
      transitionKey: "2-1>2-2",
    });

    expect(sup).toBeDefined();
    expect(sup!.kind).toBe("goal_burst_same_transition");
    expect(sup!.dedupeAgainstKind).toBe("scoring_goal");
    expect(sup!.dedupeAgainstHighlightId).toBe(DELIVERED.highlightId);
    expect(sup!.dedupeAgainstTs).toBeCloseTo(DELIVERED.candidateTs, 6);
    expect(sup!.dedupeAgainstIdempotencyKey).toBe(DELIVERED.idempotencyKey);
    expect(sup!.gapS).toBeCloseTo(17, 6);
    expect(sup!.windowS).toBe(30);
    expect(sup!.burstSize).toBe(1);
    expect(sup!.transitionKey).toBe("2-1>2-2");

    // Byte-for-byte the reason the live row carried.
    expect(formatGoalBurstSuppressionReason(sup!)).toBe(
      `goal_burst_same_transition:dedupeAgainst=${DELIVERED.highlightId}@125.667s(scoring_goal);` +
        `idempotencyKey=${DELIVERED.idempotencyKey};gap=17.000s;window=30s;transition=2-1>2-2;burst=1`
    );
  });

  it("falsifier: a NULL-key delivered GOAL escalates the 2-1>2-2 candidate (no loss)", () => {
    const run = new LiveRunShared();
    deliveredGoal(run, null);
    expect(
      run.goalBurstSuppression({ ts: REREAD_TS, eventType: "GOAL", transitionKey: "2-1>2-2" })
    ).toBeUndefined();
  });

  it("falsifier: a 1-1>2-1 delivered GOAL escalates the 2-1>2-2 candidate (no loss)", () => {
    const run = new LiveRunShared();
    deliveredGoal(run, "1-1>2-1");
    expect(
      run.goalBurstSuppression({ ts: REREAD_TS, eventType: "GOAL", transitionKey: "2-1>2-2" })
    ).toBeUndefined();
  });

  it("a keyless re-read still dedupes inside the window (the shootout path is unchanged)", () => {
    const run = new LiveRunShared();
    deliveredGoal(run, null);
    const sup = run.goalBurstSuppression({ ts: REREAD_TS, eventType: "GOAL" });
    expect(sup?.kind).toBe("goal_burst_same_transition");
    expect(sup!.transitionKey).toBeNull();
  });

  it("writes the stored candidate row shape (status=suppressed + evidence)", () => {
    const run = new LiveRunShared();
    deliveredGoal(run, "2-1>2-2");
    const sup = run.goalBurstSuppression({
      ts: REREAD_TS,
      eventType: "GOAL",
      transitionKey: "2-1>2-2",
    })!;

    const out: JobCandidate[] = [];
    const cfg = { jobId: JOB, onDecision: (c: JobCandidate) => out.push(c) } as unknown as AnalyzerConfig;
    const candidate: CandidateSignal = { eventType: "GOAL", timestamp: REREAD_TS, seq: 10 };
    const trigger: HighlightTrigger = {
      kind: "motion",
      timestamp: REREAD_TS,
      eventType: "AUDIO_BURST",
    };
    const decision: DecisionResult = {
      isHighlight: true,
      score: 85,
      eventType: "GOAL",
      outcome: "scoring_play",
      reason: "The ball is in the net and players are celebrating at t=0.0s.",
    };
    buildCandidateNote(cfg, candidate, decision, "suppressed", "cid-8491", trigger, undefined, undefined, {
      reason: formatGoalBurstSuppressionReason(sup),
      evidence: { ...sup, candidateTs: REREAD_TS },
    });

    const row = JobCandidateSchema.parse(out[0]);
    expect(row.status).toBe("suppressed");
    expect(row.eventType).toBe("GOAL");
    expect(row.outcome).toBe("scoring_play");
    expect(row.suppressionEvidence).toMatchObject({
      kind: "goal_burst_same_transition",
      windowS: 30,
      burstSize: 1,
      candidateTs: REREAD_TS,
      transitionKey: "2-1>2-2",
      dedupeAgainstKind: "scoring_goal",
      dedupeAgainstHighlightId: DELIVERED.highlightId,
      dedupeAgainstIdempotencyKey: DELIVERED.idempotencyKey,
    });
  });
});
