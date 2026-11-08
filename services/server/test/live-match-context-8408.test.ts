// ADAAAA-8408 (W2): the LIVE rail's match-context WRITER.
//
// Measured on the phase-C legs (ADAAAA-8359): `matchContext` was `{}` on 5/5
// graded live legs because nothing WROTE it there — the read path (both live
// rails -> analyzer -> decide prompt) was already in place. These tests pin the
// writer's contract, all of it $0 (no model, no GPU, no network):
//
//   1. BOUNDED: 4 folds per run whatever the run length, single-flight, and the
//      fold rides the transcript/evidence the rail already produced (the body
//      carries NO ocrFrames / kitSamples — perceive fills those from the live
//      session, so there is no extra OCR and no kit sampling here);
//   2. ZERO NEW INFERENCES: the writer never calls `decide`, so the decide count
//      per leg is unchanged (AC-A4). The only outbound call is the CPU-only fold;
//   3. MONOTONIC: a later fold can never lower a name/confidence the record
//      already earned, and one kit colour can never name both sides;
//   4. BEST-EFFORT: a null / throwing fold writes nothing and never throws;
//   5. WIRED: the analyzer hands every decided window's own commentary + content
//      clock to the hook, and the persisted record is what the decide prompt
//      actually reads (`toDecideMatchContext`) — the seam this ticket exists for.
import { describe, expect, it } from "vitest";

import {
  LIVE_MATCH_CONTEXT_FOLDS_S,
  LIVE_MATCH_CONTEXT_MAX_TRANSCRIPT_CHARS,
  createLiveMatchContextWriter,
  type MatchContext,
} from "../src/match-context";
import {
  LiveRunShared,
  observeDecideOnly,
  toDecideMatchContext,
  type AnalyzerConfig,
  type DecisionResult,
} from "../src/analyzer";
import { ASR_PREFETCH, type ObserveDecidePayload } from "../src/observe-loop";

const team = (name: string, side: "home" | "away", confidence: number, primary = ""): MatchContext["teams"][number] => ({
  name,
  side,
  kitColors: primary ? [{ primary }] : [],
  confidence,
  evidence: [{ source: "scorebug_ocr", snippet: "RMA 1-1 BAR" }],
});

const context = (teams: MatchContext["teams"], progress = 0): MatchContext => ({
  sport: "soccer",
  teams,
  inferredAt: "2026-11-08T00:00:00.000Z",
  resolverVersion: 1,
  ambiguous: false,
  trail: [{ at: "2026-11-08T00:00:00.000Z", progressPct: progress, names: [], action: ["fold"] }],
});

function fakeStore() {
  const jobs = new Map<string, any>([["job-live", { id: "job-live", status: "active" }]]);
  const patches: any[] = [];
  return {
    patches,
    jobs,
    getJob: (id: string) => jobs.get(id),
    patchJob: async (id: string, patch: any) => {
      patches.push(patch);
      const next = { ...(jobs.get(id) ?? {}), ...patch };
      jobs.set(id, next);
      return next;
    },
  };
}

/** A fold client that records every body and answers with a queued context. */
function foldClient(answer: (body: any, call: number) => any) {
  const bodies: any[] = [];
  return {
    bodies,
    postMatchContext: async (_sessionId: string, body: Record<string, unknown>) => {
      bodies.push(body);
      return answer(body, bodies.length);
    },
  };
}

describe("createLiveMatchContextWriter (ADAAAA-8408)", () => {
  it("folds at the bounded schedule only, never more than 4 per run", async () => {
    const store = fakeStore();
    const client = foldClient(() => ({ matchContext: context([team("Real Madrid", "home", 0.85)], 0) }));
    const writer = createLiveMatchContextWriter({
      jobId: "job-live",
      client: client as any,
      getSessionId: () => "sess-1",
      hints: { gameHint: "soccer" },
      getJob: store.getJob,
      patchJob: store.patchJob,
      log: () => {},
    });
    // 121 windows over a 600 s share (a 5 s cadence): a long run must not fold
    // more than the schedule allows.
    for (let t = 0; t <= 600; t += 5) {
      writer.noteWindow({ centerTs: t, transcript: `call ${t}` });
      await new Promise((r) => setImmediate(r));
    }
    await writer.finish();
    expect(LIVE_MATCH_CONTEXT_FOLDS_S).toEqual([0, 60, 120, 240]);
    expect(client.bodies).toHaveLength(4);
    expect(store.patches).toHaveLength(4);
    // Each body is the live shape: commentary + previous + progress, and NO
    // explicit OCR / kit payload (perceive reads the session for those).
    for (const body of client.bodies) {
      expect(body).not.toHaveProperty("ocrFrames");
      expect(body).not.toHaveProperty("kitSamples");
      expect(body).not.toHaveProperty("scorebugSwatches");
      expect(body.gameHint).toBe("soccer");
      expect(typeof body.transcript).toBe("string");
      expect(body.transcript.length).toBeGreaterThan(0);
    }
    // `previous` chains fold to fold, so the guard sees the record's own read.
    expect(client.bodies[0].previous).toBeUndefined();
    expect(client.bodies[1].previous).toMatchObject({ sport: "soccer" });
  });

  it("accumulates the commentary bounded to the measured cap", async () => {
    const store = fakeStore();
    const client = foldClient(() => ({ matchContext: context([team("Barcelona", "away", 0.85)], 0) }));
    const writer = createLiveMatchContextWriter({
      jobId: "job-live",
      client: client as any,
      getSessionId: () => "sess-1",
      hints: {},
      getJob: store.getJob,
      patchJob: store.patchJob,
      log: () => {},
    });
    const chunk = "x".repeat(400);
    for (let t = 0; t <= 240; t += 5) writer.noteWindow({ centerTs: t, transcript: chunk });
    await writer.finish();
    for (const body of client.bodies) {
      expect(body.transcript.length).toBeLessThanOrEqual(LIVE_MATCH_CONTEXT_MAX_TRANSCRIPT_CHARS);
    }
    // The last fold carries the NEWEST commentary, not the oldest.
    expect(client.bodies.at(-1)!.transcript.length).toBe(LIVE_MATCH_CONTEXT_MAX_TRANSCRIPT_CHARS);
  });

  it("never lowers a name or a confidence the record already earned", async () => {
    const store = fakeStore();
    const answers = [
      { matchContext: context([team("Real Madrid", "home", 0.85), team("Barcelona", "away", 0.7)], 0) },
      // A thin late fold: same sides, weaker, and a junk kit colour for both.
      { matchContext: context([team("Real Madrid", "home", 0.2, "cyan"), team("Barcelona", "away", 0.2, "cyan")], 100) },
    ];
    const client = foldClient((_body, call) => answers[Math.min(call, answers.length) - 1]);
    const writer = createLiveMatchContextWriter({
      jobId: "job-live",
      client: client as any,
      getSessionId: () => "sess-1",
      hints: {},
      getJob: store.getJob,
      patchJob: store.patchJob,
      log: () => {},
    });
    writer.noteWindow({ centerTs: 0, transcript: "Madrid on the ball" });
    await writer.finish();
    writer.noteWindow({ centerTs: 60, transcript: "Barcelona break" });
    await writer.finish();
    const published = store.getJob("job-live").matchContext as MatchContext;
    expect(published.teams.find((t) => t.side === "home")!.confidence).toBe(0.85);
    expect(published.teams.find((t) => t.side === "away")!.confidence).toBe(0.7);
    // The identical kit colour for both sides is dropped, and the record says so.
    expect(published.teams.every((t) => t.kitColors.length === 0)).toBe(true);
    expect(published.ambiguous).toBe(true);
  });

  it("is best-effort: a null or throwing fold writes nothing and never throws", async () => {
    const store = fakeStore();
    let call = 0;
    const writer = createLiveMatchContextWriter({
      jobId: "job-live",
      client: {
        postMatchContext: async () => {
          call++;
          if (call === 1) throw new Error("perceive 503");
          return null;
        },
      } as any,
      getSessionId: () => "sess-1",
      hints: {},
      getJob: store.getJob,
      patchJob: store.patchJob,
      log: () => {},
    });
    writer.noteWindow({ centerTs: 0, transcript: "hello" });
    await writer.finish();
    writer.noteWindow({ centerTs: 60, transcript: "world" });
    await expect(writer.finish()).resolves.toBeUndefined();
    expect(store.patches).toHaveLength(0);
    expect(store.getJob("job-live").matchContext).toBeUndefined();
    // Retried once per fold (a re-reserved session answers null the first time).
    expect(call).toBe(4);
  });

  it("adds no decide inference: the fold is the only outbound call", async () => {
    const store = fakeStore();
    let folds = 0;
    let decides = 0;
    const writer = createLiveMatchContextWriter({
      jobId: "job-live",
      client: {
        decide: async () => {
          decides++;
          return null;
        },
        postMatchContext: async () => {
          folds++;
          return { matchContext: context([team("Real Madrid", "home", 0.85)], 0) };
        },
      } as any,
      getSessionId: () => "sess-1",
      hints: {},
      getJob: store.getJob,
      patchJob: store.patchJob,
      log: () => {},
    });
    for (let t = 0; t <= 240; t += 3) writer.noteWindow({ centerTs: t, transcript: `w${t}` });
    await writer.finish();
    expect(folds).toBe(4);
    expect(decides).toBe(0);
  });

  it("is inert when the client has no fold endpoint", async () => {
    const store = fakeStore();
    const writer = createLiveMatchContextWriter({
      jobId: "job-live",
      client: {} as any,
      getSessionId: () => "sess-1",
      hints: {},
      getJob: store.getJob,
      patchJob: store.patchJob,
      log: () => {},
    });
    writer.noteWindow({ centerTs: 0, transcript: "x" });
    await writer.finish();
    expect(store.patches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The wiring half: the analyzer offers each window's commentary to the hook,
// and what the writer persists is exactly what the decide prompt reads.
// ---------------------------------------------------------------------------

function payloadAt(centerTs: number): ObserveDecidePayload {
  return {
    centerTs,
    frames: [{ ts: centerTs - 0.5, imageB64: "f0" }],
    seeds: [],
    biasHints: [],
    capped: false,
    droppedCount: 0,
  } as unknown as ObserveDecidePayload;
}

function payloadWithPrefetch(centerTs: number, transcript: string): ObserveDecidePayload {
  const pl = payloadAt(centerTs);
  Object.defineProperty(pl, ASR_PREFETCH, {
    value: Promise.resolve({ transcript, latencyS: 0.05, ran: true }),
    enumerable: false,
  });
  return pl;
}

function cfgWith(extra: Record<string, unknown> = {}): AnalyzerConfig {
  return {
    jobId: "job-live",
    gameHint: "soccer",
    audioContext: false,
    liveObserveLoop: true,
    ...extra,
  } as unknown as AnalyzerConfig;
}

function decideClient(): any {
  return {
    decide: async () =>
      ({
        isHighlight: false,
        score: 0,
        outcome: "not_highlight",
        eventType: "SPORTING_EVENT",
        runningSummary: "",
        analysis: { prompt: "p", dataItems: [], frames: [], images: [] },
      }) as unknown as DecisionResult,
  };
}

describe("the analyzer -> writer handoff (ADAAAA-8408)", () => {
  it("offers every decided window's own commentary and content clock", async () => {
    const seen: { centerTs: number; transcript: string }[] = [];
    await observeDecideOnly(
      decideClient(),
      new LiveRunShared(),
      cfgWith({ onObserveWindowEvidence: (input: any) => seen.push(input) }),
      "sess-1",
      payloadWithPrefetch(42.5, "Real Madrid break down the left")
    );
    expect(seen).toEqual([{ centerTs: 42.5, transcript: "Real Madrid break down the left" }]);
  });

  it("a window with no prefetch still reports (empty commentary), and a throwing hook cannot fail the decide", async () => {
    let decided = 0;
    const seen: { centerTs: number; transcript: string }[] = [];
    const client = {
      decide: async () => {
        decided++;
        return decideClient().decide();
      },
    } as any;
    await observeDecideOnly(
      client,
      new LiveRunShared(),
      cfgWith({
        onObserveWindowEvidence: (input: any) => {
          seen.push(input);
          throw new Error("writer exploded");
        },
      }),
      "sess-1",
      payloadAt(7)
    );
    expect(seen).toEqual([{ centerTs: 7, transcript: "" }]);
    expect(decided).toBe(1);
  });

  it("end to end: a run of windows populates the record the decide prompt reads", async () => {
    const store = fakeStore();
    const client = foldClient((body: any) => ({
      matchContext: context(
        [
          team("Real Madrid", "home", body.transcript.includes("Madrid") ? 0.85 : 0.5),
          team("Barcelona", "away", 0.5),
        ],
        0
      ),
    }));
    const writer = createLiveMatchContextWriter({
      jobId: "job-live",
      client: client as any,
      getSessionId: () => "sess-1",
      hints: { gameHint: "soccer" },
      getJob: store.getJob,
      patchJob: store.patchJob,
      log: () => {},
    });
    // Before the first fold the decide prompt reads no context (today's build).
    expect(toDecideMatchContext(store.getJob("job-live").matchContext)).toBeUndefined();
    const run = observeDecideOnly(
      decideClient(),
      new LiveRunShared(),
      cfgWith({ onObserveWindowEvidence: (input: any) => writer.noteWindow(input) }),
      "sess-1",
      payloadWithPrefetch(0.4, "Madrid press high")
    );
    await run;
    await writer.finish();
    // One fold fired on the run's first window and landed in the record.
    expect(client.bodies).toHaveLength(1);
    const wire = toDecideMatchContext(store.getJob("job-live").matchContext);
    expect(wire).toBeDefined();
    expect(wire!.teams.map((t) => `${t.side}:${t.name}`)).toEqual(["home:Real Madrid", "away:Barcelona"]);
    // The commentary the rail handed over is the one the fold read.
    expect(client.bodies[0].transcript).toBe("Madrid press high");
  });
});
