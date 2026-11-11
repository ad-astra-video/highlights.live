// ADAAAA-8588: score-lane monotonicity — a score read that goes BACKWARDS must
// never be admitted as goal evidence.
//
// Regression source: job 54c03cfc (the ADAAAA-8534 leg, `/state/kids510.vp8.ivf`,
// 510.167 s). The run credited `1-1 > 2-1` at 106.215 s and `2-1 > 2-2` at
// 164.481 s; at 474.982 s the SAME footage's replay segment (the fixture's third
// cut rewinds the broadcast clock 28:19 -> 17:54) read `1-1` again and then
// `2-1`, and the deferred seam re-attested the demoted row `4788ae8e` in place
// from that backwards re-read (`deferredAttestation {pre:[1,1], post:[2,1],
// deltaTs:474.982, readAt:479.081}`). A football score cannot go backwards; the
// transition had already been credited 368 s earlier.
//
// These falsifiers pin the invariant at the run's own ledger, where the
// commitment lives — not at the OCR, which is reading a real plate.
import { describe, expect, it, vi } from "vitest";
import { ObserveMetricsSnapshotSchema } from "@highlights/events";
import {
  LiveRunShared,
  applyDeferredGoalAttestations,
  deriveWindowAttestation,
  storedSurfaceFor,
  type DecisionResult,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer.js";

/** A legible, forward single-goal step at `ts` (pre -> post, both +1 on one side). */
function delta(
  pre: [number, number],
  post: [number, number],
  ts: number,
  samples = 3
): ScoreboardDeltaEvidence {
  return {
    pre,
    post,
    preTs: ts - 1,
    postTs: ts,
    deltaTs: ts,
    preSamples: samples,
    postSamples: samples,
  };
}

const SCORING: DecisionResult = {
  isHighlight: true,
  score: 85,
  eventType: "GOAL",
  outcome: "scoring_play",
  reason: "The No. 9 finishes low into the corner.",
};

/** The 54c03cfc run's two credited transitions, replayed onto a fresh run. */
function legRun(): LiveRunShared {
  const run = new LiveRunShared({ jobId: "54c03cfc-64e6-4d9b-ae57-7b6d9a4ff4d2" });
  expect(run.claimScoreTransition(delta([1, 1], [2, 1], 106.215, 24))).toBe(true);
  expect(run.claimScoreTransition(delta([2, 1], [2, 2], 164.481, 6))).toBe(true);
  return run;
}

/** The demoted celebration row the deferred seam upgraded in place. */
function demoted474(surface: ReturnType<typeof storedSurfaceFor>) {
  return {
    highlightId: "4788ae8e-713e-4c0a-84ca-6288c3bf4306",
    jobId: "54c03cfc-64e6-4d9b-ae57-7b6d9a4ff4d2",
    lo: 464.981999874115,
    hi: 474.981999874115,
    anchorTs: 474.981999874115,
    triggerKind: "motion",
    reason: surface.reason,
    caption: surface.caption,
    cardTitles: surface.cardTitles,
    colour: surface.colour,
    reasonRaw: surface.reason_raw,
  };
}

describe("score-lane monotonicity (ADAAAA-8588)", () => {
  it("T1 refuses to CREDIT a novel backwards step once a forward boundary is committed", () => {
    const run = legRun();
    // A replay/montage segment re-reads an earlier state and steps forward from
    // it: `0-1 > 1-1` is a legal single-goal step in isolation, but the run has
    // already committed (2,2). Today the key is novel, so it is credited.
    expect(run.claimScoreTransition(delta([0, 1], [1, 1], 300))).toBe(false);
    // ...and it is not recorded as credited, so the audit cannot claim it.
    expect(run.creditedScoreTransitionKeys()).toEqual(["1-1>2-1", "2-1>2-2"]);
  });

  it("T2 still credits every genuinely forward transition (over-suppression guard)", () => {
    const run = legRun();
    // The next real boundary of the match: 2-2 -> 3-2.
    expect(run.claimScoreTransition(delta([2, 2], [3, 2], 402))).toBe(true);
    // A fresh run credits its first boundary whatever it is.
    const fresh = new LiveRunShared({ jobId: "fresh" });
    expect(fresh.claimScoreTransition(delta([0, 0], [0, 1], 3))).toBe(true);
    // A backwards-or-equal pair is still refused by the legibility bar.
    expect(fresh.claimScoreTransition(delta([0, 1], [0, 1], 6))).toBe(false);
  });

  it("T3 the deferred seam refuses the 474.982 s backwards re-read (the leg's own shape)", () => {
    const run = legRun();
    const persisted: unknown[] = [];
    run.noteDeferredGoalAttestation(demoted474(storedSurfaceFor(SCORING, undefined)));
    const n = applyDeferredGoalAttestations(
      run,
      {
        jobId: "54c03cfc-64e6-4d9b-ae57-7b6d9a4ff4d2",
        onDeferredGoalAttested: vi.fn((row) => persisted.push(row)),
      },
      {
        readAt: 479.0809998512268,
        delta: delta([1, 1], [2, 1], 474.981999874115, 5),
      }
    );
    // Today this resolves the demoted row and persists an in-place GOAL upgrade.
    expect(n).toBe(0);
    expect(persisted).toEqual([]);
  });

  it("T3b the deferred seam still promotes a genuine late read (8006 shape)", () => {
    const run = legRun();
    const persisted: unknown[] = [];
    const surface = storedSurfaceFor(SCORING, undefined);
    run.noteDeferredGoalAttestation({
      ...demoted474(surface),
      highlightId: "hl-goal-8006",
      lo: 149,
      hi: 159,
      anchorTs: 159,
    });
    const n = applyDeferredGoalAttestations(
      run,
      {
        jobId: "54c03cfc-64e6-4d9b-ae57-7b6d9a4ff4d2",
        onDeferredGoalAttested: vi.fn((row) => persisted.push(row)),
      },
      // The transition of the NEXT goal, read 17 s after that window closed.
      { readAt: 179, delta: delta([2, 2], [3, 2], 176) }
    );
    expect(n).toBe(1);
    expect(persisted).toHaveLength(1);
  });

  it("T4 a non-step reading cannot seat the frontier and freeze the leg", () => {
    const run = legRun();
    // The leg's own phantom read: `RM4 2-` OCRs as `4-2` at 256-260 s, a +2
    // jump. It is legible but not a single goal step, so it must not become the
    // committed frontier — otherwise every later genuine `2-2` read is "behind".
    expect(run.claimScoreTransition(delta([2, 2], [4, 2], 256.214))).toBe(false);
    expect(run.claimScoreTransition(delta([2, 2], [3, 2], 402))).toBe(true);
  });

  it("T5 a poisoned read-water cannot over-suppress once the frontier is committed", () => {
    const run = legRun();
    // The same leg's phantom `RM4 2-` read reaches the Fix C read ledger even
    // though it can never be credited: `noteScoreReadings` folds EVERY parseable
    // read into the total-based high-water. That water is now (4,2) / total 6.
    run.noteScoreReadings([
      { ts: 100, ocr: ["1-1"] },
      { ts: 106, ocr: ["2-1"] },
      { ts: 164, ocr: ["2-2"] },
      { ts: 256, ocr: ["4-2"] },
    ]);
    expect(run.scoreHighWaterState()).toEqual([4, 2]);
    expect(run.committedScore()).toEqual([2, 2]);
    // A GENUINE next boundary (`2-2 -> 3-2`, total 5 < the poisoned water's 6)
    // must still promote its demoted window: the frontier is component-wise and
    // cannot be poisoned, so it is the authority once the run has committed.
    const persisted: unknown[] = [];
    run.noteDeferredGoalAttestation({
      ...demoted474(storedSurfaceFor(SCORING, undefined)),
      highlightId: "hl-goal-reconcile",
      lo: 149,
      hi: 159,
      anchorTs: 159,
    });
    const n = applyDeferredGoalAttestations(
      run,
      { jobId: "54c03cfc-64e6-4d9b-ae57-7b6d9a4ff4d2", onDeferredGoalAttested: vi.fn((row) => persisted.push(row)) },
      { readAt: 179, delta: delta([2, 2], [3, 2], 176) }
    );
    expect(n).toBe(1);
    expect(persisted).toHaveLength(1);
  });

  it("T6 fails OPEN before the first credit, and the refusal counter is the AC4 read", () => {
    // No committed state yet: a replay before any credit is unguarded, so a real
    // goal on a leg whose only boundary is the first one is never deleted.
    const fresh = new LiveRunShared({ jobId: "fresh-open" });
    expect(fresh.committedScore()).toBeNull();
    const persisted: unknown[] = [];
    fresh.noteDeferredGoalAttestation({
      ...demoted474(storedSurfaceFor(SCORING, undefined)),
      highlightId: "hl-goal-open",
      lo: 149,
      hi: 159,
      anchorTs: 159,
    });
    expect(
      applyDeferredGoalAttestations(
        fresh,
        { jobId: "fresh-open", onDeferredGoalAttested: vi.fn((row) => persisted.push(row)) },
        { readAt: 179, delta: delta([2, 2], [3, 2], 176) }
      )
    ).toBe(1);

    // And every refusal behind the committed frontier is counted, so the card's
    // accepted risk (a VAR correction leaves the frontier high) stays measurable.
    const run = legRun();
    expect(run.scoreFrontierRefusals()).toBe(0);
    expect(run.claimScoreTransition(delta([1, 1], [2, 1], 474.982, 5))).toBe(false);
    expect(run.scoreDeltaAdmitted(delta([0, 1], [1, 1], 480))).toBe(false);
    expect(run.scoreFrontierRefusals()).toBe(2);
    expect(run.committedScore()).toEqual([2, 2]);
  });

  it("T7 the hint lane refuses a replayed hint delta and keeps a repeated forward one", () => {
    // The hint lane adopts a legible single-goal hint delta WITHOUT claiming it
    // (claiming would demote the genuine second clip's repeated `2-1 > 2-2`, the
    // withdrawn ADAAAA-8564 B1 canary), so admission is its only guard.
    const run = legRun(); // committed (2,2)
    const hint = (pre: [number, number], post: [number, number], ts: number) => ({
      eventType: "GOAL" as const,
      ts,
      scoreBoardChanged: true,
      scoreBoardDelta: delta(pre, post, ts, 4),
    });
    const payload = (h: ReturnType<typeof hint>) => ({
      centerTs: h.ts,
      frames: [{ ts: h.ts }],
      observations: [{ ts: h.ts, ocr: [] as string[] }],
      biasHints: [h],
    });

    // A replay/montage segment's hint re-reads the already-credited boundary.
    const replayed = deriveWindowAttestation(payload(hint([1, 1], [2, 1], 474.982)), {
      claimScoreTransition: (d) => run.claimScoreTransition(d),
      admitScoreDelta: (d) => run.scoreDeltaAdmitted(d),
    });
    expect(replayed.scoreBoardChanged).toBeUndefined();
    expect(replayed.scoreBoardDelta).toBeUndefined();
    expect(run.scoreFrontierRefusals()).toBe(1);

    // ...and the genuine second clip's repeated forward step still attests, so the
    // guard can never demote a real goal (withdrawn-B1 canary shape).
    const repeated = deriveWindowAttestation(payload(hint([2, 1], [2, 2], 351.118)), {
      claimScoreTransition: (d) => run.claimScoreTransition(d),
      admitScoreDelta: (d) => run.scoreDeltaAdmitted(d),
    });
    expect(repeated.scoreBoardChanged).toBe(true);
    expect(repeated.scoreBoardDelta?.post).toEqual([2, 2]);
  });

  it("T8 the refusal counter reaches the served row (observeMetrics.rowAccounting)", () => {
    // AC4's metric is only gradeable after deploy if the count survives the
    // persisted record: a zod object STRIPS undeclared keys, so this pins the
    // counter through the schema as well as through the run's snapshot.
    const run = legRun(); // committed (2,2)
    expect(run.rowAccounting(7)).not.toHaveProperty("scoreFrontierRefusals");
    expect(run.claimScoreTransition(delta([1, 1], [2, 1], 474.982, 5))).toBe(false);
    const acct = run.rowAccounting(7);
    expect(acct.scoreFrontierRefusals).toBe(1);
    // The served row keeps the pre-8588 block intact (no counter drift).
    expect(acct).toMatchObject({
      acceptedWindows: 0,
      persistedRows: 0,
      servedCards: 7,
      suppressedWindows: 0,
      demotedCelebrations: 0,
    });
    const parsed = ObserveMetricsSnapshotSchema.shape.rowAccounting.parse(acct);
    expect(parsed?.scoreFrontierRefusals).toBe(1);
  });
});
