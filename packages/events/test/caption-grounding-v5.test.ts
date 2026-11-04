// ADAAAA-7965 (parent ADAAAA-7933, contract v5 §3): the landed-colour, place,
// score-strip, negation and render-parity increment.
//
// Every case here is pinned to a string QA v4 MEASURED on job `fd9c0259` /
// build `fba767d` (ADAAAA-7963), not invented prose:
//
//   R18  2 of 2 delivered colour beats contradicted by their own frames
//        (`crowd erupts` at T+12, `players celebrate in penalty area` at T+309)
//   R19  the 3 place misses are shot-only leads: `Yamal shoots`, its repeat,
//        `The striker shoots`
//   R20  4 of 5 accepted reasons shipped ungrammatical score-strip copy:
//        `The scoreboard updates from to as the ball stays out.`
//        `The ball stays out and the scoreboard updates from.`  (x2)
//   R21  all 5 accepted reasons asserted `The ball stays out` while their own
//        `reason_raw` said the ball entered the net and the frame showed `GOL`
//   R22  card options dropped the period 5/5, dropped the colour clause, and
//        cut one last word (`… Player shoots`)
import { describe, it, expect } from "vitest";
import {
  captionColour,
  captionForStoredLine,
  cardTitlesFor,
  colourBeatFromSignal,
  colourBeatAllowed,
  COLOUR_MAX_CHARS,
  CARD_TITLE_MAX_CHARS,
  ensureLeadPlace,
  gateAbsenceClaims,
  gateGoalClaims,
  gateQuietWindow,
  groundCaption,
  hasAbsenceClaim,
  hasPlacePhrase,
  MAX_CAPTION_CHARS,
  QUIET_MAX_WORDS,
  type ColourSignal,
} from "../src/caption-grounding";

const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

const QUIET = (place: string | null = "in midfield") => ({
  verdict: "not_highlight",
  promptText: "",
  place,
} as const);

/** A firing audio-noise signal, as ADAAAA-7964 measured it (ratio 5 -> "lifts"). */
const SIGNAL: ColourSignal = {
  signal: "audio_noise",
  ratio: 5,
  sustained: 0.2,
  peak: 0.4,
  peakT: 12,
  frameTs: 12,
  frameSeq: 36,
};

describe("v5 §3.3 (R20) — a score strip never orphans its prepositions", () => {
  // The exact shapes QA v4 measured. `updates from to` / a dangling `from.` must
  // not be producible from any input that carried a score span.
  const SHIPPED_BAD = [
    "The scoreboard updates from to as the ball stays out.",
    "The ball stays out and the scoreboard updates from.",
  ];
  const orphaned = (text: string) => /\bupdates?\s+(?:from\s+to|from|to)\b\s*(?=[,.;:!?]|$)/i.test(text);

  it("strips a `from X to Y` pair whole, keeping the clause grammatical", () => {
    const out = groundCaption(
      "The scoreboard updates from 1-1 to 2-1 as the ball enters the net.",
      QUIET()
    );
    expect(orphaned(out)).toBe(false);
    expect(SHIPPED_BAD).not.toContain(out);
    expect(out).toBe("The scoreboard updates.");
  });

  it("strips the pair on the second clause of the measured reason shape", () => {
    // The raw reason carried both a claim and an uncorroborated score strip.
    const out = groundCaption(
      "The ball enters the net and the scoreboard updates from 1-0 to 2-0.",
      QUIET()
    );
    expect(orphaned(out)).toBe(false);
    expect(SHIPPED_BAD).not.toContain(out);
    expect(out).toBe("The scoreboard updates.");
  });

  it("keeps a corroborated score span byte-identical", () => {
    const line = "The scoreboard updates from 1-1 to 2-1.";
    const out = groundCaption(line, { verdict: "not_highlight", promptText: line, place: "in midfield" });
    expect(out).toBe(line);
  });

  it("drops only the preposition of a single score span", () => {
    const out = groundCaption("No. 3 leads by 2-1 in the box.", QUIET());
    expect(orphaned(out)).toBe(false);
    expect(out).not.toMatch(/\bby\s*(?=[,.;:!?]|$)/);
    expect(out).toContain("in the box");
  });
});

describe("v5 §3.4 (R21) — an absence claim needs the window's own evidence", () => {
  it("never invents `the ball stays out` when a goal claim is rewritten", () => {
    // The v4 rewrite's exact output — QA measured it on all 5 accepted reasons.
    expect(gateGoalClaims("The ball enters the net.", { verdict: "near_miss" })).not.toContain("stays out");
    const out = gateGoalClaims("The ball enters the net.", { verdict: "near_miss" });
    expect(hasAbsenceClaim(out)).toBe(false);
  });

  it("removes an unevidenced absence clause and keeps the rest of the line", () => {
    const out = groundCaption("The ball stays out and the scoreboard updates.", QUIET());
    expect(out).not.toContain("stays out");
    expect(out).toBe("The scoreboard updates.");
  });

  it("keeps an absence claim the window's frames and verdict evidence", () => {
    const line = "No. 3 shoots and the ball stays out.";
    const out = gateAbsenceClaims(line, {
      verdict: "near_miss",
      promptText: "",
      absenceEvidence: true,
    });
    expect(out).toBe(line);
  });

  it("drops a line that is nothing but an unevidenced negative", () => {
    expect(gateAbsenceClaims("The ball stays out.", QUIET())).toBe("");
  });

  it("a goal window never evidences an absence", () => {
    const out = gateAbsenceClaims("No. 9 scores and the ball stays out.", {
      verdict: "scoring_play",
      promptText: "",
      absenceEvidence: false,
    });
    expect(hasAbsenceClaim(out)).toBe(false);
  });
});

describe("v5 §3.2 (R19) — place is injected from stored window state", () => {
  // The three place misses QA measured, verbatim.
  it.each([
    ["Yamal shoots", "The striker shoots in midfield"],
    ["The striker shoots", "The striker shoots in midfield"],
  ])("gives the measured shot-only lead %s a place", (line, expected) => {
    const out = groundCaption(line, QUIET());
    expect(out).toBe(expected);
    expect(hasPlacePhrase(out)).toBe(true);
    expect(wordCount(out)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
  });

  it("does not add a place to a lead that already names one mid-clause", () => {
    const out = ensureLeadPlace("No. 3 drives into the box and shoots", QUIET());
    expect(out).toBe("No. 3 drives into the box and shoots");
    expect(out).not.toContain("in midfield");
  });

  it("drops the lead when the fast rail resolved no place at all", () => {
    expect(ensureLeadPlace("Yamal shoots", QUIET(null))).toBe("");
  });

  it("leaves a surface that supplies no place key byte-identical (VOD, AC8)", () => {
    const line = "Yamal shoots";
    expect(ensureLeadPlace(line, { verdict: "not_highlight", promptText: "" })).toBe(line);
  });

  it("does not glue a place onto a statement with no action verb", () => {
    expect(ensureLeadPlace("The scoreboard updates.", QUIET())).toBe("The scoreboard updates.");
  });
});

describe("v5 §3.1 (R18) — the two contradicted beats can no longer ship", () => {
  it("`crowd erupts` at T+12 is replaced by the measured level beat on a LOUD window", () => {
    // ADAAAA-7995 (AC4): the quiet window carries no colour at all, so the channel
    // this case pins is the LOUD one — a scoring window keeps the derived beat.
    const loud = groundCaption("No. 3 drives into the box and shoots — crowd erupts", {
      verdict: "scoring_play",
      promptText: "",
      place: "in the box",
      colourSignal: SIGNAL,
    });
    expect(loud).not.toContain("crowd erupts");
    expect(captionColour(loud)).toBe("noise lifts, then settles");
    // ...and a quiet window with the same firing signal carries NO colour and
    // stays inside the 8-word bar (the defect measured on five fresh jobs).
    const quiet = groundCaption("No. 3 drives into the box and shoots — crowd erupts", {
      ...QUIET(),
      colourSignal: SIGNAL,
    });
    expect(quiet).not.toContain("crowd erupts");
    expect(captionColour(quiet)).toBe("");
    expect(wordCount(quiet)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
  });

  it("`players celebrate in penalty area` at T+309 is dropped outright", () => {
    const out = groundCaption("No. 3 shoots — players celebrate in penalty area.", QUIET());
    expect(out).not.toMatch(/celebrat|penalty area/i);
    expect(captionColour(out)).toBe("");
  });

  it("every derived beat is <= 40 chars, carries no name/claim/reaction noun, and names its signal", () => {
    for (const ratio of [2.1, 4, 9.9, 10, 40]) {
      const beat = colourBeatFromSignal({ ...SIGNAL, ratio });
      expect(beat.length).toBeGreaterThan(0);
      expect(beat.length).toBeLessThanOrEqual(COLOUR_MAX_CHARS);
      expect(beat).not.toMatch(/\b(?:crowd|stand|bench|dugout|celebrat|roar|erupt|momentum)\b/i);
      expect(colourBeatAllowed(beat, { colourSignal: { ...SIGNAL, ratio } })).toBe(true);
    }
  });

  it("a beat with no frame reference is dropped, never shipped", () => {
    expect(colourBeatFromSignal({ ...SIGNAL, frameTs: undefined, frameSeq: undefined })).toBe("");
  });
});

describe("v5 §3.5 (R22) — every rendered surface string is the stored gated value", () => {
  const STORED = "No. 3 shoots in midfield. noise lifts, then settles";

  it("the caption is the stored line byte-for-byte (period and colour kept)", () => {
    expect(captionForStoredLine(STORED)).toBe(STORED);
    expect(captionForStoredLine("The ball stays out.")).toBe("The ball stays out.");
  });

  it("every card option carries the stored line byte-for-byte", () => {
    const titles = cardTitlesFor(STORED, "Shot");
    expect(titles.length).toBeGreaterThanOrEqual(2);
    // Option 1 IS the stored string; the label join carries it whole; the label
    // option is the label. None is a cut derivative.
    expect(titles[0]).toBe(STORED);
    expect(titles).toContain(`Shot: ${STORED}`);
    for (const t of titles) {
      expect(STORED.includes(t.replace(/^Shot: /, "")) || "/" + t === "/Shot").toBe(true);
    }
  });

  it("a cut is resolved at the seam and the stored value is the cut", () => {
    const long = `${"No. 3 drives into the box and shoots in the penalty area. ".repeat(3)}`.trim();
    const cut = captionForStoredLine(long);
    expect(cut.length).toBeLessThanOrEqual(MAX_CAPTION_CHARS);
    // No partial word at the seam: the cut ends on a whole token.
    expect(long.startsWith(cut)).toBe(true);
    expect(cut.split(/\s+/).pop()).toBe(long.split(/\s+/).filter(Boolean)[cut.split(/\s+/).length - 1]);
    const title = cardTitlesFor(long, "Shot")[0];
    expect(title.length).toBeLessThanOrEqual(CARD_TITLE_MAX_CHARS);
    expect(long.startsWith(title)).toBe(true);
  });
});

describe("v5 — the delivered-line invariants still hold", () => {
  it("a quiet row is <= 8 words with no claim and no forwarded colour", () => {
    const out = groundCaption("No. 3 drives into the box and shoots — crowd erupts", QUIET());
    expect(wordCount(out)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
    expect(out).not.toMatch(/\bcrowd\b/i);
    expect(gateQuietWindow(out, QUIET())).toBe(out);
  });

  it("the gate is idempotent on its own output", () => {
    const once = groundCaption("No. 3 shoots — crowd erupts", { ...QUIET(), colourSignal: SIGNAL });
    expect(groundCaption(once, { ...QUIET(), colourSignal: SIGNAL })).toBe(once);
  });
});
