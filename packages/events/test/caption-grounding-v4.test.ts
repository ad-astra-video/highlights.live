// ADAAAA-7962 (parent ADAAAA-7933, contract v4 §3): the delivered-surface
// parity + grounded colour increment.
//
// v3 made the PAGE clean and left the STORE lying, so every case here is pinned
// against the strings the grade of record actually measured (level `dcaa93c5`,
// ADAAAA-7959) rather than invented prose:
//
//   R13  stored `summaryLog` 27 rows / 10 goal claims, page 26 rows / 0 claims
//   R14  "Real Madrid player controls ball in center circle." reached the page
//        from a window whose prompt never says "madrid" (first-token match)
//   R15  the fail-closed rewrite dropped the zone ("No. 9 reacts to a play in")
//   R16  the page carried 0/26 colour because every colour clause sat on a
//        `not_highlight` row (§3.3 banned colour there)
//
// and the v3 rules that already pass (claim gate, corroboration propagation,
// OCR-is-not-colour) are pinned here so v4 cannot regress them.
import { describe, it, expect } from "vitest";
import {
  COLOUR_MAX_CHARS,
  captionColour,
  colourBeatAllowed,
  dedupeStoredLines,
  gateGoalClaims,
  gateQuietWindow,
  groundCaption,
  groundNames,
  groundSummaryItems,
  hasGoalClaim,
  hasProperName,
  placePhraseOf,
  QUIET_MAX_WORDS,
  stripInternalTokens,
  windowCorroborated,
} from "../src/caption-grounding";

const quiet = (promptText = "") => ({ verdict: "not_highlight", promptText });
const goal = (promptText = "", corroborated = true) => ({
  verdict: "scoring_play",
  promptText,
  corroborated,
});

describe("contract v4 §3.3 — name provenance is the WHOLE name phrase (R14)", () => {
  it("does not ground a multi-token club name on its first token", () => {
    // The measured window g90: `madrid` occurs nowhere in its 13,053-char
    // prompt, only the common word `real` does. v3 kept the name anyway.
    const line = "Real Madrid player controls ball in center circle.";
    const out = groundCaption(line, quiet("Match context: real stadium, blue v white"));
    expect(out.toLowerCase()).not.toContain("madrid");
    expect(out).not.toContain("Real Madrid");
  });

  it("keeps a multi-token name the window's own prompt carries", () => {
    const line = "Real Madrid player controls ball in center circle.";
    const out = groundCaption(line, quiet("Match context: Real Madrid CF vs FC Barcelona"));
    expect(out).toContain("Real Madrid");
  });

  it("keeps a single-token name only when that token is in this window's prompt", () => {
    const line = "Saez strikes the ball wide.";
    expect(groundNames(line, "ASR: Saez collected it")).toBe(line);
    expect(groundNames(line, "ASR: nothing legible")).not.toContain("Saez");
  });

  it("a jersey number is evidence in its own right and is never rewritten", () => {
    expect(groundNames("No. 9 controls the ball.", "")).toContain("No. 9");
  });

  it("fails closed when no prompt is evidence at all (\"\")", () => {
    expect(groundNames("David Saez scores.", "")).not.toContain("Saez");
  });
});

describe("contract v4 §3.4 — the rewrite keeps actor + action + place (R15)", () => {
  it("condenses the measured quiet line instead of cutting through the zone", () => {
    const out = groundCaption("No. 9 reacts to a play in the penalty area.", quiet());
    expect(out.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(QUIET_MAX_WORDS);
    // "penalty area" -> "box" is the contract's own one-token place form; either
    // spelling counts, the POINT is that the zone survives the trim.
    expect(out).toMatch(/in (?:the )?(?:penalty area|box)$/);
    expect(out).not.toMatch(/\b(?:in|at|on|of|to|with|and|from)$/);
    expect(out).toContain("No. 9");
  });

  it("keeps the place on a claim rewrite (\"scores in the penalty area\")", () => {
    const out = groundCaption("Player 11 scores in the penalty area — teammates celebrate", quiet());
    expect(hasGoalClaim(out)).toBe(false);
    expect(out).toContain("in the penalty area");
  });

  it("a place-preserving rewrite never cuts the zone to satisfy \"never longer\"", () => {
    const out = groundCaption("Real Madrid player controls ball in center circle.", quiet());
    expect(placePhraseOf(out)).toBe("in center circle");
  });

  it("fails closed on a claim with no place: the claim still never survives", () => {
    const out = groundCaption("No. 10 strikes the ball into the net — goal", quiet());
    expect(hasGoalClaim(out)).toBe(false);
    expect(out).not.toContain("net");
  });

  it("strips the goal word and the OCR clock from the measured scoring line", () => {
    const out = groundCaption("Saez strikes the ball into the net — crowd erupts. GOAL 22:15", quiet("saez"));
    expect(hasGoalClaim(out)).toBe(false);
    expect(out).not.toMatch(/GOAL/);
    expect(out).not.toMatch(/\d{1,3}:\d{2}/);
    expect(stripInternalTokens(out)).toBe(out);
  });
});

describe("contract v4 §3.5 — the grounded colour channel (R16)", () => {
  it("keeps a grounded colour beat on a quiet window", () => {
    const out = groundCaption("No. 3 drives into the box and scores — crowd erupts", {
      ...quiet(),
      colourEvidence: true,
    });
    expect(hasGoalClaim(out)).toBe(false);
    expect(captionColour(out)).toBe("crowd erupts");
  });

  it("drops the colour beat when the window has no measured evidence", () => {
    const out = groundCaption("No. 3 drives into the box and scores — crowd erupts", quiet());
    expect(captionColour(out)).toBe("");
  });

  it("never lets a colour beat carry a proper name, a claim, an OCR quote or >40 chars", () => {
    const ctx = { ...quiet(), colourEvidence: true };
    expect(colourBeatAllowed("Saez screams at the bench", ctx)).toBe(false);
    expect(colourBeatAllowed("the net bulges", ctx)).toBe(false);
    expect(colourBeatAllowed("the 'GOL' graphic appears", ctx)).toBe(false);
    expect(colourBeatAllowed(`${"a".repeat(COLOUR_MAX_CHARS + 1)}`, ctx)).toBe(false);
    expect(colourBeatAllowed("crowd erupts", ctx)).toBe(true);
    expect(colourBeatAllowed("crowd erupts", { ...ctx, colourEvidence: false })).toBe(false);
  });

  it("still refuses an OCR colour clause on a loud window (§3.5 carried from v3)", () => {
    const out = gateQuietWindow("Player 11 shoots — the 'GOL' graphic appears", goal("player 11"));
    expect(captionColour(out)).toBe("");
  });

  it("a corroborated goal keeps its line byte-identical (no v3 regression)", () => {
    const line = "No. 9 scores — crowd erupts";
    expect(groundCaption(line, goal())).toBe(line);
  });

  it("an uncorroborated goal claim is rewritten, and its colour beat can survive", () => {
    const out = groundCaption("No. 9 scores — crowd erupts", {
      verdict: "scoring_play",
      promptText: "",
      corroborated: false,
      colourEvidence: true,
    });
    expect(hasGoalClaim(out)).toBe(false);
    expect(captionColour(out)).toBe("crowd erupts");
  });
});

describe("contract v4 §3.7 — the stored set IS the page set", () => {
  const FOURTEEN = Array.from({ length: 14 }, () => "Player in blue moves ball in center circle.");

  it("caps the measured 14× repeat at 2 at the WRITE seam", () => {
    let stored: string[] = [];
    for (const line of FOURTEEN) {
      const kept = dedupeStoredLines(line, stored);
      stored = kept ? [...stored, kept] : stored;
    }
    expect(stored).toHaveLength(2);
    expect(stored.every((l) => l === FOURTEEN[0])).toBe(true);
  });

  it("the rendered set equals the stored set (count and strings)", () => {
    // Write seam: gate + dedupe exactly as appendSummaryEntry does.
    const raw = [
      "No. 3 drives into the box and scores — crowd erupts",
      "Player in blue moves ball in center circle.",
      "Player in blue moves ball in center circle.",
      "Player in blue moves ball in center circle.",
      "Real Madrid player controls ball in center circle.",
    ];
    const storedEntries: { seq: number; ts: string; windowTs: number; text: string; verdict: "not_highlight" }[] = [];
    for (const [i, line] of raw.entries()) {
      const gated = groundCaption(line, quiet());
      const kept = dedupeStoredLines(gated, storedEntries.map((e) => e.text));
      if (!kept) continue;
      storedEntries.push({ seq: i + 1, ts: "t", windowTs: i * 3, text: kept, verdict: "not_highlight" });
    }
    // Render seam: the webapp's own pass over the STORED rows.
    const rendered = groundSummaryItems(storedEntries, { highlights: [], fastRail: true });
    expect(rendered.map((e) => e.text)).toEqual(storedEntries.map((e) => e.text));
    expect(rendered).toHaveLength(storedEntries.length);
    // And the page really is clean: no claim, no invented club.
    for (const item of rendered) {
      expect(hasGoalClaim(item.text)).toBe(false);
      expect(item.text.toLowerCase()).not.toContain("madrid");
    }
  });

  it("a line that is already delivered is not rewritten by a second pass", () => {
    const once = groundCaption("No. 9 reacts to a play in the penalty area.", quiet());
    expect(groundCaption(once, quiet())).toBe(once);
  });
});

describe("contract v4 §3.5 helpers", () => {
  it("hasProperName ignores function/event vocabulary and flags real names", () => {
    expect(hasProperName("crowd erupts")).toBe(false);
    expect(hasProperName("the No. 9 reacts")).toBe(false);
    expect(hasProperName("Saez reacts")).toBe(true);
    expect(hasProperName("Real Madrid bench rises")).toBe(true);
  });

  it("the claim gate is still fail-closed on unseen phrasing", () => {
    expect(gateGoalClaims("The No. 10 buries it low", quiet())).not.toContain("buries");
    expect(windowCorroborated([], 12)).toBe(false);
  });
});
