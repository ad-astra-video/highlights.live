// ADAAAA-7771: the LIVE observe pass must keep up to K decide windows IN
// FLIGHT per stream. Measured on the deployed box (ADAAAA-7769): decide capacity
// is not the constraint (the two-worker pair sustains 1.56-1.60 decides/s
// against 0.33 decides/s per stream), yet coverage stayed at 33 % / 21-24 % /
// 15-16 % because the loop AWAITED each decide — one decide in flight, ~7.3 s of
// work per 3 s window, so the lag budget dropped ~70-86 of ~100 windows as
// stale. This suite pins the fix:
//   (a) the serial path (no staged callback) is unchanged: one decide at a time,
//   (b) with depth K the expensive decide half overlaps up to K-wide and the
//       accept gate is still applied in CONTENT order, even when a later decide
//       finishes first (acceptVideoDecision has serial semantics),
//   (c) the depth is BOUNDED: a full queue is backpressure (counted), never an
//       unbounded backlog, and no window is decided twice (one decide per decide
//       call = the billing invariant),
//   (d) `flush()` drains every outstanding decide before the job reports, so
//       metrics/accepts are complete and a decide failure still fails the run,
//   (e) end to end through `analyzeJob`: a decide slower than the cadence
//       decides MORE windows at depth 3 than serially, and reports the depth it
//       actually used (`maxDecideInFlight`).
import { describe, it, expect } from "vitest";
import { analyzeJob, buildLiveObserveMetrics, type PipelineClient } from "../src/analyzer";
import { LiveObserver } from "../src/observe-loop";
import type { ObserveDecidePayload } from "../src/observe-loop";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function seed(ts: number) {
  return { ts, tracks: [], objects: [], ocr: [] };
}

/** Drive the observer's cadence on a pretends-real clock: record a frame and
 *  attempt a fire at every `cadenceS` of content time. */
async function drive(observer: LiveObserver, from: number, to: number, step: number): Promise<void> {
  for (let ts = from; ts <= to + 1e-9; ts += step) {
    const at = Number(ts.toFixed(6));
    observer.record(at, `f${at}`, seed(at) as any);
    await observer.maybeFire(at, false, 0);
  }
}

describe("LiveObserver pipelined decide depth (ADAAAA-7771)", () => {
  it("(b)+(c): runs up to K decides at once, accepts in CONTENT order, and decides each window once", async () => {
    const acceptedOrder: number[] = [];
    const decidedCenters: number[] = [];
    const contentOrder = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => Number(t.toFixed(6)));
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const observer = new LiveObserver({
      cadenceS: 0.2,
      windowS: 1,
      fps: 10,
      // Deep enough that no window is refused: this test is about ORDER, not
      // backpressure.
      maxInFlight: contentOrder.length,
      onDecideStaged: (payload: ObserveDecidePayload) => {
        decidedCenters.push(payload.centerTs);
        return {
          decide: async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            // The FIRST window is the slowest: it only completes after every
            // other window has decided, so completion order is REVERSED
            // relative to content order. The accept order must not follow it.
            if (payload.centerTs === 0) await firstGate;
            else await sleep(payload.centerTs === contentOrder[1] ? 10 : 5);
            active--;
            completed++;
            if (completed === contentOrder.length - 1) releaseFirst();
          },
          accept: async () => {
            acceptedOrder.push(payload.centerTs);
            return true;
          },
        };
      },
    });

    await drive(observer, 0, 1, 0.2);
    await observer.flush();

    // Never more than K decides outstanding...
    expect(maxActive).toBeLessThanOrEqual(contentOrder.length);
    expect(maxActive).toBe(contentOrder.length);
    expect(observer.maxInFlightDepth()).toBe(contentOrder.length);
    // ...acceptance is strictly in content order (the slow first window settles
    // last but is applied first) — `slice` drops the end-of-stream force fire,
    // which re-observes the newest window (pre-existing flush behaviour)...
    expect(acceptedOrder.slice(0, contentOrder.length)).toEqual(contentOrder);
    // ...and every window is decided EXACTLY once: one decide per decide call,
    // the billing invariant (no double-deciding of the same window). The last
    // entry is the end-of-stream force fire at the newest window.
    expect(decidedCenters).toEqual([...contentOrder, contentOrder[contentOrder.length - 1]]);
    expect(observer.decideCalls()).toBe(contentOrder.length + 1); // + tail force fire
    expect(observer.pendingApplyCount()).toBe(0);
    expect(observer.inFlightDepth()).toBe(0);
  });

  it("(a): the serial path (no staged callback) still runs one decide at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const accepted: number[] = [];
    const observer = new LiveObserver({
      cadenceS: 0.2,
      windowS: 1,
      fps: 10,
      onDecide: async (payload) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(10);
        active--;
        accepted.push(payload.centerTs);
        return true;
      },
    });
    await drive(observer, 0, 0.8, 0.2);
    await observer.flush();
    expect(maxActive).toBe(1);
    expect(observer.maxInFlightDepth()).toBe(0);
    expect(observer.backpressureSkipCount()).toBe(0);
    // Content order, plus the end-of-stream tail fire (flush force-fires the
    // newest window — the pre-existing serial behaviour, unchanged here).
    expect(accepted.slice(0, 5)).toEqual([0, 0.2, 0.4, 0.6000000000000001, 0.8].map((t) => Number(t.toFixed(6))));
  });

  it("(c): a full in-flight queue is backpressure, counted once per window, never an unbounded backlog", async () => {
    let active = 0;
    let maxActive = 0;
    const observer = new LiveObserver({
      cadenceS: 0.2,
      windowS: 1,
      fps: 10,
      maxInFlight: 2,
      onDecideStaged: () => ({
        decide: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await sleep(60);
          active--;
        },
        accept: async () => false,
      }),
    });
    await drive(observer, 0, 2, 0.2);
    await observer.flush();
    // The depth caps the outstanding work...
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(observer.maxInFlightDepth()).toBe(2);
    // ...refused ticks are counted (not silently dropped) and stay distinct from
    // a stale drop, which never happened here (lagMs = 0).
    expect(observer.backpressureSkipCount()).toBeGreaterThan(0);
    expect(observer.skippedStaleWindowCount()).toBe(0);
    const m = buildLiveObserveMetrics(observer);
    expect(m.backpressureSkippedWindows).toBe(observer.backpressureSkipCount());
    expect(m.maxDecideInFlight).toBe(2);
    expect(m.skippedStaleWindows).toBe(0);
  });

  it("(d): flush drains every outstanding decide before reporting", async () => {
    const applied: number[] = [];
    const observer = new LiveObserver({
      cadenceS: 0.2,
      windowS: 1,
      fps: 10,
      maxInFlight: 4,
      onDecideStaged: (payload) => ({
        decide: async () => {
          await sleep(30);
        },
        accept: async () => {
          applied.push(payload.centerTs);
          return true;
        },
      }),
    });
    await drive(observer, 0, 1, 0.2);
    // Decides were issued but not applied yet (the pass is pipelined).
    expect(observer.pendingApplyCount()).toBeGreaterThan(0);
    await observer.flush();
    expect(observer.pendingApplyCount()).toBe(0);
    expect(applied.length).toBe(observer.decideCalls());
    // The tail window is still observed (flush fires one last window).
    expect(applied[applied.length - 1]).toBe(
      Math.max(...observer.latencySamples().map((s) => s.centerTs))
    );
  });

  it("(d): a decide failure surfaces at flush (the run still fails, it is not silently swallowed)", async () => {
    const observer = new LiveObserver({
      cadenceS: 0.2,
      windowS: 1,
      fps: 10,
      maxInFlight: 3,
      onDecideStaged: () => ({
        decide: async () => {
          throw new Error("decide transport failed");
        },
        accept: async () => true,
      }),
    });
    await drive(observer, 0, 0.6, 0.2);
    await expect(observer.flush()).rejects.toThrow("decide transport failed");
  });
});

// --- analyzeJob integration: a decide slower than the cadence ---------------

function frameTs(b64: string): number {
  return Number(b64.replace(/^f/, ""));
}

function makeSlowClient(decideMs: number) {
  const decided: { frames: number[]; tickTs: number }[] = [];
  let currentFrameTs = 0;
  const client: PipelineClient = {
    reservePerceive: async () => ({ sessionId: "sess-inflight", appUrl: "", controlUrl: "" }),
    analyze: async (_sid: string, frame: any) => {
      currentFrameTs = frame.timestamp;
      return { observation: { tracks: [], seq: frame.seq, timestamp: frame.timestamp } as any };
    },
    decide: async (_evidence: any, dOpts: any) => {
      decided.push({ frames: dOpts.frames.map((f: any) => frameTs(f.base64)), tickTs: currentFrameTs });
      await sleep(decideMs);
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

/** Realtime-shaped rail with a BUFFERED producer: frames arrive on a wall clock
 *  (as ffmpeg ingest does) and their content timestamp is their arrival time, so
 *  a slow consumer builds a backlog exactly like the deployed live loop instead
 *  of throttling the producer. */
async function* bufferedFrames(durationMs: number, frameEveryMs = 25) {
  const queue: { seq: number; timestamp: number; imageB64: string }[] = [];
  const t0 = Date.now();
  let seq = 0;
  let finished = false;
  void (async () => {
    while (Date.now() - t0 < durationMs) {
      await sleep(frameEveryMs);
      const ts = Number(((Date.now() - t0) / 1000).toFixed(3));
      queue.push({ seq: seq++, timestamp: ts, imageB64: `f${ts}` });
    }
    finished = true;
  })();
  for (;;) {
    while (queue.length) yield queue.shift()!;
    if (finished) return;
    await sleep(5);
  }
}

const CFG = {
  jobId: "job-live-inflight",
  clipBeforeS: 4,
  clipAfterS: 4,
  gameHint: "soccer",
  liveObserveLoop: true,
  observeCadenceS: 0.4,
  observeWindowS: 1,
  observeMaxFrames: 30,
  sampleFps: 25,
  liveObserveLagBudgetS: 30,
} as const;

describe("analyzeJob pipelined live pass (ADAAAA-7771)", () => {
  it("(e): depth 3 holds the cadence (and the lag budget) where the serial pass falls behind and drops stale windows", async () => {
    // 8 s of realtime content arrives buffered at 25 ms/frame; cadence 0.4 s =>
    // ~20 windows. One decide costs 600 ms = 1.5x the cadence: a serial pass
    // drifts behind the wall clock until the 3 s lag budget starts dropping
    // windows, while depth 3 keeps every window inside the budget.
    const serial = makeSlowClient(600);
    const serialOutcome = await analyzeJob(
      serial.client,
      bufferedFrames(8000) as any,
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { ...CFG, liveObserveInFlight: 1, liveObserveLagBudgetS: 3 } as any,
      undefined
    );

    const piped = makeSlowClient(600);
    const pipedOutcome = await analyzeJob(
      piped.client,
      bufferedFrames(8000) as any,
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { ...CFG, liveObserveInFlight: 3, liveObserveLagBudgetS: 3 } as any,
      undefined
    );

    const serialM = serialOutcome.observeMetrics!;
    const pipedM = pipedOutcome.observeMetrics!;
    // The serial pass drifted past the budget and dropped windows as stale...
    expect(serialM.skippedStaleWindows).toBeGreaterThan(0);
    // ...the pipelined pass held the cadence and dropped none.
    expect(pipedM.decideCalls).toBeGreaterThan(serialM.decideCalls);
    expect(pipedM.decideCalls).toBeGreaterThanOrEqual(18);
    expect(pipedM.skippedStaleWindows).toBe(0);
    // It really had several decides outstanding: the queue depth tracks
    // decideWall / cadence (600 ms / 400 ms = 1.5), so 2 is the steady state and
    // 3 is the configured cap. The serial pass reads 0 (no staged queue at all).
    expect(pipedM.maxDecideInFlight).toBeGreaterThanOrEqual(2);
    expect(pipedM.maxDecideInFlight).toBeLessThanOrEqual(3);
    expect(serialM.maxDecideInFlight).toBe(0);
    // One decide per window: every decided call carries a distinct newest frame
    // (no double-deciding of the same window) and the counter matches the calls.
    const newest = piped.decided.map((d) => d.frames[d.frames.length - 1]);
    expect(new Set(newest).size).toBe(newest.length);
    expect(piped.decided.length).toBe(pipedM.decideCalls);
    expect(serial.decided.length).toBe(serialM.decideCalls);
  }, 60000);
});
