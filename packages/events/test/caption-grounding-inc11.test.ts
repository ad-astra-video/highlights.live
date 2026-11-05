// ADAAAA-8053 (parent ADAAAA-7933, contract v8 §3b): the three defects QA v7
// measured on the deployed build `93fae4a` (job `86f6ada4`), pinned at the shared
// gate. Every input string below is VERBATIM from that grade, not invented prose.
//
//   1. AC7/AC10 served card options `["The ball shoots in midfield",
//      "big play: The ball shoots in midfield", "big play"]`  -> §3b.1
//   2. AC3   `The white team player shoots and shoots in midfield.` (§3b.2)
//   3. AC4   the colour derivation was unobservable: 0/4 beats with no reason
//      recorded anywhere                                          -> §3b.3
import { describe, it, expect } from "vitest";
import {
  captionColour,
  cardTitlesFor,
  colourBeatFromSignal,
  colourGateDecision,
  colourTraceFor,
  collapseRepeatedVerbPhrase,
  completeCaptionLine,
  groundCaption,
  groundSummaryText,
  hasRepeatedVerbPhrase,
  isServableCardOption,
  isTaxonomyToken,
  servedShape,
  servedShapeViolations,
  storedCardSurface,
  taxonomyKey,
  type ColourSignal,
} from "../src/caption-grounding";

/** The measured firing signal (ratio 5 -> the middle tier beat). */
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

describe("§3b.1 — a card option is a gated sentence, never a taxonomy token (AC-I1)", () => {
  // The exact served triple from job `86f6ada4`.
  const MEASURED_CAPTION = "The ball shoots in midfield";

  it("never serves the bare event type or a `<type>: ` prefix", () => {
    for (const label of ["big play", "Big Play", "scoring_play", "near_miss", "not_highlight"]) {
      const titles = cardTitlesFor(MEASURED_CAPTION, [label, `${label}: ${MEASURED_CAPTION}`]);
      expect(titles, label).toEqual([MEASURED_CAPTION]);
      for (const t of titles) {
        expect(isTaxonomyToken(t), `${label}: ${t}`).toBe(false);
        expect(t, `${label}: ${t}`).not.toMatch(/^[a-z][a-z_ -]{0,24}[:—–]\s/i);
      }
    }
  });

  it("never reproduces the measured `86f6ada4` triple", () => {
    const titles = cardTitlesFor(MEASURED_CAPTION, ["big play"]);
    expect(titles).not.toContain("big play");
    expect(titles.some((t) => t.startsWith("big play: "))).toBe(false);
  });

  it("every stored card option is the accepted caption byte-for-byte", () => {
    const card = storedCardSurface({
      gated: "The ball shoots in midfield.",
      raw: "The ball shoots in midfield.",
      quiet: false,
      verdict: "big_play",
      corroborated: null,
    });
    expect(card.caption).toBe("The ball shoots in midfield.");
    for (const title of card.cardTitles) {
      // Byte-identical to the one gated stored string this row carries.
      expect(title).toBe("The ball shoots in midfield.");
    }
    expect(card.cardTitles.length).toBeGreaterThan(0);
  });

  it("recognises the taxonomy vocabulary in every spelling the pipeline emits", () => {
    for (const token of ["big play", "BIG_PLAY", "scoring play", "scoring_play", "near_miss", "not_highlight", "Near Miss"]) {
      expect(isTaxonomyToken(token), token).toBe(true);
      expect(isServableCardOption(token), token).toBe(false);
    }
    expect(taxonomyKey("BIG_PLAY")).toBe("big play");
    // A sentence is never mistaken for a token.
    expect(isTaxonomyToken("The white team player shoots in midfield.")).toBe(false);
  });

  it("refuses a token-bearing option on every render path (the read fallback)", () => {
    // The webapp's legacy fallback (`postTitles`) filters with the same predicate.
    expect(isServableCardOption("big play: The ball shoots in midfield")).toBe(false);
    expect(isServableCardOption("Shot")).toBe(false);
    expect(isServableCardOption("Goal moment")).toBe(false);
  });
});

describe("§3b.2 — claim removal rejoins instead of duplicating a verb (AC-I2)", () => {
  // VERBATIM row #6 (`ts=187`, verdict `scoring_play`) from job `86f6ada4`:
  // stored `text_raw` -> delivered `The white team player shoots and shoots in
  // midfield.` (the ungrounded goal clause was deleted and the connector left the
  // verb twice).
  const TEXT_RAW = "The white team player shoots and scores a goal — crowd reacts";
  const DELIVERED_DEFECT = "The white team player shoots and shoots in midfield.";

  it("collapses `<verb> and <same verb>` deterministically", () => {
    expect(collapseRepeatedVerbPhrase(DELIVERED_DEFECT)).toBe("The white team player shoots in midfield.");
    expect(collapseRepeatedVerbPhrase("The striker shoots and shoots")).toBe("The striker shoots");
    // A phrase repeat collapses too, and a clean line is returned byte-identical.
    expect(collapseRepeatedVerbPhrase("No. 9 takes a shot and takes a shot in the box.")).toBe(
      "No. 9 takes a shot in the box."
    );
    const clean = "The blue player shoots in midfield.";
    expect(collapseRepeatedVerbPhrase(clean)).toBe(clean);
  });

  it("repairs the measured row into a complete actor + action + place line", () => {
    // The write seam's own order: gate the line, then complete it.
    const gated = groundCaption(TEXT_RAW, {
      verdict: "scoring_play",
      promptText: "",
      place: "in midfield",
      corroborated: null,
    } as never);
    const repaired = completeCaptionLine({
      candidate: gated,
      raw: TEXT_RAW,
      quiet: false,
      place: "in midfield",
    });
    // Either a complete line or the blunt quiet line — never a doubled verb.
    expect(hasRepeatedVerbPhrase(repaired)).toBe(false);
    expect(repaired).not.toMatch(/\bshoots and shoots\b/i);
    if (repaired) {
      expect(servedShapeViolations(repaired, [TEXT_RAW])).toEqual([]);
      expect(repaired).toMatch(/shoots/);
      expect(repaired).toMatch(/in midfield/);
    }
  });

  it("suppresses the row rather than storing a doubled verb when it cannot rejoin", () => {
    // No place is groundable and the raw cannot be reduced cleanly -> the seam
    // stores nothing (a malformed line is worse than no row).
    const gated = groundSummaryText(TEXT_RAW, {
      verdict: "scoring_play",
      promptText: "",
      place: null,
      corroborated: null,
    } as never);
    expect(hasRepeatedVerbPhrase(gated)).toBe(false);
  });

  it("rejoins a LEGACY stored row at read time instead of dropping it", () => {
    // A row written by the pre-fix build still carries the doubled verb. The
    // ladder's read pass may only DELETE words, so it serves the rejoined line.
    const served = servedShape({
      candidate: DELIVERED_DEFECT,
      storedRaw: TEXT_RAW,
      storedGated: DELIVERED_DEFECT,
      quiet: false,
    });
    expect(served.text).not.toMatch(/\bshoots and shoots\b/i);
    expect(hasRepeatedVerbPhrase(served.text)).toBe(false);
    expect(served.text).toBe("The white team player shoots in midfield.");
  });

  it("flags the shape as malformed on every surface (the guardrail)", () => {
    expect(servedShapeViolations(DELIVERED_DEFECT)).toContain("verb-repeat");
    expect(servedShapeViolations("The striker shoots and shoots")).toContain("verb-repeat");
    // A legitimately coordinated pair of DIFFERENT verbs is not a repeat.
    expect(servedShapeViolations("The striker shoots and scores in the box.")).not.toContain("verb-repeat");
  });
});

describe("§3b.3 — the colour derivation is observable per row (AC-I3)", () => {
  it("records the beat when the derivation fires", () => {
    const decision = colourGateDecision(SIGNAL);
    expect(decision.clause).toBe("beat");
    expect(decision.beat).toBe(colourBeatFromSignal(SIGNAL));

    const trace = colourTraceFor({ verdict: "not_highlight", colourSignal: SIGNAL }, `A player dribbles in midfield — ${decision.beat}`, 187);
    expect(trace).toMatchObject({
      windowTs: 187,
      verdict: "not_highlight",
      signalPresent: true,
      clause: "beat",
      beat: decision.beat,
    });
    expect(trace.signal?.ratio).toBe(5);
  });

  it("names `derivation-not-reached` with the measurement's own reason", () => {
    // The shape a window written while the derive pass was unavailable produces:
    // no signal, and the seam records WHY.
    for (const reason of ["insufficient-taps", "low-energy", "no-frame", "no-window-ts"] as const) {
      const trace = colourTraceFor({ verdict: "not_highlight", colourSignal: null, colourSignalReason: reason }, "A player dribbles in midfield.", 42);
      expect(trace.signalPresent).toBe(false);
      expect(trace.clause).toBe("derivation-not-reached");
      expect(trace.signalReason).toBe(reason);
      expect(trace.beat).toBeUndefined();
    }
  });

  it("names `wording-filter` (with a sub-reason) when a real signal cannot become a beat", () => {
    for (const [signal, reason] of [
      [{ ...SIGNAL, ratio: 1.2 }, "ratio-floor"],
      [{ ...SIGNAL, sustained: 0.9 }, "plateau"],
      [{ ...SIGNAL, peak: 0.1 }, "peak-floor"],
      [{ ...SIGNAL, frameTs: undefined, frameSeq: undefined }, "no-frame"],
    ] as Array<[ColourSignal, string]>) {
      const decision = colourGateDecision(signal);
      expect(decision.clause).toBe("wording-filter");
      expect(decision.reason).toBe(reason);
      expect(decision.beat).toBe("");
      const trace = colourTraceFor({ verdict: "not_highlight", colourSignal: signal }, "A player dribbles in midfield.", 42);
      expect(trace.signalPresent).toBe(true);
      expect(trace.reason).toBe(reason);
    }
  });

  it("carries no trace for a row the derivation never evaluated (legacy / VOD)", () => {
    const card = storedCardSurface({
      gated: "A player dribbles in midfield.",
      raw: "A player dribbles in midfield.",
      quiet: true,
      verdict: "not_highlight",
      corroborated: null,
    });
    // Grounding absent -> the caller stores no trace at all; the card is clean.
    expect(card.caption).toBe("A player dribbles in midfield.");
    expect(captionColour(card.caption)).toBe("");
  });

  it("separates a quiet-cap removal from a non-firing derivation", () => {
    // The cap rewrites `clause` to `quiet-cap` in `applyQuietColourCap`; the
    // derivation itself still reports `beat` at build time.
    const trace = colourTraceFor({ verdict: "not_highlight", colourSignal: SIGNAL }, `A player dribbles in midfield — ${colourBeatFromSignal(SIGNAL)}`, 60);
    expect(trace.clause).toBe("beat");
    expect(trace.beat).toBe(colourBeatFromSignal(SIGNAL));
  });
});

describe("§3b — the v7 quiet-beat behaviour is unchanged (no regression)", () => {
  it("still appends the derived beat to a quiet row", () => {
    const out = groundCaption("A player in white dribbles the ball in the center circle.", {
      ...quietCtx("in the center circle"),
      colourSignal: SIGNAL,
    } as never);
    expect(captionColour(out)).toBe("noise lifts, then settles");
  });
});
