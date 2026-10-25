import { describe, it, expect } from "vitest";
import { LiveRunShared, DEFAULT_GOAL_BURST_SUPPRESS_S, SHOOTOUT_KICK_DEDUP_S } from "../src/analyzer";

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

describe("LiveRunShared.suppressIfGoalBurst shootout-aware (ADAAAA-7402/7420)", () => {
  it("tight window is 8s for scoreboard-corroborated goals", () => {
    expect(SHOOTOUT_KICK_DEDUP_S).toBe(8);
    expect(SHOOTOUT_KICK_DEDUP_S).toBeLessThan(DEFAULT_GOAL_BURST_SUPPRESS_S);
  });

  it("does NOT suppress a DISTINCT corroborated conversion >= 8s after the last accepted goal (AC2)", () => {
    const s = new LiveRunShared();
    // Consecutive penalty conversions, each 13-18s apart (real shootout cadence).
    // Each must NOT be burst-suppressed because each is >= SHOOTOUT_KICK_DEDUP_S (8s)
    // from the PRIOR accepted conversion (the reference).
    expect(s.suppressIfGoalBurst(588, "GOAL", { corroborated: true })).toBe(false); // first, ref -> 588
    expect(s.suppressIfGoalBurst(601, "GOAL", { corroborated: true })).toBe(false); // +13s, ref -> 601
    expect(s.suppressIfGoalBurst(614, "GOAL", { corroborated: true })).toBe(false); // +13s, ref -> 614
    expect(s.suppressIfGoalBurst(627, "GOAL", { corroborated: true })).toBe(false); // +13s, ref -> 627
    expect(s.suppressIfGoalBurst(640, "GOAL", { corroborated: true })).toBe(false); // +13s, ref -> 640
  });

  it("still dedups an ADJACENT same-kick re-read < 8s of a corroborated accepted goal (AC4)", () => {
    const s = new LiveRunShared();
    expect(s.suppressIfGoalBurst(588, "GOAL", { corroborated: true })).toBe(false); // accepted, ref -> 588
    expect(s.suppressIfGoalBurst(591, "GOAL", { corroborated: true })).toBe(true); // 3s re-read of same kick
    expect(s.suppressIfGoalBurst(595, "GOAL", { corroborated: true })).toBe(true); // 7s re-read, ref still 588
    // A distinct conversion >= 8s from the reference still surfaces (ref -> 596).
    expect(s.suppressIfGoalBurst(596, "GOAL", { corroborated: true })).toBe(false); // 8s from t=588
  });

  it("keeps the full 30s regulation window for goals WITHOUT scoreboard corroboration (confabulated-burst guard)", () => {
    const s = new LiveRunShared();
    expect(s.suppressIfGoalBurst(2, "GOAL")).toBe(false); // accepted, ref -> 2
    // A non-corroborated GOAL 10s later is still suppressed (30s window intact).
    expect(s.suppressIfGoalBurst(12, "GOAL")).toBe(true); // 10s < 30s
    expect(s.suppressIfGoalBurst(30, "GOAL")).toBe(true); // 28s < 30s
    expect(s.suppressIfGoalBurst(33, "GOAL")).toBe(false); // 31s after t=2, outside 30s; ref -> 33
  });

  it("uses the per-goal window: a corroborated goal narrows, an uncorroborated goal keeps 30s", () => {
    const s = new LiveRunShared();
    expect(s.suppressIfGoalBurst(588, "GOAL", { corroborated: true })).toBe(false); // accepted, ref -> 588
    // A corroborated conversion 13s later (distinct kick) is NOT suppressed (8s window).
    expect(s.suppressIfGoalBurst(601, "GOAL", { corroborated: true })).toBe(false); // 13s > 8s; ref -> 601
    // A corroborated re-read of the SAME kick 4s later IS suppressed (8s window).
    expect(s.suppressIfGoalBurst(605, "GOAL", { corroborated: true })).toBe(true); // 4s < 8s
    // An un-corroborated goal 13s after 601 keeps the FULL 30s window -> suppressed.
    const s2 = new LiveRunShared();
    expect(s2.suppressIfGoalBurst(601, "GOAL", { corroborated: true })).toBe(false); // accepted, ref -> 601
    expect(s2.suppressIfGoalBurst(614, "GOAL")).toBe(true); // uncorroborated, 13s < 30s
  });
});
