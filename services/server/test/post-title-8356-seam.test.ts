// ADAAAA-8356 (ADAAAA-8302 Phase B FAIL) — the write seam's card copy target.
//
// Two seams are proved here:
//
//   CORROBORATION  `writeSeamCorroborated` is what `captionGroundingForWindow`
//                  receives as `corroborated`. §3.4 fails closed on `false`, so
//                  this input decides whether a row may assert its OWN goal
//                  claim. A live GOAL the ADAAAA-7996 measured gate KEPT in the
//                  scoring lane carries a measured attestation but almost never
//                  gets a Stage-2 confirm dive (`shouldRunConfirm` short-ciruits
//                  on the same attestation), so it used to hand the copy gate
//                  `corroborated: false`: on leg 5c09695c a scoreboard-attested
//                  GOAL stored `Ball shoots on the left.` and 0/3 cards carried
//                  model copy.
//
//   AUDIT TOKEN    `storedSurfaceFor` stores `postTitleGate` beside the title so
//                  a grade can attribute a residual to the prompt (`absent`, or
//                  a claim the prompt still emits) versus the gate
//                  (`refused:<bar>`) without buying another live leg. A pass may
//                  not come from loosening that gate: the refused cases below
//                  are exactly the Phase B safety class.
import { describe, expect, it } from "vitest";
import { storedSurfaceFor, writeSeamCorroborated, type DecisionResult } from "../src/analyzer.js";
import type { CaptionGroundingContext } from "@highlights/events";

const PROMPT = 'ocr="scoreboard 1-1" | Ordoñez is on the ball | Real Madrid counter';

function ctx(
  verdict: CaptionGroundingContext["verdict"],
  extra: Partial<CaptionGroundingContext> = {}
): CaptionGroundingContext {
  return { verdict, promptText: PROMPT, place: "in the penalty area", ...extra } as CaptionGroundingContext;
}

function decision(over: Partial<DecisionResult> = {}): DecisionResult {
  return {
    isHighlight: true,
    score: 80,
    eventType: "GOAL",
    outcome: "scoring_play",
    reason: "Ordoñez strikes early.",
    ...over,
  };
}

describe("writeSeamCorroborated — the corroboration the copy gate sees", () => {
  it("counts the lane-1 measured attestation that kept a GOAL in the scoring lane", () => {
    // the leg 5c09695c case: no confirm dive, no confirmed_goal, measured attestation
    expect(writeSeamCorroborated({ confirmCorroborated: false, goalConfirmed: null, laneOneAttested: true })).toBe(
      true
    );
  });

  it("fails closed with no corroboration at all (a demoted GOAL keeps no claim)", () => {
    expect(writeSeamCorroborated({})).toBe(false);
    expect(writeSeamCorroborated({ confirmCorroborated: false, goalConfirmed: null, laneOneAttested: false })).toBe(
      false
    );
  });

  it("the pre-existing sources are unchanged", () => {
    expect(writeSeamCorroborated({ confirmCorroborated: true })).toBe(true);
    expect(writeSeamCorroborated({ goalConfirmed: "confirmed_goal" })).toBe(true);
    expect(writeSeamCorroborated({ goalConfirmed: "not_a_goal" })).toBe(false);
  });
});

describe("storedSurfaceFor — postTitleGate names accept/refuse (PO constraint 1)", () => {
  it("accepts a grounded goal claim on a corroborated scoring verdict, token `accepted`", () => {
    const surface = storedSurfaceFor(
      decision({ postTitle: "Ordoñez scores" }),
      ctx("scoring_play", { corroborated: true })
    );
    expect(surface.postTitle).toBe("Ordoñez scores");
    expect(surface.postTitleGate).toBe("accepted");
  });

  it("still refuses the same claim when corroboration is false, token names the bar", () => {
    const surface = storedSurfaceFor(
      decision({ postTitle: "Ordoñez scores" }),
      ctx("scoring_play", { corroborated: false })
    );
    // ADAAAA-8910: the claim is refused and the row's own label (`GOAL`) is what
    // is stored; the token keeps the bar that refused the candidate.
    expect(surface.postTitle).toBe("GOAL");
    expect(surface.postTitleGate).toBe("label:goal-claim");
  });

  it("refuses a goal claim on a non-scoring verdict (the Phase B safety class)", () => {
    const surface = storedSurfaceFor(
      decision({ eventType: "AUDIO_BURST", outcome: "not_highlight", postTitle: "Ordoñez scores" }),
      ctx("not_highlight")
    );
    // The label follows the served verdict (`HIGHLIGHT`), never the refused claim.
    expect(surface.postTitle).toBe("HIGHLIGHT");
    expect(surface.postTitleGate).toBe("label:goal-claim");
  });

  it("repairs a place chain by deletion and records `trimmed`", () => {
    const surface = storedSurfaceFor(
      decision({ eventType: "BIG_PLAY", outcome: "big_play", postTitle: "Player carries ball in midfield" }),
      ctx("big_play")
    );
    expect(surface.postTitle).toBe("Player carries ball");
    expect(surface.postTitleGate).toBe("trimmed");
  });

  it("records `absent` when the reply carried no title (a PROMPT miss, not a gate refusal)", () => {
    const surface = storedSurfaceFor(decision({ postTitle: undefined }), ctx("big_play"));
    expect(surface.postTitle).toBeUndefined();
    expect(surface.postTitleGate).toBe("absent");
  });

  it("stores no token when the seam has no grounding (the VOD rail stays byte-identical)", () => {
    const surface = storedSurfaceFor(decision({ postTitle: "Ordoñez scores" }), undefined);
    expect(surface.postTitle).toBe("Ordoñez scores");
    expect(surface.postTitleGate).toBeUndefined();
  });
});
