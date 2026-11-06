// ADAAAA-8209 — the ADAAAA-8194 re-grade on the served build `83479a2` left a
// Q1 forward residual of 2/16 accepted rows with no copy, plus a primary-path
// leak. Two SHAPES this file pins:
//
//  1. A SINGLE-CLAUSE ledger row whose provenance phrase is comma-appended:
//
//       Scoreboard changes from 2-2 to 1-1 at t=-3.0s, confirmed by ball in net at t=-2.0s.
//
//     `splitQuietClauses` opens clauses only at `as/while/when/and/but`, so the
//     whole sentence was ONE clause and `ledgerScoreLines` bailed on
//     `clauses.length < 2` before it ever read the `from X to Y` transition — the
//     row stored nothing even though its own prompt measured BOTH ends. The
//     ledger frame is now the leading clause up to the first comma/semicolon, so
//     the read does not depend on the sentence having a connector clause.
//
//  2. The naive fix — adding `,` to `splitQuietClauses` — MANGLES the row: the
//     provenance phrase becomes a clause, and the beat scan offers
//     `Confirmed by ball in shoots.` before the ledger candidate. A provenance /
//     attribution clause (`confirmed by …`, `ASR confirms …`, any `at t=` suffix)
//     must NEVER be a beat, and the measured instant may ride a TRAILING clause
//     (`… and crowd erupts at t=-5.0s`), which is why the ledger's `at t=` test
//     reads the row's whole stored sentence, not only the quiet frame.
//
// The fixtures are verbatim `reason_raw` values from the ADAAAA-8194 forward
// window (`dump-pd8194b.json`): `9c9f453b` (no copy), `f7b867e4` (19-word
// primary-path leak), `61d9d70a` (10-word leak), `37c2e3fe` (14-word leak),
// `f206c925` (static post-only read, clause-3 exemption) and `4c4d691b`
// (static read + ASR quote). The prompts are the rows' own OCR reads, reduced to
// the lines that carry the measured scores.
import { describe, it, expect } from "vitest";
import {
  QUIET_MAX_WORDS,
  captionLead,
  findScoreClaims,
  gateGoalClaims,
  gateQuietWindow,
  hasGoalClaim,
  quietStoredCopy,
  servedShapeViolations,
  storedReasonViolations,
  stripInternalTokens,
  wholeStoredSentence,
  type CaptionGroundingContext,
} from "@highlights/events";

const TAIL_V8 =
  "| live scoring lane: no measured attestation in this window (scoreBoardChanged=true goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none scoreReads=4 preSamples=2 postSamples=2 need=2); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL";

/** `9c9f453b` — BIG_PLAY, job c29df256, stored neither `reason` nor `caption`. */
const ROW_9C9 = `Scoreboard changes from 2-2 to 1-1 at t=-3.0s, confirmed by ball in net at t=-2.0s.; scoreboard score change confirmed ${TAIL_V8}`;
/** `f7b867e4` — BIG_PLAY; the measured instant rides the TRAILING clause. */
const ROW_F7B =
  "Scoreboard changes from 2-2 to 1-1 (likely a goal/reset) and crowd erupts at t=-5.0s; scoreboard score change confirmed | live scoring lane: no measured attestation in this window (scoreBoardChanged=true goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none scoreReads=8 preSamples=5 postSamples=3 need=2); audio/motion reaction is corroborating evidence only and cannot attest a score";
/** `61d9d70a` — GOAL; the PRIMARY path stored a 10-word line with `at t=`. */
const ROW_61D = "Scoreboard changes from 2-1 to 2-2 at t=-4.0s and t=-3.0s; scoreboard score change confirmed";
/** `37c2e3fe` — BIG_PLAY; the PRIMARY path stored a 14-word line with `at t=`. */
const ROW_37C =
  "Scoreboard changes from 2-2 to 1-1 at t=-3.0s and ball enters net. | live scoring lane: no measured attestation in this window (scoreBoardChanged=true goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none scoreReads=4 preSamples=2 postSamples=2 need=2); audio/motion reaction is corroborating evidence only and cannot attest a score";
/** `f206c925` — BIG_PLAY; static post-only read (prompt carries `1-1` only). */
const ROW_F206 =
  "Scoreboard changes to 1-1 at t=-2.0s and ASR confirms a goal for Real Madrid.; scoreboard score change confirmed | live scoring lane: no measured attestation in this window (scoreBoardChanged=true goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none scoreReads=4 preSamples=2 postSamples=2 need=2); audio/motion reaction is corroborating evidence only and cannot attest a score";

/** The row's own perceive OCR timeline (reduced to the score-bearing reads). */
const PROMPT_9C9 =
  'perceive timeline:\n  -8.0s ocr="ArtSoccer|28.5 ENA 2-2 BARAsendeAs"\n  -6.0s ocr="Art Soccer|29114 EMA 2-2 BARAszende"\n  -3.0s ocr="Art Soccer|FMA 1-1-BARASzendASALDCA"\n  -2.0s ocr="Art Soccer|FINAL 1-1-BARAzende3Asce"';
const PROMPT_61D =
  'perceive timeline:\n  -10.0s ocr="Art Soccer|22.02 FMA 2-1-BARAszende"\n  -4.0s ocr="4DAVID SAEZGOLES 1Art So|2211 EMA 2-2 BARDAVID SA"\n  -3.0s ocr="4DAVID SAEZCOLES 1Soccer|22:11FMA 2-2 BAR4DAVID S"';
const PROMPT_37C = PROMPT_9C9;
const PROMPT_F7B =
  'perceive timeline:\n  -9.0s ocr="Art Soccer|29114 EMA 2-2 BARAszende"\n  -7.0s ocr="Art Soccer|FMA 1-1-BARASzendeAsAsze"\n  -5.0s ocr="Art Soccer|FINAL 1-1-BARAzende3Asce"';
const PROMPT_F206 = 'perceive timeline:\n  -4.0s ocr="Art Soccer|11:23FMA 1-1-1 BARAszend"\n  -2.0s ocr="Art Soccer|11:32 FMA1-1-BAR12Art So"';

const ctxFor = (verdict: string, eventType: string, promptText?: string): CaptionGroundingContext => ({
  verdict,
  eventType,
  corroborated: false,
  ...(promptText ? { promptText } : {}),
});

const words = (text: string): number => captionLead(text).split(/\s+/).filter(Boolean).length;

/** Every ADAAAA-8125 post-condition the served copy must still cross. */
const expectServed = (raw: string, copy: string, ctx: CaptionGroundingContext): void => {
  const stored = wholeStoredSentence(raw);
  expect(copy).not.toBe("");
  expect(words(copy)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
  expect(storedReasonViolations(copy, [stored])).toEqual([]);
  expect(servedShapeViolations(copy, [stored])).toEqual([]);
  expect(hasGoalClaim(copy)).toBe(false);
  expect(stripInternalTokens(copy)).toBe(copy);
  expect(gateGoalClaims(copy, ctx)).toBe(copy);
  expect(gateQuietWindow(copy, ctx)).toBe(copy);
  // Extractive: every word of the copy is one of the row's own words (a ledger
  // line drops the superseded old score, so contiguity is not the test).
  const storedWords = stored.toLowerCase().match(/[\p{L}\d-]+/gu) ?? [];
  for (const w of copy.toLowerCase().match(/[\p{L}\d-]+/gu) ?? []) expect(storedWords).toContain(w);
};

describe("ADAAAA-8209 AC1: the single-clause ledger row is served its measured transition", () => {
  it("serves `Scoreboard changes to 1-1.` (row 9c9f453b)", () => {
    const ctx = ctxFor("big_play", "BIG_PLAY", PROMPT_9C9);
    const copy = quietStoredCopy(ROW_9C9, ctx);
    expect(copy).toBe("Scoreboard changes to 1-1.");
    expectServed(ROW_9C9, copy, ctx);
    // One score only — the measured POST score, never the old one beside it.
    expect(findScoreClaims(copy)).toEqual(["1-1"]);
    // The provenance phrase and the audit marker never ride.
    expect(copy).not.toContain("confirmed");
    expect(copy).not.toMatch(/\bat\s+t=/i);
  });

  it("the comma is not the mechanism: a connector form serves the same line", () => {
    const connected = "Scoreboard changes from 2-2 to 1-1 at t=-3.0s and confirmed by ball in net at t=-2.0s.";
    const ctx = ctxFor("big_play", "BIG_PLAY", PROMPT_9C9);
    const copy = quietStoredCopy(connected, ctx);
    expect(copy).toBe("Scoreboard changes to 1-1.");
    // …and the provenance clause is never offered as a beat, which is the
    // mangled line a bare comma split shipped: `Confirmed by ball in shoots.`
    expect(copy.toLowerCase()).not.toContain("confirmed");
  });

  it("a provenance clause with its own verb is still never a beat", () => {
    const raw = "Scoreboard changes from 2-2 to 1-1 at t=-3.0s and confident play confirmed by ball in net.";
    const copy = quietStoredCopy(raw, ctxFor("big_play", "BIG_PLAY", PROMPT_9C9));
    expect(copy).toBe("Scoreboard changes to 1-1.");
    expect(copy.toLowerCase()).not.toContain("confirmed");
  });

  it("still refuses a static read (prompt corroborates the post score only)", () => {
    const staticPrompt = 'perceive timeline:\n  -2.0s ocr="Art Soccer|FINAL 1-1-BARAzende3Asce"';
    expect(quietStoredCopy(ROW_9C9, ctxFor("big_play", "BIG_PLAY", staticPrompt))).toBe("");
  });

  it("never serves an attribution line as the copy", () => {
    // Corpus row `452990dd`: the quiet shape leaves `Commentary confirms Real
    // Madrid shoots.` — the model citing commentary, not the row's beat. With no
    // honest shorter sentence the row keeps no copy (clause 3).
    const raw =
      "Scoreboard changes from 1-1 to 2-1 and commentary confirms Real Madrid shoots on the left.";
    expect(quietStoredCopy(raw, ctxFor("big_play", "BIG_PLAY", PROMPT_61D))).toBe("");
  });

  it("never serves a parenthetical as the copy", () => {
    // Corpus row `4ad58222`: `(implied shot)` is model speculation; an unbalanced
    // `(` is a truncation of one. Neither is copy.
    const raw = "Scoreboard changes from 2-1 to 2-1 (implied shot) and players celebrate in midfield.";
    const copy = quietStoredCopy(raw, ctxFor("big_play", "BIG_PLAY", PROMPT_61D));
    // The row keeps its own honest beat; the parenthetical never rides.
    expect(copy).toBe("Players celebrate in midfield.");
    expect(copy).not.toContain("(");
    expect(copy).not.toContain("implied");
  });

  it("still refuses a sentence with no `from X to Y` transition", () => {
    const raw = "Scoreboard changes to 1-1 at t=-3.0s, confirmed by ball in net at t=-2.0s.";
    expect(quietStoredCopy(raw, ctxFor("big_play", "BIG_PLAY", PROMPT_9C9))).toBe("");
  });

  it("still serves nothing when the window measured no score at all", () => {
    expect(quietStoredCopy(ROW_9C9, ctxFor("big_play", "BIG_PLAY"))).toBe("");
  });

  it("keeps the static post-only row empty (row f206c925, clause-3 exemption)", () => {
    // No `from X to Y` in the row's own words; the prompt corroborates `1-1`
    // only, so the change is a claim, not a measurement.
    expect(quietStoredCopy(ROW_F206, ctxFor("big_play", "BIG_PLAY", PROMPT_F206))).toBe("");
  });
});

describe("ADAAAA-8209 AC2: the measured instant may ride a trailing clause", () => {
  it("serves the ledger line when `at t=` rides the trailing clause (row f7b867e4)", () => {
    const ctx = ctxFor("big_play", "BIG_PLAY", PROMPT_F7B);
    const copy = quietStoredCopy(ROW_F7B, ctx);
    expect(copy).toBe("Scoreboard changes to 1-1.");
    expectServed(ROW_F7B, copy, ctx);
    // The model's parenthetical speculation is never copy either.
    expect(copy).not.toContain("likely");
    expect(copy).not.toMatch(/\bat\s+t=/i);
  });

  it("a sentence with no `at t=` instant anywhere earns no LEDGER line", () => {
    const raw = "Scoreboard changes from 2-2 to 1-1 and crowd erupts.";
    const copy = quietStoredCopy(raw, ctxFor("big_play", "BIG_PLAY", PROMPT_9C9));
    // The row's own beat still ships; the ledger line is never invented without a
    // measured instant.
    expect(copy).toBe("Crowd erupts.");
    expect(copy).not.toContain("Scoreboard");
  });
});

describe("ADAAAA-8209 AC2: the store-time post-condition refuses the audit marker and the over-budget lead", () => {
  const clean = (text: string): string[] => storedReasonViolations(text, []);

  it("refuses a 10-word ledger line carrying `at t=` (row 61d9d70a)", () => {
    expect(words("Scoreboard changes from 2-1 to 2-2 at t=-4.0s and t=-3.0s.")).toBe(10);
    expect(clean("Scoreboard changes from 2-1 to 2-2 at t=-4.0s and t=-3.0s.")).toEqual([
      "audit-marker",
      "quiet-budget",
    ]);
  });

  it("refuses a 14-word ledger line carrying `at t=` (row 37c2e3fe)", () => {
    const line = "Scoreboard changes from 2-2 to 1-1 at t=-3.0s and ball shoots on the left.";
    expect(words(line)).toBe(14);
    expect(clean(line)).toEqual(["audit-marker", "quiet-budget"]);
  });

  it("refuses the audit marker on its own, at any length", () => {
    expect(clean("Scoreboard changes to 2-2 at t=-4.0s.")).toEqual(["audit-marker"]);
  });

  it("accepts the served ledger line and a within-budget prose line", () => {
    expect(clean("Scoreboard changes to 2-2.")).toEqual([]);
    expect(clean("The player in white shoots in the box.")).toEqual([]);
  });

  it("keeps a prose line with an attribution tail: the budget is the LEDGER's", () => {
    // Corpus row `6503a7f3`/`a20442a6` (dump.json): 12 words, no `at t=`, no
    // `from X to Y` transition — a prose read + attribution tail, not a ledger
    // line, so the quiet lead budget does not refuse it. Refusing it would empty
    // a row that has honest copy and no shorter sentence behind it.
    const line = "Scoreboard changes to 2-1 and commentary confirms the shot on the left.";
    expect(words(line)).toBeGreaterThan(QUIET_MAX_WORDS);
    expect(clean(line)).toEqual([]);
  });

  it("the two leaking fixtures replay to honest copies through the seam", () => {
    expect(quietStoredCopy(ROW_61D, ctxFor("scoring_play", "GOAL", PROMPT_61D))).toBe("Scoreboard changes to 2-2.");
    // 37c2e3fe's own claim clause (`ball enters net`) is unmeasured; the quiet
    // shape's substituted outcome (`Ball shoots.`) is the row's honest beat.
    const copy = quietStoredCopy(ROW_37C, ctxFor("big_play", "BIG_PLAY", PROMPT_37C));
    expect(clean(copy)).toEqual([]);
    expect(words(copy)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
  });
});
