// ADAAAA-8796 (D1) — the Stage-2 dive is a CONFIRMATION pass, not a GOAL gate.
//
// Measured state before D1 (leg `357a927d`, spec §3): `confirmDiveCount 3`,
// verdicts only on goal-shaped rows (`scoring_play` or a goal eventType). A big
// play, celebration or crowd burst carried no measured attestation either, but
// `shouldRunConfirm()` early-returned on `isGoalShaped()` before it ever asked —
// which is the board's complaint ("all identified highlights had no deep-dive
// confirmation"). These tests pin the two halves of D1:
//
//   (1) TRIGGER: a promoted (accepted) row with no measured attestation enters
//       the dive lane whatever its goal shape, on BOTH rails (live + VOD);
//       the measured-attestation cost bound and the flag-off no-op are kept.
//   (2) PRECISION: a dive verdict on a non-goal row records itself on
//       `confirmAttestation` but never promotes the row into a postable GOAL,
//       and never demotes it to `near_miss` for failing to corroborate a goal it
//       never claimed (AC1.4: 0 false postable GOALs, no coverage lost).
import { describe, it, expect } from "vitest";
import {
  analyzeJob,
  confirmReconcile,
  LiveRunShared,
  shouldRunConfirm,
  type DecisionResult,
  type PipelineClient,
} from "../src/analyzer";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";

/** A promoted NON-goal row: the population D1 adds to the dive lane. */
const BIG_PLAY: DecisionResult = {
  isHighlight: true,
  score: 70,
  eventType: "SPORTING_EVENT",
  outcome: "big_play",
  reason: "a strong run down the wing; no goal apparatus in frame",
};

/** A promoted celebration (crowd burst + cue) — never a goal, still promoted. */
const CELEBRATION: DecisionResult = {
  isHighlight: true,
  score: 65,
  eventType: "CELEBRATION",
  outcome: "big_play",
  reason: "players celebrating",
};

/** A promoted goal-shaped row, for the "adoption still works" regression. */
const GOAL_ACCEPT: DecisionResult = {
  isHighlight: true,
  score: 80,
  eventType: "GOAL",
  outcome: "scoring_play",
  reason: "ball in the net",
};

function liveCfg(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    PERCEIVE_URL: "http://p",
    DECIDE_URL: "http://d",
    LIVE_OBSERVE_LOOP: "1",
    DECIDE_CONFIRM_ENABLED: "1",
    LIVE_CONFIRM_ASYNC: "0",
    ...env,
  });
  return buildLiveAnalyzerConfig({
    cfg,
    job: { id: "job-d1-coverage", gameHint: "soccer" },
    clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
  });
}

/** The VOD observe posture: `decideWindowN` set, so `shouldRunConfirm` takes the
 *  VOD branch of the attestation predicate and the dive runs INLINE. */
function vodCfg(): any {
  return {
    jobId: "job-d1-vod",
    clipBeforeS: 4,
    clipAfterS: 4,
    gameHint: "soccer",
    confirmEnabled: true,
    observeLoop: true,
    decideWindowN: 24,
    // A big play is an OPT-IN label for the operator (`NON_GOAL_LABEL_OUTCOMES`),
    // so a promoted non-goal row needs it requested to be accepted at all.
    preferLabels: ["counter-attacks"],
  };
}

function makeClient(over: Partial<PipelineClient> = {}): PipelineClient {
  return {
    reservePerceive: async () => ({ sessionId: "sess-d1", appUrl: "", controlUrl: "" }),
    analyze: async (_sid: string, frame: any) => ({
      observation: { tracks: [], seq: frame?.seq ?? 0, timestamp: frame?.timestamp ?? 0 },
      candidate: { eventType: "SPORTING_EVENT", timestamp: frame?.timestamp ?? 0 },
    }),
    decide: async () => BIG_PLAY,
    plan: async () => ({
      planVersion: 1,
      category: "soccer",
      intent: "",
      source: "planner-fallback",
      maxTracks: 3,
      targets: [{ label: "player", role: "player" }],
      reason: "test",
    }),
    postAudio: async () => ({ candidate: null, series: [] }),
    controlForward: async () => null,
    train: async () => ({ run: "x", checkpoint: "/runs/x/model.safetensors" }),
    stopPerceive: async () => {},
    confirm: async () => ({
      enabled: true,
      goalConfirmed: "confirmed_goal",
      confidence: 0.9,
      reason: "ball in net",
      evidence: { ballInNet: true },
      stage1Disagreed: true,
      corroborated: true,
      corroborationSource: "frame_attestation",
      decision: GOAL_ACCEPT,
    }),
    ...over,
  } as PipelineClient;
}

async function* frames(n: number) {
  for (let i = 0; i < n; i++) yield { seq: i, timestamp: i, imageB64: `img${i}` };
}

describe("D1 trigger — a promoted row with no measured attestation is dived (ADAAAA-8796)", () => {
  it("fires for a promoted NON-goal read on the live rail", () => {
    const cfg = liveCfg();
    expect(shouldRunConfirm(cfg, { eventType: "SPORTING_EVENT" }, BIG_PLAY)).toBe(true);
    expect(shouldRunConfirm(cfg, { eventType: "SPORTING_EVENT" }, CELEBRATION)).toBe(true);
    // The goal-shaped promoted row is unchanged (it always dived).
    expect(shouldRunConfirm(cfg, { eventType: "GOAL" }, GOAL_ACCEPT)).toBe(true);
  });

  it("fires for the same row on the VOD rail — the rails must not diverge", () => {
    const cfg = vodCfg();
    expect(shouldRunConfirm(cfg, { eventType: "SPORTING_EVENT" }, BIG_PLAY)).toBe(true);
    expect(shouldRunConfirm(cfg, { eventType: "SPORTING_EVENT" }, CELEBRATION)).toBe(true);
    expect(shouldRunConfirm(cfg, { eventType: "GOAL" }, GOAL_ACCEPT)).toBe(true);
  });

  it("dives a MEASURED promoted row too (ADAAAA-8894/D4 dropped this skip)", () => {
    // D1 kept a cost bound here: a promoted row that already measured its own goal
    // was skipped ("the measured lane is its own corroboration"). D4 removed that
    // skip — it was the last class where a promoted card got no dive — and bounded
    // the added population by admission instead (`density_cap`). See
    // `live-confirm-coverage-8894.test.ts` for the precision and cost halves.
    const live = liveCfg();
    for (const candidate of [
      { eventType: "SPORTING_EVENT", goalCrossed: true },
      { eventType: "SPORTING_EVENT", ballOutcome: "goal" },
      { eventType: "SPORTING_EVENT", scoreBoardChanged: true },
    ]) {
      expect(shouldRunConfirm(live, candidate, BIG_PLAY)).toBe(true);
    }
    const vod = vodCfg();
    for (const candidate of [
      { eventType: "SPORTING_EVENT", goalCrossed: true },
      { eventType: "SPORTING_EVENT", ballOutcome: "goal" },
      { eventType: "SPORTING_EVENT", scoreBoardChanged: true },
    ]) {
      expect(shouldRunConfirm(vod, candidate, BIG_PLAY)).toBe(true);
    }
  });

  it("stays a strict no-op when the confirm lane is off", () => {
    expect(shouldRunConfirm({ confirmEnabled: false } as any, { eventType: "SPORTING_EVENT" }, BIG_PLAY)).toBe(false);
    expect(shouldRunConfirm({} as any, { eventType: "SPORTING_EVENT" }, BIG_PLAY)).toBe(false);
  });

  it("keeps a plain non-goal NON-accept out of the dive lane (nothing was promoted)", () => {
    const nonGoalNonAccept: DecisionResult = {
      isHighlight: false,
      score: 0,
      eventType: "SPORTING_EVENT",
      outcome: "not_highlight",
      reason: "open play",
    };
    expect(shouldRunConfirm(liveCfg(), { eventType: "SPORTING_EVENT" }, nonGoalNonAccept)).toBe(false);
    expect(shouldRunConfirm(vodCfg(), { eventType: "SPORTING_EVENT" }, nonGoalNonAccept)).toBe(false);
    // The delayed-corroboration bare-goal rescue (ADAAAA-7357) is untouched.
    const coarseGoalMiss: DecisionResult = {
      isHighlight: false,
      score: 0,
      eventType: "GOAL",
      outcome: "not_highlight",
    };
    expect(shouldRunConfirm(liveCfg(), { eventType: "GOAL" }, coarseGoalMiss)).toBe(true);
    expect(shouldRunConfirm(vodCfg(), { eventType: "GOAL" }, coarseGoalMiss)).toBe(true);
  });
});

describe("D1 precision — a non-goal row cannot be promoted by the dive (AC1.4)", () => {
  it("records the verdict but keeps the promoted big play a big play", async () => {
    const shared = new LiveRunShared();
    const out = await confirmReconcile(
      makeClient(),
      shared,
      vodCfg(),
      BIG_PLAY,
      { eventType: "SPORTING_EVENT", timestamp: 10 }
    );
    expect(out.confirmRan).toBe(true);
    // The dive said `confirmed_goal` with a frame attestation and even carried a
    // GOAL decision. D1 must NOT adopt that on a non-goal Stage-1 read.
    expect(out.decision.outcome).toBe("big_play");
    expect(out.decision.isHighlight).toBe(true);
    // ... but the verdict is observable on the row payload (AC1.1).
    expect(out.confirmAttestation).toMatchObject({
      goalConfirmed: "confirmed_goal",
      corroborated: true,
      corroborationSource: "frame_attestation",
    });
    expect(typeof out.confirmAttestation?.diveAt).toBe("string");
    expect(out.confirmAttestation?.diveLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("still adopts the verdict for a goal-shaped promoted row (no regression)", async () => {
    const shared = new LiveRunShared();
    const out = await confirmReconcile(
      makeClient(),
      shared,
      vodCfg(),
      GOAL_ACCEPT,
      { eventType: "GOAL", timestamp: 40 }
    );
    expect(out.confirmRan).toBe(true);
    expect(out.decision.outcome).toBe("scoring_play");
    expect(out.confirmAttestation?.goalConfirmed).toBe("confirmed_goal");
  });

  it("stamps a passthrough verdict instead of leaving the row silently un-dived (AC1.2)", async () => {
    const shared = new LiveRunShared();
    const out = await confirmReconcile(
      makeClient({
        confirm: async () => ({
          enabled: false,
          goalConfirmed: null,
          confidence: 0,
          reason: "",
          evidence: {},
          stage1Disagreed: false,
          decision: BIG_PLAY,
        }),
      }),
      shared,
      vodCfg(),
      BIG_PLAY,
      { eventType: "SPORTING_EVENT", timestamp: 20 }
    );
    expect(out.decision.outcome).toBe("big_play");
    expect(out.confirmAttestation?.goalConfirmed).toBe("passthrough");
  });

  it("stamps a terminal `dropped` verdict with its cause on a transport failure (AC1.2)", async () => {
    const shared = new LiveRunShared();
    const out = await confirmReconcile(
      makeClient({
        confirm: async () => {
          throw new Error("connect ECONNREFUSED decide-router:8081");
        },
      }),
      shared,
      vodCfg(),
      BIG_PLAY,
      { eventType: "SPORTING_EVENT", timestamp: 30 }
    );
    expect(out.decision.outcome).toBe("big_play");
    expect(out.confirmAttestation).toMatchObject({
      goalConfirmed: "dropped",
      dropReason: "transport_failure",
    });
  });
});

describe("D1 VOD rail end to end — the persisted row carries the verdict (AC1.1)", () => {
  it("keeps an accepted big play non-postable and stores confirmAttestation", async () => {
    const shared = new LiveRunShared();
    const outcome = await analyzeJob(
      makeClient(),
      frames(1),
      async (ts: number) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4`, hasAudio: true }),
      vodCfg(),
      undefined,
      undefined,
      shared
    );
    expect(outcome.highlights).toHaveLength(1);
    const row: any = outcome.highlights[0];
    // Coverage moved, the GOAL gate did not: still a big play, never postable.
    expect(row.outcome).toBe("big_play");
    expect(row.eventType).not.toBe("GOAL");
    // The dive ran and its verdict is on the row, so a reader can attribute it.
    expect(row.confirmAttestation).toMatchObject({
      goalConfirmed: "confirmed_goal",
      corroborated: true,
    });
    expect(shared.confirmMetrics.totalRuns).toBe(1);
  });

  it("does not demote a promoted non-goal row when the dive does not corroborate it", async () => {
    const shared = new LiveRunShared();
    const outcome = await analyzeJob(
      makeClient({
        // A dive that issues no verdict at all: the pre-D1 inline arm downgraded
        // the Stage-1 read to near_miss here, which would DELETE a promoted
        // highlight in the name of confirming it.
        confirm: async () => ({
          enabled: false,
          goalConfirmed: null,
          confidence: 0,
          reason: "",
          evidence: {},
          stage1Disagreed: false,
          decision: BIG_PLAY,
        }),
      }),
      frames(1),
      async (ts: number) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4`, hasAudio: true }),
      vodCfg(),
      undefined,
      undefined,
      shared
    );
    expect(outcome.highlights).toHaveLength(1);
    expect((outcome.highlights[0] as any).outcome).toBe("big_play");
    expect((outcome.highlights[0] as any).confirmAttestation?.goalConfirmed).toBe("passthrough");
  });
});
