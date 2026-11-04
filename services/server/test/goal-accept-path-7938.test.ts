import { describe, it, expect } from "vitest";
import { acceptVideoDecision, LiveRunShared } from "../src/analyzer";
import type {
  AnalyzerConfig,
  CandidateSignal,
  ConfirmDecision,
  DecisionResult,
  ScoreboardDeltaEvidence,
} from "../src/analyzer";

// ADAAAA-7938 (Spec B): the DEPLOYED ADAAAA-7865 rule must fire on the ACCEPT
// PATH, not just as a pure function. These tests drive `acceptVideoDecision`
// itself — the same entry point the VOD observe pass uses — so a future change
// that stops threading `corroborationSource` / `scoreboardDeltaLegible` /
// `confirmEvidenceScoreboardChanged` or the localized anchor into
// `findRepeatGoalEvent` breaks a test instead of shipping.

function goalStage1(overrides: Partial<DecisionResult> = {}): DecisionResult {
  return {
    isHighlight: true,
    score: 92,
    outcome: "scoring_play",
    eventType: "GOAL",
    reason: "ball in the net",
    ...overrides,
  } as DecisionResult;
}

/** The Stage-2 dive as the fe0e3efc windows actually returned it: the frame
 * attestation (ballInNet / trajectory) corroborates, while the MEASURED
 * scoreboard read is `false`. That is exactly a celebration re-read, so it must
 * not open a second scoring event. */
function confirmDecision(overrides: Partial<ConfirmDecision> = {}): ConfirmDecision {
  return {
    enabled: true,
    goalConfirmed: "confirmed_goal",
    confidence: 1,
    reason: "ball in net (goal-net replay)",
    evidence: { ballInNet: true, ballTrajectoryCrossedLine: true, scoreboardChanged: false, audioErupted: false },
    stage1Disagreed: false,
    corroborated: true,
    corroborationSource: "frame_attestation",
    decision: goalStage1(),
    ...overrides,
  } as ConfirmDecision;
}

function cfg(): AnalyzerConfig {
  return {
    jobId: "job-7938",
    gameHint: "soccer",
    clipBeforeS: 6,
    clipAfterS: 9,
    clipWindowMinSec: 15,
    preferLabels: [],
    // Stage-2 ON: a corroborated accept shrinks the ADAAAA-6610 burst window to
    // the 8 s same-kick dedup, which is what lets a 60 s window reach the
    // event-unit rule at all (exactly the deployed fe0e3efc shape).
    confirmEnabled: true,
    confirmWindowExtraS: 2,
  } as AnalyzerConfig;
}

function candidate(ts: number, extra: Partial<CandidateSignal> = {}): CandidateSignal {
  return { eventType: "GOAL", timestamp: ts, ...extra } as CandidateSignal;
}

const LEGIBLE_DELTA: ScoreboardDeltaEvidence = {
  pre: [0, 0],
  post: [1, 0],
  preTs: 41.0,
  postTs: 42.4,
  deltaTs: 42.4,
  preSamples: 3,
  postSamples: 3,
};

async function accept(ts: number, extra: Partial<CandidateSignal> = {}, confirm = confirmDecision()) {
  const run = new LiveRunShared({ decideWindowN: 24, audioRetainS: 400 });
  const cut = async (t: number) => ({ clipId: `clip-${t}`, clipUri: "" });
  const client = { decide: async () => goalStage1(), confirm: async () => confirm } as any;
  // The real goal: anchor 42.4, delivered clip 36.4-51.4.
  await acceptVideoDecision(client, run, cut, cfg(), undefined, { seq: 1, timestamp: 42.4 }, candidate(42.4), goalStage1());
  await acceptVideoDecision(client, run, cut, cfg(), undefined, { seq: 2, timestamp: ts }, candidate(ts, extra), goalStage1());
  return run.highlights;
}

describe("ADAAAA-7865 dedup fires on the accept path (ADAAAA-7938 Spec B)", () => {
  it("downgrades a later GOAL accept with no independent evidence to a celebration", async () => {
    // 60 s vs 42.4 s = 17.6 s: inside GOAL_DUPLICATE_REACH_S, clips do NOT
    // overlap (36.4-51.4 vs 54-69), no measured delta, frame attestation only.
    const hl = await accept(60);
    expect(hl.length).toBe(2);
    expect(hl[0].outcome).toBe("scoring_play");
    expect(hl[0].eventType).toBe("GOAL");
    expect(hl[1].outcome).toBe("big_play");
    expect(hl[1].eventType).not.toBe("GOAL");
    expect(hl[1].dedupeReason).toBe(`goal_celebration_duplicate:${hl[0].id}`);
    // The clip is still delivered (a celebration is a real moment) — the rule
    // changes the LANE, never drops footage.
    expect(hl[1].clipUri).toBeTypeOf("string");
    expect(hl[1].clipWindowSec).toBeGreaterThanOrEqual(15);
  });

  it("keeps a later GOAL accept with a MEASURED scoreboard delta as a second scoring play", async () => {
    const hl = await accept(60, { scoreBoardDelta: LEGIBLE_DELTA });
    expect(hl.length).toBe(2);
    expect(hl[1].outcome).toBe("scoring_play");
    expect(hl[1].dedupeReason).toBeUndefined();
  });

  it("downgrades even when the confirm pass CLAIMS a score change (model prose is not evidence)", async () => {
    // The fe0e3efc / 4a0a149d shape: the deep dive sees the new score DISPLAYED
    // on the bug in a celebration window and answers scoreboardChanged=true.
    // That must not open a second scoring event (ADAAAA-7938 guardrail).
    const hl = await accept(60, {}, confirmDecision({ evidence: { scoreboardChanged: true } }));
    expect(hl.length).toBe(2);
    expect(hl[1].outcome).toBe("big_play");
    expect(hl[1].dedupeReason).toBe(`goal_celebration_duplicate:${hl[0].id}`);
  });

  it("keeps a goal-call-corroborated accept as a second scoring play", async () => {
    const hl = await accept(60, {}, confirmDecision({ corroborationSource: "audio_text" }));
    expect(hl.length).toBe(2);
    expect(hl[1].outcome).toBe("scoring_play");
    expect(hl[1].dedupeReason).toBeUndefined();
  });

  it("does not touch a GOAL accept outside the 60 s reach (recall guard)", async () => {
    const hl = await accept(42.4 + 90);
    expect(hl.length).toBe(2);
    expect(hl[1].outcome).toBe("scoring_play");
    expect(hl[1].dedupeReason).toBeUndefined();
  });
});
