// ADAAAA-8803: VOD summary depth is a BAND above the serve floor, and the retry is
// told the measured shortfall.
//
// The stored rows of the funded VOD leg of job `4e5ddf8d-d7ab-4a2a-8489-9c2ba14ae734`
// (served build `cdf6445`) are the fixtures: row `42c28962` was served `accepted`
// at 41 words — one over the 40-word floor — and row `2f5a5796` retried 28 -> 34
// words and dropped, because the retry re-read the same "at least 40 words" line.
// These tests pin the new instruction set and prove the GATE did not move.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_LIVE_BAND,
  SUMMARY_RETRY_DEPTH_MARGIN_WORDS,
  SUMMARY_VOD_BAND,
  buildSummaryPrompt,
  gateSummaryDetail,
  summaryRetryMinWords,
  type SummaryEvidence,
} from "../src/highlight-summary.js";

/** The job's persisted `matchContext`: one resolved team, Barcelona (away). */
const JOB_CONTEXT = {
  sport: "soccer",
  teams: [{ name: "Barcelona", side: "away", kitColors: [], confidence: 0.85 }],
  ambiguous: false,
};

/** Row `2f5a5796`'s evidence, rebuilt from its own stored record fields
 *  (`trigger.timestamp` 87, `attestationUsed.transitionScore` 2-1 -> 2-2,
 *  `outcome` scoring_play, stored `reason`) plus the job's match context. */
const ROW_2F5A: SummaryEvidence = {
  rail: "vod",
  verdict: "scoring_play",
  eventType: "GOAL",
  reason:
    "The scoreboard updates from 2-1 to 2-2 at 22:13, and the ASR confirms the goal with 'Salina, y el gol!' at the peak of the audio energy curve.; scoreboard score change confirmed",
  caption: null,
  postTitle: null,
  windowTs: 87,
  windowDurationS: 15,
  scoreTransition: { from: "2-1", to: "2-2" },
  matchContext: JOB_CONTEXT,
  transcript: null,
};

/** The DRAFT the served build stored as `summaryRaw` on row `2f5a5796` (34 words,
 *  3 sentences). Attempt 1 (28 words) is not persisted — `summaryRaw` keeps the
 *  last refusal only — so the re-score subject is the stored draft. */
const DRAFT_34 =
  "Barcelona finds the equalizer to level the score at 2-2. This pivotal moment occurs at the 1:27 mark of the clip. The team successfully converts the opportunity to secure a draw in the match.";

/** The body the served build stored on row `42c28962` (41 words, 3 sentences).
 *  ADAAAA-8910: the first clause was `Real Madrid secures a lead as the
 *  scoreboard updates from 1-1 to 2-1` — a direction claim the row's digits
 *  cannot certify. It is repaired here (same word count) so this fixture still
 *  proves the DEPTH gate did not move; the refusal of the original clause is
 *  pinned separately. */
const SERVED_41 =
  "Real Madrid moves the ball as the scoreboard updates from 1-1 to 2-1. This scoring play occurs at the 0:27 mark of the clip during the match against Barcelona. The team successfully changes the momentum of the game with this goal.";

/** The stored first clause of row `42c28962` (ADAAAA-8910 defect 4). */
const SERVED_41_DEFECT =
  "Real Madrid secures a lead as the scoreboard updates from 1-1 to 2-1. This scoring play occurs at the 0:27 mark of the clip during the match against Barcelona. The team successfully changes the momentum of the game with this goal.";

describe("ADAAAA-8803 — the VOD target band sits above the floor", () => {
  it("asks for 45-55 words while the serve floor stays at 40", () => {
    expect(SUMMARY_VOD_BAND.floorWords).toBe(40);
    expect(SUMMARY_VOD_BAND.targetMinWords).toBe(45);
    expect(SUMMARY_VOD_BAND.targetMaxWords).toBe(55);
    expect(SUMMARY_VOD_BAND.minSentences).toBe(3);
    expect(SUMMARY_VOD_BAND.maxSentences).toBe(5);
    // The margin that makes a compliant draft a non-boundary case.
    expect(SUMMARY_VOD_BAND.targetMinWords - SUMMARY_VOD_BAND.floorWords).toBeGreaterThanOrEqual(
      SUMMARY_RETRY_DEPTH_MARGIN_WORDS
    );
  });

  it("resolves the retry depth to floor + margin on both rails", () => {
    expect(summaryRetryMinWords(SUMMARY_VOD_BAND)).toBe(45);
    expect(summaryRetryMinWords(SUMMARY_VOD_BAND)).toBe(SUMMARY_VOD_BAND.floorWords + SUMMARY_RETRY_DEPTH_MARGIN_WORDS);
    // Live is unchanged by this ticket: its target (25) already clears 18 + 5.
    expect(summaryRetryMinWords(SUMMARY_LIVE_BAND)).toBe(25);
  });

  it("removes the 'at least 40 words' floor-as-target instruction", () => {
    const prompt = buildSummaryPrompt(ROW_2F5A);
    expect(prompt).toContain("Rail: vod. Write 3-5 sentences, 45-55 words.");
    expect(prompt).toContain("aim for 45-55 words");
    expect(prompt).not.toContain("at least 40 words");
    // The first pass never carries a RETRY block.
    expect(prompt).not.toContain("RETRY:");
  });
});

describe("ADAAAA-8803 — the retry is told the measured shortfall", () => {
  const decision = gateSummaryDetail(DRAFT_34, ROW_2F5A);
  const retryPrompt = buildSummaryPrompt({
    ...ROW_2F5A,
    retry: { words: decision.words, sentences: decision.sentences, violations: decision.violations },
  });

  it("states the gate's own measurement and refusal", () => {
    expect(decision.words).toBe(34);
    expect(decision.sentences).toBe(3);
    // ADAAAA-8910 adds the direction claim ("Barcelona finds the equalizer to
    // level the score"): the row attests the digits 2-1 -> 2-2 and the names,
    // never which side levelled it.
    expect(decision.violations).toEqual(["too-few-words", "unattested-side"]);
    expect(retryPrompt).toContain("RETRY: the previous draft measured 34 words across 3 sentences");
    expect(retryPrompt).toContain("refused for: too-few-words");
  });

  it("asks for the floor PLUS a margin, not the floor again", () => {
    expect(retryPrompt).toContain("this copy must reach at least 45 words inside 3-5 sentences");
    expect(retryPrompt).toContain("45 is 5 words above the 40-word floor");
    // The old retry re-read exactly this line, which is why the row re-landed at 34.
    expect(retryPrompt).not.toContain("at least 40 words");
  });

  it("requires match facts and forbids another clock-only sentence and filler", () => {
    expect(retryPrompt).toContain("Expand with facts, not filler");
    expect(retryPrompt).toContain("the score line");
    expect(retryPrompt).toContain("Do NOT spend a whole sentence on the clip clock");
    expect(retryPrompt).toContain("(1:27)");
    expect(retryPrompt).toContain("Do not pad with generic talk about momentum");
  });

  it("keeps the fact menu verdict-aware on a celebration row", () => {
    // Same trap as ADAAAA-8687: a non-scoring row must never be steered to the
    // score line by the expansion instruction.
    const celebration = buildSummaryPrompt({
      ...ROW_2F5A,
      verdict: "big_play",
      scoreTransition: null,
      retry: { words: 22, sentences: 2, violations: ["too-few-words"] },
    });
    expect(celebration).toContain("Expand with facts, not filler");
    expect(celebration).not.toContain("Expand with facts, not filler: add the score line");
  });

  it("changes the prompt for the retry and is deterministic", () => {
    const first = buildSummaryPrompt(ROW_2F5A);
    expect(retryPrompt).not.toBe(first);
    // The retry slot is a pure function of the gate's own measurement, so a
    // re-scored row rebuilds the identical prompt (ADAAAA-8910 widened the
    // violation list; the shape did not change).
    expect(buildSummaryPrompt({ ...ROW_2F5A, retry: decision })).toBe(retryPrompt);
  });
});

describe("ADAAAA-8803 — the gate did not move (re-score of the stored rows)", () => {
  it("still refuses the stored 34-word draft, now also for its direction claim", () => {
    const decision = gateSummaryDetail(DRAFT_34, ROW_2F5A);
    expect(decision.summary).toBeFalsy();
    expect(decision.violations).toEqual(["too-few-words", "unattested-side"]);
    expect(decision.words).toBe(34);
    // The row's fact menu carries score + name + clock: the depth defect is still
    // the one the retry repairs, and the direction claim is repaired by its own
    // retry line (ADAAAA-8910).
    expect(decision.violations).not.toContain("too-few-facts");
    expect(decision.violations).not.toContain("ungrounded-name");
  });

  it("still serves the 41-word body that cleared the floor by one word", () => {
    const evidence = {
      ...ROW_2F5A,
      reason:
        "The ASR commentary explicitly states 'Acaba de marcar el Real Madrid' at the start of the window, and the scoreboard OCR confirms a score change from 1-1 to 2-1 at 18:06.; scoreboard score change confirmed",
      windowTs: 27,
      scoreTransition: { from: "1-1", to: "2-1" },
      // The job's own attribution trail measured Real Madrid (home) beside the
      // resolved Barcelona list, so the served copy's actor is attested.
      matchContext: {
        ...JOB_CONTEXT,
        trail: [
          { at: "2026-11-12T20:39:19.899Z", names: [{ name: "Barcelona", side: "away", confidence: 0.5 }] },
          { at: "2026-11-12T20:40:23.344Z", names: [{ name: "Real Madrid", side: "home", confidence: 0.5 }] },
        ],
      },
    };
    const decision = gateSummaryDetail(SERVED_41, evidence);
    expect(decision.violations).toEqual([]);
    expect(decision.summary).toBe(SERVED_41);
    expect(decision.words).toBe(41);
    // 41 is inside the new target band's shadow but above the serve floor: the
    // gate keeps serving it, which is why this ticket changes generation depth
    // and not the gate.
    expect(decision.words).toBeGreaterThanOrEqual(SUMMARY_VOD_BAND.floorWords);
    // ADAAAA-8910: the clause the build actually stored ("Real Madrid secures a
    // lead as the scoreboard updates from 1-1 to 2-1") is refused on the SAME
    // evidence — the depth gate did not move, the truth gate did.
    const defect = gateSummaryDetail(SERVED_41_DEFECT, evidence);
    expect(defect.summary).toBeFalsy();
    expect(defect.violations).toContain("unattested-side");
    expect(defect.violations).not.toContain("too-few-words");
  });
});
