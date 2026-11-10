// ADAAAA-8513 — evidence-first confirm-dive admission (parent ADAAAA-8512,
// origin lane ADAAAA-8205, grading sibling ADAAAA-8506).
//
// ADAAAA-8518 SUPERSEDED the admission half of this ticket: the per-300 s budget
// cap and the reserved goal slice are gone (CEO directive on ADAAAA-8512), and
// the per-stream one-in-flight serialization is gone too. What this file keeps
// pinning is the part that still ships:
//   AC2 due dives rank EVIDENCE first (measured score > goal-line > audio-only);
//   AC3 the published admission block survives buildLiveObserveMetrics and the
//       stored job record (contract + SQLite);
//   AC4 drops are counted per CAUSE and the pending ring's eviction is a stamped
//       `descriptor_overflow`, never a silent shift();
//   AC5 the stream-end drain leaves NO descriptor pending.
// The AC1/AC3 cap+reserved proofs moved to `live-confirm-admission-8518.test.ts`
// (unlimited default, capacity-only queueing, observed dive cost).
import { describe, expect, it, vi } from "vitest";
import {
  CONFIRM_DROP_REASONS,
  ConfirmDiveBudget,
  ConfirmDiveDispatcher,
  LIVE_CONFIRM_LOOKAHEAD_S,
  LIVE_CONFIRM_PENDING_RING,
  confirmDiveAdoption,
  confirmDiveEvidenceTier,
  confirmDiveKey,
  droppedDiveResult,
  planDueConfirmDives,
  runDueConfirmDives,
  type ConfirmDiveResult,
  type PendingConfirmDive,
} from "../src/live-confirm-async.js";
import { LiveRunShared, buildLiveObserveMetrics } from "../src/analyzer.js";
import { LiveObserver } from "../src/observe-loop.js";
import { SqliteDb } from "../src/db.js";
import { Store } from "../src/store.js";

function entry(over: Partial<PendingConfirmDive> = {}): PendingConfirmDive {
  return {
    highlightId: "hl-1",
    jobId: "job-8513",
    goalEventTs: 100,
    window: { lo: 90, hi: 100 },
    stage1: { eventType: "GOAL", outcome: "big_play", reason: "the players celebrate" },
    analysis: {},
    signals: {},
    queuedAt: 100,
    ...over,
  };
}

/** Deterministic IO: every span has persisted frames, the call always answers. */
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

function observer(): LiveObserver {
  return new LiveObserver({ cadenceS: 3, windowS: 10, fps: 2, onDecide: async () => false });
}

describe("AC1 — the dive brake is INERT by default (ADAAAA-8518 supersedes the cap)", () => {
  it("dives every due descriptor at the shipped default, with no budget refusal", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    for (let i = 0; i < 12; i++) {
      run.notePendingConfirmDive(
        entry({
          highlightId: `hl-${i}`,
          goalEventTs: 40 + i * 10,
          window: { lo: 30 + i * 10, hi: 40 + i * 10 },
          evidence: { provisional: true, scoreMeasured: true },
        })
      );
    }
    const confirm = vi.fn(async () => ({ goalConfirmed: "confirmed_goal" as const, corroborated: true }));
    const out = await runDueConfirmDives({
      run,
      io: io({ confirm }),
      nowTs: 500,
      jobId: "job-8513",
      // No explicit brake: `undefined`/`null` must resolve to UNLIMITED.
      maxDivesPer300s: null,
      adopt: async () => "promoted" as const,
      log: () => {},
    });
    expect(out.dives).toBe(12);
    expect(out.retries).toBe(0);
    expect(out.dropped).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(12);
    expect(run.confirmDroppedByReason().budget).toBe(0);
    expect(run.confirmBudget.refusalsCount()).toBe(0);
    expect(new ConfirmDiveBudget().refusalsCount()).toBe(0);
  });

  it("an explicit positive brake stays PENDING while live and stamps `budget` at stream end", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    for (let i = 0; i < 3; i++) {
      run.notePendingConfirmDive(
        entry({
          highlightId: `b-${i}`,
          goalEventTs: 40 + i * 10,
          window: { lo: 30 + i * 10, hi: 40 + i * 10 },
          evidence: { provisional: true },
        })
      );
    }
    const live = await runDueConfirmDives({
      run,
      io: io(),
      nowTs: 100,
      jobId: "job-8513",
      maxDivesPer300s: 1,
      adopt: async () => "promoted" as const,
      log: () => {},
    });
    expect(live.dives).toBe(1);
    expect(live.retries).toBe(2);
    expect(live.dropped).toBe(0);
    expect(run.pendingConfirmDives()).toHaveLength(2);

    const reasons: Array<string | undefined> = [];
    await runDueConfirmDives({
      run,
      io: io(),
      nowTs: 200,
      jobId: "job-8513",
      maxDivesPer300s: 1,
      drain: true,
      adopt: async (_e, result) => {
        reasons.push(result.droppedReason);
        return "unchanged" as const;
      },
      log: () => {},
    });
    expect(run.pendingConfirmDives()).toHaveLength(0);
    expect(reasons).toContain("budget");
  });
});

describe("AC2 — evidence-first ordering", () => {
  it("ranks measured score > goal-line > audio-only, then goalEventTs", () => {
    const measured = entry({ highlightId: "measured", goalEventTs: 400, evidence: { scoreMeasured: true } });
    const postSamples = entry({ highlightId: "samples", goalEventTs: 390, evidence: { postSamples: 2, need: 2 } });
    const goalLine = entry({ highlightId: "line", goalEventTs: 200, signals: { goalCrossed: true } });
    const ball = entry({ highlightId: "ball", goalEventTs: 210, signals: { ballOutcome: "goal" } });
    const audio = entry({ highlightId: "audio", goalEventTs: 100, evidence: { audioBurst: true } });
    const order = planDueConfirmDives([audio, ball, goalLine, postSamples, measured], { nowTs: 900 }).map(
      (d) => d.highlightId
    );
    // tier 2 (measured, then ts asc) -> tier 1 (goal-line, ts asc) -> tier 0
    expect(order).toEqual(["samples", "measured", "line", "ball", "audio"]);
    expect(confirmDiveEvidenceTier(measured)).toBe(2);
    expect(confirmDiveEvidenceTier(goalLine)).toBe(1);
    expect(confirmDiveEvidenceTier(audio)).toBe(0);
  });

  it("takes the free decide slot for the ranked-top window, not the oldest", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    // Nine due windows. The first eight (oldest) are audio-only noise; the ninth
    // is the LATEST and the only measured score transition.
    for (let i = 0; i < 8; i++) {
      run.notePendingConfirmDive(
        entry({
          highlightId: `noise-${i}`,
          goalEventTs: 60 + i * 30,
          window: { lo: 50 + i * 30, hi: 60 + i * 30 },
          evidence: { provisional: true, audioBurst: true },
        })
      );
    }
    run.notePendingConfirmDive(
      entry({
        highlightId: "real-goal",
        goalEventTs: 360,
        window: { lo: 350, hi: 360 },
        evidence: { provisional: true, scoreMeasured: true },
      })
    );
    const dived: string[] = [];
    const dispatcher = new ConfirmDiveDispatcher(() => 1);
    const out = await runDueConfirmDives({
      run,
      io: io({
        confirm: async (req: any) => {
          dived.push(`ts-${req.timestamp}`);
          return { goalConfirmed: "confirmed_goal" as const, corroborated: true };
        },
      }),
      nowTs: 1000,
      jobId: "job-8513",
      dispatcher,
      adopt: async () => "promoted" as const,
      log: () => {},
    });
    // One slot: it went to the measured goal at 360 s, not to the oldest noise.
    expect(out.dives).toBe(1);
    expect(dived).toEqual(["ts-360"]);
    // The remaining eight stay pending and are NOT stamped dropped while live.
    expect(run.pendingConfirmDives()).toHaveLength(8);
    expect(run.confirmDiveDropped()).toBe(0);
  });
});

describe("AC3 — the published admission block (capacity, not a cap)", () => {
  it("publishes dispatched / queued / maxInFlight / capacity / dives and survives the job record", async () => {
    const run = new LiveRunShared({ audioRetainS: 400, decideFeeUsd: 0.025 });
    run.notePendingConfirmDive(entry({ highlightId: "p1", goalEventTs: 40, window: { lo: 30, hi: 40 }, evidence: { provisional: true } }));
    run.notePendingConfirmDive(entry({ highlightId: "g1", goalEventTs: 50, window: { lo: 40, hi: 50 } }));
    const dispatcher = new ConfirmDiveDispatcher(() => 2);
    await runDueConfirmDives({
      run,
      io: io({ confirm: async () => ({ goalConfirmed: "not_goal" as const, corroborated: false }) }),
      nowTs: 100,
      jobId: "job-8513",
      dispatcher,
      adopt: async () => "refuted" as const,
      log: () => {},
    });
    const snap = run.confirmDiveAdmission();
    expect(snap).toMatchObject({
      dispatched: 2,
      queued: 0,
      maxInFlight: 2,
      capacityEffective: 2,
      divesBilled: 2,
      diveCostUsd: 0.05,
    });
    // No cap/reserved/spent fields: the cap is gone with the budget.
    expect(snap).not.toHaveProperty("cap");
    expect(snap).not.toHaveProperty("reserved");

    const metrics = buildLiveObserveMetrics(observer(), undefined, {
      calls: run.confirmDiveCalls(),
      dives: run.confirmDiveCount(),
      dropped: run.confirmDiveDropped(),
      byReason: run.confirmDroppedByReason(),
      admission: run.confirmDiveAdmission(),
    });
    expect(metrics.diveAdmission).toMatchObject({ dispatched: 2, capacityEffective: 2, divesBilled: 2 });
    expect(metrics.diveAdmission).not.toHaveProperty("cap");
    expect(metrics).not.toHaveProperty("diveBudget");

    const db = new SqliteDb(":memory:");
    const store = new Store(db);
    const job = await store.createJob({ ownerId: "u1", source: "rtmp", sourceUrl: "rtmp://test/stream" });
    await store.patchJob(job.id, {
      status: "done",
      observeMetrics: { ...metrics, decideCalls: 66 },
    });
    const stored = await db.getJob(job.id);
    // `JobSchema.parse` must not strip the admission block (the ADAAAA-8219 trap).
    expect(stored!.observeMetrics!.diveAdmission).toEqual(metrics.diveAdmission);
    expect(stored!.observeMetrics!.confirmDroppedByReason!.pool_busy).toBe(0);
    for (const cause of ["budget", "timeout", "transport_failure", "passthrough", "no_persisted_frames"]) {
      expect(stored!.observeMetrics!.confirmDroppedByReason).toHaveProperty(cause, 0);
    }
    await db.close();
  });
});

describe("AC4 — drops counted per cause, ring eviction stamped", () => {
  it("keeps every cause distinct on the run record", () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    run.noteConfirmDiveDropped("pool_busy:inflight=2");
    run.noteConfirmDiveDropped("budget");
    run.noteConfirmDiveDropped("timeout");
    run.noteConfirmDiveDropped("transport_failure");
    run.noteConfirmDiveDropped("passthrough");
    run.noteConfirmDiveDropped("no_persisted_frames");
    run.noteConfirmDiveDropped("frame_unreadable");
    const byReason = run.confirmDroppedByReason();
    expect(byReason).toMatchObject({
      pool_busy: 1,
      budget: 1,
      timeout: 1,
      transport_failure: 1,
      passthrough: 1,
      no_persisted_frames: 1,
      frame_unreadable: 1,
    });
    // The AC cause list is always present, even at zero.
    for (const cause of CONFIRM_DROP_REASONS) expect(byReason).toHaveProperty(cause, expect.any(Number));
    expect(run.confirmDiveDropped()).toBe(7);
  });

  it("stamps a ring eviction as descriptor_overflow instead of shift()-ing it away", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    for (let i = 0; i < LIVE_CONFIRM_PENDING_RING + 1; i++) {
      run.notePendingConfirmDive(
        entry({ highlightId: `ov-${i}`, goalEventTs: 100 + i, window: { lo: 90 + i, hi: 100 + i }, evidence: { provisional: true } })
      );
    }
    // The ring is a memory bound (`LIVE_CONFIRM_PENDING_RING`), not a dive cap;
    // the overflow list holds the evicted descriptor and the drop is already
    // counted at eviction time.
    expect(run.pendingConfirmDives()).toHaveLength(LIVE_CONFIRM_PENDING_RING);
    expect(run.confirmDiveDropped()).toBe(1);
    expect(run.confirmDroppedByReason().descriptor_overflow).toBe(1);

    const results = new Map<string, string | undefined>();
    const out = await runDueConfirmDives({
      run,
      io: io(),
      nowTs: 500,
      jobId: "job-8513",
      dispatcher: ConfirmDiveDispatcher.unbounded(),
      adopt: async (e, result) => {
        results.set(e.highlightId, result.droppedReason);
        return "unchanged" as const;
      },
      log: () => {},
    });
    expect(out.overflowDropped).toBe(1);
    expect(results.get("ov-0")).toBe("descriptor_overflow");
    expect(droppedDiveResult("descriptor_overflow").droppedReason).toBe("descriptor_overflow");
  });
});

describe("AC5 — end-of-stream drain leaves no descriptor pending", () => {
  it("stamps what the pool could not take, so no row stays unreadable", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    for (let i = 0; i < 3; i++) {
      run.notePendingConfirmDive(
        entry({ highlightId: `end-${i}`, goalEventTs: 30 + i * 10, window: { lo: 20 + i * 10, hi: 30 + i * 10 }, evidence: { provisional: true } })
      );
    }
    const results: Array<{ id: string; reason?: string }> = [];
    // A dispatcher whose single slot is already held: at stream end nothing can
    // be admitted, so every descriptor must be stamped terminal `pool_busy`.
    const dispatcher = new ConfirmDiveDispatcher(() => 1);
    expect(dispatcher.tryAdmit()).toBe(true);
    const out = await runDueConfirmDives({
      run,
      io: io(),
      nowTs: 50 + LIVE_CONFIRM_LOOKAHEAD_S,
      jobId: "job-8513",
      dispatcher,
      drain: true,
      adopt: async (e, result) => {
        results.push({ id: e.highlightId, reason: result.droppedReason });
        return "unchanged" as const;
      },
      log: () => {},
    });
    dispatcher.release();
    expect(out.dives).toBe(0);
    expect(out.dropped).toBe(3);
    expect(run.pendingConfirmDives()).toHaveLength(0);
    expect(results.filter((r) => r.reason === "pool_busy")).toHaveLength(3);
    expect(run.confirmDroppedByReason().pool_busy).toBe(3);
  });

  it("stamps a malformed descriptor instead of leaving it provisional forever", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    run.notePendingConfirmDive(
      entry({ highlightId: "bad", goalEventTs: 100, window: { lo: 120, hi: 100 }, evidence: { provisional: true } })
    );
    const adopted: string[] = [];
    await runDueConfirmDives({
      run,
      io: io(),
      nowTs: 200,
      jobId: "job-8513",
      drain: true,
      adopt: async (_e, result) => {
        adopted.push(result.droppedReason ?? "none");
        return "unchanged" as const;
      },
      log: () => {},
    });
    expect(adopted).toEqual(["descriptor_invalid"]);
    expect(run.pendingConfirmDives()).toHaveLength(0);
    expect(run.confirmDroppedByReason().descriptor_invalid).toBe(1);
  });

  it("the drain verdict writer settles the row in place (no new row, attestation stamped)", async () => {
    const store = new Store();
    const job = await store.createJob({ source: "file", sourceUrl: "/tmp/live.mp4", gameHint: "soccer" });
    await store.addHighlight(provisionalRow("h-drain", job.id) as any);
    const before = store.highlightsForJob(job.id).length;
    const adoption = confirmDiveAdoption(store.getHighlight("h-drain") as any, undefined, {
      diveAt: new Date().toISOString(),
      diveLatencyMs: 0,
      contextDegraded: [],
      droppedReason: "pool_busy",
    });
    await store.attestDeferredGoal("h-drain", adoption.patch as any);
    const after = store.getHighlight("h-drain") as any;
    expect(store.highlightsForJob(job.id).length).toBe(before);
    expect(after.confirmAttestation).toMatchObject({ goalConfirmed: "dropped", dropReason: "pool_busy" });
    expect(after.pendingConfirmDive).toBeUndefined();
    expect(after.outcome).toBe("big_play");
    expect(after.clipUri).toBe("/clips/h-drain.mp4");
  });
});
