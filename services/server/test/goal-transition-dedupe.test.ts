// ADAAAA-7865: one score transition must yield one SCORING highlight.
//
// Job dee44c2f has ONE score change in 300 s (`POR 0-0 ESP` at 153.6 s ->
// `POR 1-0 ESP` at 159.0 s) but the deployed VOD path accepted four GOAL
// highlights for it. These tests pin the rule that keeps the real goal's windows
// accepted while turning the post-goal celebration re-reads into celebrations.
import { describe, expect, it } from "vitest";
import {
  GOAL_DUPLICATE_REACH_S,
  downgradeRepeatGoalCelebration,
  findRepeatGoalEvent,
  goalHasIndependentTransitionEvidence,
  type AcceptedGoalEvent,
} from "../src/analyzer.js";

// The accepted goal of the replay: anchor 153.6, delivered clip 146.6-161.6.
const GOAL_EVENT: AcceptedGoalEvent = {
  highlightId: "hl-goal-153",
  anchorTs: 153.6,
  start: 146.6,
  end: 161.6,
};

describe("goalHasIndependentTransitionEvidence (ADAAAA-7865)", () => {
  it("credits a measured legible scoreboard delta", () => {
    expect(goalHasIndependentTransitionEvidence({ corroborationSource: "scoreboard" })).toBe(true);
    expect(goalHasIndependentTransitionEvidence({ scoreboardDeltaLegible: true })).toBe(true);
  });

  it("credits a goal-calling audio read", () => {
    expect(goalHasIndependentTransitionEvidence({ corroborationSource: "audio_text" })).toBe(true);
  });

  it("does NOT credit the deep dive's own score-change read (ADAAAA-7938)", () => {
    // A celebration window that merely DISPLAYS the new score makes the dive
    // answer true; that is model prose, not a measured transition (VOD job
    // 4a0a149d accepted a second scoring_play off it). Only a MEASURED delta or
    // a heard goal call opens a new event.
    expect(goalHasIndependentTransitionEvidence({ confirmEvidenceScoreboardChanged: true })).toBe(false);
    expect(goalHasIndependentTransitionEvidence({ confirmEvidenceScoreboardChanged: false })).toBe(false);
    expect(goalHasIndependentTransitionEvidence({ confirmEvidenceScoreboardChanged: null })).toBe(false);
  });

  it("treats celebration frame attestation alone as NO transition evidence", () => {
    expect(
      goalHasIndependentTransitionEvidence({
        corroborationSource: "frame_attestation",
        scoreboardDeltaLegible: false,
        confirmEvidenceScoreboardChanged: false,
      })
    ).toBe(false);
  });
});

describe("findRepeatGoalEvent (ADAAAA-7865)", () => {
  it("accepts the FIRST goal as a new scoring event", () => {
    expect(findRepeatGoalEvent([], { anchorTs: 153.6, start: 146.6, end: 161.6, isGoal: true })).toBeUndefined();
  });

  it("accepts a window of the same goal that anchors inside the accepted clip", () => {
    // The replay's 159 accept anchors at 159.0, inside 146.6-161.6.
    expect(
      findRepeatGoalEvent([GOAL_EVENT], {
        anchorTs: 159.0,
        start: 152.0,
        end: 167.0,
        isGoal: true,
        corroborationSource: "frame_attestation",
      })
    ).toBeUndefined();
  });

  it("flags the post-goal celebration re-reads as repeats of the accepted goal", () => {
    // Replay accepts 183.1 and 190.6: no score change inside the clip, no
    // legible scorebug, credited only by celebration frames.
    for (const anchorTs of [183.1, 190.6]) {
      expect(
        findRepeatGoalEvent([GOAL_EVENT], {
          anchorTs,
          start: anchorTs - 7,
          end: anchorTs + 8,
          isGoal: true,
          corroborationSource: "frame_attestation",
          scoreboardDeltaLegible: false,
          confirmEvidenceScoreboardChanged: false,
        })
      ).toEqual(GOAL_EVENT);
    }
  });

  it("accepts a repeat window that carries a NEW measured transition", () => {
    expect(
      findRepeatGoalEvent([GOAL_EVENT], {
        anchorTs: 183.1,
        start: 176.1,
        end: 191.1,
        isGoal: true,
        corroborationSource: "scoreboard",
      })
    ).toBeUndefined();
  });

  it("accepts a far-away goal even with no measured evidence (recall guard)", () => {
    // 240 s is beyond the duplicate reach of the 153.6 goal: that is a new goal,
    // not a celebration of the old one.
    expect(
      findRepeatGoalEvent([GOAL_EVENT], {
        anchorTs: 240.5,
        start: 233.5,
        end: 248.5,
        isGoal: true,
        corroborationSource: "frame_attestation",
      })
    ).toBeUndefined();
    expect(
      findRepeatGoalEvent([GOAL_EVENT], {
        anchorTs: 153.6 + GOAL_DUPLICATE_REACH_S - 0.5,
        start: 196.6,
        end: 211.6,
        isGoal: true,
      })
    ).toEqual(GOAL_EVENT);
  });

  it("never dedupes a non-GOAL accept", () => {
    expect(
      findRepeatGoalEvent([GOAL_EVENT], { anchorTs: 183.1, start: 176.1, end: 191.1, isGoal: false })
    ).toBeUndefined();
  });

  it("prefers the NEAREST covering event when several goals are accepted", () => {
    const later: AcceptedGoalEvent = { highlightId: "hl-goal-240", anchorTs: 240.0, start: 233, end: 248 };
    // 252 sits outside both clips but within reach of both anchors: the 240 goal
    // is the nearest one, so that is the event this window duplicates.
    expect(
      findRepeatGoalEvent([GOAL_EVENT, later], { anchorTs: 252.0, start: 252.0, end: 267.0, isGoal: true })
    ).toEqual(later);
  });

  it("ignores a non-finite anchor", () => {
    expect(findRepeatGoalEvent([GOAL_EVENT], { anchorTs: NaN, start: 176.1, end: 191.1, isGoal: true })).toBeUndefined();
  });
});

describe("downgradeRepeatGoalCelebration (ADAAAA-7865)", () => {
  const decision = {
    isHighlight: true,
    score: 95,
    eventType: "GOAL",
    outcome: "scoring_play" as const,
    reason: "The ball clearly enters the net, and the commentary confirms Ronaldo's 82nd goal.",
  };

  it("leaves the scoring lane but keeps the clip deliverable", () => {
    const d = downgradeRepeatGoalCelebration(decision, GOAL_EVENT);
    expect(d.outcome).toBe("big_play");
    expect(d.eventType).toBe("BIG_PLAY");
    expect(d.isHighlight).toBe(true);
    expect(d.score).toBe(95);
  });

  it("names the goal it duplicates in the reason (auditable)", () => {
    const d = downgradeRepeatGoalCelebration(decision, GOAL_EVENT);
    expect(d.reason).toContain("hl-goal-153");
    expect(d.reason).toContain("153.6s");
    expect(d.reason).toContain("no independent score-transition evidence");
    // Never re-introduce a goal-refuting phrase: the celebration clip is a real
    // moment, it just is not a second scoring event.
    expect(d.reason).not.toMatch(/not a goal|does not enter the net/i);
  });
});
