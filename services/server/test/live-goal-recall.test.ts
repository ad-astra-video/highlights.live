import { describe, it, expect } from "vitest";
import {
  classifyLiveWindowText,
  LiveWindowLedger,
  liveWindowQuote,
  applyLiveGoalRecall,
  isLiveGoalRecallCandidate,
  liveGoalRecallNote,
  LIVE_GOAL_RECALL_LEAD_S,
  LIVE_GOAL_RECALL_LEDGER_MAX,
  LIVE_GOAL_RECALL_QUOTE_MAX,
} from "../src/live-goal-recall";
import { liveWindowDescription, isGateRejectedBareGoal, shouldRunConfirm } from "../src/analyzer";
import type { AnalyzerConfig, DecisionResult } from "../src/analyzer";

// ADAAAA-7988: the LIVE goal-recall floor. The texts below are the ones the
// decide pass actually wrote on the CEO's 2026-11-04 13:14Z share (job
// `6d48c786`), where both goals were rejected because the ball-crossing instant
// fell between the 1 fps media-node samples.

/** A rejected decide note exactly as the live pass stored it on 13:14Z. */
function rejected(reason: string, overrides: Partial<DecisionResult> = {}): DecisionResult {
  return { isHighlight: false, score: 0, outcome: "not_highlight", nearMiss: false, reason, ...overrides } as DecisionResult;
}

function cfg(overrides: Partial<AnalyzerConfig> = {}): AnalyzerConfig {
  return {
    jobId: "job-7988",
    gameHint: "soccer",
    clipBeforeS: 6,
    clipAfterS: 9,
    clipWindowMinSec: 15,
    preferLabels: [],
    confirmEnabled: true,
    ...overrides,
  } as AnalyzerConfig;
}

describe("ADAAAA-7988 classify: the 13:14Z notes", () => {
  it("reads both real celebration notes as celebrations", () => {
    expect(classifyLiveWindowText("The player is standing with arms raised")).toBe("celebration");
    expect(
      classifyLiveWindowText(
        "The player is celebrating a previous event; no ball movement or goal occurs in this window."
      )
    ).toBe("celebration");
    expect(
      classifyLiveWindowText("No ball movement into the net is visible; players are in a static celebration or reaction.")
    ).toBe("celebration");
    expect(classifyLiveWindowText("only fans and players are seen reacting.")).toBe("celebration");
    expect(classifyLiveWindowText("players are reacting to a previous event.")).toBe("celebration");
  });

  it("reads an attack/shot window as an attack", () => {
    expect(classifyLiveWindowText("The striker shoots from the edge of the box; the keeper saves low to his right.")).toBe(
      "attack"
    );
    expect(classifyLiveWindowText("A cross into the box is headed towards goal but cleared.")).toBe("attack");
    expect(classifyLiveWindowText("Through on goal, the forward strikes the ball at the near post.")).toBe("attack");
  });

  it("keeps possession / lull / burst noise neutral (false-positive guard)", () => {
    // 13:14Z-class AUDIO_BURST noise: crowd swell, no shot, no reaction.
    expect(classifyLiveWindowText("Players pass the ball around midfield; the crowd is loud.")).toBe("neutral");
    expect(classifyLiveWindowText("The teams jog in possession; no ball movement towards goal.")).toBe("neutral");
    expect(classifyLiveWindowText("")).toBe("neutral");
    expect(classifyLiveWindowText(undefined)).toBe("neutral");
  });

  it("prefers celebration when a window describes both a shot and a reaction", () => {
    expect(
      classifyLiveWindowText("A shot was saved moments earlier; the players now celebrate with arms raised.")
    ).toBe("celebration");
  });

  it("flattens the note and bounds the quote", () => {
    const q = liveWindowQuote("line one\n  line   two");
    expect(q).toBe("line one line two");
    const long = "x".repeat(LIVE_GOAL_RECALL_QUOTE_MAX * 2);
    expect(liveWindowQuote(long).length).toBeLessThanOrEqual(LIVE_GOAL_RECALL_QUOTE_MAX);
    expect(liveWindowQuote(long).endsWith("…")).toBe(true);
  });
});

describe("ADAAAA-7988 ledger: celebration that follows an attack is a goal candidate", () => {
  it("cites the prior attack window with both quotes", () => {
    const led = new LiveWindowLedger();
    led.record(324, "The striker shoots; the keeper saves at his near post.");
    led.record(330, "The player is standing with arms raised");
    const recall = led.recallFor(330);
    expect(recall).not.toBeNull();
    expect(recall!.attackTs).toBe(324);
    expect(recall!.leadS).toBe(6);
    expect(recall!.attackQuote).toContain("shoots");
    expect(recall!.windowQuote).toContain("arms raised");
  });

  it("does not promote an attack window (only the reaction is promoted)", () => {
    const led = new LiveWindowLedger();
    led.record(324, "The striker shoots; the keeper saves.");
    expect(led.recallFor(324)).toBeNull();
  });

  it("does not promote a celebration with no attack window inside the lead", () => {
    const led = new LiveWindowLedger();
    led.record(100, "The striker shoots; the keeper saves.");
    led.record(100 + LIVE_GOAL_RECALL_LEAD_S + 1, "The player is standing with arms raised");
    expect(led.recallFor(100 + LIVE_GOAL_RECALL_LEAD_S + 1)).toBeNull();
  });

  it("does not promote when the nearest prior window is not an attack", () => {
    const led = new LiveWindowLedger();
    led.record(320, "The striker shoots; the keeper saves.");
    led.record(326, "Players pass the ball around midfield."); // neutral in between
    led.record(330, "The player is standing with arms raised");
    expect(led.recallFor(330)).toBeNull();
  });

  it("does not re-cite the same reaction twice (two celebration windows in a row)", () => {
    const led = new LiveWindowLedger();
    led.record(320, "The striker shoots; the keeper saves.");
    led.record(327, "The player is standing with arms raised");
    led.record(330, "players are reacting to a previous event.");
    expect(led.recallFor(327)).not.toBeNull();
    // The second celebration's nearest prior window is a celebration, so it does
    // not open a second goal candidate from the same attack.
    expect(led.recallFor(330)).toBeNull();
  });

  it("never re-opens a goal that was already delivered between the shot and the reaction", () => {
    const led = new LiveWindowLedger();
    led.record(320, "The striker shoots; the keeper saves.");
    led.record(330, "The player is standing with arms raised");
    expect(led.recallFor(330, { acceptedGoalTs: [322] })).toBeNull();
  });

  it("is content-ordered and bounded", () => {
    const led = new LiveWindowLedger();
    for (let i = 0; i < LIVE_GOAL_RECALL_LEDGER_MAX + 40; i++) led.record(i, "Players pass the ball around midfield.");
    expect(led.snapshot().length).toBe(LIVE_GOAL_RECALL_LEDGER_MAX);
    // Oldest fell off, newest is retained and the order is content-ascending.
    expect(led.snapshot()[0].centerTs).toBe(40);
    expect(led.windowAt(LIVE_GOAL_RECALL_LEDGER_MAX + 39)).toBeDefined();
    const ts = led.snapshot().map((w) => w.centerTs);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("ignores unusable timestamps", () => {
    const led = new LiveWindowLedger();
    expect(led.record(Number.NaN, "The player is standing with arms raised")).toBeNull();
    expect(led.recallFor(Number.NaN)).toBeNull();
  });

  it("re-decided window upgrades the quote, not the count", () => {
    const led = new LiveWindowLedger();
    led.record(330, "The player is celebrating");
    led.record(330, "The player is celebrating; arms raised; teammates hugging him.");
    expect(led.snapshot().length).toBe(1);
    expect(led.snapshot()[0].quote).toContain("teammates hugging");
  });
});

describe("ADAAAA-7988 promotion shape", () => {
  const led = new LiveWindowLedger();
  led.record(672, "The striker shoots from close range; the keeper is beaten at the far post.");
  led.record(678, "No ball movement into the net is visible; players are in a static celebration or reaction.");
  const recall = led.recallFor(678)!;

  it("only promotes a rejected window", () => {
    expect(isLiveGoalRecallCandidate(rejected("anything"))).toBe(true);
    expect(isLiveGoalRecallCandidate({ ...rejected("x"), outcome: undefined })).toBe(true);
    expect(isLiveGoalRecallCandidate({ isHighlight: true, score: 90, outcome: "scoring_play" })).toBe(false);
    expect(isLiveGoalRecallCandidate({ isHighlight: true, score: 55, outcome: "near_miss" })).toBe(false);
    expect(isLiveGoalRecallCandidate(null)).toBe(false);
  });

  it("lands the near_miss floor with the cited evidence in the reason", () => {
    const promoted = applyLiveGoalRecall(rejected("The player is celebrating a previous event."), recall);
    expect(promoted.isHighlight).toBe(false);
    expect(promoted.outcome).toBe("near_miss");
    expect(promoted.nearMiss).toBe(true);
    expect(promoted.score).toBe(55);
    expect(promoted.goalRecall).toEqual(recall);
    expect(promoted.reason).toContain("goal-recall");
    expect(promoted.reason).toContain("@672s");
    expect(promoted.reason).toContain("shoots from close range");
    expect(promoted.reason).toContain("static celebration");
    expect(promoted.reason).toContain("The player is celebrating a previous event.");
  });

  it("keeps a higher existing score instead of lowering it", () => {
    const promoted = applyLiveGoalRecall(rejected("x", { score: 71 }), recall);
    expect(promoted.score).toBe(71);
  });

  it("is the goal-shaped, un-attested non-accept the Stage-2 dive adjudicates", () => {
    const promoted = applyLiveGoalRecall(rejected("The player is celebrating a previous event."), recall);
    // Goal-shaped + not accepted => ADAAAA-7357 delayed-corroboration shape.
    expect(promoted.eventType).toBe("GOAL");
    expect(isGateRejectedBareGoal(promoted)).toBe(true);
    // An un-attested goal-shaped read enters the confirm dive...
    expect(shouldRunConfirm(cfg(), { eventType: "SPORTING_EVENT" }, promoted)).toBe(true);
    // ...but is never a delivered GOAL by itself: near_miss is not postable.
    expect(promoted.isHighlight).toBe(false);
  });

  it("does not fire the dive for an attested candidate (measured evidence exists)", () => {
    const promoted = applyLiveGoalRecall(rejected("The player is celebrating a previous event."), recall);
    expect(shouldRunConfirm(cfg(), { eventType: "GOAL", goalCrossed: true }, promoted)).toBe(false);
  });

  it("the note names both instants and the bounded quotes", () => {
    const note = liveGoalRecallNote(recall);
    expect(note).toContain("@672s");
    expect(note).toContain("6s earlier");
    expect(note).toContain("1 fps");
  });
});

describe("ADAAAA-7988 live window description seam", () => {
  it("classifies on the decide note's reason", () => {
    const d = rejected("The player is standing with arms raised", { runningSummary: "nothing useful" });
    expect(liveWindowDescription(d)).toBe("The player is standing with arms raised");
    expect(classifyLiveWindowText(liveWindowDescription(d))).toBe("celebration");
  });

  it("falls back to the running summary when the note has no reason", () => {
    const d = rejected("", { runningSummary: "Shot saved by the keeper." });
    expect(liveWindowDescription(d)).toBe("Shot saved by the keeper.");
  });

  it("returns empty for a missing verdict", () => {
    expect(liveWindowDescription(null)).toBe("");
    expect(liveWindowDescription(undefined)).toBe("");
  });
});

describe("ADAAAA-7988 false-positive guard: a lull does not produce goal candidates", () => {
  it("10 minutes of possession-only decide notes yield zero promotions", () => {
    const led = new LiveWindowLedger();
    const lullNotes = [
      "Players pass the ball around midfield; the crowd is loud.",
      "The teams jog in possession; no ball movement towards goal.",
      "A throw-in is taken near the halfway line.",
      "The referee awards a free kick in midfield.",
      "Possession changes hands in the defensive third.",
    ];
    for (let ts = 0; ts < 600; ts += 3) led.record(ts, lullNotes[(ts / 3) % lullNotes.length]);
    const promotions = led.snapshot().filter((w) => led.recallFor(w.centerTs) !== null);
    expect(promotions).toEqual([]);
  });

  it("a burst window with no attack evidence behind it yields no promotion", () => {
    const led = new LiveWindowLedger();
    // 13:14Z-class AUDIO_BURST sequence: crowd swell, no shot described.
    led.record(300, "The crowd is loud; players walk back into position.");
    led.record(306, "Players are reacting to a previous event.");
    expect(led.recallFor(306)).toBeNull();
  });
});
