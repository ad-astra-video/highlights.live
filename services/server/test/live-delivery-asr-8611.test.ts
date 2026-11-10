// ADAAAA-8611: make the ASR lane stage ATTRIBUTABLE on the delivered row, and
// land the headroom-aware wait guard INERT by default.
//
// Why this exists (leg `0cade089`, graded on ADAAAA-8487): AC-B failed p95 on ONE
// row (`076de635`, w12) whose `decideE2eMs` was 11 460 ms with `fireLagMs 0` and
// `persistAckMs 0`. The split was 6 000 ms ASR prefetch WAIT-MISS + ~5 458 ms
// decide, and proving it needed `docker logs` (`[live-asr:<job>] ... lane=waitmiss
// waitMs=6000`) plus a `decide_audit` join that was missing 3 of 84 rows. The
// graded bundle therefore could not show the stage at all.
//
// Two properties are pinned here:
//   (a) every delivered row carries `asrLane` / `asrWaitMs` / `asrPrefetchMs`, and
//       the wait is attribution INSIDE `decideE2eMs` — adding it to the stage sum
//       would double-count the tail and break the graded identity;
//   (b) `LIVE_DECIDE_ASR_HEADROOM_MS` clamps the wait to the remaining
//       delivered-latency-bar headroom, and at its shipped default (0) the code
//       path is today's exactly: full budget, full await, no trim counter.
import { describe, it, expect } from "vitest";
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
import {
  LiveDeliveryTracker,
  deliveredLatencyRow,
  deliveredLatencySummary,
  deliveredStageSum,
} from "../src/live-delivery";
import { LiveObserver, ASR_PREFETCH, ASR_STAGE, type AsrStageHolder, type ObserveDecidePayload } from "../src/observe-loop";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";
import { JobSchema, ObserveMetricsSnapshotSchema } from "@highlights/events";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");

const ORIGIN = 1_700_000_000_000;

function payload(centerTs = 1.0): ObserveDecidePayload {
  const pl: ObserveDecidePayload = {
    centerTs,
    frames: [{ ts: centerTs - 0.5, imageB64: "f0" }],
    seeds: [],
    biasHints: [],
    capped: false,
    droppedCount: 0,
  };
  // The observer attaches the lane holder at fire time on every committed window.
  Object.defineProperty(pl, ASR_STAGE, { value: {} as AsrStageHolder, enumerable: false });
  return pl;
}

function payloadWithPrefetch(
  p: Promise<{ transcript: string; latencyS: number; ran: boolean } | null>,
  extra: { firedAtMs?: number } = {}
): ObserveDecidePayload {
  const pl = payload();
  Object.defineProperty(pl, ASR_PREFETCH, { value: p, enumerable: false });
  if (extra.firedAtMs !== undefined) pl.firedAtMs = extra.firedAtMs;
  return pl;
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

describe("the delivered row attributes its ASR lane (ADAAAA-8611 AC-1)", () => {
  it("emits asrLane / asrWaitMs / asrPrefetchMs and keeps the stage identity exact", () => {
    const centerTs = 385;
    const firedAtMs = ORIGIN + centerTs * 1000;
    // The leg `0cade089` @385 s shape: 6 000 ms wait-miss, then an 11 460 ms decide.
    const row = deliveredLatencyRow({
      centerTs,
      triggerTs: 377.667,
      lagMs: 0,
      firedAtMs,
      settledAtMs: firedAtMs + 11_460,
      acceptStartMs: firedAtMs + 11_460,
      acceptDoneMs: firedAtMs + 11_468,
      persistAckAtMs: firedAtMs + 11_468,
      contentOriginMs: ORIGIN,
      asr: { lane: "waitmiss", waitMs: 6_000, prefetchMs: 0 },
      highlightId: "076de635",
    });
    expect(row).toMatchObject({
      asrLane: "waitmiss",
      asrWaitMs: 6_000,
      asrPrefetchMs: 0,
      decideE2eMs: 11_460,
      persistAckMs: 0,
    });
    // The wait is INSIDE decideE2eMs: the identity the AC is graded on must not
    // move by adding it again as its own stage.
    expect(deliveredStageSum(row)).toBe(row.deliveredLatencyMs);
    expect(row.deliveredLatencyMs).toBe(11_460 + 8 + Math.round((centerTs - 377.667) * 1000));
    // ...and the split is readable straight off the row.
    expect(row.decideE2eMs - row.asrWaitMs).toBe(5_460);
  });

  it("a row with no prefetch reports inline / 0 / 0 instead of an absent field", () => {
    const row = deliveredLatencyRow({
      centerTs: 10,
      triggerTs: 10,
      lagMs: 5,
      firedAtMs: ORIGIN + 10_000,
      settledAtMs: ORIGIN + 13_000,
      acceptStartMs: ORIGIN + 13_020,
      acceptDoneMs: ORIGIN + 13_180,
      persistAckAtMs: ORIGIN + 13_190,
      contentOriginMs: ORIGIN,
    });
    expect(row).toMatchObject({ asrLane: "inline", asrWaitMs: 0, asrPrefetchMs: 0 });
    expect(deliveredStageSum(row)).toBe(row.deliveredLatencyMs);
  });

  it("the tracker carries the lane the decide took, registered with the window (staged path)", () => {
    const tracker = new LiveDeliveryTracker("8611-staged");
    const firedAtMs = ORIGIN;
    // The staged path registers the window AFTER its decide settled, so the lane
    // is already known and rides the registration.
    tracker.noteWindow({
      centerTs: 3,
      lagMs: 0,
      firedAtMs,
      settledAtMs: firedAtMs + 4_000,
      acceptStartMs: firedAtMs + 4_000,
      acceptDoneMs: null,
      asr: { lane: "prefetched", waitMs: 0, prefetchMs: 780 },
    });
    tracker.notePersisted(3, firedAtMs + 4_010, "row-staged");
    tracker.noteAcceptDone(3, firedAtMs + 4_020);
    const [row] = tracker.rows();
    expect(row).toMatchObject({ asrLane: "prefetched", asrWaitMs: 0, asrPrefetchMs: 780, highlightId: "row-staged" });
  });

  it("noteAsrStage stamps a window whose lane is only known after its accept started (serial path)", () => {
    const tracker = new LiveDeliveryTracker("8611-serial");
    const firedAtMs = ORIGIN;
    // Registered before the combined decide+accept call (the ack fires inside it).
    tracker.noteWindow({ centerTs: 7, lagMs: 0, firedAtMs, settledAtMs: firedAtMs, acceptStartMs: firedAtMs, acceptDoneMs: null });
    tracker.notePersisted(7, firedAtMs + 6_000, "row-serial");
    tracker.noteAsrStage(7, { lane: "waitmiss", waitMs: 6_000, prefetchMs: 0 });
    tracker.noteAcceptDone(7, firedAtMs + 6_050);
    const [row] = tracker.rows();
    expect(row).toMatchObject({ asrLane: "waitmiss", asrWaitMs: 6_000, highlightId: "row-serial" });
    // A stage already stamped at registration is never overwritten by a later one.
    tracker.noteAsrStage(7, { lane: "inline", waitMs: 0, prefetchMs: 0 });
    expect(tracker.rows()[0].asrLane).toBe("waitmiss");
  });

  it("the ASR lane survives JobSchema.parse (the ADAAAA-8219 trap: undeclared keys are stripped)", () => {
    const summary = deliveredLatencySummary([
      deliveredLatencyRow({
        centerTs: 20,
        triggerTs: 20,
        lagMs: 0,
        firedAtMs: ORIGIN + 20_000,
        settledAtMs: ORIGIN + 26_000,
        acceptStartMs: ORIGIN + 26_000,
        acceptDoneMs: ORIGIN + 26_010,
        persistAckAtMs: ORIGIN + 26_010,
        contentOriginMs: ORIGIN,
        asr: { lane: "waitmiss", waitMs: 6_000, prefetchMs: 0 },
        highlightId: "row-persist",
      }),
    ]);
    // A FULL snapshot plus the delivered block: the schema requires the observer's
    // own fields, so build them instead of hand-rolling a partial object.
    const observer = new LiveObserver({ cadenceS: 3, windowS: 10, fps: 2, onDecide: async () => false });
    const base = buildLiveObserveMetrics(observer);
    const parsed = ObserveMetricsSnapshotSchema.parse({ ...base, deliveredLatency: summary });
    expect(parsed.deliveredLatency!.rows[0]).toMatchObject({ asrLane: "waitmiss", asrWaitMs: 6_000, asrPrefetchMs: 0 });
    const job = JobSchema.parse({
      id: "job-8611-persist",
      status: "done",
      createdAt: new Date().toISOString(),
      source: "rtmp",
      observeMetrics: parsed,
    });
    expect(job.observeMetrics!.deliveredLatency!.rows[0]).toMatchObject({ asrLane: "waitmiss", asrWaitMs: 6_000 });
  });
});

describe("the headroom clamp is pure and INERT at its default (ADAAAA-8611 AC-2)", () => {
  it("headroom 0 returns the configured budget unchanged", () => {
    expect(effectiveAsrWaitMs(6_000, 0, ORIGIN, ORIGIN + 100)).toBe(6_000);
    expect(effectiveAsrWaitMs(6_000, 0, undefined, ORIGIN)).toBe(6_000);
    expect(effectiveAsrWaitMs(0, 0, ORIGIN, ORIGIN)).toBe(0);
  });

  it("clamps to the remaining headroom, never below 0, never above the budget", () => {
    // 4 000 ms of the 5 000 ms bar already spent before the wait starts.
    expect(effectiveAsrWaitMs(6_000, 5_000, ORIGIN, ORIGIN + 4_000)).toBe(1_000);
    // The bar is already gone: the decide does not wait at all.
    expect(effectiveAsrWaitMs(6_000, 5_000, ORIGIN, ORIGIN + 6_000)).toBe(0);
    // A budget smaller than the headroom keeps the budget.
    expect(effectiveAsrWaitMs(500, 5_000, ORIGIN, ORIGIN + 100)).toBe(500);
    // A missing fire clock reads as elapsed 0 (the staged path's shape).
    expect(effectiveAsrWaitMs(6_000, 5_000, undefined, ORIGIN)).toBe(5_000);
  });

  it("a trimmed wait proceeds inline immediately and does NOT abort the prefetch", async () => {
    const seen: any[] = [];
    const stats: { misses: number; trims?: number } = { misses: 0, trims: 0 };
    let settledWith: string | null = null;
    const slow = new Promise<any>((resolve) =>
      setTimeout(() => {
        settledWith = "late goal call";
        resolve({ transcript: "late goal call", latencyS: 0.25, ran: true });
      }, 200)
    );
    const pl = payloadWithPrefetch(slow, { firedAtMs: Date.now() - 6_000 });
    const started = Date.now();
    await observeDecideOnly(recordingClient(seen), new LiveRunShared(), cfgWith({ decideAsrWaitMs: 6_000, decideAsrHeadroomMs: 5_000, decideAsrWaitStats: stats }), "sess", pl);
    // The 5 000 ms bar was already spent => no wait at all, inline ASR.
    expect(Date.now() - started).toBeLessThan(150);
    expect(stats.trims).toBe(1);
    // A trim is NOT a slow-call miss: the pre-8611 counter stays comparable.
    expect(stats.misses).toBe(0);
    expect(seen[0]).not.toHaveProperty("asr");
    // The lane is stamped for the delivered row even through the trim.
    expect((pl[ASR_STAGE] as AsrStageHolder).stage).toMatchObject({ lane: "waitmiss", waitMs: 0 });
    // The prefetch was never aborted: it still settles and caches.
    expect(await slow).toMatchObject({ ran: true });
    expect(settledWith).toBe("late goal call");
  });

  it("headroom unset = today's behaviour byte-identically (full budget, full await, no trim)", async () => {
    const seen: any[] = [];
    const stats: { misses: number; trims?: number } = { misses: 0, trims: 0 };
    const slow = new Promise<any>((resolve) =>
      setTimeout(() => resolve({ transcript: "goal", latencyS: 0.12, ran: true }), 120)
    );
    const pl = payloadWithPrefetch(slow, { firedAtMs: Date.now() - 60_000 });
    const started = Date.now();
    await observeDecideOnly(recordingClient(seen), new LiveRunShared(), cfgWith({ decideAsrWaitMs: 6_000, decideAsrWaitStats: stats }), "sess", pl);
    // The whole prefetch was awaited even though a 60 s old fire clock would have
    // trimmed it under the guard: the default is inert.
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(stats.misses).toBe(0);
    expect(stats.trims).toBe(0);
    expect(seen[0].asr).toMatchObject({ transcript: "goal" });
    expect((pl[ASR_STAGE] as AsrStageHolder).stage).toMatchObject({ lane: "prefetched" });
  });
});

describe("the headroom posture reaches the stored record (ADAAAA-8611)", () => {
  it("publishes asrWaitHeadroomMs / asrWaitTrims only when the clamp is configured", () => {
    const observer = new LiveObserver({ cadenceS: 3, windowS: 10, fps: 2, onDecide: async () => false });
    const inert = buildLiveObserveMetrics(observer, undefined, undefined, undefined, { waitMs: 6_000, misses: 13, laneWidth: 4 });
    expect(inert).toMatchObject({ asrWaitMisses: 13, asrWaitBudgetMs: 6_000, asrLaneWidth: 4 });
    expect(inert).not.toHaveProperty("asrWaitHeadroomMs");
    expect(inert).not.toHaveProperty("asrWaitTrims");

    const clamped = buildLiveObserveMetrics(observer, undefined, undefined, undefined, { waitMs: 6_000, misses: 3, laneWidth: 4, headroomMs: 5_000, trims: 10 });
    expect(clamped).toMatchObject({ asrWaitHeadroomMs: 5_000, asrWaitTrims: 10, asrWaitMisses: 3 });
    // Declared on the schema, so `store.patchJob` cannot strip them.
    expect(ObserveMetricsSnapshotSchema.parse(clamped)).toMatchObject({ asrWaitHeadroomMs: 5_000, asrWaitTrims: 10 });
  });

  it("LIVE_DECIDE_ASR_HEADROOM_MS defaults to 0 (inert) and reaches the analyzer config", () => {
    const base = { PERCEIVE_URL: "http://p", DECIDE_URL: "http://d", ASR_URL: "http://asr:8082", LIVE_OBSERVE_LOOP: "1" };
    expect(loadConfig(base).liveDecideAsrHeadroomMs).toBe(0);
    expect(loadConfig({ ...base, LIVE_DECIDE_ASR_HEADROOM_MS: "0" }).liveDecideAsrHeadroomMs).toBe(0);
    const cfg = loadConfig({ ...base, LIVE_DECIDE_ASR_WAIT_MS: "6000", LIVE_DECIDE_ASR_HEADROOM_MS: "5000" });
    expect(cfg.liveDecideAsrHeadroomMs).toBe(5_000);
    const analyzer = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-8611-cfg", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    });
    // The ratified 6 000 ms budget is NOT changed by this ticket.
    expect(analyzer.decideAsrWaitMs).toBe(6_000);
    expect(analyzer.decideAsrHeadroomMs).toBe(5_000);
    expect(analyzer.decideAsrWaitStats).toEqual({ misses: 0, trims: 0 });
  });

  it("compose ships the headroom knob inert by default on the server service", () => {
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
    // ...and the budget it clamps is still the ratified 6 000 ms default.
    expect(server).toContain("LIVE_DECIDE_ASR_WAIT_MS=${LIVE_DECIDE_ASR_WAIT_MS:-0}");
  });
});
