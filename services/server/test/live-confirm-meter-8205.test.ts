// ADAAAA-8205 AC-A4 / AC-A6 (integrated): the async confirm lane's meter has to
// survive the WHOLE chain — pump -> LiveRunShared counters -> buildLiveObserve
// Metrics -> Store.patchJob -> the stored row — not just each layer alone.
//
// Why this test exists. QA leg B (job `0705e2b5`) proved the arithmetic of the
// meter in memory (`costUsd` residual == exactly 2 confirm calls) while the
// stored `observeMetrics` carried NO confirm key: `JobSchema.parse` stripped the
// three undeclared counters before `db.saveJob` (fixed additively by ADAAAA-8219,
// `7800a11`). The unit suites that landed with the fix covered the schema and the
// store separately. This one composes them, so a regression in either layer — or
// in the analyzer's counter plumbing — fails here instead of on a funded leg.
//
// It also pins the billing identity QA could only infer from a log line: a dive
// dropped BEFORE the model call (`no_persisted_frames`) is counted in
// `confirmDropped` but must NOT be billed as a confirm call.
import { describe, expect, it } from "vitest";
import {
  ConfirmDiveDispatcher,
  planDueConfirmDives,
  runDueConfirmDives,
  type ConfirmDiveIo,
  type PendingConfirmDive,
} from "../src/live-confirm-async.js";
import { LiveRunShared, buildLiveObserveMetrics } from "../src/analyzer.js";
import { LiveObserver } from "../src/observe-loop.js";
import { SqliteDb } from "../src/db.js";
import { Store } from "../src/store.js";

function entry(over: Partial<PendingConfirmDive> = {}): PendingConfirmDive {
  return {
    highlightId: "hl-meter",
    jobId: "job-meter",
    goalEventTs: 100,
    window: { lo: 90, hi: 100 },
    stage1: { eventType: "GOAL", outcome: "scoring_play", reason: "A striker finishes low." },
    analysis: {},
    signals: { ballOutcome: "goal" },
    queuedAt: 100,
    ...over,
  };
}

function provisionalRow(id: string, jobId: string): Record<string, unknown> {
  return {
    id,
    jobId,
    clipUri: `/clips/${id}.mp4`,
    start: 85,
    end: 105,
    status: "accepted",
    score: 84,
    outcome: "big_play",
    eventType: "BIG_PLAY",
    reason: "the players celebrate with arms raised | provisional goal: asr_goal_call",
    provisionalGoal: {
      status: "provisional",
      cues: ["asr_goal_call"],
      declaredTs: 100,
      note: "provisional goal: asr_goal_call in the judged window",
    },
    createdAt: new Date().toISOString(),
  };
}

/** IO where the goal at 100 s has NO persisted frames and the one at 160 s does. */
function io(over: Partial<ConfirmDiveIo> = {}): ConfirmDiveIo {
  return {
    framesInSpan: (lo, hi) => (hi <= 110 ? [] : [{ seq: 1, ts: 158 }, { seq: 2, ts: 159 }]),
    loadFrame: async () => "img-b64",
    confirm: async () => ({ goalConfirmed: "confirmed_goal", corroborated: true, corroborationSource: "scoreboard" }),
    gameHint: "soccer",
    leadS: 5,
    trailS: 4,
    ...over,
  } as ConfirmDiveIo;
}

function observer(): LiveObserver {
  return new LiveObserver({
    cadenceS: 3,
    windowS: 10,
    fps: 2,
    onDecide: async () => false,
  });
}

describe("ADAAAA-8205 meter — pump -> observeMetrics -> stored row (AC-A4/A6)", () => {
  it("a pre-flight drop + one real dive land on the row as 1 call / 1 dive / 2 dropped", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    // Three distinct goals, each due (window hi + 20 s lookahead long past).
    run.notePendingConfirmDive(entry({ highlightId: "hl-busy", goalEventTs: 40, window: { lo: 30, hi: 40 } }));
    run.notePendingConfirmDive(entry({ highlightId: "hl-no-frames", goalEventTs: 100, window: { lo: 90, hi: 100 } }));
    run.notePendingConfirmDive(entry({ highlightId: "hl-promoted", goalEventTs: 160, window: { lo: 150, hi: 160 } }));
    // ADAAAA-8518: capacity 1 makes the pump QUEUE the rest (they stay PENDING
    // and replan next tick), so three ticks drain the lane one dive each. Two of
    // the goals have no persisted frames, so they drop pre-flight without a call.
    const dispatcher = new ConfirmDiveDispatcher(() => 1);
    const pumpOnce = () =>
      runDueConfirmDives({
        run,
        io: io(),
        nowMs: 1_000,
        nowTs: 400,
        jobId: "job-meter",
        dispatcher,
        adopt: async () => "promoted" as const,
        log: () => {},
      });
    const out = await pumpOnce();
    expect(out).toMatchObject({ dives: 1, queued: 2, dropped: 1 });
    expect(run.pendingConfirmDives()).toHaveLength(2);
    // No live-stream drop: the other two wait for the next tick.
    expect(run.confirmDroppedByReason().pool_busy).toBe(0);
    await pumpOnce();
    await pumpOnce();
    expect(run.pendingConfirmDives()).toHaveLength(0);

    // The pre-flight drops never billed a call; the promoted dive did.
    expect(run.confirmDiveCalls()).toBe(1);
    expect(run.confirmDiveCount()).toBe(1);
    expect(run.confirmDiveDropped()).toBe(2);

    // Compose the meter the analyzer stamps at settle (analyzer.ts:9390).
    const metrics = buildLiveObserveMetrics(observer(), undefined, {
      calls: run.confirmDiveCalls(),
      dives: run.confirmDiveCount(),
      dropped: run.confirmDiveDropped(),
    });
    expect(metrics).toMatchObject({ confirmCalls: 1, confirmDiveCount: 1, confirmDropped: 2 });

    // ...and it has to survive the contract + the SQLite `record` column, which
    // is what QA's `record->'observeMetrics'` read returns.
    const db = new SqliteDb(":memory:");
    const store = new Store(db);
    const job = await store.createJob({ ownerId: "u1", source: "rtmp", sourceUrl: "rtmp://test/stream" });
    await store.patchJob(job.id, {
      status: "done",
      completedAt: new Date().toISOString(),
      // A live pass at Stage-1's 73 decides (QA leg B's measured count); the
      // confirm term is what the dive adds on top.
      observeMetrics: { ...metrics, decideCalls: 73 },
    });

    const stored = await db.getJob(job.id);
    const m = stored!.observeMetrics!;
    expect(m.confirmCalls).toBe(1);
    expect(m.confirmDiveCount).toBe(1);
    expect(m.confirmDropped).toBe(2);
    // AC-A4 rate: one call inside the 300 s window, well under the budget of 8.
    expect(m.confirmDiveCount!).toBeLessThanOrEqual(8);
    // AC-A4 cost identity, reconstructible from the stored row alone.
    expect(0.0033 * (m.decideCalls + m.confirmCalls!)).toBeCloseTo(0.2442, 10);
    await db.close();
  });

  it("one dive per distinct goal: a re-produced window inside the reuse window is not re-dived", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    run.notePendingConfirmDive(entry({ highlightId: "hl-a", goalEventTs: 100, window: { lo: 90, hi: 100 } }));
    run.notePendingConfirmDive(entry({ highlightId: "hl-b", goalEventTs: 104, window: { lo: 94, hi: 104 } })); // same goal
    expect(planDueConfirmDives(run.pendingConfirmDives(), { nowTs: 400, reuseWindowS: 12 })).toHaveLength(1);

    const out = await runDueConfirmDives({
      run,
      io: io({ framesInSpan: () => [{ seq: 1, ts: 100 }] }),
      nowTs: 400,
      jobId: "job-meter",
      // ADAAAA-8513: the shipped cap is a cost cell (3); this meter fixture
      // composes 8 so its general descriptors admit their dives.
      maxDivesPer300s: 8,
      reuseWindowS: 12,
      adopt: async () => "promoted" as const,
      log: () => {},
    });
    expect(out.dives).toBe(1);
    expect(run.confirmDiveCalls()).toBe(1);
  });

  it("refutation on a re-read row keeps the badge and does not bill quota or a second row", async () => {
    // AC-A7 + AC-A2 guard in the same composed path: the pump refutes, the row
    // keeps `provisional` status, the count of rows for the job is unchanged.
    const store = new Store();
    const job = await store.createJob({ source: "file", sourceUrl: "/tmp/live.mp4", gameHint: "soccer" });
    const row = provisionalRow("h-ref", job.id);
    await store.addHighlight(row as any);
    const before = store.highlightsForJob(job.id).length;

    const run = new LiveRunShared({ audioRetainS: 400 });
    run.notePendingConfirmDive(entry({ highlightId: "h-ref" }));
    const out = await runDueConfirmDives({
      run,
      io: io({
        framesInSpan: () => [{ seq: 1, ts: 100 }],
        confirm: async () => ({ goalConfirmed: "not_goal", corroborated: false }),
      }),
      nowTs: 400,
      jobId: job.id,
      maxDivesPer300s: 8,
      adopt: async (e, result) => {
        const { confirmDiveAdoption } = await import("../src/live-confirm-async.js");
        const adoption = confirmDiveAdoption(store.getHighlight(e.highlightId) as any, result.verdict, {
          diveAt: new Date().toISOString(),
          diveLatencyMs: result.latencyMs,
          contextDegraded: result.context.contextDegraded,
        });
        await store.attestDeferredGoal(e.highlightId, adoption.patch as any);
        return adoption.kind;
      },
      log: () => {},
    });

    expect(out).toMatchObject({ dives: 1, dropped: 0, promoted: 0, refuted: 1 });
    const after = store.getHighlight("h-ref") as any;
    expect(after.provisionalGoal?.status).toBe("provisional");
    expect(after.provisionalGoal?.refuted).toBe(true);
    expect(after.outcome).toBe("big_play");
    expect(store.highlightsForJob(job.id).length).toBe(before);
    expect(run.confirmDiveCalls()).toBe(1);
    expect(run.confirmDiveDropped()).toBe(0);
  });
});
