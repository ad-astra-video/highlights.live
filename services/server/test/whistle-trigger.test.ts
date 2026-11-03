// ADAAAA-7707: the whistle trigger path must be WIRED, not merely switched on.
//
// The previous increment flipped `WhistleConfig.emitted = True` in perceive,
// which made the whistle ride the generic `res.candidate` slot. That reached
// `recordAudioTrigger` with no family identity at the boundary, so a whistle
// fire was judged into `stageAMetrics` (the published Stage-A fidelity) and no
// crowding counter existed. These tests pin the corrected wiring:
//
//   1. `audioTriggerFromWhistle` builds a `stageB/whistle/...` trigger from the
//      perceive `whistle` block, and builds NOTHING while the emit switch is off
//      (the config-only rollback must leave the wiring inert).
//   2. `LiveRunShared.recordAudioTrigger` routes `stageB/*` to its own ledger —
//      `stageAMetrics` cannot move because a whistle emitted.
//   3. A whistle trigger anchors ONE decide window in the live observer, and the
//      `observeMetrics` snapshot carries `whistleFires` / `whistleDecides` /
//      `whistleShare` so the ADAAAA-7713 25% tripwire is measurable.
import { describe, it, expect } from "vitest";
import {
  WHISTLE_THRESHOLD_ID,
  audioTriggerFromWhistle,
  isStageBTrigger,
  type AudioTriggerRecord,
  type WhistleFireBlock,
} from "../src/audio-trigger";
import { LiveObserver, OBSERVE_CADENCE_S } from "../src/observe-loop";
import { analyzeJob, buildLiveObserveMetrics, LiveRunShared, type PipelineClient } from "../src/analyzer";
import { stageAMetricsForJob } from "../src/job-counters";
import { whistleEvidenceLine } from "../src/stage-a-metrics";
import { LIVE_OBSERVE_MAX_FRAMES } from "../src/observe-loop";

/** The perceive `/audio` whistle block as shipped (emitted, not measure-only). */
function whistleBlock(overrides: Partial<WhistleFireBlock> = {}): WhistleFireBlock {
  return {
    kind: "burst",
    ts: 2.0,
    firedAt: 2.2,
    onsetLatencyS: 0.2,
    peakEnergy: 0.31,
    baselineEnergy: 0.02,
    thresholdId: WHISTLE_THRESHOLD_ID,
    emitted: true,
    measureOnly: false,
    sessionCandidates: 1,
    ...overrides,
  };
}

function whistleTrigger(onsetTs = 2.0, onsetLatencyS = 0.2): AudioTriggerRecord {
  return {
    kind: "burst",
    onsetTs,
    firedAt: onsetTs + onsetLatencyS,
    onsetLatencyS,
    peakEnergy: 0.31,
    baselineEnergy: 0.02,
    thresholdId: WHISTLE_THRESHOLD_ID,
  };
}

describe("audioTriggerFromWhistle (ADAAAA-7707 AC1)", () => {
  it("builds the frozen Stage-B trigger from the perceive whistle block", () => {
    const t = audioTriggerFromWhistle(whistleBlock());
    expect(t).not.toBeNull();
    expect(t!.thresholdId).toBe("stageB/whistle/2.4-3.4k/5x/0.3s");
    expect(t!.onsetTs).toBe(2.0);
    expect(t!.onsetLatencyS).toBeCloseTo(0.2, 3);
    expect(isStageBTrigger(t!.thresholdId)).toBe(true);
  });

  it("builds NOTHING while the emit switch is off (measure-only is inert)", () => {
    expect(audioTriggerFromWhistle(whistleBlock({ emitted: false, measureOnly: true }))).toBeNull();
    // a block that omits the switch state is not an emission either
    expect(audioTriggerFromWhistle(whistleBlock({ emitted: undefined, measureOnly: undefined }))).toBeNull();
  });

  it("rejects absent / malformed / wrong-family blocks instead of guessing", () => {
    expect(audioTriggerFromWhistle(null)).toBeNull();
    expect(audioTriggerFromWhistle(undefined)).toBeNull();
    expect(audioTriggerFromWhistle(whistleBlock({ ts: Number.NaN }))).toBeNull();
    expect(audioTriggerFromWhistle(whistleBlock({ onsetLatencyS: 9 }))).toBeNull();
    expect(audioTriggerFromWhistle(whistleBlock({ thresholdId: "stageA/burst/1.3x/0.3s" }))).toBeNull();
  });
});

describe("family-aware ledger (ADAAAA-7707 AC3)", () => {
  it("a whistle trigger reaches takeAudioTriggers without touching stageA", () => {
    const shared = new LiveRunShared();
    expect(shared.recordAudioTrigger(whistleTrigger())).toBe(true);

    const drained = shared.takeAudioTriggers();
    expect(drained).toHaveLength(1);
    expect(drained[0].thresholdId).toBe(WHISTLE_THRESHOLD_ID);

    // Stage-A fidelity is untouched: no candidate, so the job stays `n/a`.
    expect(shared.stageA.totalCandidates).toBe(0);
    expect(stageAMetricsForJob(shared.stageA.snapshot()).stageAMetricsStatus).toBe("n/a");
    // ...while the whistle path owns the fire.
    expect(shared.whistleTriggerCount()).toBe(1);
    expect(shared.stageBOutcomes.pendingCount()).toBe(1);
  });

  it("a stageA trigger still feeds only the Stage-A ledger", () => {
    const shared = new LiveRunShared();
    shared.recordAudioTrigger({ ...whistleTrigger(), thresholdId: "stageA/burst/1.3x/0.3s" });
    expect(shared.stageBOutcomes.pendingCount()).toBe(0);
    expect(shared.whistleTriggerCount()).toBe(0);
    expect(shared.stageAOutcomes.pendingCount()).toBe(1);
  });

  it("a LIVE whistle window is judged by the stageB ledger, never by stageA", async () => {
    const decidedAt: number[] = [];
    const client: PipelineClient = {
      reservePerceive: async () => ({ sessionId: "sess-whistle", appUrl: "", controlUrl: "" }),
      analyze: async (_sid: string, frame: any) => ({
        observation: { tracks: [], seq: frame.seq, timestamp: frame.timestamp } as any,
      }),
      decide: async () => {
        decidedAt.push(1);
        return { isHighlight: true, score: 90, eventType: "SPORTING_EVENT", outcome: "scoring_play" } as any;
      },
      plan: async () =>
        ({
          planVersion: 1,
          category: "soccer",
          intent: "",
          source: "planner-fallback",
          maxTracks: 3,
          targets: [{ label: "player", role: "player" }],
          reason: "test",
        }) as any,
      postAudio: async () => ({ candidate: null, series: [] }),
      controlForward: async () => null,
      train: async () => ({ run: "x", checkpoint: "/runs/x/model.safetensors" }),
      stopPerceive: async () => {},
      confirm: async () =>
        ({
          enabled: false,
          confidence: 0,
          reason: "",
          evidence: {},
          stage1Disagreed: false,
          decision: { isHighlight: false, score: 0, outcome: "not_highlight" },
        }) as any,
    };
    const shared = new LiveRunShared();
    shared.recordAudioTrigger(whistleTrigger(2.0, 0.2));

    const outcome = await analyzeJob(client, frames(5, 12) as any, cut, LIVE_CFG as any, undefined, undefined, shared);

    expect(decidedAt.length).toBeGreaterThan(1);
    // Stage-A stays a measured ZERO (`n/a`), not a whistle-skewed ledger.
    expect(shared.stageA.totalCandidates).toBe(0);
    expect(stageAMetricsForJob(shared.stageA.snapshot()).stageAMetricsStatus).toBe("n/a");
    // The whistle fire is measured in its own ledger instead.
    expect(shared.stageB.totalCandidates).toBe(1);
    expect(shared.stageB.acceptedCount).toBe(1);
    expect(shared.whistleTriggerCount()).toBe(1);

    // ...and the persisted snapshot carries the crowding counters.
    const m = outcome.observeMetrics!;
    expect(m.whistleFires).toBe(1);
    expect(m.whistleDecides).toBe(1);
    expect(m.whistleShare).toBeCloseTo(m.whistleDecides! / m.decideCalls, 4);
    const line = whistleEvidenceLine("live", LIVE_CFG.jobId, m)!;
    expect(line).toContain("stageB whistle fires=1 decides=1");
    expect(line).toContain(`decideCalls=${m.decideCalls}`);
  });

  it("ordinary play (no whistle) reports zero whistle volume and no Stage-A change", () => {
    const shared = new LiveRunShared();
    const m = buildLiveObserveMetrics(
      new LiveObserver({ cadenceS: OBSERVE_CADENCE_S, windowS: 10, maxFrames: 30, fps: 10, onDecide: async () => false })
    );
    expect(m.decideCalls).toBe(0);
    expect(m.whistleFires).toBe(0);
    expect(m.whistleDecides).toBe(0);
    expect(m.whistleShare).toBe(0);
    expect(shared.stageA.totalCandidates).toBe(0);
  });
});

describe("one whistle fire = one anchored analysis (ADAAAA-7707 AC2)", () => {
  it("keeps a whistle recorded ahead of a lagging frame clock and anchors it once", async () => {
    // Measured on job 4e54c757 (deployed, 2026-11-02): the audio tap runs ~10 s
    // ahead of a decide-lagged video rail, so the whistle block arrived while
    // the frame clock was still at ~32 s. The dropped (stale) spans then COVERED
    // the trigger's onset and the anchored analysis never fired
    // (`whistleFires:1, whistleDecides:0`). The dropped span must only cover
    // onsets older than the retained window.
    const seen: any[] = [];
    const run = new LiveRunShared();
    const obs = new LiveObserver({
      cadenceS: OBSERVE_CADENCE_S,
      windowS: 10,
      maxFrames: 30,
      fps: 3,
      stageA: run.stageAOutcomes,
      onDecide: async (p) => {
        seen.push(p);
        return false;
      },
    });
    for (let i = 0; i <= 99; i++) {
      const ts = Number((i / 3).toFixed(4));
      obs.record(ts, `frame-${ts}`, { ts });
      await obs.maybeFire(ts);
    }
    // the whistle fires at content 42.3 while the frame clock is at 33
    expect(obs.recordTrigger(whistleTrigger(42.3, 0.2))).toBe(true);
    // the lagging rail drops 33.3..44.9 as stale frames
    for (let i = 100; i <= 134; i++) obs.noteStaleFrame(Number((i / 3).toFixed(4)), 18);
    // the first affordable frame after the onset's lead fires ANCHORED
    obs.record(45, "frame-45", { ts: 45 });
    await obs.maybeFire(45);

    const anchored = seen.filter((p) => p.trigger);
    expect(anchored).toHaveLength(1);
    expect(anchored[0].trigger.thresholdId).toBe(WHISTLE_THRESHOLD_ID);
    expect(obs.whistleDecideCount()).toBe(1);
    expect(obs.whistleFireCount()).toBe(1);
  });

  it("still drops a trigger older than the retained window", () => {
    const obs = new LiveObserver({ cadenceS: 3, windowS: 10, maxFrames: 30, fps: 3, onDecide: async () => false });
    obs.recordTrigger(whistleTrigger(20));
    obs.record(45, "frame-45", { ts: 45 });
    obs.noteStaleFrame(45, 18);
    expect(obs.triggerStats().covered).toBe(1);
  });

  it("anchors exactly one decide window at the whistle onset", async () => {
    const seen: any[] = [];
    const run = new LiveRunShared();
    const obs = new LiveObserver({
      cadenceS: OBSERVE_CADENCE_S,
      windowS: 10,
      maxFrames: 30,
      fps: 10,
      stageA: run.stageAOutcomes,
      onDecide: async (p) => {
        seen.push(p);
        return false;
      },
    });
    let injected = false;
    for (let i = 0; i <= 120; i++) {
      const ts = Number((i / 10).toFixed(4));
      obs.record(ts, `frame-${ts}`, { ts });
      if (!injected && ts >= 2) {
        injected = true;
        // a re-fire inside the coalesce window is the SAME whistle
        expect(obs.recordTrigger(whistleTrigger(2.0))).toBe(true);
        expect(obs.recordTrigger(whistleTrigger(2.3))).toBe(false);
      }
      await obs.maybeFire(ts);
    }
    const anchored = seen.filter((p) => p.trigger);
    expect(anchored).toHaveLength(1);
    expect(anchored[0].trigger.thresholdId).toBe(WHISTLE_THRESHOLD_ID);
    expect(anchored[0].centerTs - anchored[0].trigger.onsetTs).toBeLessThanOrEqual(1.5);
    expect(obs.whistleFireCount()).toBe(1);
    expect(obs.whistleDecideCount()).toBe(1);
    expect(obs.triggerFireCount()).toBe(1);
    // no whistle verdict leaked into the Stage-A ledger
    expect(run.stageA.totalCandidates).toBe(0);
  });
});

function* frames(fps: number, durationS: number) {
  const n = Math.floor(durationS * fps);
  for (let i = 0; i < n; i++) {
    yield { seq: i, timestamp: i / fps, imageB64: `f${i / fps}` };
  }
}

const cut = async (ts: number) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` });

const LIVE_CFG = {
  jobId: "job-whistle-live",
  clipBeforeS: 4,
  clipAfterS: 4,
  gameHint: "soccer",
  liveObserveLoop: true,
  observeCadenceS: 3,
  observeWindowS: 10,
  observeMaxFrames: LIVE_OBSERVE_MAX_FRAMES,
  sampleFps: 5,
};
