// ADAAAA-7145 + ADAAAA-7147: Tier-2 signal gate for the decide-observer.
// Verifies the pure gate predicate (escalatesToTier2 / windowHasSignal) and the
// ObserveDecider gate behaviour: a no-signal window is suppressed (no billable
// decide call), a signal window fires, and the gate is recall-safe (never starve
// a goal in an uncalibrated session). ADAAAA-7147 adds the calibration-free
// ball-velocity discriminator + quiet-uncalibrated suppression (the
// suppressQuietUncalibrated mode that makes the gate cut volume on a box with no
// goal-line/homography/scoreboard channel).
import { describe, it, expect } from "vitest";
import {
  escalatesToTier2,
  windowHasSignal,
  ObserveDecider,
  type PerFrameSeed,
} from "../src/observe-loop";

describe("escalatesToTier2 (ADAAAA-7145)", () => {
  it("escalates on any hard goal signal", () => {
    expect(escalatesToTier2({ ballInNet: true })).toBe(true);
    expect(escalatesToTier2({ goalCrossed: true })).toBe(true);
    expect(escalatesToTier2({ ballOutcome: "goal" })).toBe(true);
    expect(escalatesToTier2({ ballOutcome: "cross" })).toBe(true);
    expect(escalatesToTier2({ scoreBoardChanged: true })).toBe(true);
  });

  it("does NOT escalate on a reported non-goal (goalInfra active)", () => {
    expect(escalatesToTier2({ ballOutcome: "off_target", goalInfra: true })).toBe(false);
    expect(escalatesToTier2({ goalCrossed: false, goalInfra: true })).toBe(false);
    expect(escalatesToTier2({ scoreBoardChanged: false, goalInfra: true })).toBe(false);
  });

  it("escalates on a confident motion+audio burst even without geometry", () => {
    expect(escalatesToTier2({ motionBurst: true, audioBurst: true })).toBe(true);
  });

  it("does NOT escalate on a motion burst alone (the flood source)", () => {
    expect(escalatesToTier2({ motionBurst: true, goalInfra: true })).toBe(false);
  });

  it("recall-safe: no goal-signal channel judged -> escalate (never starve)", () => {
    // goalInfra absent/false => the goal-signal channel did not judge.
    expect(escalatesToTier2({ ballOutcome: "off_target" })).toBe(true);
    expect(escalatesToTier2(undefined)).toBe(false);
    expect(escalatesToTier2({ goalInfra: false })).toBe(true);
  });
});

describe("windowHasSignal (ADAAAA-7145)", () => {
  const seed = (signal: PerFrameSeed["signal"]): PerFrameSeed => ({ ts: 0, signal });

  it("true when any in-window seed escalates", () => {
    expect(windowHasSignal([seed(undefined), seed({ goalCrossed: true })])).toBe(true);
  });

  it("false when all seeds are explicitly no-signal (goalInfra active)", () => {
    expect(
      windowHasSignal([seed({ goalCrossed: false, goalInfra: true }), seed({ ballOutcome: "off_target", goalInfra: true })])
    ).toBe(false);
  });

  it("true when a bias hint carries a scoreboard change / goal attestation", () => {
    expect(windowHasSignal([seed(undefined)], [{ eventType: "GOAL", ts: 0, scoreBoardChanged: true }])).toBe(true);
  });
});

describe("escalatesToTier2 ball-velocity signal (ADAAAA-7147)", () => {
  it("escalates on a meaningful calibration-free ball velocity when a threshold is supplied", () => {
    expect(escalatesToTier2({ ballVelocity: { speedMps: 0.2 } }, { ballMinSpeedMps: 0.08 })).toBe(true);
    expect(escalatesToTier2({ ballVelocity: { speedMps: 0.08 } }, { ballMinSpeedMps: 0.08 })).toBe(true);
  });

  it("does NOT escalate on a slow ball below the threshold when suppress-quiet is on", () => {
    expect(escalatesToTier2({ ballVelocity: { speedMps: 0.04 } }, { ballMinSpeedMps: 0.08, suppressQuietUncalibrated: true })).toBe(false);
  });

  it("still recall-escalates a slow uncalibrated ball when suppress-quiet is off (recall-safe)", () => {
    // A threshold alone adds the fast-ball escalation signal but does NOT turn
    // on quiet suppression; an uncalibrated slow ball still escalates so a
    // genuine goal is never starved.
    expect(escalatesToTier2({ ballVelocity: { speedMps: 0.04 } }, { ballMinSpeedMps: 0.08 })).toBe(true);
  });

  it("ignores ball velocity entirely when no threshold is supplied (pre-7147 behaviour)", () => {
    // Without opts the uncalibrated recall-safe branch still escalates the
    // window, but for recall-safety, NOT because the ball is fast.
    expect(escalatesToTier2({ ballVelocity: { speedMps: 0.9 } })).toBe(true);
  });

  it("suppressQuietUncalibrated drops a quiet uncalibrated window with no meaningful ball", () => {
    expect(escalatesToTier2({ ballVelocity: { speedMps: 0.02 } }, { ballMinSpeedMps: 0.08, suppressQuietUncalibrated: true })).toBe(false);
    expect(escalatesToTier2({}, { ballMinSpeedMps: 0.08, suppressQuietUncalibrated: true })).toBe(false);
  });

  it("suppressQuietUncalibrated still escalates a fast ball / goal signal / motion+audio", () => {
    const opts = { ballMinSpeedMps: 0.08, suppressQuietUncalibrated: true } as const;
    expect(escalatesToTier2({ ballVelocity: { speedMps: 0.4 } }, opts)).toBe(true);
    expect(escalatesToTier2({ goalCrossed: true }, opts)).toBe(true);
    expect(escalatesToTier2({ motionBurst: true, audioBurst: true }, opts)).toBe(true);
  });
});

describe("windowHasSignal ball-velocity (ADAAAA-7147)", () => {
  const seed = (signal: PerFrameSeed["signal"]): PerFrameSeed => ({ ts: 0, signal });

  it("suppress-quiet: a fast-ball seed escalates, a quiet uncalibrated window is suppressed", () => {
    const opts = { ballMinSpeedMps: 0.08, suppressQuietUncalibrated: true } as const;
    expect(windowHasSignal([seed({ ballVelocity: { speedMps: 0.2 } })], [], opts)).toBe(true);
    expect(windowHasSignal([seed({ ballVelocity: { speedMps: 0.02 } })], [], opts)).toBe(false);
  });
});

describe("ObserveDecider signal gate (ADAAAA-7145)", () => {
  it("suppresses the decide call on a no-signal window and counts it", async () => {
    let fired = 0;
    const d = new ObserveDecider({
      cadenceS: 3,
      windowS: 10,
      maxFrames: 30,
      fps: 2,
      signalGate: true,
      onDecide: async () => {
        fired++;
        return false;
      },
    });
    // 20 frames across 0..10s, ALL explicitly no-signal (goalInfra active).
    for (let ts = 0; ts <= 10; ts += 1) {
      d.record(ts, "img", { ts, signal: { goalCrossed: false, goalInfra: true } });
      await d.maybeFire(ts);
    }
    expect(fired).toBe(0);
    expect(d.decideCalls()).toBe(0);
    expect(d.gatedSkipCount()).toBeGreaterThan(0);
  });

  it("fires the decide call when the window has a real signal", async () => {
    let fired = 0;
    const d = new ObserveDecider({
      cadenceS: 3,
      windowS: 10,
      maxFrames: 30,
      fps: 2,
      signalGate: true,
      onDecide: async () => {
        fired++;
        return true;
      },
    });
    for (let ts = 0; ts <= 10; ts += 1) {
      // An explicit non-goal signal on every frame except a goal at ts=5.
      const signal: PerFrameSeed["signal"] =
        ts === 5 ? { goalCrossed: true } : { goalCrossed: false, goalInfra: true };
      d.record(ts, "img", { ts, signal });
      await d.maybeFire(ts);
    }
    expect(fired).toBeGreaterThan(0);
    expect(d.decideCalls()).toBeGreaterThan(0);
  });

  it("behaves exactly as before when signalGate is off (cadence always fires)", async () => {
    let fired = 0;
    const d = new ObserveDecider({
      cadenceS: 3,
      windowS: 10,
      maxFrames: 30,
      fps: 2,
      signalGate: false,
      onDecide: async () => {
        fired++;
        return false;
      },
    });
    for (let ts = 0; ts <= 10; ts += 1) {
      d.record(ts, "img", { ts, signal: { goalCrossed: false, goalInfra: true } });
      await d.maybeFire(ts);
    }
    expect(fired).toBeGreaterThan(0);
    expect(d.gatedSkipCount()).toBe(0);
  });
});

describe("ObserveDecider ball-velocity gate (ADAAAA-7147)", () => {
  it("suppress-quiet: a quiet uncalibrated window is suppressed and counted", async () => {
    let fired = 0;
    const d = new ObserveDecider({
      cadenceS: 3,
      windowS: 10,
      maxFrames: 30,
      fps: 2,
      signalGate: true,
      signalGateOpts: { ballMinSpeedMps: 0.08, suppressQuietUncalibrated: true },
      onDecide: async () => {
        fired++;
        return false;
      },
    });
    for (let ts = 0; ts <= 10; ts += 1) {
      d.record(ts, "img", { ts, signal: { ballVelocity: { speedMps: 0.02 } } });
      await d.maybeFire(ts);
    }
    expect(fired).toBe(0);
    expect(d.decideCalls()).toBe(0);
    expect(d.gatedSkipCount()).toBeGreaterThan(0);
  });

  it("suppress-quiet: fires on a window with a meaningful ball velocity", async () => {
    let fired = 0;
    const d = new ObserveDecider({
      cadenceS: 3,
      windowS: 10,
      maxFrames: 30,
      fps: 2,
      signalGate: true,
      signalGateOpts: { ballMinSpeedMps: 0.08, suppressQuietUncalibrated: true },
      onDecide: async () => {
        fired++;
        return true;
      },
    });
    for (let ts = 0; ts <= 10; ts += 1) {
      // A quiet frame everywhere except a fast ball at ts=5 (the goal approach).
      const signal: PerFrameSeed["signal"] =
        ts === 5 ? { ballVelocity: { speedMps: 0.6 } } : { ballVelocity: { speedMps: 0.02 } };
      d.record(ts, "img", { ts, signal });
      await d.maybeFire(ts);
    }
    expect(fired).toBeGreaterThan(0);
    expect(d.decideCalls()).toBeGreaterThan(0);
  });
});
