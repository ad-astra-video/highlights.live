// ADAAAA-7011: server integration test for the LIVE decide-observer wired into
// the live job path (services/server/src/analyzer.ts analyzeJob live branch,
// `cfg.liveObserveLoop` on, `decideWindowN` UNSET). Drives analyzeJob with a
// mocked PipelineClient whose `analyze` emits NO candidate, and proves:
//   (a) decide fires on the ~3 s cadence even when perceive emits NO candidate,
//   (b) every decide payload is <= 30 frames,
//   (c) the rolling window never contains frames after the tick's content time,
//   (d) cadence + decide gemma E2E latency is recorded and reported.
import { describe, it, expect } from "vitest";
import { analyzeJob, type PipelineClient } from "../src/analyzer";
import { LIVE_OBSERVE_MAX_FRAMES } from "../src/observe-loop";

function frameTs(b64: string): number {
  return Number(b64.replace(/^f/, ""));
}

function makeClient(opts: {
  candidateEventTypes?: Map<number, string>; // frame seq -> candidate eventType
  onDecide?: (evidence: any, dOpts: any) => void;
} = {}) {
  const decided: { evidence: any; opts: any; tickTs: number }[] = [];
  // The content time of the frame currently being analyzed; a decide fired
  // during processing of that frame is anchored at this tick's content time.
  let currentFrameTs = 0;
  const candidateEventTypes = opts.candidateEventTypes ?? new Map<number, string>();
  const client: PipelineClient = {
    reservePerceive: async () => ({ sessionId: "sess-live", appUrl: "", controlUrl: "" }),
    analyze: async (_sid: string, frame: any) => {
      currentFrameTs = frame.timestamp;
      const observation: any = { tracks: [], seq: frame.seq, timestamp: frame.timestamp };
      const ev = candidateEventTypes.get(frame.seq);
      return ev
        ? { observation, candidate: { eventType: ev, timestamp: frame.timestamp } }
        : { observation };
    },
    decide: async (evidence: any, dOpts: any) => {
      decided.push({ evidence, opts: dOpts, tickTs: currentFrameTs });
      opts.onDecide?.(evidence, dOpts);
      return { isHighlight: false, score: 0, outcome: "not_highlight" };
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
    postAudio: async () => null,
    controlForward: async () => {},
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
  return { client, decided };
}

function* frames(fps: number, durationS: number) {
  const n = Math.floor(durationS * fps);
  for (let i = 0; i < n; i++) {
    const ts = i / fps;
    yield { seq: i, timestamp: ts, imageB64: `f${ts}` };
  }
}

/** Live (default) analyzer config with the decide-observer enabled. */
const LIVE_OBSERVE_CFG = {
  jobId: "job-live-observe",
  clipBeforeS: 4,
  clipAfterS: 4,
  gameHint: "soccer",
  liveObserveLoop: true,
  observeCadenceS: 3,
  observeWindowS: 10,
  observeMaxFrames: LIVE_OBSERVE_MAX_FRAMES,
  sampleFps: 8, // dense assembly so a 10 s window would exceed 30 -> cap exercised
} as const;

describe("LIVE decide-observer wiring (ADAAAA-7011)", () => {
  it("(a)+(b)+(c)+(d): decide fires on cadence with NO candidate, every payload <=30 frames, window never decodes ahead, latency recorded+reported", async () => {
    const { client, decided } = makeClient(); // no candidates ever
    const outcome = await analyzeJob(
      client,
      frames(5, 20) as any, // 5 fps over 20 s (dense enough to exceed the 30-frame cap)
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { ...LIVE_OBSERVE_CFG } as any,
      undefined
    );

    // (a) decide fires on the cadence even though perceive emitted NO candidate.
    expect(decided.length).toBeGreaterThan(3); // ~3 s cadence over 20 s -> several ticks
    // The very first tick is anchored at content time 0 (first frame).
    expect(decided[0].tickTs).toBe(0);

    // (b) every decide payload is <= 30 frames.
    for (const d of decided) {
      expect(d.opts.frames.length).toBeLessThanOrEqual(LIVE_OBSERVE_MAX_FRAMES);
    }

    // (c) the rolling window never contains frames after the tick's content time:
    // each payload's newest frame equals the tick's content time and no frame
    // is later than it (no decode-ahead in the rolling-PAST window).
    for (const d of decided) {
      const ts = d.opts.frames.map((f: any) => frameTs(f.base64));
      expect(Math.max(...ts)).toBeCloseTo(d.tickTs, 5); // anchored at the tick
      for (const t of ts) expect(t).toBeLessThanOrEqual(d.tickTs + 1e-9); // never after
      // The window is the trailing ~windowS seconds ending at the tick.
      const lo = d.tickTs - 10;
      for (const t of ts) expect(t).toBeGreaterThanOrEqual(lo - 1e-9);
    }

    // (d) cadence + decide gemma E2E latency is recorded and reported.
    expect(outcome.observeMetrics).toBeDefined();
    const m = outcome.observeMetrics!;
    expect(m.decideCalls).toBe(decided.length);
    expect(m.maxFrames).toBeLessThanOrEqual(LIVE_OBSERVE_MAX_FRAMES);
    expect(m.meanE2eMs).toBeGreaterThanOrEqual(0);
    expect(m.maxE2eMs).toBeGreaterThanOrEqual(0);
    expect(m.accepted).toBe(0); // we returned not_highlight everywhere
    // Regular cadence ticks are ~3 s apart in content time (the first tick's
    // cadenceMs is 0 and is filtered out of the mean/max).
    expect(m.maxCadenceMs).toBeGreaterThanOrEqual(2.9 * 1000);
    expect(m.maxCadenceMs).toBeLessThanOrEqual(3.1 * 1000);
    expect(m.meanCadenceMs).toBeGreaterThan(0);
  });

  it("folds a perceive candidate into biasHints (evidence eventType prop), never gating decide", async () => {
    // A candidate (GOAL) fires on frame seq 4; decide must still run on cadence
    // and the candidate folds into the per-window bias hint (provenance).
    const { client, decided } = makeClient({ candidateEventTypes: new Map([[4, "GOAL"]]) });
    const outcome = await analyzeJob(
      client,
      frames(5, 12) as any,
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { ...LIVE_OBSERVE_CFG } as any,
      undefined
    );
    // decide still fires (candidate did not gate it off).
    expect(decided.length).toBeGreaterThan(2);
    // The window that contains the candidate carries it as the bias hint, which
    // becomes the decide evidence eventType (provenance, not a gate).
    const sawGoal = decided.some((d) => d.evidence.eventType === "GOAL");
    // Every other decide (no bias hint in window) defaults to SPORTING_EVENT.
    const defaulted = decided.some((d) => d.evidence.eventType === "SPORTING_EVENT");
    expect(sawGoal).toBe(true);
    expect(defaulted).toBe(true);
    expect(outcome.observeMetrics!.decideCalls).toBe(decided.length);
  });
});
