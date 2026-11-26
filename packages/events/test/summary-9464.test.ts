// ADAAAA-9464 (writer round 4) — the evidence-proportional ask and the TARGET serve
// bar.
//
// The premise is ADAAAA-9178's own served replay on the rev-21 tree (job
// `798f21c2`): `n=5, min 18, p10 18, p50 19, max 26, bodies >= 25 = 1/5` against
// AC1's `p50 >= 25`. A body at 19 words passed because the refusal tested
// `floorWords` (18), not the band target, and the ask's sentence budget was never
// tied to the row's fact count.
//
// These tests pin the two halves of the fix at `$0`:
//   AC2 — `summarySentenceAsk` yields `sentences * perSentenceWords >=
//         targetMinWords` for EVERY row with `>= 2` attested fact kinds, and keeps
//         today's ask on a row that cannot fill it;
//   AC1 — a reply under `targetMinWords` is refused `too-few-words` and the retry
//         directive asks `summaryRetryMinWords` (25 live / 45 VOD); a body at or
//         above the target serves byte-identically; the call ceiling is unchanged.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_LIVE_BAND,
  SUMMARY_MAX_CALLS_PER_ROW,
  SUMMARY_MIN_FACT_KINDS,
  SUMMARY_VOD_BAND,
  SUMMARY_WRITER_SENTENCE_MARGIN_WORDS,
  attestedFactKinds,
  buildSummaryPrompt,
  gateSummaryDetail,
  summaryBand,
  summaryRetryMinWords,
  summarySentenceAsk,
  summaryServeWordBar,
  summaryWordCount,
  type SummaryEvidence,
  type SummaryRail,
} from "../src/highlight-summary.js";

/** A live row shaped like the rev-19 block: `clock` + `action` (one actor), no
 *  measured score change. Two fact kinds — the smallest proportional row. */
const liveTwoKind = (over: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "live",
  verdict: "big_play",
  eventType: "BIG_PLAY",
  reason: null,
  caption: null,
  postTitle: "BIG PLAY · 0:12",
  windowTs: 12,
  windowDurationS: 15,
  scoreTransition: null,
  matchContext: { sport: "soccer", teams: [{ name: "Barcelona", side: "away" }] },
  transcript: null,
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
  matchClock: { token: "11:31", seconds: 691, period: null, legible: true },
  ...over,
});

/** A live row with two actors and a measured score: three fact UNITS. */
const liveThreeUnit = (over: Partial<SummaryEvidence> = {}): SummaryEvidence =>
  liveTwoKind({
    verdict: "scoring_play",
    eventType: "GOAL",
    scoreTransition: { from: "2-1", to: "2-2" },
    matchContext: {
      sport: "soccer",
      teams: [
        { name: "Barcelona", side: "away" },
        { name: "Real Madrid", side: "home" },
      ],
    },
    ...over,
  });

/** The same row on the VOD rail (target 45, floor 40). */
const vodRow = (over: Partial<SummaryEvidence> = {}): SummaryEvidence =>
  liveTwoKind({ rail: "vod", windowTs: 87, ...over });

/** A row whose evidence attests ONE fact kind: no actor, no score, no venue. */
const clockOnly = (over: Partial<SummaryEvidence> = {}): SummaryEvidence =>
  liveTwoKind({
    matchContext: null,
    attestation: null,
    matchClock: null,
    verdict: "celebration",
    eventType: "CELEBRATION",
    ...over,
  });

describe("ADAAAA-9464 AC2 — the ask selector is evidence-proportional", () => {
  it("proves the formula: sentences x per-sentence ask reaches the band target", () => {
    // The invariant is arithmetic, so it is proved over every rail and every
    // sentence count the band allows, not only over the fixtures below:
    //   s * (ceil(target / s) + margin) >= target   for every s in [minSentences, maxSentences]
    for (const rail of ["live", "vod"] as SummaryRail[]) {
      const band = summaryBand(rail);
      for (let sentences = band.minSentences; sentences <= band.maxSentences; sentences += 1) {
        const perSentenceFloor = Math.ceil(band.targetMinWords / sentences);
        expect(sentences * perSentenceFloor).toBeGreaterThanOrEqual(band.targetMinWords);
        expect(sentences * (perSentenceFloor + SUMMARY_WRITER_SENTENCE_MARGIN_WORDS)).toBeGreaterThanOrEqual(
          band.targetMinWords
        );
      }
    }
  });

  it("budgets >= targetMinWords on every row with >= 2 attested fact kinds", () => {
    const rows: SummaryEvidence[] = [
      liveTwoKind(), // clock + action (1 actor)
      liveTwoKind({ transcript: "el centro para Ordonez, remate gol", matchClock: null }), // clock + action
      liveThreeUnit(), // 2 actors + score
      liveThreeUnit({ matchContext: { sport: "soccer", competition: "La Liga", teams: [{ name: "Barcelona" }, { name: "Real Madrid" }, { name: "Portugal" }] } }), // 3 actors + score + venue
      vodRow(),
      vodRow({ scoreTransition: { from: "1-1", to: "2-1" } }),
    ];
    for (const row of rows) {
      const ask = summarySentenceAsk(row);
      const band = summaryBand(row.rail);
      expect(ask.proportional).toBe(true);
      expect(attestedFactKinds(row).length).toBeGreaterThanOrEqual(SUMMARY_MIN_FACT_KINDS);
      expect(ask.sentences).toBeGreaterThanOrEqual(band.minSentences);
      expect(ask.sentences).toBeLessThanOrEqual(band.maxSentences);
      // The arithmetic the prompt states to the writer.
      expect(ask.budgetWords).toBe(ask.sentences * ask.perSentenceWords);
      expect(ask.budgetWords).toBeGreaterThanOrEqual(band.targetMinWords);
      // … and it never asks for a per-sentence length that breaks the band ceiling.
      expect(ask.budgetWords).toBeLessThanOrEqual(band.targetMaxWords);
      // The serve bar is the target on this row.
      expect(summaryServeWordBar(row)).toBe(band.targetMinWords);
    }
  });

  it("spends every fact unit the row can supply, up to the band's sentence ceiling", () => {
    // One actor -> 2 sentences (the band floor; a clock sentence cannot stand alone).
    expect(summarySentenceAsk(liveTwoKind())).toMatchObject({
      factKinds: 2,
      factUnits: 1,
      sentences: SUMMARY_LIVE_BAND.minSentences,
      perSentenceWords: 15,
      budgetWords: 30,
    });
    // Two actors + the score line -> three sentences at today's 15 words = 45.
    expect(summarySentenceAsk(liveThreeUnit())).toMatchObject({ factUnits: 3, sentences: 3, budgetWords: 45 });
    // A VOD row lands on the band's own floor: 3 x 17 = 51 >= 45.
    expect(summarySentenceAsk(vodRow())).toMatchObject({ sentences: 3, perSentenceWords: 17, budgetWords: 51 });
  });

  it("keeps today's ask on a row that cannot fill the target (< 2 fact kinds)", () => {
    const row = clockOnly();
    expect(attestedFactKinds(row).length).toBeLessThan(SUMMARY_MIN_FACT_KINDS);
    const ask = summarySentenceAsk(row);
    const band = SUMMARY_LIVE_BAND;
    expect(ask.proportional).toBe(false);
    expect(ask.sentences).toBe(band.minSentences);
    expect(ask.perSentenceWords).toBe(
      Math.ceil(band.targetMinWords / band.minSentences) + SUMMARY_WRITER_SENTENCE_MARGIN_WORDS
    );
    // AC2's exemption: the serve bar stays the 18-word floor on this row.
    expect(summaryServeWordBar(row)).toBe(band.floorWords);
  });

  it("renders the budget it computed in the first-pass prompt", () => {
    // A 3-unit live row: three sentences of 15 words is 45, and the prompt says so.
    const prompt = buildSummaryPrompt(liveThreeUnit());
    expect(prompt).toContain("Write 2-3 sentences of at least 15 words each: 3 sentences at 15 words is 45 words");
    expect(prompt).toContain("Depth comes from a THIRD fact, not from padding. This row can supply 3 distinct facts");
    // A 2-kind row with one actor keeps the 30-word ask (no third fact to spend).
    const two = buildSummaryPrompt(liveTwoKind());
    expect(two).toContain("Write 2-3 sentences of at least 15 words each: 2 sentences at 15 words is 30 words");
    expect(two).not.toContain("Depth comes from a THIRD fact");
  });
});

describe("ADAAAA-9464 AC1 — the gate refuses at the band target", () => {
  it("refuses a 19-word body `too-few-words` and asks the retry for 25 words (live)", () => {
    const row = liveTwoKind();
    const body =
      "Barcelona dispossesses the ball at 11:31 of the match. The clip carries this sequence at 11:31 into the clip.";
    expect(summaryWordCount(body)).toBe(19);
    const decision = gateSummaryDetail(body, row);
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("too-few-words");
    // The refusal measures the body it judged, so the retry is told the truth.
    expect(decision.words).toBe(19);
    // AC1: the retry directive asks `summaryRetryMinWords` (25 live).
    const retry = buildSummaryPrompt({
      ...row,
      retry: { words: decision.words, sentences: decision.sentences, violations: decision.violations },
    });
    expect(retry).toContain(`must reach at least ${summaryRetryMinWords(SUMMARY_LIVE_BAND)} words`);
    expect(summaryRetryMinWords(SUMMARY_LIVE_BAND)).toBe(25);
    expect(retry).toContain("this copy must reach at least 25 words");
  });

  it("refuses a 44-word body `too-few-words` and asks the retry for 45 words (VOD)", () => {
    const row = vodRow({ scoreTransition: { from: "1-1", to: "2-1" } });
    const body =
      "Barcelona dispossesses the ball at 0:27 into the clip and turns the passage into a counter. " +
      "Barcelona recovers the ball near the box and clears it upfield at 0:27 into the clip. " +
      "The scoreboard reads 2-1 as the clip runs past 0:27.";
    const words = summaryWordCount(body);
    expect(words).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
    expect(words).toBeLessThan(SUMMARY_VOD_BAND.targetMinWords);
    const decision = gateSummaryDetail(body, row);
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("too-few-words");
    const retry = buildSummaryPrompt({
      ...row,
      retry: { words: decision.words, sentences: decision.sentences, violations: decision.violations },
    });
    expect(retry).toContain(`must reach at least ${summaryRetryMinWords(SUMMARY_VOD_BAND)} words`);
    expect(summaryRetryMinWords(SUMMARY_VOD_BAND)).toBe(45);
  });

  it("serves a body at or above the target unchanged", () => {
    const row = liveTwoKind();
    const body =
      "Barcelona dispossesses the ball at 11:31 of the match and turns the passage into a counter. " +
      "Barcelona recovers the ball near the box and clears it upfield at 11:31 into the clip.";
    expect(summaryWordCount(body)).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.targetMinWords);
    const decision = gateSummaryDetail(body, row);
    expect(decision.summary).toBe(body);
    expect(decision.violations).toEqual([]);
    expect(decision.words).toBe(summaryWordCount(body));
  });

  it("keeps the floor as the drop bar on a row the target cannot be filled on (AC2 exemption)", () => {
    const row = clockOnly();
    const body = "The clip runs past 0:12 into the second half of the passage of play at the window moment.";
    expect(summaryWordCount(body)).toBe(18);
    expect(summaryWordCount(body)).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.floorWords);
    expect(summaryWordCount(body)).toBeLessThan(SUMMARY_LIVE_BAND.targetMinWords);
    // The depth bar is NOT the refusal here: the row's own fact menu is the bar.
    expect(gateSummaryDetail(body, row).violations).not.toContain("too-few-words");
  });

  it("does not move the band constants or the call ceiling", () => {
    expect(SUMMARY_LIVE_BAND).toEqual({
      rail: "live",
      minSentences: 2,
      maxSentences: 3,
      targetMinWords: 25,
      targetMaxWords: 55,
      floorWords: 18,
      hardMaxWords: 70,
      hardMaxChars: 420,
    });
    expect(SUMMARY_VOD_BAND).toEqual({
      rail: "vod",
      minSentences: 3,
      maxSentences: 5,
      targetMinWords: 45,
      targetMaxWords: 55,
      floorWords: 40,
      hardMaxWords: 120,
      hardMaxChars: 700,
    });
    expect(SUMMARY_MAX_CALLS_PER_ROW).toBe(2);
    expect(SUMMARY_MIN_FACT_KINDS).toBe(2);
  });

  it("accepts an explicit floor bar on the last attempt (the post-retry floor accept)", () => {
    // The lane re-gates the LAST reply at `floorWords`, so a row whose writer
    // answered short twice still serves the copy it produced instead of losing the
    // card. It is the same gate; only the depth bar moves.
    const row = vodRow({ scoreTransition: { from: "1-1", to: "2-1" } });
    const body =
      "Barcelona dispossesses the ball at 0:27 into the clip and turns the passage into a counter. " +
      "Barcelona recovers the ball near the box and clears it upfield at 0:27 into the clip. " +
      "The scoreboard reads 2-1 as the clip runs past 0:27.";
    expect(gateSummaryDetail(body, row).summary).toBeNull();
    const floor = gateSummaryDetail(body, row, { wordBar: SUMMARY_VOD_BAND.floorWords });
    expect(floor.violations).toEqual([]);
    expect(floor.summary).toBe(body);
  });
});
