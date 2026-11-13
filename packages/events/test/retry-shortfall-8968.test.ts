// ADAAAA-8968 (AC5) — the RETRY directive must carry the MEASURED shortfall.
//
// The rev-8 grade (`ADAAAA-8925`) billed `summaryCalls` 25 over 13 rows = 1.92
// calls/row against the 1.5 AC5 average, and all 9 rows that took a second call
// still dropped. The retry was a second sample of the same prompt: it was told
// the violation token and the band floor, never the number of words its draft was
// SHORT, so it re-landed the deleted clauses and the depth refusal repeated.
//
// The lane now hands the directive `shortfallWords` (floor - measured words). The
// prompt states it as a quantity ("that draft measured 6 words short of the
// 40-word floor") beside the deleted-clause list and the row's fact menu. The
// SAMPLE-2 ACCEPTANCE CHECK does not move: the gate, the band and the floor are
// untouched — only what the second prompt is told changes.
import { describe, expect, it } from "vitest";
import {
  SUMMARY_VOD_BAND,
  buildSummaryPrompt,
  gateSummaryDetail,
  summaryFactMenu,
  summaryRetryMinWords,
  type SummaryEvidence,
} from "../src/highlight-summary.js";

/** Row `2f5a5796`'s evidence (the rev-7 VOD row the retry starved). */
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
  matchContext: {
    sport: "soccer",
    teams: [{ name: "Barcelona", side: "away", kitColors: [], confidence: 0.85 }],
    ambiguous: false,
  },
  transcript: null,
};

/** The 34-word draft the served build stored as `summaryRaw` on `2f5a5796`. */
const DRAFT_34 =
  "Barcelona finds the equalizer to level the score at 2-2. This pivotal moment occurs at the 1:27 mark of the clip. The team successfully converts the opportunity to secure a draw in the match.";

const decision = gateSummaryDetail(DRAFT_34, ROW_2F5A);

describe("ADAAAA-8968 AC5 — the retry is told how many words it is short", () => {
  it("names the measured shortfall as a number of words on a depth refusal", () => {
    const retry = {
      words: decision.words,
      sentences: decision.sentences,
      violations: decision.violations,
      shortfallWords: Math.max(0, SUMMARY_VOD_BAND.floorWords - decision.words),
      droppedClauses: decision.droppedClauses,
      factMenu: summaryFactMenu(ROW_2F5A),
    };
    const prompt = buildSummaryPrompt({ ...ROW_2F5A, retry });
    expect(decision.words).toBe(34);
    expect(retry.shortfallWords).toBe(6);
    expect(prompt).toContain("that draft measured 6 words short of the 40-word floor");
    // The bar did not move: the retry still asks for the floor plus the margin.
    expect(prompt).toContain("this copy must reach at least 45 words inside 3-5 sentences");
    expect(prompt).toContain("45 is 5 words above the 40-word floor");
    expect(summaryRetryMinWords(SUMMARY_VOD_BAND)).toBe(45);
  });

  it("carries the deleted clauses and the row's fact menu beside the shortfall", () => {
    const retry = {
      words: decision.words,
      sentences: decision.sentences,
      violations: decision.violations,
      shortfallWords: 6,
      droppedClauses: decision.droppedClauses,
      factMenu: summaryFactMenu(ROW_2F5A),
    };
    const prompt = buildSummaryPrompt({ ...ROW_2F5A, retry });
    expect(decision.droppedClauses.length).toBeGreaterThan(0);
    expect(prompt).toContain("were DELETED from that draft because they carry no attested fact");
    expect(prompt).toContain(decision.droppedClauses[0].trim());
    expect(prompt).toContain(summaryFactMenu(ROW_2F5A)[0]);
  });

  it("does not chase words the draft already had: a compliance refusal reports a zero shortfall", () => {
    const prompt = buildSummaryPrompt({
      ...ROW_2F5A,
      retry: { words: 46, sentences: 4, violations: ["unattested-sentence"], shortfallWords: 0 },
    });
    expect(prompt).toContain("that draft met the 40-word floor");
    expect(prompt).not.toContain("words short of the 40-word floor");
  });

  it("derives the shortfall from the measured words when the lane sends no explicit figure", () => {
    const prompt = buildSummaryPrompt({
      ...ROW_2F5A,
      retry: { words: 34, sentences: 3, violations: ["too-few-words"] },
    });
    expect(prompt).toContain("that draft measured 6 words short of the 40-word floor");
  });

  it("leaves the FIRST pass without a retry directive", () => {
    const first = buildSummaryPrompt(ROW_2F5A);
    expect(first).not.toContain("RETRY:");
    expect(first).not.toContain("words short of the 40-word floor");
  });
});
