// ADAAAA-8027 (§2, card clause) — the STORE-TIME post-condition over the 12
// stored card rows graded by ADAAAA-8026 on build `2f364aa`.
//
// Two distinct defects shipped on that build:
//
//   1. `gateGoalClaims` re-attached the zone with `${out} ${place}`, so after the
//      claim rewrite (`reflect a goal` -> `reflect a shot`, whose noun `shot`
//      passes `PLAY_VERB`) the place was glued AFTER the sentence period:
//      `The scoreboard updates to reflect a shot. on the left — …` (rows
//      24177d4e, 1fb8388b). Fixed by moving the lead's terminal punctuation to
//      the end of the line first (the `ensureLeadPlace` shape).
//   2. A caption card never crossed `servedShapeViolations`, so a verbless gated
//      line was stored as a card while its stored raw sentence carried a verb
//      (`Shot in midfield` / `Shot on the right` for `The ball enters the net and
//      the keeper is beaten …`, 7 rows). Fixed by `storedCardSurface`: the gated
//      caption is tested with the stored raw sentence as its source, a refused
//      caption falls back to the WHOLE re-gated first sentence of the raw line,
//      and a row that still violates stores NO card.
//
// The rows below are the byte-exact stored rows (`highlights.record`) of jobs
// 34f9f2d1-dba7-4c39-97c1-eaec9e9066fc (9) and
// 228462b5-04c5-44ed-a4e1-d2b47a475679 (3), replayed with the write-time-faithful
// context ADAAAA-8026 arm C used (`promptText: null`, `corroborated: false`).
import { describe, it, expect } from "vitest";
import {
  captionForStoredLine,
  cardTitlesFor,
  CARD_TITLE_MAX_CHARS,
  captionLead,
  gateGoalClaims,
  groundCaption,
  isQuietVerdict,
  regateServedSentence,
  placePhraseOf,
  QUIET_MAX_WORDS,
  servedShapeViolations,
  storedCardSurface,
  wholeFirstSentence,
} from "@highlights/events";
import type { CaptionGroundingContext, ColourSignal } from "@highlights/events";

interface StoredCardRow {
  id: string;
  jobId: string;
  eventType: string;
  outcome: string;
  reason: string;
  reason_raw: string;
  caption: string | null;
  colour?: Record<string, unknown> | null;
}

const ROWS: StoredCardRow[] = [
  {
    "id": "25929400-9bed-42c9-97bb-f4399d0f56df",
    "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc",
    "eventType": "BIG_PLAY",
    "outcome": "big_play",
    "reason": "Shot in midfield",
    "reason_raw": "The ball enters the net and the scoreboard updates to 2-1, followed by player celebrations. | live scoring lane: no measured attestation in this window (no scoreboard change, no goal-line / net signal, no corroborated confirm) \u2014 delivered as a celebration, not a GOAL",
    "caption": "Shot in midfield",
    "cardTitles": [
      "Shot in midfield",
      "big play: Shot in midfield",
      "big play"
    ],
    "colour": null
  },
  {
    "id": "86d3b413-e558-4705-a4a1-d42de9e8b8dd",
    "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc",
    "eventType": "BIG_PLAY",
    "outcome": "big_play",
    "reason": "Shot in midfield",
    "reason_raw": "The ball enters the net and the keeper is beaten as players celebrate. | live scoring lane: no measured attestation in this window (no scoreboard change, no goal-line / net signal, no corroborated confirm) \u2014 delivered as a celebration, not a GOAL",
    "caption": "Shot in midfield",
    "cardTitles": [
      "Shot in midfield",
      "big play: Shot in midfield",
      "big play"
    ],
    "colour": null
  },
  {
    "id": "6db8f964-8e0b-4173-8694-ec20b3d69af6",
    "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc",
    "eventType": "BIG_PLAY",
    "outcome": "big_play",
    "reason": "Shot in midfield",
    "reason_raw": "The ball enters the net and the player in white celebrates while the keeper falls. | live scoring lane: no measured attestation in this window (no scoreboard change, no goal-line / net signal, no corroborated confirm) \u2014 delivered as a celebration, not a GOAL",
    "caption": "Shot in midfield",
    "cardTitles": [
      "Shot in midfield",
      "big play: Shot in midfield",
      "big play"
    ],
    "colour": null
  },
  {
    "id": "24177d4e-df64-4c20-a3da-68451d695c00",
    "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc",
    "eventType": "GOAL",
    "outcome": "scoring_play",
    "reason": "The scoreboard updates to reflect a shot. on the left \u2014 noise spikes over the play",
    "reason_raw": "The ball enters the net and the scoreboard updates to reflect a goal.; scoreboard score change confirmed",
    "caption": "The scoreboard updates to reflect a shot. on the left \u2014 noise spikes over the play",
    "cardTitles": [
      "The scoreboard updates to reflect a shot. on the left \u2014 noise spikes over the play",
      "goal: The scoreboard updates to reflect a shot. on the left \u2014 noise spikes over the play",
      "goal"
    ],
    "colour": {
      "signal": "audio_noise",
      "ratio": 13.60887505918961,
      "sustained": 0.23529411764705882,
      "peak": 0.20118,
      "peakT": 319.3,
      "frameTs": 318,
      "frameSeq": 1590
    }
  },
  {
    "id": "3bf5f473-bf99-412d-a886-13996e5395b9",
    "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc",
    "eventType": "GOAL",
    "outcome": "scoring_play",
    "reason": "The scoreboard updates.",
    "reason_raw": "The ball enters the net and the scoreboard updates from 1-1 to 2-1.",
    "caption": "The scoreboard updates.",
    "cardTitles": [
      "The scoreboard updates.",
      "goal: The scoreboard updates.",
      "goal"
    ],
    "colour": null
  },
  {
    "id": "dd802ee6-85ac-4052-a2f7-54850d4d8dc5",
    "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc",
    "eventType": "BIG_PLAY",
    "outcome": "big_play",
    "reason": "Shot on the right",
    "reason_raw": "The ball enters the net and the keeper is beaten as players celebrate. | live scoring lane: no measured attestation in this window (no scoreboard change, no goal-line / net signal, no corroborated confirm) \u2014 delivered as a celebration, not a GOAL",
    "caption": "Shot on the right",
    "cardTitles": [
      "Shot on the right",
      "big play: Shot on the right",
      "big play"
    ],
    "colour": null
  },
  {
    "id": "0ffd56d3-b0af-4d27-9beb-cdcc7db5f901",
    "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc",
    "eventType": "BIG_PLAY",
    "outcome": "big_play",
    "reason": "Shot in midfield",
    "reason_raw": "The ball enters the net and the keeper is beaten as the crowd reacts. | live scoring lane: no measured attestation in this window (no scoreboard change, no goal-line / net signal, no corroborated confirm) \u2014 delivered as a celebration, not a GOAL",
    "caption": "Shot in midfield",
    "cardTitles": [
      "Shot in midfield",
      "big play: Shot in midfield",
      "big play"
    ],
    "colour": null
  },
  {
    "id": "1fb8388b-48c0-4008-8a79-1c7d302150aa",
    "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc",
    "eventType": "GOAL",
    "outcome": "scoring_play",
    "reason": "The scoreboard updates to reflect a shot. on the right \u2014 noise spikes over the play",
    "reason_raw": "The ball enters the net and the scoreboard updates to reflect a goal.; scoreboard score change confirmed",
    "caption": "The scoreboard updates to reflect a shot. on the right \u2014 noise spikes over the play",
    "cardTitles": [
      "The scoreboard updates to reflect a shot. on the right \u2014 noise spikes over the play",
      "goal: The scoreboard updates to reflect a shot. on the right \u2014 noise spikes over the play",
      "goal"
    ],
    "colour": {
      "signal": "audio_noise",
      "ratio": 14.059380616618279,
      "sustained": 0.23529411764705882,
      "peak": 0.203383,
      "peakT": 618.4,
      "frameTs": 618,
      "frameSeq": 3090
    }
  },
  {
    "id": "e632fa24-c881-4128-b953-b4e6cef4e7fc",
    "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc",
    "eventType": "BIG_PLAY",
    "outcome": "big_play",
    "reason": "Shot in midfield",
    "reason_raw": "The ball enters the net and the scoreboard updates from 1-1 to 2-1. | live scoring lane: no measured attestation in this window (no scoreboard change, no goal-line / net signal, no corroborated confirm) \u2014 delivered as a celebration, not a GOAL",
    "caption": "Shot in midfield",
    "cardTitles": [
      "Shot in midfield",
      "big play: Shot in midfield",
      "big play"
    ],
    "colour": null
  },
  {
    "id": "ac372486-9e0a-4df7-ab95-4c677886ff74",
    "jobId": "228462b5-04c5-44ed-a4e1-d2b47a475679",
    "eventType": "GOAL",
    "outcome": "scoring_play",
    "reason": "The scoreboard updates, followed by player celebrations.",
    "reason_raw": "The ball enters the net and the scoreboard updates to 2-1, followed by player celebrations.",
    "caption": "The scoreboard updates, followed by player celebrations.",
    "cardTitles": [
      "The scoreboard updates, followed by player celebrations.",
      "goal: The scoreboard updates, followed by player celebrations.",
      "goal"
    ],
    "colour": null
  },
  {
    "id": "a653865a-6960-404f-a412-c83d8f1e2214",
    "jobId": "228462b5-04c5-44ed-a4e1-d2b47a475679",
    "eventType": "GOAL",
    "outcome": "scoring_play",
    "reason": "The scoreboard updates.",
    "reason_raw": "The ball enters the net and the scoreboard updates to 2-2.",
    "caption": "The scoreboard updates.",
    "cardTitles": [
      "The scoreboard updates.",
      "goal: The scoreboard updates.",
      "goal"
    ],
    "colour": null
  },
  {
    "id": "38500d88-10ee-4401-9eb7-f95bff40908e",
    "jobId": "228462b5-04c5-44ed-a4e1-d2b47a475679",
    "eventType": "BIG_PLAY",
    "outcome": "big_play",
    "reason": "Shot on the right",
    "reason_raw": "The ball enters the net and the goalkeeper is beaten. | live scoring lane: no measured attestation in this window (no scoreboard change, no goal-line / net signal, no corroborated confirm) \u2014 delivered as a celebration, not a GOAL",
    "caption": "Shot on the right",
    "cardTitles": [
      "Shot on the right",
      "big play: Shot on the right",
      "big play"
    ],
    "colour": null
  }
];

/** The write-time context ADAAAA-8026 arm C reconstructed from each stored row. */
function writeTimeCtx(row: StoredCardRow): CaptionGroundingContext {
  return {
    verdict: row.outcome,
    colourSignal: (row.colour ?? null) as ColourSignal | null,
    place: placePhraseOf(row.reason ?? "") || "",
    promptText: null,
    corroborated: false,
  };
}

function derive(row: StoredCardRow) {
  const ctx = writeTimeCtx(row);
  const gated = groundCaption(row.reason_raw, ctx);
  const sources = [
    captionLead(wholeFirstSentence(row.reason)),
    captionLead(wholeFirstSentence(row.reason_raw)),
  ].filter(Boolean);
  const card = storedCardSurface({
    gated,
    raw: row.reason_raw,
    label: row.outcome,
    quiet: isQuietVerdict(row.outcome),
    regate: (sentence: string) => regateServedSentence(sentence, ctx),
  });
  return { ctx, gated, sources, card };
}

const tokens = (text: string) => text.split(/\s+/).filter(Boolean).length;
const byId = (id: string) => {
  const row = ROWS.find((r) => r.id.startsWith(id));
  if (!row) throw new Error(`no stored row ${id}`);
  return row;
};

/** The two rows whose card carried an internal sentence break on `2f364aa`. */
const BREAK_ROWS = ["24177d4e", "1fb8388b"];
/** The seven rows whose card carried no verb while the stored raw sentence did. */
const VERBLESS_ROWS = ["25929400", "86d3b413", "6db8f964", "dd802ee6", "0ffd56d3", "e632fa24", "38500d88"];

describe("ADAAAA-8027 §2 — every stored card row is whole (AC1)", () => {
  it("covers the 12 stored rows graded by ADAAAA-8026", () => {
    expect(ROWS).toHaveLength(12);
    expect(new Set(ROWS.map((r) => r.id.slice(0, 8))).size).toBe(12);
  });

  it("stores a card for every row and passes the §2 test on that exact string", () => {
    for (const row of ROWS) {
      const { sources, card } = derive(row);
      expect(card.caption, row.id).not.toBe("");
      expect(card.violations, row.id).toEqual([]);
      expect(servedShapeViolations(card.caption, sources), row.id).toEqual([]);
      // Every card option derives from the accepted caption, byte-for-byte.
      expect(card.cardTitles[0], row.id).toBe(card.caption);
    }
  });

  it("measures 0 on each of the five AC1 bars across the 12 rows", () => {
    const counts = { functionTail: 0, prefixCut: 0, internalBreak: 0, verbless: 0, quietOverBudget: 0 };
    for (const row of ROWS) {
      const { sources, card } = derive(row);
      const violations = servedShapeViolations(card.caption, sources);
      if (violations.includes("function-tail")) counts.functionTail += 1;
      if (violations.includes("prefix-cut")) counts.prefixCut += 1;
      if (violations.includes("verbless")) counts.verbless += 1;
      if (/[.!?…]["'”’)\]]*\s+\p{Ll}/u.test(card.caption)) counts.internalBreak += 1;
      if (row.outcome === "not_highlight" && tokens(card.caption) > QUIET_MAX_WORDS) counts.quietOverBudget += 1;
    }
    expect(counts).toEqual({ functionTail: 0, prefixCut: 0, internalBreak: 0, verbless: 0, quietOverBudget: 0 });
    // No stored card row in this job set is a quiet row, so the budget bar is 0
    // by construction here and is proved on a synthetic quiet row below.
    expect(ROWS.some((r) => r.outcome === "not_highlight")).toBe(false);
  });

  it("re-emits the two internal-break rows with the zone INSIDE the sentence", () => {
    const left = derive(byId("24177d4e"));
    const right = derive(byId("1fb8388b"));
    expect(left.gated).toBe("The scoreboard updates to reflect a shot on the left — noise spikes over the play");
    expect(right.gated).toBe("The scoreboard updates to reflect a shot on the right — noise spikes over the play");
    for (const s of [left, right]) {
      expect(s.card.caption).toBe(s.gated);
      expect(s.card.caption).not.toMatch(/[.!?…]["'”’)\]]*\s+\p{Ll}/u);
    }
    // The pre-fix strings are unreachable through the fixed writer.
    expect(left.card.caption).not.toBe(left.gated.replace("a shot on the left", "a shot. on the left"));
    expect(left.card.caption).not.toContain("shot. on the");
  });

  it("gives the seven verbless rows a card that carries the raw sentence's predicate", () => {
    for (const id of VERBLESS_ROWS) {
      const row = byId(id);
      const { sources, card } = derive(row);
      expect(card.caption, id).not.toBe(row.caption);
      expect(card.caption, id).not.toMatch(/^shot\b/i);
      expect(servedShapeViolations(card.caption, sources), id).not.toContain("verbless");
      // Whole sentence, not a cut: the raw sentence is the fallback source.
      expect(tokens(card.caption), id).toBeGreaterThan(3);
    }
    // Byte-exact for the row the offline proof pins.
    expect(derive(byId("25929400")).card.caption).toBe(
      "The scoreboard updates to 2-1, followed by player celebrations."
    );
  });

  it("keeps a synthetic quiet row inside the 8-token budget", () => {
    const row: StoredCardRow = {
      id: "quiet-1",
      jobId: "job",
      eventType: "BIG_PLAY",
      outcome: "not_highlight",
      reason: "A player dribbles in the midfield.",
      reason_raw: "A player in a blue kit dribbles in the midfield.",
      caption: null,
      colour: null,
    };
    const { card } = derive(row);
    expect(card.caption).not.toBe("");
    expect(tokens(card.caption)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
  });
});

describe("ADAAAA-8027 §2 — negative arm: the pre-fix writer still reproduces both shapes", () => {
  // Frozen copy of the `2f364aa` re-attach at caption-grounding.ts L995-998: the
  // place is glued AFTER the lead, so the lead's sentence period stays inside.
  const preFixAttach = (lead: string, place: string) => `${lead} ${place}`.replace(/\s+/g, " ").trim();

  it("reproduces `The scoreboard updates to reflect a shot. on the left`", () => {
    // The claim rewrite leaves this lead; `PLAY_VERB` takes `shot` as its noun.
    const broken = preFixAttach("The scoreboard updates to reflect a shot.", "on the left");
    expect(broken).toBe("The scoreboard updates to reflect a shot. on the left");
    // …and the new rule refuses exactly that shape.
    expect(servedShapeViolations(broken, [])).toContain("internal-break");
  });

  it("reproduces the stored pre-fix rows, which the new rules refuse", () => {
    for (const id of BREAK_ROWS) {
      const row = byId(id);
      expect(servedShapeViolations(row.caption ?? row.reason, []), id).toContain("internal-break");
      expect(derive(row).card.caption, id).not.toBe(row.caption);
    }
    for (const id of VERBLESS_ROWS) {
      const row = byId(id);
      // The stored card is the verbless shape the deployed writer shipped.
      expect(captionForStoredLine(row.reason), id).toBe(row.caption);
      expect(servedShapeViolations(row.caption ?? row.reason, [row.reason_raw]), id).toContain("verbless");
      expect(derive(row).card.caption, id).not.toBe(row.caption);
    }
  });
});

describe("ADAAAA-8027 §3 — card options derive from the accepted caption", () => {
  it("serves the stored string WHOLE — never a boundary cut (ADAAAA-8053 v8 §3b.1)", () => {
    const long = `${"No. 3 drives into the box and shoots in the penalty area. ".repeat(3)}`.trim();
    expect(long.length).toBeGreaterThan(CARD_TITLE_MAX_CHARS);
    const titles = cardTitlesFor(long);
    // A cut at a sentence boundary is still a PREFIX of the stored string, and
    // AC10 requires every served option to be byte-identical to a gated stored
    // string. So the option is the whole stored caption, long or not.
    expect(titles).toEqual([long]);
  });

  it("never serves a bare label or a `<type>: ` prefix as an option", () => {
    const noBoundary = "x".repeat(CARD_TITLE_MAX_CHARS + 20);
    // No sentence to serve -> no option. `Shot` alone is a taxonomy token, and
    // `Shot: …` is a variant minted at render time, not a stored string.
    expect(cardTitlesFor(noBoundary)).toEqual([]);
    for (const title of cardTitlesFor("No. 3 shoots in midfield.", ["Shot", "Shot: No. 3 shoots in midfield."])) {
      expect(title).not.toMatch(/^shot\b/i);
    }
  });

  it("never glues a place after a sentence period (the gate itself)", () => {
    const ctx = writeTimeCtx(byId("24177d4e"));
    const out = gateGoalClaims("The ball enters the net and the scoreboard updates to reflect a goal.", ctx);
    expect(out).toBe("The scoreboard updates to reflect a shot on the left.");
  });
});

describe("ADAAAA-8027 §2 — the store seam refuses what it cannot make whole", () => {
  it("strips a score the window prompt does not corroborate from the fallback card", () => {
    const row = byId("25929400");
    const ctx = { ...writeTimeCtx(row), promptText: "" };
    const gated = groundCaption(row.reason_raw, ctx);
    const card = storedCardSurface({
      gated,
      raw: row.reason_raw,
      label: row.outcome,
      quiet: isQuietVerdict(row.outcome),
      regate: (sentence: string) => regateServedSentence(sentence, ctx),
    });
    expect(gated).toBe("Shot in midfield");
    expect(card.caption).toBe("The scoreboard updates, followed by player celebrations.");
    expect(card.caption).not.toMatch(/\b\d{1,2}\s*[-–—]\s*\d{1,2}\b/);
    expect(card.violations).toEqual([]);
  });

  it("stores NO card when neither the gated line nor the raw sentence can be made whole", () => {
    const gated = `${"A player in".padEnd(200, " x")} in`;
    const card = storedCardSurface({ gated, raw: "", label: "shot", quiet: false });
    expect(card.caption).toBe("");
    expect(card.cardTitles).toEqual([]);
    expect(card.violations.length).toBeGreaterThan(0);
  });
});
