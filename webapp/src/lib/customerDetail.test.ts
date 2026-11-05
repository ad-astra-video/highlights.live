import { describe, it, expect } from "vitest";
import {
  CUSTOMER_WINDOW_CHECKED,
  CUSTOMER_WINDOW_GOAL_PENDING,
  CUSTOMER_WINDOW_HIGHLIGHT,
  CUSTOMER_WINDOW_NOTABLE,
  customerWindowRange,
  customerWindowStatus,
  customerWindowStatusKey,
  isEstablishedGoalNote,
  isGoalShapedNote,
} from "./customerDetail";
import type { DecideNote, FrameSection } from "./jobDetail";

// ADAAAA-8135: the customer projection must not read "Highlight detected" for a
// play the scoring lane DEMOTED, and must not call a non-goal celebration a
// highlight. The note shapes below are the measured ones on job
// 95e454a3-00eb-4de9-be58-ab3e7634add6 (the job the reporter saw):
//
//   t=12.468 BIG_PLAY / big_play / accepted          -> the notable-lane row
//   t=38.162 GOAL     / scoring_play / suppressed    -> the demoted goal
//   t=43.471 GOAL     / scoring_play / accepted      -> the postable goal
//   t=17.614 SPORTING_EVENT / not_highlight          -> checked, nothing found

function note(over: Partial<DecideNote> = {}): DecideNote {
  return {
    seq: 0,
    timestamp: 12.468,
    eventType: "BIG_PLAY",
    score: 85,
    outcome: "big_play",
    isHighlight: true,
    status: "accepted",
    ...over,
  };
}

function section(decideNotes: DecideNote[], index = 3): FrameSection {
  return { index, startS: index * 3, endS: (index + 1) * 3, frames: [], decideNotes };
}

const BIG_PLAY_CELEBRATION = note(); // 95e454a3 t=12.468 (notable lane row 84ac3dc7)
const DEMOTED_GOAL = note({
  timestamp: 38.162,
  eventType: "GOAL",
  outcome: "scoring_play",
  status: "suppressed",
  reason: "The scoreboard changes from 2-1 to 1-1; scoreboard score change confirmed",
});
const POSTABLE_GOAL = note({
  timestamp: 43.471,
  eventType: "GOAL",
  outcome: "scoring_play",
  status: "accepted",
});
const NOT_HIGHLIGHT = note({
  timestamp: 17.614,
  eventType: "SPORTING_EVENT",
  score: 0,
  outcome: "not_highlight",
  isHighlight: false,
  status: "rejected",
});

describe("goal-shaped note classification (ADAAAA-8135)", () => {
  it("counts a scoring_play outcome and a plain GOAL event as a goal claim", () => {
    expect(isGoalShapedNote(POSTABLE_GOAL)).toBe(true);
    expect(isGoalShapedNote(DEMOTED_GOAL)).toBe(true);
    expect(isGoalShapedNote(note({ eventType: "GOAL", outcome: undefined }))).toBe(true);
  });

  it("does NOT call a GOAL candidate scored near_miss / big_play a goal claim", () => {
    expect(isGoalShapedNote(note({ eventType: "GOAL", outcome: "near_miss" }))).toBe(false);
    expect(isGoalShapedNote(BIG_PLAY_CELEBRATION)).toBe(false);
    expect(isGoalShapedNote(NOT_HIGHLIGHT)).toBe(false);
  });

  it("an accepted claim, or a later confirmed_goal upgrade, is established", () => {
    expect(isEstablishedGoalNote(POSTABLE_GOAL)).toBe(true);
    // A demoted goal the confirm pass later upgraded is no longer "pending".
    expect(
      isEstablishedGoalNote({
        ...DEMOTED_GOAL,
        confirm: { request: {} as never, decision: { goalConfirmed: "confirmed_goal" } },
      })
    ).toBe(true);
    // ...while the same note without the confirmation is still pending.
    expect(isEstablishedGoalNote(DEMOTED_GOAL)).toBe(false);
  });
});

describe("customer window copy (ADAAAA-8135)", () => {
  it("reads 'Highlight detected' for the postable goal (95e454a3 t=43.471)", () => {
    const status = customerWindowStatus(section([POSTABLE_GOAL]));
    expect(status).toBe(CUSTOMER_WINDOW_HIGHLIGHT);
    expect(status).toBe("Highlight detected");
    expect(customerWindowStatusKey(status)).toBe("highlight");
  });

  it("reads 'Goal detected — awaiting score confirmation' for the demoted goal (t=38.162)", () => {
    const status = customerWindowStatus(section([DEMOTED_GOAL]));
    expect(status).toBe(CUSTOMER_WINDOW_GOAL_PENDING);
    expect(status).toBe("Goal detected — awaiting score confirmation");
    expect(customerWindowStatusKey(status)).toBe("goal_pending");
  });

  it("reads 'Highlight detected' once a confirmation upgrades the demoted goal", () => {
    const upgraded = {
      ...DEMOTED_GOAL,
      confirm: { request: {} as never, decision: { goalConfirmed: "confirmed_goal" as const } },
    };
    expect(customerWindowStatus(section([upgraded]))).toBe(CUSTOMER_WINDOW_HIGHLIGHT);
  });

  it("reads 'Notable play detected' for the non-goal celebration (t=12.468)", () => {
    expect(customerWindowStatus(section([BIG_PLAY_CELEBRATION]))).toBe(CUSTOMER_WINDOW_NOTABLE);
    expect(CUSTOMER_WINDOW_NOTABLE).toBe("Notable play detected");
  });

  it("reads 'Notable play detected' for a NEAR_MISS row without a goal claim", () => {
    const nearMiss = note({
      timestamp: 14.7,
      eventType: "NEAR_MISS",
      score: 45,
      outcome: "near_miss",
      nearMiss: true,
      status: "rejected",
    });
    expect(customerWindowStatus(section([nearMiss]))).toBe(CUSTOMER_WINDOW_NOTABLE);
  });

  it("keeps 'Checked — no highlight' for a not-highlight window and an empty window", () => {
    expect(customerWindowStatus(section([NOT_HIGHLIGHT]))).toBe(CUSTOMER_WINDOW_CHECKED);
    expect(customerWindowStatus(section([]))).toBe(CUSTOMER_WINDOW_CHECKED);
    expect(customerWindowStatusKey(CUSTOMER_WINDOW_CHECKED)).toBe("checked");
  });

  it("a suppressed NOT-highlight candidate can never invent a goal", () => {
    const suppressedCandidate = note({
      eventType: "GOAL",
      outcome: "not_highlight",
      isHighlight: false,
      status: "suppressed",
    });
    expect(customerWindowStatus(section([suppressedCandidate]))).toBe(CUSTOMER_WINDOW_CHECKED);
  });

  it("an established goal outranks a pending goal in the same window", () => {
    expect(customerWindowStatus(section([DEMOTED_GOAL, POSTABLE_GOAL]))).toBe(CUSTOMER_WINDOW_HIGHLIGHT);
    expect(customerWindowStatus(section([DEMOTED_GOAL, BIG_PLAY_CELEBRATION]))).toBe(
      CUSTOMER_WINDOW_GOAL_PENDING
    );
  });

  it("keeps the window's time range as the only timing a customer sees", () => {
    expect(customerWindowRange(section([DEMOTED_GOAL]))).toContain("T+9s");
  });
});

describe("customer copy carries no outcome codes, scores or internal tokens", () => {
  const COPY = [
    CUSTOMER_WINDOW_HIGHLIGHT,
    CUSTOMER_WINDOW_GOAL_PENDING,
    CUSTOMER_WINDOW_NOTABLE,
    CUSTOMER_WINDOW_CHECKED,
  ];
  const FORBIDDEN = [
    "scoring_play",
    "not_highlight",
    "near_miss",
    "big_play",
    "SPORTING_EVENT",
    "outcome",
    "suppressed",
    "accepted",
    "rejected",
    "decide",
    "corroborated",
    "/",
  ];

  it("every customer status string is plain prose", () => {
    for (const copy of COPY) {
      for (const token of FORBIDDEN) {
        expect(copy.toLowerCase()).not.toContain(token.toLowerCase());
      }
      // no numbers anywhere in customer copy
      expect(copy).not.toMatch(/\d/);
    }
  });
});
