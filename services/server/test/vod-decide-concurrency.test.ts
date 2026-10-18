import { describe, it, expect } from "vitest";
import { analyzeJob, type AnalyzeEvent, type PipelineClient, type DecisionResult } from "../src/analyzer";

/** Fake PipelineClient whose `analyze` emits a candidate on the given frames
 * and whose `decide` is controllable in duration/verdict, so a test can force
 * out-of-order completions and measure true in-flight concurrency. */
function concurrencyClient(opts: {
  candidateFrames: Map<number, { eventType: string; timestamp: number }>;
  decideDelayMs: (candidate: { eventType: string; timestamp: number }) => number;
  decideVerdict: (candidate: { eventType: string; timestamp: number }) => DecisionResult;
  observedConcurrency: number[];
  /** When present and returns an Error, that decide() call (0-indexed, in the
   * order the pool launched them) rejects — simulates a runner / vLLM failure
   * mid-job so a test can assert the job aborts rather than hangs. Passing a
   * throw on call 0 (an EARLY candidate) while a later candidate succeeds is the
   * reorder-buffer deadlock case: the later result buffers but can never be
   * accepted once its predecessor fails. */
  decideThrow?: (callIndex: number) => Error | undefined;
}) {
  let inflight = 0;
  let callIndex = 0;
  const client: PipelineClient = {
    reservePerceive: async () => ({ sessionId: "sess-x", appUrl: "", controlUrl: "" }),
    analyze: async (_sid, frame: any) => {
      const cand = opts.candidateFrames.get(frame.seq);
      const observation: any = { tracks: [], seq: frame.seq, timestamp: frame.timestamp };
      return cand ? { observation, candidate: { eventType: cand.eventType, timestamp: cand.timestamp } } : { observation };
    },
    decide: async (evidence: any) => {
      const err = opts.decideThrow?.(callIndex++);
      if (err) throw err;
      inflight++;
      opts.observedConcurrency.push(inflight);
      await new Promise((r) => setTimeout(r, opts.decideDelayMs(evidence)));
      inflight--;
      return opts.decideVerdict(evidence);
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
  };
  return client;
}

function* frameSeq(n: number) {
  for (let i = 0; i < n; i++) yield { seq: i, timestamp: i, imageB64: `img${i}` };
}

function recordEvents() {
  const events: AnalyzeEvent[] = [];
  const onEvent = (ev: AnalyzeEvent) => events.push(ev);
  return { events, onEvent };
}

const DECIDE_CFG = { jobId: "job-vod", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", decideWindowN: 24, decideConcurrency: 2 } as const;

describe("VOD decide concurrency (ADAAAA-6854)", () => {
  it("runs two candidate decide calls concurrently (W=2) and fires exactly one highlight event per accepted candidate (AC3 billing exactly-once)", async () => {
    // Two non-GOAL candidates (never burst-suppressed) close in time.
    const obs: number[] = [];
    const client = concurrencyClient({
      candidateFrames: new Map([
        [0, { eventType: "BIG_SAVE", timestamp: 2 }],
        [1, { eventType: "BIG_SAVE", timestamp: 8 }],
      ]),
      decideDelayMs: () => 60,
      decideVerdict: () => ({ isHighlight: true, score: 80, eventType: "BIG_SAVE" }),
      observedConcurrency: obs,
    });
    const { events, onEvent } = recordEvents();
    const cuts: number[] = [];
    const outcome = await analyzeJob(
      client,
      frameSeq(3) as any,
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` };
      },
      { ...DECIDE_CFG, jobId: "job-vod" },
      onEvent
    );
    const maxInflight = Math.max(...obs, 1);
    expect(maxInflight).toBe(2); // both decides were in flight at once
    const highlights = events.filter((e) => e.type === "highlight");
    const blocked = events.filter((e) => e.type === "candidateBlocked");
    expect(highlights).toHaveLength(2); // exactly-once billing: one event each
    expect(blocked).toHaveLength(0);
    expect(cuts).toHaveLength(2);
    expect(outcome.highlights).toHaveLength(2);
  });

  it("delivers accept side-effects in candidate timestamp order even when a later candidate's decide completes first (AC3 burst suppression / AC6 ordering)", async () => {
    // Two GOALs inside the burst window. ts=10's decide resolves FASTER than
    // ts=0's, so the out-of-order completer must be buffered, not accepted first.
    const obs: number[] = [];
    const client = concurrencyClient({
      candidateFrames: new Map([
        [0, { eventType: "GOAL", timestamp: 0 }],
        [10, { eventType: "GOAL", timestamp: 10 }],
      ]),
      decideDelayMs: (c) => (c.timestamp === 10 ? 10 : 100), // later one completes first
      decideVerdict: () => ({ isHighlight: true, score: 90, eventType: "GOAL" }),
      observedConcurrency: obs,
    });
    const { events, onEvent } = recordEvents();
    const cuts: number[] = [];
    const outcome = await analyzeJob(
      client,
      frameSeq(11) as any,
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` };
      },
      { ...DECIDE_CFG, jobId: "job-vod2" },
      onEvent
    );
    const highlights = events.filter((e) => e.type === "highlight");
    const blocked = events.filter((e) => e.type === "candidateBlocked");
    // Only the earliest GOAL is accepted; the burst duplicate (ts=10) is dropped
    // — even though its decide returned first.
    expect(highlights).toHaveLength(1);
    expect((highlights[0] as any).highlight?.start).toBeLessThanOrEqual(0);
    expect(blocked).toHaveLength(1);
    // Clips cut strictly in candidate timestamp order (0 before 10).
    expect(cuts).toEqual([0]);
    expect(outcome.highlights).toHaveLength(1);
  });

  it("preserves serial behavior when W=1 (operator opt-out): candidates decided one at a time, no overlap", async () => {
    const obs: number[] = [];
    const client = concurrencyClient({
      candidateFrames: new Map([
        [0, { eventType: "BIG_SAVE", timestamp: 2 }],
        [1, { eventType: "BIG_SAVE", timestamp: 8 }],
      ]),
      decideDelayMs: () => 50,
      decideVerdict: () => ({ isHighlight: true, score: 80, eventType: "BIG_SAVE" }),
      observedConcurrency: obs,
    });
    const { events, onEvent } = recordEvents();
    const cuts: number[] = [];
    await analyzeJob(
      client,
      frameSeq(3) as any,
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` };
      },
      { jobId: "job-w1", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", decideWindowN: 24, decideConcurrency: 1 },
      onEvent
    );
    const maxInflight = Math.max(...obs, 1);
    expect(maxInflight).toBe(1); // serial: only one decide in flight at a time
    expect(events.filter((e) => e.type === "highlight")).toHaveLength(2);
    expect(cuts).toHaveLength(2);
  });

  it("aborts (rejects, never hangs) when an EARLY candidate's decide fails under concurrency while a later one succeeds (AC3 exactly-once / AC5 stability on failure)", async () => {
    // W=2 with two candidates. Call 0 (the earlier candidate) throws; call 1
    // (the later candidate) succeeds and buffers. Prior to the abort fix this
    // deadlocked the reorder buffer forever; the job must instead reject.
    const obs: number[] = [];
    const client = concurrencyClient({
      candidateFrames: new Map([
        [0, { eventType: "GOAL", timestamp: 0 }],
        [1, { eventType: "BIG_SAVE", timestamp: 8 }],
      ]),
      decideDelayMs: () => 30,
      decideVerdict: () => ({ isHighlight: true, score: 80, eventType: "BIG_SAVE" }),
      observedConcurrency: obs,
      decideThrow: (callIndex) => (callIndex === 0 ? new Error("mock: decide runner failed") : undefined),
    });
    const { onEvent } = recordEvents();
    await expect(
      analyzeJob(
        client,
        frameSeq(2) as any,
        async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
        { jobId: "job-fail", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", decideWindowN: 24, decideConcurrency: 2 },
        onEvent
      )
    ).rejects.toThrow("mock: decide runner failed");
  });

  it("rejects on a decide failure in the W=1 serial path too (unchanged semantics)", async () => {
    const obs: number[] = [];
    const client = concurrencyClient({
      candidateFrames: new Map([[0, { eventType: "GOAL", timestamp: 0 }]]),
      decideDelayMs: () => 30,
      decideVerdict: () => ({ isHighlight: true, score: 90, eventType: "GOAL" }),
      observedConcurrency: obs,
      decideThrow: (callIndex) => (callIndex === 0 ? new Error("mock: serial decide failed") : undefined),
    });
    await expect(
      analyzeJob(
        client,
        frameSeq(1) as any,
        async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
        { jobId: "job-w1fail", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", decideWindowN: 24, decideConcurrency: 1 },
        () => {}
      )
    ).rejects.toThrow("mock: serial decide failed");
  });

  it("AC1 throughput: a job with 4 candidates completes materially faster at W=2 than W=1 (fixed per-decide latency)", async () => {
    // 4 non-GOAL candidates (never burst-suppressed), each decide taking 300 ms
    // (~ the slow vLLM inference that W=2 overlaps). Serial it is ~4x300=1200 ms;
    // W=2 runs two in flight so ~2x300=600 ms. Assert the W=2 job finishes in
    // well under the serial time (>=30% faster) and with NO extra decide calls.
    const DECIDE_MS = 300;
    const candidateFrames = new Map<number, { eventType: string; timestamp: number }>(
      [0, 1, 2, 3].map((i) => [i, { eventType: "BIG_SAVE", timestamp: i }])
    );
    async function run(w: number) {
      const obs: number[] = [];
      const client = concurrencyClient({ candidateFrames, decideDelayMs: () => DECIDE_MS, decideVerdict: () => ({ isHighlight: true, score: 80, eventType: "BIG_SAVE" }), observedConcurrency: obs });
      const { events, onEvent } = recordEvents();
      const t0 = Date.now();
      await analyzeJob(
        client,
        frameSeq(4) as any,
        async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
        { jobId: `job-ac1-w${w}`, clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", decideWindowN: 24, decideConcurrency: w },
        onEvent
      );
      return { ms: Date.now() - t0, maxInflight: Math.max(...obs, 1), highlights: events.filter((e) => e.type === "highlight").length };
    }
    const serial = await run(1);
    const conc = await run(2);
    // Both must accept the same 4 candidates (AC3 exactly-once; no lost clips).
    expect(serial.highlights).toBe(4);
    expect(conc.highlights).toBe(4);
    // Concurrency really overlapped the decides.
    expect(conc.maxInflight).toBeGreaterThanOrEqual(2);
    expect(serial.maxInflight).toBe(1);
    // AC1: >=30% faster. Use a generous margin for the fixed per-frame overhead.
    expect(conc.ms).toBeLessThan(serial.ms * 0.7);
    // eslint-disable-next-line no-console
    console.log(`AC1 measured: serial(W=1)=${serial.ms}ms, concurrent(W=2)=${conc.ms}ms, ratio=${(conc.ms / serial.ms).toFixed(2)}`);
  });
});
