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
    confirm: async () => ({ enabled: false, confidence: 0, reason: "", evidence: {}, stage1Disagreed: false, decision: { isHighlight: false, score: 0, outcome: "not_highlight" } }),
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

/** VOD (detail-first) analyzer config: `decideWindowN` set. ADAAAA-6903 removed
 * the app-side decide-concurrency toggle, so there is NO `decideConcurrency`
 * field here — the VOD path dispatches every candidate decide concurrently and
 * the go-livepeer orchestrator (runner `capacity`) bounds the concurrency. */
const DECIDE_CFG = { clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", decideWindowN: 24 } as const;

/** Live (baseline) analyzer config: `decideWindowN` unset, so the frame loop
 * stays on the fully-serial inline decide path (W=1). Unchanged by ADAAAA-6903. */
const LIVE_CFG = { clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer" } as const;

describe("VOD decide concurrency (ADAAAA-6854 / ADAAAA-6903 no app-side toggle)", () => {
  it("dispatches every VOD candidate decide concurrently with NO app-side cap (ADAAAA-6903) and fires exactly one highlight event per accepted candidate (AC3 billing exactly-once)", async () => {
    // Four non-GOAL candidates (never burst-suppressed) close in time. The old
    // W=2 app-side cap would have held at most 2 in flight; with the toggle
    // removed the pipeline launches them all, so 3+ are in flight at once —
    // proving the concurrency is no longer bounded by an app knob (only the
    // orchestrator runner `capacity` is).
    const obs: number[] = [];
    const client = concurrencyClient({
      candidateFrames: new Map(
        [0, 1, 2, 3].map((i) => [i, { eventType: "BIG_SAVE", timestamp: i }])
      ),
      decideDelayMs: () => 40,
      decideVerdict: () => ({ isHighlight: true, score: 80, eventType: "BIG_SAVE" }),
      observedConcurrency: obs,
    });
    const { events, onEvent } = recordEvents();
    const cuts: number[] = [];
    const outcome = await analyzeJob(
      client,
      frameSeq(4) as any,
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` };
      },
      { ...DECIDE_CFG, jobId: "job-vod" },
      onEvent
    );
    const maxInflight = Math.max(...obs, 1);
    // Beyond the old app-side cap of 2 → the concurrency toggle is gone.
    expect(maxInflight).toBeGreaterThanOrEqual(3);
    const highlights = events.filter((e) => e.type === "highlight");
    const blocked = events.filter((e) => e.type === "candidateBlocked");
    expect(highlights).toHaveLength(4); // exactly-once billing: one event each
    expect(blocked).toHaveLength(0);
    expect(cuts).toHaveLength(4);
    expect(outcome.highlights).toHaveLength(4);
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

  it("keeps the live/serial path fully serial (decideWindowN unset → W=1): candidates decided one at a time, no overlap (unchanged)", async () => {
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
      { ...LIVE_CFG, jobId: "job-live-serial" },
      onEvent
    );
    const maxInflight = Math.max(...obs, 1);
    expect(maxInflight).toBe(1); // serial: only one decide in flight at a time
    expect(events.filter((e) => e.type === "highlight")).toHaveLength(2);
    expect(cuts).toHaveLength(2);
  });

  it("does NOT abort the whole job when a candidate's decide is rejected with TicketParams-expired; the candidate is degraded to rejected and the job reaches done (ADAAAA-7003)", async () => {
    // A single candidate whose every decide is rejected as `TicketParams expired`
    // (the ADAAAA-6993 recovery re-mints once; this simulates the runner still
    // cycling params). Prior to the fix a single expired rejection called
    // abort() and the whole VOD pass ended `failed`/stuck instead of `done` —
    // exactly the reported stuck-analyzing loop. The fix retries a bounded
    // number of times, then records the candidate as rejected and finishes.
    let decideCalls = 0;
    const client: PipelineClient = {
      reservePerceive: async () => ({ sessionId: "sess-x", appUrl: "", controlUrl: "" }),
      analyze: async (_sid, frame: any) => {
        const cand = frame.seq === 0 ? { eventType: "GOAL", timestamp: 0 } : undefined;
        const observation: any = { tracks: [], seq: frame.seq, timestamp: frame.timestamp };
        return cand ? { observation, candidate: cand } : { observation };
      },
      decide: async () => {
        decideCalls++;
        const e: any = new Error("decide failed: HTTP 400");
        e.ticketParamsExpired = true;
        throw e;
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
    confirm: async () => ({ enabled: false, confidence: 0, reason: "", evidence: {}, stage1Disagreed: false, decision: { isHighlight: false, score: 0, outcome: "not_highlight" } }),
    };
    const { events, onEvent } = recordEvents();
    const outcome = await analyzeJob(
      client,
      frameSeq(2) as any,
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { ...DECIDE_CFG, jobId: "job-expired" },
      onEvent
    );
    // The job did NOT abort: it resolved to done with no accepted highlight.
    expect(outcome.highlights).toHaveLength(0);
    expect(events.filter((e) => e.type === "highlight")).toHaveLength(0);
    // The candidate was retried (bounded) then degraded, not left in flight.
    expect(decideCalls).toBeGreaterThan(0);
  });

  it("retries a TicketParams-expired decide and accepts the candidate when a later retry succeeds (ADAAAA-7003)", async () => {
    // First decide is expired, the retry succeeds. The candidate is accepted and
    // the job reaches done with one highlight, no abort.
    let decideCalls = 0;
    const client: PipelineClient = {
      reservePerceive: async () => ({ sessionId: "sess-x", appUrl: "", controlUrl: "" }),
      analyze: async (_sid, frame: any) => {
        const cand = frame.seq === 0 ? { eventType: "GOAL", timestamp: 0 } : undefined;
        const observation: any = { tracks: [], seq: frame.seq, timestamp: frame.timestamp };
        return cand ? { observation, candidate: cand } : { observation };
      },
      decide: async () => {
        decideCalls++;
        if (decideCalls === 1) {
          const e: any = new Error("decide failed: HTTP 400");
          e.ticketParamsExpired = true;
          throw e;
        }
        return { isHighlight: true, score: 90, eventType: "GOAL" };
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
    confirm: async () => ({ enabled: false, confidence: 0, reason: "", evidence: {}, stage1Disagreed: false, decision: { isHighlight: false, score: 0, outcome: "not_highlight" } }),
    };
    const { events, onEvent } = recordEvents();
    const outcome = await analyzeJob(
      client,
      frameSeq(2) as any,
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { ...DECIDE_CFG, jobId: "job-expired-retry" },
      onEvent
    );
    expect(outcome.highlights).toHaveLength(1);
    expect(events.filter((e) => e.type === "highlight")).toHaveLength(1);
    expect(decideCalls).toBeGreaterThanOrEqual(2);
  });

  it("aborts (rejects, never hangs) when an EARLY candidate's decide fails under concurrency while a later one succeeds (AC3 exactly-once / AC5 stability on failure)", async () => {
    // Two candidates submitted concurrently. Call 0 (the earlier candidate)
    // throws; call 1 (the later candidate) succeeds and buffers. Prior to the
    // abort fix this deadlocked the reorder buffer forever; the job must instead
    // reject.
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
        { ...DECIDE_CFG, jobId: "job-fail" },
        onEvent
      )
    ).rejects.toThrow("mock: decide runner failed");
  });

  it("rejects on a decide failure in the live/serial path too (unchanged semantics)", async () => {
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
        { ...LIVE_CFG, jobId: "job-live-serial-fail" },
        () => {}
      )
    ).rejects.toThrow("mock: serial decide failed");
  });

  it("AC1 throughput: the VOD concurrent-dispatch path completes materially faster than the live serial path (fixed per-decide latency, no app-side W knob)", async () => {
    // 4 non-GOAL candidates (never burst-suppressed), each decide taking 300 ms
    // (~ the slow vLLM inference). The live serial path awaits each decide
    // inline → ~4x300=1200 ms. The VOD path dispatches every candidate decide
    // concurrently (bounded by the orchestrator runner `capacity`, not an
    // app-side toggle) → ~1x300=300 ms. Assert the concurrent job finishes well
    // under the serial time (>=30% faster) and with NO extra decide calls.
    const DECIDE_MS = 300;
    const candidateFrames = new Map<number, { eventType: string; timestamp: number }>(
      [0, 1, 2, 3].map((i) => [i, { eventType: "BIG_SAVE", timestamp: i }])
    );
    async function run(vod: boolean) {
      const obs: number[] = [];
      const client = concurrencyClient({ candidateFrames, decideDelayMs: () => DECIDE_MS, decideVerdict: () => ({ isHighlight: true, score: 80, eventType: "BIG_SAVE" }), observedConcurrency: obs });
      const { events, onEvent } = recordEvents();
      const t0 = Date.now();
      await analyzeJob(
        client,
        frameSeq(4) as any,
        async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
        vod ? { ...DECIDE_CFG, jobId: "job-ac1-vod" } : { ...LIVE_CFG, jobId: "job-ac1-live" },
        onEvent
      );
      return { ms: Date.now() - t0, maxInflight: Math.max(...obs, 1), highlights: events.filter((e) => e.type === "highlight").length };
    }
    const serial = await run(false); // live: serial inline decide
    const conc = await run(true); // VOD: concurrent dispatch
    // Both must accept the same 4 candidates (AC3 exactly-once; no lost clips).
    expect(serial.highlights).toBe(4);
    expect(conc.highlights).toBe(4);
    // Concurrency really overlapped the decides; the live path stayed serial.
    expect(conc.maxInflight).toBeGreaterThanOrEqual(2);
    expect(serial.maxInflight).toBe(1);
    // AC1: >=30% faster. Use a generous margin for the fixed per-frame overhead.
    expect(conc.ms).toBeLessThan(serial.ms * 0.7);
    // eslint-disable-next-line no-console
    console.log(`AC1 measured: serial(live)=${serial.ms}ms, concurrent(VOD)=${conc.ms}ms, ratio=${(conc.ms / serial.ms).toFixed(2)}`);
  });
});
