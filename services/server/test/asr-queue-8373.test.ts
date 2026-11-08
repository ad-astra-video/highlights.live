// ADAAAA-8373: the INLINE-on-miss ASR lane's admission bound
// (`ASR_MAX_CONCURRENT` + `ASR_QUEUE_MS`).
//
// The ADAAAA-8363 grade measured the lane that concurrent inline-on-miss decide
// calls share: leg-window peak concurrency 4, 24 h peak 5, inline p95 6 272 ms
// against a 6 000 ms wait budget. Queue time is what converts a call into a
// wait-miss, so the bound has to be countable and separately labelled.
//
// The GATE itself lives in the decide process (one uvicorn worker == one lane)
// and is proven in `services/decide/tests/test_asr_admission_8373.py`. These
// tests pin the SERVER half:
//   1. INERT BY DEFAULT — `ASR_MAX_CONCURRENT` / `ASR_QUEUE_MS` unset means 0/0,
//      no bound anywhere, and the run's snapshot carries only the zero-valued
//      `asrQueueMisses` (the effective posture keys stay absent).
//   2. The counter is real — a decide response that reports `asrSource:
//      "queue_miss"` increments the per-run queue-miss counter; a prefetched or
//      plain inline response does not.
//   3. CONTRACT SYNC — the three fields are declared on
//      `ObserveMetricsSnapshotSchema`, so `JobSchema.parse` (store.patchJob)
//      cannot strip them (the ADAAAA-8219 lesson).
//   4. compose ships both knobs inert on the DECIDE and the SERVER service, so a
//      deploy cannot disagree with the code.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LiveRunShared,
  buildLiveObserveMetrics,
  observeDecideOnly,
  type AnalyzerConfig,
  type DecisionResult,
} from "../src/analyzer";
import { LiveObserver, type ObserveDecidePayload } from "../src/observe-loop";
import { MediaRailObserver } from "../src/media-rail";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";
import { JobSchema, ObserveMetricsSnapshotSchema } from "@highlights/events";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");

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

function cfgWith(extra: Record<string, unknown> = {}): AnalyzerConfig {
  return {
    jobId: "job-8373",
    gameHint: "soccer",
    audioContext: true,
    liveObserveLoop: true,
    ...extra,
  } as unknown as AnalyzerConfig;
}

function observer(): LiveObserver {
  return new LiveObserver({ cadenceS: 3, windowS: 10, fps: 2, onDecide: async () => false });
}

/** A decide client that answers with a given audio-coverage ledger. */
function clientReturning(audioContext?: Record<string, unknown>): any {
  return {
    decide: async () =>
      ({
        isHighlight: false,
        score: 0,
        outcome: "not_highlight",
        eventType: "SPORTING_EVENT",
        runningSummary: "",
        analysis: { prompt: "p", dataItems: [], frames: [], images: [] },
        ...(audioContext ? { audioContext } : {}),
      }) as unknown as DecisionResult,
  };
}

function serviceBlock(name: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-zA-Z0-9_.-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("ADAAAA-8373 inert defaults (AC1)", () => {
  it("unset / 0 / junk all read as 0 = unbounded and wait-as-today", () => {
    const base = { PERCEIVE_URL: "http://p", DECIDE_URL: "http://d", ASR_URL: "http://asr:8082" };
    const inert = loadConfig(base);
    expect(inert.liveAsrMaxConcurrent).toBe(0);
    expect(inert.liveAsrQueueMs).toBe(0);
    // compose ships `${X:-0}`; an explicit "0" and a junk value must both stay
    // inert rather than constructing a bound by accident.
    const zeroed = loadConfig({ ...base, ASR_MAX_CONCURRENT: "0", ASR_QUEUE_MS: "0" });
    expect([zeroed.liveAsrMaxConcurrent, zeroed.liveAsrQueueMs]).toEqual([0, 0]);
    const junk = loadConfig({ ...base, ASR_MAX_CONCURRENT: "two", ASR_QUEUE_MS: "" });
    expect([junk.liveAsrMaxConcurrent, junk.liveAsrQueueMs]).toEqual([0, 0]);
    // Real values carry through (floored integers, never negative).
    const bounded = loadConfig({ ...base, ASR_MAX_CONCURRENT: "2", ASR_QUEUE_MS: "150" });
    expect([bounded.liveAsrMaxConcurrent, bounded.liveAsrQueueMs]).toEqual([2, 150]);
    const negative = loadConfig({ ...base, ASR_MAX_CONCURRENT: "-3", ASR_QUEUE_MS: "-1" });
    expect([negative.liveAsrMaxConcurrent, negative.liveAsrQueueMs]).toEqual([0, 0]);
  });

  it("carries the posture to the live analyzer and gives each run its own counter", () => {
    const cfg = loadConfig({
      PERCEIVE_URL: "http://p",
      DECIDE_URL: "http://d",
      ASR_URL: "http://asr:8082",
      LIVE_OBSERVE_LOOP: "1",
      ASR_MAX_CONCURRENT: "2",
      ASR_QUEUE_MS: "150",
    });
    const analyzer = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-8373-cfg", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    } as any);
    expect(analyzer.decideAsrMaxConcurrent).toBe(2);
    expect(analyzer.decideAsrQueueMs).toBe(150);
    expect(analyzer.decideAsrQueueStats).toEqual({ misses: 0 });
    const second = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-8373-cfg-b", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    } as any);
    // Per-run counter, never a module global.
    expect(second.decideAsrQueueStats).not.toBe(analyzer.decideAsrQueueStats);
  });

  it("inert snapshot gains ONLY the zero-valued counter, no posture keys", () => {
    const metrics = buildLiveObserveMetrics(observer(), undefined, undefined, undefined, {
      maxConcurrent: 0,
      queueMs: 0,
      misses: 0,
    });
    expect(metrics.asrQueueMisses).toBe(0);
    expect(metrics).not.toHaveProperty("asrMaxConcurrent");
    expect(metrics).not.toHaveProperty("asrQueueMs");
  });
});

describe("ADAAAA-8373 bound posture on the stored row (AC1/AC2)", () => {
  it("writes the EFFECTIVE cap + queue when configured, and survives persistence", () => {
    const metrics = buildLiveObserveMetrics(observer(), undefined, undefined, undefined, {
      maxConcurrent: 2,
      queueMs: 150,
      misses: 3,
    });
    expect(metrics).toMatchObject({ asrQueueMisses: 3, asrMaxConcurrent: 2, asrQueueMs: 150 });
    // Declared, not stripped: this schema is what `store.patchJob` runs.
    expect(ObserveMetricsSnapshotSchema.parse(metrics)).toMatchObject({
      asrQueueMisses: 3,
      asrMaxConcurrent: 2,
      asrQueueMs: 150,
    });
    const job = JobSchema.parse({
      id: "job-8373-meter",
      status: "done",
      createdAt: new Date().toISOString(),
      source: "rtmp",
      observeMetrics: metrics,
    });
    expect(job.observeMetrics).toMatchObject({ asrQueueMisses: 3, asrMaxConcurrent: 2, asrQueueMs: 150 });
  });

  it("counts a queue_miss decide response, and does NOT count prefetch/inline", async () => {
    const stats = { misses: 0 };
    const cfg = cfgWith({ decideAsrQueueStats: stats, decideAsrMaxConcurrent: 2, decideAsrQueueMs: 150 });

    await observeDecideOnly(
      clientReturning({ asrSource: "queue_miss", asrRan: false, noAudioReason: "asr_queue_miss" }),
      new LiveRunShared(),
      cfg,
      "sess",
      payload()
    );
    expect(stats.misses).toBe(1);

    // A served inline call and a prefetched one are NOT bounded misses: the
    // counter must never inflate the queue-miss share from normal throughput.
    await observeDecideOnly(clientReturning({ asrSource: "inline", asrRan: true }), new LiveRunShared(), cfg, "sess", payload(2));
    await observeDecideOnly(clientReturning({ asrSource: "prefetch", asrRan: true }), new LiveRunShared(), cfg, "sess", payload(3));
    // A legacy / rule-path verdict carries no ledger at all.
    await observeDecideOnly(clientReturning(), new LiveRunShared(), cfg, "sess", payload(4));
    expect(stats.misses).toBe(1);
  });

  it("inert run leaves the counter at 0 while still writing it", async () => {
    const stats = { misses: 0 };
    const cfg = cfgWith({ decideAsrQueueStats: stats, decideAsrMaxConcurrent: 0, decideAsrQueueMs: 0 });
    await observeDecideOnly(
      clientReturning({ asrSource: "queue_miss" }),
      new LiveRunShared(),
      cfg,
      "sess",
      payload()
    );
    // With no bound configured the decide service cannot report a bounded miss;
    // if one ever arrives the counter is still honest and the posture stays 0/0.
    const metrics = buildLiveObserveMetrics(observer(), undefined, undefined, undefined, {
      maxConcurrent: 0,
      queueMs: 0,
      misses: stats.misses,
    });
    expect(metrics.asrQueueMisses).toBe(stats.misses);
    expect(metrics).not.toHaveProperty("asrMaxConcurrent");
  });
});

describe("ADAAAA-8373 compose (deploy cannot disagree with the code)", () => {
  it("ships both knobs inert on the decide service and on the server service", () => {
    for (const name of ["decide", "server"]) {
      const block = serviceBlock(name);
      expect(block).toContain("ASR_MAX_CONCURRENT=${ASR_MAX_CONCURRENT:-0}");
      expect(block).toContain("ASR_QUEUE_MS=${ASR_QUEUE_MS:-0}");
    }
  });
});

// ADAAAA-8384 (C1): the browser/WebRTC media-rail share COMPUTED the counter and
// then dropped it. `api.ts` decides through the same `observeDecideOnly`/`anaCfg`
// pair as the analyzer pass, so `decideAsrQueueStats.misses` moved — but
// `media-rail.ts` built the snapshot with no `asrQueue` argument and
// `finishBrowserJob` persisted that, so every media-rail row carried no
// `asrQueueMisses` / `asrMaxConcurrent` / `asrQueueMs` (ADAAAA-8219 class).
describe("ADAAAA-8384 C1 — a media-rail share row carries the ASR posture", () => {
  const railWith = (asrQueue?: () => { maxConcurrent: number; queueMs: number; misses: number }, contentFps?: number) =>
    new MediaRailObserver({
      jobId: "job-8384-rail",
      fps: 2,
      windowS: 10,
      cadenceS: 3,
      maxFrames: 4,
      ...(contentFps !== undefined ? { contentFps } : {}),
      onDecide: async () => false,
      ...(asrQueue ? { asrQueue } : {}),
    });

  it("inert share writes asrQueueMisses: 0 and NO posture keys", () => {
    const metrics = railWith(() => ({ maxConcurrent: 0, queueMs: 0, misses: 0 })).observeMetrics();
    expect(metrics.asrQueueMisses).toBe(0);
    expect(metrics).not.toHaveProperty("asrMaxConcurrent");
    expect(metrics).not.toHaveProperty("asrQueueMs");
    // A rail built with no reader stays byte-identical (no asrQueue field at all).
    expect(railWith().observeMetrics()).not.toHaveProperty("asrQueueMisses");
  });

  it("bounded share writes the EFFECTIVE cap + queue and THIS run's counter, read live", () => {
    const stats = { misses: 0 };
    const rail = railWith(() => ({ maxConcurrent: 2, queueMs: 150, misses: stats.misses }));
    // 0 misses at share start is still written — the field is never conditionally absent.
    expect(rail.observeMetrics()).toMatchObject({ asrQueueMisses: 0, asrMaxConcurrent: 2, asrQueueMs: 150 });
    // Read at snapshot time: the counter the decide path increments later is visible.
    stats.misses = 2;
    const metrics = rail.observeMetrics();
    expect(metrics).toMatchObject({ asrQueueMisses: 2, asrMaxConcurrent: 2, asrQueueMs: 150 });
    // Survives the persistence parse (`store.patchJob` -> JobSchema).
    const job = JobSchema.parse({
      id: "job-8384-rail-row",
      status: "done",
      createdAt: new Date().toISOString(),
      source: "browser",
      observeMetrics: metrics,
    });
    expect(job.observeMetrics).toMatchObject({ asrQueueMisses: 2, asrMaxConcurrent: 2, asrQueueMs: 150 });
  });

  it("keeps the posture on the perceive-bearing path (contentFps set)", () => {
    const stats = { misses: 1 };
    const metrics = railWith(
      () => ({ maxConcurrent: 2, queueMs: 150, misses: stats.misses }),
      1 // contentFps > 0 => observeMetrics spreads the `perceive` block over it
    ).observeMetrics();
    expect(metrics.perceive).toBeTruthy();
    expect(metrics).toMatchObject({ asrQueueMisses: 1, asrMaxConcurrent: 2, asrQueueMs: 150 });
  });
});
