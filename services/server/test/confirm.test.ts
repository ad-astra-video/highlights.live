import { describe, it, expect, vi } from "vitest";
import {
  analyzeJob,
  buildConfirmContext,
  confirmReconcile,
  CONFIRM_MAX_FRAMES,
  downsampleConfirmFrames,
  hasIndependentAttestation,
  isGateRejectedBareGoal,
  isGoalTypeEvent,
  LiveRunShared,
  selectConfirmKeyframes,
  shouldRunConfirm,
  type ConfirmDecision,
  type DecisionResult,
  type PipelineClient,
} from "../src/analyzer";

// A Stage-1 primary read of an accepted (scoring_play) goal — the population the
// Stage-2 confirmation pass is scoped to.
const acceptedGoal: DecisionResult = {
  isHighlight: true,
  score: 80,
  eventType: "GOAL",
  outcome: "scoring_play",
  reason: "stage-1 goal",
};
// A Stage-1 read that is NOT an accepted highlight (near miss) — still used to
// assert the confirm population is bounded (non-goal-shaped reads stay out).

function makeClient(over: Partial<PipelineClient> = {}): { client: PipelineClient; log: string[] } {
  const log: string[] = [];
  const client: PipelineClient = {
    reservePerceive: async () => {
      log.push("reserve");
      return { sessionId: "sess-x", appUrl: "", controlUrl: "" };
    },
    analyze: async () => {
      log.push("analyze");
      return { observation: { tracks: [], seq: 0, timestamp: 0 } };
    },
    decide: async () => {
      log.push("decide");
      return acceptedGoal;
    },
    plan: async () => ({ planVersion: 1, category: "soccer", intent: "", source: "planner-fallback", maxTracks: 3, targets: [{ label: "player", role: "player" }], reason: "test" }),
    stopPerceive: async () => {
      log.push("stop");
    },
    postAudio: async () => ({ candidate: null, series: [] }),
    controlForward: async () => {},
    train: async () => ({ run: "x", checkpoint: "/runs/x/model.safetensors" }),
    confirm: async () => {
      log.push("confirm");
      return { enabled: false, goalConfirmed: null, confidence: 0, reason: "", evidence: {}, stage1Disagreed: false, decision: acceptedGoal };
    },
    ...over,
  };
  return { client, log };
}

async function* frames(n: number) {
  for (let i = 0; i < n; i++) yield { seq: i, timestamp: i, imageB64: `img${i}` };
}

describe("isGoalTypeEvent", () => {
  it("recognizes goal-type events (case-insensitive)", () => {
    expect(isGoalTypeEvent("GOAL")).toBe(true);
    expect(isGoalTypeEvent("goal")).toBe(true);
    expect(isGoalTypeEvent("TOUCHDOWN")).toBe(true);
    expect(isGoalTypeEvent("BASKET")).toBe(true);
    expect(isGoalTypeEvent("KILL")).toBe(true);
  });
  it("rejects non-goal types and empty", () => {
    expect(isGoalTypeEvent("ASSIST")).toBe(false);
    expect(isGoalTypeEvent("HIT")).toBe(false);
    expect(isGoalTypeEvent("")).toBe(false);
    expect(isGoalTypeEvent(undefined)).toBe(false);
  });
});

describe("hasIndependentAttestation", () => {
  it("true when any independent attestation is present", () => {
    expect(hasIndependentAttestation({ ballOutcome: "goal" })).toBe(true);
    expect(hasIndependentAttestation({ ballOutcome: "Goal" })).toBe(true);
    expect(hasIndependentAttestation({ goalCrossed: true })).toBe(true);
    expect(hasIndependentAttestation({ scoreBoardChanged: true })).toBe(true);
  });
  it("false when no attestation", () => {
    expect(hasIndependentAttestation({})).toBe(false);
    expect(hasIndependentAttestation({ ballOutcome: "off_target" })).toBe(false);
    expect(hasIndependentAttestation({ goalCrossed: false })).toBe(false);
    expect(hasIndependentAttestation({ scoreBoardChanged: false })).toBe(false);
  });
});

describe("shouldRunConfirm", () => {
  it("is a strict no-op when the config flag is off", () => {
    expect(shouldRunConfirm({} as any, { eventType: "GOAL" }, acceptedGoal)).toBe(false);
    expect(shouldRunConfirm({ confirmEnabled: false } as any, { eventType: "GOAL" }, acceptedGoal)).toBe(false);
  });
  it("fires only for un-attested scoring_play accepts (goal-ness from the DECISION, ADAAAA-7185)", () => {
    const cfg = { confirmEnabled: true } as any;
    expect(shouldRunConfirm(cfg, { eventType: "GOAL" }, acceptedGoal)).toBe(true);
    // Observe-path regression (ADAAAA-7185): the candidate carries the perceive
    // bias-hint label (SPORTING_EVENT) while the GOAL class lives on the
    // verdict. The gate must fire anyway.
    expect(shouldRunConfirm(cfg, { eventType: "SPORTING_EVENT" }, acceptedGoal)).toBe(true);
    expect(shouldRunConfirm(cfg, { eventType: "ASSIST" }, acceptedGoal)).toBe(true);
    // independently attested → excluded
    expect(shouldRunConfirm(cfg, { eventType: "GOAL", ballOutcome: "goal" }, acceptedGoal)).toBe(false);
    expect(shouldRunConfirm(cfg, { eventType: "GOAL", goalCrossed: true }, acceptedGoal)).toBe(false);
    expect(shouldRunConfirm(cfg, { eventType: "GOAL", scoreBoardChanged: true }, acceptedGoal)).toBe(false);
  });
  it("does not fire on a NON-goal-shaped Stage-1 non-accept (outcome != scoring, eventType not goal-type)", () => {
    const cfg = { confirmEnabled: true } as any;
    const nonGoalNonAccept: DecisionResult = {
      isHighlight: false,
      score: 60,
      eventType: "ASSIST",
      outcome: "not_highlight",
    };
    expect(shouldRunConfirm(cfg, { eventType: "ASSIST" }, nonGoalNonAccept)).toBe(false);
    // A goal-shaped non-accept (eventType=GOAL, outcome=not_highlight) DOES fire
    // (delayed-corroboration rescue, ADAAAA-7357) — the coarse 1fps read can miss
    // a real goal, so it enters the confirm dive which the corroboration gate keeps honest.
    const coarseMiss: DecisionResult = { isHighlight: false, score: 0, eventType: "GOAL", outcome: "not_highlight" };
    expect(shouldRunConfirm(cfg, { eventType: "GOAL" }, coarseMiss)).toBe(true);
  });
  it("does not fire on a requested near-miss / big-play highlight (never a goal, ADAAAA-7185)", () => {
    const cfg = { confirmEnabled: true, preferLabels: ["near-misses"] } as any;
    const nearMissHighlight: DecisionResult = {
      isHighlight: true,
      score: 55,
      eventType: "GOAL",
      outcome: "near_miss",
      nearMiss: true,
    };
    expect(shouldRunConfirm(cfg, { eventType: "GOAL" }, nearMissHighlight)).toBe(false);
  });
});

describe("isGateRejectedBareGoal", () => {
  const gateRejectedGoal: DecisionResult = {
    isHighlight: false,
    score: 80,
    eventType: "GOAL",
    outcome: "scoring_play",
    reason: "high-value event GOAL; rejected by notable-only bar: no corroborating evidence (bare trigger)",
  };
  it("true only for a goal-shaped read stripped to a non-accept by the notable-only bare-trigger bar", () => {
    expect(isGateRejectedBareGoal(gateRejectedGoal)).toBe(true);
  });
  it("false for an accepted goal", () => {
    expect(isGateRejectedBareGoal({ isHighlight: true, outcome: "scoring_play", eventType: "GOAL", score: 80, reason: "x" })).toBe(false);
  });
  it("true for a goal-shaped non-accept even when outcome != scoring_play (delayed-corroboration rescue, ADAAAA-7357)", () => {
    // kids_soccer.mp4 114s goal: coarse 1fps read said outcome=not_highlight /
    // eventType=GOAL; the notable-only bar rejected it for lack of in-window
    // corroboration. A narrow outcome===scoring_play gate missed it.
    expect(isGateRejectedBareGoal({ isHighlight: false, outcome: "not_highlight", eventType: "GOAL", score: 0, reason: "ball moving away… no ball enters the net" })).toBe(true);
    expect(isGateRejectedBareGoal({ isHighlight: false, outcome: "near_miss", eventType: "GOAL", score: 55, reason: "x" })).toBe(true);
  });
  it("true regardless of the reason string (any free-form bare non-accept read)", () => {
    // The old signature-match on "notable-only bar" is intentionally dropped — the
    // reason varies by model read and missed ts=114.
    expect(isGateRejectedBareGoal({ isHighlight: false, outcome: "scoring_play", eventType: "GOAL", score: 80, reason: "ball outcome gate: off_target" })).toBe(true);
    expect(isGateRejectedBareGoal({ isHighlight: false, outcome: "scoring_play", eventType: "GOAL", score: 80, reason: "goal attestation: bare templated reason" })).toBe(true);
  });
  it("false for a NON-goal-shaped non-accept (eventType not goal-type, outcome != scoring)", () => {
    expect(isGateRejectedBareGoal({ isHighlight: false, outcome: "not_highlight", eventType: "ASSIST", score: 60, reason: "x" })).toBe(false);
    expect(isGateRejectedBareGoal({ isHighlight: false, outcome: "big_play", eventType: "COUNTER", score: 60, reason: "x" })).toBe(false);
  });
});

describe("shouldRunConfirm — ADAAAA-7357 delayed-corroboration population", () => {
  // A goal-shaped read the deterministic notable-only bar stripped because the
  // scoreboard / goal-call audio landed in a LATER window (no in-window signal).
  const gateRejectedGoal: DecisionResult = {
    isHighlight: false,
    score: 80,
    eventType: "GOAL",
    outcome: "scoring_play",
    reason: "high-value event GOAL; rejected by notable-only bar: no corroborating evidence (bare trigger)",
  };
  // A goal-shaped read rejected by the ball-outcome gate (NOT notable-only) —
  // must stay out of the confirm population (bounded, no false-positive cost).
  const ballGateRejectedGoal: DecisionResult = {
    isHighlight: false,
    score: 80,
    eventType: "GOAL",
    outcome: "scoring_play",
    reason: "high-value event GOAL; ballOutcome=off_target",
  };
  it("fires the confirm dive for a gate-rejected goal-shaped candidate (delayed corroboration rescue)", () => {
    const cfg = { confirmEnabled: true } as any;
    expect(shouldRunConfirm(cfg, { eventType: "GOAL" }, gateRejectedGoal)).toBe(true);
    // The observe bias-hint label must not matter — goalness lives on the verdict.
    expect(shouldRunConfirm(cfg, { eventType: "SPORTING_EVENT" }, gateRejectedGoal)).toBe(true);
  });
  it("still excludes an attested gate-rejected goal", () => {
    const cfg = { confirmEnabled: true } as any;
    expect(shouldRunConfirm(cfg, { eventType: "GOAL", scoreBoardChanged: true }, gateRejectedGoal)).toBe(false);
    expect(shouldRunConfirm(cfg, { eventType: "GOAL", ballOutcome: "goal" }, gateRejectedGoal)).toBe(false);
  });
  it("stays a strict no-op when the config flag is off (even for a gate-rejected goal)", () => {
    expect(shouldRunConfirm({ confirmEnabled: false } as any, { eventType: "GOAL" }, gateRejectedGoal)).toBe(false);
    expect(shouldRunConfirm({} as any, { eventType: "GOAL" }, gateRejectedGoal)).toBe(false);
  });
  it("fires for a goal-shaped non-accept regardless of the reject reason signature (ADAAAA-7357 broaden)", () => {
    const cfg = { confirmEnabled: true } as any;
    // A scoring_play read stripped by a NON-notable gate still fires — the target
    // is any goal-shaped bare non-accept, because the reason text varies and no
    // single signature can bound it reliably (that signature miss is the bug).
    expect(shouldRunConfirm(cfg, { eventType: "GOAL" }, ballGateRejectedGoal)).toBe(true);
  });
  it("does NOT broaden to a NON-goal-shaped near-miss / not_goal read (cost-bounded population)", () => {
    const cfg = { confirmEnabled: true } as any;
    const nonGoalTypeRead: DecisionResult = {
      isHighlight: false,
      score: 55,
      eventType: "ASSIST",
      outcome: "near_miss",
      nearMiss: true,
    };
    expect(shouldRunConfirm(cfg, { eventType: "ASSIST" }, nonGoalTypeRead)).toBe(false);
    const nonGoalBigPlay: DecisionResult = {
      isHighlight: false,
      score: 60,
      eventType: "COUNTER",
      outcome: "big_play",
    };
    expect(shouldRunConfirm(cfg, { eventType: "COUNTER" }, nonGoalBigPlay)).toBe(false);
  });
  it("fires for the kids_soccer.mp4 ts=114 delayed-corroboration goal (outcome=not_highlight / eventType=GOAL)", () => {
    const cfg = { confirmEnabled: true } as any;
    // The exact production candidate: stage-1 read outcome=not_highlight with a
    // free-form reject reason and eventType=GOAL. The old gate (outcome must be
    // scoring_play AND reason must contain the notable-only signature) missed it
    // and skipped the confirm dive for the target goal.
    const kidsTs114: DecisionResult = {
      isHighlight: false,
      score: 0,
      eventType: "GOAL",
      outcome: "not_highlight",
      nearMiss: false,
      reason:
        "The ball is clearly seen moving away from the goal or being played in the midfield area, and no ball enters the net.; outcome=not_highlight is not a scoring highlight",
    };
    expect(shouldRunConfirm(cfg, { eventType: "GOAL" }, kidsTs114)).toBe(true);
    expect(isGateRejectedBareGoal(kidsTs114)).toBe(true);
  });
});

describe("selectConfirmKeyframes", () => {
  it("picks the nearest frame to each of pre/event/post", () => {
    const fs = [
      { timestamp: 8, imageB64: "a" },
      { timestamp: 9.5, imageB64: "b" },
      { timestamp: 11, imageB64: "c" },
    ];
    const kf = selectConfirmKeyframes(fs, 10, 2, 2); // targets 8, 10, 12
    expect(kf.map((k) => k.base64)).toEqual(["a", "b", "c"]);
    expect(kf.every((k) => k.role === "full")).toBe(true);
  });
  it("returns [] on an empty frame list", () => {
    expect(selectConfirmKeyframes([], 10, 2, 2)).toEqual([]);
  });
});

describe("buildConfirmContext", () => {
  it("ADAAAA-7543: bounds the deep-dive frame sequence and keeps its full span", () => {
    const dense = Array.from({ length: 48 }, (_, i) => ({ timestamp: i / 8, imageB64: `b${i}` }));
    const out = downsampleConfirmFrames(dense);
    expect(out.length).toBe(CONFIRM_MAX_FRAMES);
    // first + last survive so the pre-instant and the aftermath stay visible
    expect(out[0].imageB64).toBe("b0");
    expect(out[out.length - 1].imageB64).toBe("b47");
    // monotonically ordered, no duplicates
    const idx = out.map((f) => dense.indexOf(f));
    expect(idx.every((v, i) => i === 0 || v > idx[i - 1])).toBe(true);
    // a sequence that already fits is passed through untouched (identity)
    const small = dense.slice(0, 5);
    expect(downsampleConfirmFrames(small)).toBe(small);
  });

  it("ADAAAA-7543: centers the frame window on the goal instant, not the window center", async () => {
    const shared = new LiveRunShared({ decideWindowN: 24 });
    const asked: number[] = [];
    const cfg = {
      resampleFrames: async (ts: number) => {
        asked.push(ts);
        return [
          { timestamp: ts - 3, imageB64: "r0" },
          { timestamp: ts, imageB64: "r1" },
          { timestamp: ts + 3, imageB64: "r2" },
        ];
      },
    } as any;
    const ctx = await buildConfirmContext(shared, cfg, { timestamp: 51 }, acceptedGoal, 46);
    expect(asked).toEqual([46]);
    expect(ctx.frames).toHaveLength(3);
    expect(ctx.frames[1].base64).toBe("r1");
  });

  it("assembles dense frames + keyframes + trajectory + motion + audio", async () => {
    const shared = new LiveRunShared({ decideWindowN: 24 });
    shared.addFrame(0, 0, "f0");
    shared.addFrame(1, 1, "f1");
    shared.addFrame(2, 2, "f2");
    shared.setFindings(0, { tracks: [] });
    shared.setFindings(1, { tracks: [{ trackId: "t1", slot: 0, kind: "ball", lostFrames: 0, label: "ball", bbox: [0, 0, 0.2, 0.2] }] });
    shared.setFindings(2, { tracks: [{ trackId: "t1", slot: 0, kind: "ball", lostFrames: 0, label: "ball", bbox: [0.4, 0, 0.6, 0.2] }] });
    // audio tap (a raw mono int16 PCM tap -> normalized energy)
    shared.addAudioChunk(1, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]).toString("base64"));

    const cfg = {
      resampleFrames: async (_ts: number) => [
        { timestamp: 0, imageB64: "r0" },
        { timestamp: 1, imageB64: "r1" },
        { timestamp: 2, imageB64: "r2" },
      ],
    } as any;
    const ctx = await buildConfirmContext(shared, cfg, { timestamp: 1 }, acceptedGoal);
    expect(ctx.frames).toHaveLength(3);
    expect(ctx.frames[0].base64).toBe("r0");
    // keyframes: nearest to pre/event/post (targets 1-2, 1, 1+3)
    expect(ctx.keyframes).toHaveLength(3);
    expect(ctx.trajectories.length).toBeGreaterThan(0);
    expect(ctx.opticalFlowMagnitude).toBeGreaterThan(0);
    expect(ctx.flowMagnitudes.length).toBeGreaterThan(0);
  });

  it("falls back to the cached window when no resample callback, and to empty defaults when nothing is cached", async () => {
    const shared = new LiveRunShared();
    const cfg = {} as any; // no resampleFrames
    const ctx = await buildConfirmContext(shared, cfg, { timestamp: 0 }, acceptedGoal);
    expect(ctx.frames).toEqual([]);
    expect(ctx.keyframes).toEqual([]);
    expect(ctx.trajectories).toEqual([]);
    expect(ctx.opticalFlowMagnitude).toBe(0);
    expect(ctx.flowMagnitudes).toEqual([]);
    expect(ctx.audioLevels).toEqual([]);
    expect(ctx.audioB64).toBe("");
  });

  it("degrades to empty when the resample callback throws", async () => {
    const shared = new LiveRunShared();
    shared.addFrame(0, 0, "f0");
    const cfg = {
      resampleFrames: async () => {
        throw new Error("burst extract failed");
      },
    } as any;
    const ctx = await buildConfirmContext(shared, cfg, { timestamp: 0 }, acceptedGoal);
    // fallback to cached window frame
    expect(ctx.frames.length).toBeGreaterThan(0);
  });
});

describe("confirmReconcile", () => {
  it("is a strict no-op when the config flag is off", async () => {
    const { client, log } = makeClient();
    const shared = new LiveRunShared();
    const cfg = {} as any;
    const res = await confirmReconcile(client, shared, cfg, acceptedGoal, { eventType: "GOAL", timestamp: 1 });
    expect(res.confirmRan).toBe(false);
    expect(res.decision).toEqual(acceptedGoal);
    expect(log).not.toContain("confirm");
    expect(shared.confirmMetrics.totalRuns).toBe(0);
  });

  it("adopts the reconciled decision on a confirmed_goal success", async () => {
    const recon: ConfirmDecision = {
      enabled: true,
      goalConfirmed: "confirmed_goal",
      confidence: 0.9,
      reason: "goal confirmed",
      evidence: { ballInNet: true },
      stage1Disagreed: false,
      decision: { isHighlight: true, score: 85, eventType: "GOAL", outcome: "scoring_play" },
    };
    const { client, log } = makeClient({ confirm: async () => { log.push("confirm"); return recon; } });
    const shared = new LiveRunShared();
    const cfg = { confirmEnabled: true, gameHint: "soccer" } as any;
    const res = await confirmReconcile(client, shared, cfg, acceptedGoal, { eventType: "GOAL", timestamp: 1 });
    expect(res.confirmRan).toBe(true);
    expect(res.decision).toEqual(recon.decision);
    expect(shared.confirmMetrics.totalRuns).toBe(1);
    expect(shared.confirmMetrics.disagreed).toBe(0);
  });

  it("adopts a refuting verdict (near_miss) and records the disagreement", async () => {
    const recon: ConfirmDecision = {
      enabled: true,
      goalConfirmed: "near_miss",
      confidence: 0.8,
      reason: "play did not convert",
      evidence: { ballTrajectoryCrossedLine: false },
      stage1Disagreed: true,
      decision: { isHighlight: false, score: 55, eventType: "GOAL", outcome: "near_miss", nearMiss: true },
    };
    const { client } = makeClient({ confirm: async () => recon });
    const shared = new LiveRunShared();
    const cfg = { confirmEnabled: true, gameHint: "soccer" } as any;
    const res = await confirmReconcile(client, shared, cfg, acceptedGoal, { eventType: "GOAL", timestamp: 1 });
    expect(res.confirmRan).toBe(true);
    expect(res.decision.outcome).toBe("near_miss");
    expect(res.decision.isHighlight).toBe(false);
    expect(shared.confirmMetrics.totalRuns).toBe(1);
    expect(shared.confirmMetrics.disagreed).toBe(1);
  });

  it("keeps the Stage-1 verdict on the passthrough path (goalConfirmed null)", async () => {
    const passthrough: ConfirmDecision = {
      enabled: true,
      goalConfirmed: null,
      confidence: 0,
      reason: "confirmation pass unparseable (kept Stage-1)",
      evidence: {},
      stage1Disagreed: false,
      decision: acceptedGoal,
    };
    const { client } = makeClient({ confirm: async () => passthrough });
    const shared = new LiveRunShared();
    const cfg = { confirmEnabled: true } as any;
    const res = await confirmReconcile(client, shared, cfg, acceptedGoal, { eventType: "GOAL", timestamp: 1 });
    expect(res.confirmRan).toBe(true);
    expect(res.decision).toEqual(acceptedGoal);
    expect(shared.confirmMetrics.totalRuns).toBe(1);
    expect(shared.confirmMetrics.disagreed).toBe(0);
  });

  it("keeps the Stage-1 verdict on a transport failure and still counts the run", async () => {
    const { client } = makeClient({ confirm: async () => { throw new Error("confirm failed: HTTP 500"); } });
    const shared = new LiveRunShared();
    const cfg = { confirmEnabled: true } as any;
    const res = await confirmReconcile(client, shared, cfg, acceptedGoal, { eventType: "GOAL", timestamp: 1 });
    expect(res.confirmRan).toBe(true);
    expect(res.decision).toEqual(acceptedGoal);
    expect(shared.confirmMetrics.totalRuns).toBe(1);
    expect(shared.confirmMetrics.disagreed).toBe(0);
  });

  it("fires the dive for a notable-only-bar-gate-rejected goal and adopts a confirmed_goal (ADAAAA-7357)", async () => {
    // A real goal the notable-only bar stripped because its scoreboard change was
    // DELAYED to a later window (goal-shaped read, no in-window corroboration).
    const gateRejectedGoal: DecisionResult = {
      isHighlight: false,
      score: 80,
      eventType: "GOAL",
      outcome: "scoring_play",
      reason: "high-value event GOAL; rejected by notable-only bar: no corroborating evidence (bare trigger)",
    };
    const recon: ConfirmDecision = {
      enabled: true,
      goalConfirmed: "confirmed_goal",
      confidence: 0.92,
      reason: "goal confirmed; delayed scoreboard change corroborates",
      evidence: { scoreboardChanged: true },
      stage1Disagreed: true,
      corroborated: true,
      corroborationSource: "scoreboard",
      decision: { isHighlight: true, score: 85, eventType: "GOAL", outcome: "scoring_play" },
    };
    const { client } = makeClient({ confirm: async () => recon });
    const shared = new LiveRunShared();
    const cfg = { confirmEnabled: true, gameHint: "soccer" } as any;
    const res = await confirmReconcile(client, shared, cfg, gateRejectedGoal, { eventType: "GOAL", timestamp: 1 });
    // The gate-rejected goal gets the Stage-2 dive (confirmRan) and the confirmed
    // verdict is adopted, so it can surface as a board GOAL.
    expect(res.confirmRan).toBe(true);
    expect(res.decision.isHighlight).toBe(true);
    expect(res.decision.outcome).toBe("scoring_play");
    expect(shared.confirmMetrics.totalRuns).toBe(1);
  });

  it("fires for an observe-path candidate (SPORTING_EVENT) and emits a run_confirmation_pass audit descriptor (ADAAAA-7185)", async () => {
    const recon: ConfirmDecision = {
      enabled: true,
      goalConfirmed: "confirmed_goal",
      confidence: 0.9,
      reason: "ball in net",
      evidence: { ballInNet: true },
      stage1Disagreed: false,
      // ADAAAA-7185: the decide side now reports WHICH independent signal.
      corroborated: true,
      corroborationSource: "scoreboard",
      decision: { isHighlight: true, score: 85, eventType: "GOAL", outcome: "scoring_play" },
    };
    const audits: any[] = [];
    const { client } = makeClient({ confirm: async () => recon });
    const shared = new LiveRunShared();
    const cfg = { confirmEnabled: true, gameHint: "soccer", jobId: "job-x", onDecideAudit: (d: any) => audits.push(d) } as any;
    // Observe-path candidate carries the perceive bias label (SPORTING_EVENT);
    // the gate must still fire because the DECISION is a scoring_play goal.
    const res = await confirmReconcile(client, shared, cfg, acceptedGoal, { eventType: "SPORTING_EVENT", timestamp: 1 });
    expect(res.confirmRan).toBe(true);
    expect(res.decision.outcome).toBe("scoring_play");
    // A run_confirmation_pass descriptor is persisted for queryability.
    expect(audits).toHaveLength(1);
    expect(audits[0].verdicts.runConfirmationPass).toBe(true);
    expect(audits[0].verdicts.goalConfirmed).toBe("confirmed_goal");
    expect(audits[0].verdicts.corroborated).toBe(true);
    expect(audits[0].verdicts.corroborationSource).toBe("scoreboard");
    expect(audits[0].jobId).toBe("job-x");
  });
});

describe("analyzeJob integration (VOD confirm driver)", () => {
  it("does not call confirm when the flag is off (strict no-op)", async () => {
    let confirmed = 0;
    const { client } = makeClient({
      analyze: async () => ({ observation: { tracks: [], seq: 0, timestamp: 0 }, candidate: { eventType: "GOAL", timestamp: 0 } }),
      confirm: async () => { confirmed++; return { enabled: true, goalConfirmed: "near_miss", confidence: 0.8, reason: "", evidence: {}, stage1Disagreed: true, decision: { isHighlight: false, score: 55, eventType: "GOAL", outcome: "near_miss", nearMiss: true } }; },
    });
    const shared = new LiveRunShared();
    // ADAAAA-7365: the observe driver is the VOD confirm path (the accept /
    // confirm dive only runs through observeOnDecide -> acceptVideoDecision), so
    // the integration tests exercise it with the observe config on.
    const cfg = { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "", observeLoop: true, decideWindowN: 24 } as any; // confirmEnabled undefined
    const outcome = await analyzeJob(client, frames(1), async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` , hasAudio: true }), cfg, undefined, undefined, shared);
    expect(confirmed).toBe(0);
    expect(outcome.highlights).toHaveLength(1); // Stage-1 accepted goal cut as normal
    expect(shared.confirmMetrics.totalRuns).toBe(0);
  });

  it("refutes a Stage-1 goal when the confirm dive returns near_miss (no goal highlight cut)", async () => {
    const { client } = makeClient({
      analyze: async () => ({ observation: { tracks: [], seq: 0, timestamp: 0 }, candidate: { eventType: "GOAL", timestamp: 0 } }),
      confirm: async () => ({ enabled: true, goalConfirmed: "near_miss", confidence: 0.8, reason: "denied at line", evidence: { ballTrajectoryCrossedLine: false }, stage1Disagreed: true, decision: { isHighlight: false, score: 55, eventType: "GOAL", outcome: "near_miss", nearMiss: true } }),
    });
    const shared = new LiveRunShared();
    const cfg = { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "", confirmEnabled: true, observeLoop: true, decideWindowN: 24 } as any;
    const outcome = await analyzeJob(client, frames(1), async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` , hasAudio: true }), cfg, undefined, undefined, shared);
    // The refuted goal is NOT cut as a board goal highlight.
    expect(outcome.highlights).toHaveLength(0);
    // ADAAAA-7365: the confirm dive fires EXACTLY ONCE even though the observe
    // driver re-produces the same candidate on the end-of-stream flush tick.
    expect(shared.confirmMetrics.totalRuns).toBe(1);
    expect(shared.confirmMetrics.disagreed).toBe(1);
  });

  it("keeps an accepted goal and tags it with the confirm verdict when confirmed", async () => {
    const { client } = makeClient({
      analyze: async () => ({ observation: { tracks: [], seq: 0, timestamp: 0 }, candidate: { eventType: "GOAL", timestamp: 0 } }),
      confirm: async () => ({ enabled: true, goalConfirmed: "confirmed_goal", confidence: 0.9, reason: "ball in net", evidence: { ballInNet: true }, stage1Disagreed: false, decision: { isHighlight: true, score: 85, eventType: "GOAL", outcome: "scoring_play" } }),
    });
    const shared = new LiveRunShared();
    const cfg = { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "", confirmEnabled: true, observeLoop: true, decideWindowN: 24 } as any;
    const outcome = await analyzeJob(client, frames(1), async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` , hasAudio: true }), cfg, undefined, undefined, shared);
    expect(outcome.highlights).toHaveLength(1);
    expect(outcome.highlights[0]).toMatchObject({ goalConfirmed: "confirmed_goal", stage1Disagreed: false, outcome: "scoring_play" });
    // ADAAAA-7365: the confirm dive fires EXACTLY ONCE (observe re-produces the
    // same candidate on the flush tick; the exactly-once key collapses both).
    expect(shared.confirmMetrics.totalRuns).toBe(1);
    expect(shared.confirmMetrics.disagreed).toBe(0);
  });
});
