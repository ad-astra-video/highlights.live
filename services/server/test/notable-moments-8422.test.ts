import { describe, expect, it } from "vitest";
import {
  HighlightRecordSchema,
  MAX_NOTABLE_ALTERNATIVES_PER_HIGHLIGHT,
  NOTABLE_MOMENT_GAP_S,
  type HighlightRecord,
} from "@highlights/events";
import {
  anchorGapClusters,
  buildPostableHighlights,
  clusterNotableWindows,
  collapseOverlappingWindows,
  countsFromPostable,
  overlapChainClusters,
  windowsOverlap,
} from "../src/highlight-postable";

// ADAAAA-8422 (N1) + ADAAAA-8443 (N1b): unit fixtures for the notable moment
// projection.
//
// The notable lane used to ship one card per window because only postable
// candidates were clustered and clip options were only minted for an ACCEPTED
// scoring GOAL. Measured shape: live job b55c5781-7976-4777-905c-847a06f3d3a8
// carried 5 non-scoring windows that read as 5 cards where the board expects 2
// moments with 2 and 3 clip options.
//
// N1 grouped those rows by strict overlap and QA measured that it yields 4
// moments on the real geometry, not 2. N1b therefore groups the notable lane by
// ANCHOR GAP (`NOTABLE_MOMENT_GAP_S` = 40 s): a notable row is a 15 s window cut
// around one play, so proximity — not footage overlap — is what makes a moment.
//
// Every fixture below is a STORED row: the projection must turn clusters into
// moments without mutating a row, dropping footage or moving a count.

const JOB = "b55c5781-7976-4777-905c-847a06f3d3a8";
/** The notable rail contract after N1b: 1 owner + up to 3 options. */
const CAP = MAX_NOTABLE_ALTERNATIVES_PER_HIGHLIGHT;

/** One persisted non-scoring row (notable lane: near_miss / big_play). */
function row(id: string, start: number, end: number, over: Partial<HighlightRecord> = {}): HighlightRecord {
  return HighlightRecordSchema.parse({
    id,
    jobId: JOB,
    clipUri: `/clips/${id}.mp4`,
    start,
    end,
    eventType: "BIG_PLAY",
    score: 60,
    reason: "A player drives into the box and the keeper gathers the ball.",
    outcome: "big_play",
    status: "accepted",
    createdAt: "2026-11-08T14:20:09.000Z",
    ...over,
  });
}

/** The 15 s window a pipeline candidate is cut around. */
function window(id: string, start: number, over: Partial<HighlightRecord> = {}): HighlightRecord {
  return row(id, start, start + 15, over);
}

/**
 * N1b-AC1: the EXACT five windows QA measured on job b55c5781. The board's
 * reading ("the first two are clip options for the first highlight, the next
 * three for the second") is a proximity grouping:
 *   02e9bf4e 255.400-270.400  |  5f8d9d07 306.388-321.388   (35.988 s anchor gap)
 *   b7fb1898 685.135-700.135  |  128ab571 697.930-712.930   (2.205 s real overlap)
 *                             |  69118d51 725.182-740.182   (12.252 s after the chain)
 */
function measuredShape(): HighlightRecord[] {
  return [
    window("02e9bf4e", 255.4),
    window("5f8d9d07", 306.388),
    window("b7fb1898", 685.135),
    window("128ab571", 697.93),
    window("69118d51", 725.182),
  ];
}

/** The whole 14-row notable population of that job (QA's measured starts). */
const JOB_14_STARTS = [
  255.4, 306.388, 685.135, 697.93, 725.182, 1606.599, 1688.101, 1726.572, 1739.053, 1773.032,
  1791.165, 1886.044, 1907.079, 2033.314,
];

describe("N1b-AC1 — the measured 5 windows read as 2 moments of 2 and 3", () => {
  it("groups by anchor gap, not overlap: strict overlap would give 4 moments", () => {
    const rows = measuredShape();
    // Why N1 shipped the wrong grouping: only 128ab571/b7fb1898 overlap.
    expect(overlapChainClusters(rows).length).toBe(4);
    expect(windowsOverlap(rows[0], rows[1])).toBe(false);
    // ...and the gap rule gives the board's partition.
    const out = clusterNotableWindows(rows);
    expect(out.moments.length).toBe(2);
    expect(out.moments.map((m) => m.memberCount)).toEqual([2, 3]);
    expect(out.moments.map((m) => m.options.length)).toEqual([1, 2]);
    expect(out.optionsSuppressed).toBe(0);
  });

  it("quote the rendered membership: the ids the two cards carry", () => {
    const out = clusterNotableWindows(measuredShape());
    const membership = out.moments.map((m) => {
      const ids = [m.owner.id, ...m.options.map((o) => o.id)].sort();
      return { owner: m.owner.id, ids };
    });
    expect(membership).toEqual([
      { owner: "02e9bf4e", ids: ["02e9bf4e", "5f8d9d07"] },
      { owner: "b7fb1898", ids: ["128ab571", "69118d51", "b7fb1898"] },
    ]);
    // No footage dropped: every measured window is an owner or an option.
    const delivered = out.moments.flatMap((m) => [m.owner.id, ...m.options.map((o) => o.id)]);
    expect(delivered.sort()).toEqual(["02e9bf4e", "128ab571", "5f8d9d07", "69118d51", "b7fb1898"]);
    // Moments are time-ordered so the lane reads left to right.
    expect(out.moments.map((m) => m.owner.start)).toEqual([255.4, 685.135]);
  });

  it("the whole 14-row job reads as 6 moments [2,3,1,5,2,1]", () => {
    const out = clusterNotableWindows(JOB_14_STARTS.map((s, i) => window(`r${i}`, s)));
    expect(out.moments.map((m) => m.memberCount)).toEqual([2, 3, 1, 5, 2, 1]);
    // Cap 3: the 5-window moment shows 3 options and counts the 4th as suppressed.
    expect(out.moments.map((m) => m.options.length)).toEqual([1, 2, 0, 3, 1, 0]);
    expect(out.moments.map((m) => m.optionsSuppressed)).toEqual([0, 0, 0, 1, 0, 0]);
    expect(out.optionsSuppressed).toBe(1);
  });
});

describe("N1b-AC2 — cluster boundaries are gap-driven", () => {
  it("two 15 s windows 36 s apart cluster together", () => {
    const out = clusterNotableWindows([window("a", 10), window("b", 46)]);
    expect(out.moments.length).toBe(1);
    expect(out.moments[0].memberCount).toBe(2);
    // The measured first pair is 35.988 s apart and must also hold together.
    expect(clusterNotableWindows(measuredShape()).moments.length).toBe(2);
  });

  it("two windows 400 s apart do not cluster", () => {
    const out = clusterNotableWindows([window("a", 10), window("b", 410)]);
    expect(out.moments.length).toBe(2);
    expect(out.moments.every((m) => m.options.length === 0)).toBe(true);
  });

  it("a real overlap still clusters (and is not a special case)", () => {
    const out = clusterNotableWindows([window("a", 10), window("b", 18)]);
    expect(out.moments.length).toBe(1);
    expect(out.moments[0].options.map((o) => o.id)).toEqual(["b"]);
  });

  it("34 s past the cluster end is inside the gap, 40 s is outside", () => {
    // 10-25 then start 59 => distance 34 (< 40): one moment.
    expect(anchorGapClusters([window("a", 10), window("b", 59)]).length).toBe(1);
    // 10-25 then start 65 => distance 40 (not < 40): two moments.
    expect(anchorGapClusters([window("a", 10), window("b", 65)]).length).toBe(2);
  });

  it("the gap is the shipped constant, exported for QA to grade", () => {
    expect(NOTABLE_MOMENT_GAP_S).toBe(40);
    expect(CAP).toBe(3);
  });

  it("POSTABLE lane stays strict-overlap: touching windows are two moments", () => {
    // a.end === b.start: adjacent footage, not a duplicate.
    const rows = [row("a", 10, 25), row("b", 25, 40)];
    expect(windowsOverlap(rows[0], rows[1])).toBe(false);
    expect(overlapChainClusters(rows).length).toBe(2);
    const collapsed = collapseOverlappingWindows(rows);
    expect(collapsed.moments.length).toBe(2);
    expect(collapsed.merged).toBe(0);
    // The notable lane merges them: 0 s pivot, same play. Two lanes, two rules.
    expect(clusterNotableWindows(rows).moments.length).toBe(1);
  });
});

describe("N1b-AC4 — the notable rail carries 3 options and counts the overflow", () => {
  it("a 3-window moment carries 2 options and suppresses nothing", () => {
    const out = clusterNotableWindows(measuredShape());
    const second = out.moments[1];
    expect(second.memberCount).toBe(3);
    expect(second.options.length).toBe(2);
    expect(second.optionsSuppressed).toBe(0);
  });

  it("a 4-window moment fits exactly at the cap (3 options, 0 suppressed)", () => {
    const rows = [window("a", 10), window("b", 18), window("c", 26), window("d", 34)];
    const out = clusterNotableWindows(rows);
    expect(out.moments[0].memberCount).toBe(4);
    expect(out.moments[0].options.length).toBe(CAP);
    expect(out.moments[0].optionsSuppressed).toBe(0);
    expect(out.optionsSuppressed).toBe(0);
  });

  it("a 5-window moment shows 3 options and reports the suppressed row", () => {
    const rows = [window("a", 10), window("b", 18), window("c", 26), window("d", 34), window("e", 42)];
    const out = clusterNotableWindows(rows);
    expect(out.moments[0].memberCount).toBe(5);
    expect(out.moments[0].options.length).toBe(CAP);
    expect(out.moments[0].optionsSuppressed).toBe(1);
    expect(out.optionsSuppressed).toBe(1);
  });

  it("the cap is still overridable (unchanged call shape for the GOAL rail)", () => {
    const rows = [window("a", 10), window("b", 18), window("c", 26), window("d", 34)];
    const out = clusterNotableWindows(rows, 2);
    expect(out.moments[0].options.length).toBe(2);
    expect(out.moments[0].optionsSuppressed).toBe(1);
  });

  it("a single window stays a lone moment with no options (no rail)", () => {
    const out = clusterNotableWindows([window("solo", 100)]);
    expect(out.moments.length).toBe(1);
    expect(out.moments[0].options).toEqual([]);
    expect(out.moments[0].memberCount).toBe(1);
  });
});

describe("the card owner is the row whose footage the card shows", () => {
  it("clip beats a named cut failure, which beats no footage at all", () => {
    const rows = [
      // No cut AND no named failure: this row cannot render a card at all, so it
      // must never own the moment's footage.
      row("nocut", 10, 25, { clipUri: "" }),
      // A named cut failure renders a card, but it shows no footage — a sibling
      // that DID cut must own the moment.
      row("failed", 11, 26, { clipUri: "", clipError: "empty recording — the stream carried no frames" }),
      row("cut", 12, 27),
    ];
    const out = clusterNotableWindows(rows);
    expect(out.moments.length).toBe(1);
    expect(out.moments[0].owner.id).toBe("cut");
    expect(out.moments[0].options.map((o) => o.id)).toEqual(["nocut", "failed"]);
    // With no cut anywhere, the named failure still owns the card (it can say WHY).
    const onlyFailed = clusterNotableWindows([
      row("nocut", 10, 25, { clipUri: "" }),
      row("failed", 11, 26, { clipUri: "", clipError: "cut failed" }),
    ]);
    expect(onlyFailed.moments[0].owner.id).toBe("failed");
  });

  it("does not mutate the stored rows it clusters", () => {
    const rows = measuredShape();
    const before = JSON.stringify(rows);
    clusterNotableWindows(rows);
    anchorGapClusters(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("buildPostableHighlights — notable moments never add or drop rows (N1-AC3)", () => {
  it("groups the measured notable lane without moving a single count", () => {
    const rows = [
      ...measuredShape(),
      // A rejected window: never postable, never notable, never an option.
      row("rej", 100, 115, { status: "rejected" }),
    ];
    const out = buildPostableHighlights(rows);
    expect(out.counts).toEqual({
      total: 6,
      rejected: 1,
      notScoring: 5,
      contradicting: 0,
      postable: 0,
      merged: 0,
      // ADAAAA-8549: the attached-replay bucket is part of the row identity; on
      // this job it is (correctly) empty.
      replay: 0,
    });
    expect(countsFromPostable(out)).toEqual({
      rawHighlights: 6,
      postableHighlights: 0,
      mergedHighlights: 0,
      rejectedHighlights: 1,
      notScoringHighlights: 5,
      contradictingHighlights: 0,
      replayHighlights: 0,
    });
    // The flat notable lane is unchanged (same rows): the projection is the only
    // thing grouping.
    expect(out.notable.map((h) => h.id).sort()).toEqual(["02e9bf4e", "128ab571", "5f8d9d07", "69118d51", "b7fb1898"]);
    expect(out.notableMoments.moments.length).toBe(2);
    // Count identity still holds over the RAW total.
    expect(out.counts.total - out.counts.postable).toBe(
      out.counts.merged + out.counts.rejected + out.counts.notScoring + out.counts.contradicting
    );
  });

  it("a rejected row is never an option (N1b-AC3)", () => {
    const rows = [
      row("keep", 10, 25),
      row("rej", 18, 33, { status: "rejected" }),
    ];
    const out = buildPostableHighlights(rows);
    const optionIds = out.notableMoments.moments.flatMap((m) => m.options.map((o) => o.id));
    expect(optionIds).toEqual([]);
    expect(out.notableMoments.moments.map((m) => m.owner.id)).toEqual(["keep"]);
    expect(out.notableMoments.moments[0].memberCount).toBe(1);
  });

  it("a goal-shaped celebration absorbed by ADAAAA-8199 is not offered as an option", () => {
    // One accepted scoring GOAL + a goal-shaped (provisional) celebration that
    // overlaps it: the ADAAAA-8199 absorb folds the celebration into the GOAL's
    // duplicate lane, so the notable lane — and therefore the moment's options —
    // must not carry it.
    const rows = [
      row("goal", 10, 25, {
        outcome: "scoring_play",
        eventType: "GOAL",
        score: 100,
        reason: "The ball clearly enters the net after a strike.",
      }),
      row("celebration", 18, 33, { eventType: "GOAL", provisionalGoal: { status: "provisional", cues: ["asr_goal_call"], declaredTs: 12, note: "ASR goal call in the window transcript" } }),
      // A genuine non-goal on its own window stays notable, with its sibling as
      // its only option.
      row("miss1", 100, 115, { outcome: "near_miss", eventType: "NEAR_MISS" }),
      row("miss2", 108, 123, { outcome: "near_miss", eventType: "NEAR_MISS" }),
    ];
    const out = buildPostableHighlights(rows);
    expect(out.highlights.map((h) => h.id)).toEqual(["goal"]);
    // Absorbed: the celebration is a duplicate of the GOAL, not a notable row.
    expect(out.duplicates.map((h) => [h.id, h.duplicateOf])).toEqual([["celebration", "goal"]]);
    expect(out.notable.map((h) => h.id).sort()).toEqual(["miss1", "miss2"]);
    const optionIds = out.notableMoments.moments.flatMap((m) => m.options.map((o) => o.id));
    expect(optionIds).not.toContain("celebration");
    expect(out.notableMoments.moments.map((m) => [m.owner.id, m.options.map((o) => o.id)])).toEqual([
      ["miss1", ["miss2"]],
    ]);
    // The absorbed celebration still counts as a not-scoring row that became a
    // merge, exactly as before this projection existed: 3 non-scoring rows in,
    // 1 absorbed => 2 left in the notable lane, 1 merged.
    expect(out.counts.notScoring).toBe(2);
    expect(out.counts.merged).toBe(1);
  });

  it("never clusters across two different jobs' rows", () => {
    // Defensive: the projection is fed one job's rows, but a mixed list must not
    // silently merge footage from two jobs.
    const out = clusterNotableWindows([
      row("a", 10, 25),
      row("b", 18, 33, { jobId: "other-job", clipUri: "/clips/b.mp4" }),
    ]);
    // Proximity alone is the moment test inside one job's row set; the caller is
    // responsible for scoping (as buildPostableHighlights is). This fixture pins
    // that the clustering itself is purely window-based, no id/job heuristics.
    expect(out.moments.length).toBe(1);
    expect(out.moments[0].memberCount).toBe(2);
  });
});
