// ADAAAA-9047 — the LIVE writer round: get served bodies into the 25-55 word band
// without buying depth with a second call.
//
// Measured on the rev-10 natural job `771f42de` (rev-10 grade: two served bodies at
// 23 and 20 words, AC1 p50 21.5 against a 25-word bar) and on this seat's `$0`
// replay of the same 14 stored rows (`tools/replay-9047.ts`):
//
//  1. the first-pass prompt asked for the band as an AIM ("aim for 25-55 words")
//     while the serve floor is 18, so a two-sentence draft stopped at 20-23 words
//     and served; nothing told the writer how many words each sentence needs;
//  2. the fact menu named CATEGORIES ("the score line", "a bounded act …"), never
//     the row's own values or the verbs the gate credits, so the writer filled the
//     act slot with "is involved in this sequence" — the clause the repair deletes;
//  3. on a row whose scorebug reading is DOT-shaped (`matchClock.token` `57.44`),
//     `serveAttestedMatchClock` rewrote the clip offset into that token and the
//     body lost its clock FACT, because `summaryFacts` only extracts `m:ss`. Four
//     stored rows were refused `too-few-facts` on copy that carried clock + action.
//
// The bars themselves are NOT touched here, and the last describe block pins that
// (band values, two-kind minimum, call ceiling, the 18-word floor accept).
import { describe, expect, it } from "vitest";
import {
  attestedSummaryFactKinds,
  buildSummaryPrompt,
  gateSummaryDetail,
  sentenceFactKinds,
  SUMMARY_LIVE_BAND,
  SUMMARY_MAX_CALLS_PER_ROW,
  SUMMARY_MIN_FACT_KINDS,
  SUMMARY_VOD_BAND,
  summaryFactMenu,
  summaryFactMenuDetail,
  summaryRetryMinWords,
  summaryWordCount,
  SUMMARY_WRITER_ACT_VOCABULARY,
  type SummaryEvidence,
} from "@highlights/events";

/** Stored row `2ff40a71` of live job `771f42de`: a promoted `big_play` whose own
 *  facts are the clip offset plus two named teams. Its scorebug reading is the
 *  dot-shaped `147.44` — the reading the serve path writes into the body. */
const liveRow = (over: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "live",
  verdict: "big_play",
  eventType: "BIG_PLAY",
  reason: "Ball enters net at t=-0.4s; crowd and players celebrate. | live scoring lane: no scoreboard change was measured",
  postTitle: "BIG PLAY · 17:40",
  caption: null,
  windowTs: 1060.3990001678467,
  windowDurationS: 15,
  scoreTransition: null,
  matchContext: { sport: "soccer", teams: [{ name: "Liverpool", side: "home" }, { name: "Chelsea", side: "away" }] },
  transcript: null,
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false, goalConfirmed: "null" },
  matchClock: { token: "147.44", seconds: null, period: null, legible: true },
  ...over,
});

/** A promoted `scoring_play`: clock + score + action, the three-kind shape whose
 *  served body measured 20 words on the rev-10 grade. */
const scoringRow = (over: Partial<SummaryEvidence> = {}): SummaryEvidence =>
  liveRow({
    verdict: "scoring_play",
    eventType: "GOAL",
    postTitle: "GOAL · 4:16",
    windowTs: 256.2220001220703,
    scoreTransition: { from: "0-0", to: "0-1" },
    matchClock: { token: "39.24", seconds: null, period: null, legible: true },
    ...over,
  });

const serves = (text: string, evidence: SummaryEvidence) => gateSummaryDetail(text, evidence).summary !== null;

describe("ADAAAA-9047 — the first pass is told the depth arithmetic", () => {
  it("renders the live band as a per-sentence length, not only a body range", () => {
    const prompt = buildSummaryPrompt(liveRow());
    expect(prompt).toContain("aim for 25-55 words and never fewer than 25");
    // ADAAAA-9106: the ask is the band arithmetic PLUS the sentence margin (15 w x
    // 2 = 30), because a draft written to the exact 13-word minimum serves under
    // the bar once the fact clauses are trimmed.
    expect(prompt).toContain("Write 2-3 sentences of at least 15 words each: 2 sentences at 15 words is 30 words");
    expect(prompt).toContain("a draft that stops below 25 words is a FAILED draft");
  });

  it("resolves the same arithmetic on the VOD band (3 sentences x 17 = 51)", () => {
    const prompt = buildSummaryPrompt(liveRow({ rail: "vod" }));
    expect(prompt).toContain("aim for 45-55 words and never fewer than 45");
    expect(prompt).toContain("Write 3-5 sentences of at least 17 words each: 3 sentences at 17 words is 51 words");
  });

  it("asks the writer to pack two facts into one sentence instead of adding filler", () => {
    expect(buildSummaryPrompt(liveRow())).toContain("Pack two facts into one sentence where the evidence allows it");
  });

  it("tells a three-kind row to use all three kinds", () => {
    expect(buildSummaryPrompt(scoringRow())).toContain("This row attests 3 fact kinds: use every one of them, in 3 sentences");
  });

  it("adds no retry instruction to a first pass (depth is not bought with a call)", () => {
    const prompt = buildSummaryPrompt(liveRow());
    expect(prompt).not.toContain("RETRY:");
    // The retry directive still exists for the filler-repair path and still asks
    // the band target, unchanged by this ticket.
    expect(summaryRetryMinWords(SUMMARY_LIVE_BAND)).toBe(25);
  });
});

describe("ADAAAA-9047 — the fact menu carries the row's own values", () => {
  it("renders the clock value, the named actors and the act vocabulary the gate credits", () => {
    const detail = summaryFactMenuDetail(liveRow());
    expect(detail.join("\n")).toContain("the clock — the clip offset 17:40");
    expect(detail.join("\n")).toContain("named actors you may use: Liverpool, Chelsea");
    // ADAAAA-9121: the menu is narrowed to what the ROW's gate credits. This row
    // measured no ball outcome, so ADAAAA-8941's bar refuses the ball-progress
    // family; offering it would instruct the writer to write a sentence the gate
    // deletes (the ADAAAA-8971 defect). Every OTHER verb still renders.
    for (const verb of SUMMARY_WRITER_ACT_VOCABULARY) {
      if (verb === "drives forward" || verb === "completes a pass") {
        expect(detail.join("\n")).not.toContain(verb);
      } else {
        expect(detail.join("\n")).toContain(verb);
      }
    }
  });

  it("offers the ball-progress verbs again on a row that measured a ball outcome", () => {
    const detail = summaryFactMenuDetail(
      liveRow({ attestation: { ballOutcome: "goal", goalCrossed: true, scoreBoardChanged: false } })
    );
    expect(detail.join("\n")).toContain("drives forward");
    expect(detail.join("\n")).toContain("completes a pass");
  });

  it("renders the score line only when the row attests a measured transition", () => {
    expect(summaryFactMenuDetail(scoringRow()).join("\n")).toContain("the scoreboard moves from 0-0 to 0-1");
    expect(summaryFactMenuDetail(liveRow()).join("\n")).not.toContain("the score line");
  });

  it("offers nothing on a row whose evidence attests no fact kind (no invented menu)", () => {
    const bare = liveRow({ windowTs: null, matchClock: null, matchContext: null });
    expect(summaryFactMenu(bare)).toEqual([]);
    expect(summaryFactMenuDetail(bare)).toEqual([]);
  });

  it("renders VALUES, never example sentences a second card could copy", () => {
    for (const line of summaryFactMenuDetail(scoringRow())) expect(line.trim().endsWith(".")).toBe(false);
  });
});

describe("ADAAAA-9047 — a dot-shaped scorebug reading is a clock fact", () => {
  const body =
    "At 17:40 into the clip Liverpool tackles the runner near the halfway line. Chelsea recovers the second ball and counters back toward its own half.";

  it("serves the body the serve path rewrote to the row's own token", () => {
    const evidence = liveRow();
    const decision = gateSummaryDetail(body, evidence);
    expect(decision.summary).not.toBeNull();
    expect(decision.violations).toEqual([]);
    expect(summaryWordCount(body)).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.targetMinWords);
  });

  it("credits the served token as a clock kind at both the body and the sentence level", () => {
    expect(attestedSummaryFactKinds(body, liveRow())).toContain("clock");
    expect(sentenceFactKinds(body.split(". ")[0], liveRow())).toContain("clock");
  });

  it("credits only the row's OWN reading, never another row's stamp", () => {
    const other = liveRow({ matchClock: { token: "57.44", seconds: null, period: null, legible: true } });
    const bodyWithForeignStamp =
      "At 147.44 of the match Liverpool tackles the runner near the halfway line. Chelsea recovers the second ball and counters back toward its own half.";
    expect(attestedSummaryFactKinds(bodyWithForeignStamp, other)).toEqual(["action"]);
    expect(gateSummaryDetail(bodyWithForeignStamp, other).violations).toContain("too-few-facts");
  });
});

describe("ADAAAA-9047 — no bar moved", () => {
  it("keeps the live band at 2-3 sentences / 25-55 words / 18-word floor", () => {
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
    expect(SUMMARY_VOD_BAND.floorWords).toBe(40);
  });

  it("keeps the two-kind minimum and the two-call ceiling", () => {
    expect(SUMMARY_MIN_FACT_KINDS).toBe(2);
    expect(SUMMARY_MAX_CALLS_PER_ROW).toBe(2);
  });

  it("still SERVES a body between the 18-word floor and the 25-word target", () => {
    // 24 words: under AC1's target, over the serve floor. The PO ruling keeps the
    // floor accept, so the writer round must not turn it into a refusal.
    const short = "At 17:40 into the clip Liverpool tackles the runner near the halfway line. Chelsea recovers the second ball and counters back toward its own half.";
    const trimmed = short.replace(" near the halfway line", "");
    expect(summaryWordCount(trimmed)).toBeLessThan(SUMMARY_LIVE_BAND.targetMinWords);
    expect(summaryWordCount(trimmed)).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.floorWords);
    expect(serves(trimmed, liveRow())).toBe(true);
  });
});
