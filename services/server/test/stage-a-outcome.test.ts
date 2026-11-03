// ADAAAA-7694: the Stage-A FP-rate metric must be MEASURED, not the all-zero
// `n/a` snapshot. Before this fix nothing in production called
// `StageAMetrics.recordOutcome()`, so `shared.stageA.snapshot()` was always
// all-zero and `stageAMetricsForJob()` always derived `stageAMetricsStatus:
// "n/a"` — even for a job whose audio tap fired candidates that the decide pass
// judged. These tests drive the REAL observers through `analyzeJob` on both
// rails (live decide-observer, VOD decide-observer) with a fired Stage-A
// trigger fed through the tap seam (`LiveRunShared.recordAudioTrigger`) and
// assert the persisted snapshot is `measured` with the deciding window's
// verdict, plus the `[live:...] / [vod:...] stageA` evidence line.
import { describe, it, expect } from "vitest";
import { analyzeJob, LiveRunShared, type PipelineClient as AnalyzeClient } from "../src/analyzer";
import { stageAMetricsForJob } from "../src/job-counters";
import { stageAEvidenceLine } from "../src/stage-a-metrics";
import { LIVE_OBSERVE_MAX_FRAMES } from "../src/observe-loop";
import type { AudioTriggerRecord } from "../src/audio-trigger";

/** A fired Stage-A trigger exactly as `audioTriggerFromCandidate` produces it
 *  from a perceive `/audio` candidate (gate kind/onset/latency/energies). */
function trigger(onsetTs: number, onsetLatencyS = 0.2): AudioTriggerRecord {
  return {
    kind: "burst",
    onsetTs,
    firedAt: onsetTs + onsetLatencyS,
    onsetLatencyS,
    peakEnergy: 0.8,
    baselineEnergy: 0.2,
    thresholdId: "stageA/burst/1.3x/0.3s",
  };
}

/** Fake PipelineClient whose decide verdict is fixed, so a test controls
 *  whether the window that judges the trigger cuts a highlight. */
function verdictClient(verdict: { isHighlight: boolean; outcome: string }) {
  const decidedAt: number[] = [];
  const client: AnalyzeClient = {
    reservePerceive: async () => ({ sessionId: "sess-stage-a", appUrl: "", controlUrl: "" }),
    analyze: async (_sid: string, frame: any) => ({
      observation: { tracks: [], seq: frame.seq, timestamp: frame.timestamp } as any,
    }),
    decide: async (_evidence: any) => {
      decidedAt.push(1);
      return {
        isHighlight: verdict.isHighlight,
        score: verdict.isHighlight ? 90 : 0,
        eventType: "SPORTING_EVENT",
        outcome: verdict.outcome,
      } as any;
    },
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
      enabled: false,
      confidence: 0,
      reason: "",
      evidence: {},
      stage1Disagreed: false,
      decision: { isHighlight: false, score: 0, outcome: "not_highlight" },
    }),
  };
  return { client, decidedAt };
}

function* frames(fps: number, durationS: number) {
  const n = Math.floor(durationS * fps);
  for (let i = 0; i < n; i++) {
    const ts = i / fps;
    yield { seq: i, timestamp: ts, imageB64: `f${ts}` };
  }
}

const cut = async (ts: number) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` });

/** LIVE rail: decide-observer on, `decideWindowN` UNSET (LiveObserver). */
const LIVE_CFG = {
  jobId: "job-stage-a-live",
  clipBeforeS: 4,
  clipAfterS: 4,
  gameHint: "soccer",
  liveObserveLoop: true,
  observeCadenceS: 3,
  observeWindowS: 10,
  observeMaxFrames: LIVE_OBSERVE_MAX_FRAMES,
  sampleFps: 5,
} as const;

/** VOD rail: decide-observer on WITH `decideWindowN` (ObserveDecider). */
const VOD_CFG = {
  jobId: "job-stage-a-vod",
  clipBeforeS: 4,
  clipAfterS: 4,
  gameHint: "soccer",
  observeLoop: true,
  observeCadenceS: 3,
  observeWindowS: 10,
  decideWindowN: 24,
  sampleFps: 2,
} as const;

describe("Stage-A outcome recording (ADAAAA-7694)", () => {
  it("LIVE: a trigger the anchored window ACCEPTS persists a measured, non-zero snapshot", async () => {
    const { client, decidedAt } = verdictClient({ isHighlight: true, outcome: "scoring_play" });
    const shared = new LiveRunShared();
    // The live audio tap routes a fired candidate here (api.ts -> recordAudioTrigger).
    expect(shared.recordAudioTrigger(trigger(2.0, 0.2))).toBe(true);

    await analyzeJob(client, frames(5, 12) as any, cut, { ...LIVE_CFG } as any, undefined, undefined, shared);

    // Decide really ran (the observer, not a trigger-gated candidate path).
    expect(decidedAt.length).toBeGreaterThan(1);
    const snap = shared.stageA.snapshot();
    expect(snap.totalCandidates).toBe(1); // one judged trigger, counted once
    expect(snap.accepted).toBe(1);
    expect(snap.rejected).toBe(0);
    expect(snap.fpRate).toBe(0);
    // Real onset latency sample from the gate record (not a synthetic 0).
    expect(snap.meanOnsetLatencyS).toBeCloseTo(0.2, 3);
    expect(snap.p50LatencyS).toBeCloseTo(0.2, 3);

    // The persisted counters are a MEASUREMENT, not the old all-zero "n/a".
    const counters = stageAMetricsForJob(snap);
    expect(counters.stageAMetricsStatus).toBe("measured");
    expect(counters.stageAMetrics?.totalCandidates).toBe(1);

    // ...and the per-job evidence line prints.
    const line = stageAEvidenceLine("live", LIVE_CFG.jobId, snap);
    expect(line).toBe(
      "[live:job-stage-a-live] stageA fpRate=0 (0/1 rejected), latency mean/max=0.2/0.2s, withinBudget=true"
    );
  });

  it("LIVE: a judged-but-REJECTED trigger is measured with fpRate 1 (was `n/a` before)", async () => {
    const { client } = verdictClient({ isHighlight: false, outcome: "not_highlight" });
    const shared = new LiveRunShared();
    shared.recordAudioTrigger(trigger(2.0, 1.9));

    await analyzeJob(client, frames(5, 12) as any, cut, { ...LIVE_CFG } as any, undefined, undefined, shared);

    const snap = shared.stageA.snapshot();
    expect(snap.totalCandidates).toBe(1);
    expect(snap.rejected).toBe(1);
    expect(snap.fpRate).toBe(1);
    expect(snap.fpRateWithinBudget).toBe(false);
    expect(stageAMetricsForJob(snap).stageAMetricsStatus).toBe("measured");
    expect(stageAEvidenceLine("live", LIVE_CFG.jobId, snap)).toContain("(1/1 rejected)");
    expect(stageAEvidenceLine("live", LIVE_CFG.jobId, snap)).toContain("withinBudget=false");
  });

  it("VOD: the decide window that covers the trigger's onset records its verdict", async () => {
    const { client } = verdictClient({ isHighlight: true, outcome: "scoring_play" });
    const shared = new LiveRunShared();
    // api.ts feeds the VOD tap's fired candidate through the same seam.
    shared.recordAudioTrigger(trigger(2.0, 0.4));

    await analyzeJob(client, frames(2, 12) as any, cut, { ...VOD_CFG } as any, undefined, undefined, shared);

    const snap = shared.stageA.snapshot();
    expect(snap.totalCandidates).toBe(1);
    expect(snap.accepted).toBe(1);
    expect(snap.meanOnsetLatencyS).toBeCloseTo(0.4, 3);
    expect(stageAMetricsForJob(snap).stageAMetricsStatus).toBe("measured");
    expect(stageAEvidenceLine("vod", VOD_CFG.jobId, snap)).toBe(
      "[vod:job-stage-a-vod] stageA fpRate=0 (0/1 rejected), latency mean/max=0.4/0.4s, withinBudget=true"
    );
  });

  it("no trigger -> still `n/a` (a measured zero must not be fabricated)", async () => {
    const { client } = verdictClient({ isHighlight: true, outcome: "scoring_play" });
    const shared = new LiveRunShared();

    await analyzeJob(client, frames(5, 12) as any, cut, { ...LIVE_CFG } as any, undefined, undefined, shared);

    expect(shared.stageA.totalCandidates).toBe(0);
    expect(stageAMetricsForJob(shared.stageA.snapshot()).stageAMetricsStatus).toBe("n/a");
    expect(stageAEvidenceLine("live", LIVE_CFG.jobId, shared.stageA.snapshot())).toBeNull();
  });
});
