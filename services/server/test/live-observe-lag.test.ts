// ADAAAA-7676: the live observe pass must not run unboundedly behind the wall
// clock. On a loaded box one decide costs ~8–13 s wall per ~3 s of content, so
// the serial live loop fell further behind every tick: a window labelled
// `T+42s` was decided at wall `+242s` (~5.7x) and the captured-frame backlog
// grew without bound. This suite pins the fix:
//   (a) LiveObserver counts the cadence windows a stale drop swallows and keeps
//       the ~3 s content cadence across the drop (AC3: never buy freshness with
//       a slower cadence, never decide more often),
//   (b) a dropped frame never enters a decide window,
//   (c) analyzeJob drops stale frames/windows once the measured content-vs-wall
//       lag exceeds the budget and reports `skippedStaleWindows` on the job
//       metrics (AC2), with the completed lag bounded (AC1),
//   (d) budget <= 0 keeps the legacy unbounded behaviour (opt-out control).
import { describe, it, expect } from "vitest";
import { analyzeJob, buildLiveObserveMetrics, type PipelineClient } from "../src/analyzer";
import { LiveObserver, LIVE_OBSERVE_LAG_BUDGET_S } from "../src/observe-loop";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeObserver() {
  const payloads: any[] = [];
  const observer = new LiveObserver({
    cadenceS: 3,
    windowS: 10,
    fps: 2,
    onDecide: async (payload) => {
      payloads.push(payload);
      return false;
    },
  });
  return { observer, payloads };
}

describe("LiveObserver stale-window drop (ADAAAA-7676)", () => {
  it("(a)+(b): a stale drop advances the cadence clock, counts skipped windows, and never decides the dropped frames", async () => {
    const { observer, payloads } = makeObserver();
    // First observation anchors the loop at content ts 0.
    observer.record(0, "f0", { ts: 0, tracks: [], objects: [], ocr: [] });
    await observer.maybeFire(0, false, 12000);
    expect(payloads.length).toBe(1);
    expect(observer.skippedStaleWindowCount()).toBe(0);
    expect(observer.lastSample()?.lagMs).toBe(12000);

    // Three seconds of dropped content = ONE skipped cadence window.
    expect(observer.noteStaleFrame(3, 15)).toBe(1);
    // Another 3.5 s of dropped content = one more skipped window.
    expect(observer.noteStaleFrame(6.5, 18)).toBe(1);
    expect(observer.skippedStaleWindowCount()).toBe(2);

    // The next fired window is one cadence (3 s of content) after the drop, so
    // the measured cadence stays <= 3 s (AC3) — freshness is bought by dropping
    // work, never by deciding more often.
    observer.record(9.5, "f9.5", { ts: 9.5, tracks: [], objects: [], ocr: [] });
    await observer.maybeFire(9.5, false, 900);
    expect(payloads.length).toBe(2);
    const sample = observer.lastSample()!;
    expect(sample.centerTs).toBe(9.5);
    expect(sample.cadenceMs).toBeCloseTo(3000, 3);
    expect(sample.completedLagMs).toBeGreaterThanOrEqual(900);

    // (b) the dropped frames are NOT in the decided window — only the frames
    // actually recorded (before and after the drop) are carried.
    const lastPayload = payloads[1];
    const ts = lastPayload.frames.map((f: any) => frameTs(f.imageB64));
    expect(ts).toEqual([0, 9.5]);
    expect(ts).not.toContain(3);
    expect(ts).not.toContain(6.5);

    // Metrics carry the AC2 counter + the measured lag.
    const m = buildLiveObserveMetrics(observer);
    expect(m.skippedStaleWindows).toBe(2);
    expect(m.maxLagMs).toBe(18000);
    expect(m.meanLagMs).toBeCloseTo(16500, 0);
    expect(m.maxCompletedLagMs).toBeGreaterThanOrEqual(900);
    expect(m.meanCadenceMs).toBeLessThanOrEqual(3000);
  });

  it("does not count a skipped window before the first observation (the drop only anchors the clock)", () => {
    const { observer } = makeObserver();
    expect(observer.noteStaleFrame(4, 20)).toBe(0);
    expect(observer.skippedStaleWindowCount()).toBe(0);
    expect(observer.maxObservedLagMs()).toBe(20000);
  });

  it("defaults to the 30 s cadence+E2E budget", () => {
    expect(LIVE_OBSERVE_LAG_BUDGET_S).toBe(30);
  });
});

// --- analyzeJob integration: a slow live producer/consumer -------------------

function frameTs(b64: string): number {
  return Number(b64.replace(/^f/, ""));
}

function makeClient(decideMs: number) {
  const decided: { evidence: any; opts: any; tickTs: number }[] = [];
  let currentFrameTs = 0;
  const client: PipelineClient = {
    reservePerceive: async () => ({ sessionId: "sess-lag", appUrl: "", controlUrl: "" }),
    analyze: async (_sid: string, frame: any) => {
      currentFrameTs = frame.timestamp;
      return { observation: { tracks: [], seq: frame.seq, timestamp: frame.timestamp } as any };
    },
    decide: async (evidence: any, dOpts: any) => {
      decided.push({ evidence, opts: dOpts, tickTs: currentFrameTs });
      if (decideMs > 0) await sleep(decideMs);
      return { isHighlight: false, score: 0, outcome: "not_highlight" } as any;
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
  } as any;
  return { client, decided };
}

/**
 * A live-shaped frame rail: content advances `sampleSec` per frame while the
 * wall clock advances `intervalMs` per frame, so a slow decide stretches the
 * content-vs-wall lag exactly like the deployed live loop.
 */
async function* slowFrames(sampleSec: number, count: number, intervalMs: number) {
  for (let i = 0; i < count; i++) {
    const ts = Number((i * sampleSec).toFixed(6));
    if (intervalMs > 0) await sleep(intervalMs);
    yield { seq: i, timestamp: ts, imageB64: `f${ts}` };
  }
}

const BASE_CFG = {
  jobId: "job-live-lag",
  clipBeforeS: 4,
  clipAfterS: 4,
  gameHint: "soccer",
  liveObserveLoop: true,
  observeCadenceS: 0.2,
  observeWindowS: 1,
  observeMaxFrames: 30,
  sampleFps: 25,
} as const;

/** Cadence windows the 60-frame / 0.04 s-content-per-frame rail spans. */
const TOTAL_WINDOWS = Math.floor((60 * 0.04) / 0.2);

describe("analyzeJob live lag bound (ADAAAA-7676)", () => {
  it("(c): drops stale windows past the budget, counts them on the job, keeps cadence <= cadence and the completed lag bounded", async () => {
    const { client, decided } = makeClient(300);
    const outcome = await analyzeJob(
      client,
      slowFrames(0.04, 60, 4) as any,
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { ...BASE_CFG, liveObserveLagBudgetS: 0.3 } as any,
      undefined
    );
    const m = outcome.observeMetrics!;
    // AC2: the queue is bounded — stale windows are DROPPED and counted.
    expect(m.skippedStaleWindows).toBeGreaterThan(0);
    // AC1: no dropped window is decided late; the observed lag stays inside the
    // budget + one decide (the decide that was already in flight).
    expect(m.maxLagMs).toBeLessThanOrEqual(300 + 300 + 250);
    // AC3: the content cadence between DECIDED windows is unchanged by the drop.
    expect(m.meanCadenceMs).toBeLessThanOrEqual(200 * 1.05);
    // Fewer billable decides than the unbounded pass would have issued.
    const totalWindows = TOTAL_WINDOWS;
    expect(m.decideCalls).toBeLessThan(totalWindows);
    expect(decided.length).toBe(m.decideCalls);
    // The measured "what a viewer sees" lag is bounded, and the LAST decided
    // window's frame set is non-empty (the pass kept analyzing the live edge).
    expect(m.maxCompletedLagMs).toBeLessThanOrEqual(300 + 300 + 300);
    const lastTs = decided[decided.length - 1].opts.frames.map((f: any) => frameTs(f.base64));
    expect(lastTs.length).toBeGreaterThan(0);
  }, 30000);

  it("(d): budget <= 0 keeps the legacy unbounded behaviour (control)", async () => {
    const { client, decided } = makeClient(300);
    const outcome = await analyzeJob(
      client,
      slowFrames(0.04, 60, 4) as any,
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { ...BASE_CFG, liveObserveLagBudgetS: 0 } as any,
      undefined
    );
    const m = outcome.observeMetrics!;
    expect(m.skippedStaleWindows).toBe(0);
    // Every cadence window is decided (plus the end-of-stream tail tick), and
    // the lag accumulated without bound — the exact shape the drop removes.
    expect(m.decideCalls).toBeGreaterThanOrEqual(TOTAL_WINDOWS);
    expect(decided.length).toBe(m.decideCalls);
    expect(m.maxCompletedLagMs).toBeGreaterThan(900);
  }, 30000);
});
