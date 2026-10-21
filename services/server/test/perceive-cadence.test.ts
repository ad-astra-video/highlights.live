// ADAAAA-7152 Gap 1: adaptive perceive cadence for the VOD detail-first pass.
// Verifies the pure, deterministic sampling/cost logic (no GPU, no network):
//  - cool (no-signal) regions are sampled at a reduced `quietStride` cadence so
//    the per-frame perceive pass is cut (the E2E cost driver);
//  - an escalated goal window is forced to FULL perceive treatment (never starved)
//    because the hot window is armed by the SAME Tier-2 gate predicate the decide
//    observer uses;
//  - a quiet clip never arms the hot window (no candidate flood);
//  - skipped (cool) frames carry NO fabricated signal, which is recall-safe at
//    the gate (absent signal escalates, never starves a genuine goal).
import { describe, it, expect } from "vitest";
import { PerceiveCadence, type PerceiveCadenceOptions } from "../src/perceive-cadence";
import { escalatesToTier2, windowHasSignal, type PerFrameSignal } from "../src/observe-loop";

/** Gate opts for all "meaningful ball" cases (matches the box's ADAAAA-7147 setup). */
const GATE: { ballMinSpeedMps: number; suppressQuietUncalibrated: boolean } = {
  ballMinSpeedMps: 0.08,
  suppressQuietUncalibrated: true,
};

/** Run a clip of `n` frames (integer content seconds) through the cadence,
 * feeding back each frame's signal (caller-supplied per-ts signal). Returns the
 * per-frame perceive decisions + the escalated timestamps seen. */
function runClip(
  n: number,
  signalAt: (ts: number) => PerFrameSignal,
  opts: PerceiveCadenceOptions
): { decisions: boolean[]; escalateTs: number[]; cadence: PerceiveCadence } {
  const cadence = new PerceiveCadence(opts);
  const decisions: boolean[] = [];
  const escalateTs: number[] = [];
  for (let ts = 0; ts < n; ts++) {
    const pick = cadence.shouldPerceive(ts);
    decisions.push(pick);
    const sig = signalAt(ts);
    if (escalatesToTier2(sig, GATE)) escalateTs.push(ts);
    cadence.noteFrameSignal(ts, sig, GATE);
  }
  return { decisions, escalateTs, cadence };
}

describe("PerceiveCadence cool-region reduction (ADAAAA-7152)", () => {
  it("perceives only every quietStride-th frame in a no-signal cool region (cost cut)", () => {
    const n = 20;
    const { decisions, cadence } = runClip(n, () => ({ ballVelocity: { speedMps: 0.01, homography: false } }), {
      quietStride: 2,
      hotAfterS: 5,
    });
    const perceived = decisions.filter(Boolean).length;
    // No signal -> no hot window.
    expect(cadence.state().hotUntilTs).toBeNull();
    // 20 cool frames at stride 2 -> 10 perceived (a 2x cut on the cool region).
    expect(perceived).toBe(10);
    // The exact indices cool cadence selects (deterministic).
    expect(decisions.filter((_, i) => i % 2 === 0)).toEqual(new Array(n / 2).fill(true));
    expect(decisions.filter((_, i) => i % 2 === 1)).toEqual(new Array(n / 2).fill(false));
  });

  it("stride 1 is a full pass (cadence disabled)", () => {
    const n = 6;
    const { decisions } = runClip(n, () => ({ ballVelocity: { speedMps: 0.01, homography: false } }), {
      quietStride: 1,
      hotAfterS: 3,
    });
    expect(decisions.every(Boolean)).toBe(true);
  });
});

describe("PerceiveCadence escalated goal window (ADAAAA-7152)", () => {
  it("arms a FULL-perceive hot window when the gate escalates, so the goal window is never starved", () => {
    const n = 30;
    // A genuine goal approach: ball fast at ts=10, quiet elsewhere.
    const { decisions, escalateTs } = runClip(
      n,
      (ts) =>
        ts === 10
          ? { ballVelocity: { speedMps: 0.5, homography: false } }
          : { ballVelocity: { speedMps: 0.01, homography: false } },
      { quietStride: 2, hotAfterS: 5 }
    );
    expect(escalateTs).toEqual([10]);
    // The escalate frame itself is perceived (cool cadence picked ts=10).
    expect(decisions[10]).toBe(true);
    // Every frame inside [escalateTs, escalateTs + hotAfterS] is FULL-perceived.
    for (let ts = 11; ts <= 15; ts++) expect(decisions[ts]).toBe(true);
    // After the hot window expires the cool cadence resumes (not all remaining hot).
    expect(decisions[16]).toBe(false);
  });

  it("extends the hot window when an already-hot frame escalates again", () => {
    const n = 30;
    const signalAt = (ts: number): PerFrameSignal =>
      ts === 10 || ts === 12
        ? { ballVelocity: { speedMps: 0.6, homography: false } }
        : { ballVelocity: { speedMps: 0.01, homography: false } };
    const { decisions } = runClip(n, signalAt, { quietStride: 2, hotAfterS: 5 });
    // First escalate at 10 -> hot 10..15; escalate again at 12 (already hot, so
    // guaranteed perceived) extends the window to 12..17.
    for (let ts = 16; ts <= 17; ts++) expect(decisions[ts]).toBe(true);
  });
});

describe("PerceiveCadence no-flood / recall-safety (ADAAAA-7152)", () => {
  it("a quiet clip never arms the hot window (no candidate flood)", () => {
    const n = 40;
    const { cadence, decisions } = runClip(n, () => ({ ballVelocity: { speedMps: 0.01, homography: false } }), {
      quietStride: 2,
      hotAfterS: 5,
    });
    expect(cadence.state().hotUntilTs).toBeNull();
    // 40 cool frames -> 20 perceived, far fewer than the full pass the cadence replaces.
    expect(decisions.filter(Boolean).length).toBe(20);
  });

  it("a skipped (cool) frame carries NO signal, which the gate treats as recall-safe", () => {
    // A cool frame that was never perceived has signal `undefined` in its seed.
    // escalatesToTier2(undefined) is false, but a window containing an escalated
    // frame still escalates — so omission can never suppress a genuine goal.
    expect(escalatesToTier2(undefined, GATE)).toBe(false);
    const window = [{ signal: undefined }, { signal: { ballVelocity: { speedMps: 0.5, homography: false } } }];
    expect(windowHasSignal(window, [], GATE)).toBe(true);
    // An empty no-signal seed does NOT itself fabricate a goal signal, but a
    // no-signal frame with no goal channel judged recall-escalates by default
    // (never starve a genuine goal in an uncalibrated session) — unchanged by
    // the cadence. With suppress-quiet ON it is dropped instead (ADAAAA-7147).
    expect(escalatesToTier2(undefined, {})).toBe(false);
    expect(escalatesToTier2({}, {})).toBe(true);
    expect(escalatesToTier2({}, GATE)).toBe(false);
  });
});
