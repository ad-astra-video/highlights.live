// ADAAAA-8139 (interim step, CEO ask 2026-11-06): a demoted goal window whose
// ASR transcript carries a goal call (and/or whose frames read as a celebration)
// must be SURFACED as a provisional goal instead of a silent celebration — while
// staying a `big_play`, so it can never be postable — and the deferred
// re-attestation must CLEAR the marker when the scoreboard change lands.
//
// Cost contract pinned here: the cue comes only from evidence the window already
// paid for (the ADAAAA-8081 ASR transcript, the decide description, the Stage-A
// crowd peak). The accept seam below makes no OCR / decide / perceive call, so a
// test that stubs every client call with `{}` passing is itself the proof.
import { describe, expect, it } from "vitest";
import { HighlightRecordSchema } from "@highlights/events";
import {
  LIVE_UNATTESTED_GOAL_NOTE,
  LiveRunShared,
  acceptVideoDecision,
  type AnalyzerConfig,
  type CandidateSignal,
  type DecisionResult,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer.js";
import {
  PROVISIONAL_CROWD_ENERGY_MIN,
  asrCarriesGoalCall,
  deriveProvisionalGoal,
  descriptionReadsAsCelebration,
} from "../src/live-provisional-goal.js";

function liveCfg(over: Partial<AnalyzerConfig> = {}): AnalyzerConfig {
  return {
    jobId: "job-8139-provisional",
    gameHint: "soccer",
    clipBeforeS: 6,
    clipAfterS: 9,
    clipWindowMinSec: 15,
    preferLabels: [],
    confirmEnabled: false,
    liveObserveLoop: true,
    ...over,
  } as AnalyzerConfig;
}

function motionCandidate(ts: number, extra: Partial<CandidateSignal> = {}): CandidateSignal {
  return { eventType: "SPORTING_EVENT", timestamp: ts, ...extra } as CandidateSignal;
}

/** The goal-shaped read the gate demotes: the model says a goal was scored but
 * no measured attestation is in the window. */
function goalRead(reason = "A striker finishes low into the corner."): DecisionResult {
  return {
    isHighlight: true,
    score: 84,
    outcome: "scoring_play",
    eventType: "GOAL",
    reason,
  } as DecisionResult;
}

const LEGIBLE_DELTA: ScoreboardDeltaEvidence = {
  pre: [1, 1],
  post: [2, 1],
  preTs: 16.1,
  postTs: 16.9,
  deltaTs: 16.9,
  preSamples: 4,
  postSamples: 4,
};

interface Harness {
  run: LiveRunShared;
  accept: (
    ts: number,
    stage1: DecisionResult,
    candidateExtra?: Partial<CandidateSignal>
  ) => Promise<void>;
}

function harness(over: Partial<AnalyzerConfig> = {}): Harness {
  const run = new LiveRunShared({ audioRetainS: 400 });
  const cfg = liveCfg(over);
  const cut = async (t: number) => ({ clipId: `clip-${t.toFixed(3)}`, clipUri: `file://clip-${t.toFixed(3)}.mp4` });
  const client = { decide: async () => ({}) as any, confirm: async () => ({}) as any } as any;
  let seq = 0;
  const accept = async (ts: number, stage1: DecisionResult, candidateExtra: Partial<CandidateSignal> = {}) => {
    seq += 1;
    await acceptVideoDecision(
      client,
      run,
      cut,
      cfg,
      () => {},
      { seq, timestamp: ts },
      motionCandidate(ts, candidateExtra),
      stage1,
      undefined,
      undefined,
      undefined,
      { lo: ts - 10, hi: ts }
    );
  };
  return { run, accept };
}

describe("asrCarriesGoalCall — a commentary goal call, never the apparatus", () => {
  it("fires on the calls a commentator makes when the ball has gone in", () => {
    expect(asrCarriesGoalCall("It's a goal! Real Madrid lead")).toBe(true);
    expect(asrCarriesGoalCall("GOOOAL for Barcelona")).toBe(true);
    expect(asrCarriesGoalCall("she scores from close range")).toBe(true);
    expect(asrCarriesGoalCall("what a finish by the number nine")).toBe(true);
    expect(asrCarriesGoalCall("Goal to Sporting, 2-1")).toBe(true);
  });

  it("never fires on the goal apparatus, a disallowed goal, or a saved shot", () => {
    expect(asrCarriesGoalCall("goal kick to the visitors")).toBe(false);
    expect(asrCarriesGoalCall("the goal line technology is not in use")).toBe(false);
    expect(asrCarriesGoalCall("no goal, the flag is up")).toBe(false);
    expect(asrCarriesGoalCall("the goal is disallowed after review")).toBe(false);
    expect(asrCarriesGoalCall("his shot is saved by the keeper")).toBe(false);
    expect(asrCarriesGoalCall("")).toBe(false);
    expect(asrCarriesGoalCall(undefined)).toBe(false);
  });
});

describe("deriveProvisionalGoal — fail-closed cue derivation", () => {
  it("marks a demoted window whose ASR carries a goal call", () => {
    const m = deriveProvisionalGoal({ windowTs: 16.95, asrTranscript: "It's a goal!" });
    expect(m).toBeDefined();
    expect(m!.status).toBe("provisional");
    expect(m!.cues).toEqual(["asr_goal_call"]);
    expect(m!.declaredTs).toBe(16.95);
    expect(m!.note).toMatch(/provisional goal/);
    expect(m!.note).toMatch(/no measured scoreboard change/);
  });

  it("marks a celebration read with no ASR at all (frames-only cue)", () => {
    const m = deriveProvisionalGoal({
      windowTs: 40,
      description: "Players run to the corner with arms raised, the bench celebrates",
    });
    expect(m?.cues).toEqual(["frame_celebration"]);
  });

  it("marks a measured crowd reaction (burst above the threshold)", () => {
    const m = deriveProvisionalGoal({
      windowTs: 40,
      crowdEnergy: PROVISIONAL_CROWD_ENERGY_MIN + 0.1,
      audioKind: "burst",
    });
    expect(m?.cues).toEqual(["crowd_reaction"]);
  });

  it("does NOT fire on a flat curve or a narration-level energy change", () => {
    expect(deriveProvisionalGoal({ windowTs: 40, crowdEnergy: 0.9, audioKind: "" })).toBeUndefined();
    expect(
      deriveProvisionalGoal({ windowTs: 40, crowdEnergy: PROVISIONAL_CROWD_ENERGY_MIN - 0.1, audioKind: "swell" })
    ).toBeUndefined();
  });

  it("never marks a window that carries a measured scoreboard change", () => {
    expect(
      deriveProvisionalGoal({ windowTs: 40, asrTranscript: "It's a goal!", scoreBoardChanged: true })
    ).toBeUndefined();
  });

  it("returns nothing for a plain big play with no cue", () => {
    expect(deriveProvisionalGoal({ windowTs: 40, description: "A defender clears the ball" })).toBeUndefined();
  });

  it("orders cues deterministically when several fire", () => {
    const a = deriveProvisionalGoal({
      windowTs: 40,
      asrTranscript: "It's a goal!",
      description: "the players celebrate with arms raised",
      crowdEnergy: 0.8,
      audioKind: "swell",
    });
    const b = deriveProvisionalGoal({
      windowTs: 40,
      audioKind: "swell",
      crowdEnergy: 0.8,
      description: "the players celebrate with arms raised",
      asrTranscript: "It's a goal!",
    });
    expect(a?.cues).toEqual(["asr_goal_call", "frame_celebration", "crowd_reaction"]);
    expect(b?.cues).toEqual(a?.cues);
  });
});

describe("the record contract (packages/events)", () => {
  it("accepts a provisional marker as an additive optional field", () => {
    const parsed = HighlightRecordSchema.parse({
      id: "h1",
      jobId: "j1",
      clipUri: "file://a.mp4",
      start: 10,
      end: 25,
      score: 88,
      status: "accepted",
      createdAt: new Date().toISOString(),
      provisionalGoal: {
        status: "provisional",
        cues: ["asr_goal_call"],
        declaredTs: 16.95,
        note: "provisional goal",
      },
    });
    expect(parsed.provisionalGoal?.cues).toEqual(["asr_goal_call"]);
  });

  it("rejects an unknown cue (the marker can never name evidence that does not exist)", () => {
    expect(() =>
      HighlightRecordSchema.parse({
        id: "h1",
        jobId: "j1",
        clipUri: "file://a.mp4",
        start: 10,
        end: 25,
        score: 88,
        status: "accepted",
        createdAt: new Date().toISOString(),
        provisionalGoal: { status: "provisional", cues: ["scoreboard_delta"], declaredTs: 1, note: "x" },
      })
    ).toThrow();
  });

  it("round-trips a row that carries no marker (every legacy row)", () => {
    expect(
      HighlightRecordSchema.parse({
        id: "h1",
        jobId: "j1",
        clipUri: "file://a.mp4",
        start: 10,
        end: 25,
        score: 88,
        status: "accepted",
        createdAt: new Date().toISOString(),
      }).provisionalGoal
    ).toBeUndefined();
  });
});

describe("the accept seam — a demoted goal is surfaced as provisional, never postable", () => {
  it("stamps the marker from the ASR goal call and keeps the row a celebration", async () => {
    const h = harness();
    const stage1 = goalRead();
    (stage1 as any).analysis = { asr: { transcript: "It's a goal! Madrid are level", latencyS: 0.4, ran: true } };
    await h.accept(16.95, stage1);

    expect(h.run.highlights.length).toBe(1);
    const row = h.run.highlights[0];
    // The ADAAAA-7996/8085 contract is untouched: still a celebration row.
    expect(row.outcome).toBe("big_play");
    expect(row.eventType).toBe("BIG_PLAY");
    expect(row.reason).toContain(LIVE_UNATTESTED_GOAL_NOTE.split(";")[0].slice(0, 40));
    // The interim surface: the row names itself a goal candidate.
    expect(row.provisionalGoal?.status).toBe("provisional");
    expect(row.provisionalGoal?.cues).toContain("asr_goal_call");
    expect(row.provisionalGoal?.declaredTs).toBe(16.95);
    // Auditable from the row alone, in the reason too.
    expect(row.reason).toContain("provisional goal");
    // The demotion's own disclosure is unchanged.
    expect(row.attestationUsed?.scoreBoardChanged).toBe(false);
  });

  it("stamps nothing when the window is plainly a celebration with no goal cue", async () => {
    const h = harness();
    await h.accept(120, goalRead("A defender clears the ball upfield"));
    const row = h.run.highlights[0];
    expect(row.outcome).toBe("big_play");
    expect(row.provisionalGoal).toBeUndefined();
  });

  it("stamps nothing on an attested goal (the gate never demoted it)", async () => {
    const h = harness();
    await h.accept(16.95, goalRead(), { scoreBoardChanged: true, scoreBoardDelta: LEGIBLE_DELTA });
    const row = h.run.highlights[0];
    expect(row.outcome).toBe("scoring_play");
    expect(row.provisionalGoal).toBeUndefined();
  });

  it("is zero-added-call: the ASR text is the one the decide already returned", async () => {
    // The harness stubs decide/confirm with `{}`; a cue that needed an OCR,
    // perceive or decide call would have to go through one of them, so the
    // marker appearing here is the cost proof.
    const h = harness();
    const stage1 = goalRead("the players celebrate with arms raised");
    await h.accept(59.46, stage1);
    expect(h.run.highlights[0].provisionalGoal?.cues).toEqual(["frame_celebration"]);
  });
});

describe("the confirm half — the deferred re-attestation clears the marker", () => {
  it("a provisional row becomes a plain GOAL row when the score change lands", async () => {
    const { Store } = await import("../src/store.js");
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/tmp/live.mp4", gameHint: "soccer" });
    await s.addHighlight({
      id: "h-prov",
      jobId: job.id,
      clipUri: "/clips/h-prov.mp4",
      start: 10,
      end: 25,
      status: "accepted",
      score: 84,
      outcome: "big_play",
      eventType: "BIG_PLAY",
      reason: "A striker finishes low into the corner. | provisional goal: asr_goal_call",
      provisionalGoal: {
        status: "provisional",
        cues: ["asr_goal_call"],
        declaredTs: 16.95,
        note: "provisional goal: asr_goal_call in the judged window, no measured scoreboard change yet",
      },
      createdAt: new Date().toISOString(),
    } as any);
    expect(s.getHighlight("h-prov")!.provisionalGoal?.status).toBe("provisional");

    // The SAME patch `attestDeferredGoalHighlight` sends when a later read
    // measures the transition (api.ts).
    const attested = await s.attestDeferredGoal("h-prov", {
      outcome: "scoring_play",
      eventType: "GOAL",
      reason: "A striker finishes low into the corner.",
      caption: undefined,
      cardTitles: undefined,
      colour: undefined,
      reason_raw: undefined,
      provisionalGoal: undefined,
      deferredAttestation: { deltaTs: 16.9, readAt: 22.4, windowLo: 6.95, windowHi: 16.95, pre: [1, 1], post: [2, 1] },
    });
    expect(attested.outcome).toBe("scoring_play");
    expect(attested.eventType).toBe("GOAL");
    // The interim marker must not survive onto the confirmed GOAL row.
    expect(attested.provisionalGoal).toBeUndefined();
    expect(s.getHighlight("h-prov")!.provisionalGoal).toBeUndefined();
    // The audit trail of the upgrade itself is untouched.
    expect(attested.deferredAttestation?.deltaTs).toBe(16.9);
  });

  it("a row with no marker upgrades exactly as before (legacy rows)", async () => {
    const { Store } = await import("../src/store.js");
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/tmp/live2.mp4", gameHint: "soccer" });
    await s.addHighlight({
      id: "h-plain",
      jobId: job.id,
      clipUri: "/clips/h-plain.mp4",
      start: 40,
      end: 55,
      status: "accepted",
      score: 70,
      outcome: "big_play",
      eventType: "BIG_PLAY",
      reason: "celebration",
      createdAt: new Date().toISOString(),
    } as any);
    const attested = await s.attestDeferredGoal("h-plain", {
      outcome: "scoring_play",
      eventType: "GOAL",
      reason: "goal",
      provisionalGoal: undefined,
    });
    expect(attested.provisionalGoal).toBeUndefined();
    expect(attested.outcome).toBe("scoring_play");
  });
});
