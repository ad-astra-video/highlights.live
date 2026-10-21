// ADAAAA-7145: Tier-2 signal gate for the decide-observer.
// Verifies the pure gate predicate (escalatesToTier2 / windowHasSignal) and the
// ObserveDecider gate behaviour: a no-signal window is suppressed (no billable
// decide call), a signal window fires, and the gate is recall-safe (never starve
// a goal in an uncalibrated session).
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
