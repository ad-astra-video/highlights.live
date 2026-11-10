// ADAAAA-8611 (live delivery tail 2): the ASR wait is bigger than the bar.
//
// Evidence (leg `0cade089`, 410 s, `cap-record-2`): row `076de635` (w12, trigger
// 385 s) delivered in 11 468 ms as `decideE2eMs 11 460` =
// **6 000 ms ASR prefetch wait-miss** (`[live-asr] lane=waitmiss waitMs=6000`) +
// **~5 458 ms decide**. `observeMetrics.asrWaitMisses = 13 / 84` windows. The
// structural problem: the deployed wait budget (`LIVE_DECIDE_ASR_WAIT_MS`, 6 000)
// is LARGER than the AC-B p95 bar (5 000), so any wait-miss row breaches p95 by
// construction, and at n in 9-19 the nearest-rank p95 is the max row.
//
// This suite pins the three properties of this ticket:
//   1. the ASR lane is attributable on the METRIC (`deliveredLatency.rows[]`
//      carries `asrLane` / `asrWaitMs` / `asrPrefetchMs`), not only in
//      `docker logs` + `decide_audit` (which held 81 of 84 rows on that leg), and
//      the stage identity `deliveredLatencyMs == sum(stages)` still holds exactly;
//   2. the headroom guard (`LIVE_DECIDE_ASR_HEADROOM_MS`) clamps the effective
//      wait to `min(budget, bar - elapsed)` — and is INERT at its default 0, i.e.
//      today's wait byte-for-byte;
//   3. a clamped/missed wait still proceeds INLINE and never aborts the prefetch
//      (its result still caches and is reused).
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LiveRunShared,
  buildLiveObserveMetrics,
  effectiveAsrWaitMs,
  observeDecideOnly,
  type AnalyzerConfig,
  type DecisionResult,
} from "../src/analyzer";
import { deliveredLatencyRow, deliveredStageSum, LiveDeliveryTracker } from "../src/live-delivery";
import { AsrPrefetcher } from "../src/asr-prefetch";
import {
  ASR_PREFETCH,
  ASR_STAGE,
  LiveObserver,
  type AsrStageHolder,
  type ObserveDecidePayload,
} from "../src/observe-loop";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";
import { JobSchema, ObserveMetricsSnapshotSchema } from "@highlights/events";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");
const ORIGIN = 1_700_000_000_000;

/** A window's payload with the three fire-time attachments the live observer
 *  makes: the side-lane prefetch promise, the ASR lane holder, and the wall fire
 *  instant. */
function payloadWith(
  prefetch: Promise<{ transcript: string; latencyS: number; ran: boolean } | null> | null,
  extra: { firedAtMs?: number; centerTs?: number } = {}
): { payload: ObserveDecidePayload; holder: AsrStageHolder } {
  const holder: AsrStageHolder = {};
  const payload: ObserveDecidePayload = {
    centerTs: extra.centerTs ?? 1.0,
    frames: [
      { ts: (extra.centerTs ?? 1.0) - 0.5, imageB64: "f0" },
      { ts: extra.centerTs ?? 1.0, imageB64: "f1" },
    ],
    seeds: [],
    biasHints: [],
    capped: false,
    droppedCount: 0,
    ...(extra.firedAtMs !== undefined ? { firedAtMs: extra.firedAtMs } : {}),
  };
  Object.defineProperty(payload, ASR_STAGE, { value: holder, enumerable: false });
  if (prefetch) Object.defineProperty(payload, ASR_PREFETCH, { value: prefetch, enumerable: false });
  return { payload, holder };
}

function cfgWith(extra: Record<string, unknown> = {}): AnalyzerConfig {
  return { jobId: "job-8611", gameHint: "soccer", audioContext: true, liveObserveLoop: true, ...extra } as unknown as AnalyzerConfig;
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

const slowPrefetch = (ms: number, transcript = "late goal call") =>
  new Promise<{ transcript: string; latencyS: number; ran: boolean }>((resolve) =>
    setTimeout(() => resolve({ transcript, latencyS: ms / 1000, ran: true }), ms)
  );

// ---------------------------------------------------------------------------
// 1. The pure clamp.
// ---------------------------------------------------------------------------
describe("effectiveAsrWaitMs (ADAAAA-8611 headroom clamp)", () => {
  it("is INERT at the shipped default (headroom 0): the wait stays the budget", () => {
    // Today's path, unchanged: no elapsed term, no clamp, the exact budget.
    expect(effectiveAsrWaitMs(6_000, 0, ORIGIN, ORIGIN + 4_900)).toBe(6_000);
    expect(effectiveAsrWaitMs(6_000, 0, undefined, ORIGIN)).toBe(6_000);
    // A configured budget but no headroom keeps 8351's behaviour for a row that
    // has already spent 4.9 s before the decide starts (the wait-miss shape).
    expect(effectiveAsrWaitMs(2_000, 0, ORIGIN, ORIGIN + 4_900)).toBe(2_000);
  });

  it("clamps to the bar headroom: min(budget, bar - elapsed since fire)", () => {
    // 6 s budget against the 5 s AC-B p95 bar, 1 s already spent => 4 s of wait.
    expect(effectiveAsrWaitMs(6_000, 5_000, ORIGIN, ORIGIN + 1_000)).toBe(4_000);
    // A row that already spent the whole bar waits 0 ms: it goes inline now
    // instead of spending 6 s more past a 5 s bar.
    expect(effectiveAsrWaitMs(6_000, 5_000, ORIGIN, ORIGIN + 5_200)).toBe(0);
    expect(effectiveAsrWaitMs(6_000, 5_000, ORIGIN, ORIGIN + 9_000)).toBe(0);
    // The budget still wins when it is the smaller of the two (a 2 s budget on a
    // 5 s bar with headroom to spare is unchanged).
    expect(effectiveAsrWaitMs(2_000, 5_000, ORIGIN, ORIGIN + 1_000)).toBe(2_000);
    // At fire, the headroom IS the bar when the bar is under the budget.
    expect(effectiveAsrWaitMs(6_000, 5_000, ORIGIN, ORIGIN)).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// 2. observeDecideOnly: inert default, clamp, and the lane on the payload.
// ---------------------------------------------------------------------------
describe("observeDecideOnly: the wait, the lane, and the clamp (ADAAAA-8611)", () => {
  it("inert default (no headroom env) waits the full budget exactly as 8351 shipped", async () => {
    const seen: any[] = [];
    const stats: { misses: number; trims?: number } = { misses: 0 };
    const { payload, holder } = payloadWith(slowPrefetch(120), { firedAtMs: Date.now() - 4_900 });
    const started = Date.now();
    await observeDecideOnly(recordingClient(seen), new LiveRunShared(), cfgWith({ decideAsrWaitMs: 6_000, decideAsrWaitStats: stats }), "sess", payload);
    // It waited for the prefetch (not cut by the ~4.9 s elapsed) ...
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(stats.misses).toBe(0);
    expect(stats.trims ?? 0).toBe(0);
    // ... used it, and the lane is attributable on the payload.
    expect(seen[0].asr).toMatchObject({ transcript: "late goal call", ran: true });
    expect(holder.stage).toMatchObject({ lane: "prefetched", prefetchMs: 120 });
    expect(holder.stage!.waitMs).toBeGreaterThanOrEqual(100);
  });

  it("clamps to headroom: a row past the bar stops waiting and decides inline", async () => {
    const seen: any[] = [];
    const stats: { misses: number; trims?: number } = { misses: 0 };
    // Already 4.98 s into a 5 s bar, with a 6 s budget: 20 ms of wait remains.
    const { payload, holder } = payloadWith(slowPrefetch(400), { firedAtMs: Date.now() - 4_980 });
    const started = Date.now();
    await observeDecideOnly(
      recordingClient(seen),
      new LiveRunShared(),
      cfgWith({ decideAsrWaitMs: 6_000, decideAsrHeadroomMs: 5_000, decideAsrWaitStats: stats }),
      "sess",
      payload
    );
    const elapsed = Date.now() - started;
    // Cut to ~20 ms, NOT the 400 ms prefetch and not the 6 s budget.
    expect(elapsed).toBeLessThan(300);
    // A clamped row is a TRIM, not a slow-call miss: `asrWaitMisses` stays
    // comparable to a pre-8611 leg.
    expect(stats.trims).toBe(1);
    expect(stats.misses).toBe(0);
    // No `asr` block => the decide service transcribes inline (coverage-neutral).
    expect(seen[0]).not.toHaveProperty("asr");
    expect(holder.stage).toMatchObject({ lane: "waitmiss", prefetchMs: 0 });
    expect(holder.stage!.waitMs).toBeGreaterThan(0);
  });

  it("a clamped wait that runs out keeps the prefetch in flight: it still caches and is reused", async () => {
    const asrCalls = { n: 0 };
    const prefetcher = new AsrPrefetcher({
      asrUrl: "http://asr:8082",
      timeoutMs: 20_000,
      maxConcurrent: 4,
      fetchImpl: (async () => {
        asrCalls.n++;
        await new Promise((r) => setTimeout(r, 80));
        return new Response(JSON.stringify({ text: "what a goal" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const first = prefetcher.start("clip-8611")!;
    const { payload, holder } = payloadWith(first, { firedAtMs: Date.now() - 5_000 });
    const seen: any[] = [];
    await observeDecideOnly(
      recordingClient(seen),
      new LiveRunShared(),
      cfgWith({ decideAsrWaitMs: 6_000, decideAsrHeadroomMs: 5_000, decideAsrWaitStats: { misses: 0 } }),
      "sess",
      payload
    );
    // Headroom was already spent => 0 ms wait, inline decide...
    expect(seen[0]).not.toHaveProperty("asr");
    expect(holder.stage).toMatchObject({ lane: "waitmiss" });
    // ...but the transcription was NOT aborted, and its result cached.
    const settled = await first;
    expect(settled).toMatchObject({ ran: true, transcript: "what a goal" });
    const reused = await prefetcher.start("clip-8611");
    expect(reused!.transcript).toBe("what a goal");
    expect(asrCalls.n).toBe(1);
    expect(prefetcher.stats.hits).toBe(1);
  });

  it("reports lane=inline (wait 0) for a window with no prefetch at all", async () => {
    const { payload, holder } = payloadWith(null);
    await observeDecideOnly(recordingClient([]), new LiveRunShared(), cfgWith({ decideAsrWaitMs: 6_000 }), "sess", payload);
    expect(holder.stage).toEqual({ lane: "inline", waitMs: 0, prefetchMs: 0 });
  });

  it("reports lane=miss when the prefetch settled without transcribing (inline fallback)", async () => {
    const { payload, holder } = payloadWith(Promise.resolve({ transcript: "", latencyS: 0.4, ran: false }));
    await observeDecideOnly(recordingClient([]), new LiveRunShared(), cfgWith({ decideAsrWaitMs: 6_000 }), "sess", payload);
    expect(holder.stage).toMatchObject({ lane: "miss", prefetchMs: 400 });
  });
});

// ---------------------------------------------------------------------------
// 3. The delivered-latency row carries the stage (additive, identity intact).
// ---------------------------------------------------------------------------
describe("deliveredLatency.rows[] carries the ASR stage (ADAAAA-8611)", () => {
  const base = {
    centerTs: 385,
    triggerTs: 385,
    lagMs: 0,
    firedAtMs: ORIGIN + 385_000,
    contentOriginMs: ORIGIN,
  };

  it("emits asrLane / asrWaitMs / asrPrefetchMs and keeps the stage identity exact", () => {
    // The leg's shape: 6 000 ms wait-miss + 5 458 ms decide, delivered 11 468 ms.
    const row = deliveredLatencyRow({
      ...base,
      settledAtMs: ORIGIN + 385_000 + 11_460,
      acceptStartMs: ORIGIN + 385_000 + 11_460,
      acceptDoneMs: ORIGIN + 385_000 + 11_468,
      persistAckAtMs: ORIGIN + 385_000 + 11_468,
      asr: { lane: "waitmiss", waitMs: 6_000, prefetchMs: 0 },
    });
    expect(row).toMatchObject({
      asrLane: "waitmiss",
      asrWaitMs: 6_000,
      asrPrefetchMs: 0,
      decideE2eMs: 11_460,
      deliveredLatencyMs: 11_468,
    });
    // The wait is INSIDE decideE2eMs: the stage sum still reconstructs the total
    // exactly (adding asrWaitMs would double-count 6 s of the tail).
    expect(deliveredStageSum(row)).toBe(row.deliveredLatencyMs);
    expect(row.decideE2eMs).toBeGreaterThanOrEqual(row.asrWaitMs);
  });

  it("reports inline / 0 / 0 on a row with no prefetch", () => {
    const row = deliveredLatencyRow({
      ...base,
      settledAtMs: ORIGIN + 385_000 + 4_300,
      acceptStartMs: ORIGIN + 385_000 + 4_320,
      acceptDoneMs: ORIGIN + 385_000 + 4_480,
      persistAckAtMs: ORIGIN + 385_000 + 4_490,
    });
    expect(row.asrLane).toBe("inline");
    expect(row.asrWaitMs).toBe(0);
    expect(row.asrPrefetchMs).toBe(0);
    expect(deliveredStageSum(row)).toBe(row.deliveredLatencyMs);
  });

  it("carries the stage through the tracker (stamped at registration)", () => {
    const tracker = new LiveDeliveryTracker("job-8611");
    const fired = ORIGIN + 385_000;
    tracker.noteWindow({
      centerTs: 385,
      lagMs: 0,
      firedAtMs: fired,
      settledAtMs: fired + 11_460,
      acceptStartMs: fired + 11_460,
      acceptDoneMs: fired + 11_468,
      asr: { lane: "waitmiss", waitMs: 6_000, prefetchMs: 0 },
    });
    tracker.notePersisted(385, fired + 11_468, "hl-385");
    const row = tracker.rows()[0];
    expect(row).toMatchObject({ asrLane: "waitmiss", asrWaitMs: 6_000, highlightId: "hl-385" });
    expect(deliveredStageSum(row)).toBe(row.deliveredLatencyMs);
  });

  it("stamps a window registered BEFORE its decide (the serial onDecide shape)", () => {
    const tracker = new LiveDeliveryTracker("job-8611-serial");
    const fired = ORIGIN + 40_000;
    tracker.noteWindow({
      centerTs: 40,
      lagMs: 0,
      firedAtMs: fired,
      settledAtMs: fired,
      acceptStartMs: fired,
      acceptDoneMs: null,
    });
    tracker.noteAsrStage(40, { lane: "prefetched", waitMs: 120, prefetchMs: 250 });
    tracker.notePersisted(40, fired + 400);
    tracker.noteAcceptDone(40, fired + 420);
    const row = tracker.rows()[0];
    expect(row).toMatchObject({ asrLane: "prefetched", asrWaitMs: 120, asrPrefetchMs: 250 });
  });

  it("prints the stage on the [live-deliver] evidence line", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const tracker = new LiveDeliveryTracker("job-8611");
    const fired = ORIGIN + 385_000;
    tracker.noteWindow({
      centerTs: 385,
      lagMs: 0,
      firedAtMs: fired,
      settledAtMs: fired + 11_460,
      acceptStartMs: fired + 11_460,
      acceptDoneMs: fired + 11_468,
      asr: { lane: "waitmiss", waitMs: 6_000, prefetchMs: 0 },
    });
    tracker.notePersisted(385, fired + 11_468);
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[live-deliver:job-8611]"));
    log.mockRestore();
    expect(line).toContain("asr=waitmiss/6000+0ms");
    expect(line).toContain("delivered=11468ms");
  });
});

// ---------------------------------------------------------------------------
// 4. Observer wiring: the lane the decide wrote reaches the delivered row.
// ---------------------------------------------------------------------------
describe("LiveObserver -> delivered row ASR stage (ADAAAA-8611)", () => {
  it("staged path: the lane the decide records lands on the row at accept", async () => {
    const tracker = new LiveDeliveryTracker("job-8611-staged");
    const observer = new LiveObserver({
      cadenceS: 3,
      windowS: 10,
      fps: 2,
      delivery: tracker,
      onDecideStaged: (payload: ObserveDecidePayload) => ({
        decide: async () => {
          // Exactly what `observeDecideOnly` does once it knows the lane.
          (payload[ASR_STAGE] as AsrStageHolder).stage = { lane: "waitmiss", waitMs: 6_000, prefetchMs: 0 };
        },
        accept: async () => true,
      }),
      maxInFlight: 2,
      observeDecideOffLoop: true,
    } as any);
    observer.record(0, "f0", { ts: 0, tracks: [], objects: [], ocr: [] });
    await observer.maybeFire(0, false, 4_500);
    await observer.flush();
    const centerTs = observer.lastSample()!.centerTs;
    observer.noteHighlightDelivered(centerTs);
    const row = buildLiveObserveMetrics(observer).deliveredLatency!.rows[0];
    expect(row).toMatchObject({ asrLane: "waitmiss", asrWaitMs: 6_000, asrPrefetchMs: 0 });
    expect(deliveredStageSum(row)).toBe(row.deliveredLatencyMs);
  });

  it("serial path: the lane is stamped after the decide, before the accept settles", async () => {
    const tracker = new LiveDeliveryTracker("job-8611-serial");
    const observer = new LiveObserver({
      cadenceS: 3,
      windowS: 10,
      fps: 2,
      delivery: tracker,
      onDecide: async (payload: ObserveDecidePayload) => {
        (payload[ASR_STAGE] as AsrStageHolder).stage = { lane: "prefetched", waitMs: 140, prefetchMs: 260 };
        return true;
      },
    } as any);
    observer.record(0, "f0", { ts: 0, tracks: [], objects: [], ocr: [] });
    await observer.maybeFire(0, false, 500);
    const centerTs = observer.lastSample()!.centerTs;
    observer.noteHighlightDelivered(centerTs);
    const row = buildLiveObserveMetrics(observer).deliveredLatency!.rows[0];
    expect(row).toMatchObject({ asrLane: "prefetched", asrWaitMs: 140, asrPrefetchMs: 260 });
  });

  it("a window with no prefetch reports inline / 0 / 0", async () => {
    const tracker = new LiveDeliveryTracker("job-8611-none");
    const observer = new LiveObserver({
      cadenceS: 3,
      windowS: 10,
      fps: 2,
      delivery: tracker,
      onDecideStaged: (payload: ObserveDecidePayload) => ({
        decide: async () => {
          (payload[ASR_STAGE] as AsrStageHolder).stage = { lane: "inline", waitMs: 0, prefetchMs: 0 };
        },
        accept: async () => true,
      }),
      maxInFlight: 2,
      observeDecideOffLoop: true,
    } as any);
    observer.record(0, "f0", { ts: 0, tracks: [], objects: [], ocr: [] });
    await observer.maybeFire(0, false, 1_000);
    await observer.flush();
    observer.noteHighlightDelivered(observer.lastSample()!.centerTs);
    const row = buildLiveObserveMetrics(observer).deliveredLatency!.rows[0];
    expect(row).toMatchObject({ asrLane: "inline", asrWaitMs: 0, asrPrefetchMs: 0 });
  });
});

// ---------------------------------------------------------------------------
// 5. The record survives persistence (the ADAAAA-8219 lesson) + the meters.
// ---------------------------------------------------------------------------
describe("the 8611 fields survive JobSchema.parse (8219 lesson)", () => {
  it("declares the row + posture fields and keeps them through the schemas", () => {
    const tracker = new LiveDeliveryTracker("job-8611-store");
    const fired = ORIGIN + 385_000;
    tracker.noteWindow({
      centerTs: 385,
      lagMs: 0,
      firedAtMs: fired,
      settledAtMs: fired + 11_460,
      acceptStartMs: fired + 11_460,
      acceptDoneMs: fired + 11_468,
      asr: { lane: "waitmiss", waitMs: 6_000, prefetchMs: 0 },
    });
    tracker.notePersisted(385, fired + 11_468, "hl-385");
    const observer = new LiveObserver({ cadenceS: 3, windowS: 10, fps: 2, delivery: tracker, onDecide: async () => false });
    const metrics = buildLiveObserveMetrics(observer, undefined, undefined, undefined, {
      waitMs: 6_000,
      misses: 4,
      laneWidth: 4,
      headroomMs: 5_000,
      trims: 9,
    });
    expect(metrics).toMatchObject({
      asrWaitMisses: 4,
      asrWaitBudgetMs: 6_000,
      asrLaneWidth: 4,
      asrWaitHeadroomMs: 5_000,
      asrWaitTrims: 9,
    });
    expect(ObserveMetricsSnapshotSchema.parse(metrics)).toMatchObject({
      asrWaitHeadroomMs: 5_000,
      asrWaitTrims: 9,
    });
    const job = JobSchema.parse({
      id: "job-8611-meter",
      status: "done",
      createdAt: new Date().toISOString(),
      source: "rtmp",
      observeMetrics: metrics,
    });
    const row = job.observeMetrics!.deliveredLatency!.rows[0];
    // Not stripped: the attribution the ticket exists to persist is on the row.
    expect(row).toMatchObject({ asrLane: "waitmiss", asrWaitMs: 6_000, asrPrefetchMs: 0 });
  });

  it("writes NO 8611 posture fields on an unconfigured rail (byte-identical row)", () => {
    const observer = new LiveObserver({ cadenceS: 3, windowS: 10, fps: 2, onDecide: async () => false });
    const inert = buildLiveObserveMetrics(observer);
    expect(inert).not.toHaveProperty("asrWaitHeadroomMs");
    expect(inert).not.toHaveProperty("asrWaitTrims");
    // A budget WITHOUT headroom keeps the 8351 posture exactly.
    const budgetOnly = buildLiveObserveMetrics(observer, undefined, undefined, undefined, {
      waitMs: 6_000,
      misses: 2,
      laneWidth: 4,
    });
    expect(budgetOnly).toMatchObject({ asrWaitMisses: 2, asrWaitBudgetMs: 6_000, asrLaneWidth: 4 });
    expect(budgetOnly).not.toHaveProperty("asrWaitHeadroomMs");
    expect(budgetOnly).not.toHaveProperty("asrWaitTrims");
  });
});

// ---------------------------------------------------------------------------
// 6. Config + compose: inert default, explicit value carried through.
// ---------------------------------------------------------------------------
describe("LIVE_DECIDE_ASR_HEADROOM_MS config + compose (ADAAAA-8611)", () => {
  it("defaults to 0 (inert) and carries an explicit value to the analyzer config", () => {
    const base = { PERCEIVE_URL: "http://p", DECIDE_URL: "http://d", ASR_URL: "http://asr:8082", LIVE_OBSERVE_LOOP: "1" };
    expect(loadConfig(base).liveDecideAsrHeadroomMs).toBe(0);
    // `0` is inert too (positiveNumberOrUndefined rejects it).
    expect(loadConfig({ ...base, LIVE_DECIDE_ASR_HEADROOM_MS: "0" }).liveDecideAsrHeadroomMs).toBe(0);

    const cfg = loadConfig({ ...base, LIVE_DECIDE_ASR_WAIT_MS: "6000", LIVE_DECIDE_ASR_HEADROOM_MS: "5000" });
    // The ratified 6 000 ms budget is NOT touched by this ticket.
    expect(cfg.liveDecideAsrWaitMs).toBe(6_000);
    expect(cfg.liveDecideAsrHeadroomMs).toBe(5_000);
    const analyzer = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-8611-cfg", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    });
    expect(analyzer.decideAsrWaitMs).toBe(6_000);
    expect(analyzer.decideAsrHeadroomMs).toBe(5_000);
    expect(analyzer.decideAsrWaitStats).toMatchObject({ misses: 0, trims: 0 });
    // A per-run counter object, not a module global.
    const second = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-8611-cfg-b", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    });
    expect(second.decideAsrWaitStats).not.toBe(analyzer.decideAsrWaitStats);
  });

  it("compose ships the guard INERT by default on the server service", () => {
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
    expect(server).toContain("LIVE_DECIDE_ASR_HEADROOM_MS=${LIVE_DECIDE_ASR_HEADROOM_MS:-0}");
    // ...and the ratified budget keeps its inert default too (not changed here).
    expect(server).toContain("LIVE_DECIDE_ASR_WAIT_MS=${LIVE_DECIDE_ASR_WAIT_MS:-0}");
  });
});
