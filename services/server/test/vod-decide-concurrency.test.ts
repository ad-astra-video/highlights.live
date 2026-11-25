import { describe, it, expect } from "vitest";
import { analyzeJob, type AnalyzeEvent, type PipelineClient, type DecisionResult } from "../src/analyzer";

/**
 * ADAAAA-9406: this suite was written against the candidate-gated VOD decide
 * pool (`decideOnCandidate` + the app-side `decideConcurrency` knob, ADAAAA-6854
 * / ADAAAA-6903). That path is GONE — `4caf0b7b feat(decision)(ADAAAA-7008)`
 * removed candidate-gated decide and made the vision LLM the primary observer —
 * so a VOD job built from the old fixture config (`decideWindowN` only) decided
 * NOTHING and every count here read 0/[].
 *
 * The real seam today is the VOD `ObserveDecider` (ADAAAA-7007), which decides
 * one window per cadence tick (~3 s, `OBSERVE_CADENCE_S`) instead of one per
 * perceived candidate, and is created only when `observeLoop && decideWindowN`
 * is set (`analyzer.ts` analyzeJob, `cfg.observeLoop && cfg.decideWindowN !==
 * undefined`). ADAAAA-7878 then staged that decide so it runs OFF the
 * frame-consume loop:
 *
 *   - the CONCURRENT shape (shipped default, `observeDecideOffLoop !== false`)
 *     issues every fired window's decide immediately and awaits none of them:
 *     `ObserveDecider.fire` -> `issueStaged` (observe-loop.ts) has NO in-flight
 *     gate at all — only the pending backlog is bounded (`observeDecideQueueMax`,
 *     default 512). That is the invariant ADAAAA-6903 pinned: no app-side
 *     concurrency cap on the VOD pass; the orchestrator's runner capacity is the
 *     only bound.
 *   - the SERIAL shape (`observeDecideOffLoop: false`) keeps the pre-7878 inline
 *     `onDecide` await on both rails: one decide at a time (W=1).
 *
 * Acceptance still happens in CONTENT order on the concurrent shape (the drain
 * chain applies the head of the queue), and one accepted window emits exactly
 * one highlight + one clip cut (AC3 billing exactly-once).
 */

/** Fake PipelineClient whose `analyze` emits a candidate on the given frames
 * and whose `decide` is controllable in duration/verdict, so a test can force
 * out-of-order completions and measure true in-flight concurrency. */
function concurrencyClient(opts: {
  candidateFrames: Map<number, { eventType: string; timestamp: number }>;
  /** `callIndex` is the 0-indexed decide call in LAUNCH order, so a test can
   * make an earlier window's decide finish after a later one's. */
  decideDelayMs: (candidate: { eventType: string; timestamp: number }, callIndex: number) => number;
  decideVerdict: (candidate: { eventType: string; timestamp: number }) => DecisionResult;
  observedConcurrency: number[];
  /** When present and returns an Error, that decide() call (0-indexed, in the
   * order the observer issued them) rejects — simulates a runner / vLLM failure
   * mid-job so a test can assert the pass aborts rather than hangs. Passing a
   * throw on call 0 (the EARLIEST window) while a later window succeeds is the
   * reorder-buffer deadlock case: the later result buffers but can never be
   * applied once its predecessor fails. */
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
      await new Promise((r) => setTimeout(r, opts.decideDelayMs(evidence, callIndex - 1)));
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
    postAudio: async () => ({ candidate: null, series: [] }),
    controlForward: async () => null,
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

/** VOD (detail-first) analyzer config: `decideWindowN` set AND `observeLoop`
 * on, which is the only combination that builds the VOD `ObserveDecider`
 * (`analyzer.ts`: `cfg.observeLoop && cfg.decideWindowN !== undefined`). This is
 * the shipped VOD decide driver since ADAAAA-7007; there is no app-side
 * concurrency toggle (ADAAAA-6903 removed it) and ADAAAA-7878 shipped the
 * off-loop issue with no in-flight cap (only `observeDecideQueueMax`). */
const DECIDE_CFG = { clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", decideWindowN: 24, observeLoop: true } as const;

/** The serial decide shape: `observeDecideOffLoop: false` keeps the pre-7878
 * inline `onDecide` await (W=1) on BOTH rails. A live pass with no observe loop
 * at all decides nothing (candidate-gated decide is gone), so the serial
 * baseline has to opt into the live observer and then turn the off-loop arm off
 * — exactly what `observeDecideOffLoop: false` does (`analyzer.ts`:
 * `observeDecideOffLoop || liveInFlight > 1 ? staged : onDecide`). */
const LIVE_CFG = {
  clipBeforeS: 4,
  clipAfterS: 4,
  gameHint: "soccer",
  liveObserveLoop: true,
  observeDecideOffLoop: false,
} as const;

describe("VOD decide concurrency (ADAAAA-6854 / ADAAAA-6903 no app-side cap)", () => {
  it("dispatches every VOD window decide concurrently with NO app-side cap (ADAAAA-6903/7878) and fires exactly one highlight event per accepted window (AC3 billing exactly-once)", async () => {
    // 13 frames of content at 1 s → cadence windows at 0/3/6/9/12 s plus the
    // end-of-stream force fire (six windows). Each decide takes 60 ms, far
    // longer than the frame loop needs for 13 instant fake perceives, so every
    // window's decide is outstanding at once. The pre-6903 W=2 app-side cap
    // would have held at most 2 in flight; the VOD observer issues them all.
    const obs: number[] = [];
    const client = concurrencyClient({
      candidateFrames: new Map(
        [0, 1, 2, 3].map((i) => [i, { eventType: "BIG_SAVE", timestamp: i }])
      ),
      decideDelayMs: () => 60,
      decideVerdict: () => ({ isHighlight: true, score: 80, eventType: "BIG_SAVE" }),
      observedConcurrency: obs,
    });
    const { events, onEvent } = recordEvents();
    const cuts: number[] = [];
    const outcome = await analyzeJob(
      client,
      frameSeq(13) as any,
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` , hasAudio: true };
      },
      { ...DECIDE_CFG, jobId: "job-vod" },
      onEvent
    );
    const maxInflight = Math.max(...obs, 1);
    const highlights = events.filter((e) => e.type === "highlight");
    const blocked = events.filter((e) => e.type === "candidateBlocked");
    // Beyond the old app-side cap of 2 → the concurrency toggle is gone and the
    // VOD observer has no in-flight gate (only the pending backlog is bounded).
    expect(maxInflight).toBeGreaterThanOrEqual(3);
    // Exactly-once billing: one accept per decided window, never two highlights
    // for one decide (and never a decide that produced no accept).
    expect(obs.length).toBeGreaterThanOrEqual(3);
    expect(highlights).toHaveLength(obs.length);
    expect(blocked).toHaveLength(0);
    expect(cuts).toHaveLength(highlights.length);
    expect(outcome.highlights).toHaveLength(highlights.length);
  });

  it("delivers accept side-effects in candidate timestamp order even when a later window's decide completes first (AC3 burst suppression / AC6 ordering)", async () => {
    // Two GOAL reads inside the burst window, three cadence windows judged. The
    // FIRST decide is the slow one (120 ms vs 10 ms), so every later verdict
    // lands before it and the out-of-order completer must be buffered, not
    // applied first.
    const obs: number[] = [];
    const client = concurrencyClient({
      candidateFrames: new Map([
        [0, { eventType: "GOAL", timestamp: 0 }],
        [2, { eventType: "GOAL", timestamp: 2 }],
      ]),
      decideDelayMs: (_c, callIndex) => (callIndex === 0 ? 120 : 10),
      decideVerdict: () => ({ isHighlight: true, score: 90, eventType: "GOAL" }),
      observedConcurrency: obs,
    });
    const { events, onEvent } = recordEvents();
    const cuts: number[] = [];
    const outcome = await analyzeJob(
      client,
      frameSeq(5) as any,
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` , hasAudio: true };
      },
      { ...DECIDE_CFG, jobId: "job-vod2" },
      onEvent
    );
    const highlights = events.filter((e) => e.type === "highlight");
    const blocked = events.filter((e) => e.type === "candidateBlocked");
    expect(obs.length).toBeGreaterThan(1); // more than one window was judged
    // Only the earliest GOAL is accepted; the burst duplicates are dropped —
    // even though their decides returned first.
    expect(highlights).toHaveLength(1);
    expect((highlights[0] as any).highlight?.start).toBeLessThanOrEqual(0);
    // Every other judged window was BLOCKED, and each block names its cause: a
    // silently-accepted duplicate (or a dropped window with no record) fails here.
    expect(blocked).toHaveLength(obs.length - highlights.length);
    for (const b of blocked) expect(String(b.reason)).toContain("goal_burst");
    // Clips cut strictly in candidate timestamp order — the accepted moment only.
    expect(cuts).toEqual([0]);
    expect(outcome.highlights).toHaveLength(1);
  });

  it("keeps the serial decide path fully serial (observeDecideOffLoop: false → W=1): windows decided one at a time, no overlap", async () => {
    const obs: number[] = [];
    const client = concurrencyClient({
      candidateFrames: new Map([0, 1].map((i) => [i, { eventType: "BIG_SAVE", timestamp: i }])),
      decideDelayMs: () => 50,
      decideVerdict: () => ({ isHighlight: true, score: 80, eventType: "BIG_SAVE" }),
      observedConcurrency: obs,
    });
    const { events, onEvent } = recordEvents();
    const cuts: number[] = [];
    await analyzeJob(
      client,
      frameSeq(7) as any,
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` , hasAudio: true };
      },
      { ...LIVE_CFG, jobId: "job-serial" },
      onEvent
    );
    const maxInflight = Math.max(...obs, 1);
    const highlights = events.filter((e) => e.type === "highlight");
    expect(maxInflight).toBe(1); // serial: only one decide in flight at a time
    expect(obs.length).toBeGreaterThanOrEqual(2);
    expect(highlights).toHaveLength(obs.length);
    expect(cuts).toHaveLength(highlights.length);
  });

  it("does NOT abort the whole job when a window's decide is rejected with TicketParams-expired; the window is degraded and the job reaches done (ADAAAA-7003)", async () => {
    // Every decide is rejected as `TicketParams expired` (the adapter re-mints
    // once, ADAAAA-6993; this simulates the runner still cycling params, which
    // is the observed stuck-analyzing loop). The observe decide degrades the
    // window to NO VERDICT (`observeDecideOnly`: `isTicketParamsExpired` ->
    // return null) instead of aborting the pass, and the degraded window emits
    // neither a highlight nor a clip cut.
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
      postAudio: async () => ({ candidate: null, series: [] }),
      controlForward: async () => null,
      train: async () => ({ run: "x", checkpoint: "/runs/x/model.safetensors" }),
      stopPerceive: async () => {},
    confirm: async () => ({ enabled: false, confidence: 0, reason: "", evidence: {}, stage1Disagreed: false, decision: { isHighlight: false, score: 0, outcome: "not_highlight" } }),
    };
    const { events, onEvent } = recordEvents();
    const cuts: number[] = [];
    const outcome = await analyzeJob(
      client,
      frameSeq(7) as any,
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` , hasAudio: true };
      },
      { ...DECIDE_CFG, jobId: "job-expired" },
      onEvent
    );
    // The job did NOT abort: it resolved to done with no accepted highlight and
    // no clip cut for the degraded windows.
    expect(outcome.highlights).toHaveLength(0);
    expect(events.filter((e) => e.type === "highlight")).toHaveLength(0);
    expect(cuts).toHaveLength(0);
    // The windows were really attempted (the degradation is not "never decided").
    expect(decideCalls).toBeGreaterThan(0);
  });

  it("degrades an expired decide to no verdict and still accepts a later window (ADAAAA-7003 / ADAAAA-7878)", async () => {
    // The first window's decide is expired (degraded, no verdict), every later
    // window's decide succeeds. The pass reaches done and the later windows are
    // accepted — one highlight per non-degraded decide, never one per total
    // decide (which would bill the degraded window).
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
        return { isHighlight: true, score: 80, eventType: "BIG_SAVE" };
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
    confirm: async () => ({ enabled: false, confidence: 0, reason: "", evidence: {}, stage1Disagreed: false, decision: { isHighlight: false, score: 0, outcome: "not_highlight" } }),
    };
    const { events, onEvent } = recordEvents();
    const outcome = await analyzeJob(
      client,
      frameSeq(7) as any,
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` , hasAudio: true }),
      { ...DECIDE_CFG, jobId: "job-expired-retry" },
      onEvent
    );
    const highlights = events.filter((e) => e.type === "highlight");
    expect(decideCalls).toBeGreaterThanOrEqual(2);
    expect(highlights).toHaveLength(decideCalls - 1);
    expect(outcome.highlights).toHaveLength(highlights.length);
  });

  it("aborts (rejects, never hangs) when an EARLY window's decide fails under concurrency while a later one succeeds (AC3 exactly-once / AC5 stability on failure)", async () => {
    // Several windows are issued concurrently. Call 0 (the earliest window)
    // throws; the later windows succeed and buffer. Prior to the drain-chain
    // abort fix this deadlocked the reorder buffer forever; the job must instead
    // reject.
    const obs: number[] = [];
    const client = concurrencyClient({
      candidateFrames: new Map([
        [0, { eventType: "GOAL", timestamp: 0 }],
        [1, { eventType: "BIG_SAVE", timestamp: 1 }],
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
        frameSeq(7) as any,
        async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` , hasAudio: true }),
        { ...DECIDE_CFG, jobId: "job-fail" },
        onEvent
      )
    ).rejects.toThrow("mock: decide runner failed");
  });

  it("rejects on a decide failure in the serial path too (unchanged semantics)", async () => {
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
        frameSeq(3) as any,
        async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` , hasAudio: true }),
        { ...LIVE_CFG, jobId: "job-serial-fail" },
        () => {}
      )
    ).rejects.toThrow("mock: serial decide failed");
  });

  it("AC1 throughput: the VOD concurrent-dispatch path completes materially faster than the serial path (fixed per-decide latency, no app-side W knob)", async () => {
    // 13 frames of content → six cadence windows, each decide taking 300 ms
    // (~ the slow vLLM inference). The serial arm awaits each decide inline →
    // ~6x300=1800 ms. The VOD arm issues them all at once (bounded by the
    // orchestrator runner `capacity`, not an app-side toggle) → ~1x300=300 ms.
    // Assert the concurrent job finishes well under the serial time (>=30 %
    // faster), accepts the same windows, and calls decide the same number of
    // times (no re-deciding to buy the speed).
    const DECIDE_MS = 300;
    const candidateFrames = new Map<number, { eventType: string; timestamp: number }>(
      [0, 1, 2, 3].map((i) => [i, { eventType: "BIG_SAVE", timestamp: i }])
    );
    async function run(concurrent: boolean) {
      const obs: number[] = [];
      const client = concurrencyClient({ candidateFrames, decideDelayMs: () => DECIDE_MS, decideVerdict: () => ({ isHighlight: true, score: 80, eventType: "BIG_SAVE" }), observedConcurrency: obs });
      const { events, onEvent } = recordEvents();
      const t0 = Date.now();
      await analyzeJob(
        client,
        frameSeq(13) as any,
        async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` , hasAudio: true }),
        // The two arms must judge the SAME number of windows or the counts are
        // not comparable: the VOD cadence is 3 s (OBSERVE_CADENCE_S) while the
        // live observer's own is 5 s (LIVE_OBSERVE_CADENCE_S), so pin the live
        // arm to 3 s here. This is the only knob the comparison needs.
        concurrent ? { ...DECIDE_CFG, jobId: "job-ac1-vod" } : { ...LIVE_CFG, liveObserveCadenceS: 3, jobId: "job-ac1-serial" },
        onEvent
      );
      return { ms: Date.now() - t0, maxInflight: Math.max(...obs, 1), highlights: events.filter((e) => e.type === "highlight").length, decides: obs.length };
    }
    const serial = await run(false); // serial: inline awaited decide
    const conc = await run(true); // VOD: concurrent dispatch
    // Both must accept the same windows (AC3 exactly-once; no lost clips) with
    // the same number of decide calls (no extra work bought the speed).
    expect(serial.highlights).toBeGreaterThan(0);
    expect(serial.decides).toBe(conc.decides);
    expect(conc.highlights).toBe(serial.highlights);
    // Concurrency really overlapped the decides; the serial arm stayed serial.
    expect(conc.maxInflight).toBeGreaterThanOrEqual(2);
    expect(serial.maxInflight).toBe(1);
    // AC1: >=30% faster. Use a generous margin for the fixed per-frame overhead.
    expect(conc.ms).toBeLessThan(serial.ms * 0.7);
    // eslint-disable-next-line no-console
    console.log(`AC1 measured: serial=${serial.ms}ms (${serial.decides} decides), concurrent(VOD)=${conc.ms}ms (${conc.decides} decides), ratio=${(conc.ms / serial.ms).toFixed(2)}`);
  });
});
