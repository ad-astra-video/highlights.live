// ADAAAA-8714 (AC2/AC3): ONE placement decision for the delivered window.
//
// AC1 measured the mechanism on the stored corpus (2026-11-12, read-only psql on
// the box): 202 `measured_transition` rows all sit at exactly 7.000 s of a 15 s
// card (0.467 d — ACC-2 holds), while every reaction row (`peak_audio_reaction`,
// `peak_audio_far_burst_capped`, `peak_audio_far_rejected`, `trigger_evidence`)
// ALSO sits at 7.000 s and can name no goal instant at all. The card was centred
// on the crowded roar, and the newest leg that names a goal instant (5cc78c08)
// shows the failure shape: reaction row @473.900 s, the leg's own measured
// transition @458.667 s sits 8.233 s BEFORE that card's start — the goal is not
// in the clip.
//
// The ruling: a reaction cue with no goal instant ENDS the card
// (`[cue - (window - tail), cue + tail]`, tail 1.5-2 s, length unchanged). A row
// that names its goal instant keeps the ADAAAA-8152 placement byte-for-byte.
import { describe, it, expect } from "vitest";
import {
  CELEBRATION_TAIL_MAX_S,
  CELEBRATION_TAIL_MIN_S,
  CELEBRATION_TAIL_S,
  GOAL_INSTANT_ANCHORS,
  placeLiveClipWindow,
} from "../src/clip-placement.js";
import { clipWindow } from "../src/config.js";

/** The live rail's defaults: 7 s before / 8 s after, 15 s floor. */
const nominal = (cue: number) => clipWindow(cue, 7, 8, 15);

describe("placeLiveClipWindow — celebration tail (AC2)", () => {
  it("puts the cue at the END of the card for a reaction anchor with no goal instant", () => {
    const cue = 473.9;
    const placed = placeLiveClipWindow({
      localizedTs: cue,
      anchorReason: "peak_audio_reaction",
      window: nominal(cue),
      live: true,
    });
    // [cue - 13, cue + 2] on a 15 s card: the whole judged window `[cue-10, cue]`
    // plus the reaction lands inside it.
    expect(placed.reason).toBe("celebration_tail");
    expect(placed.start).toBeCloseTo(cue - 13, 6);
    expect(placed.end).toBeCloseTo(cue + 2, 6);
    expect(placed.end - placed.start).toBeCloseTo(15, 6);
    // AC2 thresholds: cue >= clipWindowSec - 2.5 and card start >= 13 s before it.
    expect(placed.cueOffsetSec).toBeGreaterThanOrEqual(15 - 2.5);
    expect(placed.cueOffsetSec).toBeCloseTo(13, 6);
    expect(placed.celebrationOffsetSec).toBeCloseTo(13, 6);
    expect(cue - placed.start).toBeGreaterThanOrEqual(13);
    expect(placed.reactionCue).toBe(true);
  });

  it("classifies every reaction/celebration anchor reason as a tail cue", () => {
    for (const reason of [
      "peak_audio_reaction",
      "peak_audio_far_burst_capped",
      "peak_audio_far_rejected",
      "trigger_evidence",
      undefined,
      null,
      "unknown_reason",
    ]) {
      const placed = placeLiveClipWindow({
        localizedTs: 100,
        anchorReason: reason as any,
        window: nominal(100),
        live: true,
      });
      expect(placed.reason).toBe("celebration_tail");
      expect(placed.cueOffsetSec).toBeCloseTo(100 - 87, 6);
    }
  });

  it("keeps the cue inside the window - 2.5 s band for any tail override", () => {
    const dur = 15;
    for (const tailS of [0, 0.2, CELEBRATION_TAIL_MIN_S, CELEBRATION_TAIL_S, 2.5, 9, NaN]) {
      const placed = placeLiveClipWindow({ localizedTs: 200, anchorReason: "peak_audio_reaction", window: nominal(200), live: true, tailS });
      expect(placed.cueOffsetSec).toBeGreaterThanOrEqual(dur - CELEBRATION_TAIL_MAX_S);
      expect(placed.cueOffsetSec).toBeLessThanOrEqual(dur - CELEBRATION_TAIL_MIN_S);
      expect(placed.end - placed.start).toBeCloseTo(dur, 6);
    }
  });

  it("keeps the LENGTH when the cue is too early to hold 13 s of pre-roll", () => {
    // A share only 4 s old: nothing before t=0 exists, so the card slides forward
    // instead of going short (the >= 15 s floor is not spent on a clamp).
    const placed = placeLiveClipWindow({ localizedTs: 4, anchorReason: "peak_audio_reaction", window: nominal(4), live: true });
    expect(placed.reason).toBe("celebration_tail");
    expect(placed.start).toBe(0);
    expect(placed.end).toBeCloseTo(15, 6);
    expect(placed.cueOffsetSec).toBeCloseTo(4, 6);
    expect(placed.celebrationOffsetSec).toBeCloseTo(4, 6);
  });
});

describe("placeLiveClipWindow — goal-bearing rows are untouched (AC3)", () => {
  it("keeps the ADAAAA-8152 window for a measured transition (offset 7 of 15)", () => {
    for (const reason of [...GOAL_INSTANT_ANCHORS]) {
      const cue = 158.667;
      const placed = placeLiveClipWindow({ localizedTs: cue, anchorReason: reason, window: nominal(cue), live: true });
      expect(placed.reason).toBe("goal_anchor");
      expect(placed.start).toBeCloseTo(cue - 7, 6);
      expect(placed.end).toBeCloseTo(cue + 8, 6);
      expect(placed.cueOffsetSec).toBeCloseTo(7, 6);
      expect(placed.celebrationOffsetSec).toBeUndefined();
      expect(placed.reactionCue).toBe(false);
    }
  });

  it("lets a caller-nameable goal instant win over the anchor reason", () => {
    const cue = 500;
    const placed = placeLiveClipWindow({
      localizedTs: cue,
      anchorReason: "peak_audio_reaction",
      knownGoalTs: 500, // a credited transition read elsewhere
      window: nominal(cue),
      live: true,
    });
    expect(placed.reason).toBe("goal_anchor");
    expect(placed.start).toBeCloseTo(cue - 7, 6);
  });

  it("never ships a card that does not contain the goal instant it names", () => {
    const cue = 500;
    const placed = placeLiveClipWindow({
      localizedTs: cue,
      anchorReason: "measured_transition",
      knownGoalTs: 480, // 20 s before the nominal window start
      window: nominal(cue),
      live: true,
    });
    expect(placed.reason).toBe("goal_anchor");
    expect(placed.start).toBeCloseTo(480 - 7, 6);
    expect(placed.end - placed.start).toBeCloseTo(15, 6);
    expect(480).toBeGreaterThanOrEqual(placed.start);
    expect(480).toBeLessThanOrEqual(placed.end);
  });

  it("leaves the VOD rail's placement exactly as it was", () => {
    const cue = 123.1;
    for (const reason of ["peak_audio_reaction", "peak_audio_far_rejected", "trigger_evidence", "measured_transition"]) {
      const placed = placeLiveClipWindow({ localizedTs: cue, anchorReason: reason, window: nominal(cue), live: false });
      expect(placed.start).toBeCloseTo(cue - 7, 6);
      expect(placed.end).toBeCloseTo(cue + 8, 6);
      expect(placed.reason).toBe(reason === "measured_transition" ? "goal_anchor" : "evidence_anchor");
    }
  });

  it("preserves the window length and the >= 15 s floor on every path", () => {
    const cases: Array<{ cue: number; reason: string; live: boolean }> = [
      { cue: 12, reason: "peak_audio_reaction", live: true },
      { cue: 4, reason: "peak_audio_reaction", live: true },
      { cue: 473.9, reason: "trigger_evidence", live: true },
      { cue: 158.667, reason: "measured_transition", live: true },
      { cue: 158.667, reason: "frame_attestation", live: true },
      { cue: 900, reason: "peak_audio_reaction", live: false },
    ];
    for (const c of cases) {
      const placed = placeLiveClipWindow({ localizedTs: c.cue, anchorReason: c.reason, window: nominal(c.cue), live: c.live });
      expect(placed.end - placed.start).toBeCloseTo(15, 6);
      expect(placed.start).toBeGreaterThanOrEqual(0);
    }
  });
});
