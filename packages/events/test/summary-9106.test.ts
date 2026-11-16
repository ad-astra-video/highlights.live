// ADAAAA-9106 — writer round 2: the LIVE caption depth (p50 24 vs >= 25) and the
// score-line relay, both measured on the SERVED block `68aa5f97` (job
// `06aabcd9-0768-4750-8756-34717ba704ed`) by the ADAAAA-9051 grade.
//
// Measured on the three served bodies (words 22 / 24 / 26, p50 **24.0** against
// AC1's 25) and on row `c2c7a982` (`scoreTransition 2-1>2-2`,
// `attestationUsed.scoreBoardChanged true`, `authority scoreboard`, `scoreReads
// 12`, `need 2`) whose served body carried NO score line at all.
//
//  1. The depth ask was the band arithmetic EXACTLY (`ceil(25/2)=13` words per
//     sentence -> 26 words) and it licensed everything above `25-5=20` as
//     not-short, so the writer answered 22 / 24 / 26 — two of them exactly two
//     13-word sentences. The ask now carries a sentence margin
//     (`SUMMARY_WRITER_SENTENCE_MARGIN_WORDS`), and a draft under the band
//     minimum is a FAILED draft instead of a servable short one.
//  2. The score line was one OPTIONAL kind among several, so a row that measured a
//     change wrote the clock and the act instead. On a row that measured the
//     change the relay is now REQUIRED, packed into the sentence that names an
//     attested actor's act (the same two-facts-one-sentence lever).
//
// Nothing here is a bar move: `summaryBand`, `SUMMARY_MIN_FACT_KINDS`, the 18-word
// floor accept, `SUMMARY_MAX_CALLS_PER_ROW` and `SUMMARY_SENTENCE_REPEAT_THRESHOLD`
// stay exactly as served, and the last block pins that — including a body that
// omits the measured score line still SERVING (the relay is a writer requirement,
// not a new refusal).
import { describe, expect, it } from "vitest";
import {
  attestedSummaryFactKinds,
  buildSummaryPrompt,
  gateSummaryDetail,
  SUMMARY_LIVE_BAND,
  SUMMARY_MAX_CALLS_PER_ROW,
  SUMMARY_MIN_FACT_KINDS,
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
  SUMMARY_VOD_BAND,
  SUMMARY_WRITER_SENTENCE_MARGIN_WORDS,
  summaryBand,
  summaryRetryMinWords,
  summaryWordCount,
  type SummaryEvidence,
} from "@highlights/events";

/** Stored row `c2c7a982` of job `06aabcd9` — the AC11 fixture: a confirmed GOAL
 *  whose scoreboard transition was measured twice over, served with no score line. */
const measuredChangeRow = (over: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "live",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason: "Scoreboard changes to 2-2.",
  postTitle: "GOAL",
  caption: "Scoreboard changes to 2-2.",
  windowTs: 160,
  windowDurationS: 15,
  scoreTransition: { from: "2-1", to: "2-2" },
  matchContext: {
    sport: "soccer",
    teams: [
      { name: "Real Madrid", side: "home" },
      { name: "Barcelona", side: "away" },
    ],
  },
  transcript: null,
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: true, goalConfirmed: "null" },
  matchClock: { token: "22:13", seconds: 1333, period: null, legible: true },
  ...over,
});

/** Stored row `614f57c0` of the same job — the AC11 NEGATIVE case: a BIG_PLAY
 *  whose celebration reason mentions a scoreboard change the live lane did NOT
 *  measure (`scoreBoardChanged=false`), so no score line may be relayed. */
const unmeasuredScoreRow = (over: Partial<SummaryEvidence> = {}): SummaryEvidence =>
  measuredChangeRow({
    verdict: "big_play",
    eventType: "BIG_PLAY",
    reason:
      "ASR confirms goal at t=-1.7s | live scoring lane: no scoreboard change was measured (scoreBoardChanged=false goalCrossed=false ballOutcome=none)",
    caption: null,
    postTitle: "BIG PLAY",
    windowTs: 102.66666666666666,
    scoreTransition: null,
    attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false, goalConfirmed: "null" },
    matchClock: { token: "18:12", seconds: 1092, period: null, legible: true },
    ...over,
  });

const promptLine = (prompt: string, needle: string): string =>
  prompt.split("\n").find((line) => line.includes(needle)) ?? "";

describe("ADAAAA-9106 — the first pass asks for the depth, not the exact minimum", () => {
  it("asks a live row for 15 words per sentence (30 words on two sentences)", () => {
    const prompt = buildSummaryPrompt(measuredChangeRow());
    expect(prompt).toContain("Write 2-3 sentences of at least 15 words each: 2 sentences at 15 words is 30 words");
    // The ask is the band arithmetic plus the margin, and it stays inside the band.
    expect(SUMMARY_WRITER_SENTENCE_MARGIN_WORDS).toBe(2);
    expect(2 * (Math.ceil(SUMMARY_LIVE_BAND.targetMinWords / SUMMARY_LIVE_BAND.minSentences) + SUMMARY_WRITER_SENTENCE_MARGIN_WORDS)).toBe(30);
    expect(2 * 15).toBeLessThanOrEqual(SUMMARY_LIVE_BAND.targetMaxWords);
  });

  it("stops licensing a body under the band minimum as servable", () => {
    const prompt = buildSummaryPrompt(measuredChangeRow());
    expect(prompt).toContain("a draft that stops below 25 words is a FAILED draft");
    // The rev-12 license for a 21-24-word body is gone; the SERVE floor is not.
    expect(prompt).not.toContain("a body that stops at 20 words or fewer is short");
    expect(SUMMARY_LIVE_BAND.floorWords).toBe(18);
  });

  it("resolves the VOD ask off the same margin (3 x 17 = 51)", () => {
    const vod = buildSummaryPrompt(measuredChangeRow({ rail: "vod" }));
    expect(vod).toContain("Write 3-5 sentences of at least 17 words each: 3 sentences at 17 words is 51 words");
    // The retry floor is a different number and is unchanged by this ticket.
    expect(summaryRetryMinWords(SUMMARY_VOD_BAND)).toBe(45);
    expect(summaryRetryMinWords(SUMMARY_LIVE_BAND)).toBe(25);
  });

  it("adds no retry line to the first pass (no headroom for a depth retry)", () => {
    const prompt = buildSummaryPrompt(measuredChangeRow());
    expect(prompt).not.toContain("RETRY:");
    expect(SUMMARY_MAX_CALLS_PER_ROW).toBe(2);
  });
});

describe("ADAAAA-9106 — a MEASURED score change is relayed on the first pass", () => {
  it("requires the relay with the row's own measured transition", () => {
    const line = promptLine(buildSummaryPrompt(measuredChangeRow()), "MEASURED a score change on this row");
    expect(line).toContain("2-1 -> 2-2");
    expect(line).toContain("the scoreboard moves from 2-1 to 2-2");
    expect(line).toContain("MUST state it");
    expect(line).toContain("FAILED draft");
    // Sides: the digits and the change are attested, WHICH side scored is not.
    expect(line).toContain("Never say which side scored");
    // No sample sentence with an actor filled in: a second card could copy it.
    expect(line).not.toContain("Real Madrid");
    expect(line).not.toContain("Barcelona");
  });

  it("asks the relay to ride the sentence that names an attested actor's act", () => {
    const prompt = buildSummaryPrompt(measuredChangeRow());
    expect(prompt).toContain("with that actor as the subject and the score line riding on it");
    expect(prompt).toContain("Pack two facts into one sentence where the evidence allows it");
  });

  it("does NOT require a relay on a row whose lane measured no change (the negative case)", () => {
    const prompt = buildSummaryPrompt(unmeasuredScoreRow());
    expect(prompt).not.toContain("MEASURED a score change on this row");
    // The celebration ban stays exactly as served.
    expect(prompt).toContain("This is NOT a scoring play");
    expect(prompt).toContain("do not state a score or whether it changed");
  });

  it("does not ask for the relay on a scoring row with no measured transition", () => {
    const prompt = buildSummaryPrompt(measuredChangeRow({ scoreTransition: null }));
    expect(prompt).not.toContain("MEASURED a score change on this row");
  });
});

describe("ADAAAA-9106 — the relay in copy: row c2c7a982 serves the score line", () => {
  // The writer shape the new prompt asks for: 15+ words per sentence, the score
  // line packed into the sentence that names an attested actor's act.
  // ADAAAA-8941 (rev-17): sentence 1's act is a BOUNDED act, not the carry it was
  // pinned with ("drives forward through the middle"). `sustainedFactUnattested`
  // no longer credits a carry on a row that measured no ball outcome (this fixture
  // row: `ballOutcome: null`, `goalCrossed: false`), so the action kind the relay
  // assertion reads has to come from an act the row can anchor. The relay itself —
  // the score line inside the actor's sentence — is unchanged.
  const withScore =
    "Real Madrid intercepts a loose ball through the middle before the defence can reset as the scoreboard moves from 2-1 to 2-2 at 2:40 into the clip. Barcelona dispossesses the runner on the edge of the area and threads a pass between the lines.";
  const withoutScore =
    "Real Madrid drives forward through the middle before the defence can reset at 2:40 into the clip to advance the play. Barcelona dispossesses the runner on the edge of the area and threads a pass between the lines.";

  it("serves the relayed body with the score credited and both fact kinds", () => {
    const evidence = measuredChangeRow();
    const decision = gateSummaryDetail(withScore, evidence);
    expect(decision.violations).toEqual([]);
    expect(decision.summary).not.toBeNull();
    expect(decision.summary).toContain("2-2");
    expect(attestedSummaryFactKinds(withScore, evidence)).toEqual(expect.arrayContaining(["score", "clock", "action"]));
    expect(summaryWordCount(decision.summary ?? "")).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.targetMinWords);
  });

  it("still SERVES a body that omits the relay (the requirement is the writer's, not a bar)", () => {
    const decision = gateSummaryDetail(withoutScore, measuredChangeRow());
    expect(decision.violations).toEqual([]);
    expect(decision.summary).not.toBeNull();
    expect(attestedSummaryFactKinds(withoutScore, measuredChangeRow())).not.toContain("score");
  });

  it("never credits a score on the row whose lane measured none (614f57c0)", () => {
    const decision = gateSummaryDetail(withScore, unmeasuredScoreRow());
    const kinds = attestedSummaryFactKinds(withScore, unmeasuredScoreRow());
    // The digits earn nothing: the credit is read off `attestedFactKinds`, which
    // needs a MEASURED transition. The guard on this row is the prompt (the relay
    // line and the celebration ban are absent/kept), not a new refusal — see the
    // "no bar moved" block below.
    expect(kinds).not.toContain("score");
    expect(decision.summary === null || !attestedSummaryFactKinds(decision.summary, unmeasuredScoreRow()).includes("score")).toBe(true);
  });
});

describe("ADAAAA-9106 — no bar moved", () => {
  it("keeps the live band, the two-kind minimum, the call ceiling and the repeat threshold", () => {
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
    expect(summaryBand("live")).toBe(SUMMARY_LIVE_BAND);
    expect(SUMMARY_VOD_BAND.targetMinWords).toBe(45);
    expect(SUMMARY_MIN_FACT_KINDS).toBe(2);
    expect(SUMMARY_MAX_CALLS_PER_ROW).toBe(2);
    expect(SUMMARY_SENTENCE_REPEAT_THRESHOLD).toBe(0.8);
  });

  it("keeps the 18-word floor accept on a live row", () => {
    const evidence = unmeasuredScoreRow();
    const short =
      "Real Madrid completes a pass at 1:42 into the clip to move the ball forward. Barcelona recovers the ball to initiate a counter.";
    expect(summaryWordCount(short)).toBeGreaterThanOrEqual(SUMMARY_LIVE_BAND.floorWords);
    expect(summaryWordCount(short)).toBeLessThan(SUMMARY_LIVE_BAND.targetMinWords);
    expect(gateSummaryDetail(short, evidence).summary).not.toBeNull();
  });
});
