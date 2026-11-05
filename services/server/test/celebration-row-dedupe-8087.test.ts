// ADAAAA-8087: row emission on the live rail.
//
// Regression source: live leg of ADAAAA-8079 (job 00edb27a, 300 s
// `kids300_7935.mp4` at the shipped cell). The GOAL recall ruling held, but the
// leg shipped 6 rows against a pre-change 3 and the surplus was celebration-lane:
//
//   R1 GOAL     100.825
//   R2 BIG_PLAY 114.025  (distinct moment, kept)
//   R3 GOAL     156.325
//   R4 BIG_PLAY 161.586  <- inside R3's delivered clip: one event, two rows
//   R5 BIG_PLAY 184.290  (kept)
//   R6 BIG_PLAY 187.490  <- same reason text 3.2 s after R5: one moment, two rows
//
// These tests pin the two collapse rules at the accept-path seam: a celebration
// whose clip overlaps an already-delivered GOAL's clip, and two celebration
// accepts a moment apart carrying the same reason text.
import { describe, expect, it } from "vitest";
import {
  CELEBRATION_DUPLICATE_GAP_S,
  GOAL_DUPLICATE_REACH_S,
  LiveRunShared,
  celebrationReasonKey,
  findCelebrationDuplicate,
  type AcceptedCelebrationEvent,
  type AcceptedGoalEvent,
} from "../src/analyzer.js";

/** R3: the delivered GOAL of the same 300 s leg (clip 7 s before / 8 s after). */
const GOAL_R3: AcceptedGoalEvent = { highlightId: "hl-goal-156", anchorTs: 156.325, start: 149.325, end: 164.325 };
/** R1. */
const GOAL_R1: AcceptedGoalEvent = { highlightId: "hl-goal-100", anchorTs: 100.825, start: 93.825, end: 108.825 };
/** R5: the delivered celebration that R6 repeats. */
const CELEBRATION_R5: AcceptedCelebrationEvent = {
  highlightId: "hl-celeb-184",
  anchorTs: 184.29,
  start: 177.29,
  end: 192.29,
  reasonKey: celebrationReasonKey("The ball clearly enters the net and the keeper is beaten"),
};

const CELEBRATION_REASON = "The ball clearly enters the net and the keeper is beaten";

function celebration(anchorTs: number, reason = "A different, later reaction"): Parameters<typeof findCelebrationDuplicate>[2] {
  return { anchorTs, start: anchorTs - 7, end: anchorTs + 8, reason, isCelebration: true };
}

describe("celebrationReasonKey (ADAAAA-8087)", () => {
  it("normalises whitespace and case, keeps wording", () => {
    expect(celebrationReasonKey("  The  ball\nenters the net ")).toBe("the ball enters the net");
    expect(celebrationReasonKey("The ball enters the net")).not.toBe(celebrationReasonKey("The ball enters the net!"));
    expect(celebrationReasonKey(undefined)).toBe("");
    expect(celebrationReasonKey(null)).toBe("");
  });
});

describe("findCelebrationDuplicate — R4 inside R3's GOAL clip (ADAAAA-8087)", () => {
  it("collapses a celebration whose clip overlaps the delivered GOAL's clip", () => {
    // R4 anchors 5.261 s after R3, and its clip 154.586-169.586 overlaps the
    // goal's 149.325-164.325 — the goal row already shows this footage.
    expect(findCelebrationDuplicate([GOAL_R3], [], celebration(161.586))).toEqual({
      kind: "goal_clip",
      goal: GOAL_R3,
    });
  });

  it("keeps R2: 13.2 s past R1 it is outside the goal's clip (distinct trigger)", () => {
    // QA called R2 out as NOT part of the defect: its anchor sits past the
    // goal's ±10 s clip even though the 15 s clip windows share an edge.
    expect(findCelebrationDuplicate([GOAL_R1], [], celebration(114.025))).toBeUndefined();
  });

  it("keeps a celebration whose clip does not overlap any delivered GOAL", () => {
    // R5 at 184.29 vs R3's 149.325-164.325: 27.97 s later, no shared footage.
    expect(findCelebrationDuplicate([GOAL_R3], [], celebration(184.29))).toBeUndefined();
  });

  it("keeps an overlapping clip when the anchor is beyond the duplicate reach", () => {
    // 15 s clips overlap only within ~15 s; force a long clip to prove the reach
    // bound still guards a re-read far past GOAL_DUPLICATE_REACH_S.
    const longGoal: AcceptedGoalEvent = { highlightId: "hl-goal-0", anchorTs: 0, start: 0, end: 400 };
    const far = { ...celebration(GOAL_DUPLICATE_REACH_S + 30), start: 0, end: 400 };
    expect(findCelebrationDuplicate([longGoal], [], far)).toBeUndefined();
  });

  it("prefers the NEAREST overlapping goal (audit names the right row)", () => {
    const near: AcceptedGoalEvent = { highlightId: "hl-goal-160", anchorTs: 160, start: 153, end: 168 };
    expect(findCelebrationDuplicate([GOAL_R3, near], [], celebration(161.586))).toEqual({
      kind: "goal_clip",
      goal: near,
    });
  });
});

describe("findCelebrationDuplicate — R5/R6 same reason 3.2 s apart (ADAAAA-8087)", () => {
  it("collapses the second accept carrying the same reason text", () => {
    expect(findCelebrationDuplicate([], [CELEBRATION_R5], celebration(187.49, CELEBRATION_REASON))).toEqual({
      kind: "celebration_pair",
      celebration: CELEBRATION_R5,
    });
  });

  it("collapses regardless of trivial whitespace/case drift in the copy", () => {
    expect(
      findCelebrationDuplicate([], [CELEBRATION_R5], celebration(187.49, "  the BALL clearly enters the net and the keeper is beaten "))
    ).toEqual({ kind: "celebration_pair", celebration: CELEBRATION_R5 });
  });

  it("keeps a second celebration with different reason text (distinct moment)", () => {
    expect(findCelebrationDuplicate([], [CELEBRATION_R5], celebration(187.49, "The keeper dives low to his left"))).toBeUndefined();
  });

  it("keeps a same-reason celebration beyond the pair gap", () => {
    expect(
      findCelebrationDuplicate([], [CELEBRATION_R5], celebration(184.29 + CELEBRATION_DUPLICATE_GAP_S + 0.5, CELEBRATION_REASON))
    ).toBeUndefined();
  });

  it("never pairs two empty reasons (\"no text\" is not evidence of sameness)", () => {
    const silent: AcceptedCelebrationEvent = { ...CELEBRATION_R5, reasonKey: "" };
    expect(findCelebrationDuplicate([], [silent], celebration(187.49, ""))).toBeUndefined();
    expect(findCelebrationDuplicate([], [silent], celebration(187.49, undefined))).toBeUndefined();
  });

  it("never dedupes a GOAL-class accept (ADAAAA-7865 owns that lane)", () => {
    const goalInput = { ...celebration(161.586), isCelebration: false };
    expect(findCelebrationDuplicate([GOAL_R3], [CELEBRATION_R5], goalInput)).toBeUndefined();
  });

  it("ignores a non-finite anchor", () => {
    expect(findCelebrationDuplicate([GOAL_R3], [], { ...celebration(NaN) })).toBeUndefined();
  });
});

describe("LiveRunShared celebration ledger (ADAAAA-8087)", () => {
  it("replays the graded leg's row inventory through the run-level seam", () => {
    const run = new LiveRunShared();
    // R1 GOAL delivered.
    run.noteAcceptedGoalEvent(GOAL_R1);
    // R2 celebration 13.2 s later anchors OUTSIDE R1's clip -> distinct, kept.
    expect(run.celebrationDuplicateEvent({ ...celebration(114.025), isCelebration: true })).toBeUndefined();
    // R3 GOAL delivered (distinct transition).
    run.noteAcceptedGoalEvent(GOAL_R3);
    // R4 celebration inside R3's clip -> collapses.
    expect(run.celebrationDuplicateEvent({ ...celebration(161.586), isCelebration: true })).toEqual({
      kind: "goal_clip",
      goal: GOAL_R3,
    });
    // R5 delivered as a row and remembered.
    expect(run.celebrationDuplicateEvent({ ...celebration(184.29), isCelebration: true })).toBeUndefined();
    run.noteAcceptedCelebrationEvent(CELEBRATION_R5);
    // R6 carries R5's reason 3.2 s later -> collapses into R5.
    expect(
      run.celebrationDuplicateEvent({ ...celebration(187.49, CELEBRATION_REASON), isCelebration: true })
    ).toEqual({ kind: "celebration_pair", celebration: CELEBRATION_R5 });
    // A distinct moment after R5 still ships.
    expect(
      run.celebrationDuplicateEvent({ ...celebration(210.0, "The coach fist-pumps on the touchline"), isCelebration: true })
    ).toBeUndefined();
  });

  it("does not let a DROPPED accept become a row that suppresses a later moment", () => {
    const run = new LiveRunShared();
    run.noteAcceptedGoalEvent(GOAL_R1);
    // A collapse returns a duplicate but records nothing...
    expect(run.celebrationDuplicateEvent({ ...celebration(105.0), isCelebration: true })).toEqual({
      kind: "goal_clip",
      goal: GOAL_R1,
    });
    // ...so an unrelated celebration at 210 s is still judged on its own merits.
    expect(run.celebrationDuplicateEvent({ ...celebration(210.0), isCelebration: true })).toBeUndefined();
  });
});
