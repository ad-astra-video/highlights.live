// ADAAAA-7995 (follow-up of the ADAAAA-7980 served-reading QA) — the residuals that
// were still shipping on the v3 build `334fe57`, pinned at the shared gate:
//
//   §2  a claim removed mid-clause left its introducing verb behind, so the quiet
//       shape glued the outcome verb onto a half-clause:
//       `The ball clearly enters the net and the keeper is beaten.` -> `The ball
//       clearly enters the shoots in midfield`. And a stored-zone injection landed
//       AFTER a sentence's terminal period: `… reflect a shot. on the right`.
//   AC4 a quiet (`not_highlight`) row carried `— noise spikes over the play`
//       (the v5 40% share) and rose to 12-14 words against an 8-word bar.
//   AC1 display de-dup had no way to see a beat the WRITE seam produced: two
//       distinct claims gated to one non-goal beat are stored twice (`text` gated,
//       `text_raw` kept) and both look untouched at read time.
import { describe, it, expect } from "vitest";
import {
  captionColour,
  captionLineKey,
  colourBeatFromSignal,
  dedupeDisplayLines,
  ensureLeadPlace,
  gateQuietWindow,
  groundCaption,
  hasGoalClaim,
  quietShape,
  QUIET_MAX_WORDS,
  type ColourSignal,
} from "../src/caption-grounding";

const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** A firing audio-noise signal (ratio 11 -> `noise spikes over the play`). */
const SIGNAL: ColourSignal = {
  signal: "audio_noise",
  ratio: 11,
  sustained: 0.2,
  peak: 0.4,
  peakT: 12,
  frameTs: 12,
  frameSeq: 36,
};

const QUIET = (place: string | null = "in midfield") =>
  ({ verdict: "not_highlight", promptText: "", place }) as const;

describe("§2 — a rewritten claim leaves a whole phrase, never a mangled one", () => {
  it("drops the verb whose object was the claim (no `enters the shoots`)", () => {
    // Verbatim measured: highlight 42abfcb4 on `6fe19ac5` and the T+119-134 row on
    // `47d8e506`, raw `The ball clearly enters the net and the keeper is beaten.`
    const raw = "The ball clearly enters the net and the keeper is beaten.";
    for (const [place, expected] of [
      ["in midfield", "The ball shoots in midfield"],
      ["in the box", "The ball shoots in the box"],
    ] as const) {
      const out = groundCaption(raw, { verdict: "not_highlight", promptText: "", place });
      expect(out).toBe(expected);
      expect(hasGoalClaim(out)).toBe(false);
      // The defect shapes must be unreachable.
      expect(out).not.toMatch(/enters?\s+(?:the\s+)?shoots?/i);
      expect(out).not.toMatch(/\benters?\s+the$/i);
    }
  });

  it("quietShape never ends on an open-object verb", () => {
    const out = quietShape("No. 8 clearly finds the back of the net");
    expect(out).not.toMatch(/\b(?:enters?|finds?|hits?)\s+the$/i);
    expect(wordCount(out)).toBeGreaterThan(0);
  });

  it("injects the stored place INSIDE the sentence, not after its period", () => {
    // Verbatim measured: PIPELINE DETAIL T+112-127 on `47d8e506`,
    // `The scoreboard updates to reflect a shot. on the right`.
    const out = groundCaption("The scoreboard updates to reflect a shot.", {
      verdict: "near_miss",
      promptText: "",
      place: "on the right",
    });
    expect(out).toBe("The scoreboard updates to reflect a shot on the right.");
    expect(out).not.toMatch(/\.\s+on the right/i);
    // ensureLeadPlace directly: a whole sentence keeps one terminal period.
    expect(ensureLeadPlace("The scoreboard updates to reflect a shot.", QUIET("on the right"))).toBe(
      "The scoreboard updates to reflect a shot on the right."
    );
    // A play lead with no terminal punctuation gets the place appended and keeps
    // no sentence break.
    expect(ensureLeadPlace("No. 9 drives toward the box", QUIET("in midfield"))).toBe(
      "No. 9 drives toward the box in midfield"
    );
  });
});

describe("AC4 — a quiet row carries no colour and stays inside 8 words", () => {
  it("drops the derived beat on a quiet window even when the signal fires", () => {
    const ctx = { ...QUIET("in the box"), colourSignal: SIGNAL };
    // The exact served row: `Player in blue kit dribbles in box — noise spikes
    // over the play` (12-13 words, colour on a `not_highlight` window).
    const out = groundCaption("Player in blue kit dribbles in box — noise spikes over the play", ctx);
    expect(out).toBe("Player in blue kit dribbles in box");
    expect(captionColour(out)).toBe("");
    expect(wordCount(out)).toBeLessThanOrEqual(QUIET_MAX_WORDS);
    // gateQuietWindow is idempotent on the clean row.
    expect(gateQuietWindow(out, ctx)).toBe(out);
  });

  it("keeps the derived beat on a LOUD window (the v5 channel is unchanged)", () => {
    const out = groundCaption("No. 3 drives into the box and shoots", {
      verdict: "near_miss",
      promptText: "",
      place: "in the box",
      colourSignal: SIGNAL,
    });
    expect(captionColour(out)).toBe(colourBeatFromSignal(SIGNAL));
    expect(captionColour(out)).toBe("noise spikes over the play");
  });

  it("never ships a beat on its own when the claim gate emptied the lead", () => {
    // Measured stored row on `6fe19ac5` seq 19 (`big_play`): the whole delivered
    // line was `noise spikes over the play`.
    const out = groundCaption("The ball enters the net — keeper beaten.", {
      verdict: "big_play",
      promptText: "",
      place: "in the box",
      colourSignal: SIGNAL,
    });
    // The claim took the whole lead with it, so there is no caption to ship: the
    // row drops (the append seam skips an empty grounded line) instead of becoming
    // a colour clause on its own.
    expect(out).toBe("");
    expect(captionLineKey(out)).not.toBe(captionLineKey("noise spikes over the play"));
  });
});

describe("AC1/AC2 — the display cap sees the WRITE seam's own collisions", () => {
  const twin = { text: "No. 7 strikes the ball wide on the left", gateProduced: true };

  it("keeps a gate-produced beat once, however many stored rows delivered it", () => {
    const kept = dedupeDisplayLines([
      { text: "Player in blue jersey dribbles in center field", gateProduced: false },
      { ...twin },
      { text: "No. 7 strikes the ball wide on the left", gateProduced: true },
      { text: "Yamal shoots in midfield", gateProduced: false },
    ]);
    expect(kept.map((l) => l.text)).toEqual([
      "Player in blue jersey dribbles in center field",
      "No. 7 strikes the ball wide on the left",
      "Yamal shoots in midfield",
    ]);
  });

  it("caps untouched repeats at one row per beat, keeping the first in story order", () => {
    const kept = dedupeDisplayLines([
      { text: "Player in white moves in center circle." },
      { text: "Player in blue jersey dribbles in center field" },
      { text: "  player in white moves in center circle  " },
      { text: "PLAYER IN WHITE MOVES IN CENTER CIRCLE!" },
    ]);
    expect(kept.map((l) => l.text)).toEqual([
      "Player in white moves in center circle.",
      "Player in blue jersey dribbles in center field",
    ]);
  });

  it("a gate-produced key is capped at 1 even when the caller passes a bigger max", () => {
    const kept = dedupeDisplayLines(
      [{ text: "X", gateProduced: true }, { text: "X", gateProduced: false }, { text: "X", gateProduced: true }],
      2
    );
    expect(kept).toHaveLength(1);
  });

  it("never drops a distinct row and is deterministic", () => {
    const lines = [
      { text: "A" },
      { text: "B" },
      { text: "C" },
      { text: "A" },
    ];
    expect(dedupeDisplayLines(lines).map((l) => l.text)).toEqual(["A", "B", "C"]);
    expect(dedupeDisplayLines(lines)).toEqual(dedupeDisplayLines(lines));
  });
});
