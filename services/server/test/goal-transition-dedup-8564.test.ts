// ADAAAA-8564 falsifiers — corrected by the rer8139 content check.
//
// The 8534 leg (job 54c03cfc) ran `/state/kids510.vp8.ivf` = kids300 (300.07 s)
// frame-concat rer8139 (210.10 s), zero re-encode. It delivered 7 rows over 4
// anchors and FOUR GOAL rows. Transcribing the stored rows gives:
//
//   segment 1 (kids300)  1-1>2-1 @102.681 (hl 9a965553), 2-1>2-2 @161.950
//                        (hl eca4c1de)                     -> 2 forward steps
//   segment 2 (rer8139)  2-1>2-2 @346.980 (hl 29abe607)      -> 51.05 s into the clip
//                        1-1>2-1 @474.982 (hl 4788ae8e, deferred read at
//                        479.081 s)                          -> 174.91 s into the clip
//
// Segment 2's two reads cannot BOTH be forward transitions of one scoreboard:
// 2-2 at 51 s and then 1-1 at 175 s is a rewind. ADAAAA-8139's OCR pass over
// the same underlying capture (`capture.webm`, 8 reads, 17.0-75.4 s) reads
// `2-1` at 17.0/23.9/24.5/43.8/49.0 s and `2-2` at 55.5/56.0/75.4 s and never
// `1-1`, which corroborates row 3 (51.05 s sits inside the 49.0->55.5 s step)
// and leaves row 4 ungrounded: its pre sample (1-1) contradicts a state the run
// had already read 128 s earlier.
//
// Nothing in the pipeline compares a read against the run's own earlier state,
// so the deferred read upgrades the celebration to a GOAL. Fix C closes that:
// a transition whose POST state is below a state the run already read cannot
// attest a NEW GOAL (fail-closed, then the next forward read from the new
// baseline attests normally).
//
// Withdrawn proposal: "one transitionKey = one goal for the whole run" (B1/B2
// of the first write-up). A second clip whose scoreline repeats the first
// clip's progression carries the SAME keys for DIFFERENT moments — on this leg
// it would have demoted the genuine rer8139 goal at 351.118. Test C2 below pins
// that regression so the withdrawn rule cannot land by accident.
import { describe, expect, it } from "vitest";
import {
  LiveRunShared,
  buildLiveObserveMetrics,
  observeAcceptOnly,
  type AnalyzerConfig,
  type DecisionResult,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer.js";
import { LiveObserver } from "../src/observe-loop.js";

/** A legible measured score transition (both sides >= 2 contiguous reads). */
function deltaOf(pre: [number, number], post: [number, number], deltaTs = 1): ScoreboardDeltaEvidence {
  return { pre, post, preTs: 0, postTs: deltaTs, deltaTs, preSamples: 2, postSamples: 2 };
}

/** The delivered GOAL of the 2-1>2-2 boundary in segment 1: hl eca4c1de. */
const GOAL_164: Parameters<LiveRunShared["noteAcceptedGoalEvent"]>[0] = {
  highlightId: "eca4c1de-07f5-49a7-bf25-ed0aa060dc64",
  anchorTs: 161.95,
  start: 154.95,
  end: 169.95,
  candidateTs: 164.481,
  transitionKey: "2-1>2-2",
};

/** The celebration the deferred read promoted: hl 4788ae8e, window 464.982-474.982. */
function parkCelebration(run: LiveRunShared, lo = 464.982, hi = 474.982) {
  run.noteDeferredGoalAttestation({
    highlightId: "4788ae8e-713e-4c0a-84ca-6288c3bf4306",
    jobId: "54c03cfc-64e6-4d9b-ae57-7b6d9a4ff4d2",
    lo,
    hi,
    anchorTs: hi,
    triggerKind: "motion",
  });
}

describe("ADAAAA-8564 / Fix C: a rewound score read cannot attest a new GOAL", () => {
  it("refuses the 479.081 s read (pre 1-1 -> post 2-1) after the run read 2-2 at 351.118 s", () => {
    // Stored: the row-3 window's own reads put the board at 2-2 (2 reads) after
    // a 2-1 read; hl 4788ae8e's deferred read at 479.081 s then reports
    // 1-1 -> 2-1. POST (1+2=3 goals) is below a state this run already read
    // (2+2=4), so the transition is a rewind, not a new goal.
    const run = new LiveRunShared();
    run.noteScoreReadings([
      { ts: 340.0, ocr: ["2 - 1"] },
      { ts: 351.0, ocr: ["2 - 2"] },
      { ts: 355.0, ocr: ["2 - 2"] },
    ]);
    parkCelebration(run);
    const upgrades = run.resolveDeferredGoalAttestation({
      readAt: 479.081,
      delta: deltaOf([1, 1], [2, 1], 474.982),
    });
    // Today: `ownedByDeliveredGoal` is POSITIONAL and the 2-2 boundary was
    // credited 128 s earlier, so the entry is promoted to a second GOAL.
    expect(upgrades).toEqual([]);
  });

  it("still attests a forward step that lands ON the state already read (2-1 -> 2-2 at 351.118 s)", () => {
    // Guard against over-suppression: the genuine rer8139 transition reaches
    // the same total the earlier clip reached, which is a forward step, not a
    // rewind. This must stay a GOAL.
    const run = new LiveRunShared();
    run.noteScoreReadings([{ ts: 300.5, ocr: ["2 - 2"] }]);
    parkCelebration(run, 339.98, 354.98);
    const upgrades = run.resolveDeferredGoalAttestation({
      readAt: 356.0,
      delta: deltaOf([2, 1], [2, 2], 346.98),
    });
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0].highlightId).toBe("4788ae8e-713e-4c0a-84ca-6288c3bf4306");
  });

  it("still attests a higher transition (2-2 -> 3-2) after the same reads", () => {
    const run = new LiveRunShared();
    run.noteScoreReadings([{ ts: 351.0, ocr: ["2 - 2"] }]);
    parkCelebration(run);
    const upgrades = run.resolveDeferredGoalAttestation({
      readAt: 480.0,
      delta: deltaOf([2, 2], [3, 2], 478.0),
    });
    expect(upgrades).toHaveLength(1);
  });

  it("fails OPEN when the run has no earlier score state (absent evidence is not a contradiction)", () => {
    const run = new LiveRunShared();
    parkCelebration(run);
    const upgrades = run.resolveDeferredGoalAttestation({
      readAt: 479.081,
      delta: deltaOf([1, 1], [2, 1], 474.982),
    });
    expect(upgrades).toHaveLength(1);
  });
});

describe("ADAAAA-8564 / withdrawn B1: a repeated transitionKey is NOT a repeated moment", () => {
  it("keeps the second clip's 2-1>2-2 accept as a NEW scoring event, 186.6 s after segment 1's", () => {
    // kids300 and rer8139 both progress 1-1 -> 2-1 -> 2-2, so the transition KEY
    // repeats across the seam while the moments are distinct. A run-wide key
    // ledger (the withdrawn Fix B1) would have demoted the rer8139 goal. This
    // canary pins the shape the withdrawn rule must never take: an accept whose
    // own legible delta is outside the delivered event's clip opens a new event.
    const run = new LiveRunShared();
    run.noteAcceptedGoalEvent(GOAL_164);
    expect(
      run.repeatGoalEvent({
        anchorTs: 346.98,
        start: 339.98,
        end: 354.98,
        isGoal: true,
        scoreboardDeltaLegible: true,
      })
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ADAAAA-8564 / Fix A: `accepted` is a WINDOW counter; the rows reconcile.
//
// The leg: 130 decided windows = 115 rejected / 8 suppressed / 7 accepted, and
// 7 persisted rows. `observeMetrics.accepted` read 11 because (a) a
// burst-suppressed window returns the PRE-suppression GOAL verdict (so it counts
// as accepted and wrote no row) and (b) the 4 rows the ADAAAA-7996 gate demoted
// to a celebration ship but fail `isAcceptedHighlight`. Fix A publishes the row
// accounting instead of changing the delivery verdict: `accepted` itself stays
// exactly what it was (it feeds the Stage-A/B ledgers).
describe("ADAAAA-8564 / Fix A: row accounting reconciles `accepted` with the rows", () => {
  const liveCfg = () =>
    ({
      jobId: "job-8564",
      gameHint: "soccer",
      clipBeforeS: 6,
      clipAfterS: 9,
      clipWindowMinSec: 15,
      preferLabels: [],
      confirmEnabled: false,
      liveObserveLoop: true,
      observeWindowS: 10,
      sampleFps: 3,
    }) as unknown as AnalyzerConfig;
  const goalDecision = () =>
    ({
      isHighlight: true,
      score: 85,
      outcome: "scoring_play",
      eventType: "GOAL",
      reason: "Scoreboard changes from 1-1 to 2-1 and players celebrate.",
    }) as DecisionResult;
  /** One live window's payload: 4 frames, no OCR (so no measured delta). */
  function payloadAt(centerTs: number) {
    const ts = [centerTs - 9, centerTs - 6, centerTs - 3, centerTs];
    return {
      centerTs,
      frames: ts.map((t, seq) => ({ ts: t, imageB64: "f", seq })),
      seeds: ts.map((t) => ({ ts: t, tracks: [], objects: [], ocr: [] })),
      observations: ts.map((t) => ({ ts: t, ocr: [] })),
      biasHints: [],
      capped: false,
      droppedCount: 0,
    } as any;
  }
  const cut = async (t: number) => ({ clipId: `clip-${t}`, clipUri: "" });
  const client = { decide: async () => goalDecision(), confirm: async () => ({ enabled: false }) } as any;

  it("counts a burst-SUPPRESSED window as suppressed, not as an accepted row", async () => {
    // Stored: 8 windows of this leg were suppressed by `goal_burst_same_transition`
    // (they wrote no row) after hl eca4c1de credited 2-1>2-2 at 164.481 s.
    const run = new LiveRunShared();
    run.noteAcceptedGoalEvent(GOAL_164);
    const accepted = await observeAcceptOnly(client, run, cut, liveCfg(), undefined, payloadAt(167.548), goalDecision());
    expect(run.highlights).toHaveLength(0);
    // The delivery verdict is UNCHANGED (no behaviour change): the branch still
    // reports the pre-suppression GOAL verdict, which is why `accepted` over-counts.
    expect(accepted).toBe(true);
    expect(run.rowAccounting(0)).toEqual({
      acceptedWindows: 0,
      persistedRows: 0,
      servedCards: 0,
      suppressedWindows: 1,
      demotedCelebrations: 0,
    });
  });

  it("counts a DEMOTED celebration row as a row, not as an accepted window", async () => {
    // Stored: 4 of the leg's 7 delivered rows are the ADAAAA-7996 demotion
    // (GOAL -> BIG_PLAY celebration). They ship, so `persistedRows` must count
    // them even though `isAcceptedHighlight` (preferLabels []) refuses them.
    const run = new LiveRunShared();
    const accepted = await observeAcceptOnly(client, run, cut, liveCfg(), undefined, payloadAt(161.448), goalDecision());
    expect(run.highlights).toHaveLength(1);
    expect(run.highlights[0].outcome).toBe("big_play");
    expect(accepted).toBe(false);
    const accounting = run.rowAccounting(1);
    expect(accounting).toEqual({
      acceptedWindows: 0,
      persistedRows: 1,
      servedCards: 1,
      suppressedWindows: 0,
      demotedCelebrations: 1,
    });
    // The published invariant: every row is either an accepted window or a
    // demoted celebration.
    expect(accounting.persistedRows).toBe(accounting.acceptedWindows + accounting.demotedCelebrations);
  });

  it("reproduces the leg's arithmetic: 3 + 8 = 11 accepted, 3 + 4 = 7 rows", () => {
    // The stored counters, replayed through the published invariant. No leg, no
    // GPU: the two identities the diagnosis derived are asserted directly.
    const leg = { accepted: 11, acceptedWindows: 3, suppressedWindows: 8, demotedCelebrations: 4, persistedRows: 7 };
    expect(leg.accepted).toBe(leg.acceptedWindows + leg.suppressedWindows);
    expect(leg.persistedRows).toBe(leg.acceptedWindows + leg.demotedCelebrations);
  });

  it("publishes rowAccounting on the snapshot, and omits it when the run is not instrumented", () => {
    const observer = new LiveObserver({ cadenceS: 3, windowS: 10, fps: 2, onDecide: async () => false });
    const accounting = {
      acceptedWindows: 3,
      persistedRows: 7,
      servedCards: 7,
      suppressedWindows: 8,
      demotedCelebrations: 4,
    };
    expect(buildLiveObserveMetrics(observer, undefined, undefined, undefined, undefined, accounting).rowAccounting).toEqual(accounting);
    expect(buildLiveObserveMetrics(observer).rowAccounting).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ADAAAA-8604 / R1: a football score is monotone PER TEAM, not by total.
//
// The Fix C guard compared `post[0] + post[1] < highWater[0] + highWater[1]`, so a
// read that swaps the sides (`1-2` already read, then `2-1` attested) passes on an
// equal TOTAL. Measured on the served build of `3f5734e`: high-water `[1,2]`, a
// parked celebration, deferred read `1-1 -> 2-1` -> 1 upgrade, i.e. a second GOAL
// on the same client-visible shape the parent ticket was opened about, one
// split-order away.
describe("ADAAAA-8604 / R1: the rewind compare is per team, not by total", () => {
  it("refuses a same-total reversed split (run read 1-2, the deferred read lands 2-1)", () => {
    const run = new LiveRunShared();
    run.noteScoreReadings([
      { ts: 20.0, ocr: ["1 - 2"] },
      { ts: 23.0, ocr: ["1 - 2"] },
    ]);
    expect(run.scoreHighWaterState()).toEqual([1, 2]);
    parkCelebration(run, 24.0, 30.0);
    const upgrades = run.resolveDeferredGoalAttestation({
      readAt: 30.0,
      delta: deltaOf([1, 1], [2, 1], 28.0),
    });
    // 1-2 and 2-1 both total 3, so the total compare attests this. Per team it is
    // a rewind (the side that read 2 cannot read 1 later), so it must not mint a
    // second GOAL — the window stays the celebration it was accepted as.
    expect(upgrades).toEqual([]);
  });

  it("still attests a genuine per-team forward step that reaches the same total", () => {
    // Guard against over-suppression: 1-2 -> 2-2 raises one side and keeps the
    // other, which is a forward step, not a rewind.
    const run = new LiveRunShared();
    run.noteScoreReadings([{ ts: 20.0, ocr: ["1 - 2"] }]);
    parkCelebration(run, 24.0, 30.0);
    const upgrades = run.resolveDeferredGoalAttestation({
      readAt: 30.0,
      delta: deltaOf([1, 2], [2, 2], 28.0),
    });
    expect(upgrades).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ADAAAA-8604 / R2: the run-wide high-water is re-baselined on a detected kickoff.
//
// Measured on the served build of `3f5734e`: high-water `[3,2]`, then two `0-0`
// reads (a new match starting), a parked celebration, deferred read
// `0-0 -> 1-0` -> 0 upgrades. The new match's real goals all ship as celebrations
// until the running total passes `3+2` — silently. A kickoff is two CONTIGUOUS
// `0-0` reads after a non-zero high-water; the `54c03cfc` rewind read `1-1` and
// never `0-0`, so it still fails closed (R1 above and the four Fix C tests).
describe("ADAAAA-8604 / R2: a detected kickoff re-baselines the score high-water", () => {
  it("attests the new match's first goal (0-0 -> 1-0) after a 3-2 first match", () => {
    const run = new LiveRunShared();
    run.noteScoreReadings([
      { ts: 10.0, ocr: ["3 - 2"] },
      { ts: 40.0, ocr: ["0 - 0"] },
      { ts: 43.0, ocr: ["0 - 0"] },
    ]);
    expect(run.scoreHighWaterState()).toEqual([0, 0]);
    expect(run.scoreKickoffBaselineResets()).toBe(1);
    parkCelebration(run, 40.0, 48.0);
    const upgrades = run.resolveDeferredGoalAttestation({
      readAt: 50.0,
      delta: deltaOf([0, 0], [1, 0], 45.0),
    });
    expect(upgrades).toHaveLength(1);
  });

  it("does not re-baseline on a SINGLE 0-0 read (one flicker is not a kickoff)", () => {
    const run = new LiveRunShared();
    run.noteScoreReadings([
      { ts: 10.0, ocr: ["3 - 2"] },
      { ts: 12.0, ocr: ["0 - 0"] },
    ]);
    expect(run.scoreHighWaterState()).toEqual([3, 2]);
    parkCelebration(run, 12.0, 18.0);
    const upgrades = run.resolveDeferredGoalAttestation({
      readAt: 20.0,
      delta: deltaOf([0, 0], [1, 0], 15.0),
    });
    expect(upgrades).toEqual([]);
  });

  it("does not re-baseline when a non-zero read lands between the two 0-0 reads", () => {
    const run = new LiveRunShared();
    run.noteScoreReadings([
      { ts: 10.0, ocr: ["3 - 2"] },
      { ts: 12.0, ocr: ["0 - 0"] },
      { ts: 14.0, ocr: ["0 - 1"] },
      { ts: 16.0, ocr: ["0 - 0"] },
    ]);
    // No re-baseline: the high-water is still the 3-2 state the run really read.
    expect(run.scoreHighWaterState()).toEqual([3, 2]);
  });

  it("counts a re-produced window's 0-0 frame as one read, not two", () => {
    // Overlapping decide windows carry the same content frames; a re-decided
    // window must not fabricate the kickoff pair out of one read.
    const run = new LiveRunShared();
    run.noteScoreReadings([
      { ts: 10.0, ocr: ["3 - 2"] },
      { ts: 40.0, ocr: ["0 - 0"] },
    ]);
    run.noteScoreReadings([{ ts: 40.0, ocr: ["0 - 0"] }]);
    expect(run.scoreHighWaterState()).toEqual([3, 2]);
  });
});