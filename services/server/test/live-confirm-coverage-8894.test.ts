// ADAAAA-8894 (D4) — the deep dive runs on EVERY promoted row, whatever it
// measured. D1 (ADAAAA-8796) removed the goal-shape skip; D4 removes the last
// class that still served a promoted card with no dive: a row that carries a
// MEASURED attestation ("the measured lane is its own corroboration and the dive
// would only re-bill it").
//
// Three things must be true together, and each is pinned below:
//
//   (1) TRIGGER + ADMISSION: a promoted row with a measured attestation enters
//       the dive lane on BOTH rails, and on the LIVE rail the pending descriptor
//       is actually published for a scoring-lane row — the `outcome !==
//       "scoring_play"` gate was the live arm of the same skip, and a trigger
//       that fires without a descriptor is still no dive.
//   (2) PRECISION GUARD (must not regress D1 AC1.4): on a measured row the dive
//       may add the moment and nothing else. It may not REFUTE the measurement,
//       may not move the served lane off `measured` (AC4.2: 0 lane diffs), and
//       may not withhold a GOAL the measurement itself licenses. The guard
//       therefore sits AFTER the promote arm: a row that measured its transition
//       still promotes in place (D1 AC1.4), and a row whose measurement the dive
//       cannot corroborate stays exactly as served. Both directions are pinned
//       here, because a guard placed before the promote arm turns every measured
//       row `unchanged` — the AC1.4 regression the clause forbids in reverse.
//       The guard is enforced at the two writers (the inline reconcile and
//       `confirmDiveAdoption`) and read at the two readers
//       (`confirmationForHighlightRow`, `hasRefutingDiveAttestation`) — every one
//       of them is asserted here, because a guard only at the writer still serves
//       a demoted card.
//   (3) COST (Ruling B): the extra population is bounded by ADMISSION, not by
//       shrinking coverage. `LIVE_CONFIRM_DENSITY_CAP_PER_STREAM_HOUR` = 48 caps
//       the live rail at 48 x $0.0033324 = $0.15996/stream-hour, and a withheld
//       dive is settled `density_cap` — a NAMED skip reason on the card, never a
//       silent drop.
import { describe, it, expect, vi } from "vitest";
import {
  ConfirmationSkipReasonSchema,
  DiveAdmissionSnapshotSchema,
  HighlightRecordSchema,
} from "@highlights/events";
import {
  acceptVideoDecision,
  confirmReconcile,
  LiveRunShared,
  shouldRunConfirm,
  type DecisionResult,
  type PipelineClient,
} from "../src/analyzer";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";
import {
  CONFIRM_DROP_REASONS,
  LIVE_CONFIRM_DENSITY_CAP_PER_STREAM_HOUR,
  confirmDiveAdoption,
  confirmDiveEvidenceTier,
  runDueConfirmDives,
  type DegradedSignal,
  type PendingConfirmDive,
} from "../src/live-confirm-async";
import { confirmationForHighlightRow } from "../src/confirmation-lane";
import { hasRefutingDiveAttestation } from "../src/highlight-postable";

/** A promoted, goal-shaped, MEASURED accept: the population D4 adds. */
const MEASURED_GOAL: DecisionResult = {
  isHighlight: true,
  score: 88,
  eventType: "GOAL",
  outcome: "scoring_play",
  reason: "scoreboard went 1-0 between the posts",
};

/** A measured candidate: the accept gate saw the scoreboard change itself. */
const MEASURED_CANDIDATE = {
  eventType: "GOAL",
  goalCrossed: true,
  scoreBoardChanged: true,
  ballOutcome: "goal",
  timestamp: 40,
};

function liveCfg(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    PERCEIVE_URL: "http://p",
    DECIDE_URL: "http://d",
    LIVE_OBSERVE_LOOP: "1",
    DECIDE_CONFIRM_ENABLED: "1",
    LIVE_CONFIRM_ASYNC: "1",
    ...env,
  });
  return buildLiveAnalyzerConfig({
    cfg,
    job: { id: "job-d4-live", gameHint: "soccer" },
    clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
  });
}

/** The VOD observe posture: the dive runs INLINE on the accept path. */
function vodCfg(): any {
  return {
    jobId: "job-d4-vod",
    clipBeforeS: 4,
    clipAfterS: 4,
    gameHint: "soccer",
    confirmEnabled: true,
    observeLoop: true,
    decideWindowN: 24,
    preferLabels: ["counter-attacks"],
  };
}

/** A dive that REFUTES the goal — the verdict that used to demote a row. */
const REFUTING = {
  enabled: true,
  goalConfirmed: "not_goal" as const,
  confidence: 0.8,
  reason: "no ball in the net",
  evidence: { ballInNet: false },
  stage1Disagreed: true,
  corroborated: false,
};

function makeClient(over: Partial<PipelineClient> = {}): PipelineClient {
  return {
    reservePerceive: async () => ({ sessionId: "sess-d4", appUrl: "", controlUrl: "" }),
    analyze: async (_sid: string, frame: any) => ({
      observation: { tracks: [], seq: frame?.seq ?? 0, timestamp: frame?.timestamp ?? 0 },
      candidate: { eventType: "GOAL", timestamp: frame?.timestamp ?? 0 },
    }),
    decide: async () => MEASURED_GOAL,
    plan: async () => ({
      planVersion: 1,
      category: "soccer",
      intent: "",
      source: "planner-fallback",
      maxTracks: 3,
      targets: [{ label: "player", role: "player" }],
      reason: "test",
    }),
    postAudio: async () => ({ candidate: null, series: [] }),
    controlForward: async () => null,
    train: async () => ({ run: "x", checkpoint: "/runs/x/model.safetensors" }),
    stopPerceive: async () => {},
    confirm: async () => REFUTING as any,
    ...over,
  } as PipelineClient;
}

describe("D4 trigger — a promoted MEASURED row is dived, on both rails", () => {
  it("fires on the live rail for every measured attestation shape", () => {
    const cfg = liveCfg();
    for (const candidate of [
      { eventType: "GOAL", goalCrossed: true },
      { eventType: "GOAL", ballOutcome: "goal" },
      { eventType: "GOAL", scoreBoardChanged: true },
    ]) {
      expect(shouldRunConfirm(cfg, candidate, MEASURED_GOAL)).toBe(true);
    }
  });

  it("fires on the VOD rail for the same shapes — the rails must not diverge", () => {
    const cfg = vodCfg();
    for (const candidate of [
      { eventType: "GOAL", goalCrossed: true },
      { eventType: "GOAL", ballOutcome: "goal" },
      { eventType: "GOAL", scoreBoardChanged: true },
    ]) {
      expect(shouldRunConfirm(cfg, candidate, MEASURED_GOAL)).toBe(true);
    }
  });

  it("still dives a measured but NON-accepted goal-shaped read (the recall rescue)", () => {
    // ADAAAA-7357's delayed-corroboration rescue is untouched: the trigger is
    // coverage over promoted rows AND that rescue, never a measurement test.
    const cfg = vodCfg();
    const coarseGoalMiss: DecisionResult = {
      isHighlight: false,
      score: 0,
      eventType: "GOAL",
      outcome: "not_highlight",
    };
    expect(shouldRunConfirm(cfg, { eventType: "GOAL", scoreBoardChanged: true }, coarseGoalMiss)).toBe(true);
  });

  it("stays a strict no-op when the lane is off", () => {
    expect(shouldRunConfirm({ confirmEnabled: false } as any, MEASURED_CANDIDATE, MEASURED_GOAL)).toBe(false);
  });

  it("publishes the pending descriptor for a SCORING-lane row (the live arm of the skip)", async () => {
    // The trigger firing is not enough: before D4 the descriptor was gated on
    // `decision.outcome !== "scoring_play"`, so a measured GOAL accept served
    // its card with no descriptor and therefore no dive moment.
    const run = new LiveRunShared();
    const cfg = liveCfg();
    const events: any[] = [];
    await acceptVideoDecision(
      makeClient(),
      run,
      async (ts: number) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      cfg,
      (ev) => events.push(ev),
      { seq: 1, timestamp: 40 },
      MEASURED_CANDIDATE as any,
      MEASURED_GOAL,
      undefined,
      40,
      undefined,
      { lo: 30, hi: 40 }
    );
    const row = events.find((e) => e.type === "highlight")?.highlight;
    expect(row).toBeTruthy();
    expect(row.outcome).toBe("scoring_play");
    expect(row.pendingConfirmDive).toBeTruthy();
    // The descriptor is admitted at the evidence tier a measurement earns, so
    // the added population is not starved behind audio-only celebrations.
    expect(confirmDiveEvidenceTier(row.pendingConfirmDive)).toBe(2);
    // ...and it is on the run's pending ring, where admission reads it.
    expect(run.confirmDivePendingCount()).toBe(1);
  });
});

describe("D4 precision guard — a measured row cannot be refuted or re-laned (AC4.2)", () => {
  it("VOD: a refuting dive leaves the measured accept and discloses the flag", async () => {
    const out = await confirmReconcile(makeClient(), new LiveRunShared(), vodCfg(), MEASURED_GOAL, {
      ...MEASURED_CANDIDATE,
    } as any);
    expect(out.confirmRan).toBe(true);
    // The dive ran and its verdict is recorded...
    expect(out.confirmAttestation).toMatchObject({
      goalConfirmed: "not_goal",
      laneKeptByMeasurement: true,
    });
    // ...but the measurement still owns the accept.
    expect(out.decision.outcome).toBe("scoring_play");
    expect(out.decision.isHighlight).toBe(true);
  });

  it("VOD: a CONFIRMING dive does not move the lane to `dive` either", async () => {
    const out = await confirmReconcile(
      makeClient({
        confirm: async () => ({
          enabled: true,
          goalConfirmed: "confirmed_goal",
          confidence: 0.9,
          reason: "ball in net",
          evidence: { ballInNet: true },
          stage1Disagreed: false,
          corroborated: true,
          corroborationSource: "frame_attestation",
          decision: MEASURED_GOAL,
        }),
      }),
      new LiveRunShared(),
      vodCfg(),
      MEASURED_GOAL,
      { ...MEASURED_CANDIDATE } as any
    );
    expect(out.decision.outcome).toBe("scoring_play");
    expect(out.confirmAttestation).toMatchObject({ laneKeptByMeasurement: true, goalConfirmed: "confirmed_goal" });
    // The served card derives the MEASURED lane, not `dive`.
    const card = confirmationForHighlightRow(
      { status: "accepted", trigger: { eventType: "GOAL", kind: "goal_line", timestamp: 40, goalCrossed: true }, confirmAttestation: out.confirmAttestation as any },
      { status: "accepted", trigger: MEASURED_CANDIDATE as any, analysis: MEASURED_GOAL.analysis } as any,
      { confirmEnabled: true }
    );
    expect(card?.lane).toBe("measured");
    expect(card?.skipReason).toBeUndefined();
  });

  it("VOD: the reuse cache cannot move a measured window's lane either", async () => {
    // One dive per distinct goal: a re-produced window reuses the FIRST verdict.
    // That verdict may have been written for a window that measured NOTHING (a
    // celebration that corroborated first), so the flag must be stamped on the
    // reuse answer or the measured window would serve a lane it never measured.
    const shared = new LiveRunShared();
    const cfg = { ...vodCfg(), confirmReuseWindowS: 30 };
    const confirming = async () => ({
      enabled: true,
      goalConfirmed: "confirmed_goal" as const,
      confidence: 0.9,
      reason: "ball in net",
      evidence: { ballInNet: true },
      stage1Disagreed: false,
      corroborated: true,
      corroborationSource: "frame_attestation" as const,
      decision: MEASURED_GOAL,
    });
    // A promoted, goal-shaped, NON-measured read at the same goal instant.
    const first = await confirmReconcile(makeClient({ confirm: confirming }), shared, cfg, MEASURED_GOAL, {
      eventType: "GOAL",
      timestamp: 40,
    } as any, 40);
    expect(first.confirmRan).toBe(true);
    expect(first.confirmAttestation?.laneKeptByMeasurement).toBeUndefined();
    const confirmSpy = vi.fn(confirming);
    const second = await confirmReconcile(
      makeClient({ confirm: confirmSpy }),
      shared,
      cfg,
      MEASURED_GOAL,
      { ...MEASURED_CANDIDATE, timestamp: 41 } as any,
      40.5
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(second.confirmAttestation?.laneKeptByMeasurement).toBe(true);
    expect(second.decision.outcome).toBe("scoring_play");
  });

  it("live writer: a trigger-only measured row is never refuted, and the 8239 bar still withholds its GOAL", () => {
    const measuredRow = {
      id: "hl-d4",
      jobId: "job-d4-live",
      clipUri: "/clips/hl-d4.mp4",
      start: 30,
      end: 45,
      status: "accepted",
      score: 88,
      outcome: "big_play",
      eventType: "GOAL",
      reason: "scoreboard went 1-0",
      trigger: { timestamp: 40, scoreBoardChanged: true },
      createdAt: "2026-11-13T00:00:00.000Z",
    };
    const meta = { diveAt: "2026-11-13T00:00:10.000Z", diveLatencyMs: 800, contextDegraded: [] as DegradedSignal[] };

    const refute = confirmDiveAdoption(measuredRow as any, REFUTING as any, meta);
    expect(refute.kind).toBe("unchanged");
    expect((refute.patch as any).outcome).toBeUndefined();
    expect((refute.patch as any).provisionalGoal).toBeUndefined();
    expect((refute.patch as any).confirmAttestation.laneKeptByMeasurement).toBe(true);

    // A corroborated promotion attempt is refused too: "nothing about a measured
    // row changes except the moment" includes not promoting a demoted row.
    const promote = confirmDiveAdoption(
      measuredRow as any,
      {
        goalConfirmed: "confirmed_goal",
        corroborated: true,
        corroborationSource: "frame_attestation",
        stage1Disagreed: false,
        momentTs: 41.2,
        momentConfidence: 0.7,
      } as any,
      { ...meta, frameRefs: [{ seq: 41, ts: 41 }, { seq: 42, ts: 42 }] }
    );
    expect(promote.kind).toBe("unchanged");
    expect((promote.patch as any).outcome).toBeUndefined();
    expect((promote.patch as any).confirmAttestation.laneKeptByMeasurement).toBe(true);
    // ...while the MOMENT it named is still recorded — the one thing it may add.
    expect((promote.patch as any).confirmAttestation.momentTs).toBe(41.2);
  });

  it("live writer: a row that MEASURED its transition still promotes in place, lane `measured` before and after", () => {
    // D1 AC1.4 and AC4.2 together. The measurement — not the dive — is what
    // licenses the GOAL here, so the guard must NOT withhold it: same row,
    // `promoted`, and the served lane is `measured` on both sides of the move.
    // (A guard placed before the promote arm returned `unchanged` for this row,
    // which broke AC1.4; the promote arm must stay upstream of the guard.)
    const promotingRow = {
      id: "hl-d4-promote",
      jobId: "job-d4-live",
      clipUri: "/clips/hl-d4-promote.mp4",
      start: 30,
      end: 45,
      status: "accepted",
      score: 88,
      outcome: "big_play",
      eventType: "BIG_PLAY",
      reason: "the players celebrate with arms raised | provisional goal: asr_goal_call",
      provisionalGoal: { status: "provisional", cues: ["asr_goal_call"], declaredTs: 40 },
      // The accept itself measured the transition (two legible post samples).
      attestationUsed: { scoreBoardChanged: true, postSamples: 2, need: 2 },
      trigger: { timestamp: 40, scoreBoardChanged: true },
      createdAt: "2026-11-13T00:00:00.000Z",
    };
    const adoption = confirmDiveAdoption(
      promotingRow as any,
      {
        goalConfirmed: "confirmed_goal",
        corroborated: true,
        corroborationSource: "frame_attestation",
        stage1Disagreed: false,
        momentTs: 41.2,
        momentConfidence: 0.7,
      } as any,
      { diveAt: "2026-11-13T00:00:10.000Z", diveLatencyMs: 800, contextDegraded: [], frameRefs: [{ seq: 41, ts: 41.2 }] }
    );
    expect(adoption.kind).toBe("promoted");
    expect(adoption.patch.outcome).toBe("scoring_play");
    expect(adoption.patch.eventType).toBe("GOAL");
    // Never an insert: the move is in place on the same row.
    expect(adoption.patch.id).toBeUndefined();
    expect(adoption.patch.jobId).toBeUndefined();
    // The dive's moment lands, and the read side is told the lane did not move.
    expect((adoption.patch as any).confirmAttestation.momentTs).toBe(41.2);
    expect((adoption.patch as any).confirmAttestation.laneKeptByMeasurement).toBe(true);
    const card = confirmationForHighlightRow(
      {
        status: "accepted",
        outcome: "scoring_play",
        eventType: "GOAL",
        trigger: { kind: "goal_line", timestamp: 40, goalCrossed: true },
        confirmAttestation: (adoption.patch as any).confirmAttestation,
      } as any,
      { status: "accepted", trigger: MEASURED_CANDIDATE as any, analysis: MEASURED_GOAL.analysis } as any,
      { confirmEnabled: true }
    );
    expect(card?.lane).toBe("measured");
    expect(hasRefutingDiveAttestation({ ...(adoption.patch as any), outcome: "scoring_play" } as any)).toBe(false);
  });

  it("live writer: a NON-measured row keeps its D1/D3 behaviour (no regression)", () => {
    const plainRow = {
      id: "hl-d4-plain",
      jobId: "job-d4-live",
      clipUri: "/clips/hl-d4-plain.mp4",
      start: 50,
      end: 65,
      status: "accepted",
      score: 70,
      outcome: "big_play",
      eventType: "BIG_PLAY",
      reason: "a strong run down the wing",
      trigger: { timestamp: 55 },
      createdAt: "2026-11-13T00:00:00.000Z",
    };
    const out = confirmDiveAdoption(
      plainRow as any,
      {
        goalConfirmed: "confirmed_goal",
        corroborated: true,
        corroborationSource: "frame_attestation",
        stage1Disagreed: false,
      } as any,
      { diveAt: "2026-11-13T00:00:10.000Z", diveLatencyMs: 800, contextDegraded: [], frameRefs: [{ seq: 55, ts: 55 }] }
    );
    expect((out.patch as any).confirmAttestation?.laneKeptByMeasurement).toBeUndefined();
  });

  it("read side: a flagged measured row keeps its GOAL card (postable projection)", () => {
    const row = {
      status: "accepted" as const,
      outcome: "scoring_play",
      eventType: "GOAL",
      trigger: { timestamp: 40, scoreBoardChanged: true },
      confirmAttestation: {
        goalConfirmed: "not_goal",
        corroborated: false,
        corroborationSource: null,
        laneKeptByMeasurement: true,
      },
    };
    // `confirmationForHighlightRow` must answer `measured`, not `dive_disagreed`.
    const card = confirmationForHighlightRow(row as any, undefined, { confirmEnabled: true });
    expect(card?.lane).toBe("measured");
    // ...and the postable projection must not read the verdict as a refutation.
    expect(hasRefutingDiveAttestation(row as any)).toBe(false);
    // The un-flagged control: the same verdict on a row that measured nothing is
    // still a refutation (D3 precedence preserved).
    expect(
      hasRefutingDiveAttestation({
        ...row,
        trigger: { timestamp: 40 },
        outcome: "big_play",
        confirmAttestation: { goalConfirmed: "not_goal", corroborated: false, corroborationSource: null },
      } as any)
    ).toBe(true);
  });
});

describe("D4 cost — the LIVE density guard bounds admission, and names every withheld dive", () => {
  const DENSITY_ENTRY = (id: string, ts: number): PendingConfirmDive => ({
    highlightId: id,
    jobId: "job-d4-live",
    goalEventTs: ts,
    window: { lo: ts - 10, hi: ts },
    stage1: { eventType: "GOAL", outcome: "scoring_play", reason: "goal" },
    analysis: {},
    signals: { scoreBoardChanged: true },
    evidence: { scoreMeasured: true },
    queuedAt: ts,
  });

  function io(confirm = vi.fn(async () => ({ goalConfirmed: "confirmed_goal" as const, corroborated: true }))) {
    return {
      framesInSpan: (lo: number, hi: number) => {
        const out: { seq: number; ts: number }[] = [];
        for (let t = Math.ceil(lo); t <= hi; t++) out.push({ seq: t, ts: t });
        return out;
      },
      loadFrame: async (seq: number) => `img-${seq}`,
      confirm,
      gameHint: "soccer",
    } as any;
  }

  it("caps admission at the ruled 48 dives/stream-hour and settles the rest density_cap", async () => {
    const run = new LiveRunShared();
    run.notePendingConfirmDive(DENSITY_ENTRY("hl-a", 40));
    run.notePendingConfirmDive(DENSITY_ENTRY("hl-b", 80));
    run.notePendingConfirmDive(DENSITY_ENTRY("hl-c", 120));
    const confirm = vi.fn(async () => ({ goalConfirmed: "confirmed_goal" as const, corroborated: true }));
    const out = await runDueConfirmDives({
      run,
      io: io(confirm),
      nowTs: 300,
      jobId: "job-d4-live",
      // 0.02 h of stream -> floor(48 x 0.02) = 0 -> the documented 1-dive floor.
      densityCap: { streamHours: 0.02 },
      adopt: async () => "unchanged" as const,
      log: () => {},
    });
    expect(out.dives).toBe(1);
    expect(out.densitySuppressed).toBe(2);
    expect(confirm).toHaveBeenCalledTimes(1);
    // Every withheld dive is a NAMED drop cause, not a silent shift().
    expect(run.confirmDroppedByReason().density_cap).toBe(2);
    expect(CONFIRM_DROP_REASONS).toContain("density_cap");
    // ...and the stored admission block publishes the rate it enforced.
    const admission = run.confirmDiveAdmission();
    expect(admission.densityCap).toEqual({
      maxPerStreamHour: LIVE_CONFIRM_DENSITY_CAP_PER_STREAM_HOUR,
      streamHours: 0.02,
      allowance: 1,
      suppressed: 2,
    });
    expect(DiveAdmissionSnapshotSchema.parse(admission)).toBeTruthy();
    // Nothing is left waiting: a capped dive is settled, not queued.
    expect(run.confirmDivePendingCount()).toBe(0);
  });

  it("scales the allowance with the leg's own stream clock", async () => {
    const run = new LiveRunShared();
    run.notePendingConfirmDive(DENSITY_ENTRY("hl-a", 40));
    run.notePendingConfirmDive(DENSITY_ENTRY("hl-b", 80));
    // A full stream-hour admits the whole ruled allowance.
    const out = await runDueConfirmDives({
      run,
      io: io(),
      nowTs: 3600,
      jobId: "job-d4-live",
      densityCap: { streamHours: 1 },
      adopt: async () => "unchanged" as const,
      log: () => {},
    });
    expect(out.dives).toBe(2);
    expect(out.densitySuppressed).toBe(0);
    expect(run.confirmDiveAdmission().densityCap?.allowance).toBe(48);
  });

  it("is inert without a stream clock — VOD admission stays byte-identical", async () => {
    const run = new LiveRunShared();
    for (let i = 0; i < 5; i++) run.notePendingConfirmDive(DENSITY_ENTRY(`hl-${i}`, 40 + i * 10));
    const out = await runDueConfirmDives({
      run,
      io: io(),
      nowTs: 400,
      jobId: "job-d4-vod",
      adopt: async () => "unchanged" as const,
      log: () => {},
    });
    expect(out.dives).toBe(5);
    expect(out.densitySuppressed).toBe(0);
    // No denominator -> no density block on the VOD row.
    expect(run.confirmDiveAdmission().densityCap).toBeUndefined();
  });

  it("serves a withheld dive as the bare `density_cap` reason, not `dropped:density_cap`", () => {
    const card = confirmationForHighlightRow(
      {
        status: "accepted",
        confirmAttestation: { goalConfirmed: "dropped", corroborated: false, dropReason: "density_cap" },
      },
      undefined,
      { confirmEnabled: true }
    );
    expect(card?.lane).toBe("unconfirmed");
    expect(card?.skipReason).toBe("density_cap");
    expect(ConfirmationSkipReasonSchema.parse("density_cap")).toBe("density_cap");
  });
});

describe("D4 contract sync", () => {
  it("accepts `laneKeptByMeasurement` on the stored attestation", () => {
    const parsed = HighlightRecordSchema.parse({
      id: "hl-d4",
      jobId: "job-d4",
      clipUri: "/clips/hl-d4.mp4",
      start: 30,
      end: 45,
      status: "accepted",
      score: 88,
      outcome: "scoring_play",
      eventType: "GOAL",
      reason: "goal",
      createdAt: "2026-11-13T00:00:00.000Z",
      confirmAttestation: {
        goalConfirmed: "not_goal",
        corroborated: false,
        corroborationSource: null,
        diveAt: "2026-11-13T00:00:10.000Z",
        diveLatencyMs: 800,
        contextDegraded: [],
        laneKeptByMeasurement: true,
      },
    });
    expect((parsed.confirmAttestation as any).laneKeptByMeasurement).toBe(true);
  });

  it("accepts the density admission block, and drops it when absent", () => {
    const base = {
      dispatched: 3,
      queued: 0,
      maxInFlight: 1,
      capacityEffective: 4,
      divesBilled: 3,
      diveCostUsd: 0.0099972,
    };
    expect(DiveAdmissionSnapshotSchema.parse(base).densityCap).toBeUndefined();
    expect(
      DiveAdmissionSnapshotSchema.parse({
        ...base,
        densityCap: { maxPerStreamHour: 48, streamHours: 0.1516, allowance: 7, suppressed: 0 },
      }).densityCap?.allowance
    ).toBe(7);
  });

  it("keeps the historical `measured_attestation` reason parseable", () => {
    for (const reason of ["measured_attestation", "not_goal_shaped", "dive_disabled", "density_cap", "dropped:pool_busy"]) {
      expect(ConfirmationSkipReasonSchema.parse(reason)).toBe(reason);
    }
  });
});
