// ADAAAA-8193 (ADAAAA-8131 Q1 forward FAIL on the served ADAAAA-8130 build
// `42c016e`): 2 of the 81 accepted rows written since the 8130 deploy still
// stored neither `reason` nor `caption`. The 22-row replay arm stayed 22/22, so
// the 8130 actor-first fix holds; these two rows are a SECOND shape the extractor
// missed.
//
// ROW 1 (`job be2a5850…`, `highlight 953ca437…`, `BIG_PLAY`, 2026-11-06T01:10Z)
// is CLAIM-FREE and leads with the event LEDGER:
//   "Scoreboard changes to 1-1 at t=0.0s and players celebrate."
// `hasGoalClaim` is false, so `quietStoredCopy` built `candidates = [quiet]`
// ONLY: the beat clauses were computed only for a `claimBearing` row, and a
// claim-free row never had an outcome verb substituted, so nothing would have
// matched the substitution test even if they had been. The quiet candidate is
// the row's whole 9-word ledger sentence — over the §3.3 8-word budget — and the
// trimmed line fails the served-shape post-condition, so clause 3 emptied a row
// whose own honest tail beat is `Players celebrate.`
//
// ROW 2 (`job b8fb4aa4…`, `highlight c8d843fe…`, `GOAL`, 2026-11-06T00:26Z)
//   "Scoreboard changes from 2-1 to 2-2 at t=-5.0s and the ball is in the net."
// is claim-bearing: the claim cut leaves `… and the ball is in the shoots`, the
// leading clause is refused as a beat (event LEDGER, never a beat), and the tail
// strips to `the ball is in` (no verb) — every candidate is refused, correctly,
// because the ball-in-net clause is NOT measured (`goalCrossed=false`,
// `ballOutcome=null`). Whether a LEDGER-ONLY row is served a corroborated
// scoreboard line or carries an explicit clause-3 exemption is a product ruling
// (ADAAAA-8124); until it is recorded this row stays empty, and the tests below
// pin BOTH sides of that boundary: no uncorroborated claim ships, and no ledger
// line is invented by the extractor.
//
// Three things this file grades:
//   1. a claim-free row that LEADS with the ledger offers its own trailing beat
//      clause (row 1 -> `Players celebrate.`), passing every ADAAAA-8125
//      post-condition (<= 8-word lead, 0 served-shape violations against the
//      row's own stored sentence, fixed point of the gate order, non-empty);
//   2. that widening is SCOPED: a claim-free row that does not lead with the
//      ledger keeps its single quiet candidate, and a ledger-lead whose tail
//      carries no verb is still refused (clause 3 stays honest);
//   3. row 2 stays empty, and its unmeasured `ball is in the net` clause is
//      never served — the ledger is not turned into copy by this fix.
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
  stripInternalTokens,
  wholeStoredSentence,
  type CaptionGroundingContext,
} from "@highlights/events";

/** The live-scoring-lane demotion tail the row carries (audit text, never copy). */
const TAIL_V8 =
  "| live scoring lane: no measured attestation in this window (scoreBoardChanged=true goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none scoreReads=4 preSamples=2 postSamples=2 need=2); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL";

/** ROW 1, verbatim `reason_raw` (ADAAAA-8131 dump-forward.json). */
const ROW1_RAW = `Scoreboard changes to 1-1 at t=0.0s and players celebrate.; scoreboard score change confirmed ${TAIL_V8}`;

/** ROW 2, verbatim `reason_raw` (ADAAAA-8131 dump-forward.json). */
const ROW2_RAW =
  "Scoreboard changes from 2-1 to 2-2 at t=-5.0s and the ball is in the net.; scoreboard score change confirmed";

/** ROW 2's window dossier carries the score flip in the perceive OCR timeline
 * (`-6.1s … 2-1 …` / `-5.0s … 2-2 …`); the ball-in-net clause is unmeasured. */
const ROW2_PROMPT =
  'perceive timeline:\n  -6.8s ocr="22.12 RMA 2-1 BARAszende"\n  -6.1s ocr="22.12 RMA 2-1 BARAszende"\n  -5.0s ocr="22:19 |RMA 2-2 BAR"\n  -3.9s ocr="22:19 |RMA 2-2 BAR"';

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
  expect(servedShapeViolations(copy, [stored])).toEqual([]);
  expect(hasGoalClaim(copy)).toBe(false);
  expect(stripInternalTokens(copy)).toBe(copy);
  // Fixed point of the gate order: no read or re-emit derives another line.
  expect(gateGoalClaims(copy, ctx)).toBe(copy);
  expect(gateQuietWindow(copy, ctx)).toBe(copy);
  // Extractive: the copy is the row's own words, never a new sentence.
  expect(stored.toLowerCase()).toContain(copy.replace(/[.!?]+$/, "").toLowerCase());
};

describe("ADAAAA-8193 Q1 forward residual: claim-free ledger-leading row", () => {
  it("serves the row's own tail beat (row 1)", () => {
    const ctx = ctxFor("big_play", "BIG_PLAY", '22:19 |RMA 1-1 BAR\n-2.0s tracks=3 objects=player');
    const copy = quietStoredCopy(ROW1_RAW, ctx);
    expect(copy).toBe("Players celebrate.");
    expectServed(ROW1_RAW, copy, ctx);
  });

  it("the quiet candidate is refused on the 8-word budget, not on a claim", () => {
    const sentence = "Scoreboard changes to 1-1 at t=0.0s and players celebrate.";
    expect(hasGoalClaim(sentence)).toBe(false);
    expect(words(sentence)).toBeGreaterThan(QUIET_MAX_WORDS);
    // …so the whole ledger sentence may never be the copy.
    const copy = quietStoredCopy(ROW1_RAW, ctxFor("big_play", "BIG_PLAY"));
    expect(copy).not.toContain("Scoreboard");
  });

  it("never serves the ledger FRAME of a claim-free row as the beat", () => {
    // One clause only: the ledger line is the whole sentence, there is no beat.
    const raw = "Scoreboard changes to 1-1 at t=0.0s.; scoreboard score change confirmed";
    expect(quietStoredCopy(raw, ctxFor("big_play", "BIG_PLAY"))).toBe("");
  });

  it("keeps the scope: a claim-free row that does NOT lead with the ledger is unchanged", () => {
    const raw = "A player in white controls the ball in midfield and the keeper watches the play.";
    const copy = quietStoredCopy(raw, ctxFor("big_play", "BIG_PLAY"));
    // The quiet path still derives its line; the trailing clause is not offered
    // as a beat, because only a LEDGER-led sentence owns that widening.
    expect(copy).toBe("A player controls the ball in midfield.");
    expect(copy).not.toContain("keeper watches");
  });

  it("still refuses a ledger-led tail clause with no verb", () => {
    const raw = "Scoreboard changes to 1-1 at t=0.0s and the ball in the box.";
    expect(quietStoredCopy(raw, ctxFor("big_play", "BIG_PLAY"))).toBe("");
  });

  it("still refuses a ledger-led tail that carries a score claim the window never shows", () => {
    const raw = "Scoreboard changes to 1-1 at t=0.0s and the player in white makes it 2-0.";
    // No prompt: the score claim cannot be corroborated, so nothing ships.
    expect(quietStoredCopy(raw, ctxFor("big_play", "BIG_PLAY"))).toBe("");
  });
});

describe("ADAAAA-8193 row 2: ledger-only row stays empty until the ADAAAA-8124 ruling", () => {
  it("stores no copy for the ledger-only row", () => {
    expect(quietStoredCopy(ROW2_RAW, ctxFor("scoring_play", "GOAL", ROW2_PROMPT))).toBe("");
  });

  it("never serves the unmeasured `ball is in the net` clause", () => {
    const copy = quietStoredCopy(ROW2_RAW, ctxFor("scoring_play", "GOAL", ROW2_PROMPT));
    expect(copy).not.toContain("net");
    expect(hasGoalClaim(copy)).toBe(false);
    // The corpus's own claim survives in the stored sentence; only the copy is
    // refused, never the row.
    expect(findScoreClaims(wholeStoredSentence(ROW2_RAW))).toEqual(["2-1", "2-2"]);
  });
});
