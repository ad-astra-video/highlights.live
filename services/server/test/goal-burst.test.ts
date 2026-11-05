import { describe, it, expect } from "vitest";
import {
  LiveRunShared,
  DEFAULT_GOAL_BURST_SUPPRESS_S,
  SHOOTOUT_KICK_DEDUP_S,
  formatGoalBurstSuppressionReason,
} from "../src/analyzer";

// ADAAAA-8140: the burst lane is now a SAME-TRANSITION dedupe against the run's
// ledger of DELIVERED scoring GOALs, not a timestamp stamped at check time. A
// goal-shaped row that never shipped as a GOAL (a demoted celebration, a failed
// cut) can therefore never suppress a later real goal, and every suppression
// names the row it deduped against.

/** Record a DELIVERED scoring GOAL (the only thing that may suppress). */
function delivered(
  s: LiveRunShared,
  ts: number,
  opts: { id?: string; transitionKey?: string | null } = {}
): void {
  s.noteAcceptedGoalEvent({
    highlightId: opts.id ?? `hl-${ts}`,
    anchorTs: ts - 2,
    start: ts - 10,
    end: ts + 5,
    candidateTs: ts,
    transitionKey: opts.transitionKey ?? null,
    idempotencyKey: `hl:job:${ts}:GOAL`,
  });
}

describe("LiveRunShared.goalBurstSuppression (ADAAAA-6610/8140)", () => {
  it("never suppresses the first GOAL, or a GOAL beyond the window", () => {
    const s = new LiveRunShared();
    expect(s.goalBurstSuppression({ ts: 2, eventType: "GOAL" })).toBeUndefined();
    delivered(s, 2);
    expect(s.goalBurstSuppression({ ts: 40, eventType: "GOAL" })).toBeUndefined(); // 38s > 30s
  });

  it("suppresses a re-read inside the window and names the delivered goal", () => {
    const s = new LiveRunShared();
    delivered(s, 2, { id: "hl-a", transitionKey: "1-1>2-1" });
    const sup = s.goalBurstSuppression({ ts: 10, eventType: "GOAL" });
    expect(sup).toBeDefined();
    expect(sup!.kind).toBe("goal_burst_same_transition");
    expect(sup!.dedupeAgainstHighlightId).toBe("hl-a");
    expect(sup!.dedupeAgainstTs).toBe(2);
    expect(sup!.dedupeAgainstIdempotencyKey).toBe("hl:job:2:GOAL");
    expect(sup!.gapS).toBe(8);
    expect(sup!.windowS).toBe(DEFAULT_GOAL_BURST_SUPPRESS_S);
    expect(sup!.transitionKey).toBe("1-1>2-1");
  });

  it("does not let a suppressed burst extend itself (reference stays on the delivered goal)", () => {
    const s = new LiveRunShared();
    delivered(s, 2);
    expect(s.goalBurstSuppression({ ts: 10, eventType: "GOAL" })?.burstSize).toBe(1);
    expect(s.goalBurstSuppression({ ts: 20, eventType: "GOAL" })?.burstSize).toBe(2);
    // 33s after the DELIVERED goal (t=2) => outside the window.
    expect(s.goalBurstSuppression({ ts: 35, eventType: "GOAL" })).toBeUndefined();
  });

  it("never suppresses a non-GOAL event", () => {
    const s = new LiveRunShared();
    delivered(s, 2);
    expect(s.goalBurstSuppression({ ts: 3, eventType: "BIG_SAVE" })).toBeUndefined();
    expect(s.goalBurstSuppression({ ts: 4, eventType: "NEAR_MISS" })).toBeUndefined();
    expect(s.goalBurstSuppression({ ts: 5, eventType: "DUNK" })).toBeUndefined();
  });

  it("applies the configured window, not just the default", () => {
    const s = new LiveRunShared({ goalBurstWindowS: 10 });
    delivered(s, 5);
    expect(s.goalBurstSuppression({ ts: 12, eventType: "GOAL" })?.windowS).toBe(10); // 7s < 10s
    expect(s.goalBurstSuppression({ ts: 20, eventType: "GOAL" })).toBeUndefined(); // 15s > 10s
  });

  it("default window is 30s", () => {
    expect(DEFAULT_GOAL_BURST_SUPPRESS_S).toBe(30);
  });
});

describe("goalBurstSuppression: pre-accept loss path (ADAAAA-8140)", () => {
  /** Record a DELIVERED goal-shaped accept the gate demoted to a celebration. */
  const deliveredCelebration = (s: LiveRunShared, ts: number, opts: { id?: string; transitionKey?: string | null } = {}) =>
    s.noteDeliveredGoalShapedEvent({
      highlightId: opts.id ?? `hl-celeb-${ts}`,
      anchorTs: ts - 2,
      start: ts - 10,
      end: ts + 5,
      candidateTs: ts,
      transitionKey: opts.transitionKey ?? null,
      idempotencyKey: `hl:job:${ts}:GOAL`,
    });

  it("does not suppress a real goal 26s after a DEMOTED celebration (no silent drop)", () => {
    // The measured defect: a GOAL-shaped window at 23.9s demoted to a
    // celebration stamped the burst reference, so the real goal at 49.9s
    // (26s later) was dropped with no reason. A demoted row is only a
    // same-MOMENT reference (8s), so 26s later ships as its own row.
    const s = new LiveRunShared();
    deliveredCelebration(s, 23.95);
    expect(s.goalBurstSuppression({ ts: 49.99, eventType: "GOAL" })).toBeUndefined();
  });

  it("still collapses a same-moment re-read of a DEMOTED celebration (3.2s)", () => {
    // ADAAAA-8085's stored 182.29 / 185.49 pair: one goal must not become two
    // celebration cards.
    const s = new LiveRunShared();
    deliveredCelebration(s, 182.29, { id: "hl-182" });
    const sup = s.goalBurstSuppression({ ts: 185.49, eventType: "GOAL" });
    expect(sup?.dedupeAgainstHighlightId).toBe("hl-182");
    expect(sup?.dedupeAgainstKind).toBe("goal_shaped_celebration");
    expect(sup?.windowS).toBe(SHOOTOUT_KICK_DEDUP_S);
    expect(sup?.gapS).toBeCloseTo(3.2, 5);
  });

  it("escalates a candidate carrying its OWN forward transition the delivered row never claimed", () => {
    // A delivered goal that certified nothing (transition null) cannot claim a
    // later window that measured a real forward step.
    const s = new LiveRunShared();
    delivered(s, 160.55, { id: "hl-noop", transitionKey: null });
    expect(
      s.goalBurstSuppression({ ts: 176.28, eventType: "GOAL", transitionKey: "1-1>2-1" })
    ).toBeUndefined();
  });

  it("still dedupes the SAME transition inside the window", () => {
    const s = new LiveRunShared();
    delivered(s, 160.55, { id: "hl-goal", transitionKey: "1-1>2-1" });
    const sup = s.goalBurstSuppression({ ts: 168, eventType: "GOAL", transitionKey: "1-1>2-1" });
    expect(sup?.dedupeAgainstHighlightId).toBe("hl-goal");
    expect(sup?.dedupeAgainstKind).toBe("scoring_goal");
    expect(sup?.transitionKey).toBe("1-1>2-1");
  });

  it("escalates a DISTINCT transition inside the window", () => {
    const s = new LiveRunShared();
    delivered(s, 160.55, { id: "hl-goal", transitionKey: "1-1>2-1" });
    // A second goal 12s later (1-1>2-2) is a NEW scoring event, not a re-read.
    expect(
      s.goalBurstSuppression({ ts: 172.5, eventType: "GOAL", transitionKey: "1-1>2-2" })
    ).toBeUndefined();
  });

  it("formats a machine-readable reason naming the row it deduped against", () => {
    const s = new LiveRunShared();
    delivered(s, 2, { id: "hl-a" });
    const reason = formatGoalBurstSuppressionReason(s.goalBurstSuppression({ ts: 10, eventType: "GOAL" })!);
    expect(reason).toContain("goal_burst_same_transition:dedupeAgainst=hl-a@2.000s(scoring_goal)");
    expect(reason).toContain("idempotencyKey=hl:job:2:GOAL");
    expect(reason).toContain("gap=8.000s");
    expect(reason).toContain("window=30s");
    expect(reason).toContain("transition=none");
    expect(reason).toContain("burst=1");
  });
});

describe("goalBurstSuppression shootout-aware (ADAAAA-7402/7420)", () => {
  it("tight window is 8s for scoreboard-corroborated goals", () => {
    expect(SHOOTOUT_KICK_DEDUP_S).toBe(8);
    expect(SHOOTOUT_KICK_DEDUP_S).toBeLessThan(DEFAULT_GOAL_BURST_SUPPRESS_S);
  });

  it("does NOT suppress a DISTINCT corroborated conversion >= 8s after the last delivered goal (AC2)", () => {
    const s = new LiveRunShared();
    delivered(s, 588);
    delivered(s, 601);
    delivered(s, 614);
    delivered(s, 627);
    delivered(s, 640);
    // Each conversion is 13s from the one before it -> the tight window never fires.
    expect(s.goalBurstSuppression({ ts: 653, eventType: "GOAL", corroborated: true })).toBeUndefined();
  });

  it("still dedups an ADJACENT same-kick re-read < 8s of a corroborated delivered goal (AC4)", () => {
    const s = new LiveRunShared();
    delivered(s, 588);
    expect(s.goalBurstSuppression({ ts: 591, eventType: "GOAL", corroborated: true })?.gapS).toBe(3);
    expect(s.goalBurstSuppression({ ts: 595, eventType: "GOAL", corroborated: true })?.gapS).toBe(7);
    expect(s.goalBurstSuppression({ ts: 596, eventType: "GOAL", corroborated: true })).toBeUndefined(); // 8s
  });

  it("keeps the full 30s regulation window for goals WITHOUT corroboration (confabulated-burst guard)", () => {
    const s = new LiveRunShared();
    delivered(s, 2);
    expect(s.goalBurstSuppression({ ts: 12, eventType: "GOAL" })).toBeDefined(); // 10s < 30s
    expect(s.goalBurstSuppression({ ts: 30, eventType: "GOAL" })).toBeDefined(); // 28s < 30s
    expect(s.goalBurstSuppression({ ts: 33, eventType: "GOAL" })).toBeUndefined(); // 31s
  });

  it("uses the per-goal window: a corroborated goal narrows, an uncorroborated goal keeps 30s", () => {
    const s = new LiveRunShared();
    delivered(s, 588);
    expect(s.goalBurstSuppression({ ts: 601, eventType: "GOAL", corroborated: true })).toBeUndefined(); // 13s > 8s
    delivered(s, 601);
    expect(s.goalBurstSuppression({ ts: 605, eventType: "GOAL", corroborated: true })?.gapS).toBe(4); // same kick
    const s2 = new LiveRunShared();
    delivered(s2, 601);
    expect(s2.goalBurstSuppression({ ts: 614, eventType: "GOAL" })).toBeDefined(); // uncorroborated, 13s < 30s
  });
});
