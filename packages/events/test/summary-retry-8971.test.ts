// ADAAAA-8971 (increment 2 of ADAAAA-8934, AC5) — the RETRY SLOT's own rules.
//
// AC5 measures `summaryCalls` per row: rev-8 wrote 25 calls over 13 stored rows
// (1.92/row) because nine refused rows spent a second call on the SAME prompt.
// `306bb35` hands that retry the deleted-clause list and the row's fact menu, so
// the second sample is at least different. What is left is a retry that cannot
// succeed BY CONSTRUCTION, and there are two shapes of it:
//
//   1. the menu offered a fact the row does not attest. `summaryFactMenu` read the
//      VERDICT (`scoring_play`) instead of the evidence, so a row whose evidence
//      carries no measured transition was told "the score line … carries the most
//      words", and the gate then refuses every score clause it writes
//      (`scoreFactGrounded`). Measured on the rev-8 live leg (job `e4c2fe29`):
//      every promoted row attests clock + a named actor and NO score transition.
//   2. the menu is EMPTY: the row attests no fact kind at all, so every sample of
//      it must assert something unattested (`unattested-*`) — the refusal is a
//      property of the row, not of the sample.
//
// Both now end the row on ONE call, which is the AC5 direction. No bar is lowered:
// the menu only ever loses facts the gate would refuse to credit, and the
// determinism rule only fires where a second sample is provably futile.
import { describe, expect, it } from "vitest";
import {
  attestedFactKinds,
  buildSummaryPrompt,
  gateSummaryDetail,
  summaryFactMenu,
  summaryRefusalIsRepairable,
  type SummaryEvidence,
} from "../src/highlight-summary.js";

/** Live job `9bed3bd7`: no competition / venue key job-wide. */
const LIVE_CONTEXT = {
  sport: "soccer",
  teams: [{ name: "Barcelona", side: "away", kitColors: [], confidence: 0.5 }],
  inferredAt: "2026-11-13T06:12:29.808402Z",
  resolverVersion: 1,
  ambiguous: true,
  trail: [
    { at: "2026-11-13T06:08:30.057Z", names: [{ side: "away", name: "Barcelona", confidence: 0.5 }] },
  ],
};

const row = (over: Partial<SummaryEvidence>): SummaryEvidence => ({
  rail: "live",
  verdict: "scoring_play",
  eventType: "BIG_PLAY",
  reason: "Scoreboard changes to RMA 2-1; scoreboard score change confirmed",
  caption: "Scoreboard changes to RMA 2-1.",
  postTitle: null,
  windowTs: 101,
  windowDurationS: 15,
  scoreTransition: null,
  matchContext: LIVE_CONTEXT,
  transcript: null,
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: true },
  matchClock: { token: "18:12", seconds: 1092, period: null, legible: true },
  ...over,
});

/** The rev-8 live row `23f9b28e`: `scoring_play` VERDICT, clock + actor, no transition. */
const ROW_23F9 = row({});
/** A row whose evidence DOES carry the measured transition. */
const ROW_WITH_SCORE = row({ scoreTransition: { from: "1-1", to: "2-1" } });

describe("ADAAAA-8971 AC5 — the retry menu offers only facts the row attests", () => {
  it("keeps the score line off a row with no measured transition", () => {
    // The row is a `scoring_play` by verdict; its evidence never attests 1-1 -> 2-1.
    expect(ROW_23F9.verdict).toBe("scoring_play");
    expect(attestedFactKinds(ROW_23F9)).not.toContain("score");
    expect(summaryFactMenu(ROW_23F9)).not.toContain("the score line");
    // What it DOES attest is still offered.
    expect(summaryFactMenu(ROW_23F9)).toContain("the clock or spell");
  });

  it("offers the score line when the transition IS attested", () => {
    expect(attestedFactKinds(ROW_WITH_SCORE)).toContain("score");
    expect(summaryFactMenu(ROW_WITH_SCORE)).toContain("the score line");
  });

  it("keeps the clock line off a row with no window anchor", () => {
    const noAnchor = row({ windowTs: null, matchContext: null, transcript: null });
    expect(summaryFactMenu(noAnchor)).not.toContain("the clock or spell");
  });

  it("never tells the retry the score line 'carries the most words' on a score-less row", () => {
    const draft = "Barcelona maintains possession and works the ball forward during this sequence.";
    const decision = gateSummaryDetail(draft, ROW_23F9);
    const prompt = buildSummaryPrompt({
      ...ROW_23F9,
      retry: {
        words: decision.words,
        sentences: decision.sentences,
        violations: decision.violations,
        droppedClauses: decision.droppedClauses,
        factMenu: summaryFactMenu(ROW_23F9),
      },
    });
    expect(prompt).not.toContain("the score line carry the most words");
    expect(prompt).toContain("the clock or spell carry the most words");
  });
});

describe("ADAAAA-8971 AC5 — a refusal a second sample cannot repair ends on one call", () => {
  it("treats `unattested-sentence` as deterministic when the FACT MENU is empty", () => {
    // No window anchor, no score, no attested name, no venue => nothing to write.
    const empty = row({ windowTs: null, matchContext: null, transcript: null });
    expect(summaryFactMenu(empty)).toEqual([]);
    expect(summaryRefusalIsRepairable("unattested-sentence", empty)).toBe(false);
    expect(summaryRefusalIsRepairable("unattested-atmosphere", empty)).toBe(false);
  });

  it("keeps the retry slot for the same refusal on a row that DOES attest a fact", () => {
    expect(summaryRefusalIsRepairable("unattested-sentence", ROW_23F9)).toBe(true);
  });

  it("keeps `too-few-facts` deterministic on a one-kind row and repairable on a two-kind row", () => {
    const oneKind = row({ matchContext: null, transcript: null }); // clock only
    expect(attestedFactKinds(oneKind)).toEqual(["clock"]);
    expect(summaryRefusalIsRepairable("too-few-facts", oneKind)).toBe(false);
    // clock + action (a named attested actor).
    expect(attestedFactKinds(ROW_23F9)).toEqual(["clock", "action"]);
    expect(summaryRefusalIsRepairable("too-few-facts", ROW_23F9)).toBe(true);
  });
});
