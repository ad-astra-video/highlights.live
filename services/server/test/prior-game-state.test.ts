import { describe, it, expect } from "vitest";
import {
  buildObserveDecideRequest,
  LiveRunShared,
  PRIOR_GAME_STATE_ASR_MAX_CHARS,
  PRIOR_GAME_STATE_REACH_S,
  PRIOR_GAME_STATE_STORY_MAX_CHARS,
  isScoringDecision,
  priorTail,
} from "../src/analyzer";
import type { DecisionResult } from "../src/analyzer";
import type { ObserveDecidePayload } from "../src/observe-loop";
import type { ScoreboardDeltaEvidence } from "../src/analyzer";

// ADAAAA-7938 (Spec A): the VOD decide pass must carry the prior game state
// (story-so-far + prior ASR + scoreboard transition) into every window after
// the first, and must not change the request at all when it has nothing
// measured. These tests pin both halves: the block's content/bounds and the
// byte-identical no-op.

function payload(centerTs = 24): ObserveDecidePayload {
  return {
    centerTs,
    frames: [{ ts: centerTs - 1, imageB64: "f0", seq: 1 }],
    seeds: [],
    biasHints: [],
    capped: false,
    droppedCount: 0,
  };
}

const VOD_CFG = {
  jobId: "job-1",
  gameHint: "soccer",
  decideWindowN: 24,
  audioContext: false,
} as unknown as Parameters<typeof buildObserveDecideRequest>[0];

const LIVE_CFG = {
  jobId: "job-1",
  gameHint: "soccer",
  audioContext: false,
} as unknown as Parameters<typeof buildObserveDecideRequest>[0];

function goalDecision(overrides: Partial<DecisionResult> = {}): DecisionResult {
  return {
    isHighlight: true,
    score: 90,
    outcome: "scoring_play",
    eventType: "GOAL",
    runningSummary: "Goal at 42s: Ronaldo finishes low to make it 1-0 Portugal.",
    analysis: { prompt: "p", dataItems: [], frames: [], images: [], asr: { transcript: "It's 1-0 Portugal." } },
    ...overrides,
  } as DecisionResult;
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

describe("ADAAAA-7938 prior game state — the first window is a strict no-op", () => {
  it("omits priorGameState entirely when nothing has been decided yet", () => {
    const run = new LiveRunShared({ decideWindowN: 24 });
    const { opts } = buildObserveDecideRequest(VOD_CFG, run, payload(3));
    expect(opts).toBeDefined();
    expect(opts!.priorGameState).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(opts!, "priorGameState")).toBe(false);
  });

  it("never carries the block on the live rail even after a scored window", () => {
    const run = new LiveRunShared();
    run.noteWindowGameState(42.4, goalDecision(), { scoreBoardDelta: LEGIBLE_DELTA });
    const { opts } = buildObserveDecideRequest(LIVE_CFG, run, payload(48));
    expect(opts!.priorGameState).toBeUndefined();
  });
});

describe("ADAAAA-7938 prior game state — carried state", () => {
  it("carries the story-so-far, the prior ASR tail and needsNewScore after a goal", () => {
    const run = new LiveRunShared({ decideWindowN: 24 });
    run.noteWindowGameState(42.4, goalDecision(), { scoreBoardDelta: LEGIBLE_DELTA });
    const { opts } = buildObserveDecideRequest(VOD_CFG, run, payload(48));
    const pg = opts!.priorGameState;
    expect(pg).toBeDefined();
    expect(pg!.story).toContain("1-0 Portugal");
    expect(pg!.priorAsr).toContain("1-0 Portugal");
    expect(pg!.score).toBe("1-0");
    expect(pg!.lastScoreTs).toBe(42.4);
    expect(pg!.needsNewScore).toBe(true);
    expect(pg!.sinceLastScoreS).toBeCloseTo(5.6, 3);
  });

  it("bounds both tails (AC-A3 cost bound)", () => {
    const run = new LiveRunShared({ decideWindowN: 24 });
    const long = "word ".repeat(400).trim();
    run.noteWindowGameState(
      10,
      goalDecision({
        runningSummary: long,
        analysis: { prompt: "p", dataItems: [], frames: [], images: [], asr: { transcript: long } },
      }),
      {}
    );
    const pg = run.priorGameStateFor(20)!;
    expect(pg.story.length).toBeLessThanOrEqual(PRIOR_GAME_STATE_STORY_MAX_CHARS + 1);
    expect(pg.priorAsr.length).toBeLessThanOrEqual(PRIOR_GAME_STATE_ASR_MAX_CHARS + 1);
    expect(pg.story.startsWith("…")).toBe(true);
    expect(pg.priorAsr.startsWith("…")).toBe(true);
  });

  it("drops the needsNewScore claim outside the 7865 reach (recall guard)", () => {
    const run = new LiveRunShared({ decideWindowN: 24 });
    run.noteWindowGameState(42.4, goalDecision(), { scoreBoardDelta: LEGIBLE_DELTA });
    // Stay just inside/outside the reach: `42.4 + 60 - 42.4` is not exactly 60
    // in binary floating point, and the deterministic rule compares the same way.
    const near = run.priorGameStateFor(42.4 + PRIOR_GAME_STATE_REACH_S - 0.1);
    expect(near!.needsNewScore).toBe(true);
    const far = run.priorGameStateFor(42.4 + PRIOR_GAME_STATE_REACH_S + 1);
    expect(far!.needsNewScore).toBe(false);
    // Outside the reach the block still names the score, so it must not read as
    // "nothing happened".
    expect(far!.score).toBe("1-0");
  });

  it("ignores a scoring play with no measured delta for the score text, but still notes the instant", () => {
    const run = new LiveRunShared({ decideWindowN: 24 });
    run.noteWindowGameState(50, goalDecision(), {});
    const pg = run.priorGameStateFor(56)!;
    expect(pg.score).toBeNull();
    expect(pg.lastScoreTs).toBe(50);
    expect(pg.needsNewScore).toBe(true);
  });

  it("keeps content order: a re-produced older window cannot overwrite newer state", () => {
    const run = new LiveRunShared({ decideWindowN: 24 });
    run.noteWindowGameState(30, goalDecision({ runningSummary: "NEWER" }), {});
    run.noteWindowGameState(12, goalDecision({ runningSummary: "OLDER", analysis: undefined }), {});
    const pg = run.priorGameStateFor(36)!;
    expect(pg.story).toBe("NEWER");
    expect(pg.priorAsr).toBe("It's 1-0 Portugal.");
  });

  it("a non-scoring window never opens a score transition", () => {
    const run = new LiveRunShared({ decideWindowN: 24 });
    run.noteWindowGameState(24, {
      isHighlight: true,
      score: 40,
      outcome: "big_play",
      eventType: "BIG_PLAY",
      runningSummary: "Celebration after the goal.",
      analysis: { prompt: "p", dataItems: [], frames: [], images: [] },
    } as DecisionResult, {});
    const pg = run.priorGameStateFor(30)!;
    expect(pg.story).toBe("Celebration after the goal.");
    expect(pg.needsNewScore).toBe(false);
    expect(pg.lastScoreTs).toBeNull();
  });
});

describe("ADAAAA-7938 helpers", () => {
  it("priorTail keeps the newest part and single-lines the text", () => {
    expect(priorTail("a\nb   c", 99)).toBe("a b c");
    expect(priorTail("0123456789", 4)).toBe("…6789");
    expect(priorTail(undefined, 10)).toBe("");
    expect(priorTail(42, 10)).toBe("");
  });

  it("isScoringDecision reads the taxonomy, then the legacy label", () => {
    expect(isScoringDecision({ isHighlight: true, outcome: "scoring_play", eventType: "GOAL" })).toBe(true);
    expect(isScoringDecision({ isHighlight: true, outcome: "big_play", eventType: "BIG_PLAY" })).toBe(false);
    expect(isScoringDecision({ isHighlight: true, eventType: "GOAL" })).toBe(true);
    expect(isScoringDecision({ isHighlight: false, eventType: "GOAL" })).toBe(false);
  });
});
