// ADAAAA-8209 AC2 — the WRITE-SEAM proof that the audit marker and the
// over-budget lead no longer reach a stored `reason` on the PRIMARY path.
//
// `services/server/src/analyzer.ts` stored
// `card.caption || (reasonClean ? shapedReason : quietCopy)` and `reasonClean`
// applied only `servedShapeViolations`, so the model's window-relative
// `at t=` marker and a lead over the quiet budget shipped as copy on the
// primary path while the quiet candidate gate refused exactly those shapes:
//
//   61d9d70a  Scoreboard changes from 2-1 to 2-2 at t=-4.0s and t=-3.0s.        (10 words)
//   37c2e3fe  Scoreboard changes from 2-2 to 1-1 at t=-3.0s and ball enters net. (14 words, stored as
//                                                                            `… and ball shoots on the left.`)
//   f7b867e4  … and crowd erupts at t=-5.0s                                    (19 words)
//
// `storedSurfaceFor` now applies `storedReasonViolations` — the quiet gate's own
// post-conditions (no `at t=` audit marker, lead within `QUIET_MAX_WORDS`) —
// and falls through to the quiet copy instead of storing the audit row. The
// fixtures are verbatim `reason_raw` values from the ADAAAA-8194 forward window.
import { describe, expect, it } from "vitest";
import { storedSurfaceFor, type DecisionResult } from "../src/analyzer.js";
import {
  QUIET_MAX_WORDS,
  captionLead,
  storedReasonViolations,
  wholeStoredSentence,
  type CaptionGroundingContext,
} from "@highlights/events";

const TAIL_V8 =
  "| live scoring lane: no measured attestation in this window (scoreBoardChanged=true goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none scoreReads=4 preSamples=2 postSamples=2 need=2); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL";

const ROW_61D = "Scoreboard changes from 2-1 to 2-2 at t=-4.0s and t=-3.0s; scoreboard score change confirmed";
const ROW_37C = `Scoreboard changes from 2-2 to 1-1 at t=-3.0s and ball enters net. ${TAIL_V8}`;
const ROW_9C9 = `Scoreboard changes from 2-2 to 1-1 at t=-3.0s, confirmed by ball in net at t=-2.0s.; scoreboard score change confirmed ${TAIL_V8}`;
const ROW_F7B = `Scoreboard changes from 2-2 to 1-1 (likely a goal/reset) and crowd erupts at t=-5.0s; scoreboard score change confirmed ${TAIL_V8}`;
const ROW_F206 = `Scoreboard changes to 1-1 at t=-2.0s and ASR confirms a goal for Real Madrid.; scoreboard score change confirmed ${TAIL_V8}`;

const PROMPT_2_1_2_2 = 'ocr="Art Soccer|22.02 FMA 2-1-BARAszende" | ocr="2211 EMA 2-2 BARDAVID SA"';
const PROMPT_2_2_1_1 =
  'ocr="ArtSoccer|28.5 ENA 2-2 BARAsendeAs" | ocr="Art Soccer|FMA 1-1-BARASzendASALDCA" | ocr="Art Soccer|FINAL 1-1-BARAzende3Asce"';
const PROMPT_1_1_ONLY = 'ocr="Art Soccer|11:32 FMA1-1-BAR12Art So"';

function row(reason: string, eventType: string, outcome: DecisionResult["outcome"]): DecisionResult {
  return { isHighlight: true, score: 61, eventType, outcome, reason };
}

const ctx = (verdict: string, eventType: string, promptText: string): CaptionGroundingContext => ({
  verdict,
  eventType,
  corroborated: false,
  promptText,
});

const leadWords = (text: string): number => captionLead(text).split(/\s+/).filter(Boolean).length;

/** The store-time bar: the reason may not carry the audit marker or exceed the lead budget. */
const expectStoredCopy = (stored: { reason?: string }, raw: string): void => {
  expect(stored.reason).toBeTruthy();
  const reason = stored.reason as string;
  expect(reason).not.toMatch(/\bat\s+t=-?[\d.]+\s*s\b/i);
  expect(leadWords(reason)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
  expect(storedReasonViolations(reason, [wholeStoredSentence(raw)])).toEqual([]);
};

describe("ADAAAA-8209 AC2 — the primary store path refuses the audit marker", () => {
  it("61d9d70a: stores the measured ledger line, not the 10-word at-t line", () => {
    const stored = storedSurfaceFor(
      row(ROW_61D, "GOAL", "scoring_play"),
      ctx("scoring_play", "GOAL", PROMPT_2_1_2_2)
    );
    expect(stored.reason).toBe("Scoreboard changes to 2-2.");
    expectStoredCopy(stored, ROW_61D);
    // The audit line is kept as `reason_raw`, never lost.
    expect(stored.reason_raw).toBe(ROW_61D);
  });

  it("37c2e3fe: stores a within-budget line, not the 14-word at-t line", () => {
    const stored = storedSurfaceFor(
      row(ROW_37C, "BIG_PLAY", "big_play"),
      ctx("big_play", "BIG_PLAY", PROMPT_2_2_1_1)
    );
    expectStoredCopy(stored, ROW_37C);
  });

  it("9c9f453b: stores the corroborated one-score ledger line", () => {
    const stored = storedSurfaceFor(
      row(ROW_9C9, "BIG_PLAY", "big_play"),
      ctx("big_play", "BIG_PLAY", PROMPT_2_2_1_1)
    );
    expect(stored.reason).toBe("Scoreboard changes to 1-1.");
    expectStoredCopy(stored, ROW_9C9);
  });

  it("f7b867e4: stores the ledger line although the instant rides a trailing clause", () => {
    const stored = storedSurfaceFor(
      row(ROW_F7B, "BIG_PLAY", "big_play"),
      ctx("big_play", "BIG_PLAY", PROMPT_2_2_1_1)
    );
    expect(stored.reason).toBe("Scoreboard changes to 1-1.");
    expectStoredCopy(stored, ROW_F7B);
  });

  it("a static post-only read stores nothing but keeps its audit line", () => {
    const stored = storedSurfaceFor(
      row(ROW_F206, "BIG_PLAY", "big_play"),
      ctx("big_play", "BIG_PLAY", PROMPT_1_1_ONLY)
    );
    // Clause 3: no honest sentence exists for a static read, so no `reason`.
    expect(stored.reason).toBeUndefined();
    expect(stored.reason_raw).toBe(ROW_F206);
  });

  it("a prose reason with an attribution tail stores byte-identically (no transition)", () => {
    const raw = "Scoreboard changes to 2-1 and commentary confirms the shot on the left.";
    const stored = storedSurfaceFor(
      row(raw, "BIG_PLAY", "big_play"),
      ctx("big_play", "BIG_PLAY", 'ocr="Art Soccer|22:11FMA 2-1 BAR4DAVID S"')
    );
    expect(stored.reason).toBe(raw);
  });

  it("a within-budget prose reason still stores byte-identically", () => {
    const raw = "The player in white shoots in the penalty area.";
    const stored = storedSurfaceFor(
      row(raw, "BIG_PLAY", "big_play"),
      ctx("big_play", "BIG_PLAY", "the player in white shoots in the penalty area")
    );
    expect(stored.reason).toBe(raw);
    expect(stored.reason_raw).toBeUndefined();
  });
});
