// ADAAAA-8125 — the WRITE-SEAM proof for the ADAAAA-8124 ruling.
//
// `storedSurfaceFor` is the ONE derivation of a highlight's stored, customer
// readable surface. Before this change it stored
// `card.caption || (reasonClean ? shapedReason : "")`, so a REFUSED goal-claim
// card on a non-empty but shape-unclean gated line stored NOTHING: the row kept
// its clip and its counts, and served no copy at all (22 of 61 accepted rows on
// the ADAAAA-8124 post-deploy sweep).
//
// The fixtures below are verbatim `reason_raw` values from that sweep, replayed
// through the seam with the window's own grounding context. The "already had
// copy" expectations are the PRE-FIX seam's own output (measured on
// `origin/master` 30dd79b), hard-coded here so AC3 is a byte-for-byte
// comparison, not a re-derivation.
import { describe, expect, it } from "vitest";
import { storedSurfaceFor, type DecisionResult } from "../src/analyzer.js";
import {
  captionLead,
  findScoreClaims,
  gateGoalClaims,
  gateQuietWindow,
  hasGoalClaim,
  servedShapeViolations,
  stripInternalTokens,
  wholeStoredSentence,
  type CaptionGroundingContext,
} from "@highlights/events";

const TAIL_V8 =
  "| live scoring lane: no measured attestation in this window (scoreBoardChanged=false goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL";

/** The measured post-deploy rows (accepted, `record.reason IS NULL`). */
const DEMOTED_PLAYER_IN_WHITE = `The scoreboard updates from 1-1 to 2-1 as the player in white scores. ${TAIL_V8}`;
const GOAL_CELEBRATE = "The scoreboard updates from 1-1 to 2-1 as players celebrate a goal.; scoreboard score change confirmed";

const PROMPT = 'ocr="scoreboard 1-1" | ocr="scoreboard 2-1" | the player in white shoots in the penalty area';

const verdictCtx = (
  verdict: CaptionGroundingContext["verdict"],
  eventType: string,
  corroborated: boolean
): CaptionGroundingContext => ({
  verdict,
  eventType,
  promptText: PROMPT,
  corroborated,
  place: "in the penalty area",
});

function row(
  reason: string,
  eventType: string,
  outcome: DecisionResult["outcome"],
  score = 61
): DecisionResult {
  return { isHighlight: true, score, eventType, outcome, reason };
}

describe("ADAAAA-8125 AC1 — the 22-row class is unproducible at the seam", () => {
  const demoted = storedSurfaceFor(
    row(DEMOTED_PLAYER_IN_WHITE, "BIG_PLAY", "big_play"),
    verdictCtx("big_play", "BIG_PLAY", false)
  );

  it("stores a gate-clean reason where it used to store nothing", () => {
    expect(demoted.reason).toBe("The player in white shoots in the box.");
    // The pre-fix seam stored only `reason_raw` on this row (no `reason`).
    expect(demoted.reason_raw).toBe(DEMOTED_PLAYER_IN_WHITE);
  });

  it("stores no caption and no card title: copy does not earn a claim card", () => {
    expect(demoted.caption).toBeUndefined();
    expect(demoted.cardTitles).toBeUndefined();
  });

  it("the stored copy passes the same post-condition `reasonClean` applies", () => {
    const source = wholeStoredSentence(stripInternalTokens(DEMOTED_PLAYER_IN_WHITE).trim());
    expect(servedShapeViolations(demoted.reason as string, [source])).toEqual([]);
    expect(hasGoalClaim(demoted.reason as string)).toBe(false);
    expect(findScoreClaims(demoted.reason as string)).toEqual([]);
    expect(stripInternalTokens(demoted.reason as string)).toBe(demoted.reason);
    expect(captionLead(demoted.reason as string).split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(8);
  });

  it("is idempotent under the full gate order (AC2)", () => {
    const ctx = verdictCtx("big_play", "BIG_PLAY", false);
    const stored = demoted.reason as string;
    const claimed = gateGoalClaims(stored, ctx);
    expect(claimed).toBe(stored);
    expect(gateQuietWindow(claimed, ctx)).toBe(stored);
  });

  it("the row is still accepted and counted: nothing filters it out (AC4)", () => {
    // The seam is a pure writer: it returns the surface for a row it accepts, and
    // the only difference from the pre-fix seam is the copy. Counts (§3 whole-goal
    // counts, banner counts, chapter sums) are computed elsewhere and untouched.
    expect(Object.keys(demoted).sort()).toEqual(["reason", "reason_raw"]);
  });
});

describe("ADAAAA-8125 AC3 — rows that already carried copy are byte-identical", () => {
  // Every expectation below is the PRE-FIX seam's output on `origin/master`
  // 30dd79b, captured before this change and pinned verbatim.

  it("an accepted card keeps its caption as the reason (byte-identical)", () => {
    const surface = storedSurfaceFor(
      row(GOAL_CELEBRATE, "GOAL", "scoring_play", 74),
      verdictCtx("scoring_play", "GOAL", true)
    );
    expect(surface).toEqual({
      reason: "The scoreboard updates from 1-1 to 2-1 as players celebrate a goal.",
      caption: "The scoreboard updates from 1-1 to 2-1 as players celebrate a goal.",
      cardTitles: ["The scoreboard updates from 1-1 to 2-1 as players celebrate a goal."],
      reason_raw: GOAL_CELEBRATE,
    });
  });

  it("a clean quiet row keeps its accepted card line (byte-identical)", () => {
    const surface = storedSurfaceFor(
      row("No. 9 reacts to a play in the penalty area", "BIG_PLAY", "big_play", 40),
      verdictCtx("big_play", "BIG_PLAY", false)
    );
    expect(surface).toEqual({
      reason: "No. 9 reacts to a play in the penalty area",
      caption: "No. 9 reacts to a play in the penalty area",
      cardTitles: ["No. 9 reacts to a play in the penalty area"],
    });
  });

  it("a claim suppressed inside its own sentence keeps the §2 lead (byte-identical)", () => {
    const raw = "A player shoots from the penalty area — the ball misses the goal.";
    const surface = storedSurfaceFor(
      row(raw, "BIG_PLAY", "not_highlight", 55),
      verdictCtx("not_highlight", "BIG_PLAY", false)
    );
    expect(surface).toEqual({
      reason: "A player shoots from the penalty area.",
      caption: "A player shoots from the penalty area.",
      cardTitles: ["A player shoots from the penalty area."],
      reason_raw: raw,
    });
  });

  it("VOD (no grounding context) is untouched: the gate line passes through", () => {
    const surface = storedSurfaceFor(row("The No. 9 finishes low into the corner.", "GOAL", "scoring_play", 70), undefined);
    expect(surface).toEqual({ reason: "The No. 9 finishes low into the corner." });
  });
});

describe("ADAAAA-8125 clause 3 — no honest sentence stores nothing, the row survives", () => {
  it("a window with no honest quiet sentence stores no copy (and no placeholder)", () => {
    const raw = `Crowd erupts in celebration as the scoreboard shows a goal for FCB. ${TAIL_V8}`;
    const surface = storedSurfaceFor(row(raw, "BIG_PLAY", "big_play"), verdictCtx("big_play", "BIG_PLAY", false));
    expect(surface.reason).toBeUndefined();
    expect(surface.caption).toBeUndefined();
    expect(surface.cardTitles).toBeUndefined();
    expect(surface.reason_raw).toBe(raw);
    // The surface still exists: the row is accepted, it simply carries no copy.
    expect(Object.keys(surface)).toEqual(["reason_raw"]);
  });

  it("never serves a placeholder or a neighbouring ladder line", () => {
    // A demoted BIG_PLAY whose only beat is `the commentator announces the goal`:
    // the gated line is not shape-clean, and the quiet candidate fails the shape
    // gate (the claim noun leaves `announces a shoots`), so the seam stores no copy.
    const raw = `The scoreboard updates from 1-1 to 2-1 as the commentator announces the goal. ${TAIL_V8}`;
    const surface = storedSurfaceFor(row(raw, "BIG_PLAY", "big_play"), verdictCtx("big_play", "BIG_PLAY", false));
    expect(surface.reason).toBeUndefined();
    expect(surface.caption).toBeUndefined();
    expect(JSON.stringify(surface)).not.toMatch(/shot|Shot|no copy|unavailable/i);
  });
});

describe("ADAAAA-8125 clause 2 — the goal-claim gate is not relaxed", () => {
  it("an uncorroborated goal row still may not assert a goal in its stored copy", () => {
    const surface = storedSurfaceFor(
      row(GOAL_CELEBRATE, "GOAL", "scoring_play", 74),
      verdictCtx("scoring_play", "GOAL", false)
    );
    const copy = surface.reason ?? "";
    expect(hasGoalClaim(copy)).toBe(false);
    expect(copy).not.toMatch(/\b(?:goal|scores?|scored|net)\b/i);
  });
});
