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
