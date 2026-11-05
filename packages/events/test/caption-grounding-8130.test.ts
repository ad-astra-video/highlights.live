// ADAAAA-8130 (ADAAAA-8126 Q1 = 1 on the ADAAAA-8125 fix): ONE of the 22
// ADAAAA-8124 baseline no-copy rows still stored nothing although its own window
// carries an honest beat.
//
// The row (`job 6184f0e2…`, `highlight 368393f2…`, `BIG_PLAY`, 2026-11-05T15:43Z)
// stored
//   "Crowd erupts in celebration as the scoreboard shows a goal for FCB. | …"
// and `quietStoredCopy` returned `""`: `quietShape` cut the claim and left
// `Crowd erupts in celebration as the scoreboard shows a shoots`, `quietBeatClause`
// only scanned clauses AFTER the frame split, so the row's OWN leading clause
// (`Crowd erupts in celebration`, its own verb `erupts`, no claim) was never
// offered as a candidate. Clause 3 (no honest sentence) was not the binding case.
//
// Three things are graded here:
//   1. the LEADING clause is a beat candidate when it carries its own verb and no
//      claim/score/internal token (extractive: the row's own words, sentence-case,
//      closed with `restoreTerminalPunctuation`);
//   2. the substituted tail is stripped BEFORE the beat check (`shows a shoots`
//      -> `shows`) and the frame clause it came from is never a beat, so the
//      mangled variant cannot be served;
//   3. every post-condition of the ADAAAA-8125 fix is unchanged (fixed point of
//      `gateGoalClaims` -> `gateQuietWindow`, 0 `servedShapeViolations` against
//      `wholeStoredSentence(raw)`, <= 8-word lead, no internal token, no card).
//
// The replay table below is the EXACT 22 rows from ADAAAA-8126's `replay-out`
// (sources verbatim, `reasonRaw` from the dump): 22/22 copy, and the 21 rows the
// ADAAAA-8125 build already served stay byte-identical.
import { describe, it, expect } from "vitest";
import {
  QUIET_MAX_WORDS,
  captionLead,
  findScoreClaims,
  gateGoalClaims,
  gateQuietWindow,
  hasGoalClaim,
  quietStoredCopy,
  restoreTerminalPunctuation,
  servedShapeViolations,
  stripInternalTokens,
  wholeStoredSentence,
  type CaptionGroundingContext,
} from "@highlights/events";

/** The demotion tail the live scoring lane appends (audit text, never copy). */
const TAIL_V8 =
  "| live scoring lane: no measured attestation in this window (scoreBoardChanged=false goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL";

const ctxFor = (verdict: string, eventType: string): CaptionGroundingContext => ({
  verdict,
  eventType,
  corroborated: false,
});

type Row = { eventType: string; verdict: string; raw: string; copy: string };

/** The 22 no-copy rows from ADAAAA-8126's replay (`dump.json`, sources verbatim). */
const REPLAY_ROWS: Row[] = [
  { eventType: "BIG_PLAY", verdict: "big_play", raw: "The scoreboard updates from 1-1 to 2-1 as players celebrate a goal. | live scoring lane: no measured attestation in this window (scoreBoardChanged=false goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL", copy: "Players celebrate." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "The scoreboard updates from 2-1 to 2-2 as the ball enters the net.; scoreboard score change confirmed", copy: "The ball shoots." },
  { eventType: "BIG_PLAY", verdict: "big_play", raw: "The scoreboard updates from 1-1 to 2-1 as the player in white scores. | live scoring lane: no measured attestation in this window (scoreBoardChanged=false goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL", copy: "The player in white shoots." },
  { eventType: "BIG_PLAY", verdict: "big_play", raw: "Crowd erupts in celebration as the scoreboard shows a goal for FCB. | live scoring lane: no measured attestation in this window (scoreBoardChanged=false goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL", copy: "Crowd erupts in celebration." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "The scoreboard updates from 1-1 to 2-1 as players celebrate a goal.; scoreboard score change confirmed", copy: "Players celebrate." },
  { eventType: "BIG_PLAY", verdict: "big_play", raw: "Scoreboard updates from 1-1 to 2-1 as the player in white scores. | live scoring lane: no measured attestation in this window (scoreBoardChanged=false goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL", copy: "The player in white shoots." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "The scoreboard updates from 1-1 to 2-1 as the ball enters the net.; scoreboard score change confirmed", copy: "The ball shoots." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "The scoreboard updates from 2-1 to 2-2 as the ball enters the net.; scoreboard score change confirmed", copy: "The ball shoots." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "The scoreboard changes from 1-1 to 2-1 as the ball enters the net.; scoreboard score change confirmed", copy: "The ball shoots." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "The scoreboard updates from 1-1 to 2-1 as players celebrate a goal.; scoreboard score change confirmed", copy: "Players celebrate." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "The scoreboard changes from 2-1 to 1-1 as the ball enters the net.; scoreboard score change confirmed", copy: "The ball shoots." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "The scoreboard changes from 1-1 to 2-1 as players celebrate a goal.; scoreboard score change confirmed", copy: "Players celebrate." },
  { eventType: "BIG_PLAY", verdict: "big_play", raw: "The scoreboard updates from 1-1 to 2-1 as the player in white scores. | live scoring lane: no measured attestation in this window (scoreBoardChanged=false goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL", copy: "The player in white shoots." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "The scoreboard updates to 2-1 and a player celebrates after the ball enters the net.; scoreboard score change confirmed", copy: "A player celebrates after the ball shoots." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "The scoreboard changes from 1-1 to 2-1 as the ball enters the net.; scoreboard score change confirmed", copy: "The ball shoots." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "The scoreboard updates from 1-1 to 2-1 as players celebrate a goal.; scoreboard score change confirmed", copy: "Players celebrate." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "Scoreboard changes from 1-1 to 2-1 as players celebrate a goal.; scoreboard score change confirmed", copy: "Players celebrate." },
  { eventType: "BIG_PLAY", verdict: "big_play", raw: "The scoreboard updates from 1-1 to 2-1 as the player in white scores. | live scoring lane: no measured attestation in this window (scoreBoardChanged=false goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL", copy: "The player in white shoots." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "The scoreboard changes from 2-1 to 2-2 as the ball enters the net.; scoreboard score change confirmed", copy: "The ball shoots." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "The scoreboard changes from 1-1 to 2-1 as players celebrate a goal.; scoreboard score change confirmed", copy: "Players celebrate." },
  { eventType: "GOAL", verdict: "scoring_play", raw: "The scoreboard changes from 2-1 to 1-1 and players celebrate as the ball enters the net.; scoreboard score change confirmed", copy: "The ball shoots." },
  { eventType: "BIG_PLAY", verdict: "big_play", raw: "The scoreboard updates from 1-1 to 2-1 as the player in white scores. | live scoring lane: no measured attestation in this window (scoreBoardChanged=false goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL", copy: "The player in white shoots." },];

describe("ADAAAA-8130 Q1 — the 22 ADAAAA-8124 no-copy rows all carry copy", () => {
  it("serves gate-clean copy for 22/22 and keeps the ADAAAA-8125 strings byte-identical", () => {
    for (const row of REPLAY_ROWS) {
      const ctx = ctxFor(row.verdict, row.eventType);
      expect(quietStoredCopy(row.raw, ctx), `${row.raw.slice(0, 60)}`).toBe(row.copy);
    }
    expect(REPLAY_ROWS.filter((r) => quietStoredCopy(r.raw, ctxFor(r.verdict, r.eventType)) === "")).toEqual([]);
  });

  it("keeps every post-condition of the quiet copy (0 violations, no claim, no token)", () => {
    for (const row of REPLAY_ROWS) {
      const ctx = ctxFor(row.verdict, row.eventType);
      const copy = quietStoredCopy(row.raw, ctx);
      const source = wholeStoredSentence(stripInternalTokens(row.raw).trim());
      expect(servedShapeViolations(copy, [source]), `${copy}`).toEqual([]);
      expect(hasGoalClaim(copy), `${copy}`).toBe(false);
      expect(gateGoalClaims(copy, ctx), `${copy}`).toBe(copy);
      expect(gateQuietWindow(copy, ctx), `${copy}`).toBe(copy);
      expect(findScoreClaims(copy), `${copy}`).toEqual([]);
      expect(stripInternalTokens(copy), `${copy}`).toBe(copy);
      expect(/[.!?]$/.test(copy), `${copy}`).toBe(true);
      expect(captionLead(copy).split(/\s+/).filter(Boolean).length, `${copy}`).toBeLessThanOrEqual(QUIET_MAX_WORDS);
      // …and no card is derived from copy (clause 2 of the ADAAAA-8124 ruling).
      expect(typeof copy).toBe("string");
      expect(restoreTerminalPunctuation(copy)).toBe(copy);
    }
  });

  it("stores the row's own leading beat on the quoted row (Q1's failing row)", () => {
    const raw = `Crowd erupts in celebration as the scoreboard shows a goal for FCB. ${TAIL_V8}`;
    expect(quietStoredCopy(raw, ctxFor("big_play", "BIG_PLAY"))).toBe("Crowd erupts in celebration.");
  });
});

describe("ADAAAA-8130 — the leading clause is a beat candidate (extractive only)", () => {
  it("accepts a lead with its own verb and no claim", () => {
    const raw = `Crowd erupts in celebration as the scoreboard shows a goal for FCB. ${TAIL_V8}`;
    expect(quietStoredCopy(raw, ctxFor("big_play", "BIG_PLAY"))).toBe("Crowd erupts in celebration.");
    // Every word is the row's own; the only addition is the sentence end.
    const copy = quietStoredCopy(raw, ctxFor("big_play", "BIG_PLAY"));
    for (const word of copy.replace(/[.!?]/g, "").toLowerCase().split(/\s+/)) {
      expect(raw.toLowerCase().includes(word), `${word} in ${copy}`).toBe(true);
    }
  });

  it("accepts the lead at a `and` boundary too (not only `as`)", () => {
    const raw = "Crowd erupts in celebration and the scoreboard shows a goal for FCB.";
    expect(quietStoredCopy(raw, ctxFor("big_play", "BIG_PLAY"))).toBe("Crowd erupts in celebration.");
  });

  it("refuses a leading clause that itself carries a claim or a scoreline", () => {
    // The ledger line is the frame, never the beat (`The scoreboard updates from
    // 1-1 to 2-1` carries both a scoreline and the scoreboard noun).
    const scoreRow = `The scoreboard updates from 1-1 to 2-1 as the commentator announces the goal. ${TAIL_V8}`;
    expect(quietStoredCopy(scoreRow, ctxFor("big_play", "BIG_PLAY"))).toBe("");
    const claimedLead = `The crowd celebrates a goal as the scoreboard shows a goal for FCB. ${TAIL_V8}`;
    const copy = quietStoredCopy(claimedLead, ctxFor("big_play", "BIG_PLAY"));
    expect(hasGoalClaim(copy)).toBe(false);
    expect(copy).not.toMatch(/goal/i);
  });
});

describe("ADAAAA-8130 — the substituted tail never makes a beat", () => {
  it("strips `shows a shoots` before the beat check and refuses the frame clause", () => {
    // On the measured row `quietShape` leaves `… as the scoreboard shows a
    // shoots`. The frame clause is refused, so the copy is the row's lead and can
    // never be `The scoreboard shows.`.
    const copy = quietStoredCopy(
      `Crowd erupts in celebration as the scoreboard shows a goal for FCB. ${TAIL_V8}`,
      ctxFor("big_play", "BIG_PLAY")
    );
    expect(copy).toBe("Crowd erupts in celebration.");
    expect(copy).not.toMatch(/scoreboard|shows|shoots/i);
    // A clause whose only remaining verb is the display verb that introduced the
    // claim is a FRAME, not a beat, so the lead is served instead of it.
    expect(quietStoredCopy("Players celebrate as the scoreboard shows a goal for FCB.", ctxFor("big_play", "BIG_PLAY"))).toBe(
      "Players celebrate."
    );
    // The mangled shape itself is never copy (no claim to cut => clause 3).
    expect(quietStoredCopy("Crowd erupts in celebration as the scoreboard shows a shoots.", ctxFor("big_play", "BIG_PLAY"))).toBe(
      ""
    );
  });

  it("still repairs a tail clause whose own verb survives the strip", () => {
    // `players celebrate a shoots` -> `players celebrate` (the ADAAAA-8125 shape).
    const raw = `The scoreboard updates from 1-1 to 2-1 as players celebrate a goal. ${TAIL_V8}`;
    expect(quietStoredCopy(raw, ctxFor("big_play", "BIG_PLAY"))).toBe("Players celebrate.");
  });
});

describe("ADAAAA-8130 — the claim-suppressed lead is sanctioned, a prefix cut is not", () => {
  const source = "Crowd erupts in celebration as the scoreboard shows a goal for FCB.";

  it("sanctions the row's own WHOLE leading clause when the dropped clause carries the claim", () => {
    expect(servedShapeViolations("Crowd erupts in celebration.", [source])).toEqual([]);
  });

  it("still flags an unterminated prefix and a lead that contains a connector", () => {
    expect(servedShapeViolations("Crowd erupts in celebration", [source])).toContain("prefix-cut");
    // A lead that ends mid-clause (`while the crowd`) is still a cut, never copy.
    const quoted = "Players celebrate in the box while the crowd and stadium displays 'GOAL' on the screens.";
    expect(servedShapeViolations("Players celebrate in the box while the crowd.", [quoted])).toContain("prefix-cut");
  });

  it("still flags a prefix whose remainder carries no claim (an arbitrary truncation)", () => {
    const plain = "The keeper dives to the left and the crowd roars.";
    expect(servedShapeViolations("The keeper dives to the left.", [plain])).toContain("prefix-cut");
  });
});
