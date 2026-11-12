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

/** The repaired row's body (44 words, 4 sentences) — inside the VOD target band. */
const SERVED_44 =
  "Real Madrid takes the lead in this intense match against Barcelona. The scoreboard updates from 1-1 to 2-1 at the 0:27 mark of the clip. A player in a white kit celebrates the successful scoring play. This goal shifts the momentum during the competition.";

describe("ADAAAA-8791 — the VOD depth floor is the target", () => {
  it("puts floorWords at targetMinWords so sub-target copy cannot serve", () => {
    expect(SUMMARY_VOD_BAND.targetMinWords).toBe(40);
    expect(SUMMARY_VOD_BAND.floorWords).toBe(SUMMARY_VOD_BAND.targetMinWords);
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

  it("still accepts a target-length body on the same evidence", () => {
    const decision = gateSummaryDetail(SERVED_44, ROW_48FE);
    expect(decision.violations).toEqual([]);
    expect(decision.summary).toBe(SERVED_44);
    expect(decision.words).toBe(44);
    expect(decision.words).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
  });

  it("names the refused draft's length in the repair prompt", () => {
    const plain = buildSummaryPrompt(ROW_0526);
    const repair = buildSummaryPrompt({ ...ROW_0526, repairWords: 36 });
    expect(plain).not.toContain("previous draft");
    expect(repair).toContain("previous draft was 36 words");
    expect(repair).toContain(`at least ${SUMMARY_VOD_BAND.targetMinWords} words this time`);
    // Nothing else about the prompt moves: the fact menu and the clip-offset
    // clock rule are unchanged, so score/clock grounding is not widened.
    expect(repair).toContain("Score transition: 2-1 -> 2-2");
    expect(repair).toContain("The clock fact is the `Window:` label only");
  });
});
