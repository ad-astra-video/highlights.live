// ADAAAA-8831 (AC12): the entity-bearing 29-word body that was still refused.
//
// Found on live leg `27bd816f`: both promoted rows were `dropped:gate` (2 summary
// calls each) although their replies carried the attested score line. Replaying
// them through the served gate showed TWO defects that had nothing to do with the
// advertised depth band (live floor 18 words / target 25):
//
//   1. row `a4827973` — the AC10 neutraliser DELETED the sentence holding the
//      attested score line because the role noun sat in the object position
//      ("… after a defender found the back of the net."), leaving 13 words / 1
//      sentence and a refusal `too-few-words,too-few-sentences,restates-caption,
//      too-few-facts`. The gate then reported `words=29` — the count of the RAW
//      reply it never judged — so the retry prompt was told a shortfall the row
//      did not have and the second sample stayed dry.
//   2. row `8d521507` — `ungrounded-name` on `Real Madrid`, a team the job's own
//      matchContext TRAIL measured (scorebug `RMA2-2 BAR`) but the evidence
//      renderer never printed (it prints `teams` only), plus the nationality
//      adjective `Spanish` read as a proper name.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_LIVE_BAND,
  attestedActorNames,
  attestedFactKinds,
  bodyNamesAttestedActor,
  buildSummaryPrompt,
  gateSummaryDetail,
  neutraliseRoleNouns,
  summaryEvidenceText,
  summarySentenceCount,
  summaryViolations,
  summaryWordCount,
  matchContextTrailNames,
  type SummaryEvidence,
} from "../src/highlight-summary.js";

/** The job's persisted matchContext (`27bd816f`): Barcelona resolved into
 *  `teams`; Real Madrid present in the attribution trail only. */
const JOB_CONTEXT = {
  sport: "soccer",
  teams: [{ name: "Barcelona", side: "away", kitColors: [], confidence: 0.5 }],
  trail: [
    { at: "2026-11-12T20:39:19.899889Z", names: [{ name: "Barcelona", side: "away", confidence: 0.5 }] },
    { at: "2026-11-12T20:40:23.344074Z", names: [{ name: "Real Madrid", side: "home", confidence: 0.5 }] },
  ],
};

/** Row `a4827973`: the reply the served build stored as `summaryRaw`. */
const ROW_A482_EV: SummaryEvidence = {
  rail: "live",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason: "Ball enters net at t=-1.0s, scoreboard changes to 2-2, and crowd erupts.",
  caption: "Ball enters net at t=-1.0s, scoreboard changes to 2-2, and crowd erupts.",
  postTitle: "Defender scores",
  windowTs: 163.12599992752075,
  scoreTransition: { from: "2-1", to: "2-2" },
  matchContext: JOB_CONTEXT,
  transcript: null,
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: true },
};

const DRAFT_A482 =
  "Real Madrid equalized the score to 2-2 after a defender found the back of the net. The crowd erupted in celebration during this scoring play at the 2:43 mark.";

/** Row `8d521507`: the reply the served build stored as `summaryRaw`. */
const ROW_8D52_EV: SummaryEvidence = {
  rail: "live",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason: "The scoreboard changes to 2-1 at t=0.0 and ASR confirms a goal.",
  caption: "The scoreboard changes to 2-1 at t=0.0 and ASR confirms a goal.",
  postTitle: "Midfielder scores",
  windowTs: 102.59500002861023,
  scoreTransition: { from: "1-1", to: "2-1" },
  matchContext: JOB_CONTEXT,
  transcript: null,
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: true },
};

const DRAFT_8D52 =
  "Real Madrid takes a 2-1 lead after the scoreboard changes at the 1:42 mark. Real Madrid keeps possession as the clip runs past 1:42.";

/** The same row, after the ADAAAA-8910 direction claim is repaired: the digits
 *  and the names are attested, WHICH SIDE levelled is not, so the sentence states
 *  the scoreboard's line instead of crediting it. Same facts, same evidence.
 *  ADAAAA-8914 (AC14.1): the second sentence was "The crowd erupted in
 *  celebration …", an atmosphere clause the clause repair deletes; it now carries
 *  the row's clip clock and an attested actor's play. */
const DRAFT_A482_FIXED =
  "Real Madrid moves the ball forward as the scoreboard reads 2-2. Real Madrid keeps possession at the 2:43 mark into the clip.";

describe("ADAAAA-8831 AC12 — an object-position role phrase is rewritten, not deleted", () => {
  it("keeps the sentence that holds the attested score line", () => {
    const n = neutraliseRoleNouns(DRAFT_A482, ROW_A482_EV);
    expect(n.droppedSentences).toBe(0);
    expect(n.text).toContain("2-2");
    expect(n.text).toContain("after a player found the back of the net");
    // Only the role claim changed: no fact, name or score was introduced.
    expect(n.text).not.toMatch(/defender/i);
    expect(summaryWordCount(n.text)).toBe(29);
    expect(summarySentenceCount(n.text)).toBe(2);
  });

  it("serves the row instead of dropping it, on the live band it advertises", () => {
    const decision = gateSummaryDetail(DRAFT_A482_FIXED, ROW_A482_EV);
    expect(SUMMARY_LIVE_BAND.floorWords).toBe(18);
    expect(decision.violations).toEqual([]);
    expect(decision.gate).toBe("accepted");
    expect(decision.summary).toBeTruthy();
    expect(decision.words).toBe(22);
    expect(decision.sentences).toBe(2);
    expect(decision.droppedSentences).toBe(0);
    expect(summaryViolations(decision.summary!, ROW_A482_EV)).toEqual([]);
  });

  it("refuses the stored draft on the same evidence: it credited the levelling side (ADAAAA-8910 defect 4)", () => {
    // `Real Madrid equalized the score to 2-2` names an attested team AND the
    // direction, and the row's scorebug only attests `RMA 1-1 BAR` -> `RMA 2-1 BAR`
    // digits — on the sibling row of the same transition the copy credited the
    // other side. The role-noun neutraliser cannot repair a direction claim, so
    // the row is refused and retried with the direction line.
    const decision = gateSummaryDetail(DRAFT_A482, ROW_A482_EV);
    expect(decision.summary).toBeFalsy();
    expect(decision.violations).toContain("unattested-side");
  });
});

describe("ADAAAA-8831 AC12 — the match context trail grounds the teams it measured", () => {
  it("reads the trail names the resolved `teams` list does not carry", () => {
    expect(matchContextTrailNames(JOB_CONTEXT)).toEqual(["Barcelona", "Real Madrid"]);
    expect(summaryEvidenceText(ROW_8D52_EV)).toContain("Real Madrid");
  });

  it("counts a trail-measured side as an ATTESTED ACTOR, not just a groundable name", () => {
    // The two readers must agree: a name the evidence grounds is a name the body
    // can credit. On this row `teams` carries Barcelona only, so without the
    // trail the served body named a measured team and still read
    // `bodyNamesAttestedActor=false`.
    expect(attestedActorNames(ROW_8D52_EV)).toEqual(["Barcelona", "Real Madrid"]);
    const decision = gateSummaryDetail(DRAFT_8D52, ROW_8D52_EV);
    expect(decision.summary).toBeTruthy();
    expect(bodyNamesAttestedActor(decision.summary!, ROW_8D52_EV)).toBe(true);
  });

  it("does not let a trail entry invent an actor for a body that names nobody", () => {
    // The 8735 bar is unchanged where there is no trail: no teams, no transcript
    // => no attested actor, so no `action` fact is available.
    const bare: SummaryEvidence = { ...ROW_8D52_EV, matchContext: null, transcript: null };
    expect(attestedActorNames(bare)).toEqual([]);
    expect(attestedFactKinds(bare)).not.toContain("action");
  });

  it("serves the entity-bearing 29-word body that carried the attested score", () => {
    const decision = gateSummaryDetail(DRAFT_8D52, ROW_8D52_EV);
    expect(decision.violations).toEqual([]);
    expect(decision.gate).toBe("accepted");
    // ADAAAA-8914: the filler sentence ("This scoring play shifts the momentum …")
    // is replaced by an attested play + the clip clock, so the body is 24 words
    // instead of the old 29 — still well above the live floor.
    expect(decision.words).toBe(24);
    expect(decision.sentences).toBe(2);
  });

  it("does not treat a nationality adjective as an ungrounded name", () => {
    expect(summaryViolations(DRAFT_8D52, ROW_8D52_EV)).not.toContain("ungrounded-name");
  });

  it("still refuses a team the row's evidence does not carry at all", () => {
    const draft = "Bayern Munich takes a 2-1 lead after the scoreboard changes at the 1:42 mark. This scoring play shifts the momentum during the match.";
    expect(summaryViolations(draft, ROW_8D52_EV)).toContain("ungrounded-name");
  });
});

describe("ADAAAA-8831 — a refusal reports the body it JUDGED, not the raw reply", () => {
  it("reports the clamped/judged counts on a refusal, never the raw reply's", () => {
    // A runaway reply is clamped to the band's hard ceiling and BOTH candidates
    // are judged; the refusal must report the text it last judged.
    const filler =
      "The move builds through the middle. ".repeat(20) +
      "It appeared to change the shape of the match during this passage of play. ".repeat(6);
    const decision = gateSummaryDetail(filler, ROW_A482_EV);
    expect(decision.summary).toBeNull();
    expect(decision.violations.length).toBeGreaterThan(0);
    expect(decision.words).toBeLessThan(summaryWordCount(filler));
    // The clamp's ceiling is what was judged; the raw reply is far longer.
    expect(decision.words).toBeLessThanOrEqual(SUMMARY_LIVE_BAND.hardMaxWords);
  });

  it("reports zero dropped sentences when the neutraliser rewrote in place", () => {
    const decision = gateSummaryDetail(DRAFT_A482, ROW_A482_EV);
    expect(decision.droppedSentences).toBe(0);
    expect(neutraliseRoleNouns(DRAFT_8D52, ROW_8D52_EV).droppedSentences).toBe(0);
  });

  it("tells the retry the attested actors when the draft invented one", () => {
    const prompt = buildSummaryPrompt({
      ...ROW_8D52_EV,
      retry: { words: 29, sentences: 2, violations: ["ungrounded-name"] },
    });
    expect(prompt).toContain("named an entity this evidence does not attest");
    expect(prompt).toContain("Name ONLY these attested actors: Barcelona");
  });

  it("leaves the first-pass prompt byte-identical (no retry directive)", () => {
    const prompt = buildSummaryPrompt({ ...ROW_8D52_EV });
    expect(prompt).not.toContain("named an entity this evidence does not attest");
  });
});
