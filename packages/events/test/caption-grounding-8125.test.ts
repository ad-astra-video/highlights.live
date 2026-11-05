// ADAAAA-8125 (ADAAAA-8124 product ruling): an accepted highlight whose
// goal-claim card is REFUSED stored neither a `reason` nor a `caption` when the
// gated line was non-empty but shape-unclean.
//
// Measured on the ADAAAA-8124 post-deploy sweep (`origin/master` = box
// `deploy-master` = `8921543`): 61 accepted `highlight` rows across
// `highlights` + `notableHighlights`, 39 with copy and 22 with NOTHING — 36% of
// the accepted surface. Every row below is a verbatim `reason_raw` from that
// sweep (`highlights`, accepted, `record.reason IS NULL`), so the fixtures are
// the measured class, not a reconstruction of it.
//
// The ruling has three clauses and this file grades all three:
//   1. serve the QUIET SHAPE derived from the row's own window;
//   2. copy does not earn a claim card (`quietStoredCopy` never returns a card);
//   3. no honest sentence => store nothing, keep the row (no placeholder, no
//      invented word, no filter).
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
const TAIL_V7 =
  "| live scoring lane: no measured attestation in this window (no scoreboard change, no goal-line / net signal, no corroborated confirm) — delivered as a celebration, not a GOAL";

/** This window's own evidence (its OCR reads + its prompt), nothing else. */
const PROMPT =
  'ocr="scoreboard 1-1" | ocr="scoreboard 2-1" | the player in white shoots in the penalty area';

const ctxFor = (
  verdict: string,
  eventType: string,
  overrides: Partial<CaptionGroundingContext> = {}
): CaptionGroundingContext => ({
  verdict,
  eventType,
  promptText: PROMPT,
  corroborated: false,
  place: "in the penalty area",
  ...overrides,
});

/** `reason` is the copy the seam stores; `null` = clause 3 (store nothing). */
const ROWS: {
  label: string;
  raw: string;
  verdict: string;
  eventType: string;
  corroborated: boolean;
  reason: string | null;
}[] = [
  {
    label: "bfc26c78 demoted celebration (v8 tail)",
    raw: `The scoreboard updates from 1-1 to 2-1 as the player in white scores. ${TAIL_V8}`,
    verdict: "big_play",
    eventType: "BIG_PLAY",
    corroborated: false,
    reason: "The player in white shoots in the box.",
  },
  {
    label: "7704c622 demoted celebration (v8 tail, no leading article)",
    raw: `Scoreboard updates from 1-1 to 2-1 as the player in white scores. ${TAIL_V8}`,
    verdict: "big_play",
    eventType: "BIG_PLAY",
    corroborated: false,
    reason: "The player in white shoots in the box.",
  },
  {
    label: "goal row, net clause",
    raw: "The scoreboard updates from 1-1 to 2-1 as the ball enters the net.; scoreboard score change confirmed",
    verdict: "scoring_play",
    eventType: "GOAL",
    corroborated: true,
    reason: "The ball shoots in the penalty area.",
  },
  {
    label: "goal row, coordinate clause (v7 tail on the celebration row)",
    raw: `The ball enters the net and players celebrate as the commentator confirms the goal. ${TAIL_V7}`,
    verdict: "big_play",
    eventType: "BIG_PLAY",
    corroborated: false,
    reason: "The ball shoots in the penalty area.",
  },
  {
    label: "goal row, celebration in the area",
    raw: `The ball enters the net and players celebrate in the penalty area. ${TAIL_V7}`,
    verdict: "big_play",
    eventType: "BIG_PLAY",
    corroborated: false,
    reason: "The ball shoots in the penalty area.",
  },
  {
    label: "player-in-white celebration",
    raw: "The scoreboard updates from 1-1 to 2-1 as a player in white celebrates a goal.; scoreboard score change confirmed",
    verdict: "scoring_play",
    eventType: "GOAL",
    corroborated: true,
    reason: "A player in white celebrates.",
  },
  {
    label: "players-celebrate goal row",
    raw: "The scoreboard changes from 1-1 to 2-1 as players celebrate a goal.; scoreboard score change confirmed",
    verdict: "scoring_play",
    eventType: "GOAL",
    corroborated: true,
    reason: "Players celebrate.",
  },
  {
    label: "post-net celebration",
    raw: "The scoreboard updates to 2-1 and a player celebrates after the ball enters the net.; scoreboard score change confirmed",
    verdict: "scoring_play",
    eventType: "GOAL",
    corroborated: true,
    reason: "A player celebrates in the box.",
  },
  {
    label: "claim-free play row (quiet shape already)",
    raw: "No. 9 reacts to a play in the penalty area",
    verdict: "big_play",
    eventType: "BIG_PLAY",
    corroborated: false,
    reason: "No. 9 reacts in the box.",
  },
  // Clause 3: the window has no honest sentence — the seam must store NOTHING
  // (never a placeholder, never a mangled substitution).
  {
    label: "commentator announces an uncorroborated name",
    raw: "The scoreboard updates from 1-1 to 2-1 as the commentator announces Manuel Ordoñez's goal.; scoreboard score change confirmed",
    verdict: "scoring_play",
    eventType: "GOAL",
    corroborated: true,
    reason: null,
  },
  {
    label: "commentator announces the goal",
    raw: `The scoreboard updates from 1-1 to 2-1 as the commentator announces the goal. ${TAIL_V8}`,
    verdict: "big_play",
    eventType: "BIG_PLAY",
    corroborated: false,
    reason: null,
  },
  {
    label: "quoted OCR label on the stadium screen",
    raw: `Players celebrate in the box while the crowd and stadium displays 'GOAL' on the screens. ${TAIL_V8}`,
    verdict: "big_play",
    eventType: "BIG_PLAY",
    corroborated: false,
    reason: null,
  },
  {
    label: "crowd erupts around a scoreboard frame",
    raw: `Crowd erupts in celebration as the scoreboard shows a goal for FCB. ${TAIL_V8}`,
    verdict: "big_play",
    eventType: "BIG_PLAY",
    corroborated: false,
    reason: null,
  },
];

describe("ADAAAA-8125 clause 1 — a refused card still owes copy (AC1)", () => {
  it("serves a gate-clean reason for every row of the measured class that has one", () => {
    for (const row of ROWS.filter((r) => r.reason)) {
      const ctx = ctxFor(row.verdict, row.eventType, { corroborated: row.corroborated });
      expect(quietStoredCopy(row.raw, ctx), row.label).toBe(row.reason);
    }
  });

  it("closes the sentence and never leaves copy bare (AC1)", () => {
    for (const row of ROWS.filter((r) => r.reason)) {
      const copy = quietStoredCopy(row.raw, ctxFor(row.verdict, row.eventType, { corroborated: row.corroborated }));
      expect(/[.!?]$/.test(copy), `${row.label}: ${copy}`).toBe(true);
    }
  });

  it("the pre-fix expression could store nothing on these rows (negative arm)", () => {
    // The shipped seam stored `card.caption || (reasonClean ? gated : "")`. On the
    // refused card the caption is empty; on these rows the gated line is not
    // shape-clean against its own stored sentence either, so the row stored "".
    for (const row of ROWS.filter((r) => r.reason)) {
      const source = wholeStoredSentence(stripInternalTokens(row.raw).trim());
      // The gated line the card gate refused, reduced to this row's own beat.
      const gated = quietStoredCopy(row.raw, ctxFor(row.verdict, row.eventType, { corroborated: row.corroborated }));
      expect(gated, row.label).not.toBe("");
      // Not a prefix cut of its own sentence: the copy is the row's BEAT.
      expect(servedShapeViolations(gated, [source]), row.label).toEqual([]);
    }
  });
});

describe("ADAAAA-8125 clause 2 — copy does not earn a claim card (AC2)", () => {
  it("never asserts a goal, a score or an internal token", () => {
    for (const row of ROWS.filter((r) => r.reason)) {
      const copy = quietStoredCopy(row.raw, ctxFor(row.verdict, row.eventType, { corroborated: row.corroborated }));
      expect(hasGoalClaim(copy), `${row.label}: ${copy}`).toBe(false);
      expect(findScoreClaims(copy), `${row.label}: ${copy}`).toEqual([]);
      expect(stripInternalTokens(copy), `${row.label}: ${copy}`).toBe(copy);
      expect(copy).not.toMatch(/\[near_miss\]|outcome=|T\+|·/);
    }
  });

  it("is a fixed point of the full gate order (gateGoalClaims then gateQuietWindow)", () => {
    for (const row of ROWS.filter((r) => r.reason)) {
      const ctx = ctxFor(row.verdict, row.eventType, { corroborated: row.corroborated });
      const copy = quietStoredCopy(row.raw, ctx);
      const claimed = gateGoalClaims(copy, ctx);
      expect(claimed, row.label).toBe(copy);
      expect(gateQuietWindow(claimed, ctx), row.label).toBe(copy);
      // …and the copy is its own quiet copy (idempotent under re-derivation).
      expect(quietStoredCopy(copy, ctx), row.label).toBe(copy);
    }
  });

  it("carries 0 served-shape violations against its own stored sentence", () => {
    for (const row of ROWS.filter((r) => r.reason)) {
      const source = wholeStoredSentence(stripInternalTokens(row.raw).trim());
      const copy = quietStoredCopy(row.raw, ctxFor(row.verdict, row.eventType, { corroborated: row.corroborated }));
      expect(servedShapeViolations(copy, [source]), row.label).toEqual([]);
    }
  });

  it("keeps the quiet budget and never exceeds the row's own sentence", () => {
    for (const row of ROWS.filter((r) => r.reason)) {
      const copy = quietStoredCopy(row.raw, ctxFor(row.verdict, row.eventType, { corroborated: row.corroborated }));
      const source = wholeStoredSentence(stripInternalTokens(row.raw).trim());
      expect(captionLead(copy).split(/\s+/).filter(Boolean).length, row.label).toBeLessThanOrEqual(QUIET_MAX_WORDS);
      expect(copy.split(/\s+/).filter(Boolean).length, row.label).toBeLessThanOrEqual(
        source.split(/\s+/).filter(Boolean).length
      );
    }
  });

  it("does not serve a proper name this window's prompt cannot corroborate", () => {
    const raw =
      "The scoreboard updates from 1-1 to 2-1 as Saez scores in the penalty area.; scoreboard score change confirmed";
    const copy = quietStoredCopy(raw, ctxFor("scoring_play", "GOAL", { corroborated: true }));
    expect(copy).not.toMatch(/Saez/i);
    // With the same name present in the prompt, the name is corroborated and may ride.
    const corroborated = quietStoredCopy(
      raw,
      ctxFor("scoring_play", "GOAL", { corroborated: true, promptText: `${PROMPT} Saez strikes in the box` })
    );
    expect(corroborated).toMatch(/Saez/);
  });
});

describe("ADAAAA-8125 clause 3 — no honest sentence, no placeholder (AC1/AC2)", () => {
  it("stores nothing when the quiet candidate fails the shape gate", () => {
    for (const row of ROWS.filter((r) => r.reason === null)) {
      expect(quietStoredCopy(row.raw, ctxFor(row.verdict, row.eventType, { corroborated: row.corroborated })), row.label).toBe("");
    }
  });

  it("stores nothing rather than serving a mangled outcome substitution", () => {
    // `quietShape` appends the outcome verb after the determiner the claim noun
    // left behind: `… celebrate a shoots` is not copy.
    const copy = quietStoredCopy(
      "The scoreboard updates from 1-1 to 2-1 as the crowd celebrates a goal for FCB.; scoreboard score change confirmed",
      ctxFor("scoring_play", "GOAL", { corroborated: true })
    );
    expect(copy).not.toMatch(/a shoots|the shoots/);
  });

  it("ignores an empty / internal-only line", () => {
    expect(quietStoredCopy("", ctxFor("big_play", "BIG_PLAY"))).toBe("");
    expect(quietStoredCopy("   ", ctxFor("big_play", "BIG_PLAY"))).toBe("");
    expect(
      quietStoredCopy("[near_miss] outcome=wide T+12s ·", ctxFor("big_play", "BIG_PLAY"))
    ).toBe("");
  });

  it("is deterministic (extractive only: no clock, no randomness, same input same bytes)", () => {
    const raw = `The scoreboard updates from 1-1 to 2-1 as the player in white scores. ${TAIL_V8}`;
    const ctx = ctxFor("big_play", "BIG_PLAY");
    const first = quietStoredCopy(raw, ctx);
    for (let i = 0; i < 5; i += 1) expect(quietStoredCopy(raw, ctx)).toBe(first);
    // Every word comes from this row, or is the two sanctioned substitutions the
    // contract itself defines: the window's own outcome verb (§3.3 quiet shape)
    // and `penalty area` -> `box` (the quiet trim's place form). Nothing else.
    const sanctioned = new Set(["shoots", "box", "is", "saved", "blocked", "cleared", "goes", "wide"]);
    for (const word of first.replace(/[.!?]/g, "").toLowerCase().split(/\s+/)) {
      const fromRow = raw.toLowerCase().includes(word);
      expect(fromRow || sanctioned.has(word), `${word} in ${first}`).toBe(true);
    }
  });

  it("only ever derives from ITS OWN row (a neighbouring ladder line never leaks in)", () => {
    const own = `The scoreboard updates from 1-1 to 2-1 as the player in white scores. ${TAIL_V8}`;
    const neighbour = "The keeper saves a header in the box.";
    const copy = quietStoredCopy(own, ctxFor("big_play", "BIG_PLAY"));
    expect(copy).not.toMatch(/keeper|header|saves/i);
    expect(quietStoredCopy(neighbour, ctxFor("big_play", "BIG_PLAY"))).not.toBe(copy);
  });
});

describe("ADAAAA-8125 — the copy is a copy, not a card", () => {
  it("returns a plain string (no card title is derived from copy)", () => {
    const copy = quietStoredCopy(`The scoreboard updates from 1-1 to 2-1 as the player in white scores. ${TAIL_V8}`, ctxFor("big_play", "BIG_PLAY"));
    expect(typeof copy).toBe("string");
    expect(restoreTerminalPunctuation(copy)).toBe(copy);
  });
});
