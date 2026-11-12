// ADAAAA-8740 (§6.3): a leading celebration cue must not ship a card that ends
// before the goal.
//
// AC1 reproduces the graded leg's OWN pair, offline and $0: job
// `1b0a3221-e805-452e-a3f5-fdeb6693766e` stored one event as TWO rows —
//   cue        `localizedTs 96.500`, `peak_audio_reaction`, card `[83.500, 98.500]`
//              (`celebration_tail`, goal instant NOT on the card)
//   transition `localizedTs 102.743`, `measured_transition`, card `[95.743, 110.743]`
// and the pre-fix decision emitted both cards (the cue card ends 4.243 s before
// the ball crossed). The group decision must emit ONE card that contains
// `102.743` with >= 2 s of pre-goal footage.
//
// AC2 pins the decision function itself: `goal_anchor_over_leading_cue` when the
// group's goal instant does not fit the cue-tail window, and the cue row
// suppressed when the group's goal row ships (one card per event).
//
// AC3 pins no-regression: a lone reaction row keeps `celebration_tail` with the
// cue at `>= d - 2.5`, `measured_transition` rows keep ACC-2 (`0.467 d`), no row
// places a known goal instant outside its card, and the VOD posture is
// byte-identical.
import { describe, it, expect } from "vitest";
import {
  LiveRunShared,
  acceptVideoDecision,
  clipEventGroupRowFromHighlight,
  type AnalyzerConfig,
  type CandidateSignal,
  type DecisionResult,
  type LeadingCueRetraction,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer.js";
import {
  CELEBRATION_TAIL_S,
  cueCardCompetesWithGoal,
  placeLiveClipWindow,
  placeLiveEventGroupClipWindows,
  type ClipEventGroupRow,
} from "../src/clip-placement.js";
import { clipWindow } from "../src/config.js";
import { LiveDeliveryTracker } from "../src/live-delivery.js";

/** The live rail's defaults: 7 s before / 8 s after, 15 s floor. */
const nominal = (cue: number) => clipWindow(cue, 7, 8, 15);
const D = 15;

/** The graded leg's stored rows, verbatim (read-only psql, 2026-11-12). */
function legRow(r: {
  id: string;
  localizedTs: number;
  anchorReason: string;
  card: { start: number; end: number };
  placementReason: string;
}) {
  return clipEventGroupRowFromHighlight({
    id: r.id,
    start: r.card.start,
    end: r.card.end,
    localizedTs: r.localizedTs,
    localizeAnchorReason: r.anchorReason,
    clipPlacementReason: r.placementReason,
  });
}

const LEG = {
  cue: {
    id: "05d2815c-2a3d-4a61-a351-eaacd4944928",
    localizedTs: 96.5,
    anchorReason: "peak_audio_reaction",
    placementReason: "celebration_tail",
    card: { start: 83.5, end: 98.5 },
  },
  goal: {
    id: "38512cc7-5456-45df-84f2-fd9f850823d2",
    localizedTs: 102.74300003051758,
    anchorReason: "measured_transition",
    placementReason: "goal_anchor",
    card: { start: 95.74300003051758, end: 110.74300003051758 },
  },
} as const;

function liveCfg(over: Partial<AnalyzerConfig> = {}): AnalyzerConfig {
  return {
    jobId: "job-8740",
    gameHint: "soccer",
    clipBeforeS: 7,
    clipAfterS: 8,
    clipWindowMinSec: 15,
    preferLabels: [],
    confirmEnabled: false,
    liveObserveLoop: true,
    ...over,
  } as AnalyzerConfig;
}

function motionCandidate(ts: number, extra: Partial<CandidateSignal> = {}): CandidateSignal {
  return { eventType: "SPORTING_EVENT", timestamp: ts, ...extra } as CandidateSignal;
}

/** The celebration-class scoring read the leg stored for the roar's window: the
 * measured-attestation gate demotes it (no score change in its window). */
function celebrationRead(): DecisionResult {
  return {
    isHighlight: true,
    score: 85,
    outcome: "scoring_play",
    eventType: "BIG_PLAY",
    reason: "ASR confirms goal and the crowd erupts.",
  } as DecisionResult;
}

/** The leg's own measured transition: 1-1 -> 2-1 first seen at 102.743 s. */
const LEG_GOAL_DELTA: ScoreboardDeltaEvidence = {
  pre: [1, 1],
  post: [2, 1],
  preTs: 101.2,
  postTs: 102.743,
  deltaTs: 102.743,
  preSamples: 14,
  postSamples: 10,
};

interface Harness {
  run: LiveRunShared;
  cuts: Array<{ ts: number; window?: { start: number; end: number; cueTail?: boolean } }>;
  retractions: LeadingCueRetraction[];
  accept: (
    ts: number,
    stage1: DecisionResult,
    opts?: { candidateExtra?: Partial<CandidateSignal>; lo?: number; hi?: number }
  ) => Promise<void>;
}

/** Drive the REAL accept seam repeatedly on ONE run (the live rail's shape). */
function harness(): Harness {
  const run = new LiveRunShared({ audioRetainS: 400 });
  const cuts: Harness["cuts"] = [];
  const retractions: LeadingCueRetraction[] = [];
  const cut = async (t: number, window?: { start: number; end: number; cueTail?: boolean }) => {
    cuts.push({ ts: t, window });
    return { clipId: `clip-${t}`, clipUri: `file://clip-${t}.mp4` };
  };
  const client = {
    decide: () => {
      throw new Error("decide must NOT run on the accept seam (AC4: 0 added calls)");
    },
    confirm: () => {
      throw new Error("confirm must NOT run with confirmEnabled=false (AC4: 0 added calls)");
    },
  } as any;
  const cfg = liveCfg({ onLeadingCueRetracted: (r) => retractions.push(r) });
  return {
    run,
    cuts,
    retractions,
    accept: async (ts, stage1, opts = {}) => {
      await acceptVideoDecision(
        client,
        run,
        cut,
        cfg,
        undefined,
        { seq: cuts.length + 1, timestamp: ts },
        motionCandidate(ts, opts.candidateExtra),
        stage1,
        undefined,
        undefined,
        undefined,
        // The live rail's trailing judged window.
        { lo: opts.lo ?? ts - 10, hi: opts.hi ?? ts }
      );
    },
  };
}

describe("ADAAAA-8740 AC1 — the graded leg's own pair emits ONE card", () => {
  it("replays cue 96.500 + transition 102.743 through the real accept seam: 2 cards -> 1", async () => {
    const h = harness();
    // --- the PRE-FIX shape, reproduced offline from the same two rows ---------
    const preCue = placeLiveClipWindow({
      localizedTs: LEG.cue.localizedTs,
      anchorReason: LEG.cue.anchorReason,
      window: nominal(LEG.cue.localizedTs),
      live: true,
    });
    const preGoal = placeLiveClipWindow({
      localizedTs: LEG.goal.localizedTs,
      anchorReason: LEG.goal.anchorReason,
      window: nominal(LEG.goal.localizedTs),
      live: true,
    });
    expect([preCue.start, preCue.end]).toEqual([83.5, 98.5]);
    expect(preGoal.start).toBeCloseTo(95.743, 3);
    expect(preGoal.end).toBeCloseTo(110.743, 3);
    // Pre-fix: TWO cards, and the cue card does not hold the goal.
    expect(LEG.goal.localizedTs - preCue.end).toBeCloseTo(4.243, 3);
    expect(preCue.end < LEG.goal.localizedTs).toBe(true);

    // --- the FIX, through the real accept seam -------------------------------
    // 1. the roar's window (judged [86.5, 96.5]) accepts as a demoted celebration
    await h.accept(LEG.cue.localizedTs, celebrationRead(), { lo: 86.5, hi: 96.5 });
    expect(h.run.highlights).toHaveLength(1);
    expect(h.run.highlights[0].clipPlacementReason).toBe("celebration_tail");
    const cueRowId = h.run.highlights[0].id;

    // 2. the transition window (judged [92.743, 102.743]) measures the goal
    //    (`scoreBoardChanged` is what the leg's own ledger read on that window)
    await h.accept(LEG.goal.localizedTs, celebrationRead(), {
      candidateExtra: { scoreBoardDelta: LEG_GOAL_DELTA, scoreBoardChanged: true },
      lo: 92.743,
      hi: 102.743,
    });

    // ONE card for the event group, and it is the goal row's.
    expect(h.run.highlights).toHaveLength(1);
    const card = h.run.highlights[0];
    expect(card.localizedTs).toBeCloseTo(102.743, 3);
    expect(card.clipPlacementReason).toBe("goal_anchor");
    expect(card.start).toBeCloseTo(95.743, 3);
    expect(card.end).toBeCloseTo(110.743, 3);
    // AC1: contains 102.743 with >= 2 s of pre-goal footage.
    expect(card.start).toBeLessThanOrEqual(102.743);
    expect(card.end).toBeGreaterThanOrEqual(102.743);
    expect(102.743 - card.start).toBeGreaterThanOrEqual(2);
    expect(card.clipWindowSec).toBeCloseTo(D, 6);

    // The cue card was WITHDRAWN (not demoted-and-still-served), with the real
    // id and cards on the hook, so the rail can delete it from the store.
    expect(h.retractions).toHaveLength(1);
    expect(h.retractions[0].highlightId).toBe(cueRowId);
    // The withdrawn row is gone from the run's delivered set (it is the cue row,
    // never the goal row).
    expect(h.run.highlights.some((r) => r.id === cueRowId)).toBe(false);
    expect(h.retractions[0].cueTs).toBeCloseTo(96.5, 3);
    expect(h.retractions[0].cueCard.start).toBeCloseTo(83.5, 3);
    expect(h.retractions[0].cueCard.end).toBeCloseTo(98.5, 3);
    expect(h.retractions[0].goalTs).toBeCloseTo(102.743, 3);
    expect(h.retractions[0].reason).toBe("cue_row_covered_by_goal");

    // Only the goal row was cut (the cue row already had its own card).
    expect(h.cuts).toHaveLength(2);
    expect(h.cuts[1].window?.start).toBeCloseTo(95.743, 3);

    // The ledger reads one served card for the conflicting event: the
    // demotion that produced the cue row stays visible, the withdrawal is its
    // own number, and the identity still closes.
    const ledger = h.run.rowAccounting(h.run.highlights.length);
    expect(ledger).toEqual({
      acceptedWindows: 1,
      persistedRows: 1,
      servedCards: 1,
      suppressedWindows: 0,
      demotedCelebrations: 1,
      retractedCards: 1,
    });
    expect(ledger.persistedRows).toBe(
      ledger.acceptedWindows + ledger.demotedCelebrations - (ledger.retractedCards ?? 0)
    );
  });

  it("retracting the reading leaves servedCards at the cards a viewer holds", () => {
    const tracker = new LiveDeliveryTracker();
    const firedAtMs = 1_000_000;
    tracker.noteWindow({
      centerTs: 96.5,
      lagMs: 500,
      firedAtMs,
      settledAtMs: firedAtMs + 3000,
      acceptStartMs: firedAtMs + 3000,
      acceptDoneMs: firedAtMs + 3100,
    });
    tracker.notePersisted(96.5, firedAtMs + 3150, LEG.cue.id);
    expect(tracker.snapshot()?.samples).toBe(1);
    expect(tracker.retractDelivered(LEG.cue.id)).toBe(true);
    // The withdrawn reading leaves the ledger, so the tracker has no samples
    // left to summarise (snapshot() is null at zero).
    expect(tracker.snapshot()?.samples ?? 0).toBe(0);
    expect(tracker.retractedRows()).toBe(1);
    // Idempotent: retracting twice never decrements twice.
    expect(tracker.retractDelivered(LEG.cue.id)).toBe(false);
    expect(tracker.retractedRows()).toBe(1);
  });
});

describe("ADAAAA-8740 AC2 — one decision over the event group", () => {
  it("replays the stored rows through the decision: 1 card, cue row suppressed", () => {
    const group = placeLiveEventGroupClipWindows({
      rows: [legRow(LEG.cue), legRow(LEG.goal)],
      live: true,
    });
    expect(group.goalTs).toBeCloseTo(102.743, 3);
    expect(group.goalRowIndex).toBe(1);
    // ONE card for the event group (pre-fix this pair emitted 2).
    expect(group.cards).toHaveLength(1);
    expect(group.cards[0].start).toBeCloseTo(95.743, 3);
    expect(group.cards[0].end).toBeCloseTo(110.743, 3);
    expect(group.cards[0].reason).toBe("goal_anchor");
    expect(group.suppressed).toHaveLength(1);
    expect(group.suppressed[0].id).toBe(LEG.cue.id);
    expect(group.suppressed[0].localizedTs).toBeCloseTo(96.5, 3);
    expect(group.suppressed[0].goalTs).toBeCloseTo(102.743, 3);
    expect(group.suppressed[0].reason).toBe("cue_row_covered_by_goal");
  });

  it("keeps celebration_tail when the group's goal instant fits the tail window", () => {
    // Goal 1.5 s after the cue: `[cue - 13, cue + 2]` still holds it (rule 1).
    const cue = 200;
    const group = placeLiveEventGroupClipWindows({
      rows: [{ localizedTs: cue, anchorReason: "peak_audio_reaction", window: nominal(cue) }],
      goalTs: cue + 1.5,
      live: true,
    });
    expect(group.cards).toHaveLength(1);
    expect(group.cards[0].reason).toBe("celebration_tail");
    expect(group.cards[0].start).toBeCloseTo(cue - 13, 6);
    expect(group.cards[0].end).toBeCloseTo(cue + 2, 6);
    // The goal is inside the card.
    expect(cue + 1.5).toBeLessThanOrEqual(group.cards[0].end);
  });

  it("places goal_anchor_over_leading_cue when the goal instant does not fit", () => {
    // The QA leg's geometry: goal 6.243 s after the cue -> outside `cue + 2`.
    const cue = 96.5;
    const goalTs = 102.743;
    const group = placeLiveEventGroupClipWindows({
      rows: [{ localizedTs: cue, anchorReason: "peak_audio_reaction", window: nominal(cue) }],
      goalTs,
      live: true,
    });
    expect(group.cards).toHaveLength(1);
    const placed = group.rows[0].placed!;
    expect(placed.reason).toBe("goal_anchor_over_leading_cue");
    // Fixed length, goal-anchored, goal inside, cue's real position disclosed.
    expect(placed.end - placed.start).toBeCloseTo(D, 6);
    expect(placed.start).toBeLessThanOrEqual(goalTs);
    expect(placed.end).toBeGreaterThanOrEqual(goalTs);
    expect(goalTs - placed.start).toBeCloseTo(7, 6); // ACC-2 shape: 0.467 d
    expect(placed.celebrationOffsetSec).toBeCloseTo(cue - placed.start, 6);
    expect(placed.celebrationOffsetSec).toBeCloseTo(0.757, 3);
    expect(placed.cueOffsetSec).toBeGreaterThanOrEqual(0);
    // The celebration is NOT forced to the end: the cue is still on the card.
    expect(placed.start).toBeLessThanOrEqual(cue);
    expect(placed.end).toBeGreaterThanOrEqual(cue);
  });

  it("suppresses a leading cue accept when the goal row already shipped", async () => {
    const h = harness();
    // The transition lands FIRST (an out-of-order accept: decide latency differs).
    await h.accept(102.743, celebrationRead(), {
      candidateExtra: { scoreBoardDelta: LEG_GOAL_DELTA },
      lo: 92.743,
      hi: 102.743,
    });
    expect(h.run.highlights).toHaveLength(1);
    const goalId = h.run.highlights[0].id;

    // Then the roar's window accepts: its card would cover [83.5, 98.5] and ends
    // 4.243 s before the goal the board already holds.
    await h.accept(96.5, celebrationRead(), { lo: 86.5, hi: 96.5 });

    // Suppressed BEFORE cut/persist: one row, one card, no second clip.
    expect(h.run.highlights).toHaveLength(1);
    expect(h.run.highlights[0].id).toBe(goalId);
    expect(h.cuts).toHaveLength(1);
    const ledger = h.run.rowAccounting(h.run.highlights.length);
    expect(ledger.suppressedWindows).toBe(1);
    expect(ledger.persistedRows).toBe(1);
    expect(ledger.servedCards).toBe(1);
    expect(ledger.retractedCards).toBeUndefined();
  });

  it("keeps a DISTINCT celebration that shares no footage with the goal", () => {
    const goalCard = { start: 95.743, end: 110.743 };
    // A celebration 20 s later, no card overlap -> its own moment, own card.
    const cue = 132;
    const group = placeLiveEventGroupClipWindows({
      rows: [
        clipEventGroupRowFromHighlight({
          id: LEG.goal.id,
          start: goalCard.start,
          end: goalCard.end,
          localizedTs: LEG.goal.localizedTs,
          localizeAnchorReason: LEG.goal.anchorReason,
        }),
        { localizedTs: cue, anchorReason: "peak_audio_reaction", window: nominal(cue) },
      ],
      live: true,
    });
    expect(group.cards).toHaveLength(2);
    expect(group.suppressed).toHaveLength(0);
    const celebration = group.rows[1].placed!;
    expect(celebration.reason).toBe("celebration_tail");
    expect(celebration.cueOffsetSec).toBeCloseTo(cue - celebration.start, 6);
  });

  it("only overlaps, never a shared edge, count as the same event", () => {
    expect(cueCardCompetesWithGoal({ start: 83.5, end: 98.5 }, { start: 95.743, end: 110.743 })).toBe(true);
    expect(cueCardCompetesWithGoal({ start: 80, end: 95.743 }, { start: 95.743, end: 110.743 })).toBe(false);
    expect(cueCardCompetesWithGoal({ start: 110.743, end: 125.743 }, { start: 95.743, end: 110.743 })).toBe(false);
  });

  it("retracts ONE cue card per event across a multi-goal run (no collateral)", async () => {
    const h = harness();
    const deltaB: ScoreboardDeltaEvidence = {
      pre: [2, 1],
      post: [3, 1],
      preTs: 211.2,
      postTs: 212.743,
      deltaTs: 212.743,
      preSamples: 12,
      postSamples: 9,
    };
    // Event A: cue 96.500 then the measured transition 102.743.
    await h.accept(96.5, celebrationRead(), { lo: 86.5, hi: 96.5 });
    await h.accept(102.743, celebrationRead(), {
      candidateExtra: { scoreBoardDelta: LEG_GOAL_DELTA, scoreBoardChanged: true },
      lo: 92.743,
      hi: 102.743,
    });
    // Event B: cue 206.500 then the measured transition 212.743.
    await h.accept(206.5, celebrationRead(), { lo: 196.5, hi: 206.5 });
    await h.accept(212.743, celebrationRead(), {
      candidateExtra: { scoreBoardDelta: deltaB, scoreBoardChanged: true },
      lo: 202.743,
      hi: 212.743,
    });
    // One card per event: both goal cards, both cues withdrawn.
    expect(h.run.highlights).toHaveLength(2);
    expect(h.run.highlights.map((r) => Math.round(r.localizedTs))).toEqual([103, 213]);
    expect(h.retractions).toHaveLength(2);
    for (const card of h.run.highlights) {
      const ts = card.localizedTs as number;
      expect(card.start).toBeLessThanOrEqual(ts);
      expect(card.end).toBeGreaterThanOrEqual(ts);
      expect(card.end - card.start).toBeCloseTo(D, 6);
    }
    const ledger = h.run.rowAccounting(h.run.highlights.length);
    expect(ledger).toEqual({
      acceptedWindows: 2,
      persistedRows: 2,
      servedCards: 2,
      suppressedWindows: 0,
      demotedCelebrations: 2,
      retractedCards: 2,
    });
    // The retractions name the CUE rows (not the goal rows that replaced them).
    expect(h.retractions.map((r) => Math.round(r.cueTs))).toEqual([97, 207]);
  });
});

describe("ADAAAA-8740 AC3 — no regression", () => {
  it("a lone reaction row keeps celebration_tail at cue >= d - 2.5 (QA leg shape)", () => {
    const group = placeLiveEventGroupClipWindows({
      rows: [{ localizedTs: 96.5, anchorReason: "peak_audio_reaction", window: nominal(96.5) }],
      live: true,
    });
    const placed = group.rows[0].placed!;
    expect(placed.reason).toBe("celebration_tail");
    expect(placed.cueOffsetSec).toBeCloseTo(D - CELEBRATION_TAIL_S, 6);
    expect(placed.cueOffsetSec).toBeGreaterThanOrEqual(D - 2.5);
    expect(placed.celebrationOffsetSec).toBeCloseTo(13, 6);
  });

  it("203 measured_transition rows keep ACC-2 at 0.467 d", () => {
    const rows: ClipEventGroupRow[] = Array.from({ length: 203 }, (_, i) => {
      const cue = 30 + i * 7.317;
      return { localizedTs: cue, anchorReason: "measured_transition", window: nominal(cue) };
    });
    const group = placeLiveEventGroupClipWindows({ rows, live: true });
    expect(group.cards).toHaveLength(203);
    const atAcc2 = group.cards.filter((c) => Math.abs((c.start + 7 - c.start) - 7) < 1e-9 && c.reason === "goal_anchor");
    expect(atAcc2.length).toBe(203);
    for (const c of group.cards) {
      const row = rows[c.rowIndex];
      // Goal instant at 0.467 d, card unchanged, length preserved.
      expect(row.localizedTs - c.start).toBeCloseTo(7, 6);
      expect(c.end - c.start).toBeCloseTo(D, 6);
    }
    expect(group.suppressed).toHaveLength(0);
  });

  it("0 rows place a known goal instant outside the card (gap sweep)", () => {
    for (const gap of [-14, -9, -5, 0, 1, 2, 2.5, 4.243, 6.243, 9, 12, 14.9]) {
      const cue = 300;
      const goalTs = cue + gap;
      const group = placeLiveEventGroupClipWindows({
        rows: [{ localizedTs: cue, anchorReason: "peak_audio_reaction", window: nominal(cue) }],
        goalTs,
        live: true,
      });
      const card = group.cards[0];
      expect(group.suppressed).toHaveLength(0);
      expect(card.start).toBeLessThanOrEqual(goalTs);
      expect(card.end).toBeGreaterThanOrEqual(goalTs);
      expect(card.end - card.start).toBeCloseTo(D, 6);
    }
  });

  it("leaves the VOD posture byte-identical (live: false never groups)", () => {
    const rows: ClipEventGroupRow[] = [
      legRow(LEG.cue),
      legRow(LEG.goal),
      { localizedTs: 400, anchorReason: "trigger_evidence", window: nominal(400) },
    ];
    const vod = placeLiveEventGroupClipWindows({ rows, live: false });
    expect(vod.suppressed).toHaveLength(0);
    const live = placeLiveEventGroupClipWindows({ rows, live: true });
    expect(live.suppressed).toHaveLength(1);
    // VOD still centres the nominal window and reports evidence_anchor.
    expect(vod.rows[2].placed!.reason).toBe("evidence_anchor");
    expect(vod.rows[2].placed!.start).toBeCloseTo(nominal(400).start, 6);
    const vodRow = placeLiveClipWindow({
      localizedTs: 400,
      anchorReason: "trigger_evidence",
      window: nominal(400),
      live: false,
    });
    expect(vod.rows[2].placed).toEqual(vodRow);
  });
});
