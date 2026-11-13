/**
 * ADAAAA-8844 (Inc 2): identity-verified score surface.
 *
 * A live stream carried a PIP of another game with its own score bug; the
 * scoreboard OCR read THAT bug, saw its score change, and a clip was cut. Inc 1
 * pinned the bug per job (ADAAAA-8835). This increment makes a score change an
 * ATTESTATION only when the surface can be shown to be this match's surface.
 *
 * These tests pin the server half of the rule:
 *  - the fold withholds a score change measured on a CONTRADICTED surface and
 *    carries the REASON instead, so decide cannot force a goal off it (AC2.3);
 *  - `absent` identity keeps today's behaviour byte-identically (the recall risk
 *    AC2.2/AC2.3 guard);
 *  - the accept lane can never derive `authority: scoreboard` from a demoted
 *    window, and the demotion note leads the refusal copy (scope item 5);
 *  - the block is persisted from the SAME fold the live and VOD paths read, and
 *    the team reference rides the same carriage to perceive on both rails
 *    (AC2.6: VOD carries the same rule).
 */
import { describe, expect, it } from "vitest";
import {
  analyzeJob,
  buildObserveDecideRequest,
  foldWindowAttestation,
  liveGoalAttestationUsed,
  liveUnattestedGoalRefusal,
  type AnalyzerConfig,
  type PipelineClient,
} from "../src/analyzer";
import { LiveRunShared } from "../src/analyzer";
import type { ObserveDecidePayload, PerFrameSeed } from "../src/observe-loop";
import {
  declaredScoreboardSurface,
  nextScoreboardSurface,
  normalizeSurfaceIdentity,
  scoreboardSurfaceAttests,
  scoreboardSurfaceDemotionNote,
  withSurfaceDemotion,
  type ScoreboardSurfaceBlock,
} from "../src/scoreboard-surface";
import { liveSurfaceWiring, scoreboardSurfaceTracker, withMatchContextTeams } from "../src/api";

const CONTRADICTED = {
  verdict: "contradicted" as const,
  kitDistance: 0.62,
  threshold: 0.35,
  kitsPresent: true,
  kitsDiffer: true,
  namesMatch: false,
  namesMatched: [],
  names: ["LALIGA", "AL1"],
  kits: { home: [230, 220, 20], away: [0, 200, 200] },
};

const DEMOTION =
  "score change on a contradicted score surface: ignored (kits Δ=0.62 > 0.35; printed names LALIGA, AL1 unmatched)";

function payload(biasHints: ObserveDecidePayload["biasHints"]): ObserveDecidePayload {
  const seeds: PerFrameSeed[] = [
    { ts: 0, objects: [{ label: "ball", confidence: 0.9, bbox: [0.5, 0.5, 0.6, 0.6] }] },
  ];
  return {
    centerTs: 10,
    frames: [{ ts: 0, imageB64: "f0" }],
    seeds,
    biasHints,
    capped: false,
    droppedCount: 0,
  };
}

/** A fake store whose `patchJob` records what the tracker persists. */
function fakeStore(block?: ScoreboardSurfaceBlock) {
  const writes: any[] = [];
  let job: any = { id: "job-1", scoreboardSurface: block };
  return {
    writes,
    getJob: () => job,
    patchJob: async (_id: string, patch: any) => {
      writes.push(patch);
      job = { ...job, ...patch };
      return job;
    },
  };
}

describe("surface identity normalisation (stored shape)", () => {
  it("keeps a measured verdict and drops an unrecognised one", () => {
    expect(normalizeSurfaceIdentity(CONTRADICTED)?.verdict).toBe("contradicted");
    expect(normalizeSurfaceIdentity({ verdict: "foreign" })).toBeUndefined();
    expect(normalizeSurfaceIdentity("contradicted")).toBeUndefined();
    expect(normalizeSurfaceIdentity(null)).toBeUndefined();
  });

  it("coerces the numbers/lists it stores and never invents a kit", () => {
    const identity = normalizeSurfaceIdentity({
      verdict: "contradicted",
      kitDistance: 0.6200001,
      threshold: 0.35,
      kits: { home: [230.4, 220, 20], away: [0, 200], weird: [1, 2, 3] },
      names: Array.from({ length: 20 }, (_, i) => `N${i}`),
      namesMatched: ["Real Madrid"],
    })!;
    expect(identity.kitDistance).toBeCloseTo(0.62, 5);
    expect(identity.kits).toEqual({ home: [230, 220, 20] });
    expect(identity.names).toHaveLength(8);
    expect(identity.namesMatched).toEqual(["Real Madrid"]);
  });

  it("only a contradicted surface withholds attestation (absent keeps today)", () => {
    expect(scoreboardSurfaceAttests(undefined)).toBe(true);
    expect(scoreboardSurfaceAttests({ ...declaredScoreboardSurface([0, 0, 1, 0.2]), identity: { verdict: "absent" } })).toBe(true);
    expect(scoreboardSurfaceAttests({ ...declaredScoreboardSurface([0, 0, 1, 0.2]), identity: { verdict: "consistent" } })).toBe(true);
    expect(scoreboardSurfaceAttests({ ...declaredScoreboardSurface([0, 0, 1, 0.2]), identity: CONTRADICTED })).toBe(false);
  });

  it("names the measurement in the demotion note (scope item 5)", () => {
    const note = scoreboardSurfaceDemotionNote(CONTRADICTED)!;
    expect(note).toContain("contradicted score surface");
    expect(note).toContain("0.62");
    expect(note).toContain("0.35");
    expect(note).toContain("LALIGA");
    expect(scoreboardSurfaceDemotionNote({ verdict: "absent" })).toBe("");
  });
});

describe("the folded block (identity + demotion)", () => {
  it("latches a measured identity on the SAME box and drops it on a new one", () => {
    const first = nextScoreboardSurface(undefined, {
      scoreboardRoi: [0, 0, 0.5, 0.2],
      scoreboardRoiSource: "explicit",
      scoreboardRoiVerified: true,
      seq: 0,
      scoreboardSurfaceIdentity: CONTRADICTED,
    })!;
    expect(first.identity?.verdict).toBe("contradicted");

    // Same box, no new reading: the verdict is a property of the surface.
    const same = nextScoreboardSurface(first, {
      scoreboardRoi: [0, 0, 0.5, 0.2],
      scoreboardRoiSource: "explicit",
      seq: 3,
    })!;
    expect(same.identity?.verdict).toBe("contradicted");

    // A different box has NOT been measured yet: it must not inherit a verdict
    // (an unmeasured surface is `absent`, not this match's proven one).
    const moved = nextScoreboardSurface(first, {
      scoreboardRoi: [0.5, 0.5, 1, 1],
      scoreboardRoiSource: "discovery",
      seq: 4,
    })!;
    expect(moved.identity).toBeUndefined();
    expect(scoreboardSurfaceAttests(moved)).toBe(true);
  });

  it("folds a demotion that arrives without a reported box", () => {
    const block = { ...declaredScoreboardSurface([0, 0, 1, 0.2]), verified: true };
    const next = withSurfaceDemotion(block, DEMOTION)!;
    expect(next.demotion).toBe(DEMOTION);
    expect(withSurfaceDemotion(next, DEMOTION)).toBeUndefined(); // no write for a repeat
    expect(withSurfaceDemotion(undefined, DEMOTION)).toBeUndefined();
  });

  it("persists through the tracker and answers attests/verdict from the SAME block", async () => {
    const store = fakeStore({ ...declaredScoreboardSurface([0, 0, 0.5, 0.2]) });
    const tracker = scoreboardSurfaceTracker(store as any, "job-1");
    expect(tracker.attests()).toBe(true);
    expect(tracker.verdict()).toBeUndefined();

    tracker.onObservation({
      scoreboardRoi: [0, 0, 0.5, 0.2],
      scoreboardRoiSource: "explicit",
      scoreboardRoiVerified: true,
      seq: 1,
      scoreboardSurfaceIdentity: CONTRADICTED,
      scoreboardSurfaceDemoted: DEMOTION,
    } as any);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0].scoreboardSurface.identity.verdict).toBe("contradicted");
    expect(store.writes[0].scoreboardSurface.demotion).toBe(DEMOTION);
    // the read side follows the fold, so the accept lane cannot disagree
    expect(tracker.attests()).toBe(false);
    expect(tracker.verdict()).toBe("contradicted");
  });

  it("liveSurfaceWiring hands the analyzer writer + both reads off one tracker", async () => {
    const store = fakeStore({ ...declaredScoreboardSurface([0, 0, 0.5, 0.2]) });
    const wiring = liveSurfaceWiring(store as any, "job-1");
    expect(typeof wiring.onScoreboardSurface).toBe("function");
    expect(typeof wiring.getScoreboardSurfaceAttests).toBe("function");
    expect(typeof wiring.getScoreboardSurfaceVerdict).toBe("function");
    wiring.onScoreboardSurface!({
      scoreboardRoi: [0, 0, 0.5, 0.2],
      scoreboardRoiSource: "explicit",
      seq: 2,
      scoreboardSurfaceIdentity: CONTRADICTED,
    } as any);
    expect(wiring.getScoreboardSurfaceAttests!()).toBe(false);
    expect(wiring.getScoreboardSurfaceVerdict!()).toBe("contradicted");
  });
});

describe("the window fold (AC2.3 at the source)", () => {
  it("carries the demotion as a REASON, never as a score attestation", () => {
    const att = foldWindowAttestation([
      { eventType: "GOAL", ts: 9, scoreBoardChanged: false, surfaceDemotion: DEMOTION },
      { eventType: "GOAL", ts: 9.5, surfaceDemotion: DEMOTION },
    ]);
    expect(att.scoreBoardChanged).toBeUndefined();
    expect(att.surfaceDemotion).toBe(DEMOTION);
  });

  it("leaves a window with no demotion byte-identical", () => {
    const att = foldWindowAttestation([{ eventType: "GOAL", ts: 9, scoreBoardChanged: true }]);
    expect(att.scoreBoardChanged).toBe(true);
    expect(att.surfaceDemotion).toBeUndefined();
  });

  it("puts the verdict on the decide evidence, and nothing when unmeasured", () => {
    const withVerdict = buildObserveDecideRequest(
      {
        gameHint: "soccer",
        getScoreboardSurfaceVerdict: () => "contradicted",
      } as unknown as AnalyzerConfig,
      new LiveRunShared(),
      payload([{ eventType: "GOAL", ts: 9, scoreBoardChanged: false, surfaceDemotion: DEMOTION }])
    );
    expect(withVerdict.evidence.scoreboardSurfaceIdentity).toBe("contradicted");
    expect(withVerdict.evidence.surfaceDemotion).toBe(DEMOTION);
    expect(withVerdict.evidence.scoreBoardChanged).toBeUndefined();

    // No measured surface => no key at all (byte-identical decide payload).
    const unmeasured = buildObserveDecideRequest(
      { gameHint: "soccer" } as unknown as AnalyzerConfig,
      new LiveRunShared(),
      payload([{ eventType: "GOAL", ts: 9, scoreBoardChanged: true }])
    );
    expect("scoreboardSurfaceIdentity" in unmeasured.evidence).toBe(false);
    expect("surfaceDemotion" in unmeasured.evidence).toBe(false);
    expect(unmeasured.evidence.scoreBoardChanged).toBe(true);
  });
});

describe("the accept lane (AC2.1 / scope item 5)", () => {
  it("a demoted window can never claim scoreboard authority", () => {
    const used = liveGoalAttestationUsed({
      attribution: {
        scoreBoardChanged: true,
        surfaceDemotion: DEMOTION,
        scoreBoardDelta: { pre: [0, 0], post: [1, 0] } as any,
      },
      corroborated: true,
      corroborationSource: "scoreboard",
      transitionKey: "0-0>1-0",
      transitionDelta: { pre: [0, 0], post: [1, 0] } as any,
      scoreReads: { scoreReads: 9, preSamples: 4, postSamples: 4, need: 2 } as any,
    });
    expect(used.scoreBoardChanged).toBe(false);
    expect(used.authority).toBe("none");
    expect(used.surfaceDemotion).toBe(DEMOTION);
    expect(used.transitionKey).toBeUndefined();
  });

  it("leads the refusal copy with the real reason", () => {
    const used = liveGoalAttestationUsed({
      attribution: { scoreBoardChanged: false, surfaceDemotion: DEMOTION },
      corroborated: true,
      rationale: undefined as never,
    } as any);
    expect(liveUnattestedGoalRefusal(used)).toBe(DEMOTION);
  });
});

describe("the team reference carriage (AC2.6: live and VOD carry the same rule)", () => {
  it("shapes the job's match context teams and drops what identity cannot use", () => {
    const shaped = withMatchContextTeams(undefined, [
      { side: "home", name: "Real Madrid", kitColors: [{ primary: "white", secondary: "blue" }] },
      { side: "away", name: "FC Barcelona", kitColors: [{ primary: "blue" }] },
      { side: "home", kitColors: [] }, // nothing usable
      "junk",
    ])!;
    expect(shaped.matchContextTeams).toEqual([
      { side: "home", name: "Real Madrid", kitColors: [{ primary: "white", secondary: "blue" }] },
      { side: "away", name: "FC Barcelona", kitColors: [{ primary: "blue" }] },
    ]);
  });

  it("sends nothing when the job has no resolved match context", () => {
    expect(withMatchContextTeams(undefined, undefined)).toBeUndefined();
    expect(withMatchContextTeams(undefined, [])).toBeUndefined();
    const base = { goalLine: { position: 0.5 } };
    expect(withMatchContextTeams(base, [] as any)).toEqual(base);
  });

  it("the VOD rail reads the same fold, so a foreign surface cannot attest there either", () => {
    // The VOD path builds its analyzer config with the SAME `liveSurfaceWiring`
    // helper and the SAME `buildObserveDecideRequest` fold as live, so one
    // demoted observation produces the same refusal on a VOD job.
    const store = fakeStore({ ...declaredScoreboardSurface([0, 0, 0.5, 0.2]) });
    const wiring = liveSurfaceWiring(store as any, "vod-job");
    wiring.onScoreboardSurface!({
      scoreboardRoi: [0, 0, 0.5, 0.2],
      scoreboardRoiSource: "explicit",
      seq: 1,
      scoreboardSurfaceIdentity: CONTRADICTED,
      scoreboardSurfaceDemoted: DEMOTION,
    } as any);
    const vodCfg = {
      gameHint: "soccer",
      getScoreboardSurfaceAttests: wiring.getScoreboardSurfaceAttests,
      getScoreboardSurfaceVerdict: wiring.getScoreboardSurfaceVerdict,
    } as unknown as AnalyzerConfig;
    expect(wiring.getScoreboardSurfaceAttests!()).toBe(false);
    const { evidence } = buildObserveDecideRequest(
      vodCfg,
      new LiveRunShared(),
      payload([{ eventType: "GOAL", ts: 9, scoreBoardChanged: false, surfaceDemotion: DEMOTION }])
    );
    expect(evidence.scoreboardSurfaceIdentity).toBe("contradicted");
    expect(evidence.scoreBoardChanged).toBeUndefined();
  });
});

describe("the VOD/file rail (AC2.6)", () => {
  function fakeVodClient(over: Partial<PipelineClient> = {}): PipelineClient {
    return {
      reservePerceive: async () => ({ sessionId: "sess-vod", appUrl: "", controlUrl: "" }),
      analyze: async () => ({ observation: { tracks: [], seq: 0, timestamp: 0 } }),
      decide: async () => ({ isHighlight: true, score: 80, eventType: "GOAL" }),
      plan: async () => ({ planVersion: 1, category: "soccer", intent: "", source: "planner-fallback", maxTracks: 3, targets: [], reason: "test" }),
      stopPerceive: async () => {},
      postAudio: async () => ({ candidate: null, series: [] }),
      controlForward: async () => null,
      train: async () => ({ run: "x", checkpoint: "/runs/x/model.safetensors" }),
      confirm: async () => ({ enabled: false, goalConfirmed: null, confidence: 0, reason: "", evidence: {}, stage1Disagreed: false, decision: { isHighlight: false, score: 0, eventType: "GOAL" } }),
      ...over,
    } as PipelineClient;
  }

  async function* frames(n: number) {
    for (let i = 0; i < n; i++) yield { seq: i, timestamp: i, imageB64: `img${i}` };
  }

  it("a demoted score change from a VOD/file analyze cannot reach decide as attestation", async () => {
    let seen: any;
    const client = fakeVodClient({
      analyze: async () => ({
        observation: {
          tracks: [],
          seq: 0,
          timestamp: 0,
          scoreBoardChanged: true,
          scoreboardSurfaceDemoted: DEMOTION,
        },

      } as any),
      decide: async (evidence: any) => {
        seen = evidence;
        return { isHighlight: false, score: 0, eventType: "GOAL" };
      },
    });
    await analyzeJob(client, frames(3), async () => ({ clipId: "c", clipUri: "/c.mp4", hasAudio: true }), {
      jobId: "vod-job",
      clipBeforeS: 4,
      clipAfterS: 4,
      gameHint: "soccer",
      liveObserveLoop: true,
      // the same wiring the VOD path installs (liveSurfaceWiring)
      getScoreboardSurfaceAttests: () => false,
      getScoreboardSurfaceVerdict: () => "contradicted",
    } as any);
    expect(seen).toBeTruthy();
    expect(seen.scoreboardSurfaceIdentity).toBe("contradicted");
    expect(seen.scoreBoardChanged).toBeUndefined();
    expect(seen.surfaceDemotion).toBe(DEMOTION);
  });

  it("an unmeasured VOD surface keeps today's decide evidence (no key, score change intact)", async () => {
    const evs: any[] = [];
    const client = fakeVodClient({
      analyze: async () => ({ observation: { tracks: [], seq: 0, timestamp: 0, scoreBoardChanged: true } } as any),
      decide: async (evidence: any) => {
        evs.push(evidence);
        return { isHighlight: true, score: 80, eventType: "GOAL" };
      },
    });
    await analyzeJob(client, frames(3), async () => ({ clipId: "c", clipUri: "/c.mp4", hasAudio: true }), {
      jobId: "vod-job-2",
      clipBeforeS: 4,
      clipAfterS: 4,
      gameHint: "soccer",
      liveObserveLoop: true,
    } as any);
    expect(evs.length).toBeGreaterThan(0);
    // The score change reaches decide as it does today, and NO identity key is
    // added to any request (byte-identical payload on an unmeasured surface).
    expect(evs.every((e) => !("scoreboardSurfaceIdentity" in e))).toBe(true);
    expect(evs.every((e) => !("surfaceDemotion" in e))).toBe(true);
  });
});
