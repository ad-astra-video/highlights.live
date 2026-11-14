// ADAAAA-8506 — the Stage-2 deep dive must not be skipped by an attestation the
// row-level gate would then reject.
//
// Measured on live job `c4d33a26` (147 decides, 0 confirm dives): every
// goal-shaped window carried `scoreboard score change observed: yes` from OCR
// reading sponsor banners as the score. `shouldRunConfirm` read that RAW flag
// (`hasIndependentAttestation`), called the window "attested" and skipped the
// dive — while `liveGoalHasMeasuredEvidence` refused the same window
// (`postSamples: 0`, `need: 2`) and demoted it to a celebration. The same signal
// was "attested" to skip the dive and "not attested" to promote the row, so the
// dive that exists to check a noisy claim was the one thing the noise suppressed.
//
// These tests pin:
//   (1) the LIVE skip predicate is EXACTLY the row-level scoring gate — for every
//       attestation shape, `shouldRunConfirm` is false iff the row gate would
//       accept the row as attested;
//   (2) a noisy `scoreBoardChanged` (a banner/non-goal-step read) does NOT
//       suppress the dive;
//   (3) a genuinely measured single-goal delta is STILL DIVED (ADAAAA-8894/D4
//       deleted the measured-attestation skip, so the cost bound moved from
//       population to ADMISSION: the live 48-dives/stream-hour density guard);
//   (4) the VOD rail dives it too — D4 gave both rails the SAME trigger, because
//       they had diverged twice (VOD read `hasIndependentAttestation`);
//   (5) AC4 — a DROPPED dive stamps a terminal verdict field on the provisional
//       row and clears its descriptor, so no finished job keeps
//       `status:"provisional"` with nothing to read.
import { describe, it, expect } from "vitest";
import {
  candidateHasMeasuredAttestation,
  liveGoalHasMeasuredEvidence,
  shouldRunConfirm,
} from "../src/analyzer";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";
import {
  ConfirmDiveBudget,
  ConfirmDiveDispatcher,
  confirmDiveAdoption,
  droppedDiveResult,
  runDueConfirmDives,
  type PendingConfirmDive,
} from "../src/live-confirm-async";

const ACCEPTED_GOAL = {
  isHighlight: true,
  score: 80,
  eventType: "GOAL",
  outcome: "scoring_play",
  reason: "stage-1 goal read",
} as any;

function liveCfg() {
  const cfg = loadConfig({
    PERCEIVE_URL: "http://p",
    DECIDE_URL: "http://d",
    LIVE_OBSERVE_LOOP: "1",
    DECIDE_CONFIRM_ENABLED: "1",
  });
  return buildLiveAnalyzerConfig({
    cfg,
    job: { id: "job-8506", gameHint: "soccer" },
    clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
  });
}

/** A legible, single-goal score transition: this really is a goal. */
const MEASURED_GOAL_DELTA = {
  pre: [1, 1] as [number, number],
  post: [2, 1] as [number, number],
  preTs: 4,
  postTs: 9,
  deltaTs: 9,
  preSamples: 2,
  postSamples: 2,
};

/** The c4d33a26 shape: the flag says "changed" but the span reads a sponsor
 *  banner (`5-40`), a multi-goal step that cannot attest anything. */
const NOISY_BANNER_READS = {
  scoreReads: 4,
  preSamples: 4,
  postSamples: 0,
  need: 2,
  scoreStates: 3,
  newestTransition: "1-1>5-40",
};

/** Flag-only attestation with the read span contradicting it (no delta stored). */
const NOISY_FLAG_ONLY = {
  eventType: "GOAL",
  scoreBoardChanged: true,
  scoreReads: NOISY_BANNER_READS,
};

const ATTESTED = {
  eventType: "GOAL",
  scoreBoardChanged: true,
  scoreBoardDelta: MEASURED_GOAL_DELTA,
  scoreReads: { scoreReads: 4, preSamples: 2, postSamples: 2, need: 2, scoreStates: 2, newestTransition: "1-1>2-1" },
};

const EQUAL_SCORE_DELTA = {
  eventType: "GOAL",
  scoreBoardChanged: true,
  scoreBoardDelta: { ...MEASURED_GOAL_DELTA, post: [1, 1] as [number, number] },
};

const GOAL_LINE = { eventType: "GOAL", goalCrossed: true };
const BALL_OUTCOME = { eventType: "GOAL", ballOutcome: "goal" };
const LEGACY_FLAG_ONLY = { eventType: "GOAL", scoreBoardChanged: true };

const SHAPES: Array<[string, any]> = [
  ["no attestation", { eventType: "GOAL" }],
  ["noisy banner reads (c4d33a26)", NOISY_FLAG_ONLY],
  ["flag with a contradicting banner delta", { eventType: "GOAL", scoreBoardChanged: true, scoreBoardDelta: { ...MEASURED_GOAL_DELTA, post: [5, 40] as [number, number] } }],
  ["equal score delta", EQUAL_SCORE_DELTA],
  ["measured single-goal delta", ATTESTED],
  ["goal line", GOAL_LINE],
  ["ball outcome goal", BALL_OUTCOME],
  ["legacy flag-only (no reads)", LEGACY_FLAG_ONLY],
];

describe("ADAAAA-8506 AC3 — the dive skip is the row-level gate's own predicate", () => {
  it("pins predicate equivalence for every attestation shape on the live rail", () => {
    const cfg = liveCfg();
    for (const [, candidate] of SHAPES) {
      const rowGate = liveGoalHasMeasuredEvidence({
        scoreBoardChanged: candidate.scoreBoardChanged,
        goalCrossed: candidate.goalCrossed,
        ballOutcome: candidate.ballOutcome,
        scoreBoardDelta: candidate.scoreBoardDelta,
        scoreReads: candidate.scoreReads,
      });
      // ADAAAA-8506: the candidate-level predicate still agrees with the row gate
      // it feeds — the polarity bug this file exists for cannot come back.
      expect(candidateHasMeasuredAttestation(candidate)).toBe(rowGate);
      // ADAAAA-8894 (D4): the trigger no longer reads that gate at all. An
      // ACCEPTED row dives whatever its goal shape and whatever it measured, so
      // "attested" can no longer suppress the dive that checks the attestation.
      // Coverage is bounded by admission (the density guard), not by the gate.
      expect(shouldRunConfirm(cfg, candidate, ACCEPTED_GOAL)).toBe(true);
    }
  });

  it("does NOT let a noisy scoreBoardChanged suppress the dive", () => {
    const cfg = liveCfg();
    // The exact defect: flag=true, span says the score never moved.
    expect(liveGoalHasMeasuredEvidence({ ...NOISY_FLAG_ONLY, scoreBoardDelta: undefined })).toBe(false);
    expect(shouldRunConfirm(cfg, NOISY_FLAG_ONLY, ACCEPTED_GOAL)).toBe(true);
    // An equal-score delta is a legible NON-transition, not a goal.
    expect(shouldRunConfirm(cfg, EQUAL_SCORE_DELTA, ACCEPTED_GOAL)).toBe(true);
  });

  it("dives a measured, legible single-goal attestation too (D4 coverage, Ruling B)", () => {
    const cfg = liveCfg();
    // The row gate still attests it — that is what decides the LANE (`measured`),
    // and the D4 precision guard keeps the lane through the dive.
    expect(liveGoalHasMeasuredEvidence(ATTESTED)).toBe(true);
    // ...but it no longer decides whether the dive runs.
    expect(shouldRunConfirm(cfg, ATTESTED, ACCEPTED_GOAL)).toBe(true);
    expect(shouldRunConfirm(cfg, GOAL_LINE, ACCEPTED_GOAL)).toBe(true);
    expect(shouldRunConfirm(cfg, BALL_OUTCOME, ACCEPTED_GOAL)).toBe(true);
    expect(shouldRunConfirm(cfg, LEGACY_FLAG_ONLY, ACCEPTED_GOAL)).toBe(true);
  });

  it("lands the dive on the delayed-corroboration population too", () => {
    const cfg = liveCfg();
    const bareGoal = { isHighlight: false, score: 0, eventType: "GOAL", outcome: "not_highlight", reason: "no ball in net" } as any;
    expect(shouldRunConfirm(cfg, NOISY_FLAG_ONLY, bareGoal)).toBe(true);
  });

  it("dives the VOD rail too — one trigger for both rails (D4 parity, AC4.6)", () => {
    const vod = { ...liveCfg(), liveObserveLoop: false, decideWindowN: 24 } as any;
    // ADAAAA-8894 (D4): the VOD arm used to read its own predicate
    // (`hasIndependentAttestation`), which is how the rails diverged twice. Both
    // rails now call this one trigger, so a VOD row that measured its goal gets
    // the same dive moment and the same skip-reason vocabulary.
    expect(shouldRunConfirm(vod, NOISY_FLAG_ONLY, ACCEPTED_GOAL)).toBe(true);
    expect(shouldRunConfirm(vod, ATTESTED, ACCEPTED_GOAL)).toBe(true);
  });
});

describe("ADAAAA-8506 AC4 — a dropped dive is terminal, never an unread provisional row", () => {
  const provisionalRow = {
    outcome: "big_play",
    eventType: "BIG_PLAY",
    provisionalGoal: { status: "provisional", cues: ["asr_goal_call"], declaredTs: 100, note: "waiting on a score read" },
  } as any;

  it("stamps the drop verdict on the row and clears the pending descriptor", () => {
    const adoption = confirmDiveAdoption(provisionalRow, undefined, {
      diveAt: "2026-11-09T00:00:00.000Z",
      diveLatencyMs: 0,
      contextDegraded: [],
      droppedReason: "budget",
    });
    expect(adoption.kind).toBe("unchanged");
    expect(adoption.patch.pendingConfirmDive).toBeUndefined();
    expect(adoption.patch.confirmAttestation).toMatchObject({
      goalConfirmed: "dropped",
      dropReason: "budget",
    });
    // The provisional badge is preserved (AC-A7): only the verdict field changes.
    expect(adoption.patch.provisionalGoal).toBeUndefined();
  });

  function entry(): PendingConfirmDive {
    return {
      highlightId: "h-1",
      jobId: "job-8506",
      goalEventTs: 30,
      window: { lo: 20, hi: 30 },
      stage1: { outcome: "big_play" },
      analysis: {},
      signals: {},
      queuedAt: 30,
    };
  }

  function runState() {
    return {
      pending: [entry()] as PendingConfirmDive[],
      dropped: [] as string[],
      pendingConfirmDives() {
        return this.pending;
      },
      confirmDiveAttempted() {
        return new Set<string>();
      },
      noteConfirmDiveAttempt() {},
      dropPendingConfirmDive() {
        this.pending = [];
      },
      noteConfirmDiveDropped(r: string) {
        this.dropped.push(r);
      },
      noteConfirmDiveDone() {},
      confirmBudget: new ConfirmDiveBudget(),
      confirmDiveCalls() {
        return 0;
      },
      confirmDiveCount() {
        return 0;
      },
      confirmDiveDropped() {
        return this.dropped.length;
      },
    };
  }

  it("calls the verdict writer for a stream-end pool_busy stamp (no row left waiting)", async () => {
    const state = runState();
    const adopted: Array<{ reason?: string; wrote: boolean }> = [];
    const dispatcher = new ConfirmDiveDispatcher(() => 1);
    expect(dispatcher.tryAdmit()).toBe(true); // the only slot is held
    const out = await runDueConfirmDives({
      run: state as any,
      io: {} as any,
      nowMs: 1_000,
      nowTs: 30 + 20,
      jobId: "job-8506",
      dispatcher,
      drain: true,
      adopt: async (_e, result) => {
        adopted.push({ reason: result.droppedReason, wrote: !result.ok });
        return "unchanged" as const;
      },
    });
    dispatcher.release();
    expect(out.dropped).toBe(1);
    expect(adopted).toEqual([{ reason: "pool_busy", wrote: true }]);
    expect(state.pending).toHaveLength(0);
  });

  it("calls the verdict writer for a budget drop and for a failed dive", async () => {
    const budgetState = runState();
    const budgetAdopted: Array<string | undefined> = [];
    // ADAAAA-8518 (AC1): `0` now means UNLIMITED, so the brake is exercised with
    // an EXPLICIT POSITIVE cap whose single token is already spent in the window.
    expect(budgetState.confirmBudget.allow(30 + 20, 1)).toBe(true);
    const budgetOut = await runDueConfirmDives({
      run: budgetState as any,
      io: {} as any,
      nowTs: 30 + 20,
      jobId: "job-8506",
      maxDivesPer300s: 1,
      // ADAAAA-8513 (AC5): at stream end a budget refusal is terminal and the
      // descriptor is stamped — AC1 keeps it pending only while the stream can
      // still retry it.
      drain: true,
      adopt: async (_e, result) => {
        budgetAdopted.push(result.droppedReason);
        return "unchanged" as const;
      },
    });
    expect(budgetOut.dropped).toBe(1);
    expect(budgetAdopted).toEqual(["budget"]);

    // A dive that ran and failed carries its own reason (e.g. timeout).
    expect(droppedDiveResult("timeout", 45_000).droppedReason).toBe("timeout");
    const timeoutAdoption = confirmDiveAdoption(provisionalRow, undefined, {
      diveAt: "2026-11-09T00:00:00.000Z",
      diveLatencyMs: 45_000,
      contextDegraded: [],
      droppedReason: "timeout",
    });
    expect(timeoutAdoption.patch.confirmAttestation).toMatchObject({ goalConfirmed: "dropped", dropReason: "timeout" });
    expect(timeoutAdoption.patch.pendingConfirmDive).toBeUndefined();
  });
});
