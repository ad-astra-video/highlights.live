// ADAAAA-7878: `client.decide` must NOT run inside the frame-consume loop. The
// board directive on ADAAAA-7863: "client.decide should not be in the frame
// loop." Pre-fix the VOD ObserveDecider awaited `onDecide` (-> client.decide) for
// every fired window, so the ingest loop stalled for the whole gemma E2E
// (measured 5-14 s) and the live depth-1 fallback awaited inline too.
//
// This suite pins the fix:
//   (a) `maybeFire` ISSUES the window and returns — the caller keeps consuming
//       frames while the decide is in flight (framesConsumedDuringDecide >= 1),
//   (b) acceptance/Stage ledgers still apply in CONTENT order when decides
//       complete out of order (acceptVideoDecision keeps serial semantics),
//   (c) decide COUNT is unchanged: one billable decide per fired window, exactly
//       as the serial pass (no double-deciding, no dropped windows on a normal
//       clip),
//   (d) the pending queue is BOUNDED and a refusal is counted (never an
//       unbounded backlog, never a blocked ingest loop),
//   (e) `flush()` drains everything (metrics/accepts complete) and a decide
//       failure still fails the pass,
//   (f) end to end through `analyzeJob`: with the flag ON no `client.analyze`
//       runs inside a decide span, with it OFF the loop stalls (the pre-fix
//       signature) — and both runs decide the same number of windows.
import { describe, it, expect } from "vitest";
import { analyzeJob, type PipelineClient, type DecisionResult } from "../src/analyzer";
import { ObserveDecider, IngestGapTracker } from "../src/observe-loop";
import type { ObserveDecidePayload } from "../src/observe-loop";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function seed(ts: number) {
  return { ts, tracks: [], objects: [], ocr: [] };
}

/** Record a frame and attempt a cadence tick at `ts`. */
async function tick(observer: ObserveDecider, ts: number): Promise<void> {
  observer.record(ts, `f${ts}`, seed(ts) as any);
  await observer.maybeFire(ts);
}

describe("ObserveDecider off-loop decide (ADAAAA-7878)", () => {
  it("(a) issues the decide and returns: the loop keeps consuming while gemma judges", async () => {
    let releaseDecide: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseDecide = r;
    });
    let decideStarted = 0;
    const observer = new ObserveDecider({
      cadenceS: 0.5,
      windowS: 2,
      fps: 2,
      onDecideStaged: (_payload: ObserveDecidePayload) => ({
        decide: async () => {
          decideStarted++;
          await gate;
        },
        accept: async () => true,
      }),
    });
    const t0 = Date.now();
    for (let ts = 0; ts <= 3 + 1e-9; ts = Number((ts + 0.5).toFixed(6))) {
      await tick(observer, ts);
    }
    const elapsed = Date.now() - t0;
    // Seven cadence windows fired; the decides are all still in flight (the gate
    // is closed), yet `maybeFire` returned each time. Pre-fix this call would
    // have blocked on the FIRST decide.
    expect(decideStarted).toBeGreaterThanOrEqual(1);
    expect(observer.decideCalls()).toBeGreaterThanOrEqual(4);
    expect(observer.pendingApplyCount()).toBe(observer.decideCalls());
    expect(observer.decideInFlightDepth()).toBeGreaterThanOrEqual(1);
    expect(elapsed).toBeLessThan(150);
    releaseDecide();
    await observer.flush();
    expect(observer.pendingApplyCount()).toBe(0);
    expect(observer.decideInFlightDepth()).toBe(0);
  });

  it("(b) accepts in CONTENT order even when a later decide finishes first", async () => {
    const acceptedOrder: number[] = [];
    const centers = [0, 0.5, 1, 1.5, 2].map((t) => Number(t.toFixed(6)));
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let finished = 0;
    const observer = new ObserveDecider({
      cadenceS: 0.5,
      windowS: 2,
      fps: 2,
      maxInFlight: centers.length,
      onDecideStaged: (payload: ObserveDecidePayload) => ({
        decide: async () => {
          if (payload.centerTs === centers[0]) await firstGate;
          else await sleep(2);
          finished++;
          if (finished === centers.length - 1) releaseFirst();
        },
        accept: async () => {
          acceptedOrder.push(payload.centerTs);
          return true;
        },
      }),
    });
    for (const ts of centers) await tick(observer, ts);
    await observer.flush();
    // The first window's decide resolved LAST, but its verdict was applied FIRST.
    // `flush()` then re-fires the tail window at the last content ts (the historic
    // end-of-stream force fire), so the order is `centers` followed by that tail.
    expect(acceptedOrder.slice(0, centers.length)).toEqual(centers);
    const monotonic = acceptedOrder.every((v, i) => i === 0 || v >= acceptedOrder[i - 1]);
    expect(monotonic).toBe(true);
  });

  it("(c) decide COUNT and accept count are identical to the serial pass on the same frames", async () => {
    const centers = Array.from({ length: 12 }, (_, i) => Number((i * 0.5).toFixed(6)));
    const run = async (staged: boolean) => {
      let decides = 0;
      let accepts = 0;
      const observer = new ObserveDecider({
        cadenceS: 0.5,
        windowS: 2,
        fps: 2,
        ...(staged
          ? {
              onDecideStaged: () => ({
                decide: async () => {
                  decides++;
                  await sleep(1);
                },
                accept: async () => {
                  accepts++;
                  return true;
                },
              }),
            }
          : {
              onDecide: async () => {
                decides++;
                return true;
              },
            }),
      });
      for (const ts of centers) await tick(observer, ts);
      await observer.flush();
      return { decides, accepts, calls: observer.decideCalls(), accepted: observer.acceptedCount() };
    };
    const serial = await run(false);
    const offLoop = await run(true);
    expect(offLoop.decides).toBe(serial.decides);
    expect(offLoop.calls).toBe(serial.calls);
    expect(offLoop.accepted).toBe(serial.accepted);
    // Exactly one billable decide per fired window (no double-deciding).
    expect(offLoop.decides).toBe(offLoop.calls);
  });

  it("(d) bounds the pending queue and counts a refusal instead of growing forever", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let decides = 0;
    const observer = new ObserveDecider({
      cadenceS: 0.5,
      windowS: 2,
      fps: 2,
      maxPending: 1,
      onDecideStaged: () => ({
        decide: async () => {
          decides++;
          await gate;
        },
        accept: async () => true,
      }),
    });
    for (let ts = 0; ts <= 4 + 1e-9; ts = Number((ts + 0.5).toFixed(6))) {
      await tick(observer, ts);
    }
    expect(observer.pendingApplyCount()).toBeLessThanOrEqual(1);
    expect(observer.decideCalls()).toBe(1);
    expect(observer.queueFullSkipCount()).toBeGreaterThan(0);
    expect(decides).toBe(1);
    release();
    await observer.flush();
    expect(observer.pendingApplyCount()).toBe(0);
  });

  it("(e) flush drains every outstanding window and rethrows a decide failure", async () => {
    const observer = new ObserveDecider({
      cadenceS: 0.5,
      windowS: 2,
      fps: 2,
      onDecideStaged: (payload: ObserveDecidePayload) => ({
        decide: async () => {
          await sleep(5);
          if (payload.centerTs === 1) throw new Error("decide exploded");
        },
        accept: async () => true,
      }),
    });
    for (const ts of [0, 0.5, 1, 1.5, 2]) await tick(observer, ts);
    // The failure surfaces at flush, exactly like the serial pass threw out of
    // the frame loop — it must not be swallowed.
    await expect(observer.flush()).rejects.toThrow("decide exploded");
  });
});

describe("IngestGapTracker (ADAAAA-7878)", () => {
  it("reports the pre-fix stall signature (0 frames, one gap = the decide E2E)", () => {
    const lines: string[] = [];
    const gaps = new IngestGapTracker({ jobId: "job-serial", framePeriodMs: 500, log: (l) => lines.push(l) });
    gaps.noteAnalyze(1_000);
    gaps.noteAnalyze(1_500);
    // The decide starts right after the 1 500 ms analyze and nothing runs during it.
    const sample = gaps.recordWindow({ centerTs: 3, startedMs: 1_500, endedMs: 11_500 });
    expect(sample.framesConsumedDuringDecide).toBe(0);
    expect(sample.maxIngestGapMs).toBe(10_000);
    expect(sample.decideE2eMs).toBe(10_000);
    expect(lines[0]).toContain("[ingest-gap:job-serial]");
    expect(lines[0]).toContain("framesConsumedDuringDecide=0");
  });

  it("reports continuous ingest during an off-loop decide (frames >= 1, gap ~ frame period)", () => {
    const gaps = new IngestGapTracker({ jobId: "job-offloop", framePeriodMs: 500 });
    for (let t = 0; t <= 12_000; t += 500) gaps.noteAnalyze(t);
    const sample = gaps.recordWindow({ centerTs: 6, startedMs: 2_000, endedMs: 10_250 });
    expect(sample.framesConsumedDuringDecide).toBe(16);
    expect(sample.maxIngestGapMs).toBeLessThanOrEqual(500);
    expect(sample.p95IngestGapMs).toBeLessThanOrEqual(500);
  });
});

// --- end to end through analyzeJob ------------------------------------------

/** Fake client that measures whether `client.analyze` runs inside a decide span
 *  (the AC1 question) and how many decides a pass makes (the AC3 question). */
function gapClient(opts: { decideDelayMs: number }) {
  const analyzeStarts: number[] = [];
  const decideSpans: { startMs: number; endMs: number }[] = [];
  let decides = 0;
  const client: PipelineClient = {
    reservePerceive: async () => ({ sessionId: "sess-x", appUrl: "", controlUrl: "" }),
    analyze: async (_sid, _frame: any) => {
      analyzeStarts.push(Date.now());
      await sleep(3);
      return { observation: { tracks: [], objects: [], ocr: [], seq: 0, timestamp: 0 } } as any;
    },
    decide: async () => {
      const startMs = Date.now();
      decides++;
      await sleep(opts.decideDelayMs);
      decideSpans.push({ startMs, endMs: Date.now() });
      return { isHighlight: false, score: 10, eventType: "SPORTING_EVENT", outcome: "not_highlight" } as DecisionResult;
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
  /** Analyze calls that STARTED inside a decide span. */
  const analyzesInsideDecides = () =>
    decideSpans.reduce((n, s) => n + analyzeStarts.filter((t) => t > s.startMs && t < s.endMs).length, 0);
  return { client, decides: () => decides, decidesMade: () => decideSpans.length, analyzesInsideDecides };
}

function* frameSeq(n: number, stepS = 1) {
  for (let i = 0; i < n; i++) yield { seq: i, timestamp: Number((i * stepS).toFixed(6)), imageB64: `img${i}` };
}

const OBSERVE_CFG = {
  clipBeforeS: 4,
  clipAfterS: 4,
  gameHint: "soccer",
  decideWindowN: 24,
  observeLoop: true,
  observeCadenceS: 1,
  observeWindowS: 2,
  sampleFps: 2,
} as const;

describe("analyzeJob: VOD ingest continuity across the flag (ADAAAA-7878 AC1/AC3)", () => {
  const runJob = async (offLoop: boolean, frames: number, decideDelayMs: number) => {
    const fake = gapClient({ decideDelayMs });
    const cuts: number[] = [];
    const outcome = await analyzeJob(
      fake.client,
      frameSeq(frames, 0.5) as any,
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4`, hasAudio: true };
      },
      { ...OBSERVE_CFG, jobId: `job-gap-${offLoop ? "offloop" : "serial"}`, observeDecideOffLoop: offLoop },
      undefined
    );
    return { outcome, fake, cuts };
  };

  it("flag ON: no frame-consume stall during a decide; flag OFF reproduces the stall", async () => {
    const after = await runJob(true, 20, 120);
    const before = await runJob(false, 20, 120);
    // AC1: with the flag on the loop keeps calling analyze while gemma judges, so
    // some analyzes start INSIDE a decide span. Flags off = the pre-fix stall.
    expect(after.fake.decidesMade()).toBeGreaterThan(0);
    expect(after.fake.analyzesInsideDecides()).toBeGreaterThan(0);
    expect(before.fake.analyzesInsideDecides()).toBe(0);
  });

  it("decide count is unchanged by the flag (one billable decide per fired window)", async () => {
    const after = await runJob(true, 20, 60);
    const before = await runJob(false, 20, 60);
    expect(after.fake.decides()).toBe(before.fake.decides());
    expect(after.outcome.vodObserveMetrics?.decideCalls).toBe(before.outcome.vodObserveMetrics?.decideCalls);
    // No extra billed decides anywhere in the pass.
    expect(after.fake.decides()).toBe(after.fake.decidesMade());
  });

  it("job wall clock is strictly lower with the decide off the loop", async () => {
    const t0 = Date.now();
    const after = await runJob(true, 20, 120);
    const afterMs = Date.now() - t0;
    const t1 = Date.now();
    const before = await runJob(false, 20, 120);
    const beforeMs = Date.now() - t1;
    expect(after.fake.decides()).toBe(before.fake.decides());
    // Every serialize-vs-overlap comparison on the same frames: the pre-fix pass
    // pays analyze + decide serially, the off-loop pass hides the analyze work
    // behind the decide (the AC4 win, measured again on the box).
    expect(afterMs).toBeLessThan(beforeMs);
  });
});

// --- AC2: the LIVE depth-1 (crowded-box) fallback ---------------------------

/** Buffered live rail: 0.04 s content per frame, no wall pacing. */
function* liveFrames(count: number, stepS = 0.04) {
  for (let i = 0; i < count; i++) yield { seq: i, timestamp: Number((i * stepS).toFixed(6)), imageB64: `lf${i}` };
}

const LIVE_OBSERVE_CFG = {
  clipBeforeS: 4,
  clipAfterS: 4,
  gameHint: "soccer",
  liveObserveLoop: true,
  observeCadenceS: 0.2,
  observeWindowS: 1,
  observeMaxFrames: 30,
  sampleFps: 25,
  liveObserveContentFps: 1000,
  liveObserveLagBudgetS: 3,
} as const;

describe("analyzeJob: LIVE depth-1 fallback issues and does not await (ADAAAA-7878 AC2)", () => {
  const runLive = async (offLoop: boolean) => {
    const fake = gapClient({ decideDelayMs: 120 });
    const outcome = await analyzeJob(
      fake.client,
      liveFrames(120) as any,
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { ...LIVE_OBSERVE_CFG, jobId: `job-live-${offLoop ? "offloop" : "serial"}`, liveObserveInFlight: 1, observeDecideOffLoop: offLoop } as any,
      undefined
    );
    return { outcome, fake };
  };

  it("keeps ingest running while the single in-flight decide judges, and stays at depth 1", async () => {
    const after = await runLive(true);
    expect(after.fake.decidesMade()).toBeGreaterThan(0);
    // AC2: frames keep being consumed while that one decide is in flight.
    expect(after.fake.analyzesInsideDecides()).toBeGreaterThan(0);
    // Depth 1 is preserved: at most ONE decide is outstanding at a time, and at
    // most one decide is billed per window (no double-deciding).
    expect(after.outcome.observeMetrics!.maxDecideInFlight).toBe(1);
    expect(after.outcome.observeMetrics!.decideCalls).toBe(after.fake.decidesMade());
  });

  it("flag OFF reproduces the pre-7878 in-loop stall at depth 1", async () => {
    const before = await runLive(false);
    expect(before.fake.decidesMade()).toBeGreaterThan(0);
    expect(before.fake.analyzesInsideDecides()).toBe(0);
  });
});

