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
import { describe, it, expect, vi } from "vitest";
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

// ---------------------------------------------------------------------------
// ADAAAA-8024: the re-attestation (upgrade) delivery path.
//
// Measured gap: on job `228462b5` (build `d6c9a9f`) three highlights were
// delivered at 108.8 / 159 / 285 s but `deliveredLatency.samples` read 2 —
// the @108.8 GOAL was demoted by the ADAAAA-7996 gate, re-attested by the
// ADAAAA-8017 upgrade path, and delivered from that path, which never reported
// a delivery. Two things were missing:
//   (1) the observer only registered a window when `accepted` was true, so a
//       demoted window's fire/settle/accept clocks were thrown away, and
//   (2) the upgrade's write-through ack never reached `notePersisted`.
// These tests pin the fix: one reading per delivered highlight ROW, whichever
// path delivered it, with a breakdown that reconstructs the total exactly.
// ---------------------------------------------------------------------------
describe("delivered-latency: re-attested (upgrade-path) deliveries (ADAAAA-8024)", () => {
  const centerTs = 159;
  const lagMs = 700;
  const firedAtMs = ORIGIN + centerTs * 1000 + lagMs;
  const window = {
    centerTs,
    lagMs,
    firedAtMs,
    settledAtMs: firedAtMs + 4300,
    acceptStartMs: firedAtMs + 4420,
    acceptDoneMs: firedAtMs + 4600,
  };

  it("records a delivery produced ONLY by the upgrade path (samples = 1, exact breakdown)", () => {
    const tracker = new LiveDeliveryTracker("job-2284");
    // The window was decided and its row shipped as a celebration (the gate
    // demoted it), so the observer registers it even though accepted=false.
    tracker.noteWindow(window);
    expect(tracker.snapshot()).toBeUndefined(); // registered ≠ delivered

    // ~9 s later the later scoreboard read re-attests the row.
    const upgradeAckAtMs = firedAtMs + 4600 + 9000;
    tracker.notePersisted(centerTs, upgradeAckAtMs, "hl-goal2");

    const snap = tracker.snapshot()!;
    expect(snap.samples).toBe(1);
    const row = snap.rows[0];
    expect(row).toMatchObject({
      triggerTs: 159,
      fireLagMs: 700,
      decideE2eMs: 4300,
      acceptWaitMs: 120,
      acceptMs: 180,
      persistAckMs: 9000,
      localizeOffsetMs: 0,
      highlightId: "hl-goal2",
    });
    // The AC's number, and the breakdown reconstructs it EXACTLY.
    expect(row.deliveredLatencyMs).toBe(700 + 4300 + 120 + 180 + 9000);
    expect(deliveredStageSum(row)).toBe(row.deliveredLatencyMs);
  });

  it("prints the matching [live-deliver:<job>] line for an upgrade delivery", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const tracker = new LiveDeliveryTracker("job-2284");
    tracker.noteWindow(window);
    tracker.notePersisted(centerTs, firedAtMs + 4600 + 9000, "hl-goal2");
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("[live-deliver:job-2284]"));
    log.mockRestore();
    expect(line).toBeDefined();
    expect(line).toContain("delivered=14300ms");
    expect(line).toContain("highlight=hl-goal2");
  });

  it("counts the row ONCE when the accept path and the upgrade both fire", () => {
    const tracker = new LiveDeliveryTracker("job-both");
    tracker.noteWindow(window);
    // Accept-time persist (the celebration row became readable then)...
    tracker.notePersisted(centerTs, firedAtMs + 4608, "hl-goal2");
    // ...then the re-attestation upgrade reports the SAME row.
    tracker.notePersisted(centerTs, firedAtMs + 4600 + 9000, "hl-goal2");
    const snap = tracker.snapshot()!;
    expect(snap.samples).toBe(1);
    // First delivery wins: the row keeps the accept-time reading.
    expect(snap.rows[0].deliveredLatencyMs).toBe(700 + 4300 + 120 + 180 + 8);
  });

  it("samples equals the number of DISTINCT delivered rows", () => {
    const tracker = new LiveDeliveryTracker();
    tracker.noteWindow(window);
    tracker.noteWindow({ ...window, centerTs: 285, lagMs: 1100, firedAtMs: ORIGIN + 285_000 + 1100 });
    tracker.notePersisted(159, firedAtMs + 4600 + 500, "hl-a");
    tracker.notePersisted(285, ORIGIN + 285_000 + 1100 + 4600 + 500, "hl-b");
    // Every path may re-report a row; none may add a second reading.
    tracker.notePersisted(285, ORIGIN + 285_000 + 1100 + 4600 + 500, "hl-b");
    tracker.notePersisted(159, firedAtMs + 4600 + 9000, "hl-a");
    const snap = tracker.snapshot()!;
    expect(snap.samples).toBe(2);
    expect(new Set(snap.rows.map((r) => r.highlightId)).size).toBe(snap.samples);
  });

  it("keeps a LOCALIZED re-attested trigger exact via its own localize term", () => {
    const tracker = new LiveDeliveryTracker();
    tracker.noteWindow(window);
    // ADAAAA-8017's boundary read swings the anchor inside the window.
    tracker.notePersisted(158.667, firedAtMs + 4600 + 9000, "hl-goal2");
    const row = tracker.snapshot()!.rows[0];
    expect(row.localizeOffsetMs).toBe(333);
    expect(row.deliveredLatencyMs).toBe(700 + 4300 + 120 + 180 + 9000 + 333);
    expect(deliveredStageSum(row)).toBe(row.deliveredLatencyMs);
  });
});

describe("LiveObserver registers a DEMOTED window so the upgrade delivery is measurable (ADAAAA-8024)", () => {
  it("keeps the clocks of an accepted=false window and emits the row when the upgrade acks", async () => {
    const tracker = new LiveDeliveryTracker("job-demoted");
    const observer = new LiveObserver({
      cadenceS: 3,
      windowS: 10,
      fps: 2,
      delivery: tracker,
      onDecideStaged: () => ({
        decide: async () => {},
        // ADAAAA-7996: the goal gate demotes the accept to a celebration row.
        accept: async () => false,
      }),
      maxInFlight: 2,
      observeDecideOffLoop: true,
    } as any);
    observer.record(0, "f0", { ts: 0, tracks: [], objects: [], ocr: [] });
    await observer.maybeFire(0, false, 4500);
    await observer.flush();
    // The demoted window contributes NO sample by itself (accepted=false)...
    expect(buildLiveObserveMetrics(observer).deliveredLatency).toBeUndefined();
    // ...but its clocks are retained, so the re-attestation's ack completes it.
    const centerTs = observer.lastSample()!.centerTs;
    const ackAtMs = Date.now() + 9000;
    observer.noteHighlightDelivered(centerTs, ackAtMs, "hl-demoted");
    const snap = buildLiveObserveMetrics(observer).deliveredLatency!;
    expect(snap.samples).toBe(1);
    expect(snap.rows[0].fireLagMs).toBe(4500);
    expect(snap.rows[0].highlightId).toBe("hl-demoted");
    expect(deliveredStageSum(snap.rows[0])).toBe(snap.rows[0].deliveredLatencyMs);
  });
});

// ADAAAA-8495 (AC2): the off-by-one window pairing.
//
// ADAAAA-8487 AC-A proved on leg `2c4124fe` that every delivered row carried the
// PREVIOUS decided window's clocks: `noteWindow` registered a window only after
// `accept()` returned (observe-loop), the store ack fires DURING accept, and a
// live-localized trigger (a 3 s-multiple offset from the judged centre) never
// matches `centerTs` exactly — so the `pending[pending.length - 1]` fallback
// consumed the previous entry. `ackAt - persistAckMs` reproduced a stored
// `job_candidates.created_at` on 9/9 rows, and 43,051 of 140,554 ms (30.6 %) of
// the reported `persistAckMs` was that previous window's decide cadence.
describe("delivered-latency window pairing (ADAAAA-8495 AC2)", () => {
  /** A decided window's clocks. `decideMs` is fire -> decide settle; the accept
   *  is fast (`acceptMs`) unless told otherwise, exactly like a window that
   *  shipped no row. */
  function windowAt(centerTs: number, decideMs: number, acceptMs: number, atMs: number) {
    const firedAtMs = atMs;
    const settledAtMs = firedAtMs + decideMs;
    return {
      centerTs,
      lagMs: 200,
      firedAtMs,
      settledAtMs,
      acceptStartMs: settledAtMs,
      acceptDoneMs: settledAtMs + acceptMs,
    };
  }

  it("reproduces the pre-8495 mis-pairing when the window is registered only AFTER its accept", () => {
    const tracker = new LiveDeliveryTracker();
    // Window A (centre 100) was decided and accepted 5 ms after settling; it is
    // the window that happened to be pending when B's row acked.
    const a = windowAt(100, 5_000, 5, ORIGIN + 100_000 + 200);
    tracker.noteWindow(a); // legacy order: registered once accept() returned
    // Window B (centre 106) is still being accepted when its own row acks: the
    // trigger is localized to 103, so the exact-centre match fails.
    const ackAtB = a.acceptDoneMs + 1_200;
    tracker.notePersisted(103, ackAtB);
    const row = tracker.rows()[0];
    // The row reports A's decide cost and A's acceptDone — the bug.
    expect(row.decideE2eMs).toBe(5_000);
    expect(row.acceptMs).toBe(5);
    expect(row.persistAckMs).toBe(1_200);
    expect(row.triggerTs).toBe(103);
  });

  it("pairs a row emitted DURING its own accept with its own window (the fix)", () => {
    const tracker = new LiveDeliveryTracker();
    // A previous, faster window is still pending (it shipped no row).
    const a = windowAt(100, 5_000, 5, ORIGIN + 100_000 + 200);
    tracker.noteWindow(a);
    // Window B: registered BEFORE its accept runs (acceptDoneMs unknown yet).
    const firedAtB = ORIGIN + 106_000 + 200;
    const settledAtB = firedAtB + 1_400; // its own decide (fast, like the leg)
    const acceptStartB = settledAtB + 10; // content-order head of line
    tracker.noteWindow({
      centerTs: 106,
      lagMs: 200,
      firedAtMs: firedAtB,
      settledAtMs: settledAtB,
      acceptStartMs: acceptStartB,
      acceptDoneMs: null,
    });
    // The row is persisted (acked) 42 ms into B's accept, with its trigger
    // localized to 103 — it must still pair with B.
    const ackAtB = acceptStartB + 42;
    tracker.notePersisted(103, ackAtB, "hl-b");
    expect(tracker.rows().length).toBe(0); // not finalised until accept returns
    const acceptDoneB = acceptStartB + 60;
    tracker.noteAcceptDone(106, acceptDoneB);
    const row = tracker.rows()[0];
    expect(row.highlightId).toBe("hl-b");
    expect(row.triggerTs).toBe(103);
    // Its OWN window: 1,400 ms decide (not A's 5,000), 10 ms head of line.
    expect(row.decideE2eMs).toBe(1_400);
    expect(row.acceptWaitMs).toBe(10);
    // The ack landed inside the accept, so there is no post-accept ack wait.
    expect(row.persistAckMs).toBe(0);
    expect(row.acceptMs).toBe(ackAtB - acceptStartB);
    // The total still reconstructs from the stages + the localization term.
    expect(row.localizeOffsetMs).toBe((106 - 103) * 1000);
    expect(deliveredStageSum(row)).toBe(row.deliveredLatencyMs);
    // The delivered instant IS the ack: total = ackAtB - (origin + 103 s).
    expect(row.deliveredLatencyMs).toBe(ackAtB - (ORIGIN + 103_000));
  });

  it("keeps a deferred (post-accept) ack measurable with its own window", () => {
    const tracker = new LiveDeliveryTracker();
    const firedAtMs = ORIGIN + 40_000 + 200;
    const settledAtMs = firedAtMs + 900;
    const acceptStartMs = settledAtMs + 5;
    tracker.noteWindow({
      centerTs: 40,
      lagMs: 200,
      firedAtMs,
      settledAtMs,
      acceptStartMs,
      acceptDoneMs: null,
    });
    // No ack during accept: the row is only reported later (the deferred
    // re-attestation path), 3 s after the accept returned.
    const acceptDoneMs = acceptStartMs + 70;
    tracker.noteAcceptDone(40, acceptDoneMs);
    expect(tracker.rows().length).toBe(0);
    tracker.notePersisted(40, acceptDoneMs + 3_000, "hl-attested");
    const row = tracker.rows()[0];
    expect(row.acceptMs).toBe(70);
    expect(row.persistAckMs).toBe(3_000);
    expect(deliveredStageSum(row)).toBe(row.deliveredLatencyMs);
  });
});
