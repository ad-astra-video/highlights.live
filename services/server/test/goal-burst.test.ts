import { describe, it, expect } from "vitest";
import { LiveRunShared, DEFAULT_GOAL_BURST_SUPPRESS_S } from "../src/analyzer";

describe("LiveRunShared.suppressIfGoalBurst (ADAAAA-6610)", () => {
  it("accepts the first GOAL and a spaced GOAL beyond the window", () => {
    const s = new LiveRunShared();
    expect(s.suppressIfGoalBurst(2, "GOAL")).toBe(false); // first goal accepted
    expect(s.suppressIfGoalBurst(40, "GOAL")).toBe(false); // 38s later > 30s
  });

  it("suppresses a GOAL within the burst window of the last accepted goal", () => {
    const s = new LiveRunShared();
    expect(s.suppressIfGoalBurst(2, "GOAL")).toBe(false);
    expect(s.suppressIfGoalBurst(10, "GOAL")).toBe(true); // 8s later
    expect(s.suppressIfGoalBurst(20, "GOAL")).toBe(true); // still within 30s of t=2
  });

  it("does not let a suppressed burst extend itself (reference stays at accepted goal)", () => {
    const s = new LiveRunShared();
    expect(s.suppressIfGoalBurst(2, "GOAL")).toBe(false);
    expect(s.suppressIfGoalBurst(10, "GOAL")).toBe(true);
    expect(s.suppressIfGoalBurst(20, "GOAL")).toBe(true);
    // 33s after the ACCEPTED goal (t=2) => outside window, accepted again.
    expect(s.suppressIfGoalBurst(35, "GOAL")).toBe(false);
  });

  it("never suppresses a non-GOAL event", () => {
    const s = new LiveRunShared();
    expect(s.suppressIfGoalBurst(2, "BIG_SAVE")).toBe(false);
    expect(s.suppressIfGoalBurst(3, "NEAR_MISS")).toBe(false);
    expect(s.suppressIfGoalBurst(4, "DUNK")).toBe(false);
  });

  it("applies the configured window, not just the default", () => {
    const s = new LiveRunShared({ goalBurstWindowS: 10 });
    expect(s.suppressIfGoalBurst(5, "GOAL")).toBe(false);
    expect(s.suppressIfGoalBurst(12, "GOAL")).toBe(true); // 7s < 10s
    expect(s.suppressIfGoalBurst(20, "GOAL")).toBe(false); // 15s > 10s
  });

  it("default window is 30s", () => {
    expect(DEFAULT_GOAL_BURST_SUPPRESS_S).toBe(30);
  });
});
