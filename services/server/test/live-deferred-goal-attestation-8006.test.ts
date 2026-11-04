// ADAAAA-8006: deferred attestation re-emit for the LIVE scoring lane.
//
// Regression source: live job b54366ac (file-sim of `kids300_7935.mp4`, GT goals
// at 100 s and 159 s, posture LIVE_DECIDE_CONFIRM=0). The ADAAAA-7996 gate was
// correct — the 159 s GOAL accept carried no measured attestation in its judged
// window `[149, 159]` and shipped as a `big_play` celebration — but the score
// change only became LEGIBLE 17 s later (`decide_audit` reads `2-1` through the
// 18:04:18 window and `2-2` first at 18:04:34.6Z), so a true goal was demoted and
// postable recall was 1/2.
//
// These tests pin the two things AC5 asks for: the lookahead bound and the
// "delta transition belongs to the cancelled window" predicate, plus the audit
// line each re-emit emits and the fact that an upgraded row is postable.
import { describe, expect, it, vi } from "vitest";
import {
  LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S,
  LIVE_UNATTESTED_GOAL_NOTE,
  LiveRunShared,
  applyDeferredGoalAttestations,
  downgradeUnattestedLiveGoal,
  scoreboardDeltaAttestsDeferredWindow,
  scoreboardDeltaSingleGoalStep,
  storedSurfaceFor,
  type DecisionResult,
  type DeferredGoalAttestationUpgrade,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer.js";
import { attestDeferredGoalHighlight, type LiveHighlightPersistence } from "../src/api.js";
import { Store } from "../src/store.js";
import { isPostableHighlight } from "../src/highlight-postable.js";
import type { HighlightRecord } from "@highlights/events";

/** The measured transition: scoreboard read `2-1` until ~172 s and `2-2` first at
 *  176 s — 17 s after the 159 s accept's judged window closed. */
const GOAL2_DELTA: ScoreboardDeltaEvidence = {
  pre: [2, 1],
  post: [2, 2],
  preTs: 172,
  postTs: 176,
  deltaTs: 176,
  preSamples: 3,
  postSamples: 2,
};

/** The cancelled window of the 159 s accept on the live rail. */
const GOAL2_WINDOW = { lo: 149, hi: 159 };

const SCORING: DecisionResult = {
  isHighlight: true,
  score: 72,
  eventType: "GOAL",
  outcome: "scoring_play",
  reason: "The No. 9 finishes low into the corner.",
};

function demotedRow(overrides: Partial<HighlightRecord> = {}): HighlightRecord {
  const d = downgradeUnattestedLiveGoal(SCORING);
  return {
    id: "hl-goal2",
    jobId: "job-8006",
    clipUri: "/clips/job-8006-1490.mp4",
    start: 152,
    end: 167,
    localizedTs: 159,
    localizeSignal: "trigger",
    eventType: d.eventType,
    score: d.score,
    reason: d.reason,
    outcome: d.outcome,
    status: "accepted",
    createdAt: "2026-11-04T18:04:18.000Z",
    ...overrides,
  };
}

function pending(overrides: Partial<Parameters<LiveRunShared["noteDeferredGoalAttestation"]>[0]> = {}) {
  const surface = storedSurfaceFor(SCORING, undefined);
  return {
    highlightId: "hl-goal2",
    jobId: "job-8006",
    lo: GOAL2_WINDOW.lo,
    hi: GOAL2_WINDOW.hi,
    anchorTs: 159,
    triggerKind: "motion",
    reason: surface.reason,
    caption: surface.caption,
    cardTitles: surface.cardTitles,
    colour: surface.colour,
    reasonRaw: surface.reason_raw,
    ...overrides,
  };
}

describe("scoreboardDeltaAttestsDeferredWindow (ADAAAA-8006)", () => {
  it("attributes the measured 17 s-late scoreboard read to the cancelled window", () => {
    expect(
      scoreboardDeltaAttestsDeferredWindow({ window: GOAL2_WINDOW, delta: GOAL2_DELTA, readAt: 179 })
    ).toBe(true);
  });

  it("enforces the lookahead bound (20 s) on both edges", () => {
    const at = (deltaTs: number) => ({ ...GOAL2_DELTA, deltaTs, postTs: deltaTs });
    // 20 s after the window close is still inside the bound (boundary included).
    expect(
      scoreboardDeltaAttestsDeferredWindow({ window: GOAL2_WINDOW, delta: at(179), readAt: 182 })
    ).toBe(true);
    // 21 s is outside it: the transition could be a following goal's.
    expect(
      scoreboardDeltaAttestsDeferredWindow({ window: GOAL2_WINDOW, delta: at(180), readAt: 183 })
    ).toBe(false);
    // The default IS the documented bound, and a caller may tighten it.
    expect(LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S).toBe(20);
    expect(
      scoreboardDeltaAttestsDeferredWindow({
        window: GOAL2_WINDOW,
        delta: at(170),
        readAt: 172,
        maxLookaheadS: 5,
      })
    ).toBe(false);
  });

  it("refuses a transition read inside/at the window (the normal attestation path owns it)", () => {
    const inside = { ...GOAL2_DELTA, preTs: 155, postTs: 157, deltaTs: 157 };
    expect(
      scoreboardDeltaAttestsDeferredWindow({ window: GOAL2_WINDOW, delta: inside, readAt: 157 })
    ).toBe(false);
  });

  it("refuses a read that does not belong to a later window", () => {
    expect(
      scoreboardDeltaAttestsDeferredWindow({ window: GOAL2_WINDOW, delta: GOAL2_DELTA, readAt: 150 })
    ).toBe(false);
  });

  it("refuses an ambiguous (two-goal) jump and a non-legible delta", () => {
    const twoGoals: ScoreboardDeltaEvidence = { ...GOAL2_DELTA, pre: [1, 1], post: [3, 1] };
    expect(scoreboardDeltaSingleGoalStep(twoGoals)).toBe(false);
    expect(
      scoreboardDeltaAttestsDeferredWindow({ window: GOAL2_WINDOW, delta: twoGoals, readAt: 179 })
    ).toBe(false);
    // A single OCR read per side never makes a legible delta.
    expect(
      scoreboardDeltaAttestsDeferredWindow({
        window: GOAL2_WINDOW,
        delta: { ...GOAL2_DELTA, preSamples: 1 },
        readAt: 179,
      })
    ).toBe(false);
    // Equal pre/post is not a transition at all.
    expect(
      scoreboardDeltaAttestsDeferredWindow({
        window: GOAL2_WINDOW,
        delta: { ...GOAL2_DELTA, post: [2, 1] },
        readAt: 179,
      })
    ).toBe(false);
    expect(scoreboardDeltaAttestsDeferredWindow({ window: GOAL2_WINDOW, delta: null, readAt: 179 })).toBe(false);
  });

  it("accepts a single goal step on either side", () => {
    expect(scoreboardDeltaSingleGoalStep(GOAL2_DELTA)).toBe(true);
    expect(scoreboardDeltaSingleGoalStep({ ...GOAL2_DELTA, pre: [2, 2], post: [3, 2] })).toBe(true);
    expect(scoreboardDeltaSingleGoalStep({ ...GOAL2_DELTA, pre: [2, 2], post: [2, 2] })).toBe(false);
    expect(scoreboardDeltaSingleGoalStep(null)).toBe(false);
  });
});

describe("LiveRunShared deferred-attestation ledger (ADAAAA-8006)", () => {
  it("resolves a demoted row once, then consumes it (no double re-emit)", () => {
    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(pending());
    const first = run.resolveDeferredGoalAttestation({ readAt: 179, delta: GOAL2_DELTA });
    expect(first).toHaveLength(1);
    expect(first[0].highlightId).toBe("hl-goal2");
    expect(first[0].deltaTs).toBe(176);
    expect(first[0].readAt).toBe(179);
    expect(first[0].lookaheadS).toBe(LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S);
    expect(first[0].reason).toContain("finishes low");
    expect(first[0].reason).not.toContain(LIVE_UNATTESTED_GOAL_NOTE);
    // A re-decided window re-reads the same delta: it must not re-emit.
    expect(run.resolveDeferredGoalAttestation({ readAt: 179, delta: GOAL2_DELTA })).toHaveLength(0);
    expect(run.pendingDeferredGoalAttestations()).toHaveLength(0);
  });

  it("does not re-attest a score-steady lull row (the ADAAAA-7996 precision bar)", () => {
    const run = new LiveRunShared();
    // The 285 s `big_play` accept in the 159-299 s lull: no legible delta ever
    // follows it, so it stays a celebration.
    run.noteDeferredGoalAttestation(pending({ highlightId: "hl-lull", lo: 275, hi: 285, anchorTs: 285 }));
    expect(run.resolveDeferredGoalAttestation({ readAt: 288, delta: undefined })).toHaveLength(0);
    // ...and a transition attributed to a DIFFERENT window leaves it alone.
    expect(run.resolveDeferredGoalAttestation({ readAt: 179, delta: GOAL2_DELTA })).toHaveLength(0);
    expect(run.pendingDeferredGoalAttestations()).toHaveLength(1);
  });

  it("fails closed when two demoted windows are within the lookahead of one read", () => {
    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(pending({ highlightId: "hl-a" }));
    run.noteDeferredGoalAttestation(pending({ highlightId: "hl-b", lo: 154, hi: 164 }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(run.resolveDeferredGoalAttestation({ readAt: 179, delta: GOAL2_DELTA })).toHaveLength(0);
    expect(spy.mock.calls[0]?.[0]).toContain("ambiguous deferred attestation");
    spy.mockRestore();
    // Neither row was consumed: an unambiguous later read still cannot resolve
    // them (there are two), so both stay celebrations — the precision-safe default.
    expect(run.pendingDeferredGoalAttestations()).toHaveLength(2);
  });

  it("refuses to re-attest a transition a delivered scoring GOAL already owns", () => {
    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(pending());
    // A later window delivered the GOAL for this transition (clip 170.5-185.5).
    run.noteAcceptedGoalEvent({ highlightId: "hl-goal2b", anchorTs: 176, start: 170.5, end: 185.5 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(run.resolveDeferredGoalAttestation({ readAt: 179, delta: GOAL2_DELTA })).toHaveLength(0);
    expect(spy.mock.calls[0]?.[0]).toContain("already owned by a delivered scoring GOAL");
    spy.mockRestore();
    expect(run.pendingDeferredGoalAttestations()).toHaveLength(0);
  });
});

describe("applyDeferredGoalAttestations (ADAAAA-8006)", () => {
  it("logs one audit line per re-emit and hands the upgrade to the persist hook", () => {
    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(pending());
    const seen: DeferredGoalAttestationUpgrade[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const count = applyDeferredGoalAttestations(
      run,
      { jobId: "job-8006", onDeferredGoalAttested: (up) => seen.push(up) },
      { readAt: 179, delta: GOAL2_DELTA }
    );
    const line = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();
    expect(count).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].highlightId).toBe("hl-goal2");
    // Mirrors `[live-goal-gate:<job>]`, so an operator greps one family.
    expect(line).toContain("[live-goal-gate-upgrade:job-8006]");
    expect(line).toContain("re-attested GOAL @159s");
    expect(line).toContain("17.0 s after the window closed");
    expect(line).toContain("2-1 -> 2-2");
  });

  it("is inert when nothing is pending or the hook is unset", () => {
    const run = new LiveRunShared();
    expect(applyDeferredGoalAttestations(run, { jobId: "job-8006" }, { readAt: 179, delta: GOAL2_DELTA })).toBe(0);
    run.noteDeferredGoalAttestation(pending());
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(applyDeferredGoalAttestations(run, { jobId: "job-8006" }, { readAt: 179, delta: GOAL2_DELTA })).toBe(1);
    spy.mockRestore();
  });
});

describe("attestDeferredGoalHighlight (ADAAAA-8006)", () => {
  async function seededStore() {
    const store = new Store(null);
    await store.addHighlight(demotedRow());
    return store;
  }

  it("moves the row back into the scoring lane and makes it postable", async () => {
    const store = await seededStore();
    const before = store.getHighlight("hl-goal2")!;
    expect(before.outcome).toBe("big_play");
    expect(isPostableHighlight(before)).toBe(false);

    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(pending());
    const [up] = run.resolveDeferredGoalAttestation({ readAt: 179, delta: GOAL2_DELTA });
    const next = await attestDeferredGoalHighlight({ store } as unknown as LiveHighlightPersistence, up);
    expect(next).not.toBeNull();
    expect(next!.outcome).toBe("scoring_play");
    expect(next!.eventType).toBe("GOAL");
    expect(next!.reason).not.toContain(LIVE_UNATTESTED_GOAL_NOTE);
    expect(next!.localizedTs).toBe(159); // the delivered instant is untouched (+0.0 s vs GT)
    expect(next!.deferredAttestation).toEqual({
      deltaTs: 176,
      readAt: 179,
      windowLo: 149,
      windowHi: 159,
      pre: [2, 1],
      post: [2, 2],
    });
    expect(isPostableHighlight(next!)).toBe(true);
    // The store (memory) is the truth the feed/detail endpoints read.
    expect(store.getHighlight("hl-goal2")!.outcome).toBe("scoring_play");
  });

  it("is idempotent and leaves an already-scoring row untouched", async () => {
    const store = new Store(null);
    await store.addHighlight(demotedRow({ outcome: "scoring_play", eventType: "GOAL", reason: SCORING.reason }));
    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(pending());
    const [up] = run.resolveDeferredGoalAttestation({ readAt: 179, delta: GOAL2_DELTA });
    const next = await attestDeferredGoalHighlight({ store } as unknown as LiveHighlightPersistence, up);
    expect(next!.outcome).toBe("scoring_play");
    expect(next!.deferredAttestation).toBeUndefined();
  });

  it("fails closed when the row is gone or carries no scoring-lane reason", async () => {
    const store = await seededStore();
    const run = new LiveRunShared();
    run.noteDeferredGoalAttestation(pending());
    const [up] = run.resolveDeferredGoalAttestation({ readAt: 179, delta: GOAL2_DELTA });
    expect(
      await attestDeferredGoalHighlight({ store } as unknown as LiveHighlightPersistence, { ...up, highlightId: "missing" })
    ).toBeNull();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await attestDeferredGoalHighlight({ store } as unknown as LiveHighlightPersistence, { ...up, reason: "  " })
    ).toBeNull();
    spy.mockRestore();
    expect(store.getHighlight("hl-goal2")!.outcome).toBe("big_play");
  });
});
