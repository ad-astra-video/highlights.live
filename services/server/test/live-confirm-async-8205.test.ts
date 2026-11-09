// ADAAAA-8205: the LIVE async confirm lane.
//
// The ticket's failure it pins:
//  - the accept path used to AWAIT the Stage-2 dive (p50 ~15.7 s), and a failed
//    dive rewrote the provisional row to `near_miss`, deleting the
//    "GOAL (UNCONFIRMED)" badge (AC-A1 / AC-A7);
//  - the dive was unmetered (AC-A4);
//  - nothing bounded the dive count per stream (AC-A4) or dropped on a busy pool
//    instead of queueing (AC-A6).
//
// The tests below are the no-GPU proof: due-dive planning, the sliding budget,
// adoption on the SAME row (promote / refute / passthrough), and the accept-seam
// regression that the row publishes untouched with a persisted descriptor while
// no confirm call is made on the accept path.
import { describe, expect, it, vi } from "vitest";
import {
  ConfirmDiveBudget,
  LIVE_CONFIRM_MAX_DIVES_PER_300S,
  buildPersistedConfirmContext,
  confirmDiveAdoption,
  confirmDiveKey,
  planDueConfirmDives,
  runConfirmDive,
  runDueConfirmDives,
  type PendingConfirmDive,
} from "../src/live-confirm-async.js";
import { LiveRunShared, acceptVideoDecision, type AnalyzerConfig, type CandidateSignal, type DecisionResult } from "../src/analyzer.js";
import { Store } from "../src/store.js";

function entry(over: Partial<PendingConfirmDive> = {}): PendingConfirmDive {
  return {
    highlightId: "hl-1",
    jobId: "job-8205",
    goalEventTs: 100,
    window: { lo: 90, hi: 100 },
    stage1: { eventType: "GOAL", outcome: "scoring_play", reason: "A striker finishes low." },
    analysis: { transcript: "It's a goal!", audioLevels: [0.1, 0.9, 0.3] },
    signals: { ballOutcome: "goal" },
    queuedAt: 100,
    ...over,
  };
}

function persistedFrames(n: number, from = 88, step = 1) {
  return Array.from({ length: n }, (_, i) => ({ seq: i, ts: from + i * step, base64: `img-${i}` }));
}

describe("planDueConfirmDives — post-window, one per distinct goal", () => {
  it("is NOT due until the judged window's lookahead has closed", () => {
    const pending = [entry()];
    expect(planDueConfirmDives(pending, { nowTs: 110 })).toHaveLength(0); // hi=100, +20 s
    expect(planDueConfirmDives(pending, { nowTs: 119.9 })).toHaveLength(0);
    expect(planDueConfirmDives(pending, { nowTs: 120 })).toHaveLength(1);
  });

  it("selects ONE dive per distinct goal inside the reuse window", () => {
    const pending = [
      entry({ highlightId: "a", goalEventTs: 100 }),
      entry({ highlightId: "b", goalEventTs: 104 }), // same goal, overlapping window
      entry({ highlightId: "c", goalEventTs: 160 }), // a genuinely distinct goal
    ];
    const due = planDueConfirmDives(pending, { nowTs: 300, reuseWindowS: 12 });
    expect(due.map((d) => d.highlightId)).toEqual(["a", "c"]);
  });

  it("skips a goal whose dive was already attempted", () => {
    const pending = [entry({ highlightId: "a" })];
    const attempted = new Set([confirmDiveKey(pending[0])]);
    expect(planDueConfirmDives(pending, { nowTs: 300, attempted })).toHaveLength(0);
  });

  it("ignores malformed windows instead of diving them", () => {
    const pending = [entry({ highlightId: "bad", window: { lo: 100, hi: 90 } })];
    expect(planDueConfirmDives(pending, { nowTs: 300 })).toHaveLength(0);
  });
});

describe("ConfirmDiveBudget — <= 8 dives per 300 s per stream", () => {
  it("allows the default eight goal-slice dives and refuses the ninth, counting the refusal", () => {
    const b = new ConfirmDiveBudget();
    for (let i = 0; i < LIVE_CONFIRM_MAX_DIVES_PER_300S; i++) {
      // ADAAAA-8513 (AC3): a provisional-goal row spends the reserved slice
      // (`min(3, cap)`) and may use the whole cap.
      expect(b.allow(100 + i, LIVE_CONFIRM_MAX_DIVES_PER_300S, true)).toBe(true);
    }
    expect(b.allow(110, LIVE_CONFIRM_MAX_DIVES_PER_300S, true)).toBe(false);
    expect(b.refusalsCount()).toBe(1);
    expect(b.count(110)).toBe(LIVE_CONFIRM_MAX_DIVES_PER_300S);
  });

  it("ADAAAA-8513 (AC3): the reserved slice is never spent on a general dive", () => {
    const b = new ConfirmDiveBudget();
    // cap 8 -> 3 reserved, 5 general. Five general dives fit, the sixth does not
    // even though the window still has 3 tokens (they belong to the goal slice).
    for (let i = 0; i < 5; i++) expect(b.allow(100 + i, 8, false)).toBe(true);
    expect(b.allow(106, 8, false)).toBe(false);
    // ...but a provisional-goal dive can still spend those 3 tokens.
    expect(b.allow(107, 8, true)).toBe(true);
    expect(b.allow(108, 8, true)).toBe(true);
    expect(b.allow(109, 8, true)).toBe(true);
    expect(b.allow(110, 8, true)).toBe(false);
    expect(b.snapshot(110, 8)).toMatchObject({ cap: 8, reserved: 3, spentReserved: 3, spentGeneral: 5, retries: 0 });
  });

  it("slides: a dive 300 s later is allowed again", () => {
    const b = new ConfirmDiveBudget();
    for (let i = 0; i < LIVE_CONFIRM_MAX_DIVES_PER_300S; i++) b.allow(0 + i, LIVE_CONFIRM_MAX_DIVES_PER_300S, true);
    expect(b.allow(299, LIVE_CONFIRM_MAX_DIVES_PER_300S, true)).toBe(false);
    expect(b.allow(300.5, LIVE_CONFIRM_MAX_DIVES_PER_300S, true)).toBe(true);
  });

  it("counts the configured max, not a hard-coded one", () => {
    const b = new ConfirmDiveBudget();
    expect(b.allow(10, 1, true)).toBe(true);
    expect(b.allow(11, 1, true)).toBe(false);
  });
});

describe("buildPersistedConfirmContext — persisted artifacts only, no fabrication", () => {
  it("stamps every signal a persisted JPEG cannot reconstruct and sends it EMPTY", () => {
    const ctx = buildPersistedConfirmContext({ frames: persistedFrames(20), eventTs: 100 });
    expect(ctx.frames.length).toBeGreaterThan(0);
    expect(ctx.frames.length).toBeLessThanOrEqual(12);
    expect(ctx.keyframes.length).toBe(3);
    // Motion, optical flow and the audio clip cannot be rebuilt from disk.
    expect(ctx.trajectories).toEqual([]);
    expect(ctx.opticalFlowMagnitude).toBe(0);
    expect(ctx.flowMagnitudes).toEqual([]);
    expect(ctx.audioB64).toBe("");
    expect(ctx.contextDegraded).toEqual(
      expect.arrayContaining(["motion_trajectories", "optical_flow", "audio_clip", "audio_levels"])
    );
  });

  it("reuses the stage-1 audio level series instead of inventing one", () => {
    const ctx = buildPersistedConfirmContext({
      frames: persistedFrames(10),
      eventTs: 100,
      analysis: { transcript: "It's a goal!", audioLevels: [0.2, 0.8] },
    });
    expect(ctx.audioLevels).toEqual([0.2, 0.8]);
    expect(ctx.contextDegraded).not.toContain("audio_levels");
  });

  it("sends only frames that actually loaded (a missing file is absent evidence)", () => {
    const frames = persistedFrames(6).filter((f) => f.seq % 2 === 0);
    const ctx = buildPersistedConfirmContext({ frames, eventTs: 91 });
    expect(ctx.frames.length).toBeGreaterThan(0);
    expect(ctx.frames.every((f) => /^img-/.test(f.base64))).toBe(true);
  });
});

describe("confirmDiveAdoption — the verdict moves the SAME row", () => {
  const meta = { diveAt: "2026-11-06T15:00:00.000Z", diveLatencyMs: 1234, contextDegraded: ["motion_trajectories" as const] };

  it("promotes a corroborated confirmed_goal into the scoring lane and clears the marker", () => {
    const a = confirmDiveAdoption(
      { outcome: "big_play", eventType: "BIG_PLAY", provisionalGoal: { status: "provisional" } },
      { goalConfirmed: "confirmed_goal", corroborated: true, corroborationSource: "scoreboard" },
      meta
    );
    expect(a.kind).toBe("promoted");
    expect(a.patch).toMatchObject({
      outcome: "scoring_play",
      eventType: "GOAL",
      provisionalGoal: undefined,
      pendingConfirmDive: undefined,
      confirmAttestation: {
        goalConfirmed: "confirmed_goal",
        corroborated: true,
        corroborationSource: "scoreboard",
        diveLatencyMs: 1234,
        contextDegraded: ["motion_trajectories"],
      },
    });
    // Never an insert: the patch carries no id/jobId/new row identity.
    expect(a.patch.id).toBeUndefined();
    expect(a.patch.jobId).toBeUndefined();
  });

  it("refutes near_miss/not_goal but KEEPS the provisional badge and the clip (AC-A7)", () => {
    const provisional = { status: "provisional", cues: ["asr_goal_call"], declaredTs: 100, note: "provisional goal" };
    const a = confirmDiveAdoption(
      { outcome: "big_play", eventType: "BIG_PLAY", provisionalGoal: provisional },
      { goalConfirmed: "near_miss", corroborated: false },
      meta
    );
    expect(a.kind).toBe("refuted");
    expect(a.patch.outcome).toBeUndefined(); // no near_miss rewrite
    expect(a.patch.eventType).toBeUndefined();
    expect(a.patch.provisionalGoal).toMatchObject({ status: "provisional", refuted: true });
    expect((a.patch.provisionalGoal as any).note).toMatch(/did not confirm/i);
    expect(a.patch.confirmAttestation).toMatchObject({ goalConfirmed: "near_miss", corroborated: false });
  });

  it("refutes a confirmed_goal that never corroborated it (no uncorroborated promotion)", () => {
    const a = confirmDiveAdoption(
      { outcome: "big_play", provisionalGoal: { status: "provisional" } },
      { goalConfirmed: "confirmed_goal", corroborated: false },
      meta
    );
    expect(a.kind).toBe("refuted");
    expect(a.patch.outcome).toBeUndefined();
  });

  // ADAAAA-8223 B2: an attempt that resolves nothing must still leave a marker,
  // otherwise a cleared descriptor reads exactly like a never-armed one.
  it("stamps the passthrough attestation instead of clearing the descriptor silently (B2)", () => {
    const passthrough = confirmDiveAdoption({ outcome: "big_play" }, undefined, meta);
    expect(passthrough.kind).toBe("unchanged");
    expect(passthrough.patch).toMatchObject({
      pendingConfirmDive: undefined,
      confirmAttestation: {
        goalConfirmed: "passthrough",
        corroborated: false,
        corroborationSource: null,
        diveLatencyMs: 1234,
        contextDegraded: ["motion_trajectories"],
      },
    });
    // Clip-facing fields untouched (AC-A6 "row unchanged" = outcome/eventType/clip/provisionalGoal).
    expect(passthrough.patch.outcome).toBeUndefined();
    expect(passthrough.patch.eventType).toBeUndefined();
    expect(passthrough.patch.provisionalGoal).toBeUndefined();
  });

  it("stamps the attempt on the already-scoring guard arm without rewriting it (B2)", () => {
    const resolved = confirmDiveAdoption(
      { outcome: "scoring_play", eventType: "GOAL" },
      { goalConfirmed: "not_goal", corroborated: false },
      meta
    );
    expect(resolved.kind).toBe("unchanged");
    expect(resolved.patch.outcome).toBeUndefined();
    expect(resolved.patch.eventType).toBeUndefined();
    expect(resolved.patch.provisionalGoal).toBeUndefined();
    expect((resolved.patch.confirmAttestation as any).goalConfirmed).toBe("not_goal");
  });

  // ADAAAA-8223 B3: never manufacture a provisional marker just to refute it.
  it("does not refute a row that never carried a provisional marker (B3)", () => {
    const a = confirmDiveAdoption(
      { outcome: "big_play", eventType: "BIG_PLAY" },
      { goalConfirmed: "near_miss", corroborated: false },
      meta
    );
    expect(a.kind).toBe("unchanged");
    expect(a.reason).toMatch(/no provisional marker/i);
    expect(a.patch.provisionalGoal).toBeUndefined();
    expect(a.patch.outcome).toBeUndefined();
    // The attempt itself stays observable.
    expect((a.patch.confirmAttestation as any).goalConfirmed).toBe("near_miss");
  });

  it("does not refute a provisional marker that is no longer in the provisional state (B3)", () => {
    const a = confirmDiveAdoption(
      { outcome: "big_play", provisionalGoal: { status: "confirmed", cues: ["asr_goal_call"] } },
      { goalConfirmed: "not_goal", corroborated: false },
      meta
    );
    expect(a.kind).toBe("unchanged");
    expect(a.patch.provisionalGoal).toBeUndefined();
  });
});

describe("runConfirmDive — fail closed on every failure mode", () => {
  const io = (over: Partial<Parameters<typeof runConfirmDive>[1]> = {}) => ({
    framesInSpan: () => persistedFrames(10, 88).map((f) => ({ seq: f.seq, ts: f.ts })),
    loadFrame: async (seq: number) => `img-${seq}`,
    confirm: async () => ({ goalConfirmed: "confirmed_goal" as const, corroborated: true, corroborationSource: "scoreboard" as const }),
    gameHint: "soccer",
    ...over,
  });

  it("runs on persisted frames and returns the verdict", async () => {
    const r = await runConfirmDive(entry(), io());
    expect(r.ok).toBe(true);
    expect(r.verdict?.goalConfirmed).toBe("confirmed_goal");
    expect(r.framesSent).toBeGreaterThan(0);
    expect(r.context.contextDegraded).toContain("motion_trajectories");
  });

  it("drops when no frame survived on disk", async () => {
    const r = await runConfirmDive(entry(), io({ loadFrame: async () => null }));
    expect(r.ok).toBe(false);
    expect(r.droppedReason).toBe("no_persisted_frames");
  });

  it("drops a timeout without throwing", async () => {
    const r = await runConfirmDive(
      entry(),
      io({ confirm: () => new Promise(() => {}), timeoutMs: 5 }),
      { jobId: "job-8205", log: () => {} }
    );
    expect(r.ok).toBe(false);
    expect(r.droppedReason).toBe("timeout");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("drops a transport failure without throwing", async () => {
    const r = await runConfirmDive(
      entry(),
      io({ confirm: async () => { throw new Error("ECONNRESET"); } }),
      { jobId: "job-8205", log: () => {} }
    );
    expect(r.ok).toBe(false);
    expect(r.droppedReason).toBe("transport_failure");
  });

  it("drops a passthrough (no structured verdict) and never credits it", async () => {
    const r = await runConfirmDive(entry(), io({ confirm: async () => ({ goalConfirmed: null }) }));
    expect(r.ok).toBe(false);
    expect(r.droppedReason).toBe("passthrough");
  });
});

describe("runDueConfirmDives — budget, busy pool, adoption", () => {
  function runState(pending: PendingConfirmDive[]) {
    const state = {
      attempted: new Set<string>(),
      dropped: [] as string[],
      calls: 0,
      done: 0,
      entries: [...pending],
      confirmBudget: new ConfirmDiveBudget(),
      pendingConfirmDives() { return this.entries; },
      confirmDiveAttempted() { return this.attempted; },
      noteConfirmDiveAttempt(k: string) { this.attempted.add(k); },
      dropPendingConfirmDive(k: string) { this.entries = this.entries.filter((e) => confirmDiveKey(e) !== k); },
      noteConfirmDiveDropped(r: string) { this.dropped.push(r); },
      noteConfirmDiveDone() { this.done++; this.calls++; },
      confirmDiveCalls() { return this.calls; },
      confirmDiveCount() { return this.done; },
      confirmDiveDropped() { return this.dropped.length; },
    };
    return state;
  }
  const io = {
    // Any span the dive asks for is served from the persisted inventory, so a
    // second distinct goal really gets its frames (and its dive).
    framesInSpan: (lo: number, hi: number) => {
      const out: { seq: number; ts: number }[] = [];
      for (let t = Math.ceil(lo); t <= hi; t++) out.push({ seq: t, ts: t });
      return out;
    },
    loadFrame: async (seq: number) => `img-${seq}`,
    confirm: async () => ({ goalConfirmed: "confirmed_goal" as const, corroborated: true }),
    gameHint: "soccer",
  };

  it("drops when the decide pool is busy and never makes the confirm call", async () => {
    const confirm = vi.fn(async () => ({ goalConfirmed: "confirmed_goal" as const, corroborated: true }));
    const state = runState([entry()]);
    const out = await runDueConfirmDives({
      run: state as any,
      io: { ...io, confirm },
      nowTs: 200,
      jobId: "job-8205",
      busy: () => "inflight=2",
      adopt: () => "promoted",
      log: () => {},
    });
    expect(out.dropped).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    expect(state.dropped[0]).toMatch(/pool_busy/);
  });

  it("ADAAAA-8513 (AC1): a budget refusal stays PENDING and runs once the window slides", async () => {
    const confirm = vi.fn(async () => ({ goalConfirmed: "confirmed_goal" as const, corroborated: true }));
    const dropped: string[] = [];
    const state = runState(
      Array.from({ length: 9 }, (_, i) =>
        entry({
          highlightId: `hl-${i}`,
          goalEventTs: 20 + i * 20,
          window: { lo: 10 + i * 20, hi: 20 + i * 20 },
          evidence: { provisional: true, scoreMeasured: true },
        })
      )
    );
    const originalDrop = state.dropPendingConfirmDive.bind(state);
    state.dropPendingConfirmDive = (k: string) => {
      dropped.push(k);
      originalDrop(k);
    };
    const adopt = vi.fn(async () => "promoted" as const);
    const run = async (nowTs: number) =>
      runDueConfirmDives({
        run: state as any,
        io: { ...io, confirm },
        nowTs,
        jobId: "job-8205",
        maxDivesPer300s: 8,
        adopt,
        log: () => {},
      });

    // Tick 1: 8 tokens spent, the 9th (highest goalEventTs, ranked last inside
    // its tier) is REFUSED — it must stay pending and must not be stamped.
    const first = await run(400);
    expect(first.dives).toBe(8);
    expect(first.dropped).toBe(0);
    expect(first.retries).toBe(1);
    expect(state.pendingConfirmDives()).toHaveLength(1);
    expect(state.pendingConfirmDives()[0].highlightId).toBe("hl-8");
    // No adoption for the still-pending descriptor: its row is NOT dropped.
    expect(adopt).toHaveBeenCalledTimes(8);
    expect(dropped).not.toContain(confirmDiveKey(state.pendingConfirmDives()[0]));

    // Tick 2: the 300 s window has slid, so the retry runs and is spent.
    const second = await run(701);
    expect(second.dives).toBe(1);
    expect(second.dropped).toBe(0);
    expect(state.pendingConfirmDives()).toHaveLength(0);
    expect(confirm).toHaveBeenCalledTimes(9);
  });

  it("promotes and refutes on the same row, and counts them", async () => {
    const kinds = ["promoted", "refuted"];
    const state = runState([entry({ highlightId: "a", goalEventTs: 100 }), entry({ highlightId: "b", goalEventTs: 200 })]);
    const out = await runDueConfirmDives({
      run: state as any,
      io,
      nowTs: 500,
      jobId: "job-8205",
      adopt: () => kinds.shift() as any,
      log: () => {},
    });
    expect(out).toMatchObject({ dives: 2, dropped: 0, promoted: 1, refuted: 1 });
    expect(state.pendingConfirmDives()).toHaveLength(0);
  });
});

// --- the accept-seam regression (AC-A1 + AC-A7) -----------------------------

const PROVISIONAL_REASON = "the players celebrate with arms raised";

function liveCfg(over: Partial<AnalyzerConfig> = {}): AnalyzerConfig {
  return {
    jobId: "job-8205-accept",
    gameHint: "soccer",
    clipBeforeS: 6,
    clipAfterS: 9,
    clipWindowMinSec: 15,
    preferLabels: [],
    confirmEnabled: true,
    confirmReuseWindowS: 12,
    liveObserveLoop: true,
    ...over,
  } as AnalyzerConfig;
}

function goalRead(reason = PROVISIONAL_REASON): DecisionResult {
  return { isHighlight: true, score: 84, outcome: "scoring_play", eventType: "GOAL", reason } as DecisionResult;
}

function motionCandidate(ts: number): CandidateSignal {
  return { eventType: "SPORTING_EVENT", timestamp: ts } as CandidateSignal;
}

async function acceptOnce(cfg: AnalyzerConfig, client: any, run: LiveRunShared, ts = 100) {
  const cut = async (t: number) => ({ clipId: `c-${t}`, clipUri: `file://c-${t}.mp4` });
  await acceptVideoDecision(
    client,
    run,
    cut,
    cfg,
    () => {},
    { seq: 1, timestamp: ts },
    motionCandidate(ts),
    goalRead(),
    undefined,
    ts, // goalEventTs
    undefined,
    { lo: ts - 10, hi: ts }
  );
}

describe("acceptVideoDecision — async lane keeps the accept path free of the dive", () => {
  it("does NOT call confirm on the accept path, persists the descriptor, keeps the provisional row", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    const confirm = vi.fn(async () => ({ goalConfirmed: "confirmed_goal" as const, corroborated: true }));
    const client = { decide: async () => ({}), confirm } as any;
    const seen: PendingConfirmDive[] = [];
    await acceptOnce(liveCfg({ liveConfirmAsync: true, onConfirmDivePending: (d) => seen.push(d) }), client, run);

    // AC-A1: no confirm call was awaited on the accept path.
    expect(confirm).not.toHaveBeenCalled();
    // AC-A7: the row ships as a celebration with the provisional marker intact.
    expect(run.highlights).toHaveLength(1);
    const row: any = run.highlights[0];
    expect(row.outcome).toBe("big_play");
    expect(row.provisionalGoal?.status).toBe("provisional");
    // The descriptor is persisted WITH the row and handed off once.
    expect(row.pendingConfirmDive).toMatchObject({ goalEventTs: 100, window: { lo: 90, hi: 100 } });
    expect(seen).toHaveLength(1);
    expect(seen[0].highlightId).toBe(row.id);
    expect(seen[0].analysis.transcript).toBeUndefined(); // no ASR persisted -> absent, never invented
    expect(run.pendingConfirmDives()).toHaveLength(1);
  });

  it("unarmed (LIVE_CONFIRM_ASYNC=0) still awaits the dive and demotes on failure", async () => {
    const run = new LiveRunShared({ audioRetainS: 400 });
    const confirm = vi.fn(async () => {
      throw new Error("confirm transport down");
    });
    const client = { decide: async () => ({}), confirm } as any;
    await acceptOnce(liveCfg({ liveConfirmAsync: false }), client, run);
    expect(confirm).toHaveBeenCalledTimes(1);
    // The shipped sync behaviour: a failed dive rewrites the row to near_miss
    // BEFORE persist, so the provisional badge never reaches the board.
    expect(run.highlights).toHaveLength(0);
  });
});

describe("Store — the verdict move never inserts a second row (AC-A2)", () => {
  it("promotes the existing row in place and leaves the job's row count unchanged", async () => {
    const store = new Store();
    const job = await store.createJob({ source: "file", sourceUrl: "/tmp/live.mp4", gameHint: "soccer" });
    await store.addHighlight({
      id: "h-prov",
      jobId: job.id,
      clipUri: "/clips/h-prov.mp4",
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
        note: "provisional goal: asr_goal_call in the judged window, no measured scoreboard change yet",
      },
      createdAt: new Date().toISOString(),
    } as any);
    const before = store.highlightsForJob(job.id).length;

    const adoption = confirmDiveAdoption(
      store.getHighlight("h-prov") as any,
      { goalConfirmed: "confirmed_goal", corroborated: true, corroborationSource: "scoreboard" },
      { diveAt: new Date().toISOString(), diveLatencyMs: 900, contextDegraded: ["motion_trajectories"] }
    );
    const moved = await store.attestDeferredGoal("h-prov", adoption.patch as any);
    expect(moved.id).toBe("h-prov");
    expect(moved.outcome).toBe("scoring_play");
    expect(moved.eventType).toBe("GOAL");
    expect(moved.provisionalGoal).toBeUndefined();
    expect(moved.confirmAttestation?.corroborated).toBe(true);
    expect(moved.pendingConfirmDive).toBeUndefined();
    expect(store.highlightsForJob(job.id).length).toBe(before);
  });

  it("refutation keeps the row, its clip and the provisional status", async () => {
    const store = new Store();
    const job = await store.createJob({ source: "file", sourceUrl: "/tmp/live.mp4", gameHint: "soccer" });
    await store.addHighlight({
      id: "h-ref",
      jobId: job.id,
      clipUri: "/clips/h-ref.mp4",
      start: 85,
      end: 105,
      status: "accepted",
      score: 84,
      outcome: "big_play",
      eventType: "BIG_PLAY",
      provisionalGoal: { status: "provisional", cues: ["asr_goal_call"], declaredTs: 100, note: "provisional goal" },
      createdAt: new Date().toISOString(),
    } as any);
    const adoption = confirmDiveAdoption(
      store.getHighlight("h-ref") as any,
      { goalConfirmed: "not_goal", corroborated: false },
      { diveAt: new Date().toISOString(), diveLatencyMs: 700, contextDegraded: [] }
    );
    const moved = await store.attestDeferredGoal("h-ref", adoption.patch as any);
    expect(moved.clipUri).toBe("/clips/h-ref.mp4");
    expect(moved.outcome).toBe("big_play");
    expect(moved.provisionalGoal?.status).toBe("provisional");
    expect(moved.provisionalGoal?.refuted).toBe(true);
    expect(moved.confirmAttestation?.goalConfirmed).toBe("not_goal");
  });
});
