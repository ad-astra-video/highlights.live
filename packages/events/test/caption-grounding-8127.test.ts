// ADAAAA-8127 (Defect B, write seam — fix forward only): two stored copy rows
// carried no sentence end / empty parentheses on the `8921543` build:
//
//   46654656 `b9ca96dd` notableHighlights -> `The keeper is beaten`
//   9c2564e7 `760c599e` highlights        -> `The scoreboard updates from 2-1 to 2-1 ().`
//   68a4c53d `dcb5af4c` highlights        -> `The scoreboard updates from 2-1 to 2-1 ().`
//
// Both artifacts are produced by the WRITE seam from the row's own stored
// `reason_raw`, so this suite replays that seam over the three stored inputs:
//
//   1. `stripInternalTokens` removes the pipeline's evidence tag
//      (`; scoreboard score change confirmed`). When the tag sat INSIDE
//      parentheses the words went and the brackets stayed: `( )` -> `()`.
//   2. the store-time post-condition (`storedCardSurface`) accepted a gated line
//      that had lost its sentence end to the claim gate (`The keeper is beaten`)
//      because it compared equal to its own source, so a bare label was stored.
//
// The rows themselves are NOT rewritten (ADAAAA-8124 AC4 precedent): the fix is
// forward-only — re-running the writer over the same inputs must emit
// `The keeper is beaten.` and `The scoreboard updates from 2-1 to 2-1.`.
import { describe, it, expect } from "vitest";
import {
  captionForStoredLine,
  groundCaption,
  hasTerminalPunctuation,
  restoreTerminalPunctuation,
  stripInternalTokens,
  storedCardSurface,
} from "@highlights/events";

/** Verbatim stored `reason_raw` of `46654656` `b9ca96dd` (BIG_PLAY, accepted). */
const KEEPER_RAW =
  "The ball enters the net and the keeper is beaten as the player in white scores. | live scoring lane: no measured attestation in this window (scoreBoardChanged=false goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL";

/** Verbatim stored `reason_raw` of `9c2564e7`/`68a4c53d` (GOAL, accepted). */
const SCOREBOARD_RAW =
  "The ball enters the net and the scoreboard updates from 2-1 to 2-1 (score change confirmed).; scoreboard score change confirmed";

/** Verbatim gated line the two scoreboard rows stored. */
const SCOREBOARD_GATED = "The scoreboard updates from 2-1 to 2-1 ().";
/** Verbatim gated line the keeper row stored. */
const KEEPER_GATED = "The keeper is beaten";

const emptyParens = (text: string) => (text.match(/\(\s*\)/g) ?? []).length;

describe("ADAAAA-8127 Defect B — the evidence-tag strip leaves no empty parentheses", () => {
  it("strips the tag that sat inside parentheses without leaving `()`", () => {
    const out = stripInternalTokens(SCOREBOARD_RAW);
    expect(emptyParens(out)).toBe(0);
    expect(out).toBe("The ball enters the net and the scoreboard updates from 2-1 to 2-1.");
    expect(hasTerminalPunctuation(out)).toBe(true);
  });

  it("emits the ticket's expected line end to end (claim gate then no empty pair)", () => {
    // A non-goal window: the claim gate rewrites the goal claim to the production
    // it can stand behind (the stored raw's own posture, `delivered as a
    // celebration, not a GOAL`).
    const gated = groundCaption(SCOREBOARD_RAW, { verdict: "big_play" } as never);
    expect(gated).toBe("The scoreboard updates from 2-1 to 2-1.");
    expect(emptyParens(gated)).toBe(0);
    const card = storedCardSurface({ gated, raw: SCOREBOARD_RAW, quiet: false, verdict: "scoring_play" });
    expect(card.caption).toBe("The scoreboard updates from 2-1 to 2-1.");
    expect(card.cardTitles).toEqual(["The scoreboard updates from 2-1 to 2-1."]);
  });
});

describe("ADAAAA-8127 Defect B — the store-time post-condition closes a bare caption", () => {
  it("stores `The keeper is beaten.` for the keeper row's gated line", () => {
    const card = storedCardSurface({
      gated: KEEPER_GATED,
      raw: KEEPER_RAW,
      quiet: false,
      verdict: "big_play",
    });
    expect(card.caption).toBe("The keeper is beaten.");
    expect(card.cardTitles).toEqual(["The keeper is beaten."]);
    expect(hasTerminalPunctuation(card.caption)).toBe(true);
  });

  it("closes a caption that already ends in a sentence without doubling the stop", () => {
    const card = storedCardSurface({
      gated: "The goalkeeper falls to the ground.",
      raw: "The ball enters the net and the goalkeeper falls to the ground.",
      quiet: false,
      verdict: "big_play",
    });
    expect(card.caption).toBe("The goalkeeper falls to the ground.");
  });
});

describe("ADAAAA-8127 Defect B — the three stored rows replay clean", () => {
  it("has 0 `()` artifacts and 0 missing sentence ends over the replayed writer", () => {
    const inputs: Array<{ raw: string; gated: string; verdict: string }> = [
      { raw: SCOREBOARD_RAW, gated: SCOREBOARD_GATED, verdict: "scoring_play" },
      { raw: SCOREBOARD_RAW, gated: SCOREBOARD_GATED, verdict: "scoring_play" },
      { raw: KEEPER_RAW, gated: KEEPER_GATED, verdict: "big_play" },
    ];
    let parens = 0;
    let open = 0;
    for (const input of inputs) {
      const stripped = stripInternalTokens(input.raw);
      const gatedNow = groundCaption(input.raw, { verdict: "big_play" } as never);
      const card = storedCardSurface({ gated: gatedNow, raw: stripped, quiet: false, verdict: input.verdict });
      const served = card.caption || gatedNow;
      parens += emptyParens(stripped) + emptyParens(served);
      open += Number(!hasTerminalPunctuation(served));
      // The gated line the row actually stored is closed by the post-condition.
      const legacy = storedCardSurface({ gated: input.gated, raw: stripped, quiet: false, verdict: input.verdict });
      if (input.gated.startsWith("The keeper")) {
        expect(legacy.caption).toBe("The keeper is beaten.");
      }
      open += Number(!hasTerminalPunctuation(legacy.caption || "x"));
    }
    expect({ parens, open }).toEqual({ parens: 0, open: 0 });
  });
});

describe("ADAAAA-8127 Defect B — negative arm: with the rules removed the artifacts return", () => {
  // Frozen pre-fix tidy: no empty-pair removal (`caption-grounding.ts` @ 8921543).
  const preFixTidy = (text: string) =>
    text
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/([,;:])\s*(?=[,.;:!?])/g, "")
      .replace(/^[\s,;:—–-]+/, "")
      .replace(/[\s,;:—–-]+$/, "")
      .trim();
  // Frozen pre-fix store-time candidate: the gated line, unclosed.
  const preFixCandidate = (gated: string) => captionForStoredLine(gated);

  it("reproduces `The scoreboard updates from 2-1 to 2-1 ().`", () => {
    const tagStripped = SCOREBOARD_RAW.replace(/;?\s*\b(?:scoreboard score change confirmed|score change confirmed)\b/gi, "");
    const broken = preFixTidy(tagStripped);
    expect(broken).toBe("The ball enters the net and the scoreboard updates from 2-1 to 2-1 ().");
    expect(emptyParens(broken)).toBe(1);
    // …and the shipped rules produce the closed form.
    expect(emptyParens(stripInternalTokens(SCOREBOARD_RAW))).toBe(0);
  });

  it("reproduces the bare `The keeper is beaten`", () => {
    expect(preFixCandidate(KEEPER_GATED)).toBe("The keeper is beaten");
    expect(hasTerminalPunctuation(preFixCandidate(KEEPER_GATED))).toBe(false);
    // …and the post-condition now closes it.
    expect(
      storedCardSurface({ gated: KEEPER_GATED, raw: KEEPER_RAW, quiet: false, verdict: "big_play" }).caption
    ).toBe(restoreTerminalPunctuation(KEEPER_GATED));
  });
});
