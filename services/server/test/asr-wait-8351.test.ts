// ADAAAA-8351: the decide-side ASR WAIT BUDGET, split from the transcription
// timeout.
//
// Phase 2 (ADAAAA-8300) moved the transcription deadline 6 000 -> 20 000 ms
// alone and FAILED: two rows waited 20 767 / 21 494 ms for a prefetch that never
// finished, so AC3a max rose to 23 628 / 23 852 ms. The knob removed the ABANDON
// cap without bounding the WAIT.
//
// The fix is a decide-side budget (`LIVE_DECIDE_ASR_WAIT_MS`) that is separate
// from the transcription timeout: on a miss the decide proceeds with its own
// INLINE ASR (coverage-neutral, `asrRan` stays 100 %) while the prefetch keeps
// running and still caches, so the next window reuses it instead of re-paying.
// These tests pin the three properties the leg depends on:
//   1. the budget binds: a slow prefetch does NOT hold the decide past it, and
//      the decide request carries no `asr` block (=> inline ASR runs);
//   2. the work is not wasted: the same clip's prefetched result is still
//      reusable after the miss, and the lane never re-transcribes it;
//   3. the meter SURVIVES persistence: `asrWaitMisses` / `asrWaitBudgetMs` /
//      `asrLaneWidth` are declared on `ObserveMetricsSnapshotSchema`, so
//      `JobSchema.parse` (store.patchJob) cannot strip them (ADAAAA-8219 lesson);
//   4. the knob is INERT by default: unset = today's behaviour byte-identically,
//      both on the decide request and on the persisted snapshot.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LiveRunShared,
  buildLiveObserveMetrics,
  buildObserveDecideRequest,
  observeDecideOnly,
  type AnalyzerConfig,
  type DecisionResult,
} from "../src/analyzer";
import { AsrPrefetcher } from "../src/asr-prefetch";
import { LiveObserver, ASR_PREFETCH, type ObserveDecidePayload } from "../src/observe-loop";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";
import { JobSchema, ObserveMetricsSnapshotSchema } from "@highlights/events";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");

function pcmChunkB64(): string {
  return Buffer.alloc(3200).toString("base64");
}

function payload(centerTs = 1.0): ObserveDecidePayload {
  return {
    centerTs,
    frames: [
      { ts: centerTs - 0.5, imageB64: "f0" },
      { ts: centerTs, imageB64: "f1" },
    ],
    seeds: [],
    biasHints: [],
    capped: false,
    droppedCount: 0,
  };
}

/** Latched payload: carries this window's prefetch on the ADAAAA-8081 symbol,
 *  exactly the way `LiveObserver` attaches it at fire time. */
function payloadWithPrefetch(p: Promise<{ transcript: string; latencyS: number; ran: boolean } | null>) {
  const pl = payload();
  Object.defineProperty(pl, ASR_PREFETCH, { value: p, enumerable: false });
  return pl;
}

function cfgWith(extra: Record<string, unknown> = {}): AnalyzerConfig {
  return {
    jobId: "job-8351",
    gameHint: "soccer",
    audioContext: true,
    liveObserveLoop: true,
    ...extra,
  } as unknown as AnalyzerConfig;
}

function recordingClient(seen: any[]): any {
  return {
    decide: async (_evidence: any, opts: any) => {
      seen.push(opts);
      return {
        isHighlight: false,
        score: 0,
        outcome: "not_highlight",
        eventType: "SPORTING_EVENT",
        runningSummary: "",
        analysis: { prompt: "p", dataItems: [], frames: [], images: [] },
      } as unknown as DecisionResult;
    },
  };
}

describe("LIVE_DECIDE_ASR_WAIT_MS bounds the wait without dropping coverage (ADAAAA-8351)", () => {
  it("a budget miss proceeds INLINE at the budget, not at the prefetch", async () => {
    const seen: any[] = [];
    const stats = { misses: 0 };
    const slow = new Promise<any>((resolve) =>
      setTimeout(() => resolve({ transcript: "late goal call", latencyS: 0.25, ran: true }), 250)
    );
    const started = Date.now();
    await observeDecideOnly(
      recordingClient(seen),
      new LiveRunShared(),
      cfgWith({ decideAsrWaitMs: 40, decideAsrWaitStats: stats }),
      "sess",
      payloadWithPrefetch(slow)
    );
    const elapsed = Date.now() - started;
    // The decide did not wait for the 250 ms prefetch: the 40 ms budget bound it.
    expect(elapsed).toBeLessThan(200);
    expect(stats.misses).toBe(1);
    // A miss must leave the request byte-identical to "no prefetch": no `asr`
    // block => the decide service transcribes inline (asrRan stays 100 %).
    expect(seen[0]).not.toHaveProperty("asr");
  });

  it("the prefetched result is still cached and reused after a miss (no re-pay)", async () => {
    const asrCalls = { n: 0 };
    const prefetcher = new AsrPrefetcher({
      asrUrl: "http://asr:8082",
      timeoutMs: 20_000,
      maxConcurrent: 4,
      fetchImpl: (async () => {
        asrCalls.n++;
        await new Promise((r) => setTimeout(r, 60));
        return new Response(JSON.stringify({ text: "what a goal" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const first = prefetcher.start("clip-wait")!; // fire time: lane starts it
    const run = new LiveRunShared();
    for (let i = 0; i < 20; i++) run.addAudioChunk(i * 0.1, pcmChunkB64());
    const stats = { misses: 0 };

    // Window N misses the budget and decides inline.
    const seen: any[] = [];
    await observeDecideOnly(
      recordingClient(seen),
      run,
      cfgWith({ decideAsrWaitMs: 10, decideAsrWaitStats: stats }),
      "sess",
      payloadWithPrefetch(first)
    );
    expect(stats.misses).toBe(1);
    expect(seen[0]).not.toHaveProperty("asr");

    // The prefetch was NOT aborted: it settles with a real transcript ...
    const settled = await first;
    expect(settled).toMatchObject({ ran: true, transcript: "what a goal" });
    // ... and it is served from the cache to the next consumer (the next window /
    // a re-decide of the same clip), so the lane paid exactly ONE call.
    const reused = await prefetcher.start("clip-wait");
    expect(reused!.transcript).toBe("what a goal");
    expect(asrCalls.n).toBe(1);
    expect(prefetcher.stats.hits).toBe(1);
    // Feeding the settled result back through the request builder restores the
    // prefetched lane: the miss cost the decide, not the transcription.
    const { opts } = buildObserveDecideRequest(cfgWith(), run, payload(), settled as any);
    expect(opts!.asr).toMatchObject({ transcript: "what a goal", ran: true });
    expect(opts).toHaveProperty("asr");
  });

  it("a prefetch that lands inside the budget is used, and no miss is counted", async () => {
    const seen: any[] = [];
    const stats = { misses: 0 };
    const fast = Promise.resolve({ transcript: "goal", latencyS: 0.3, ran: true });
    await observeDecideOnly(
      recordingClient(seen),
      new LiveRunShared(),
      cfgWith({ decideAsrWaitMs: 6_000, decideAsrWaitStats: stats }),
      "sess",
      payloadWithPrefetch(fast)
    );
    expect(stats.misses).toBe(0);
    expect(seen[0].asr).toMatchObject({ transcript: "goal", ran: true });
  });

  it("unset budget = today's behaviour (full await, no miss, no snapshot field)", async () => {
    const seen: any[] = [];
    const stats = { misses: 0 };
    const slow = new Promise<any>((resolve) =>
      setTimeout(() => resolve({ transcript: "goal", latencyS: 0.2, ran: true }), 120)
    );
    const started = Date.now();
    await observeDecideOnly(
      recordingClient(seen),
      new LiveRunShared(),
      cfgWith({ decideAsrWaitStats: stats }),
      "sess",
      payloadWithPrefetch(slow)
    );
    // The decide waited the WHOLE prefetch, exactly as before 8351 ...
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(seen[0].asr).toMatchObject({ transcript: "goal" });
    expect(stats.misses).toBe(0);
    // ... and the snapshot carries none of the 8351 fields.
    const observer = new LiveObserver({ cadenceS: 3, windowS: 10, fps: 2, onDecide: async () => false });
    // ADAAAA-8344 landed the 4th positional arg (`decideStages`); the ASR
    // posture is the 5th, so the stage slot stays undefined here.
    const metrics = buildLiveObserveMetrics(observer, undefined, undefined, undefined, {
      waitMs: 0,
      misses: 0,
      laneWidth: 4,
    });
    expect(metrics).not.toHaveProperty("asrWaitMisses");
    expect(metrics).not.toHaveProperty("asrWaitBudgetMs");
    expect(metrics).not.toHaveProperty("asrLaneWidth");
  });
});

describe("asrWaitMisses survives persistence (ADAAAA-8351 / 8219 lesson)", () => {
  it("declares the three fields on ObserveMetricsSnapshotSchema and keeps them through JobSchema.parse", () => {
    const observer = new LiveObserver({ cadenceS: 3, windowS: 10, fps: 2, onDecide: async () => false });
    const metrics = buildLiveObserveMetrics(observer, undefined, undefined, undefined, {
      waitMs: 6_000,
      misses: 3,
      laneWidth: 4,
    });
    expect(metrics).toMatchObject({ asrWaitMisses: 3, asrWaitBudgetMs: 6_000, asrLaneWidth: 4 });
    // Declared, not stripped: the schema is what `store.patchJob` runs.
    expect(ObserveMetricsSnapshotSchema.parse(metrics)).toMatchObject({
      asrWaitMisses: 3,
      asrWaitBudgetMs: 6_000,
      asrLaneWidth: 4,
    });
    const job = JobSchema.parse({
      id: "job-8351-meter",
      status: "done",
      createdAt: new Date().toISOString(),
      source: "rtmp",
      observeMetrics: metrics,
    });
    expect(job.observeMetrics).toMatchObject({ asrWaitMisses: 3, asrWaitBudgetMs: 6_000, asrLaneWidth: 4 });
  });
});

describe("LIVE_DECIDE_ASR_WAIT_MS config + compose (ADAAAA-8351)", () => {
  it("defaults to 0 (inert) and carries an explicit value through to the analyzer config", () => {
    const base = { PERCEIVE_URL: "http://p", DECIDE_URL: "http://d", ASR_URL: "http://asr:8082", LIVE_OBSERVE_LOOP: "1" };
    const inert = loadConfig(base);
    expect(inert.liveDecideAsrWaitMs).toBe(0);
    // `0` is inert too (positiveNumberOrUndefined rejects it) => the knob cannot
    // move a cell by accident.
    expect(loadConfig({ ...base, LIVE_DECIDE_ASR_WAIT_MS: "0" }).liveDecideAsrWaitMs).toBe(0);

    // ADAAAA-8609: a wait at/after the side lane's own timeout (`LIVE_DECIDE_ASR_
    // PREFETCH_TIMEOUT_MS`, 6 000 by default) can never receive a transcript, so
    // it is clamped just under that deadline (see config-asr-wait-8609.test.ts).
    // An explicit SHORT wait still carries through untouched — that is the
    // behaviour this test pins.
    const cfg = loadConfig({ ...base, LIVE_DECIDE_ASR_WAIT_MS: "1500", LIVE_DECIDE_ASR_PREFETCH_CONCURRENCY: "4" });
    expect(cfg.liveDecideAsrWaitMs).toBe(1_500);
    const analyzer = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-8351-cfg", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    });
    expect(analyzer.decideAsrWaitMs).toBe(1_500);
    // The transcription timeout keeps its own knob: unset => the code default
    // (6 000); the leg sets 20 000 so a slow call completes and caches.
    expect(analyzer.decideAsrPrefetchTimeoutMs).toBe(6_000);
    expect(analyzer.decideAsrPrefetchConcurrency).toBe(4);
    expect(analyzer.decideAsrWaitStats).toEqual({ misses: 0 });
    // A per-run counter object, not a module global: two jobs never share misses.
    const second = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-8351-cfg-b", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    });
    expect(second.decideAsrWaitStats).not.toBe(analyzer.decideAsrWaitStats);
  });

  it("compose ships the knob inert by default on the server service", () => {
    const lines = compose.split("\n");
    const start = lines.findIndex((l) => l === "  server:");
    expect(start).toBeGreaterThanOrEqual(0);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^  [a-zA-Z0-9_.-]+:\s*$/.test(lines[i])) {
        end = i;
        break;
      }
    }
    const server = lines.slice(start, end).join("\n");
    expect(server).toContain("LIVE_DECIDE_ASR_WAIT_MS=${LIVE_DECIDE_ASR_WAIT_MS:-0}");
  });
});
