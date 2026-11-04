import { describe, expect, it } from "vitest";
import {
  HighlightRecordSchema,
  JobDetailSchema,
  type HighlightRecord,
  type JobCandidate,
} from "@highlights/events";
import { SqliteDb } from "../src/db";
import { Store } from "../src/store";
import {
  alternativeClipWindow,
  alternativeDedupeKey,
  alternativeIdFor,
  buildCelebrationAlternative,
  canOwnAlternatives,
  celebrationOwnerOf,
  celebrationWindowsFor,
  deliverCelebrationAlternatives,
  groupAlternativesByOwner,
  isCelebrationWindow,
  owningGoalFor,
  selectCelebrationAlternatives,
} from "../src/celebration-alternatives";

// ADAAAA-7984 (ADAAAA-7953 decision A+): post-goal celebration/replay windows are
// delivered as ALTERNATIVE CLIPS of the GOAL highlight they follow, at most 2 per
// goal, selected nearest-to-goal-clip-end first (tie-break decide confidence),
// without touching any highlight counter.
//
// The fixture is the CANONICAL clip verified on the deployed build (ADAAAA-7938):
// VOD job 64668dff-a200-4afb-bcc0-3f2fe77be769, /data/clips/
// adaaa7912-Portugal_vs_Spain_90s.mp4, Soccer, 3 fps. Stored rows quoted from the
// box: one accepted GOAL (eventType GOAL, outcome scoring_play, clip
// 35.4-50.4 s, localizedTs 42.4, clipWindowBeforeS 7 / clipWindowAfterS 8, score
// 95, corroborated true) and 11 REJECTED celebration windows 45-89.67 s that
// decide big_play (near_miss at 69 s). The goal end is 50.4 s; the eligible band
// the 7938 verification measured is 45-89.7 s.
const JOB = "64668dff-a200-4afb-bcc0-3f2fe77be769";

function goalHighlight(over: Partial<HighlightRecord> = {}): HighlightRecord {
  return HighlightRecordSchema.parse({
    id: "goal-h1",
    jobId: JOB,
    clipUri: "/clips/goal.mp4",
    start: 35.4,
    end: 50.4,
    localizedTs: 42.4,
    localizeSignal: "peak_frame",
    clipWindowBeforeS: 7,
    clipWindowAfterS: 8,
    clipWindowSec: 15,
    eventType: "GOAL",
    score: 95,
    outcome: "scoring_play",
    corroborated: true,
    status: "accepted",
    createdAt: "2026-11-04T00:00:00.000Z",
    ...over,
  });
}

/** One persisted decide verdict (the reject path stores `status: rejected`). */
function candidate(
  timestamp: number,
  over: Partial<JobCandidate> = {}
): Pick<JobCandidate, "status" | "outcome" | "timestamp" | "score" | "reason"> {
  return {
    status: "rejected",
    outcome: "big_play",
    timestamp,
    score: 0,
    reason: `window @${timestamp}s: post-goal celebration, no score transition`,
    ...over,
  };
}

/** The 11 celebration windows the deployed build produced on the canonical clip. */
const CANONICAL_WINDOWS = [
  candidate(45),
  candidate(48, { score: 55 }),
  candidate(51, { score: 45 }),
  candidate(54),
  candidate(57),
  candidate(60),
  candidate(63),
  candidate(66),
  candidate(69, { outcome: "near_miss" }),
  candidate(72),
  candidate(75),
  candidate(78),
  candidate(81),
  candidate(84),
  candidate(87),
  candidate(89.66666666666667),
];

// The operator clip-window setting the canonical job ran under, plus the VOD
// decide-window pre-roll (VOD_ANALYSIS_PRE_WINDOW_S default 3).
const CLIP_CFG = { preWindowS: 3, clipBeforeS: 7, clipAfterS: 8, clipWindowMinSec: 15 };

describe("celebration window eligibility (ADAAAA-7984)", () => {
  const owner = celebrationOwnerOf(goalHighlight());

  it("reads the owner's anchor from localizedTs and its delivered clip end", () => {
    expect(owner.highlightId).toBe("goal-h1");
    expect(owner.anchorTs).toBeCloseTo(42.4, 6);
    expect(owner.end).toBeCloseTo(50.4, 6);
  });

  it("only a scoring, non-rejected GOAL row can own alternatives", () => {
    expect(canOwnAlternatives(goalHighlight())).toBe(true);
    expect(canOwnAlternatives(goalHighlight({ outcome: "big_play" }))).toBe(false);
    expect(canOwnAlternatives(goalHighlight({ status: "rejected" }))).toBe(false);
  });

  it("accepts the canonical set: every post-goal non-scoring window inside the 60 s reach", () => {
    const windows = celebrationWindowsFor(CANONICAL_WINDOWS, owner);
    expect(windows).toHaveLength(16);
    expect(windows.every((w) => w.anchorTs > owner.anchorTs)).toBe(true);
    expect(windows.every((w) => w.anchorTs - owner.anchorTs <= 60)).toBe(true);
  });

  it("rejects pre-goal windows, accepted windows, not_highlight windows and out-of-reach windows", () => {
    const rows = [
      candidate(42.4), // the goal's own window — not after it
      candidate(30, { score: 80 }), // pre-goal
      candidate(48, { status: "accepted", outcome: "scoring_play" }), // a distinct scoring event
      candidate(51, { outcome: "not_highlight" }), // judged nothing worth watching
      candidate(120), // beyond GOAL_DUPLICATE_REACH_S (60 s)
    ];
    expect(rows.map((r) => isCelebrationWindow(r as JobCandidate, owner))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("ties a window to the SAME reach the 7865 dedup uses, not a second threshold", () => {
    const inReach = candidate(42.4 + 59.9);
    const outOfReach = candidate(42.4 + 60.5);
    expect(isCelebrationWindow(inReach as JobCandidate, owner)).toBe(true);
    expect(isCelebrationWindow(outOfReach as JobCandidate, owner)).toBe(false);
  });

  it("resolves the owning goal by nearest preceding goal anchor", () => {
    const goals = [
      { highlightId: "g1", anchorTs: 10, start: 3, end: 18 },
      { highlightId: "g2", anchorTs: 42.4, start: 35.4, end: 50.4 },
    ];
    expect(owningGoalFor(goals, 51)?.highlightId).toBe("g2");
    expect(owningGoalFor(goals, 20)?.highlightId).toBe("g1");
    expect(owningGoalFor(goals, 5)).toBeUndefined();
    expect(owningGoalFor(goals, 120)).toBeUndefined();
  });
});

describe("deterministic cap + selection (ADAAAA-7984 §4)", () => {
  const owner = celebrationOwnerOf(goalHighlight());

  it("delivers exactly 2 of the 16 eligible windows: nearest to the goal clip end first", () => {
    const selected = selectCelebrationAlternatives(celebrationWindowsFor(CANONICAL_WINDOWS, owner));
    expect(selected).toHaveLength(2);
    // goal clip ends 50.4 s: 51 s is 0.6 s away, 48 s is 2.4 s away.
    expect(selected.map((w) => w.anchorTs)).toEqual([51, 48]);
    expect(selected[0].distanceToGoalEndS).toBeCloseTo(0.6, 6);
    expect(selected[1].distanceToGoalEndS).toBeCloseTo(2.4, 6);
  });

  it("never caps by arrival order: a shuffled window list selects the same pair", () => {
    const forward = celebrationWindowsFor(CANONICAL_WINDOWS, owner);
    const backward = celebrationWindowsFor([...CANONICAL_WINDOWS].reverse(), owner);
    const shuffled = celebrationWindowsFor(
      [...CANONICAL_WINDOWS].sort((a, b) => (a.timestamp % 7) - (b.timestamp % 7)),
      owner
    );
    const pick = (ws: typeof forward) => selectCelebrationAlternatives(ws).map((w) => w.anchorTs);
    expect(pick(backward)).toEqual(pick(forward));
    expect(pick(shuffled)).toEqual(pick(forward));
  });

  it("tie-breaks equal distance by decide confidence descending, then the earlier window", () => {
    const windows = celebrationWindowsFor(
      [candidate(47, { score: 10 }), candidate(45, { score: 70 }), candidate(60, { score: 90 })],
      owner
    );
    // |47-50.4| = 3.4 ; |60-50.4| = 9.6 ; |45-50.4| = 5.4 -> 47 wins on distance,
    // the runner-up is 45 (5.4 s) over 60 (9.6 s), so confidence decides nothing
    // here. Force the tie explicitly below.
    expect(selectCelebrationAlternatives(windows).map((w) => w.anchorTs)).toEqual([47, 45]);

    const tied = [
      { anchorTs: 53, outcome: "big_play" as const, score: 20, distanceToGoalEndS: 2.6 },
      { anchorTs: 47, outcome: "big_play" as const, score: 60, distanceToGoalEndS: 3.4 },
      { anchorTs: 54, outcome: "near_miss" as const, score: 90, distanceToGoalEndS: 3.6 },
      { anchorTs: 46.8, outcome: "big_play" as const, score: 55, distanceToGoalEndS: 3.6 },
    ];
    // 53 (2.6) first; then distance 3.4 (score 60) beats the two 3.6 windows, and
    // at equal distance 3.6 the higher confidence (90) wins over 55.
    expect(selectCelebrationAlternatives(tied).map((w) => w.anchorTs)).toEqual([53, 47]);
    const twoWay = selectCelebrationAlternatives([
      { anchorTs: 54, outcome: "near_miss" as const, score: 90, distanceToGoalEndS: 3.6 },
      { anchorTs: 46.8, outcome: "big_play" as const, score: 55, distanceToGoalEndS: 3.6 },
    ]);
    // Equal distance: confidence decides, so 54 (score 90) outranks 46.8 (55).
    expect(twoWay.map((w) => w.anchorTs)).toEqual([54, 46.8]);
  });

  it("honours an explicit cap and a zero cap", () => {
    const windows = celebrationWindowsFor(CANONICAL_WINDOWS, owner);
    expect(selectCelebrationAlternatives(windows, 1)).toHaveLength(1);
    expect(selectCelebrationAlternatives(windows, 0)).toHaveLength(0);
  });
});

describe("alternative clip window + idempotency key (ADAAAA-7984 §6)", () => {
  it("puts both delivered alternatives inside the measured post-goal band (45-89.7 s)", () => {
    const owner = celebrationOwnerOf(goalHighlight());
    const selected = selectCelebrationAlternatives(celebrationWindowsFor(CANONICAL_WINDOWS, owner));
    const windows = selected.map((w) => alternativeClipWindow(w.anchorTs, CLIP_CFG));
    expect(windows).toEqual([
      { start: 48, end: 63 }, // anchor 51 s - 3 s pre-roll, 15 s clip length
      { start: 45, end: 60 }, // anchor 48 s - 3 s pre-roll
    ]);
    for (const w of windows) {
      expect(w.start).toBeGreaterThanOrEqual(45);
      expect(w.end).toBeLessThanOrEqual(89.7);
    }
  });

  it("keeps the operator clip length and never a negative start", () => {
    expect(alternativeClipWindow(51, CLIP_CFG)).toEqual({ start: 48, end: 63 });
    // before+after below the 15 s product floor -> the floor wins
    expect(alternativeClipWindow(20, { preWindowS: 2, clipBeforeS: 2, clipAfterS: 2, clipWindowMinSec: 15 })).toEqual({
      start: 18,
      end: 33,
    });
    expect(alternativeClipWindow(0, CLIP_CFG).start).toBe(0);
  });

  it("keys on owning highlight id + window anchor and derives a stable row id", () => {
    expect(alternativeDedupeKey("goal-h1", 51)).toBe("alt:goal-h1:51.000");
    expect(alternativeDedupeKey("goal-h1", 51.0004)).toBe("alt:goal-h1:51.000");
    expect(alternativeIdFor(alternativeDedupeKey("goal-h1", 51))).toBe(
      alternativeIdFor(alternativeDedupeKey("goal-h1", 51))
    );
    expect(alternativeIdFor(alternativeDedupeKey("goal-h1", 51))).not.toBe(
      alternativeIdFor(alternativeDedupeKey("goal-h1", 48))
    );
    // different owning goal, same anchor -> different row and key
    expect(alternativeDedupeKey("goal-h2", 51)).not.toBe(alternativeDedupeKey("goal-h1", 51));
  });

  it("labels the row celebration / alternative_of and never scoring", () => {
    const owner = celebrationOwnerOf(goalHighlight());
    const [w] = selectCelebrationAlternatives(celebrationWindowsFor(CANONICAL_WINDOWS, owner));
    const row = buildCelebrationAlternative({
      jobId: JOB,
      owner,
      window: w,
      clip: { clipId: "clip-51", clipUri: "/clips/clip-51.mp4" },
      clipWindow: alternativeClipWindow(w.anchorTs, CLIP_CFG),
      createdAt: "2026-11-04T00:00:00.000Z",
    });
    expect(row.eventType).toBe("celebration");
    expect(row.relation).toBe("alternative_of");
    expect(row.outcome).toBe("big_play");
    expect(row.highlightId).toBe("goal-h1");
    expect(row.windowAnchorTs).toBe(51);
    expect(row.clipUri).toBe("/clips/clip-51.mp4");
    expect(row.start).toBe(48);
    expect(row.end).toBe(63);
    expect(row.dedupeKey).toBe("alt:goal-h1:51.000");
  });
});

describe("delivery on a VOD job (ADAAAA-7984 AC2/AC3/AC7)", () => {
  /** Store with the canonical goal row + its 16 persisted decide verdicts. */
  async function canonicalStore(): Promise<Store> {
    const store = new Store(null);
    await store.addHighlight(goalHighlight());
    for (let i = 0; i < CANONICAL_WINDOWS.length; i++) {
      const c = CANONICAL_WINDOWS[i];
      await store.recordJobCandidate({
        id: `cand-${i}`,
        jobId: JOB,
        seq: i,
        timestamp: c.timestamp,
        eventType: "SPORTING_EVENT",
        score: c.score ?? 0,
        isHighlight: false,
        status: c.status,
        outcome: c.outcome,
        reason: c.reason,
        createdAt: "2026-11-04T00:00:00.000Z",
      });
    }
    return store;
  }

  function cutter() {
    const calls: { ts: number; win?: { start: number; end: number } }[] = [];
    const cut = async (ts: number, win?: { start: number; end: number }) => {
      calls.push({ ts, win });
      return { clipId: `clip-${ts}`, clipUri: `/clips/clip-${ts}.mp4` };
    };
    return { cut, calls };
  }

  it("attaches 2 alternatives to the goal and leaves every highlight counter alone", async () => {
    const store = await canonicalStore();
    const { cut, calls } = cutter();
    const delivered = await deliverCelebrationAlternatives({
      store,
      jobId: JOB,
      ownerId: "owner-1",
      cfg: CLIP_CFG,
      cut,
    });
    expect(delivered).toBe(2);
    expect(calls).toHaveLength(2);
    // The alternative windows are the celebration band's, not the goal's footage.
    expect(calls.map((c) => c.win)).toEqual([
      { start: 48, end: 63 },
      { start: 45, end: 60 },
    ]);
    // NOT highlights: the persisted highlight rows are exactly the one goal.
    expect(store.highlightsForJob(JOB)).toHaveLength(1);
    expect(store.highlightsForJob(JOB)[0].outcome).toBe("scoring_play");
    // The alternatives resolve to that highlight and are grouped under it.
    const rows = store.alternativesForJob(JOB);
    expect(rows.map((r) => r.windowAnchorTs)).toEqual([48, 51]);
    expect(rows.every((r) => r.highlightId === "goal-h1")).toBe(true);
    expect(rows.every((r) => r.eventType === "celebration" && r.outcome !== ("scoring_play" as string))).toBe(true);
    const grouped = groupAlternativesByOwner(rows);
    expect(grouped.get("goal-h1")).toHaveLength(2);
  });

  it("second pass over the same windows: same set, no duplicate rows, no duplicate clip files", async () => {
    const store = await canonicalStore();
    const first = cutter();
    await deliverCelebrationAlternatives({ store, jobId: JOB, cfg: CLIP_CFG, cut: first.cut });
    const firstRows = store.alternativesForJob(JOB);

    const second = cutter();
    const delivered = await deliverCelebrationAlternatives({ store, jobId: JOB, cfg: CLIP_CFG, cut: second.cut });
    expect(delivered).toBe(2);
    // Idempotent on the dedupe key: nothing re-cut, nothing re-inserted.
    expect(second.calls).toHaveLength(0);
    const secondRows = store.alternativesForJob(JOB);
    expect(secondRows.map((r) => r.id)).toEqual(firstRows.map((r) => r.id));
    expect(new Set(secondRows.map((r) => r.clipUri)).size).toBe(2);
  });

  it("does nothing for a job with no accepted GOAL (a missed-detection job)", async () => {
    const store = new Store(null);
    for (let i = 0; i < CANONICAL_WINDOWS.length; i++) {
      const c = CANONICAL_WINDOWS[i];
      await store.recordJobCandidate({
        id: `cand-${i}`,
        jobId: JOB,
        seq: i,
        timestamp: c.timestamp,
        eventType: "SPORTING_EVENT",
        score: c.score ?? 0,
        isHighlight: false,
        status: c.status,
        outcome: c.outcome,
        createdAt: "2026-11-04T00:00:00.000Z",
      });
    }
    const { cut, calls } = cutter();
    expect(await deliverCelebrationAlternatives({ store, jobId: JOB, cfg: CLIP_CFG, cut })).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("records a cut failure on the row instead of failing the job", async () => {
    const store = await canonicalStore();
    const cut = async () => {
      throw new Error("ffmpeg exploded");
    };
    const delivered = await deliverCelebrationAlternatives({ store, jobId: JOB, cfg: CLIP_CFG, cut });
    expect(delivered).toBe(2);
    const rows = store.alternativesForJob(JOB);
    expect(rows.every((r) => r.clipUri === "" && r.clipError === "ffmpeg exploded")).toBe(true);
  });

  it("caps at 2 per goal even when 3+ windows sit at the same distance", async () => {
    const store = new Store(null);
    await store.addHighlight(goalHighlight());
    const rows = [candidate(52, { score: 30 }), candidate(53, { score: 80 }), candidate(54, { score: 60 })];
    for (let i = 0; i < rows.length; i++) {
      const c = rows[i];
      await store.recordJobCandidate({
        id: `c-${i}`,
        jobId: JOB,
        seq: i,
        timestamp: c.timestamp,
        eventType: "SPORTING_EVENT",
        score: c.score ?? 0,
        isHighlight: false,
        status: c.status,
        outcome: c.outcome,
        createdAt: "2026-11-04T00:00:00.000Z",
      });
    }
    const { cut } = cutter();
    expect(await deliverCelebrationAlternatives({ store, jobId: JOB, cfg: CLIP_CFG, cut })).toBe(2);
    // |52-50.4| = 1.6 wins; 53 (2.6, score 80) beats 54 (3.6, score 60).
    expect(store.alternativesForJob(JOB).map((r) => r.windowAnchorTs)).toEqual([52, 53]);
  });
});
describe("contract + persistence (ADAAAA-7984)", () => {
  it("round-trips an alternative through the SQLite backend and dedups on the key", async () => {
    const db = new SqliteDb(":memory:");
    await db.migrate();
    const owner = celebrationOwnerOf(goalHighlight());
    const [w] = selectCelebrationAlternatives(celebrationWindowsFor(CANONICAL_WINDOWS, owner));
    const row = buildCelebrationAlternative({
      jobId: JOB,
      owner,
      window: w,
      clip: { clipId: "clip-51", clipUri: "/clips/clip-51.mp4" },
      clipWindow: alternativeClipWindow(w.anchorTs, CLIP_CFG),
      createdAt: "2026-11-04T00:00:00.000Z",
    });
    await db.saveHighlightAlternative(row);
    // A re-run upserts the same row instead of adding a second one.
    await db.saveHighlightAlternative({ ...row, createdAt: "2026-11-04T01:00:00.000Z" });
    const all = await db.listHighlightAlternatives();
    expect(all).toHaveLength(1);
    expect(all[0].clipUri).toBe("/clips/clip-51.mp4");
    expect((await db.highlightAlternativesForHighlight("goal-h1")).map((a) => a.dedupeKey)).toEqual([
      "alt:goal-h1:51.000",
    ]);
    // Deleting the job cascades the alternative row with its highlights.
    await db.deleteJob(JOB);
    expect(await db.listHighlightAlternatives()).toHaveLength(0);
    await db.close();
  });

  it("delivers alternatives on the job-detail payload grouped UNDER the owning highlight", () => {
    const owner = celebrationOwnerOf(goalHighlight());
    const [w] = selectCelebrationAlternatives(celebrationWindowsFor(CANONICAL_WINDOWS, owner));
    const alternative = buildCelebrationAlternative({
      jobId: JOB,
      owner,
      window: w,
      clip: { clipId: "clip-51", clipUri: "/clips/clip-51.mp4" },
      clipWindow: alternativeClipWindow(w.anchorTs, CLIP_CFG),
      createdAt: "2026-11-04T00:00:00.000Z",
    });
    const detail = JobDetailSchema.parse({
      job: { id: JOB, source: "file", status: "done", createdAt: "2026-11-04T00:00:00.000Z" },
      highlights: [{ ...goalHighlight(), alternatives: [alternative] }],
      maxTraces: 8,
    });
    expect(detail.highlights).toHaveLength(1);
    expect(detail.highlights[0].eventType).toBe("GOAL");
    expect(detail.highlights[0].alternatives).toHaveLength(1);
    expect(detail.highlights[0].alternatives![0].highlightId).toBe(detail.highlights[0].id);
    // The alternative is NOT a highlight: the postable list still has exactly one.
    expect(detail.notableHighlights).toHaveLength(0);
  });
});
