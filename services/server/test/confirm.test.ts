import { describe, it, expect, vi } from "vitest";
import {
  analyzeJob,
  buildConfirmContext,
  confirmReconcile,
  hasIndependentAttestation,
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
// A Stage-1 read that is NOT an accepted highlight (near miss) — should never trigger.
const nonAccept: DecisionResult = {
  isHighlight: false,
  score: 55,
  eventType: "GOAL",
  outcome: "near_miss",
  nearMiss: true,
};

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
    postAudio: async () => null,
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
  it("does not fire on a Stage-1 non-accept (near miss / not a highlight)", () => {
    const cfg = { confirmEnabled: true } as any;
    expect(shouldRunConfirm(cfg, { eventType: "GOAL" }, nonAccept)).toBe(false);
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
    const cfg = { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" } as any; // confirmEnabled undefined
    const outcome = await analyzeJob(client, frames(1), async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }), cfg, undefined, undefined, shared);
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
    const cfg = { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "", confirmEnabled: true } as any;
    const outcome = await analyzeJob(client, frames(1), async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }), cfg, undefined, undefined, shared);
    // The refuted goal is NOT cut as a board goal highlight.
    expect(outcome.highlights).toHaveLength(0);
    expect(shared.confirmMetrics.totalRuns).toBe(1);
    expect(shared.confirmMetrics.disagreed).toBe(1);
  });

  it("keeps an accepted goal and tags it with the confirm verdict when confirmed", async () => {
    const { client } = makeClient({
      analyze: async () => ({ observation: { tracks: [], seq: 0, timestamp: 0 }, candidate: { eventType: "GOAL", timestamp: 0 } }),
      confirm: async () => ({ enabled: true, goalConfirmed: "confirmed_goal", confidence: 0.9, reason: "ball in net", evidence: { ballInNet: true }, stage1Disagreed: false, decision: { isHighlight: true, score: 85, eventType: "GOAL", outcome: "scoring_play" } }),
    });
    const shared = new LiveRunShared();
    const cfg = { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "", confirmEnabled: true } as any;
    const outcome = await analyzeJob(client, frames(1), async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }), cfg, undefined, undefined, shared);
    expect(outcome.highlights).toHaveLength(1);
    expect(outcome.highlights[0]).toMatchObject({ goalConfirmed: "confirmed_goal", stage1Disagreed: false, outcome: "scoring_play" });
    expect(shared.confirmMetrics.totalRuns).toBe(1);
    expect(shared.confirmMetrics.disagreed).toBe(0);
  });
});
