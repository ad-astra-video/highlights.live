// ADAAAA-7965 (contract v5 §3.1–§3.4): the write-seam resolvers that feed the
// caption gate on the fast rail.
//
// These are the three facts v4 could not see and Inc 9 adds:
//   - the per-window audio-noise signal a colour beat is DERIVED from (R18),
//     with the frame that confirms it;
//   - the stored place a lead ships with when the model names none (R19);
//   - the window's own evidence for an absence claim (R21).
// All three are CPU-only reads of state the pipeline already holds: no decide
// call, no new frame, no perception pass, no prompt change.
import { describe, it, expect } from "vitest";
import { colourBeatFromSignal } from "@highlights/events";
import { windowAbsenceEvidence, windowColourSignal, windowPlace } from "../src/analyzer";

/** A run whose audio series is the given taps (stream seconds, RMS energy). */
const runWith = (taps: { t: number; energy: number }[]) => ({
  seriesWindow: () => taps.map((p) => ({ ...p, baseline: 0.05 })),
});

const cfg = { preWindowS: 2, postWindowS: 4, sampleFps: 3, analysisFps: 3, getRunningSummary: () => "" };

describe("windowColourSignal (§3.1, R18)", () => {
  // A short burst: one peak tap, a low median, no plateau.
  const burst = [
    { t: 10.0, energy: 0.05 },
    { t: 10.1, energy: 0.06 },
    { t: 10.2, energy: 0.05 },
    { t: 10.3, energy: 0.05 },
    { t: 10.4, energy: 0.4 },
    { t: 10.5, energy: 0.06 },
    { t: 10.6, energy: 0.05 },
    { t: 10.7, energy: 0.05 },
  ];
  const frames = [
    { ts: 9, seq: 27 },
    { ts: 10.4, seq: 31 },
    { ts: 12, seq: 36 },
  ];

  it("attaches the measured ratio, the plateau share and the confirming frame", () => {
    const sig = windowColourSignal(runWith(burst), 10.3, cfg, frames);
    expect(sig).not.toBeNull();
    expect(sig!.signal).toBe("audio_noise");
    expect(sig!.peak).toBeCloseTo(0.4);
    expect(sig!.ratio).toBeGreaterThan(4);
    expect(sig!.sustained).toBeCloseTo(1 / 8);
    expect(sig!.peakT).toBeCloseTo(10.4);
    expect(sig!.frameTs).toBeCloseTo(10.4);
    expect(sig!.frameSeq).toBe(31);
    expect(colourBeatFromSignal(sig)).toBe("noise lifts, then settles");
  });

  it("returns null when the window has no stored frame to confirm the instant", () => {
    expect(windowColourSignal(runWith(burst), 10.3, cfg, [])).toBeNull();
    expect(windowColourSignal(runWith(burst), 10.3, cfg, undefined)).toBeNull();
  });

  it("returns null when the window has too little energy or too few taps", () => {
    expect(windowColourSignal(runWith(burst.map((p) => ({ ...p, energy: 0.1 }))), 10.3, cfg, frames)).toBeNull();
    expect(windowColourSignal(runWith(burst.slice(0, 3)), 10.3, cfg, frames)).toBeNull();
  });

  it("does not turn a sustained plateau into a beat", () => {
    const plateau = Array.from({ length: 10 }, (_v, i) => ({ t: 10 + i / 10, energy: 0.3 }));
    const sig = windowColourSignal(runWith(plateau), 10.5, cfg, frames);
    expect(sig).not.toBeNull();
    expect(sig!.sustained).toBe(1);
    expect(colourBeatFromSignal(sig)).toBe("");
  });

  it("derives wording as a function of the measured ratio, never of a model clause", () => {
    const spike = burst.map((p) => (p.t === 10.4 ? { ...p, energy: 0.9 } : p));
    expect(colourBeatFromSignal(windowColourSignal(runWith(spike), 10.3, cfg, frames))).toBe(
      "noise spikes over the play"
    );
  });
});

describe("windowPlace (§3.2, R19)", () => {
  it("maps the tracked ball position to a coarse, frame-verifiable place", () => {
    expect(windowPlace({ ballPosition: () => [0.1, 0.5] }, 12, cfg)).toBe("on the left");
    expect(windowPlace({ ballPosition: () => [0.9, 0.5] }, 12, cfg)).toBe("on the right");
    expect(windowPlace({ ballPosition: () => [0.5, 0.4] }, 12, cfg)).toBe("in midfield");
    expect(windowPlace({ ballPosition: () => [0.5, 0.9] }, 12, cfg)).toBe("near the touchline");
  });

  it("falls back to the last stored possession line when no ball is tracked", () => {
    const withLine = { ...cfg, getRunningSummary: () => "Kick-off.\nYamal carries ball into penalty area." };
    expect(windowPlace({ ballPosition: () => undefined }, 12, withLine)).toBe("in penalty area");
  });

  it("resolves nothing (empty) when neither the frames nor the stored line name a place", () => {
    expect(windowPlace({ ballPosition: () => undefined }, 12, cfg)).toBe("");
  });
});

describe("windowAbsenceEvidence (§3.4, R21)", () => {
  it("never evidences an absence on a goal window", () => {
    expect(windowAbsenceEvidence({ ballOutcome: "out" }, "scoring_play")).toBe(false);
  });

  it("needs a positive out-of-play attestation or an explicit frame pair", () => {
    expect(windowAbsenceEvidence({ ballOutcome: "off_target" }, "near_miss")).toBe(true);
    expect(windowAbsenceEvidence({ ballOutcome: "saved" }, "not_highlight")).toBe(true);
    // Ball across the line -> the opposite of an absence.
    expect(windowAbsenceEvidence({ ballOutcome: "goal", goalCrossed: true }, "near_miss")).toBe(false);
    // Two agreeing frame signals.
    expect(
      windowAbsenceEvidence(
        { seeds: [{ signal: { ballInNet: false, goalCrossed: false } }] },
        "near_miss"
      )
    ).toBe(true);
    // No evidence at all -> fail closed.
    expect(windowAbsenceEvidence({}, "near_miss")).toBe(false);
  });
});
