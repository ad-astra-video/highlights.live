import { describe, expect, it } from "vitest";
import { HighlightRecordSchema, type HighlightRecord } from "@highlights/events";
import { isAcceptedHighlight, type DecisionResult } from "../src/analyzer";
import {
  buildPostableHighlights,
  clipQuotaDelta,
  dedupedClipTotals,
  hasContradictingVerdict,
  isGoalRefutingReason,
  isPostableHighlight,
  postableCountFields,
  quotaDeltaForInsert,
  quotaMomentCount,
  windowsOverlap,
} from "../src/highlight-postable";
import { D61_JOB, d61Highlight, d61Highlights } from "./fixtures/d61-highlights";

// ADAAAA-7621: precision gate (scoring_play only) + rejected exclusion +
// overlap dedupe for the postable highlight list. Regression source: the
// ADAAAA-7620 review of VOD job d61e52f6 (24 GOAL-typed clips, 1 rejected,
// 2 self-contradicting accepts, 6 overlapping windows => 18 unique moments).

// ADAAAA-7854: the 24 measured rows of d61e52f6 now live in one shared fixture so
// the postable-gate tests and the clip-count tests assert against the same data.
const JOB = D61_JOB;

/** One persisted d61 row (defaults: accepted scoring_play, end = start + 15). */
function hl(over: Partial<HighlightRecord> & { start: number }): HighlightRecord {
  return d61Highlight(over);
}


describe("isAcceptedHighlight (ADAAAA-7621 precision gate)", () => {
  // The literal acceptance fixture: a GOAL-typed candidate whose verdict is
  // near_miss must not be accepted, whatever eventType says.
  it("rejects a GOAL-typed candidate whose verdict is near_miss", () => {
    const d: DecisionResult = {
      isHighlight: true,
      score: 60,
      eventType: "GOAL",
      outcome: "near_miss",
      nearMiss: true,
      reason: "The ball is clearly seen being kicked but it does not enter the net.",
    };
    expect(isAcceptedHighlight(d)).toBe(false);
    expect(isAcceptedHighlight(d, ["goals"])).toBe(false);
    // Still exportable when the job explicitly asked for near misses.
    expect(isAcceptedHighlight(d, ["near-misses"])).toBe(true);
  });

  it("rejects a scoring_play verdict whose own reason refutes the goal", () => {
    const d: DecisionResult = {
      isHighlight: true,
      score: 60,
      eventType: "GOAL",
      outcome: "scoring_play",
      reason:
        "The ball is seen moving towards the goal but does not enter the net; it appears to be a shot that misses or is saved.; outcome=near_miss is not a scoring highlight; confirmation pass: goal confirmed (deep frame dive)",
    };
    expect(isAcceptedHighlight(d)).toBe(false);
  });

  it("accepts a clean scoring_play verdict", () => {
    const d: DecisionResult = {
      isHighlight: true,
      score: 100,
      eventType: "GOAL",
      outcome: "scoring_play",
      reason: "The ball clearly enters the net after a strike, and the goalkeeper is beaten.",
    };
    expect(isAcceptedHighlight(d)).toBe(true);
  });

  it("keeps legacy verdicts (no outcome) on their isHighlight flag", () => {
    expect(isAcceptedHighlight({ isHighlight: true, score: 80 })).toBe(true);
    expect(isAcceptedHighlight({ isHighlight: false, score: 80 })).toBe(false);
  });
});

describe("isGoalRefutingReason", () => {
  it("matches refutations and ignores genuine accepts", () => {
    expect(isGoalRefutingReason("the ball does not enter the net")).toBe(true);
    expect(isGoalRefutingReason("the ball didn't cross into the goal")).toBe(true);
    expect(isGoalRefutingReason("outcome=near_miss is not a scoring highlight")).toBe(true);
    expect(isGoalRefutingReason("no goal was scored here")).toBe(true);
    expect(isGoalRefutingReason("The ball clearly enters the net and the goalkeeper is beaten.")).toBe(false);
    expect(isGoalRefutingReason("scoreboard score change confirmed")).toBe(false);
    expect(isGoalRefutingReason(undefined)).toBe(false);
  });
});

describe("isPostableHighlight / hasContradictingVerdict", () => {
  it("excludes rejected, non-scoring and self-contradicting records", () => {
    expect(isPostableHighlight(hl({ start: 10 }))).toBe(true);
    expect(isPostableHighlight(hl({ start: 10, status: "rejected" }))).toBe(false);
    expect(isPostableHighlight(hl({ start: 10, status: "pending" }))).toBe(true);
    expect(isPostableHighlight(hl({ start: 10, outcome: "near_miss" }))).toBe(false);
    expect(isPostableHighlight(hl({ start: 10, outcome: "big_play" }))).toBe(false);
    // A GOAL-typed record whose own verdict is near_miss.
    expect(isPostableHighlight(hl({ start: 10, eventType: "GOAL", outcome: "near_miss" }))).toBe(false);
    expect(hasContradictingVerdict(hl({ start: 10, goalConfirmed: "near_miss" }))).toBe(true);
    expect(hasContradictingVerdict(hl({ start: 10, goalConfirmed: "not_goal" }))).toBe(true);
  });
});

describe("windowsOverlap", () => {
  it("overlaps shared footage but not touching/adjacent windows", () => {
    expect(windowsOverlap({ start: 10, end: 25 }, { start: 20, end: 35 })).toBe(true);
    expect(windowsOverlap({ start: 10, end: 25 }, { start: 25, end: 40 })).toBe(false);
    expect(windowsOverlap({ start: 10, end: 25 }, { start: 25.6, end: 40 })).toBe(false);
  });
});

describe("buildPostableHighlights (rejected exclusion + precision gate)", () => {
  it("drops rejected clips and keeps the notable non-goal lane separate", () => {
    const list = [
      hl({ start: 10 }),
      hl({ start: 100, status: "rejected" }),
      hl({ start: 200, outcome: "near_miss", eventType: "NEAR_MISS", nearMiss: true }),
      hl({ start: 300, outcome: "near_miss", eventType: "GOAL" }), // GOAL-typed, verdict near_miss
      hl({ start: 400, outcome: "not_highlight" }),
    ];
    const out = buildPostableHighlights(list);
    expect(out.highlights.map((h) => h.id)).toEqual(["hl-10"]);
    expect(out.notable.map((h) => h.id)).toEqual(["hl-200", "hl-300"]);
    expect(out.counts).toMatchObject({ total: 5, rejected: 1, notScoring: 3, contradicting: 0, postable: 1, merged: 0 });
    // A GOAL label can never ride the postable list off a near_miss verdict.
    expect(out.highlights.every((h) => h.outcome === "scoring_play")).toBe(true);
    expect(out.notable.every((h) => h.outcome !== "scoring_play")).toBe(true);
  });

  it("drops a scoring_play whose own verdict contradicts the goal", () => {
    const list = [
      hl({ start: 10 }),
      hl({ start: 100, score: 60, reason: "The ball is seen moving towards the goal but does not enter the net." }),
      hl({ start: 300, score: 100, goalConfirmed: "not_goal" }),
    ];
    const out = buildPostableHighlights(list);
    expect(out.highlights.map((h) => h.id)).toEqual(["hl-10"]);
    expect(out.counts.contradicting).toBe(2);
  });
});

describe("buildPostableHighlights (overlap dedupe)", () => {
  it("merges overlapping windows into one moment, keeping the highest score", () => {
    const list = [
      hl({ start: 100, end: 115, score: 70 }),
      hl({ start: 104, end: 119, score: 95 }),
      hl({ start: 108, end: 123, score: 60 }),
      hl({ start: 300, end: 315, score: 90 }),
    ];
    const out = buildPostableHighlights(list);
    expect(out.highlights.length).toBe(2);
    const moment = out.highlights.find((h) => windowsOverlap(h, { start: 104, end: 119 }))!;
    expect(moment.score).toBe(95); // highest score owns the footage
    expect(moment.duplicateCount).toBe(2);
    expect(moment.mergedIds).toEqual(["hl-100", "hl-108"]);
    expect(out.duplicates.map((h) => h.duplicateOf)).toEqual([moment.id, moment.id]);
    // No two postable windows overlap.
    for (const a of out.highlights) for (const b of out.highlights) {
      if (a.id !== b.id) expect(windowsOverlap(a, b)).toBe(false);
    }
  });

  it("prefers the corroborated clip at equal score and does not merge adjacent moments", () => {
    const list = [
      hl({ start: 100, end: 115, score: 95 }),
      hl({ start: 110, end: 125, score: 95, corroborated: true, corroborationSource: "scoreboard" }),
      // Adjacent, not overlapping: stays a separate moment.
      hl({ start: 125, end: 140, score: 95 }),
    ];
    const out = buildPostableHighlights(list);
    expect(out.highlights.map((h) => h.start)).toEqual([110, 125]);
    expect(out.highlights[0].duplicateCount).toBe(1);
    expect(out.highlights[1].duplicateCount).toBeUndefined();
  });

  it("a rejected or contradicting clip never absorbs a good one as its duplicate", () => {
    const list = [
      hl({ start: 100, end: 115, status: "rejected", score: 100 }),
      hl({ start: 104, end: 119, score: 90, reason: "does not enter the net" }),
      hl({ start: 108, end: 123, score: 85 }),
    ];
    const out = buildPostableHighlights(list);
    expect(out.highlights.map((h) => h.id)).toEqual(["hl-108"]);
    expect(out.highlights[0].duplicateCount).toBeUndefined();
    expect(out.duplicates).toEqual([]);
  });

  it("is pure: the persisted records are not mutated", () => {
    const list = [hl({ start: 100, end: 115, score: 70 }), hl({ start: 104, end: 119, score: 95 })];
    const snapshot = JSON.parse(JSON.stringify(list));
    const out = buildPostableHighlights(list);
    expect(list).toEqual(snapshot);
    expect(out.highlights[0]).not.toBe(list[1]);
  });
});

describe("d61e52f6 regression (ADAAAA-7620 review)", () => {
  const out = buildPostableHighlights(d61Highlights());

  it("excludes the rejected clip and the 2 self-contradicting accepts", () => {
    const ids = out.highlights.map((h) => h.id);
    expect(ids).not.toContain("hl-245.6"); // status: rejected
    expect(ids).not.toContain("hl-141.2"); // own read: "does not enter the net"
    expect(ids).not.toContain("hl-688.6"); // own read: "does not enter the net"
    expect(out.counts).toMatchObject({ total: 24, rejected: 1, notScoring: 0, contradicting: 2 });
  });

  it("yields a postable list with zero overlapping windows", () => {
    const hl = out.highlights;
    expect(hl.length).toBe(17); // 24 raw -> -1 rejected -2 contradicting -4 merged
    for (const a of hl) for (const b of hl) {
      if (a.id !== b.id) expect(windowsOverlap(a, b)).toBe(false);
    }
    // Sorted-by-time projection for a human skim.
    expect(hl.map((h) => h.start).sort((a, b) => a - b)).toEqual([
      31.3, 69.5, 115.6, 171.1, 273.9, 359.2, 394.7, 410.3, 457.7, 579.4, 601.1, 629.6, 660.2, 678.2, 701, 717.3, 755,
    ]);
  });

  it("exposes duplicateCount on merged moments and duplicateOf on the merged-away clips", () => {
    const merged = out.highlights.filter((h) => (h.duplicateCount ?? 0) > 0);
    expect(merged.map((h) => [h.start, h.duplicateCount])).toEqual([
      [359.2, 2], // 341.8 + 351.8 merged into the score-100 window
      [579.4, 1], // 565.8 merged (winner corroborated)
      [755, 1], // 765.1 merged (tie -> earlier window wins)
    ]);
    expect(out.duplicates.length).toBe(4);
    expect(out.duplicates.map((h) => h.start).sort((a, b) => a - b)).toEqual([341.8, 351.8, 565.8, 765.1]);
    for (const d of out.duplicates) expect(merged.some((m) => m.id === d.duplicateOf)).toBe(true);
  });

  it("no postable clip carries a self-contradicting reason", () => {
    expect(out.highlights.filter((h) => hasContradictingVerdict(h))).toEqual([]);
    expect(out.highlights.every((h) => h.outcome === "scoring_play")).toBe(true);
  });
});

// ADAAAA-7854: the clip COUNT projection. User-facing totals must be the deduped
// postable moment count; raw rows stay the audit total. These assertions are the
// numbers the Highlights tile, the job payload and admin analytics ship.
describe("clip counts (ADAAAA-7854)", () => {
  it("projects d61e52f6 as 24 raw rows / 17 postable moments / 4 merged", () => {
    const counts = postableCountFields(d61Highlights());
    expect(counts).toEqual({
      rawHighlights: 24,
      postableHighlights: 17,
      mergedHighlights: 4,
      rejectedHighlights: 1,
      notScoringHighlights: 0,
      contradictingHighlights: 2,
    });
    // The count is a projection of the same pass that builds the list.
    const out = buildPostableHighlights(d61Highlights());
    expect(counts.postableHighlights).toBe(out.highlights.length);
    expect(counts.mergedHighlights).toBe(out.duplicates.length);
    // Raw - postable = merged + rejected + contradicting: nothing vanishes.
    expect(counts.rawHighlights - counts.postableHighlights).toBe(
      counts.mergedHighlights + counts.rejectedHighlights + counts.notScoringHighlights + counts.contradictingHighlights
    );
  });

  it("dedupes per job: identical windows on two different jobs are two moments", () => {
    const list = [...d61Highlights("job-a"), ...d61Highlights("job-b")];
    const totals = dedupedClipTotals(list);
    expect(totals).toEqual({ raw: 48, postable: 34 });
  });

  it("orders the quota debit by MOMENTS, not by rows", () => {
    // A new moment debits one slot; nothing new merged away debits nothing.
    expect(clipQuotaDelta(0, 1)).toEqual({ debit: 1, refund: 0 });
    expect(clipQuotaDelta(1, 1)).toEqual({ debit: 0, refund: 0 });
    // Bridging two moments into one releases the absorbed slot.
    expect(clipQuotaDelta(2, 1)).toEqual({ debit: 0, refund: 1 });

    // The insert-level helper makes the arrival order irrelevant: a clip that
    // overlaps an existing one never debits, whichever of the two lands first.
    const dupRows = [hl({ start: 100, end: 115, score: 90 }), hl({ start: 104, end: 119, score: 95 })];
    expect(quotaDeltaForInsert([], [dupRows[0]])).toEqual({ debit: 1, refund: 0 });
    expect(quotaDeltaForInsert([dupRows[0]], dupRows)).toEqual({ debit: 0, refund: 0 });
    expect(quotaDeltaForInsert([dupRows[1]], dupRows)).toEqual({ debit: 0, refund: 0 });
    // Two adjacent (non-overlapping) clips are two moments: 2 slots.
    expect(quotaDeltaForInsert([hl({ start: 100, end: 115 })], [hl({ start: 100, end: 115 }), hl({ start: 200, end: 215 })])).toEqual({
      debit: 1,
      refund: 0,
    });
    // The d61 job's 24 rows hold 17 quota moments (same collapse as the list).
    expect(quotaMomentCount(d61Highlights())).toBe(17);
  });
});

// ADAAAA-8199: the LIVE read-side merge. Regression source: jobs `58aafd8e` /
// `9d7ab76c` (funded 2-stream `file-sim` leg of `kids300_7935.mp4`, GT goals at
// 100 s and 159 s). On the served build `b07f9b9` the confirmed GOAL row and the
// provisional celebration for the SAME transition shipped as two rows, because
// `buildPostableHighlights` admitted only `scoring_play` into the overlap cluster
// and the celebration lanes are never candidates. The rows below are the stored
// ones (created_at, windows and markers verbatim); the read projection is what
// the board and the clip counts must show.
const PROVISIONAL_NOTE =
  "provisional goal: asr_goal_call in the judged window, no measured scoreboard change yet - " +
  "the row is a celebration until a later score read measures the transition (then it becomes the confirmed GOAL).";

function celebration(over: Partial<HighlightRecord> & { start: number }): HighlightRecord {
  return d61Highlight(
    {
      outcome: "big_play",
      eventType: "BIG_PLAY",
      score: 85,
      reason: PROVISIONAL_NOTE,
      provisionalGoal: { status: "provisional", cues: ["asr_goal_call"], declaredTs: over.start + 7, note: PROVISIONAL_NOTE },
      ...over,
    },
    "58aafd8e-75af-4971-9170-78a4f7cc53e5"
  );
}

function confirmedGoal(over: Partial<HighlightRecord> & { start: number }): HighlightRecord {
  return d61Highlight(
    {
      outcome: "scoring_play",
      eventType: "GOAL",
      score: 85,
      ...over,
    },
    "58aafd8e-75af-4971-9170-78a4f7cc53e5"
  );
}

describe("buildPostableHighlights (ADAAAA-8199 celebration absorption)", () => {
  // The two GOAL+celebration pairs measured on 58aafd8e, plus the three tail
  // rows (score-steady / backward-read true negatives at the clip loop boundary).
  const measuredLeg = (): HighlightRecord[] => [
    celebration({ id: "ff95095e", start: 93, end: 108 }), // provisional @100
    confirmedGoal({ id: "0b334e6c", start: 102, end: 117 }), // confirmed @115
    celebration({ id: "2b394fff", start: 154.7, end: 169.7 }), // provisional @160
    confirmedGoal({ id: "20135897", start: 154, end: 169 }), // confirmed @165
    celebration({ id: "e5f8246a", start: 293, end: 308 }), // tail: not provisional
    celebration({ id: "94ff5875", start: 295, end: 310 }),
    celebration({ id: "35987657", start: 307.7, end: 322.7 }),
  ];

  it("ships ONE postable GOAL per transition and absorbs the celebration into it", () => {
    const out = buildPostableHighlights(measuredLeg());
    // Two true goals, two postable rows - not two goals plus two celebration cards.
    expect(out.highlights.map((h) => [h.id, h.outcome])).toEqual([
      ["0b334e6c", "scoring_play"],
      ["20135897", "scoring_play"],
    ]);
    // The celebrations left the notable lane and are auditable as duplicates.
    expect(out.notable.map((h) => h.id)).toEqual(["e5f8246a", "94ff5875", "35987657"]);
    expect(out.duplicates.map((h) => [h.id, h.duplicateOf])).toEqual([
      ["ff95095e", "0b334e6c"],
      ["2b394fff", "20135897"],
    ]);
    // AC2 audit trail: the merge is reported, not 0-by-construction.
    expect(out.highlights.map((h) => [h.id, h.duplicateCount, h.mergedIds])).toEqual([
      ["0b334e6c", 1, ["ff95095e"]],
      ["20135897", 1, ["2b394fff"]],
    ]);
    expect(out.counts).toMatchObject({ total: 7, postable: 2, merged: 2, notScoring: 3, rejected: 0, contradicting: 0 });
    // The count identity still holds (nothing counted twice or lost).
    expect(out.counts.total - out.counts.postable).toBe(
      out.counts.merged + out.counts.rejected + out.counts.notScoring + out.counts.contradicting
    );
  });

  it("keeps a true non-goal notable row even when its window overlaps a GOAL (AC3)", () => {
    const out = buildPostableHighlights([
      confirmedGoal({ id: "goal-x", start: 100, end: 115 }),
      // A genuine big play (no provisional marker, no GOAL label) inside the
      // goal window: it is NOT a celebration of the same transition.
      d61Highlight({ id: "bigplay-x", start: 104, end: 119, outcome: "big_play", eventType: "BIG_PLAY", score: 80 }),
      // A near miss inside the window: still notable, never absorbed.
      d61Highlight({ id: "near-x", start: 106, end: 121, outcome: "near_miss", eventType: "NEAR_MISS", score: 60 }),
    ]);
    expect(out.highlights.map((h) => h.id)).toEqual(["goal-x"]);
    expect(out.notable.map((h) => h.id)).toEqual(["bigplay-x", "near-x"]);
    expect(out.duplicates).toEqual([]);
    expect(out.highlights[0].duplicateCount).toBeUndefined();
  });

  it("does not absorb a provisional celebration that overlaps no confirmed GOAL", () => {
    const out = buildPostableHighlights([
      celebration({ id: "prov-alone", start: 400, end: 415 }),
      confirmedGoal({ id: "goal-far", start: 500, end: 515 }),
    ]);
    expect(out.highlights.map((h) => h.id)).toEqual(["goal-far"]);
    expect(out.notable.map((h) => h.id)).toEqual(["prov-alone"]);
    expect(out.duplicates).toEqual([]);
  });

  it("is ordering-independent: the celebration may be stored before OR after the GOAL (AC4)", () => {
    const rows = measuredLeg();
    const forward = buildPostableHighlights(rows);
    const reversed = buildPostableHighlights([...rows].reverse());
    expect(reversed.highlights.map((h) => h.id)).toEqual(forward.highlights.map((h) => h.id));
    expect(reversed.duplicates.map((h) => h.id).sort()).toEqual(forward.duplicates.map((h) => h.id).sort());
  });

  it("drops the provisional marker from an absorbed celebration (AC6) without mutating the stored row", () => {
    const rows = measuredLeg();
    const out = buildPostableHighlights(rows);
    // The surviving GOAL cards speak for the transition: no "GOAL (unconfirmed)".
    for (const h of out.highlights) expect(h.provisionalGoal).toBeUndefined();
    // Neither does the merged-lane copy of the celebration it absorbed.
    for (const d of out.duplicates) {
      expect(d.provisionalGoal).toBeUndefined();
      expect(d.duplicateOf).toBeTruthy();
    }
    // The persisted rows keep their marker — the projection is what clears it.
    const stored = rows.find((r) => r.id === "ff95095e");
    expect(stored?.provisionalGoal?.status).toBe("provisional");
  });
});

// ADAAAA-8155: one surfaced item per real goal transition on the provisional
// lane. Regression source: job b5de5a9a-2f14-42e8-b5ea-64b156c06906 (QA leg on
// the served ADAAAA-8139 build 8842f3c), where the board rendered the accepted
// GOAL card `8508f8a1` (scoring_play, span 52.985-67.985 s, judged transition
// 2-1 going to 2-2) AND a "GOAL (unconfirmed)" notable row `f48cafec`
// (BIG_PLAY/big_play, span 57.699-72.699 s, provisionalGoal.declaredTs
// 64.612 s) for the SAME transition. The rows below are the stored ones
// verbatim; only the read projection changes.
const BF_JOB = "b5de5a9a-2f14-42e8-b5ea-64b156c06906";
const BF_ACCEPTED_START = 52.984999895095825;
const BF_ACCEPTED_END = 67.98499989509583;
const BF_DEMOTED_START = 57.698999881744385;
const BF_DEMOTED_END = 72.69899988174438;
const BF_JUDGED_TS = 64.61199998855591;
const BF_PROVISIONAL_NOTE =
  "provisional goal: frame_celebration in the judged window, no measured scoreboard change yet - " +
  "the row is a celebration until a later score read measures the transition (then it becomes the confirmed GOAL).";

/** The accepted GOAL of the measured transition on b5de5a9a. */
function bfAcceptedGoal(over: Partial<HighlightRecord> = {}): HighlightRecord {
  return d61Highlight(
    {
      id: "8508f8a1",
      start: BF_ACCEPTED_START,
      end: BF_ACCEPTED_END,
      score: 95,
      eventType: "GOAL",
      outcome: "scoring_play",
      ...over,
    },
    BF_JOB
  );
}

/** The demoted provisional row of the same transition (window defaults to the
 * stored one; override `start`/`end` for the localized-away-clip shape). */
function bfDemoted(over: Partial<HighlightRecord> = {}): HighlightRecord {
  return d61Highlight(
    {
      id: "f48cafec",
      start: BF_DEMOTED_START,
      end: BF_DEMOTED_END,
      score: 85,
      eventType: "BIG_PLAY",
      outcome: "big_play",
      reason: BF_PROVISIONAL_NOTE,
      provisionalGoal: {
        status: "provisional",
        cues: ["frame_celebration"],
        declaredTs: BF_JUDGED_TS,
        note: BF_PROVISIONAL_NOTE,
      },
      ...over,
    },
    BF_JOB
  );
}

/** The job's kick-off row, so the measured leg keeps its stored shape. */
function bfKickoff(): HighlightRecord {
  return d61Highlight({ id: "a13f8db5", start: 0, end: 15, score: 95, eventType: "GOAL" }, BF_JOB);
}

describe("buildPostableHighlights (ADAAAA-8155 covering accepted GOAL)", () => {
  const surfaced = (out: ReturnType<typeof buildPostableHighlights>): HighlightRecord[] => [
    ...out.highlights,
    ...out.notable,
    ...out.duplicates,
  ];

  it("AC-1: the measured b5de5a9a duplicate ships no second 'GOAL (unconfirmed)' row", () => {
    const rows = [bfKickoff(), bfAcceptedGoal(), bfDemoted()];
    const out = buildPostableHighlights(rows);
    // The transition has ONE surfaced goal row, and it is the accepted GOAL.
    expect(out.highlights.map((h) => h.id)).toEqual(["a13f8db5", "8508f8a1"]);
    // The demoted row is the same moment: absorbed, not a second notable card.
    expect(out.notable).toEqual([]);
    expect(out.duplicates.map((h) => [h.id, h.duplicateOf])).toEqual([["f48cafec", "8508f8a1"]]);
    // Nothing surfaced for the transition prints the provisional marker.
    for (const h of surfaced(out)) expect(h.provisionalGoal).toBeUndefined();
    // The stored row keeps its marker (projection only, never a mutation).
    expect(rows[2].provisionalGoal?.status).toBe("provisional");
    expect(out.counts).toMatchObject({ total: 3, postable: 2, merged: 1, notScoring: 0, rejected: 0, contradicting: 0 });
  });

  it("AC-1: clears the marker when the accepted GOAL covers the judged instant but the clips do not overlap", () => {
    // The localized clip: the demoted row's window was moved off the instant the
    // window was judged at, so the ADAAAA-8199 overlap absorb cannot see it.
    const demoted = bfDemoted({ start: 70, end: 85 });
    const accepted = bfAcceptedGoal();
    expect(windowsOverlap(accepted, demoted)).toBe(false);
    const out = buildPostableHighlights([accepted, demoted]);
    expect(out.highlights.map((h) => h.id)).toEqual(["8508f8a1"]);
    expect(out.duplicates).toEqual([]);
    expect(out.notable.map((h) => h.id)).toEqual(["f48cafec"]);
    // ... but the judged instant 64.612 s IS inside the accepted 52.985-67.985 s
    // span, so the row no longer claims to be a second, unconfirmed goal.
    expect(out.notable[0].provisionalGoal).toBeUndefined();
    // Its own lane label survives: still a notable big play, not a goal.
    expect(out.notable[0].outcome).toBe("big_play");
    expect(out.notable[0].eventType).toBe("BIG_PLAY");
  });

  it("AC-1: an uncovered demoted row still renders the unconfirmed marker", () => {
    // No accepted GOAL anywhere near the judged instant.
    const farGoal = bfAcceptedGoal({ start: 300, end: 315 });
    const uncovered = buildPostableHighlights([farGoal, bfDemoted({ start: 70, end: 85 })]);
    expect(uncovered.notable.map((h) => h.id)).toEqual(["f48cafec"]);
    expect(uncovered.notable[0].provisionalGoal?.status).toBe("provisional");

    // Fail-closed at the boundary too: 0.6 s past the accepted clip's end is NOT
    // covered, so the marker stays. Coverage is strict containment, no tolerance.
    const boundary = buildPostableHighlights([
      bfAcceptedGoal(),
      bfDemoted({
        start: 70,
        end: 85,
        provisionalGoal: {
          status: "provisional",
          cues: ["frame_celebration"],
          declaredTs: BF_ACCEPTED_END + 0.6,
          note: BF_PROVISIONAL_NOTE,
        },
      }),
    ]);
    expect(boundary.notable[0].provisionalGoal?.status).toBe("provisional");
  });

  it("AC-2: never promotes the demoted row and never changes either row's outcome/eventType", () => {
    for (const demoted of [bfDemoted(), bfDemoted({ start: 70, end: 85 })]) {
      const accepted = bfAcceptedGoal();
      const out = buildPostableHighlights([accepted, demoted]);
      // The demoted row is never postable, with or without a covering GOAL.
      expect(out.highlights.map((h) => h.id)).not.toContain("f48cafec");
      expect(out.highlights.every((h) => h.outcome === "scoring_play")).toBe(true);
      expect(isPostableHighlight(demoted)).toBe(false);
      // Neither stored row was rewritten, and their labels are untouched.
      expect(accepted.outcome).toBe("scoring_play");
      expect(accepted.eventType).toBe("GOAL");
      expect(demoted.outcome).toBe("big_play");
      expect(demoted.eventType).toBe("BIG_PLAY");
      expect(demoted.provisionalGoal?.status).toBe("provisional");
    }
  });

  it("AC-2: the count identity is unchanged by the marker projection", () => {
    const covered = buildPostableHighlights([bfKickoff(), bfAcceptedGoal(), bfDemoted({ start: 70, end: 85 })]);
    const uncovered = buildPostableHighlights([
      bfKickoff(),
      bfAcceptedGoal({ start: 300, end: 315 }),
      bfDemoted({ start: 70, end: 85 }),
    ]);
    // Clearing a marker is not a merge: the row stays notable and the postable
    // count is the same as the uncovered shape.
    expect(covered.counts.postable).toBe(uncovered.counts.postable);
    expect(covered.counts.notScoring).toBe(uncovered.counts.notScoring);
    expect(covered.counts.merged).toBe(uncovered.counts.merged);
    for (const out of [covered, uncovered]) {
      expect(out.counts.total - out.counts.postable).toBe(
        out.counts.merged + out.counts.rejected + out.counts.notScoring + out.counts.contradicting
      );
    }
  });
});
