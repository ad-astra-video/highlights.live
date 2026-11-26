import { describe, expect, it } from "vitest";
import {
  buildSummaryPrompt,
  dropRestatedSentences,
  gateSummaryDetail,
  stripPurposeTails,
  summaryFacts,
  summaryRestatedSentences,
  summarySentenceCount,
  summaryWordCount,
  SUMMARY_LIVE_BAND,
  SUMMARY_VOD_BAND,
  type SummaryEvidence,
} from "../src/highlight-summary.js";

/**
 * ADAAAA-9178 (rev-21): depth at the write seam.
 *
 * The ticket's evidence is the rev-19 served block (job `798f21c2`, 5 bodies,
 * 18-26 words, p50 19) whose second sentences are either a purpose/manner tail
 * with no measured outcome or a restatement of a fact sentence 1 already served.
 * These are the seam's own predicates on those bytes, plus the two guards that
 * keep the seam from laundering a claim or from dropping a card it cannot afford
 * to shorten.
 */

/** The five served rev-19 bodies, verbatim (artifact `d287d2c1`, job `798f21c2`). */
const SERVED_REV19 = [
  "Portugal recovers the ball at 18:11 of the match to initiate a transition. Barcelona then crosses the ball to maintain their offensive presence during the play.",
  "Barcelona wins the ball back at 04:38 of the match. Real Madrid then attempts a counter as the match clock reaches 04:38.",
  "Portugal dispossesses the ball at 11:55 into the clip. The clip carries this sequence at 11:55 into the clip.",
  "Real Madrid threads a pass at 06:16 of the match. Barcelona then counters to maintain their offensive position.",
  "Portugal dispossesses the ball at 22:13 of the match. Barcelona then crosses the ball to initiate a transition.",
];

const LIVE_CONTEXT = {
  teams: [{ name: "Portugal" }, { name: "Barcelona" }, { name: "Real Madrid" }],
};

const liveRow = (overrides: Partial<SummaryEvidence> = {}): SummaryEvidence =>
  ({
    rail: "live",
    verdict: "big_play",
    eventType: "BIG_PLAY",
    reason: null,
    caption: null,
    postTitle: "BIG PLAY · 0:12",
    windowTs: 12,
    windowDurationS: 15,
    scoreTransition: null,
    matchContext: LIVE_CONTEXT,
    transcript: null,
    attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
    matchClock: { token: "11:31", seconds: 691, period: null, legible: true },
    ...overrides,
  }) as SummaryEvidence;

describe("ADAAAA-9178 stripPurposeTails — the padding class, deleted extractively", () => {
  it("deletes every purpose/manner tail on the served rev-19 bodies and keeps every fact", () => {
    const seen: string[] = [];
    for (const body of SERVED_REV19) {
      const strip = stripPurposeTails(body);
      for (const tail of strip.stripped) seen.push(tail);
      // Deletion only: no fact may leave the body with the tail.
      const before = summaryFacts(body).map((f) => f.kind).sort();
      const after = summaryFacts(strip.text).map((f) => f.kind).sort();
      expect(after).toEqual(before);
    }
    expect(seen).toEqual([
      "to initiate a transition.",
      "to maintain their offensive presence during the play.",
      "to maintain their offensive position.",
      "to initiate a transition.",
    ]);
  });

  it("returns the bytes untouched for a body with no tail", () => {
    const body = "Real Madrid intercepts the ball near the touchline and counters at 0:31 of the clip.";
    const strip = stripPurposeTails(body);
    expect(strip.stripped).toEqual([]);
    expect(strip.text).toBe(body);
  });

  it("refuses a tail that would take a fact with it, and refuses to empty a sentence", () => {
    // The tail carries the only fact of the sentence (`wins the ball back`).
    const tailOnlyFact = "The move continues to maintain their offensive position and wins the ball back.";
    expect(stripPurposeTails(tailOnlyFact).stripped).toEqual([]);
    // "during the play" as a whole sentence has no head to keep.
    expect(stripPurposeTails("During the play.").stripped).toEqual([]);
  });

  it("does not launder a CLAIM the tail was hiding (the rev-17 carry row)", () => {
    // Row `5f1ca385` shape: a carry on a row that measured no ball outcome, with
    // the purpose tail bolted on. ADAAAA-8941 refuses the carry as an action fact,
    // so stripping the tail first would turn a claimed sentence into a servable
    // clock sentence — the guard keeps the tail and the filler repair judges it.
    const evidence = liveRow({ attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false } });
    const carry = "Barcelona drives forward at 11:31 of the match to maintain their offensive position.";
    const strip = stripPurposeTails(carry, evidence);
    expect(strip.stripped).toEqual([]);
    expect(strip.kept).toEqual([carry]);
    // The same tail on a BOUNDED act is deleted: the act is a fact on this row.
    const bounded = "Barcelona crosses the ball at 11:31 of the match to maintain their offensive position.";
    const boundedStrip = stripPurposeTails(bounded, evidence);
    expect(boundedStrip.stripped).toEqual(["to maintain their offensive position."]);
    expect(boundedStrip.text).toBe("Barcelona crosses the ball at 11:31 of the match.");
  });
});

describe("ADAAAA-9178 summaryRestatedSentences — the 'second sentence adds nothing' class", () => {
  it("flags the frame sentence that re-narrates the clip clock (`03cdc053`)", () => {
    const reports = summaryRestatedSentences(SERVED_REV19[2]);
    expect(reports.map((r) => r.restated)).toEqual([false, true]);
    expect(reports[1].tokens).toEqual(["clock:11:55"]);
  });

  it("does NOT flag a second sentence that names a different actor's act (`8abf948e`)", () => {
    // Its clock repeats, but `Real Madrid … counters` is a fact sentence 1 does not
    // carry, so the sentence is thin (the prompt bans the clock restatement) and not
    // a restatement. The bar must not delete a real second fact.
    const reports = summaryRestatedSentences(SERVED_REV19[1]);
    expect(reports.map((r) => r.restated)).toEqual([false, false]);
    expect(reports[1].tokens).toContain("action:real madrid|counter");
  });

  it("flags a sentence whose only facts the body already carries, on a two-fact body", () => {
    const body =
      "Barcelona works the ball through the middle as the scoreboard moves to 2-1 at 0:27 into the clip. " +
      "Real Madrid intercepts the ball near the touchline and counters at 0:31 of the clip. " +
      "The scoreboard reads 2-1 as the clip runs past 0:27.";
    const reports = summaryRestatedSentences(body);
    expect(reports.map((r) => r.restated)).toEqual([false, false, true]);
    expect(reports[2].tokens.sort()).toEqual(["clock:0:27", "score:2-1"]);
  });
});

describe("ADAAAA-9178 dropRestatedSentences — extractive, affordability-guarded", () => {
  it("deletes the restating sentence when the remainder still clears the band", () => {
    const evidence = liveRow({
      rail: "vod",
      verdict: "scoring_play",
      eventType: "GOAL",
      scoreTransition: { from: "1-1", to: "2-1" },
      windowTs: 27,
    }) as unknown as SummaryEvidence;
    const body =
      "Barcelona works the ball through the middle as the scoreboard moves to 2-1 at 0:27 into the clip. " +
      "Real Madrid intercepts the ball near the touchline and counters at 0:31 of the clip. " +
      "Barcelona recovers the ball and threads a pass to the far side. " +
      "The scoreboard reads 2-1 as the clip runs past 0:27.";
    const drop = dropRestatedSentences(body, evidence);
    expect(drop.affordable).toBe(true);
    expect(drop.dropped).toEqual(["The scoreboard reads 2-1 as the clip runs past 0:27."]);
    expect(summarySentenceCount(drop.text)).toBe(3);
    expect(summaryWordCount(drop.text)).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
  });

  it("refuses the deletion (bytes unchanged) when it would take the card under the floor", () => {
    // A rev-19-shaped live body: deleting the restating sentence leaves one sentence
    // and under the 18-word floor, so serving it would cost the row its copy.
    const evidence = liveRow();
    const body = "Portugal dispossesses the ball at 11:55 into the clip. The clip carries this sequence at 11:55 into the clip.";
    const drop = dropRestatedSentences(body, evidence);
    expect(drop.affordable).toBe(false);
    expect(drop.dropped).toEqual(["The clip carries this sequence at 11:55 into the clip."]);
    expect(drop.text).toBe(body);
  });
});

describe("ADAAAA-9178 gate — what serves after the seam", () => {
  it("serves a padded body with the tail deleted and records it", () => {
    // No attested match clock on this fixture: the body's clocks are clip offsets,
    // so the ADAAAA-8910 frame guard is not what this test is exercising.
    const evidence = liveRow({ windowTs: 3, matchClock: null });
    const body =
      "Portugal recovers the ball and turns the move around near the halfway line at 0:03 into the clip. " +
      "Barcelona then crosses the ball to maintain their offensive presence during the play. " +
      "Real Madrid intercepts the pass and counters at 0:11 into the clip.";
    const decision = gateSummaryDetail(body, evidence);
    expect(decision.violations).toEqual([]);
    expect(decision.summary).toBeTruthy();
    expect(decision.summary).not.toMatch(/maintain their offensive presence/);
    expect(decision.purposeTails).toEqual(["to maintain their offensive presence during the play."]);
    expect(decision.restatedSentences).toEqual([]);
    expect(summaryWordCount(decision.summary as string)).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.floorWords);
  });

  it("refuses a padded body under the target instead of serving the padding (ADAAAA-9464)", () => {
    // 21 words before, 16 after the strip. ADAAAA-9178 served the writer's padded
    // bytes here (the padding was "the only thing holding it over the FLOOR").
    // ADAAAA-9464 moves the bar to the band TARGET, so the choice is no longer
    // "serve it padded or drop it": a body at 21 words is refused `too-few-words`
    // on the same single AC5 retry that asks for 25, and a padded body never
    // reaches a card — "a padded body is a fail, not a pass" (9464 premise guard).
    const evidence = liveRow({ windowTs: 18, matchClock: null });
    const body = "Portugal recovers the ball in the middle at 0:18 into the clip. Barcelona then crosses the ball to initiate a transition.";
    const decision = gateSummaryDetail(body, evidence);
    expect(decision.summary).toBeNull();
    expect(decision.violations).toContain("too-few-words");
    expect(summaryWordCount(body)).toBeLessThan(SUMMARY_LIVE_BAND.targetMinWords);
  });

  it("does not move a floor, a target or the retry margin", () => {
    expect(SUMMARY_LIVE_BAND.floorWords).toBe(18);
    expect(SUMMARY_LIVE_BAND.targetMinWords).toBe(25);
    expect(SUMMARY_LIVE_BAND.maxSentences).toBe(3);
    expect(SUMMARY_VOD_BAND.floorWords).toBe(40);
    expect(SUMMARY_VOD_BAND.targetMinWords).toBe(45);
  });
});

describe("ADAAAA-9178 prompt — the writer is asked for depth on facts", () => {
  it("carries the AC2 rule and the purpose-tail ban on every row", () => {
    const prompt = buildSummaryPrompt(liveRow());
    expect(prompt).toContain("Every sentence after the first must carry a fact the body does NOT already have");
    expect(prompt).toContain("NEVER append a purpose or manner tail to a sentence");
  });

  it("asks for the third sentence only when the row can supply three distinct facts", () => {
    const twoActors = buildSummaryPrompt(liveRow());
    expect(twoActors).toContain("Depth comes from a THIRD fact, not from padding");
    expect(twoActors).toContain("write 3 sentences of at least 15 words each");
    // A row that attests no actor and no score cannot build three facts: the ask
    // would be a menu the row cannot fill (ADAAAA-8971).
    const bare = buildSummaryPrompt(
      liveRow({
        matchContext: null,
        attestation: null,
        matchClock: null,
        verdict: "celebration",
        eventType: "CELEBRATION",
      })
    );
    expect(bare).not.toContain("Depth comes from a THIRD fact");
  });
});
