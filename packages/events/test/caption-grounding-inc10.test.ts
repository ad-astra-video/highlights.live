// ADAAAA-8043 (parent ADAAAA-7933, contract v7 §3): the four defects QA v6
// measured on job `3544e617` (build `a408584`, 25 delivered rows), pinned at the
// shared gate. Every input below is a VERBATIM stored row from that job
// (`jobs.record->summaryLog[].text_raw`), not invented prose.
//
//   1. AC4  the colour derivation never fires on a quiet row  -> §3.1
//   2. AC3  4 malformed lines survived a 90% completeness bar  -> §3.2
//   3. AC9  1 outcome inversion (goal -> "wide on the left")   -> §3.3
//   4. AC4b `goal:` on the card of an uncorroborated goal      -> §3.4
import { describe, it, expect } from "vitest";
import {
  captionColour,
  captionLead,
  cardTitlesFor,
  colourBeatFromSignal,
  completeCaptionLine,
  completenessGaps,
  gateGoalClaims,
  groundCaption,
  QUIET_MAX_WORDS,
  restoreTerminalPunctuation,
  storedCardSurface,
  type ColourSignal,
} from "../src/caption-grounding";

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** A firing audio-noise signal (ratio 5 -> the middle tier beat). */
const SIGNAL: ColourSignal = {
  signal: "audio_noise",
  ratio: 5,
  sustained: 0.2,
  peak: 0.4,
  peakT: 12,
  frameTs: 12,
  frameSeq: 36,
};

const quietCtx = (place: string | null, extra: Record<string, unknown> = {}) =>
  ({ verdict: "not_highlight", promptText: "", place, ...extra }) as never;

describe("§3.1 — the colour derivation fires on a quiet row (AC4)", () => {
  it("appends the beat derived from the stored signal to a not_highlight row", () => {
    const out = groundCaption("A player in white dribbles the ball in the center circle.", {
      ...quietCtx("in the center circle"),
      colourSignal: SIGNAL,
    } as never);
    expect(captionColour(out)).toBe(colourBeatFromSignal(SIGNAL));
    expect(captionColour(out)).toBe("noise lifts, then settles");
    // AC5 measures the LEAD before the beat separator.
    expect(words(captionLead(out))).toBeLessThanOrEqual(QUIET_MAX_WORDS);
  });

  it("never forwards the model's reaction clause, on any verdict", () => {
    // Verbatim `text_raw` rows 8/9/13/22 all carry a reaction clause.
    for (const verdict of ["not_highlight", "big_play", "near_miss", "scoring_play"]) {
      const out = groundCaption("The striker celebrates the goal — Bench reacts with joy", {
        ...quietCtx("in the box", { verdict }),
        colourSignal: SIGNAL,
      } as never);
      // The model's reaction clause never survives; the LEAD may still describe
      // the celebration (that is the window's own read, not a colour claim).
      expect(out).not.toMatch(/bench|reacts with|erupts/i);
      expect(captionColour(out)).toBe("noise lifts, then settles");
    }
  });

  it("keeps the beat inside the 40-char ceiling and the quiet cap is a write-seam rule", () => {
    for (const ratio of [2, 4, 10, 40]) {
      const beat = colourBeatFromSignal({ ...SIGNAL, ratio });
      expect(beat.length).toBeLessThanOrEqual(40);
      expect(beat).not.toMatch(/crowd|bench|celebrat|erupt|roar/i);
    }
  });
});

describe("§3.2 — completeness: actor + action + place, or the row is suppressed (AC3)", () => {
  it("repairs the broken score-strip grammar (`remains of the pitch`)", () => {
    // Row 15: stored text_raw. The v6 quiet trim deleted `in the center` and
    // left `of the pitch` behind.
    const raw = "The ball remains in the center of the pitch.";
    const repaired = completeCaptionLine({
      candidate: "The ball remains of the pitch.",
      raw,
      quiet: true,
      place: "in the center",
    });
    expect(repaired).not.toMatch(/of the pitch/i);
    expect(repaired).toBe("The ball remains in center.");
    expect(completenessGaps(repaired)).toEqual([]);
  });

  it("repairs a row that lost its PLACE (rows 16/18)", () => {
    for (const [raw, candidate, place] of [
      [
        "A player in a blue kit dribbles the ball in the center circle.",
        "A player in a blue dribbles the ball.",
        "in the center circle",
      ],
      [
        "A player in a white kit attempts a shot in the penalty area.",
        "A player in a white attempts a shot.",
        "in the box",
      ],
    ] as const) {
      const repaired = completeCaptionLine({ candidate, raw, quiet: true, place });
      expect(completenessGaps(repaired)).toEqual([]);
      expect(words(captionLead(repaired))).toBeLessThanOrEqual(QUIET_MAX_WORDS);
      // The zone is the window's own stored place, never invented.
      expect(repaired).toMatch(/center circle|box/);
    }
  });

  it("repairs a row that lost its ACTION (row 17) and keeps the grounded actor", () => {
    const repaired = completeCaptionLine({
      candidate: "A player from the box.",
      raw: "A player in a white kit shoots from the penalty area.",
      quiet: true,
      place: "in the box",
    });
    expect(completenessGaps(repaired)).toEqual([]);
    expect(repaired).toMatch(/shoots|attempts|falls|dribbles/);
    // The zone is the raw sentence's own place (never invented).
    expect(repaired).toMatch(/penalty area|box/);
    expect(words(captionLead(repaired))).toBeLessThanOrEqual(QUIET_MAX_WORDS);
  });

  it("suppresses a line nothing can ground instead of storing it malformed (row 23 shape)", () => {
    const out = completeCaptionLine({ candidate: "A player in the box.", raw: "| ", quiet: true, place: "" });
    expect(out).toBe("");
    expect(completenessGaps("A player in the box.")).toContain("action");
    expect(completenessGaps("A player from the box.")).toContain("action");
    expect(completenessGaps("A player in a white attempts a shot.")).toContain("place");
  });

  it("normalises terminal punctuation at the seam (AC10 has nothing to repair)", () => {
    // Rows 1/6/19 were stored WITHOUT a sentence end and gained one at read.
    expect(restoreTerminalPunctuation("Player in purple dribbles in the center circle")).toBe(
      "Player in purple dribbles in the center circle."
    );
    const repaired = completeCaptionLine({
      candidate: "Player in purple dribbles in the center circle",
      raw: "Player in purple jersey dribbles in the center circle",
      quiet: true,
      place: "in the center circle",
    });
    expect(repaired.endsWith(".")).toBe(true);
  });
});

describe("§3.3 — an ungrounded outcome is dropped, never inverted (AC9)", () => {
  it("row 22: a scoring_play window never ships `wide`", () => {
    // Verbatim row 22: verdict `scoring_play`, text_raw `The winger strikes the
    // ball into the net — crowd erupts`, delivered as
    // `The winger strikes the ball wide on the left`.
    const out = groundCaption("The winger strikes the ball into the net — crowd erupts", {
      verdict: "scoring_play",
      promptText: "",
      place: "on the left",
      corroborated: false,
    } as never);
    expect(out).not.toMatch(/\bwide\b/i);
    expect(out).not.toMatch(/\bnet\b/i);
    expect(out).toMatch(/strikes the ball/);
    expect(out).toMatch(/on the left/);
  });

  it("never turns a grounded goal into a miss on any uncorroborated surface", () => {
    for (const text of [
      "No. 8 headers ball into net",
      "The striker finds the back of the net",
      "That levels it",
    ]) {
      const out = gateGoalClaims(text, { verdict: "not_highlight", corroborated: false });
      expect(out, text).not.toMatch(/\bwide\b|off target|over the bar/i);
      expect(out, text).not.toMatch(/\bnet\b|goal line|\bgoal\b/i);
    }
  });
});

describe("§3.4 — corroboration reaches the card-title surface (AC4b)", () => {
  const card = (corroborated: boolean) =>
    storedCardSurface({
      gated: "The player in the purple jersey takes a shot from the penalty area.",
      raw: "The player in the purple jersey takes a shot from the penalty area.",
      label: "goal",
      quiet: false,
      verdict: "scoring_play",
      corroborated,
    });

  it("renders no `goal` option for an uncorroborated goal", () => {
    const { cardTitles } = card(false);
    expect(cardTitles.length).toBeGreaterThan(0);
    for (const title of cardTitles) expect(title, title).not.toMatch(/\bgoal\b/i);
  });

  it("serves no `goal` option for a corroborated goal either — a label is not an option (v8 §3b.1)", () => {
    // ADAAAA-8053: `goal` / `goal: …` are taxonomy-token shapes; the card offers
    // the gated caption alone. AC4b is unaffected: the caption cannot assert an
    // uncorroborated goal.
    for (const title of card(true).cardTitles) expect(title, title).not.toMatch(/^goal\b/i);
    expect(card(true).cardTitles).toEqual([card(true).caption]);
  });

  it("a corroborated label is never a card option", () => {
    // `cardTitlesFor` no longer takes a label at all: a token cannot be served.
    for (const title of cardTitlesFor("Player in white shoots in midfield.")) {
      expect(title).not.toMatch(/^goal\b/i);
      expect(title).toBe("Player in white shoots in midfield.");
    }
  });
});

describe("§3.2 — measured residual on the bounded level `dece44c3`", () => {
  it("never doubles a preposition when the zone replaces its object (row 6)", () => {
    // Verbatim row 6: raw `A player in blue moves the ball toward the center of
    // the pitch.`, stored zone `in midfield`, shipped
    // `A player moves the ball toward in midfield.`
    const out = groundCaption("A player in blue moves the ball toward the center of the pitch.", {
      verdict: "not_highlight",
      promptText: "",
      place: "in midfield",
    } as never);
    expect(out).not.toMatch(/\btoward\b/i);
    expect(out).not.toMatch(/\b(?:to|toward|into)\s+(?:in|at|on)\b/i);
    expect(out).toMatch(/in midfield/);
    expect(completenessGaps(out)).toEqual([]);
  });
});
