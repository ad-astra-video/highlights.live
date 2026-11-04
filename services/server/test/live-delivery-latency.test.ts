// ADAAAA-8005 (gate 3): the trigger -> DELIVERED latency metric.
//
// The AC ("trigger -> delivered p50 <= 5 s") had no metric behind it: the only
// number that matched was a hand join of `[live-lag:<job>] decide @Ts lag` and
// `[ingest-gap:<job>] decideE2eMs`, which cannot be re-graded off a job record.
// This suite pins the definition and the arithmetic:
//   (a) "delivered" is the store write-through ACK, and the per-row number is
//       `persistAck - (contentOrigin + triggerTs)`,
//   (b) the row decomposes EXACTLY into fire lag / decide e2e / accept wait /
//       accept work / persist ack, so a replay can blame the right stage,
//   (c) the observer only emits a row for an ACCEPTED window, and the snapshot
//       reaches `observeMetrics.deliveredLatency` with p50/p95/max.
import { describe, it, expect } from "vitest";
import {
  LiveDeliveryTracker,
  deliveredLatencyRow,
  deliveredLatencySummary,
  deliveredStageSum,
} from "../src/live-delivery";
import { buildLiveObserveMetrics } from "../src/analyzer";
import { LiveObserver } from "../src/observe-loop";

const ORIGIN = 1_700_000_000_000; // wall epoch ms of content t=0

describe("delivered-latency arithmetic (ADAAAA-8005 gate 3)", () => {
  it("computes trigger->delivered from absolute wall clocks and decomposes exactly", () => {
    const centerTs = 108;
    const lagMs = 2780; // content ts -> fire (frame arrival / relay lag)
    const firedAtMs = ORIGIN + centerTs * 1000 + lagMs;
    const settledAtMs = firedAtMs + 3839; // decide settle
    const acceptStartMs = settledAtMs + 20; // content-order head of line
    const acceptDoneMs = acceptStartMs + 160; // accept gate work
    const persistAckAtMs = acceptDoneMs + 12; // write-through ack
    const row = deliveredLatencyRow({
      centerTs,
      triggerTs: centerTs,
      lagMs,
      firedAtMs,
      settledAtMs,
      acceptStartMs,
      acceptDoneMs,
      persistAckAtMs,
      contentOriginMs: ORIGIN,
    });
    expect(row).toMatchObject({
      triggerTs: 108,
      fireLagMs: 2780,
      decideE2eMs: 3839,
      acceptWaitMs: 20,
      acceptMs: 160,
      persistAckMs: 12,
    });
    // The AC's number: persistAck - (contentOrigin + triggerTs).
    expect(row.deliveredLatencyMs).toBe(2780 + 3839 + 20 + 160 + 12);
    // ...and it is the SUM of the stages, not an independent estimate.
    expect(deliveredStageSum(row, { centerTs })).toBe(row.deliveredLatencyMs);
  });

  it("counts a LOCALIZED trigger against the row's own triggerTs, not the window centre", () => {
    const centerTs = 108;
    const triggerTs = 102.667; // ADAAAA-7996 localization inside the window
    const row = deliveredLatencyRow({
      centerTs,
      triggerTs,
      lagMs: 300,
      firedAtMs: ORIGIN + centerTs * 1000 + 300,
      settledAtMs: ORIGIN + centerTs * 1000 + 300 + 4000,
      acceptStartMs: ORIGIN + centerTs * 1000 + 4300,
      acceptDoneMs: ORIGIN + centerTs * 1000 + 4450,
      persistAckAtMs: ORIGIN + centerTs * 1000 + 4460,
      contentOriginMs: ORIGIN,
    });
    expect(row.triggerTs).toBe(102.667);
    expect(row.deliveredLatencyMs).toBe(Math.round(4460 + (centerTs - triggerTs) * 1000));
    expect(deliveredStageSum(row, { centerTs })).toBe(row.deliveredLatencyMs);
  });

  it("clamps a clock that would read negative instead of emitting a negative latency", () => {
    const row = deliveredLatencyRow({
      centerTs: 50,
      triggerTs: 50,
      lagMs: -5, // a clock skew must never produce a negative stage
      firedAtMs: ORIGIN + 50_000,
      settledAtMs: ORIGIN + 49_000, // settle before fire (skewed input)
      acceptStartMs: ORIGIN + 48_000,
      acceptDoneMs: ORIGIN + 47_000,
      persistAckAtMs: ORIGIN + 10_000, // acked before content t=0
      contentOriginMs: ORIGIN,
    });
    expect(row.fireLagMs).toBe(0);
    expect(row.decideE2eMs).toBe(0);
    expect(row.acceptWaitMs).toBe(0);
    expect(row.acceptMs).toBe(0);
    expect(row.persistAckMs).toBe(0);
    expect(row.deliveredLatencyMs).toBe(0);
  });

  it("summarises p50/p95/max over the per-row readings", () => {
    const make = (total: number) =>
      deliveredLatencyRow({
        centerTs: 0,
        triggerTs: 0,
        lagMs: 0,
        firedAtMs: ORIGIN,
        settledAtMs: ORIGIN + total,
        acceptStartMs: ORIGIN + total,
        acceptDoneMs: ORIGIN + total,
        persistAckAtMs: ORIGIN + total,
        contentOriginMs: ORIGIN,
      });
    const snap = deliveredLatencySummary([make(4300), make(4493), make(6277), make(6776)]);
    expect(snap.samples).toBe(4);
    // Nearest-rank style interpolation: (4493 + 6277) / 2.
    expect(snap.p50Ms).toBe(5385);
    expect(snap.p95Ms).toBe(6701); // 6277 + (6776 - 6277) * 0.85
    expect(snap.maxMs).toBe(6776);
    expect(snap.rows.map((r) => r.deliveredLatencyMs)).toEqual([4300, 4493, 6277, 6776]);
  });
});

describe("LiveDeliveryTracker (ADAAAA-8005)", () => {
  it("emits no snapshot before a row is delivered, then one per delivered row", () => {
    const tracker = new LiveDeliveryTracker("job-x");
    expect(tracker.snapshot()).toBeUndefined();
    const firedAtMs = ORIGIN + 45_000 + 1000;
    tracker.noteWindow({
      centerTs: 45,
      lagMs: 1000,
      firedAtMs,
      settledAtMs: firedAtMs + 3437,
      acceptStartMs: firedAtMs + 3437,
      acceptDoneMs: firedAtMs + 3600,
    });
    expect(tracker.snapshot()).toBeUndefined(); // pending: not yet readable
    tracker.notePersisted(45, firedAtMs + 3608);
    const snap = tracker.snapshot()!;
    expect(snap.samples).toBe(1);
    expect(snap.rows[0].deliveredLatencyMs).toBe(4608);
    expect(snap.p50Ms).toBe(4608);
  });

  it("attaches a localized trigger ack to the newest pending window", () => {
    const tracker = new LiveDeliveryTracker();
    const firedAtMs = ORIGIN + 108_000 + 200;
    tracker.noteWindow({
      centerTs: 108,
      lagMs: 200,
      firedAtMs,
      settledAtMs: firedAtMs + 4000,
      acceptStartMs: firedAtMs + 4000,
      acceptDoneMs: firedAtMs + 4150,
    });
    // The stored row's trigger sits inside the window, not on its centre.
    tracker.notePersisted(104.5, firedAtMs + 4160);
    const row = tracker.snapshot()!.rows[0];
    expect(row.triggerTs).toBe(104.5);
    // fire lag 200 ms + accept 4150 + ack 10 + the 3.5 s the trigger sits
    // before the window centre.
    expect(row.deliveredLatencyMs).toBe(4160 + 200 + 3500);
  });

  it("ignores a second ack for the same window (a retried persist cannot double-count)", () => {
    const tracker = new LiveDeliveryTracker();
    const firedAtMs = ORIGIN + 30_000;
    tracker.noteWindow({
      centerTs: 30,
      lagMs: 0,
      firedAtMs,
      settledAtMs: firedAtMs + 100,
      acceptStartMs: firedAtMs + 100,
      acceptDoneMs: firedAtMs + 200,
    });
    tracker.notePersisted(30, firedAtMs + 250);
    tracker.notePersisted(30, firedAtMs + 900);
    expect(tracker.snapshot()!.samples).toBe(1);
    expect(tracker.snapshot()!.rows[0].persistAckMs).toBe(50);
  });
});

describe("LiveObserver -> observeMetrics.deliveredLatency (ADAAAA-8005)", () => {
  function makeObserver(accepted: boolean | ((centerTs: number) => boolean)) {
    const tracker = new LiveDeliveryTracker("job-gate3");
    const observer = new LiveObserver({
      cadenceS: 3,
      windowS: 10,
      fps: 2,
      delivery: tracker,
      onDecideStaged: () => ({
        decide: async () => {},
        accept: async () => (typeof accepted === "function" ? accepted(0) : accepted),
      }),
      maxInFlight: 2,
      observeDecideOffLoop: true,
    } as any);
    return { observer, tracker };
  }

  it("records one row per ACCEPTED window and persists it under observeMetrics", async () => {
    const { observer } = makeObserver(true);
    observer.record(0, "f0", { ts: 0, tracks: [], objects: [], ocr: [] });
    await observer.maybeFire(0, false, 4500);
    // Drain the staged queue (flush fires the tail window too, so drive the
    // accept chain directly through the public flush path then settle).
    await observer.flush();
    // The tracker recorded a window at accept time; the server's persist path
    // completes it.
    observer.noteHighlightDelivered(observer.lastSample()!.centerTs);
    const m = buildLiveObserveMetrics(observer);
    expect(m.deliveredLatency).toBeDefined();
    expect(m.deliveredLatency!.samples).toBeGreaterThanOrEqual(1);
    const row = m.deliveredLatency!.rows[0];
    expect(row.fireLagMs).toBe(4500);
    expect(row.deliveredLatencyMs).toBeGreaterThanOrEqual(4500);
  });

  it("records no row for a rejected window", async () => {
    const observer = new LiveObserver({
      cadenceS: 3,
      windowS: 10,
      fps: 2,
      delivery: new LiveDeliveryTracker("job-rejected"),
      onDecideStaged: () => ({
        decide: async () => {},
        accept: async () => false,
      }),
      maxInFlight: 2,
      observeDecideOffLoop: true,
    } as any);
    observer.record(0, "f0", { ts: 0, tracks: [], objects: [], ocr: [] });
    await observer.maybeFire(0, false, 500);
    await observer.flush();
    expect(buildLiveObserveMetrics(observer).deliveredLatency).toBeUndefined();
  });
});
