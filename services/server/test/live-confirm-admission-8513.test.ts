// ADAAAA-8513 — evidence-first confirm-dive admission (parent ADAAAA-8512,
// origin lane ADAAAA-8205, grading sibling ADAAAA-8506).
//
// The CEO rule this pins: "if there is evidence of a goal then the deep dive
// should happen to confirm it and correctly get the clip." The lane as shipped
// violated it four ways; each AC below is a $0 unit proof, no leg / GPU / deploy:
//   AC1 a budget refusal is TRANSIENT (pending, retried, bounded) — never a
//       first-refusal terminal drop;
//   AC2 due dives rank EVIDENCE first (measured score > goal-line > audio-only),
//       so the last token goes to the strongest window, not the oldest;
//   AC3 `min(3, cap)` tokens are reserved for provisional-goal rows and the
//       admission block is published on `observeMetrics.diveBudget`;
//   AC4 drops are counted per CAUSE and the pending ring's eviction is a stamped
//       `descriptor_overflow`, never a silent shift();
//   AC5 the stream-end drain leaves NO descriptor pending — a finished job
//       cannot keep a `provisional` row with no verdict field.
import { describe, expect, it, vi } from "vitest";
import {
  CONFIRM_DROP_REASONS,
  ConfirmDiveBudget,
  LIVE_CONFIRM_BUDGET_ATTEMPTS,
  LIVE_CONFIRM_LOOKAHEAD_S,
  LIVE_CONFIRM_MAX_DIVES_PER_300S,
  LIVE_CONFIRM_RESERVED_DIVES,
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

describe("AC1 — a budget refusal retries, bounded, and never stamps a pending row", () => {
  it("leaves the descriptor pending, then dives it once the window slides", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    const dropped = vi.fn();
    const realDrop = run.dropPendingConfirmDive.bind(run);
    (run as any).dropPendingConfirmDive = (key: string) => {
      dropped(key);
      realDrop(key);
    };
    for (let i = 0; i < LIVE_CONFIRM_MAX_DIVES_PER_300S + 1; i++) {
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
    const adopt = vi.fn(async () => "promoted" as const);

    const first = await runDueConfirmDives({
      run,
      io: io({ confirm }),
      nowTs: 500,
      jobId: "job-8513",
      maxDivesPer300s: LIVE_CONFIRM_MAX_DIVES_PER_300S,
      adopt,
      log: () => {},
    });
    expect(first.dives).toBe(LIVE_CONFIRM_MAX_DIVES_PER_300S);
    expect(first.dropped).toBe(0);
    expect(first.retries).toBe(1);
    expect(run.pendingConfirmDives()).toHaveLength(1);
    // The refused descriptor is still pending and was NOT handed to the row
    // writer (no `dropped` verdict), while the eight settled ones were.
    expect(dropped).not.toHaveBeenCalledWith(confirmDiveKey(run.pendingConfirmDives()[0]));
    expect(adopt).toHaveBeenCalledTimes(LIVE_CONFIRM_MAX_DIVES_PER_300S);

    const second = await runDueConfirmDives({
      run,
      io: io({ confirm }),
      nowTs: 500 + 301,
      jobId: "job-8513",
      maxDivesPer300s: LIVE_CONFIRM_MAX_DIVES_PER_300S,
      adopt,
      log: () => {},
    });
    expect(second.dives).toBe(1);
    expect(second.retries).toBe(0);
    expect(run.pendingConfirmDives()).toHaveLength(0);
    expect(confirm).toHaveBeenCalledTimes(LIVE_CONFIRM_MAX_DIVES_PER_300S + 1);
  });

  it("abandons the retry after LIVE_CONFIRM_BUDGET_ATTEMPTS refusals, with a stamped budget drop", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    run.notePendingConfirmDive(entry({ evidence: { provisional: true } }));
    const results: ConfirmDiveResult[] = [];
    // cap 0: every tick refuses, so the descriptor burns its retry bound.
    for (let i = 0; i < LIVE_CONFIRM_BUDGET_ATTEMPTS; i++) {
      const out = await runDueConfirmDives({
        run,
        io: io(),
        nowTs: 130,
        jobId: "job-8513",
        maxDivesPer300s: 0,
        adopt: async (_e, result) => {
          results.push(result);
          return "unchanged" as const;
        },
        log: () => {},
      });
      if (i < LIVE_CONFIRM_BUDGET_ATTEMPTS - 1) {
        expect(out.dropped).toBe(0);
        expect(run.pendingConfirmDives()).toHaveLength(1);
        expect(results).toHaveLength(0);
      } else {
        expect(out.dropped).toBe(1);
        expect(run.pendingConfirmDives()).toHaveLength(0);
        expect(results.map((r) => r.droppedReason)).toEqual(["budget"]);
      }
    }
    expect(run.confirmDiveDropped()).toBe(1);
    expect(run.confirmDroppedByReason().budget).toBe(1);
    expect(run.confirmBudget.retriesCount()).toBe(LIVE_CONFIRM_BUDGET_ATTEMPTS);
  });

  it("a busy pool stays TERMINAL (only budget is transient)", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    run.notePendingConfirmDive(entry({ evidence: { provisional: true } }));
    const out = await runDueConfirmDives({
      run,
      io: io(),
      nowTs: 130,
      jobId: "job-8513",
      busy: () => "inflight=3",
      adopt: async () => "unchanged" as const,
      log: () => {},
    });
    expect(out.dropped).toBe(1);
    expect(run.pendingConfirmDives()).toHaveLength(0);
    expect(run.confirmDroppedByReason().pool_busy).toBe(1);
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

  it("the last budget token goes to the ranked-top window, not the oldest", async () => {
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
      maxDivesPer300s: 1,
      adopt: async () => "promoted" as const,
      log: () => {},
    });
    // One token: it went to the measured goal at 360 s, not to the oldest noise.
    expect(out.dives).toBe(1);
    expect(dived).toEqual(["ts-360"]);
    // The remaining eight stay pending (AC1), they are not stamped dropped.
    expect(run.pendingConfirmDives()).toHaveLength(8);
    expect(run.confirmDiveDropped()).toBe(0);
  });
});

describe("AC3 — the reserved goal slice and the published admission block", () => {
  it("publishes cap / reserved / spentReserved / spentGeneral / retries", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    run.notePendingConfirmDive(entry({ highlightId: "p1", goalEventTs: 40, window: { lo: 30, hi: 40 }, evidence: { provisional: true } }));
    run.notePendingConfirmDive(entry({ highlightId: "g1", goalEventTs: 50, window: { lo: 40, hi: 50 } }));
    await runDueConfirmDives({
      run,
      io: io(),
      nowTs: 100,
      jobId: "job-8513",
      maxDivesPer300s: 8,
      adopt: async () => "promoted" as const,
      log: () => {},
    });
    const snap = run.confirmDiveBudget();
    expect(snap.cap).toBe(8);
    expect(snap.reserved).toBe(Math.min(LIVE_CONFIRM_RESERVED_DIVES, 8));
    expect(snap.spentReserved).toBe(1);
    expect(snap.spentGeneral).toBe(1);
    expect(snap.retries).toBe(0);
    expect(ConfirmDiveBudget.reservedTokens(3)).toBe(3);
    expect(ConfirmDiveBudget.reservedTokens(1)).toBe(1);
  });

  it("publishes the configured cap, not the compile-time default", () => {
    // ADAAAA-8513 verification defect: the pump admits against
    // cfg.liveConfirmMaxDivesPer300S, so the stored `diveBudget.cap` must be
    // that same number (an operator-composed 4 used to report cap: 8).
    const composed = new LiveRunShared({ audioRetainS: 400, liveConfirmMaxDivesPer300S: 4 });
    expect(composed.confirmDiveMaxPer300s()).toBe(4);
    expect(composed.confirmDiveBudget()).toMatchObject({ cap: 4, reserved: LIVE_CONFIRM_RESERVED_DIVES });
    // The default is still the shipped constant (AC7: unchanged at 8).
    expect(new LiveRunShared().confirmDiveBudget().cap).toBe(LIVE_CONFIRM_MAX_DIVES_PER_300S);
  });

  it("a general dive cannot spend the reserved slice", async () => {
    const b = new ConfirmDiveBudget();
    // cap 8 -> 5 general tokens; the provisional rows still get their 3.
    for (let i = 0; i < 5; i++) expect(b.allow(10 + i, 8, false)).toBe(true);
    expect(b.allow(16, 8, false)).toBe(false);
    for (let i = 0; i < LIVE_CONFIRM_RESERVED_DIVES; i++) expect(b.allow(17 + i, 8, true)).toBe(true);
    expect(b.allow(20, 8, true)).toBe(false);
    expect(b.snapshot(20, 8)).toMatchObject({ cap: 8, reserved: 3, spentReserved: 3, spentGeneral: 5 });
  });

  it("survives buildLiveObserveMetrics and the stored job record (contract + SQLite)", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    run.notePendingConfirmDive(entry({ evidence: { provisional: true, scoreMeasured: true } }));
    await runDueConfirmDives({
      run,
      io: io({ confirm: async () => ({ goalConfirmed: "not_goal" as const, corroborated: false }) }),
      nowTs: 130,
      jobId: "job-8513",
      adopt: async () => "refuted" as const,
      log: () => {},
    });
    run.noteConfirmDiveDropped("pool_busy:inflight=3");
    const metrics = buildLiveObserveMetrics(observer(), undefined, {
      calls: run.confirmDiveCalls(),
      dives: run.confirmDiveCount(),
      dropped: run.confirmDiveDropped(),
      byReason: run.confirmDroppedByReason(),
      budget: run.confirmDiveBudget(),
    });
    expect(metrics.diveBudget).toMatchObject({
      cap: LIVE_CONFIRM_MAX_DIVES_PER_300S,
      reserved: LIVE_CONFIRM_RESERVED_DIVES,
      spentReserved: 1,
      spentGeneral: 0,
      retries: 0,
    });
    expect(metrics.confirmDroppedByReason).toMatchObject({ pool_busy: 1 });

    const db = new SqliteDb(":memory:");
    const store = new Store(db);
    const job = await store.createJob({ ownerId: "u1", source: "rtmp", sourceUrl: "rtmp://test/stream" });
    await store.patchJob(job.id, {
      status: "done",
      observeMetrics: { ...metrics, decideCalls: 66 },
    });
    const stored = await db.getJob(job.id);
    // `JobSchema.parse` must not strip the two new fields (the ADAAAA-8219 trap).
    expect(stored!.observeMetrics!.diveBudget).toEqual(metrics.diveBudget);
    expect(stored!.observeMetrics!.confirmDroppedByReason!.pool_busy).toBe(1);
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
    // The six AC causes are always present, even at zero.
    for (const cause of CONFIRM_DROP_REASONS) expect(byReason).toHaveProperty(cause, expect.any(Number));
    expect(run.confirmDiveDropped()).toBe(7);
  });

  it("stamps a ring eviction as descriptor_overflow instead of shift()-ing it away", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    for (let i = 0; i < 17; i++) {
      run.notePendingConfirmDive(
        entry({ highlightId: `ov-${i}`, goalEventTs: 100 + i, window: { lo: 90 + i, hi: 100 + i }, evidence: { provisional: true } })
      );
    }
    // The ring is 16; the overflow list holds the evicted descriptor and the
    // drop is already counted at eviction time.
    expect(run.pendingConfirmDives()).toHaveLength(16);
    expect(run.confirmDiveDropped()).toBe(1);
    expect(run.confirmDroppedByReason().descriptor_overflow).toBe(1);

    const results = new Map<string, string | undefined>();
    const out = await runDueConfirmDives({
      run,
      io: io(),
      nowTs: 500,
      jobId: "job-8513",
      // No budget pressure here: every pending descriptor dives.
      maxDivesPer300s: 32,
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
  it("dives what the budget can afford and stamps what it cannot, so no row stays unreadable", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    // Three provisional descriptors still pending at stream end.
    for (let i = 0; i < 3; i++) {
      run.notePendingConfirmDive(
        entry({ highlightId: `end-${i}`, goalEventTs: 30 + i * 10, window: { lo: 20 + i * 10, hi: 30 + i * 10 }, evidence: { provisional: true } })
      );
    }
    // Burn the whole budget first so the drain can only afford one dive... then
    // set the cap to 1 to force the other two through the terminal budget path.
    const results: Array<{ id: string; reason?: string }> = [];
    const out = await runDueConfirmDives({
      run,
      io: io(),
      nowTs: 50 + LIVE_CONFIRM_LOOKAHEAD_S,
      jobId: "job-8513",
      maxDivesPer300s: 1,
      drain: true,
      adopt: async (e, result) => {
        results.push({ id: e.highlightId, reason: result.droppedReason });
        return "unchanged" as const;
      },
      log: () => {},
    });
    expect(out.dives).toBe(1);
    expect(out.dropped).toBe(2);
    expect(run.pendingConfirmDives()).toHaveLength(0);
    expect(results.filter((r) => r.reason === "budget")).toHaveLength(2);
    expect(run.confirmDroppedByReason().budget).toBe(2);
    // Every adoption carries a terminal reason, so the row gets a verdict field.
    expect(results.every((r) => r.reason === "budget" || r.reason === undefined)).toBe(true);
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
      droppedReason: "budget",
    });
    await store.attestDeferredGoal("h-drain", adoption.patch as any);
    const after = store.getHighlight("h-drain") as any;
    expect(store.highlightsForJob(job.id).length).toBe(before);
    expect(after.confirmAttestation).toMatchObject({ goalConfirmed: "dropped", dropReason: "budget" });
    expect(after.pendingConfirmDive).toBeUndefined();
    expect(after.outcome).toBe("big_play");
    expect(after.clipUri).toBe("/clips/h-drain.mp4");
  });
});
