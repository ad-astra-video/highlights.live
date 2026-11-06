// ADAAAA-8199: promote a delivered provisional/goal-shaped celebration IN PLACE
// for the accept that first measures its transition.
//
// Regression source: the funded 2-stream `file-sim` leg of `kids300_7935.mp4`
// (jobs `58aafd8e` / `9d7ab76c`) on build `b07f9b9`. Goal 1 on `58aafd8e`:
// `ff95095e` (provisional celebration @100, window [93,108]) and `0b334e6c`
// (confirmed GOAL @115, window [102,117]) shipped as two rows for ONE transition.
// The celebration landed at 12:48:18 and the ordinary GOAL accept at 12:48:42;
// because the accept persisted and stamped its transition onto the delivered-GOAL
// ledger first, `resolveDeferredGoalAttestation` then (correctly) refused to
// promote the provisional row as `ownedByDeliveredGoal`. The same goal shipped
// as two cards.
//
// These tests pin the ordering fix: the accept asks the run to credit the ONE
// pending demoted row its own measured delta is attributable to, BEFORE the
// insert, so the row id / clip / instant are preserved and no second row exists.
import { describe, expect, it, vi } from "vitest";
import {
  LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S,
  LiveRunShared,
  downgradeUnattestedLiveGoal,
  storedSurfaceFor,
  type DecisionResult,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer.js";
import { attestDeferredGoalHighlight, type LiveHighlightPersistence } from "../src/api.js";
import { Store } from "../src/store.js";
import { buildPostableHighlights, isPostableHighlight } from "../src/highlight-postable.js";
import type { HighlightRecord } from "@highlights/events";

/** Goal 1's measured transition on the leg: 1-1 -> 2-1, first legible at 109 s. */
const GOAL1_DELTA: ScoreboardDeltaEvidence = {
  pre: [1, 1],
  post: [2, 1],
  preTs: 107,
  postTs: 109,
  deltaTs: 109,
  preSamples: 2,
  postSamples: 2,
};

/** The provisional row's judged window on the live rail (trailing: [90, 100]). */
const GOAL1_WINDOW = { lo: 90, hi: 100 };

/** Goal 2's measured transition: 2-1 -> 2-2 at 166 s, inside the [154.7, 169.7]
 *  provisional window; the accept that measured it read at 169 s (its own
 *  window's close is 169.7, i.e. the accept window overlaps the provisional one
 *  rather than following it — the case the deferred lane's `readAt >= hi` bound
 *  cannot credit). */
const GOAL2_DELTA: ScoreboardDeltaEvidence = {
  pre: [2, 1],
  post: [2, 2],
  preTs: 164,
  postTs: 166,
  deltaTs: 166,
  preSamples: 3,
  postSamples: 2,
};

const SCORING: DecisionResult = {
  isHighlight: true,
  score: 85,
  eventType: "GOAL",
  outcome: "scoring_play",
  reason: "ASR confirms 'remate gol' and the scoreboard reads 2-1.",
};

function demotedProvisionalRow(overrides: Partial<HighlightRecord> = {}): HighlightRecord {
  const d = downgradeUnattestedLiveGoal(SCORING);
  return {
    id: "ff95095e",
    jobId: "58aafd8e-75af-4971-9170-78a4f7cc53e5",
    clipUri: "/clips/58aafd8e-ff95095e.mp4",
    start: 93,
    end: 108,
    localizedTs: 100,
    localizeSignal: "trigger",
    eventType: d.eventType,
    score: d.score,
    reason: d.reason,
    outcome: d.outcome,
    status: "accepted",
    provisionalGoal: {
      status: "provisional",
      cues: ["asr_goal_call"],
      declaredTs: 100,
      note: "provisional goal: asr_goal_call in the judged window, no measured scoreboard change yet",
    },
    createdAt: "2026-11-06T12:48:18.368Z",
    ...overrides,
  };
}

function pending(overrides: Partial<Parameters<LiveRunShared["noteDeferredGoalAttestation"]>[0]> = {}) {
  const surface = storedSurfaceFor(SCORING, undefined);
  return {
    highlightId: "ff95095e",
    jobId: "58aafd8e-75af-4971-9170-78a4f7cc53e5",
    lo: GOAL1_WINDOW.lo,
    hi: GOAL1_WINDOW.hi,
    anchorTs: 100,
    triggerKind: "motion",
    reason: surface.reason,
    caption: surface.caption,
    cardTitles: surface.cardTitles,
    colour: surface.colour,
    reasonRaw: surface.reason_raw,
    ...overrides,
  };
}

describe("LiveRunShared.promoteDeferredGoalForAccept (ADAAAA-8199)", () => {
  it("credits the pending provisional row for the accept's own measured transition", () => {
    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(pending());
    // The GOAL accept's window is [102, 117] centred at 115 — it contains the
    // 109 s transition and OVERLAPS the provisional row's [93,108] window.
    const up = run.promoteDeferredGoalForAccept({ delta: GOAL1_DELTA, readAt: 115 });
    expect(up).toBeDefined();
    // AC1: the SAME row is credited (row id preserved), not a replacement row.
    expect(up!.highlightId).toBe("ff95095e");
    expect(up!.anchorTs).toBe(100);
    expect(up!.deltaTs).toBe(109);
    expect(up!.readAt).toBe(115);
    expect(up!.lookaheadS).toBe(LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S);
    // The provisional marker's scoring surface is what gets restored.
    expect(up!.reason).toContain("remate gol");
    // Consumed exactly once: a re-decided window cannot promote twice.
    expect(run.pendingDeferredGoalAttestations()).toHaveLength(0);
    expect(run.promoteDeferredGoalForAccept({ delta: GOAL1_DELTA, readAt: 118 })).toBeUndefined();
  });

  it("handles the overlapping-window ordering (goal 2): the accept reads its OWN window, not a later one", () => {
    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(pending({ lo: 154.7, hi: 169.7, anchorTs: 160 }));
    // The confirm accept's window closes at 169 s, a fraction BEFORE the
    // provisional judged window's 169.7 s close: the deferred lane's
    // `readAt >= hi` bound rejects this read, which is why the second row landed.
    const up = run.promoteDeferredGoalForAccept({ delta: GOAL2_DELTA, readAt: 169 });
    expect(up).toBeDefined();
    expect(up!.highlightId).toBe("ff95095e");
    expect(up!.deltaTs).toBe(166);
  });

  it("fails closed when a delivered scoring GOAL already owns the transition", () => {
    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(pending());
    run.noteAcceptedGoalEvent({
      highlightId: "some-other-goal",
      anchorTs: 109,
      start: 102,
      end: 117,
      candidateTs: 115,
      transitionKey: "1-1>2-1",
    });
    expect(run.promoteDeferredGoalForAccept({ delta: GOAL1_DELTA, readAt: 115 })).toBeUndefined();
    // The pending row was not consumed by a refused promotion.
    expect(run.pendingDeferredGoalAttestations()).toHaveLength(1);
  });

  it("fails closed on ambiguity: two demoted windows inside one transition's reach", () => {
    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(pending({ highlightId: "hl-a" }));
    run.noteDeferredGoalAttestation(pending({ highlightId: "hl-b", lo: 96, hi: 104 }));
    expect(run.promoteDeferredGoalForAccept({ delta: GOAL1_DELTA, readAt: 115 })).toBeUndefined();
    expect(run.pendingDeferredGoalAttestations()).toHaveLength(2);
  });

  it("fails closed on a non-legible delta, a two-goal jump, and a transition before the window", () => {
    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(pending());
    expect(run.promoteDeferredGoalForAccept({ delta: undefined, readAt: 115 })).toBeUndefined();
    expect(run.promoteDeferredGoalForAccept({ delta: { ...GOAL1_DELTA, preSamples: 1 }, readAt: 115 })).toBeUndefined();
    expect(
      run.promoteDeferredGoalForAccept({ delta: { ...GOAL1_DELTA, post: [3, 1] }, readAt: 115 })
    ).toBeUndefined();
    // A transition 25 s past the close is beyond the deferred lookahead: it could
    // be a following goal, so it is never credited to this window.
    expect(
      run.promoteDeferredGoalForAccept({ delta: { ...GOAL1_DELTA, preTs: 123, postTs: 125, deltaTs: 125 }, readAt: 130 })
    ).toBeUndefined();
    expect(run.pendingDeferredGoalAttestations()).toHaveLength(1);
  });

  it("promotes the persisted row in place: same id, GOAL lane, provisional marker cleared, ONE postable row", async () => {
    const store = new Store(null);
    await store.addHighlight(demotedProvisionalRow());
    expect(isPostableHighlight(store.getHighlight("ff95095e")!)).toBe(false);
    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(pending());
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const up = run.promoteDeferredGoalForAccept({ delta: GOAL1_DELTA, readAt: 115 })!;
    const persisted = await attestDeferredGoalHighlight({ store } as unknown as LiveHighlightPersistence, up);
    spy.mockRestore();

    expect(persisted).not.toBeNull();
    const rows = store.highlightsForJob("58aafd8e-75af-4971-9170-78a4f7cc53e5");
    // AC1: ONE row for the transition, and it is the provisional row's own id.
    expect(rows.map((r) => r.id)).toEqual(["ff95095e"]);
    const row = rows[0];
    expect(row.outcome).toBe("scoring_play");
    expect(row.eventType).toBe("GOAL");
    expect(row.provisionalGoal).toBeUndefined();
    expect(row.localizedTs).toBe(100); // the delivered instant is untouched
    expect(row.deferredAttestation).toEqual({
      deltaTs: 109,
      readAt: 115,
      windowLo: 90,
      windowHi: 100,
      pre: [1, 1],
      post: [2, 1],
    });
    // AC2/AC1 on the read surface: one postable row, nothing left in notable.
    const postable = buildPostableHighlights(rows);
    expect(postable.highlights.map((h) => h.id)).toEqual(["ff95095e"]);
    expect(postable.notable).toEqual([]);
    expect(postable.duplicates).toEqual([]);
  });
});
