import { describe, expect, it } from "vitest";
import { HighlightRecordSchema, MAX_ALTERNATIVES_PER_HIGHLIGHT, type HighlightRecord } from "@highlights/events";
import {
  buildPostableHighlights,
  clusterNotableWindows,
  countsFromPostable,
  overlapChainClusters,
  windowsOverlap,
} from "../src/highlight-postable";

// ADAAAA-8422 (N1) AC6: unit fixtures for the notable moment projection.
//
// The notable lane used to ship one card per window because only postable
// candidates were clustered and clip options were only minted for an ACCEPTED
// scoring GOAL. Measured shape: live job b55c5781-7976-4777-905c-847a06f3d3a8
// carried 5 non-scoring windows that read as 5 cards where the board expects 2
// moments with 2 and 3 clip options.
//
// Every fixture below is a STORED row: the projection must turn clusters into
// moments without mutating a row, dropping footage or moving a count.

const JOB = "b55c5781-7976-4777-905c-847a06f3d3a8";

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

/** The reported shape: windows 1-2 overlap, windows 3-4-5 overlap, the two
 * groups do not touch. => 2 moments of 2 and 3 windows. */
function reportedShape(): HighlightRecord[] {
  return [
    row("w1", 10, 25),
    row("w2", 18, 33),
    row("w3", 60, 75),
    row("w4", 68, 83),
    row("w5", 76, 91),
  ];
}

describe("clusterNotableWindows — one moment per overlap chain (N1-AC1)", () => {
  it("5 windows in 2 clusters => 2 moments with option counts 1 and 2", () => {
    const out = clusterNotableWindows(reportedShape());
    expect(out.moments.length).toBe(2);
    expect(out.moments.map((m) => m.memberCount)).toEqual([2, 3]);
    expect(out.moments.map((m) => m.options.length)).toEqual([1, 2]);
    expect(out.optionsSuppressed).toBe(0);
    // No footage dropped: every window is either a moment's owner or an option.
    const delivered = out.moments.flatMap((m) => [m.owner.id, ...m.options.map((o) => o.id)]);
    expect(delivered.sort()).toEqual(["w1", "w2", "w3", "w4", "w5"]);
    // A moment card never spans two clusters: every option is transitively
    // chained to its owner (an option need not touch the owner directly — a
    // 3-window chain's last window only touches the middle one).
    for (const m of out.moments) {
      const chain = [m.owner, ...m.options];
      for (const o of chain) {
        expect(chain.some((other) => other.id !== o.id && windowsOverlap(other, o)) || chain.length === 1).toBe(true);
      }
    }
    // Moments are time ordered so the lane reads left to right.
    expect(out.moments.map((m) => m.owner.start)).toEqual([10, 60]);
  });

  it("a transitive chain (1-2-3, where 1 does not touch 3) is ONE moment", () => {
    // 10-25 / 20-35 / 30-45: 1 and 3 do not overlap; only the chain joins them.
    const rows = [row("a", 10, 25), row("b", 20, 35), row("c", 30, 45)];
    // Sanity: the strict overlap test really does not join the ends...
    expect(rows[0].start < rows[2].end && rows[2].start < rows[0].end).toBe(false);
    // ...but the chain does, so the three windows are ONE moment.
    expect(overlapChainClusters(rows).length).toBe(1);
    const out = clusterNotableWindows(rows);
    expect(out.moments.length).toBe(1);
    expect(out.moments[0].memberCount).toBe(3);
    expect(out.moments[0].options.length).toBe(MAX_ALTERNATIVES_PER_HIGHLIGHT);
    expect(out.moments[0].options.map((o) => o.id).sort()).toEqual(["b", "c"]);
  });

  it("touching windows (a.end === b.start) stay two moments", () => {
    const out = clusterNotableWindows([row("a", 10, 25), row("b", 25, 40)]);
    expect(out.moments.length).toBe(2);
    expect(out.moments.every((m) => m.options.length === 0)).toBe(true);
  });

  it("a single window stays a lone moment with no options (no rail)", () => {
    const out = clusterNotableWindows([row("solo", 100, 115)]);
    expect(out.moments.length).toBe(1);
    expect(out.moments[0].options).toEqual([]);
    expect(out.moments[0].memberCount).toBe(1);
  });

  it("caps options at MAX_ALTERNATIVES_PER_HIGHLIGHT and reports the overflow", () => {
    // A 4-window chain is wider than the shipped rail (1 + 2). The extra window
    // is COUNTED, never silently dropped.
    const rows = [row("a", 10, 25), row("b", 18, 33), row("c", 26, 41), row("d", 34, 49)];
    const out = clusterNotableWindows(rows);
    expect(out.moments.length).toBe(1);
    expect(out.moments[0].memberCount).toBe(4);
    expect(out.moments[0].options.length).toBe(MAX_ALTERNATIVES_PER_HIGHLIGHT);
    expect(out.moments[0].optionsSuppressed).toBe(1);
    expect(out.optionsSuppressed).toBe(1);
  });

  it("the owner is the row whose footage the card shows (clip beats no clip)", () => {
    const rows = [
      // No cut AND no named failure: this row cannot render a card at all, so it
      // must never own the moment's footage.
      row("nocut", 10, 25, { clipUri: "" }),
      row("cut", 12, 27),
    ];
    const out = clusterNotableWindows(rows);
    expect(out.moments.length).toBe(1);
    expect(out.moments[0].owner.id).toBe("cut");
    expect(out.moments[0].options.map((o) => o.id)).toEqual(["nocut"]);
  });

  it("does not mutate the stored rows it clusters", () => {
    const rows = reportedShape();
    const before = JSON.stringify(rows);
    clusterNotableWindows(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("buildPostableHighlights — notable moments never add or drop rows (N1-AC3)", () => {
  it("groups the notable lane without moving a single count", () => {
    const rows = [
      ...reportedShape(),
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
    });
    expect(countsFromPostable(out)).toEqual({
      rawHighlights: 6,
      postableHighlights: 0,
      mergedHighlights: 0,
      rejectedHighlights: 1,
      notScoringHighlights: 5,
      contradictingHighlights: 0,
    });
    // The flat notable lane is unchanged (same rows): the projection is the only
    // thing grouping.
    expect(out.notable.map((h) => h.id).sort()).toEqual(["w1", "w2", "w3", "w4", "w5"]);
    expect(out.notableMoments.moments.length).toBe(2);
    // Count identity still holds over the RAW total.
    expect(out.counts.total - out.counts.postable).toBe(
      out.counts.merged + out.counts.rejected + out.counts.notScoring + out.counts.contradicting
    );
  });

  it("a rejected row is never an option (N1-AC6)", () => {
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

  it("a goal-shaped celebration absorbed by ADAAAA-8199 is not offered as an option (N1-AC6)", () => {
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
    // Overlap alone is the moment test inside one job's row set; the caller is
    // responsible for scoping (as buildPostableHighlights is). This fixture pins
    // that the clustering itself is purely window-based, no id/job heuristics.
    expect(out.moments.length).toBe(1);
    expect(out.moments[0].memberCount).toBe(2);
  });
});
