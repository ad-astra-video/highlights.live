// ADAAAA-8221 — the LIVE scoring lane's refusal tail is AUDIT text, not copy.
//
//   | live scoring lane: no measured attestation in this window (…) — delivered
//     as a celebration, not a GOAL
//
// ADAAAA-8040/8209 already ruled that a decide reason's audit tails never reach
// the stored sentence, and `stripInternalTokens`' `INTERNAL_REASON_TAIL` removed
// that family — but not this one. The measured consequence on build `1d49b02`
// (0 GPU container replay of the 188 stored rows that carry the tail):
//
//  * 8 rows carried the whole evidence paragraph into `wholeStoredSentence`
//    (their own sentence had no terminal punctuation before the tail);
//  * the write-seam line (`groundCaption`) was refused to `""` on 109 rows,
//    because the tail's own `GOAL` / `celebration` words look like a claim;
//  * `quietStoredCopy` is byte-identical on all 188 rows, and a row whose lead
//    already ends a sentence is untouched — so this is an audit-strip fix, not a
//    copy rewrite.
import { describe, it, expect } from "vitest";
import {
  groundCaption,
  quietStoredCopy,
  stripInternalTokens,
  wholeStoredSentence,
  type CaptionGroundingContext,
} from "@highlights/events";

/** The demotion tail the live scoring lane appends (v8, with the counters). */
const TAIL_V8 =
  "| live scoring lane: no measured attestation in this window (scoreBoardChanged=false goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL";
/** The v7 wording (no counters). */
const TAIL_V7 =
  "| live scoring lane: no measured attestation in this window (no scoreboard change, no goal-line / net signal, no corroborated confirm) — delivered as a celebration, not a GOAL";

/** The audit phrases that must never survive into any derived surface. */
const AUDIT_PHRASES =
  /live scoring lane|no measured attestation|delivered as a celebration|corroborating evidence only|cannot attest a score/i;

const ctxFor = (overrides: Partial<CaptionGroundingContext> = {}): CaptionGroundingContext => ({
  verdict: "big_play",
  eventType: "BIG_PLAY",
  corroborated: false,
  place: "in midfield",
  promptText: "",
  ...overrides,
});

describe("ADAAAA-8221 — stripInternalTokens removes the live scoring-lane tail", () => {
  it("strips the v8 tail after a terminal sentence", () => {
    const raw = `Crowd erupts in celebration as the scoreboard shows a goal for FCB. ${TAIL_V8}`;
    expect(stripInternalTokens(raw)).toBe("Crowd erupts in celebration as the scoreboard shows a goal for FCB.");
  });

  it("strips the v7 tail after a terminal sentence", () => {
    const raw = `Crowd erupts in celebration as the scoreboard shows a goal for FCB. ${TAIL_V7}`;
    expect(stripInternalTokens(raw)).toBe("Crowd erupts in celebration as the scoreboard shows a goal for FCB.");
  });

  it("strips the tail when the row's own sentence has no terminal punctuation", () => {
    // The measured leak shape: nothing ends the sentence before the tail, so the
    // tail used to ride into the derived sentence.
    const raw = `Crowd erupts in celebration as the scoreboard shows a goal for FCB ${TAIL_V8}`;
    const stripped = stripInternalTokens(raw);
    expect(AUDIT_PHRASES.test(stripped)).toBe(false);
    expect(stripped).toBe("Crowd erupts in celebration as the scoreboard shows a goal for FCB");
  });

  it("also strips it when it rides a semicolon/ledger line", () => {
    const raw = `Scoreboard changes from 2-2 to 1-1 at t=-3.0s, confirmed by ball in net at t=-2.0s ${TAIL_V8}`;
    const stripped = stripInternalTokens(raw);
    expect(AUDIT_PHRASES.test(stripped)).toBe(false);
    expect(stripped).toBe("Scoreboard changes from 2-2 to 1-1 at t=-3.0s, confirmed by ball in net at t=-2.0s");
  });

  it("returns text without a tail byte-identical", () => {
    const clean = "Crowd erupts in celebration. — players mob the scorer";
    expect(stripInternalTokens(clean)).toBe(clean);
  });

  it("keeps a `|`-separated clause that is not an audit tail", () => {
    const clean = "The keeper saves | the rebound is cleared";
    expect(stripInternalTokens(clean)).toBe(clean);
  });
});

describe("ADAAAA-8221 — the derived sentence never carries the audit paragraph", () => {
  it("wholeStoredSentence is the row's own sentence, not the evidence paragraph", () => {
    const raw = `Crowd erupts in celebration as the scoreboard shows a goal for FCB ${TAIL_V8}`;
    const whole = wholeStoredSentence(stripInternalTokens(raw).trim());
    expect(AUDIT_PHRASES.test(whole)).toBe(false);
    expect(whole).toBe("Crowd erupts in celebration as the scoreboard shows a goal for FCB");
  });

  it("a row whose lead ends a sentence is untouched (no copy rewrite)", () => {
    const raw = `Players celebrate in the box. ${TAIL_V8}`;
    const ctx = ctxFor();
    expect(quietStoredCopy(raw, ctx)).toBe("Players celebrate in the box.");
    expect(groundCaption(raw, ctx)).toBe("Players celebrate in the box.");
  });

  it("keeps the ADAAAA-8130 leading beat byte-identical (crowd erupts fixture)", () => {
    // The row that stored NOTHING on the ADAAAA-8125 build; ADAAAA-8130 ruled it
    // owes its own leading beat. This increment must not move that string.
    const raw = `Crowd erupts in celebration as the scoreboard shows a goal for FCB. ${TAIL_V8}`;
    const ctx = ctxFor({ place: "in the penalty area", promptText: 'ocr="scoreboard 1-1" | ocr="scoreboard 2-1"' });
    expect(quietStoredCopy(raw, ctx)).toBe("Crowd erupts in celebration.");
    expect(AUDIT_PHRASES.test(quietStoredCopy(raw, ctx))).toBe(false);
  });

  it("keeps the row's own beat on the write seam (ADAAAA-8027 row 25929400 shape)", () => {
    // Before the strip this line was refused to `""`: the tail's `GOAL` and
    // `celebration` words made the claim gate drop the whole row even though the
    // window's own sentence carried a claim-free beat.
    const raw = `The ball enters the net and the scoreboard updates to 2-1, followed by player celebrations. ${TAIL_V7}`;
    const gated = groundCaption(raw, ctxFor());
    expect(gated).toBe("The scoreboard updates, followed by player celebrations.");
    expect(AUDIT_PHRASES.test(gated)).toBe(false);
  });

  it("never derives copy that mentions the lane or its evidence", () => {
    const raws = [
      `Crowd erupts in celebration ${TAIL_V8}`,
      `Players celebrate in the box ${TAIL_V7}`,
      `The keeper is beaten, followed by a celebration. ${TAIL_V8}`,
      `The scoreboard updates to 2-1. ${TAIL_V8}`,
    ];
    for (const raw of raws) {
      const ctx = ctxFor();
      for (const out of [wholeStoredSentence(stripInternalTokens(raw).trim()), quietStoredCopy(raw, ctx), groundCaption(raw, ctx)]) {
        expect(AUDIT_PHRASES.test(out), `${raw} -> ${out}`).toBe(false);
      }
    }
  });
});
