import { describe, expect, it } from "vitest";
import { HighlightRecordSchema, type HighlightRecord } from "@highlights/events";
import { isAcceptedHighlight, type DecisionResult } from "../src/analyzer";
import {
  buildPostableHighlights,
  hasContradictingVerdict,
  isGoalRefutingReason,
  isPostableHighlight,
  windowsOverlap,
} from "../src/highlight-postable";

// ADAAAA-7621: precision gate (scoring_play only) + rejected exclusion +
// overlap dedupe for the postable highlight list. Regression source: the
// ADAAAA-7620 review of VOD job d61e52f6 (24 GOAL-typed clips, 1 rejected,
// 2 self-contradicting accepts, 6 overlapping windows => 18 unique moments).

const JOB = "d61e52f6-7569-4757-bffc-f56d03e10b6a";

function hl(over: Partial<HighlightRecord> & { start: number }): HighlightRecord {
  const { start, ...rest } = over;
  return HighlightRecordSchema.parse({
    id: `hl-${start}`,
    jobId: JOB,
    clipUri: `/clips/hl-${start}.mp4`,
    start,
    end: start + 15,
    eventType: "GOAL",
    score: 100,
    reason: "The ball clearly enters the net after a strike by the player in the blue jersey.",
    outcome: "scoring_play",
    status: "accepted",
    createdAt: "2026-10-31T14:30:00.000Z",
    ...rest,
  });
}

/**
 * The 24 persisted highlight windows of job d61e52f6, as measured on the
 * deployed box (start/end/score/status/verdict). The two score-60 entries carry
 * the real refuting verdict text; the rest are clean accepts.
 */
const D61_WINDOWS: {
  start: number;
  end: number;
  score: number;
  status: "accepted" | "rejected" | "pending";
  goalConfirmed?: "confirmed_goal" | "near_miss" | "not_goal";
  reason?: string;
  corroborated?: boolean;
  corroborationSource?: "audio_text" | "scoreboard";
}[] = [
  { start: 31.3, end: 46.3, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 69.5, end: 84.5, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 115.6, end: 130.6, score: 100, status: "accepted" },
  {
    start: 141.2,
    end: 156.2,
    score: 60,
    status: "accepted",
    goalConfirmed: "confirmed_goal",
    reason:
      "The ball is seen moving towards the goal but does not enter the net; it appears to be a shot that misses or is saved.; outcome=near_miss is not a scoring highlight; confirmation pass: goal confirmed (deep frame dive)",
  },
  { start: 171.1, end: 186.1, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 245.6, end: 260.6, score: 100, status: "rejected" },
  { start: 273.9, end: 288.9, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 341.8, end: 356.8, score: 95, status: "accepted" },
  { start: 351.8, end: 366.8, score: 95, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 359.2, end: 374.2, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 394.7, end: 409.7, score: 95, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 410.3, end: 425.3, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 457.7, end: 472.7, score: 85, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 565.8, end: 580.8, score: 100, status: "accepted" },
  { start: 579.4, end: 594.4, score: 100, status: "accepted", goalConfirmed: "confirmed_goal", corroborated: true, corroborationSource: "scoreboard" },
  { start: 601.1, end: 616.1, score: 85, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 629.6, end: 644.6, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 660.2, end: 675.2, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 678.2, end: 693.2, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  {
    start: 688.6,
    end: 703.6,
    score: 60,
    status: "accepted",
    goalConfirmed: "confirmed_goal",
    reason:
      "The ball is clearly seen being kicked and moving towards the goal, but it does not enter the net; it appears to be a shot that misses or is saved.; outcome=near_miss is not a scoring highlight",
  },
  { start: 701.0, end: 716.0, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 717.3, end: 732.3, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 755.0, end: 770.0, score: 95, status: "accepted", goalConfirmed: "confirmed_goal", corroborated: true },
  { start: 765.1, end: 780.1, score: 95, status: "accepted", goalConfirmed: "confirmed_goal", corroborated: true },
];

function d61Highlights(): HighlightRecord[] {
  return D61_WINDOWS.map((w) =>
    hl({
      start: w.start,
      end: w.end,
      score: w.score,
      status: w.status,
      goalConfirmed: w.goalConfirmed,
      reason: w.reason,
      corroborated: w.corroborated,
      corroborationSource: w.corroborationSource,
    })
  );
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
