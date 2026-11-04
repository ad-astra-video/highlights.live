// ADAAAA-7937 — the numeric contract of the `audio_level` sound-levels graph:
// window-relative Y domain (AC2), hover/keyboard readout (AC4) and arrow-key
// stepping (AC7). Pure functions, node test env (no jsdom by convention).
import { describe, it, expect } from "vitest";
import {
  audioDp2,
  audioLevelCrossStep,
  audioLevelDomain,
  audioLevelReadout,
  nearestAudioLevelIndex,
} from "./audioLevel";

describe("audioLevelDomain (AC2 — window-relative, peak-anchored)", () => {
  it("is [min(0, minE), maxE]", () => {
    expect(audioLevelDomain([0.1, 0.55, 0.9, 0.3, 0.22, 0.68])).toEqual([0, 0.9]);
    expect(audioLevelDomain([0.04, 0.12, 0.04, 0.12])).toEqual([0, 0.12]);
  });

  it("keeps a negative minimum instead of clamping it to zero", () => {
    expect(audioLevelDomain([-0.2, 0.3])).toEqual([-0.2, 0.3]);
  });

  it("uses [0, max(1e-3, peak)] for flat input", () => {
    expect(audioLevelDomain([0.05, 0.05, 0.05])).toEqual([0, 0.05]);
    expect(audioLevelDomain([0, 0, 0])).toEqual([0, 0.001]);
  });

  it("never returns an inverted or zero-height domain", () => {
    for (const values of [[], [0], [0, 0], [-0.4, -0.4], [0.9]]) {
      const [lo, hi] = audioLevelDomain(values);
      expect(hi).toBeGreaterThan(lo);
    }
  });
});

describe("audioLevelReadout (AC4 — 2-dp mono readout)", () => {
  it("renders T+<ts>s · energy <v> · baseline <v> on a time axis", () => {
    expect(audioLevelReadout({ index: 0, count: 3, t: 8, energy: 0.1, baseline: 0.05 })).toBe(
      "T+8.00s · energy 0.10 · baseline 0.05"
    );
  });

  it("omits the baseline segment when the point has none", () => {
    expect(audioLevelReadout({ index: 2, count: 6, t: 10.5, energy: 0.9 })).toBe("T+10.50s · energy 0.90");
  });

  it("uses sample <i>/<n> when the series has no timestamps", () => {
    expect(audioLevelReadout({ index: 1, count: 4, energy: 0.12 })).toBe("sample 2/4 · energy 0.12");
  });

  it("formats every value at 2 dp", () => {
    expect(audioDp2(0.4567)).toBe("0.46");
    expect(audioDp2(0)).toBe("0.00");
    expect(audioLevelReadout({ index: 0, count: 1, energy: 0.005 })).toBe("sample 1/1 · energy 0.01");
  });
});

describe("audioLevelCrossStep (AC7 — Left/Right arrow stepping)", () => {
  it("enters at the active edge when no cross is active", () => {
    expect(audioLevelCrossStep(null, 1, 4)).toBe(0);
    expect(audioLevelCrossStep(null, -1, 4)).toBe(3);
  });

  it("steps by one and clamps at both ends", () => {
    expect(audioLevelCrossStep(0, 1, 4)).toBe(1);
    expect(audioLevelCrossStep(2, -1, 4)).toBe(1);
    expect(audioLevelCrossStep(0, -1, 4)).toBe(0);
    expect(audioLevelCrossStep(3, 1, 4)).toBe(3);
  });

  it("is safe for an empty series", () => {
    expect(audioLevelCrossStep(null, 1, 0)).toBe(0);
  });
});

describe("nearestAudioLevelIndex (AC4 — snap the cross to a real sample)", () => {
  it("picks the closest drawn x", () => {
    const xs = [0, 106.7, 213.3, 320];
    expect(nearestAudioLevelIndex(xs, 107)).toBe(1);
    expect(nearestAudioLevelIndex(xs, 0)).toBe(0);
    expect(nearestAudioLevelIndex(xs, 300)).toBe(3);
  });
});
