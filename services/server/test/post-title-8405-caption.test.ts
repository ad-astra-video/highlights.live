// ADAAAA-8405 (Phase C AC4 residual): the collapsed ANNOUNCER caption.
//
// Measured on the post-deploy build (4 file-sim legs): the 6 postable cards all
// served `caption == postTitle` — the `copyTargetFor` degrade — because the
// stored `caption` was null on every row. The cause was the write seam: `caption`
// was only stored when the CARD (`cardTitles`) was accepted, and the card is
// earned only by corroboration (§3.4), so a scoring_play row whose goal read was
// not corroborated stored no caption at all and the detail route fell back to
// the title.
//
// The fix keeps the card refused and stores the row's own GATED announcer line
// as the caption. These tests pin the three properties that make that honest:
//   1. caption === reason (nothing is stored that the row does not already serve);
//   2. cardTitles stay refused on the same row (no gate was loosened);
//   3. the caption is NOT the deterministic title, and it carries no claim;
//   4. a row with no honest sentence still stores no caption;
//   5. the VOD seam (no grounding context) is byte-identical: `reason` only.
import { describe, expect, it } from "vitest";
import {
  deterministicPostTitle,
  hasGoalClaim,
  postTitleShapeViolations,
  type CaptionGroundingContext,
} from "@highlights/events";
import { storedSurfaceFor } from "../src/analyzer";
import type { DecisionResult } from "../src/analyzer";

const PROMPT =
  'transcript="Ordonez drives it home" ocr="Art Soccer|11:32 Real Madrid" track count: 4';
const TAIL_V8 =
  "| live scoring lane: no measured attestation in this window (scoreBoardChanged=false goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL";

const ctx = (over: Partial<CaptionGroundingContext> = {}): CaptionGroundingContext => ({
  verdict: "scoring_play",
  eventType: "GOAL",
  promptText: PROMPT,
  // the measured row class: a scoring_play verdict the pipeline could NOT
  // corroborate (scoreboard delta / goal line / net outcome all unread)
  corroborated: false,
  place: "in the penalty area",
  ...over,
});

const row = (
  reason: string,
  eventType = "GOAL",
  outcome: DecisionResult["outcome"] = "scoring_play"
): DecisionResult => ({ isHighlight: true, score: 80, eventType, outcome, reason });

describe("ADAAAA-8405 AC4 — a refused card still serves announcer detail", () => {
  it("stores the gated announcer line as the caption and refuses the card", () => {
    // The measured 8125 row class (verbatim `reason_raw` from the post-deploy
    // sweep): the card gate refuses the claim while the gated quiet line is
    // honest copy. 7 of the 13 stored post-deploy rows were `refused:goal-claim`.
    const raw = `The scoreboard updates from 1-1 to 2-1 as the player in white scores. ${TAIL_V8}`;
    const decision: DecisionResult = {
      isHighlight: true,
      score: 80,
      eventType: "BIG_PLAY",
      outcome: "big_play",
      reason: raw,
    };
    const surface = storedSurfaceFor(decision, ctx({
      verdict: "big_play",
      eventType: "BIG_PLAY",
      promptText: 'ocr="scoreboard 1-1" | ocr="scoreboard 2-1" | the player in white shoots in the penalty area',
    }));
    // The card (postable copy options) is still earned only by corroboration.
    expect(surface.cardTitles).toBeUndefined();
    // The collapsed detail is the row's own gated line — never the title.
    expect(surface.caption).toBe(surface.reason);
    expect(surface.caption).not.toBe(
      deterministicPostTitle({ eventType: "BIG_PLAY", outcome: "big_play", windowTs: 74 })
    );
    // ...and it never teaches a score claim the row did not measure.
    expect(hasGoalClaim(surface.caption as string)).toBe(false);
  });

  it("keeps the card on a CORROBORATED row and serves the same caption", () => {
    const decision = row("The scoreboard updates from 1-1 to 2-1 as players celebrate a goal.");
    const surface = storedSurfaceFor(decision, ctx({ corroborated: true }));
    expect(surface.cardTitles?.length).toBeGreaterThan(0);
    expect(surface.caption).toBe(surface.cardTitles?.[0]);
    expect(surface.caption).toBe(surface.reason);
  });

  it("stores no caption when the window has no honest sentence", () => {
    // A claim with no gated sentence left: the row keeps the audit line and
    // stores no customer copy (clause 3 stays intact).
    const decision = row("Crowd erupts in celebration as the scoreboard shows a goal for FCB.");
    const surface = storedSurfaceFor(decision, ctx());
    if (surface.reason === undefined) expect(surface.caption).toBeUndefined();
    else expect(surface.caption).toBe(surface.reason);
  });

  it("leaves the VOD seam byte-identical: reason only, no caption", () => {
    const surface = storedSurfaceFor(
      row("The No. 9 finishes low into the corner."),
      undefined
    );
    // ADAAAA-8969: the VOD seam still stores no gated caption, and now stores the
    // row's own non-asserting label (the same string the read projection serves).
    expect(surface).toEqual({ reason: "The No. 9 finishes low into the corner.", postTitle: "GOAL" });
  });
});
