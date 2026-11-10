// ADAAAA-8518 — confirm-dive admission is CAPACITY ONLY (parent ADAAAA-8512,
// builds on ADAAAA-8513, grader of record ADAAAA-8506).
//
// CEO directive of record (ADAAAA-8512, 2026-11-09T22:14:38Z / 22:15:08Z):
// "Remove this cap for now. Tracking the cost of a stream is good enough for
// now." / "Also remove the 1 deep dive decide in flight cap. The only cap should
// be the total capacity available in decide runners."
//
// Every AC below is a $0 unit proof — no leg, no GPU, no deploy:
//   AC1 no rate cap: `LIVE_CONFIRM_MAX_DIVES_PER_300S` is UNLIMITED by default
//       (an absent/non-positive value never resolves to a capping number), so 20
//       due descriptors dispatch with zero budget refusals and zero `budget`
//       stamps;
//   AC2 no per-stream one-in-flight serialization: 3 due dives at capacity 3
//       hold 3 in flight for the SAME jobId;
//   AC3 capacity is the only gate and it QUEUES: capacity 1 with 3 due gives 1
//       dispatch + 2 pending (not dropped), capacity 2 gives 2 dispatches, and a
//       live stream never stamps `pool_busy`;
//   AC4 evidence-first ordering is retained (tier 2 takes the only slot);
//   AC5 cost replaces the cap and is published: `diveCostUsd == decideFee x
//       dives`, the `costUsd` identity holds, and `diveAdmission.divesBilled`
//       equals the billed confirm calls.
import { describe, expect, it, vi } from "vitest";
import {
  ConfirmDiveDispatcher,
  ConfirmDiveBudget,
  LIVE_CONFIRM_QUEUE_WAIT_MS,
  diveCapacityFromProbe,
  droppedDiveResult,
  normalizeConfirmDiveCap,
  runDueConfirmDives,
  type PendingConfirmDive,
} from "../src/live-confirm-async.js";
import { LiveRunShared, buildLiveObserveMetrics } from "../src/analyzer.js";
import { LiveObserver } from "../src/observe-loop.js";
import { loadConfig } from "../src/config.js";
import { withDiveCostReadout } from "../src/api.js";
import { PERCEIVE_PER_HOUR_USD, billableConfirmCalls, computeCostUsd } from "../src/job-settlement.js";

function entry(over: Partial<PendingConfirmDive> = {}): PendingConfirmDive {
  return {
    highlightId: "hl-1",
    jobId: "job-8518",
    goalEventTs: 100,
    window: { lo: 90, hi: 100 },
    stage1: { eventType: "GOAL", outcome: "big_play", reason: "the players celebrate" },
    analysis: {},
    signals: {},
    queuedAt: 100,
    ...over,
  };
}

/** `n` distinct goals inside a 300 s content window, all due at `nowTs`. */
function dueEntries(n: number, jobId = "job-8518"): PendingConfirmDive[] {
  return Array.from({ length: n }, (_, i) =>
    entry({
      jobId,
      highlightId: `hl-${i}`,
      goalEventTs: 10 + i * 10,
      window: { lo: 0 + i * 10, hi: 10 + i * 10 },
      evidence: { provisional: true, scoreMeasured: true },
    })
  );
}

function io(over: Record<string, unknown> = {}) {
  return {
    framesInSpan: (lo: number, hi: number) => {
      const out: { seq: number; ts: number }[] = [];
      for (let t = Math.ceil(lo); t <= hi; t++) out.push({ seq: t, ts: t });
      return out;
    },
    loadFrame: async (seq: number) => `img-${seq}`,
    confirm: async () => ({ goalConfirmed: "confirmed_goal" as const, corroborated: true }),
    gameHint: "soccer",
    ...over,
  } as any;
}

function observer(): LiveObserver {
  return new LiveObserver({ cadenceS: 3, windowS: 10, fps: 2, onDecide: async () => false });
}

describe("AC1 — no rate cap, unlimited by default", () => {
  it("resolves an absent / zero / negative value to UNLIMITED, and only a positive value to a cap", () => {
    expect(normalizeConfirmDiveCap(undefined)).toBeNull();
    expect(normalizeConfirmDiveCap(null)).toBeNull();
    expect(normalizeConfirmDiveCap("")).toBeNull();
    // `0` must NEVER mean "no dives".
    expect(normalizeConfirmDiveCap(0)).toBeNull();
    expect(normalizeConfirmDiveCap(-4)).toBeNull();
    expect(normalizeConfirmDiveCap("nonsense")).toBeNull();
    expect(normalizeConfirmDiveCap("3")).toBe(3);
    expect(normalizeConfirmDiveCap(7.9)).toBe(7);
    // The shipped config default is `null` (unlimited) and the whole lane's
    // silence: no brake constant resolves to a number.
    expect(loadConfig({}).liveConfirmMaxDivesPer300S).toBeNull();
    expect(loadConfig({ LIVE_CONFIRM_MAX_DIVES_PER_300S: "0" }).liveConfirmMaxDivesPer300S).toBeNull();
    expect(loadConfig({ LIVE_CONFIRM_MAX_DIVES_PER_300S: "3" }).liveConfirmMaxDivesPer300S).toBe(3);
  });

  it("dispatches 20 due descriptors in one 300 s window with 0 refusals and 0 budget stamps", async () => {
    const run = new LiveRunShared({ audioRetainS: 400, liveConfirmMaxDivesPer300S: loadConfig({}).liveConfirmMaxDivesPer300S });
    for (const e of dueEntries(20)) run.notePendingConfirmDive(e);
    const confirm = vi.fn(async () => ({ goalConfirmed: "confirmed_goal" as const, corroborated: true }));
    const out = await runDueConfirmDives({
      run,
      io: io({ confirm }),
      nowTs: 500,
      jobId: "job-8518",
      // The configured default (null = unlimited) — never a number that caps.
      maxDivesPer300s: loadConfig({}).liveConfirmMaxDivesPer300S,
      dispatcher: ConfirmDiveDispatcher.unbounded(),
      adopt: async () => "promoted" as const,
      log: () => {},
    });
    expect(out.dives).toBe(20);
    expect(out.retries).toBe(0);
    expect(out.dropped).toBe(0);
    expect(run.confirmBudget.refusalsCount()).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(20);
    // No stored row may ever carry a `budget` drop at the default.
    expect(run.confirmDroppedByReason().budget).toBe(0);
    expect(droppedDiveResult("budget").droppedReason).toBe("budget");
    // A brake object with no cap configured refuses nothing.
    const brake = new ConfirmDiveBudget();
    for (let i = 0; i < 20; i++) expect(brake.allow(10 + i, null)).toBe(true);
    expect(brake.refusalsCount()).toBe(0);
  });
});

describe("AC2 — no per-stream one-in-flight serialization", () => {
  it("holds 3 dives in flight for the SAME jobId at capacity 3", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    for (const e of dueEntries(3)) run.notePendingConfirmDive(e);
    let live = 0;
    let peak = 0;
    const dispatcher = new ConfirmDiveDispatcher(() => 3);
    const out = await runDueConfirmDives({
      run,
      io: io({
        confirm: async () => {
          live++;
          peak = Math.max(peak, live);
          // Hold the call open long enough that all three are admitted together.
          await new Promise((r) => setTimeout(r, 5));
          live--;
          return { goalConfirmed: "confirmed_goal" as const, corroborated: true };
        },
      }),
      nowTs: 500,
      jobId: "job-8518",
      dispatcher,
      adopt: async () => "promoted" as const,
      log: () => {},
    });
    expect(out.dives).toBe(3);
    expect(peak).toBe(3);
    expect(dispatcher.maxInFlight).toBe(3);
    expect(run.confirmDiveAdmission().maxInFlight).toBe(3);
    expect(dispatcher.inFlight).toBe(0);
  });
});

describe("AC3 — capacity is the only gate, and it QUEUES", () => {
  it("capacity 1 with 3 due: 1 dispatch, 2 pending, no drop while the stream is live", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    for (const e of dueEntries(3)) run.notePendingConfirmDive(e);
    const dispatcher = new ConfirmDiveDispatcher(() => 1);
    const out = await runDueConfirmDives({
      run,
      io: io(),
      nowMs: 1_000,
      nowTs: 500,
      jobId: "job-8518",
      dispatcher,
      adopt: async () => "promoted" as const,
      log: () => {},
    });
    expect(out.dives).toBe(1);
    expect(out.queued).toBe(2);
    expect(out.dropped).toBe(0);
    expect(run.pendingConfirmDives()).toHaveLength(2);
    // Never a `pool_busy` stamp while the stream is live.
    expect(run.confirmDroppedByReason().pool_busy).toBe(0);
    const adm = run.confirmDiveAdmission();
    expect(adm).toMatchObject({ dispatched: 1, queued: 2, maxInFlight: 1, capacityEffective: 1 });
  });

  it("capacity 2 with 3 due: 2 dispatches, 1 pending, no drop", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    for (const e of dueEntries(3)) run.notePendingConfirmDive(e);
    const out = await runDueConfirmDives({
      run,
      io: io(),
      nowMs: 1_000,
      nowTs: 500,
      jobId: "job-8518",
      dispatcher: new ConfirmDiveDispatcher(() => 2),
      adopt: async () => "promoted" as const,
      log: () => {},
    });
    expect(out.dives).toBe(2);
    expect(out.queued).toBe(1);
    expect(out.dropped).toBe(0);
    expect(run.pendingConfirmDives()).toHaveLength(1);
    expect(run.confirmDroppedByReason().pool_busy).toBe(0);
  });

  it("queues across streams: the shared dispatcher counts one total in-flight budget", async () => {
    const a = new LiveRunShared({ audioRetainS: 400, jobId: "stream-a" });
    const b = new LiveRunShared({ audioRetainS: 400, jobId: "stream-b" });
    for (const e of dueEntries(2, "stream-a")) a.notePendingConfirmDive(e);
    for (const e of dueEntries(2, "stream-b")) b.notePendingConfirmDive(e);
    const dispatcher = new ConfirmDiveDispatcher(() => 2);
    let live = 0;
    let peak = 0;
    const slowIo = io({
      confirm: async () => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 2));
        live--;
        return { goalConfirmed: "confirmed_goal" as const, corroborated: true };
      },
    });
    // Both streams admit in the same tick: the TOTAL in flight may never exceed 2.
    const [outA, outB] = await Promise.all([
      runDueConfirmDives({ run: a, io: slowIo, nowTs: 500, jobId: "stream-a", dispatcher, adopt: async () => "promoted" as const, log: () => {} }),
      runDueConfirmDives({ run: b, io: slowIo, nowTs: 500, jobId: "stream-b", dispatcher, adopt: async () => "promoted" as const, log: () => {} }),
    ]);
    expect(outA.dives + outB.dives).toBe(2);
    expect(outA.queued + outB.queued).toBe(2);
    expect(peak).toBe(2);
    expect(a.confirmDiveDropped()).toBe(0);
    expect(b.confirmDiveDropped()).toBe(0);
  });

  it("stamps pool_busy only after the explicit queue-wait bound", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    run.notePendingConfirmDive(entry({ highlightId: "waiting", evidence: { provisional: true } }));
    const dispatcher = new ConfirmDiveDispatcher(() => 1);
    // Occupy the only slot for the whole test.
    expect(dispatcher.tryAdmit()).toBe(true);
    const reasons: Array<string | undefined> = [];
    const adopt = async (_e: PendingConfirmDive, result: any) => {
      reasons.push(result.droppedReason);
      return "unchanged" as const;
    };
    // First sighting: stamps the wait, stays PENDING.
    const first = await runDueConfirmDives({ run, io: io(), nowMs: 1_000, nowTs: 200, jobId: "job-8518", dispatcher, queueWaitMs: 5_000, adopt, log: () => {} });
    expect(first.queued).toBe(1);
    expect(first.dropped).toBe(0);
    expect(run.pendingConfirmDives()).toHaveLength(1);
    // Inside the bound: still pending.
    const second = await runDueConfirmDives({ run, io: io(), nowMs: 1_000 + LIVE_CONFIRM_QUEUE_WAIT_MS - 1, nowTs: 200, jobId: "job-8518", dispatcher, adopt, log: () => {} });
    expect(second.dropped).toBe(0);
    // Past the explicit bound (time, not a dive count): stamped terminal.
    const third = await runDueConfirmDives({ run, io: io(), nowMs: 1_000 + LIVE_CONFIRM_QUEUE_WAIT_MS + 1, nowTs: 200, jobId: "job-8518", dispatcher, adopt, log: () => {} });
    dispatcher.release();
    expect(third.dropped).toBe(1);
    expect(reasons).toEqual(["pool_busy"]);
    expect(run.pendingConfirmDives()).toHaveLength(0);
    expect(run.confirmDroppedByReason().pool_busy).toBe(1);
  });

  it("resolves capacity from the signer probe, falling back only when it has no answer", () => {
    // A real advertisement wins, even a small one.
    expect(diveCapacityFromProbe({ effective: 3, source: "probe" }, 8)).toBe(3);
    expect(diveCapacityFromProbe({ effective: 2, source: "last-known" }, 8)).toBe(2);
    // No answer (nothing advertised / no snapshot) -> the configured width.
    expect(diveCapacityFromProbe({ effective: 8, source: "funded" }, 4)).toBe(4);
    expect(diveCapacityFromProbe(null, 5)).toBe(5);
    expect(diveCapacityFromProbe(undefined, undefined)).toBe(2);
  });
});

describe("AC4 — evidence-first ordering retained", () => {
  it("capacity 1 with tiers 0/2/1 queued: the tier 2 dive takes the slot", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    run.notePendingConfirmDive(
      entry({ highlightId: "audio", goalEventTs: 30, window: { lo: 20, hi: 30 }, evidence: { audioBurst: true } })
    );
    run.notePendingConfirmDive(
      entry({ highlightId: "line", goalEventTs: 40, window: { lo: 30, hi: 40 }, signals: { goalCrossed: true } })
    );
    run.notePendingConfirmDive(
      entry({ highlightId: "measured", goalEventTs: 50, window: { lo: 40, hi: 50 }, evidence: { scoreMeasured: true } })
    );
    const dived: string[] = [];
    const out = await runDueConfirmDives({
      run,
      io: io({
        confirm: async (req: any) => {
          dived.push(`ts-${req.timestamp}`);
          return { goalConfirmed: "confirmed_goal" as const, corroborated: true };
        },
      }),
      nowTs: 500,
      jobId: "job-8518",
      dispatcher: new ConfirmDiveDispatcher(() => 1),
      adopt: async () => "promoted" as const,
      log: () => {},
    });
    expect(out.dives).toBe(1);
    expect(dived).toEqual(["ts-50"]);
    expect(run.pendingConfirmDives().map((e) => e.highlightId).sort()).toEqual(["audio", "line"]);
  });
});

describe("AC5 — cost replaces the cap and is published", () => {
  it("10 dives issue calls -> diveCostUsd == 10 x decideFee, divesBilled == 10, costUsd identity holds", async () => {
    const decideFee = 0.025;
    const streamSeconds = 300;
    const decideCalls = 66;
    const run = new LiveRunShared({ audioRetainS: 400, decideFeeUsd: decideFee });
    for (const e of dueEntries(10)) run.notePendingConfirmDive(e);
    const confirm = vi.fn(async () => ({ goalConfirmed: "confirmed_goal" as const, corroborated: true }));
    const out = await runDueConfirmDives({
      run,
      io: io({ confirm }),
      nowTs: 500,
      jobId: "job-8518",
      dispatcher: ConfirmDiveDispatcher.unbounded(),
      adopt: async () => "promoted" as const,
      log: () => {},
    });
    expect(out.dives).toBe(10);
    expect(confirm).toHaveBeenCalledTimes(10);

    const metrics = buildLiveObserveMetrics(observer(), undefined, {
      calls: run.confirmDiveCalls(),
      dives: run.confirmDiveCount(),
      dropped: run.confirmDiveDropped(),
      byReason: run.confirmDroppedByReason(),
      admission: run.confirmDiveAdmission(),
    });
    expect(metrics.confirmCalls).toBe(10);
    expect(metrics.diveAdmission!.diveCostUsd).toBeCloseTo(10 * decideFee, 6);
    expect(metrics.diveAdmission!.divesBilled).toBe(10);
    expect(metrics.diveAdmission!.dispatched).toBe(10);

    // The stored readout (api.ts stamps the fee at settlement) carries the same
    // numbers, and `costUsd = decideFee x (decideCalls + dives) + perceive` holds.
    const stored = withDiveCostReadout({ ...metrics, decideCalls }, decideFee, streamSeconds);
    const billed = billableConfirmCalls(stored);
    expect(billed).toBe(10);
    expect(stored.diveAdmission!.divesBilled).toBe(10);
    expect(stored.diveAdmission!.diveCostUsd).toBeCloseTo(10 * decideFee, 6);
    const perceiveUsd = (streamSeconds / 3600) * PERCEIVE_PER_HOUR_USD;
    const costUsd = computeCostUsd(decideCalls, streamSeconds, decideFee, billed);
    // `computeCostUsd` is the ONE stored-cost source and it rounds to 4 dp
    // (`toFixed(4)`), so the identity is asserted at the precision it persists.
    expect(costUsd).toBeCloseTo(decideFee * (decideCalls + 10) + perceiveUsd, 4);
    // ...and the per-stream-hour readout prices that same measured cost.
    expect(stored.costPerStreamHour).toBeCloseTo(costUsd / (streamSeconds / 3600), 3);
    // No cap field and no `diveBudget` block survive anywhere.
    expect(metrics).not.toHaveProperty("diveBudget");
    expect(stored.diveAdmission).not.toHaveProperty("cap");
  });
});
