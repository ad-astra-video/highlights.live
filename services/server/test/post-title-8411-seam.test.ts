// ADAAAA-8411 — the WRITE seam and the title's name bar, at the seam that stores
// a row (services/server/src/analyzer.ts).
//
// Phase D's FAIL (ADAAAA-8406 AC4) and its writer residue are measured on the
// rows job 755fd1f5 wrote; these tests replay the same stored evidence through
// the real `storedSurfaceFor` derivation, so the fix is proven where it ships
// rather than on a copy of it. $0: no decide call, no GPU, no network.
import { describe, expect, it } from "vitest";

import {
  gatePostTitleDetail,
  projectPostTitle,
  storedReasonViolations,
  wholeStoredSentence,
  type CaptionGroundingContext,
} from "@highlights/events";
import { storedSurfaceFor } from "../src/analyzer";

/** decide_audit g54 (job 755fd1f5) — the window's own stored prompt lines. */
const G54_PROMPT = [
  "- scoreboard score change observed during window: yes",
  "- audio commentary transcript (ASR):",
  "-   la mania è mal, la mania è parada vizia e da vizia è che può  diacerla la selina, il gol!",
  '-  -3.3s tracks=3 vel=0.05 objects=player,soccer ball ocr="Art Soccer\\|22:113 EMA 2-2 BARAszend" poss=none',
].join("\n");

/** The row's stored `raw_reply.reason` (the model's only sentence for the window). */
const G54_REASON = "Scoreboard changes to 2-2 at t=-3.3s and ASR confirms 'il gol!'";

const G54_DECISION = {
  reason: G54_REASON,
  postTitle: "David Saez scores",
  outcome: "scoring_play",
  eventType: "GOAL",
} as never;

const G54_CTX: CaptionGroundingContext = {
  verdict: "scoring_play",
  eventType: "GOAL",
  promptText: G54_PROMPT,
  corroborated: true,
};

describe("ADAAAA-8411 write seam (storedSurfaceFor)", () => {
  it("stores a non-empty caption for the clock-bracketed attestation row", () => {
    const surface = storedSurfaceFor(G54_DECISION, G54_CTX);
    expect(surface.caption).toBe("Scoreboard changes to 2-2.");
    // The audit line still rides along (Phase D attributed the defect with it).
    expect(surface.reason_raw).toBe(G54_REASON);
    // `reason` is unchanged by this ticket: the store-time post-condition still
    // refuses the `at t=` audit marker, and the caption carries the copy.
    expect(surface.reason).toBeUndefined();
  });

  it("the stored caption crosses the same post-condition as every stored line", () => {
    const surface = storedSurfaceFor(G54_DECISION, G54_CTX);
    expect(storedReasonViolations(surface.caption as string, [wholeStoredSentence(G54_REASON)])).toEqual([]);
    expect(surface.caption).not.toMatch(/t=|ASR|confirms/);
  });

  it("the stored caption is never the card title", () => {
    const surface = storedSurfaceFor(G54_DECISION, G54_CTX);
    const title = projectPostTitle(
      {
        postTitle: surface.postTitle ?? null,
        caption: surface.caption ?? null,
        reason: surface.reason ?? null,
        reasonRaw: surface.reason_raw ?? null,
        eventType: "GOAL",
        outcome: "scoring_play",
        localizedTs: 158.666,
      },
      {}
    );
    expect(surface.caption).toBeTruthy();
    expect(surface.caption).not.toBe(title);
  });

  it("does not fire on the long-form VOD seam (no grounding -> AC8 parity)", () => {
    const surface = storedSurfaceFor(G54_DECISION, undefined);
    expect(surface.caption).toBeUndefined();
    expect(surface.reason_raw).toBeUndefined();
  });
});

describe("ADAAAA-8411 title name bar: the row's own copy grounds the headline", () => {
  const scoring = { verdict: "scoring_play", eventType: "GOAL", promptText: "- ASR: Manuel Ordoñez saves it, then Real Madrid break." };

  it("refuses a name the row's own copy does not carry", () => {
    const ref = gatePostTitleDetail("Manuel Ordoñez scores", { ...scoring, ownCopy: "The keeper saves the shot." });
    expect(ref.title).toBeNull();
    expect(ref.gate).toBe("refused:ungrounded-name");
  });

  it("accepts the same name when the row's own sentence names the player", () => {
    const ok = gatePostTitleDetail("Manuel Ordoñez scores", { ...scoring, ownCopy: "ASR confirms goal by Manuel Ordoñez." });
    expect(ok.title).toBe("Manuel Ordoñez scores");
  });

  it("keeps prompt-only grounding when no row copy is supplied (other call sites)", () => {
    expect(gatePostTitleDetail("Manuel Ordoñez scores", scoring).title).toBe("Manuel Ordoñez scores");
  });

  it("a row with no copy at all is not evidence against the title", () => {
    expect(gatePostTitleDetail("Manuel Ordoñez scores", { ...scoring, ownCopy: "" }).title).toBe("Manuel Ordoñez scores");
  });
});
