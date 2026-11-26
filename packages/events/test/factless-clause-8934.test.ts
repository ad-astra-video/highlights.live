// ADAAAA-8934 (AC14 clause-level + AC1-VOD coverage) — the rev-8 VOD bodies
// replayed at $0.
//
// The rev-8 grade (ADAAAA-8925) measured two halves of ONE defect on job set
// `3c221d18 … 5da11cff`:
//
//   * AC14 — the per-job template sentence was gone (0/4 bodies), but 7 of the
//     18 served sentences carried NO attested fact. They were possession /
//     pressure prose (`Barcelona maintains possession …`, `… continues to press
//     for control.`, `… works the ball forward as the play develops.`) and they
//     passed the gate with `summaryViolations: null`, because the sentence path
//     credited `action` whenever the row attested the team NAME — an attested
//     ENTITY standing in for an attested actor action;
//   * AC1-VOD — the clause repair could only DELETE, so 9 of 13 promoted rows
//     fell from 38-47 words to 22-37 (under the 40-word VOD floor) and served
//     nothing at all: 4 of 8 cards carried a body (50 %).
//
// The tests below pin the fix in both directions: the state class earns nothing,
// the repair SUBSTITUTES a fact from the row's own evidence before the body is
// re-counted against the floor, and the retry hears what was deleted.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_MIN_FACT_KINDS,
  SUMMARY_VOD_BAND,
  attestedFactKinds,
  attestedSummaryFactKinds,
  buildSummaryPrompt,
  summaryRetryMinWords,
  summaryServeWordBar,
  dropFillerSentences,
  gateSummaryDetail,
  sentenceActionAttested,
  sentenceFactKinds,
  summaryFacts,
  summaryFactCandidates,
  summaryFactMenu,
  summarySentencesOf,
  summaryViolations,
  summaryWordCount,
  unattestedSentences,
  type SummaryEvidence,
} from "../src/highlight-summary.js";

/** The rev-8 VOD job's persisted `matchContext`: both teams attested, no
 *  competition and no venue key (the census's own shape). */
const MATCH_CONTEXT = {
  sport: "soccer",
  teams: [
    { name: "Barcelona", side: "away", kitColors: [], confidence: 0.5 },
    { name: "Real Madrid", side: "home", kitColors: [], confidence: 0.5 },
  ],
  ambiguous: false,
  inferredAt: "2026-11-13T11:44:02.512739Z",
  resolverVersion: 1,
  trail: [
    { at: "2026-11-13T11:44:02.512Z", names: [{ side: "away", name: "Barcelona", confidence: 0.5 }] },
    { at: "2026-11-13T11:44:02.512Z", names: [{ side: "home", name: "Real Madrid", confidence: 0.5 }] },
  ],
};

/** The six sentences the rev-8 grade measured as factless, verbatim. */
const FACTLESS = [
  "Barcelona maintains possession while moving the ball toward the goal.",
  "Barcelona maintains possession to advance the play and move the ball toward the goal.",
  "Barcelona continues to press for control.",
  "Barcelona works the ball forward as the play develops.",
  "Barcelona works the ball forward as the score changes.",
  "Barcelona works the ball forward to create a scoring opportunity.",
];

/** Row `8216e21b` of job `3c221d18`: GOAL 2-1 -> 2-2, clip offset 1:24. */
const ROW_8216: SummaryEvidence = {
  rail: "vod",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason: "The scoreboard changes from 2-1 to 2-2 at 22:13, confirmed by the commentary eruption.",
  caption: "Goal at 1:24.",
  postTitle: "GOAL · 1:24",
  windowTs: 84,
  windowDurationS: 15,
  scoreTransition: { from: "2-1", to: "2-2" },
  matchContext: MATCH_CONTEXT,
  transcript: null,
  matchClock: null,
};

/** The rev-8 stored body for that row (40 words, 4 sentences, 2 factless). */
const SERVED_8216 =
  "Barcelona works the ball forward to create a scoring opportunity. " +
  "The scoreboard moves to 2-2 during this sequence. " +
  "This play occurs at 1:24 into the clip. " +
  "Barcelona maintains possession to advance the play and move the ball toward the goal.";

/** A row whose evidence attests a score transition but no competition/venue. */
const ROW_7BBA: SummaryEvidence = {
  ...ROW_8216,
  reason: "The scoreboard changes from 1-1 to 2-1 at 18:06, confirmed by the commentary eruption.",
  caption: "Goal at 0:27.",
  postTitle: "GOAL · 0:27",
  windowTs: 27,
  scoreTransition: { from: "1-1", to: "2-1" },
};

// ---------------------------------------------------------------------------
// 1. AC14 — a possession/pressure clause is NOT a fact.
// ---------------------------------------------------------------------------
describe("ADAAAA-8934 AC14 — the stated clause earns no action fact", () => {
  it("credits no `action` for any of the six rev-8 factless sentences", () => {
    for (const sentence of FACTLESS) {
      // The row attests Barcelona as an ENTITY; the clause asserts an ONGOING
      // STATE that no channel on this row measures.
      expect({ sentence, action: attestedSummaryFactKinds(sentence, ROW_8216).includes("action") }).toEqual({
        sentence,
        action: false,
      });
      expect({ sentence, facts: summaryFacts(sentence).filter((f) => f.kind === "action") }).toEqual({
        sentence,
        facts: [],
      });
    }
  });

  it("reports every one of them as an unattested sentence", () => {
    const body = SERVED_8216;
    const factless = unattestedSentences(body, ROW_8216);
    expect(factless.map((report) => report.sentence)).toEqual([
      "Barcelona works the ball forward to create a scoring opportunity.",
      "Barcelona maintains possession to advance the play and move the ball toward the goal.",
    ]);
  });

  it("keeps a BOUNDED act by a named attested actor as an action fact", () => {
    // The rescue stays narrow where it is defensible: an interception, a
    // recovery or a won-back ball is an EVENT a named actor performs in one
    // moment, not a state the row never measured.
    const sentence = "Real Madrid intercepts the ball near the box at 1:24 into the clip.";
    expect(sentenceActionAttested(sentence, "intercepts", ROW_8216)).toBe(true);
    expect(sentenceFactKinds(sentence, ROW_8216)).toEqual(expect.arrayContaining(["action", "clock"]));
    expect(attestedSummaryFactKinds(sentence, ROW_8216)).toContain("action");
  });

  it("refuses a ball-outcome verb on a row that measured no outcome", () => {
    // Unchanged bar: the state class was the defect, not the ball-outcome gate.
    const evidence: SummaryEvidence = {
      ...ROW_8216,
      attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: true },
    };
    const sentence = "Barcelona shoots at 1:24 into the clip.";
    expect(sentenceActionAttested(sentence, "shoots", evidence)).toBe(false);
    expect(summaryViolations(sentence, evidence)).toContain("unattested-action");
  });

  it("leaves the row's fact menu offering only what the row attests", () => {
    const menu = summaryFactMenu(ROW_8216);
    expect(menu).toContain("the score line");
    expect(menu.join(" ")).not.toMatch(/possession|pressure|control|sustained/i);
  });
});

// ---------------------------------------------------------------------------
// 2. AC1-VOD — the repair SUBSTITUTES a fact before the floor is re-counted.
// ---------------------------------------------------------------------------
describe("ADAAAA-8934 AC1-VOD — the repair restores the floor with attested facts", () => {
  it("deletes both factless clauses and substitutes fact-bearing sentences", () => {
    const drop = dropFillerSentences(SERVED_8216, ROW_8216);
    expect(drop.dropped).toHaveLength(2);
    expect(drop.substituted.length).toBeGreaterThan(0);
    // Every substituted sentence carries at least one attested fact kind.
    for (const sentence of drop.substituted) {
      expect(sentenceFactKinds(sentence, ROW_8216).length).toBeGreaterThan(0);
      expect(unattestedSentences(sentence, ROW_8216)).toEqual([]);
    }
    // … and the repaired body clears the VOD floor the rev-8 repair starved. Since
    // ADAAAA-9464 the repair AIMS at the serve bar (the band target, 45 on VOD);
    // on this stored row the pool is exhausted at 43, which is the row's measured
    // limit and is reported here rather than papered over.
    const words = summaryWordCount(drop.text);
    expect(words).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
    expect(summaryServeWordBar(ROW_8216)).toBe(SUMMARY_VOD_BAND.targetMinWords);
    expect(words).toBe(43);
    expect(summarySentencesOf(drop.text).length).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.minSentences);
  });

  it("refuses the row on DEPTH only after the repair, so the AC5 retry asks for the 45-word target", () => {
    // ADAAAA-8934 pinned this row as SERVED (43 repaired words against the 40-word
    // VOD floor). ADAAAA-9464 moved the refusal to the band target (45 on VOD), so
    // the same repair is now measured honestly: it is fact-per-sentence and it
    // deleted both factless clauses, but the pool stops at 43 — 2 short of the
    // target — and the row takes the single AC5 retry, whose directive asks for
    // exactly `summaryRetryMinWords` (45). No factless sentence reaches a card.
    const decision = gateSummaryDetail(SERVED_8216, ROW_8216);
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("too-few-words");
    expect(decision.violations).not.toContain("too-few-facts");
    expect(decision.droppedClauses).toHaveLength(2);
    expect(decision.substitutedClauses.length).toBeGreaterThan(0);
    expect(decision.repairedWords).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
    expect(decision.repairedWords).toBeLessThan(SUMMARY_VOD_BAND.targetMinWords);
    for (const sentence of FACTLESS) expect(decision.substitutedClauses.join(" ")).not.toContain(sentence);
    // The retry directive the lane hands the second sample.
    const retry = buildSummaryPrompt({
      ...ROW_8216,
      retry: { words: decision.words, sentences: decision.sentences, violations: decision.violations },
    });
    expect(retry).toContain(`must reach at least ${summaryRetryMinWords(SUMMARY_VOD_BAND)} words`);
  });

  it("keeps the body's own bytes when the deletion already clears the band", () => {
    // Extractive purity: the substitution runs only when extraction cost the card
    // its copy, so a compliant body is never padded with repair sentences.
    const body =
      "The scoreboard moves to 2-1 at the 0:27 mark of this clip. Real Madrid intercepts the ball near the box at 0:27 into the clip. " +
      "Barcelona wins back possession near the touchline and threads a pass to the left flank at 0:27 of the clip. " +
      "The scoreboard holds at 2-1 as the clip runs past 0:27 and the sequence closes out wide.";
    const drop = dropFillerSentences(body, ROW_7BBA);
    expect(drop.dropped).toEqual([]);
    expect(drop.substituted).toEqual([]);
    expect(drop.text).toBe(body);
  });

  it("does not rebuild a body whose every sentence was deleted", () => {
    // A draft that grounded NOTHING keeps serving nothing: rebuilding it from the
    // pool would serve synthetic copy the model never wrote (AC14's own rule).
    const allFiller = FACTLESS.join(" ");
    const drop = dropFillerSentences(allFiller, ROW_8216);
    expect(drop.dropped).toHaveLength(FACTLESS.length);
    expect(drop.substituted).toEqual([]);
    expect(drop.text).toBe("");
    expect(gateSummaryDetail(allFiller, ROW_8216).summary).toBeNull();
  });

  it("cannot invent a fact the row does not attest", () => {
    // No score transition and no window anchor: the pool is empty, so the repair
    // leaves the deletion alone and the depth bars refuse the row.
    const barren: SummaryEvidence = {
      rail: "vod",
      verdict: "scoring_play",
      eventType: "GOAL",
      caption: "Goal.",
      postTitle: "GOAL",
      windowTs: null,
      scoreTransition: null,
      matchContext: { sport: "soccer", teams: [], ambiguous: true },
      transcript: null,
      matchClock: null,
    };
    expect(summaryFactCandidates(barren)).toEqual([]);
    expect(attestedFactKinds(barren).length).toBeLessThan(SUMMARY_MIN_FACT_KINDS);
    const decision = gateSummaryDetail(SERVED_8216, barren);
    expect(decision.summary).toBeNull();
    expect(decision.substitutedClauses).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. AC5 — the retry is handed the deletions and the fact menu.
// ---------------------------------------------------------------------------
describe("ADAAAA-8934 AC5/AC14 — the retry hears what was deleted", () => {
  it("names the deleted clauses and offers the menu in the retry directive", () => {
    const decision = gateSummaryDetail(SERVED_8216, ROW_8216);
    const prompt = buildSummaryPrompt({
      ...ROW_8216,
      retry: {
        words: decision.words,
        sentences: decision.sentences,
        violations: ["too-few-words"],
        droppedClauses: decision.droppedClauses,
        factMenu: summaryFactMenu(ROW_8216),
      },
    });
    expect(prompt).toContain("These sentences were DELETED from that draft because they carry no attested fact");
    expect(prompt).toContain("Barcelona works the ball forward to create a scoring opportunity.");
    // The menu the retry may draw on is the row's own menu, not a generic one.
    expect(prompt).toContain("the score line");
    expect(prompt).toContain("a bounded act (an interception, a recovery, a won-back ball, a counter)");
  });

  it("keeps the prompt's second fact type off the state class", () => {
    // The rev-8 prompt ASKED for the filler: when the row attests no ball
    // outcome it told the model to describe possession and pressing. Both
    // branches now name the bounded act instead.
    const scoringRow = buildSummaryPrompt({ ...ROW_8216 });
    expect(scoringRow).not.toContain("Describe the team's sustained play instead");
    expect(scoringRow).toContain("never as the subject of 'is pressing' / 'is holding possession'");
    // … and the non-scoring branch, which is where the rev-8 instruction sat.
    const plainRow = buildSummaryPrompt({
      ...ROW_8216,
      verdict: "big_play",
      eventType: "BIG_PLAY",
      scoreTransition: null,
      caption: "Big play at 1:24.",
      postTitle: "BIG PLAY · 1:24",
      // The instruction lives on the branch where the row MEASURED no ball
      // outcome — the shape the rev-8 VOD rows carried.
      attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
    });
    expect(plainRow).toContain("Do NOT describe possession, pressure, control");
    expect(plainRow).not.toContain("Describe the team's sustained play instead");
  });

  it("still credits a transitive act on the same row", () => {
    // The noun/verb guard is narrow: a real verb keeps earning `action`.
    const sentence = "Real Madrid scores to change the scoreboard to 2-2 at 1:24 into the clip.";
    expect(summaryFacts(sentence).map((fact) => fact.kind)).toContain("action");
    expect(attestedSummaryFactKinds(sentence, ROW_8216)).toContain("action");
  });
});
