// ADAAAA-8791: the VOD depth floor is the band's TARGET (40), not a 0.72x
// fraction of it. Job `a200d2bd` (95 s clip, 33 decides) served promoted row
// `0526c296` as `accepted` at 36 words — above the old 30-word floor, below the
// 40-word target — which is a depth FAIL on a promoted VOD row even when every
// fact is attested. These tests pin the floor, the refusal the shipped body earns
// under it, and the retry prompt that asks the second sample for the target.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_VOD_BAND,
  buildSummaryPrompt,
  gateSummaryDetail,
  summaryRetryMinWords,
  type SummaryEvidence,
} from "../src/highlight-summary.js";

/** Row `0526c296`'s evidence at generation time: the clip-offset clock, the
 *  measured 2-1 -> 2-2 transition, one resolved team. */
const ROW_0526: SummaryEvidence = {
  rail: "vod",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason:
    "The scoreboard changes from 1-1 to 2-1 at 18:06, and the ASR confirms 'Acaba de marcar el Real Madrid' while the frames show a player in a white kit (Real Madrid) celebrating.; scoreboard score change confirmed",
  caption: null,
  postTitle: null,
  windowTs: 87,
  windowDurationS: 15,
  scoreTransition: { from: "2-1", to: "2-2" },
  matchContext: { teams: [{ name: "Barcelona", side: "away" }] },
  transcript: null,
};

/** Row `48fe4280`'s evidence at generation time: 1-1 -> 2-1 at clip offset 0:27. */
const ROW_48FE: SummaryEvidence = {
  ...ROW_0526,
  windowTs: 27,
  scoreTransition: { from: "1-1", to: "2-1" },
};

/** The body the served build actually stored and served (36 words, 3 sentences). */
const SERVED_36 =
  "Barcelona finds the back of the net to level the score at 2-2. The crowd erupts in celebration as the scoreboard updates during this scoring play. This goal occurs at the 1:27 mark of the clip.";

/** A compliant row body (44 words, 4 sentences) — inside the VOD target band.
 *  ADAAAA-8910: the fixture that used to sit here ("Real Madrid takes the lead in
 *  this intense match … during the competition") is the exact copy the live-copy
 *  seam now refuses: it asserted a direction no row attests and a competition the
 *  match context does not carry. It is kept below as `SERVED_44_DEFECT` so the
 *  refusal is pinned instead of being lost with the fixture swap. */
const SERVED_44 =
  "Barcelona works the ball through the middle after the scoreboard moves to 2-1 at 0:27 into the clip. " +
  "The white kit presses high and forces a turnover near the touchline. " +
  "A quick exchange opens space for a shot that is gathered. " +
  "The move keeps the pressure on as both sides reset.";

/** The body the served build stored on row `48fe4280` — the ADAAAA-8910 defects
 *  3 and 4 in one paragraph (`takes the lead`, `this intense match`,
 *  `the competition`). */
const SERVED_44_DEFECT =
  "Real Madrid takes the lead in this intense match against Barcelona. The scoreboard updates from 1-1 to 2-1 at the 0:27 mark of the clip. A player in a white kit celebrates the successful scoring play. This goal shifts the momentum during the competition.";

describe("ADAAAA-8791 — the VOD depth floor is the target", () => {
  // ADAAAA-8803 supersedes the "floor IS the target" shape pinned here at 8791:
  // a target that sits ON the serve floor makes every compliant draft a boundary
  // case (job `4e5ddf8d` served its only VOD body at 41 against a 40 floor). The
  // floor stays the serve bar at 40; the TARGET band moved to 45-55 above it, and
  // the retry asks for the floor plus a margin.
  it("keeps the 40-word serve floor below a 45-word target band", () => {
    expect(SUMMARY_VOD_BAND.floorWords).toBe(40);
    expect(SUMMARY_VOD_BAND.targetMinWords).toBe(45);
    expect(SUMMARY_VOD_BAND.targetMinWords).toBeGreaterThan(SUMMARY_VOD_BAND.floorWords);
    expect(summaryRetryMinWords(SUMMARY_VOD_BAND)).toBe(45);
  });

  it("refuses the served 36-word body as `too-few-words`", () => {
    const decision = gateSummaryDetail(SERVED_36, ROW_0526);
    expect(decision.summary).toBeFalsy();
    expect(decision.violations).toContain("too-few-words");
    expect(decision.words).toBe(36);
    // The facts are fine: the refusal is depth, not grounding.
    expect(decision.violations).not.toContain("too-few-facts");
    expect(decision.violations).not.toContain("ungrounded-name");
  });

  it("still accepts a body above the 40-word floor on the same evidence", () => {
    const decision = gateSummaryDetail(SERVED_44, ROW_48FE);
    expect(decision.violations).toEqual([]);
    expect(decision.summary).toBe(SERVED_44);
    expect(decision.words).toBe(51);
    expect(decision.words).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
  });

  it("refuses the body the served build stored — it named the side that scored and a competition the row cannot attest (ADAAAA-8910)", () => {
    const decision = gateSummaryDetail(SERVED_44_DEFECT, ROW_48FE);
    expect(decision.summary).toBeFalsy();
    // The depth bars all pass: this is a truth refusal, not a length one.
    expect(decision.violations).not.toContain("too-few-words");
    expect(decision.violations).toContain("unattested-venue");
    expect(decision.violations).toContain("unattested-side");
  });

  it("keeps the prompt's fact menu and clip-offset clock rule unchanged", () => {
    // The depth fix is a band change, not a prompt/grounding change: the fact
    // menu, the clip-offset clock rule and the score grounding are byte-identical
    // to the served build, so nothing is widened by closing the depth FAIL.
    const prompt = buildSummaryPrompt(ROW_0526);
    expect(prompt).toContain("Carry at least TWO different facts from the evidence");
    expect(prompt).toContain("Score transition: 2-1 -> 2-2");
    expect(prompt).toContain("The clock fact is the `Window:` label only");
    expect(prompt).toContain(`aim for ${SUMMARY_VOD_BAND.targetMinWords}-${SUMMARY_VOD_BAND.targetMaxWords} words`);
  });
});
