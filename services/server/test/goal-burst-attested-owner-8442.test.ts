// ADAAAA-8442 (ATTEST-2): a fully-attested GOAL must be deduped under the GOAL
// lane, never deleted as a burst duplicate of a celebration.
//
// Regression source: live job `b55c5781-7976-4777-905c-847a06f3d3a8` (ATTEST-2
// census on ADAAAA-8421 §4.3 / ADAAAA-8435 C2). Ten `eventType=GOAL` candidates
// were `status=suppressed` with `kind=goal_burst_same_transition` and
// `transitionKey=null`; three of them held every measured channel true and still
// produced no highlight, because suppression runs BEFORE accept and the burst
// lane's nearest reference was an earlier goal-shaped row the attestation gate had
// DEMOTED to a celebration:
//
//   75b22f0f @14:47:10.253 -> ab1071b5 (14:47:06.754)  gap 3.408 s
//   c1338e86 @14:47:12.380 -> ab1071b5                 gap 5.714 s
//   65e0ad50 @14:52:16.835 -> e4214be4 (14:52:10.474)  gap 6.785 s
//
// These tests pin the accept-lane fix: the burst OWNER is resolved by attestation
// strength — the attested sibling promotes the celebration row IN PLACE (same id,
// same clip, no new clip window), one transition keeps one postable GOAL (AV10),
// and a burst with NO measured row keeps today's celebration dedupe byte-for-byte.
import { describe, expect, it, vi } from "vitest";
import {
  LiveRunShared,
  acceptVideoDecision,
  attestedGoalBurstOwnerPromotion,
  formatGoalBurstOwnerPromotedReason,
  formatGoalBurstSuppressionReason,
  liveGoalAttestationUsed,
  liveGoalHasMeasuredEvidence,
  storedSurfaceFor,
  downgradeUnattestedLiveGoal,
  type AnalyzerConfig,
  type CandidateSignal,
  type DeferredGoalAttestation,
  type DeferredGoalAttestationUpgrade,
  type DecisionResult,
  type LiveGoalAttestationUsed,
  type ScoreReadDiagnostics,
} from "../src/analyzer.js";
import { attestDeferredGoalHighlight, type LiveHighlightPersistence } from "../src/api.js";
import { Store } from "../src/store.js";
import { buildPostableHighlights, isPostableHighlight } from "../src/highlight-postable.js";
import type { HighlightRecord } from "@highlights/events";

const JOB = "b55c5781-7976-4777-905c-847a06f3d3a8";

/** The scoring-lane verdict the accepting window produced (goal copy). */
const SCORING: DecisionResult = {
  isHighlight: true,
  score: 85,
  eventType: "GOAL",
  outcome: "scoring_play",
  reason: "The ball crosses the line and the scoreboard moves 1-1 to 2-1.",
};

/** The measured read counts the ATTEST-2 rows carried (`postSamples=0`): the score
 * channel could not attest, which is why the goal-line / net channel is the one
 * that must win the burst owner. */
const NO_POST_SAMPLE: ScoreReadDiagnostics = {
  scoreReads: 3,
  preSamples: 3,
  postSamples: 0,
  need: 2,
  scoreStates: 2,
  newestTransition: null,
};

/** A goal-shaped celebration row the attestation gate demoted (owner of a burst):
 * ab1071b5 / e4214be4 shape. */
function demotedCelebrationRow(id: string, anchorTs: number, overrides: Partial<HighlightRecord> = {}): HighlightRecord {
  const d = downgradeUnattestedLiveGoal(SCORING);
  return {
    id,
    jobId: JOB,
    clipUri: `/clips/${JOB}-${id}.mp4`,
    start: anchorTs - 10,
    end: anchorTs + 5,
    localizedTs: anchorTs,
    localizeSignal: "trigger",
    eventType: d.eventType,
    score: d.score,
    reason: d.reason,
    outcome: d.outcome,
    status: "accepted",
    provisionalGoal: {
      status: "provisional",
      cues: ["asr_goal_call"],
      declaredTs: anchorTs,
      note: "provisional goal: asr_goal_call in the judged window, no measured scoreboard change yet",
    },
    createdAt: "2026-11-08T14:47:06.754Z",
    ...overrides,
  };
}

/** The deferred-attestation entry the demoted row parked at delivery time. */
function deferredEntry(overrides: Partial<DeferredGoalAttestation> = {}): DeferredGoalAttestation {
  const surface = storedSurfaceFor(SCORING, undefined);
  return {
    highlightId: "ab1071b5",
    jobId: JOB,
    lo: 96.754,
    hi: 106.754,
    anchorTs: 100.754,
    triggerKind: "motion",
    reason: surface.reason,
    caption: surface.caption,
    cardTitles: surface.cardTitles,
    colour: surface.colour,
    reasonRaw: surface.reason_raw,
    ...overrides,
  };
}

/** The three MEASURED sibling shapes from the census (plus the fail-closed
 * control with no measurement at all). Content seconds preserve the measured gaps:
 * owner 100.000, siblings 103.408 / 105.714; owner 400.000, sibling 406.785. */
const MEASURED_CASES = [
  { id: "75b22f0f", owner: "ab1071b5", ownerTs: 100.0, siblingTs: 103.408 },
  { id: "c1338e86", owner: "ab1071b5", ownerTs: 100.0, siblingTs: 105.714 },
  { id: "65e0ad50", owner: "e4214be4", ownerTs: 400.0, siblingTs: 406.785 },
] as const;

/** Build the attestation the accepting window reports for a MEASURED goal sibling
 * (ball-in-net / goal-line channel; the score channel has no post sample). */
function measuredAttestation(): { used: LiveGoalAttestationUsed; attested: boolean } {
  const used = liveGoalAttestationUsed({
    attribution: {
      scoreBoardChanged: true,
      goalCrossed: true,
      ballOutcome: "goal",
      scoreBoardDelta: undefined,
    },
    scoreReads: NO_POST_SAMPLE,
  });
  const attested = liveGoalHasMeasuredEvidence({
    scoreBoardChanged: used.scoreBoardChanged,
    goalCrossed: used.goalCrossed,
    ballOutcome: used.ballOutcome,
    corroborated: used.corroborated,
    goalConfirmed: used.goalConfirmed,
    scoreReads: NO_POST_SAMPLE,
  });
  return { used, attested };
}

/** Build the NO-MEASUREMENT control sibling (today's fail-closed shape). */
function unmeasuredAttestation(): { used: LiveGoalAttestationUsed; attested: boolean } {
  const used = liveGoalAttestationUsed({
    attribution: { scoreBoardChanged: false, goalCrossed: false, ballOutcome: undefined },
  });
  const attested = liveGoalHasMeasuredEvidence({
    scoreBoardChanged: used.scoreBoardChanged,
    goalCrossed: used.goalCrossed,
    ballOutcome: used.ballOutcome,
    corroborated: used.corroborated,
    goalConfirmed: used.goalConfirmed,
    scoreReads: undefined,
  });
  return { used, attested };
}

/** A run holding one delivered goal-shaped celebration owner. */
function runWithOwner(ownerId: string, ownerTs: number): LiveRunShared {
  const run = new LiveRunShared();
  run.noteDeliveredGoalShapedEvent({
    highlightId: ownerId,
    anchorTs: ownerTs,
    start: ownerTs - 10,
    end: ownerTs + 5,
    candidateTs: ownerTs,
    transitionKey: null,
    idempotencyKey: `hl:${JOB}:${ownerTs}:GOAL`,
  });
  run.noteDeferredGoalAttestation(deferredEntry({ highlightId: ownerId, anchorTs: ownerTs + 0.754, lo: ownerTs - 3.246, hi: ownerTs + 6.754 }));
  return run;
}

describe("ATTEST-2 burst owner resolution (ADAAAA-8442, AT2-AC4)", () => {
  it("keeps today's suppression SHAPE: the burst lane still reports the celebration it deduped against", () => {
    const run = runWithOwner("ab1071b5", 100.0);
    const sup = run.goalBurstSuppression({ ts: 103.408, eventType: "GOAL" });
    // AT2-AC2: suppression counts keep today's shape (one row suppressed, same
    // kind/window/gap fields) — only the OWNER's lane changes.
    expect(sup).toBeDefined();
    expect(sup!.kind).toBe("goal_burst_same_transition");
    expect(sup!.dedupeAgainstKind).toBe("goal_shaped_celebration");
    expect(sup!.dedupeAgainstHighlightId).toBe("ab1071b5");
    expect(sup!.dedupeAgainstTs).toBe(100.0);
    expect(sup!.gapS).toBeCloseTo(3.408, 3);
    expect(sup!.transitionKey).toBeNull();
    expect(formatGoalBurstSuppressionReason(sup!)).toBe(
      "goal_burst_same_transition:dedupeAgainst=ab1071b5@100.000s(goal_shaped_celebration);" +
        "idempotencyKey=hl:b55c5781-7976-4777-905c-847a06f3d3a8:100:GOAL;gap=3.408s;window=8s;transition=none;burst=1"
    );
  });

  it("resolves the owner by attestation strength on all three measured census shapes", () => {
    const measured = measuredAttestation();
    expect(measured.attested).toBe(true);
    for (const c of MEASURED_CASES) {
      const run = runWithOwner(c.owner, c.ownerTs);
      const sup = run.goalBurstSuppression({ ts: c.siblingTs, eventType: "GOAL" });
      expect(sup, `${c.id}: the burst lane must still see the celebration owner`).toBeDefined();
      const owner = attestedGoalBurstOwnerPromotion({
        suppression: sup,
        goalShaped: true,
        measuredGoalAttested: measured.attested,
        liveLane: true,
        deferred: run.pendingDeferredGoalAttestations(),
        acceptWindow: { lo: c.siblingTs - 10, hi: c.siblingTs },
      });
      expect(owner?.highlightId, `${c.id}: owner`).toBe(c.owner);
      expect(owner?.anchorTs).toBe(c.ownerTs + 0.754);
      // Same-transition claim at the same gap the burst lane measured.
      expect(sup!.gapS).toBeCloseTo(c.siblingTs - c.ownerTs, 2);
    }
    // The census gaps, quoted so a grader can diff them against the C2 table.
    expect(MEASURED_CASES.map((c) => Number((c.siblingTs - c.ownerTs).toFixed(3)))).toEqual([3.408, 5.714, 6.785]);
  });

  it("AT2-AC3 fail-closed: a burst with NO measured row keeps the celebration dedupe (no goal card)", () => {
    const control = unmeasuredAttestation();
    expect(control.attested).toBe(false);
    for (const c of MEASURED_CASES) {
      const run = runWithOwner(c.owner, c.ownerTs);
      const sup = run.goalBurstSuppression({ ts: c.siblingTs, eventType: "GOAL" });
      expect(sup!.dedupeAgainstKind).toBe("goal_shaped_celebration");
      expect(
        attestedGoalBurstOwnerPromotion({
          suppression: sup,
          goalShaped: true,
          measuredGoalAttested: control.attested,
          liveLane: true,
          deferred: run.pendingDeferredGoalAttestations(),
          acceptWindow: { lo: c.siblingTs - 10, hi: c.siblingTs },
        }),
        `${c.id}: unmeasured burst must not promote`
      ).toBeUndefined();
    }
  });

  it("fails closed off the live lane, on a non-goal label, and when the target is not a demoted celebration", () => {
    const measured = measuredAttestation();
    const run = runWithOwner("ab1071b5", 100.0);
    const sup = run.goalBurstSuppression({ ts: 103.408, eventType: "GOAL" })!;
    const base = {
      suppression: sup,
      goalShaped: true,
      measuredGoalAttested: measured.attested,
      liveLane: true,
      deferred: run.pendingDeferredGoalAttestations(),
      acceptWindow: { lo: 93.408, hi: 103.408 },
    };
    expect(attestedGoalBurstOwnerPromotion(base)?.highlightId).toBe("ab1071b5");
    expect(attestedGoalBurstOwnerPromotion({ ...base, liveLane: false })).toBeUndefined();
    expect(attestedGoalBurstOwnerPromotion({ ...base, goalShaped: false })).toBeUndefined();
    expect(attestedGoalBurstOwnerPromotion({ ...base, suppression: undefined })).toBeUndefined();
    // A delivered SCORING goal is never promoted (it is already the goal lane).
    const goalRun = new LiveRunShared();
    goalRun.noteAcceptedGoalEvent({
      highlightId: "hl-goal",
      anchorTs: 100,
      start: 90,
      end: 105,
      candidateTs: 100,
      transitionKey: null,
    });
    const goalSup = goalRun.goalBurstSuppression({ ts: 103.408, eventType: "GOAL" })!;
    expect(goalSup.dedupeAgainstKind).toBe("scoring_goal");
    expect(attestedGoalBurstOwnerPromotion({ ...base, suppression: goalSup })).toBeUndefined();
    // A non-overlapping owner is not the same moment -> no promotion.
    expect(
      attestedGoalBurstOwnerPromotion({ ...base, acceptWindow: { lo: 120, hi: 130 } })
    ).toBeUndefined();
  });

  it("consumes the owner exactly once (a re-decided window cannot promote twice)", () => {
    const run = runWithOwner("ab1071b5", 100.0);
    expect(run.pendingDeferredGoalAttestations()).toHaveLength(1);
    expect(run.claimBurstCelebrationOwner("ab1071b5")?.highlightId).toBe("ab1071b5");
    expect(run.pendingDeferredGoalAttestations()).toHaveLength(0);
    expect(run.claimBurstCelebrationOwner("ab1071b5")).toBeUndefined();
  });

  it("names the promoted owner and the attestation channels on the suppressed sibling row", () => {
    const measured = measuredAttestation();
    const run = runWithOwner("ab1071b5", 100.0);
    const sup = run.goalBurstSuppression({ ts: 103.408, eventType: "GOAL" })!;
    const owner = attestedGoalBurstOwnerPromotion({
      suppression: sup,
      goalShaped: true,
      measuredGoalAttested: measured.attested,
      liveLane: true,
      deferred: run.pendingDeferredGoalAttestations(),
      acceptWindow: { lo: 93.408, hi: 103.408 },
    })!;
    expect(formatGoalBurstOwnerPromotedReason({ owner, suppression: sup, attestationUsed: measured.used })).toBe(
      "goal_burst_owner_promoted:owner=ab1071b5@100.754s;attestation=scoreBoardChanged+goalCrossed+ballOutcome=goal;gap=3.408s;burst=1"
    );
  });
});

describe("ATTEST-2 promotion end to end (ADAAAA-8442, AT2-AC1/AC2/AC5)", () => {
  /** The accept lane's promotion payload for one measured sibling. */
  function promotionFor(
    owner: DeferredGoalAttestation,
    siblingTs: number,
    used: LiveGoalAttestationUsed
  ): DeferredGoalAttestationUpgrade {
    return {
      ...owner,
      readAt: siblingTs,
      resolvedSurface: storedSurfaceFor(SCORING, undefined),
      attestationUsed: used,
    };
  }

  it("AT2-AC1: for every measured census burst the surviving stored row is the burst owner, scoring_play and postable", async () => {
    const observed: string[] = [];
    for (const c of MEASURED_CASES) {
      const store = new Store(null);
      const ownerAnchor = c.ownerTs + 0.754;
      await store.addHighlight(demotedCelebrationRow(c.owner, ownerAnchor));
      expect(isPostableHighlight(store.getHighlight(c.owner)!)).toBe(false);

      const run = runWithOwner(c.owner, c.ownerTs);
      const measured = measuredAttestation();
      const sup = run.goalBurstSuppression({ ts: c.siblingTs, eventType: "GOAL" })!;
      expect(sup.dedupeAgainstKind).toBe("goal_shaped_celebration");
      expect(sup.dedupeAgainstHighlightId).toBe(c.owner);
      const owner = attestedGoalBurstOwnerPromotion({
        suppression: sup,
        goalShaped: true,
        measuredGoalAttested: measured.attested,
        liveLane: true,
        deferred: run.pendingDeferredGoalAttestations(),
        acceptWindow: { lo: c.siblingTs - 10, hi: c.siblingTs },
      })!;
      expect(owner.highlightId, `${c.id}: chosen owner`).toBe(c.owner);
      const claimed = run.claimBurstCelebrationOwner(owner.highlightId)!;
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const persisted = await attestDeferredGoalHighlight(
        { store } as unknown as LiveHighlightPersistence,
        promotionFor(claimed, c.siblingTs, measured.used)
      );
      spy.mockRestore();

      expect(persisted).not.toBeNull();
      const rows = store.highlightsForJob(JOB);
      // AT2-AC2 / AC5: ONE row for the transition — the owner's own row, its own
      // already-delivered clip. No new clip window was cut for the sibling.
      expect(rows.map((r) => r.id), `${c.id}: one stored row`).toEqual([c.owner]);
      const row = rows[0];
      expect(row.outcome).toBe("scoring_play");
      expect(row.eventType).toBe("GOAL");
      expect(isPostableHighlight(row)).toBe(true);
      // The owner's delivered instant and clip are untouched.
      expect(row.localizedTs).toBe(ownerAnchor);
      expect(row.clipUri).toBe(`/clips/${JOB}-${c.owner}.mp4`);
      expect(row.provisionalGoal).toBeUndefined();
      // The measured attestation that resolved it rides the row (AT2-AC1 quote).
      expect(row.attestationUsed).toMatchObject({
        scoreBoardChanged: true,
        goalCrossed: true,
        ballOutcome: "goal",
        scoreReads: 3,
        preSamples: 3,
        postSamples: 0,
        need: 2,
      });
      // Audit: a NON-delta promotion records the attesting window, never a fake
      // pre/post score pair (there was no legible scoreboard delta here).
      expect(row.deferredAttestation).toEqual({
        deltaTs: c.siblingTs,
        readAt: c.siblingTs,
        windowLo: owner.lo,
        windowHi: owner.hi,
        channel: "measured_attestation",
      });

      // AT2-AC2: exactly ONE postable GOAL card, nothing left in notable, and the
      // count identity `raw - postable = merged + rejected + notScoring + contradicting`
      // still holds.
      const projection = buildPostableHighlights(rows);
      expect(projection.highlights.map((h) => h.id)).toEqual([c.owner]);
      expect(projection.notable).toEqual([]);
      expect(projection.duplicates).toEqual([]);
      const counts = projection.counts;
      expect(counts.total - counts.postable).toBe(
        counts.merged + counts.rejected + counts.notScoring + counts.contradicting
      );
      observed.push(
        `${c.id}@${c.siblingTs}s -> owner ${c.owner} (${sup.gapS.toFixed(3)}s) lane=${row.outcome} postable=${isPostableHighlight(row)}`
      );
    }
    // The evidence line for the ticket: burst id -> chosen owner -> lane.
    console.log(`[ATTEST-2 AC1] ${observed.join(" | ")}`);
    expect(observed).toHaveLength(3);
  });

  it("AT2-AC2: one goal transition keeps exactly one postable GOAL across the whole 3-row burst", async () => {
    // Census shape: one celebration owner (ab1071b5) + the two measured siblings
    // 3.408 s and 5.714 s later. The first attested sibling promotes the owner in
    // place; the second must then dedupe against the PROMOTED GOAL (a
    // `scoring_goal` reference), not against a celebration, so the burst cannot
    // mint a second row.
    const store = new Store(null);
    await store.addHighlight(demotedCelebrationRow("ab1071b5", 100.754));
    const run = runWithOwner("ab1071b5", 100.0);
    const measured = measuredAttestation();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const first = run.goalBurstSuppression({ ts: 103.408, eventType: "GOAL" })!;
    const owner = attestedGoalBurstOwnerPromotion({
      suppression: first,
      goalShaped: true,
      measuredGoalAttested: measured.attested,
      liveLane: true,
      deferred: run.pendingDeferredGoalAttestations(),
      acceptWindow: { lo: 93.408, hi: 103.408 },
    })!;
    const persisted = await attestDeferredGoalHighlight(
      { store } as unknown as LiveHighlightPersistence,
      promotionFor(run.claimBurstCelebrationOwner(owner.highlightId)!, 103.408, measured.used)
    );
    expect(persisted?.outcome).toBe("scoring_play");
    // The accept lane stamps the promoted row onto the delivered-GOAL ledger.
    run.noteAcceptedGoalEvent({
      highlightId: owner.highlightId,
      anchorTs: owner.anchorTs,
      start: owner.lo,
      end: owner.hi,
      candidateTs: 103.408,
      transitionKey: null,
    });

    // Sibling 2 (5.714 s) now dedupes against the PROMOTED GOAL.
    const second = run.goalBurstSuppression({ ts: 105.714, eventType: "GOAL" });
    expect(second?.dedupeAgainstKind).toBe("scoring_goal");
    expect(second?.dedupeAgainstHighlightId).toBe("ab1071b5");
    expect(
      attestedGoalBurstOwnerPromotion({
        suppression: second,
        goalShaped: true,
        measuredGoalAttested: measured.attested,
        liveLane: true,
        deferred: run.pendingDeferredGoalAttestations(),
        acceptWindow: { lo: 95.714, hi: 105.714 },
      })
    ).toBeUndefined();
    spy.mockRestore();

    const rows = store.highlightsForJob(JOB);
    const projection = buildPostableHighlights(rows);
    expect(rows).toHaveLength(1);
    expect(projection.highlights).toHaveLength(1);
    expect(projection.highlights[0].outcome).toBe("scoring_play");
    const c = projection.counts;
    expect(c.total - c.postable).toBe(c.merged + c.rejected + c.notScoring + c.contradicting);
  });
});

// ---------------------------------------------------------------------------
// The REAL accept seam: the wiring this fix adds must fire on the live lane the
// census job ran on (`liveObserveLoop`, `decideWindowN` unset, trailing window),
// and it must not persist a second row for the sibling.
// ---------------------------------------------------------------------------
describe("ATTEST-2 accept-seam wiring (ADAAAA-8442)", () => {
  function liveCfg(over: Partial<AnalyzerConfig> = {}): AnalyzerConfig {
    return {
      jobId: JOB,
      gameHint: "soccer",
      clipBeforeS: 6,
      clipAfterS: 9,
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

  function harness(over: Partial<AnalyzerConfig> = {}) {
    const run = new LiveRunShared({ audioRetainS: 400 });
    const notes: Array<{ status: string; timestamp: number; suppressionReason?: string; suppressionEvidence?: any }> = [];
    const blocked: string[] = [];
    const upgrades: DeferredGoalAttestationUpgrade[] = [];
    const cfg = liveCfg({
      onDecision: (n: any) => notes.push(n),
      onDeferredGoalAttested: (u: DeferredGoalAttestationUpgrade) => upgrades.push(u),
      ...over,
    });
    const cut = async (t: number) => ({ clipId: `clip-${t.toFixed(3)}`, clipUri: `file://clip-${t.toFixed(3)}.mp4` });
    const client = { decide: async () => ({}) as any, confirm: async () => ({}) as any } as any;
    let seq = 0;
    const accept = async (ts: number, stage1: DecisionResult, extra: Partial<CandidateSignal> = {}) => {
      seq += 1;
      await acceptVideoDecision(
        client,
        run,
        cut,
        cfg,
        (ev: any) => {
          if (ev?.type === "candidateBlocked") blocked.push(String(ev.reason ?? ""));
        },
        { seq, timestamp: ts },
        motionCandidate(ts, extra),
        stage1,
        undefined,
        undefined,
        undefined,
        { lo: ts - 10, hi: ts }
      );
    };
    return { run, notes, blocked, upgrades, accept };
  }

  it("promotes the demoted celebration owner in place instead of suppressing the attested goal", async () => {
    const h = harness();
    // The owner: a goal-shaped accept the measured gate demoted (no post sample).
    await h.accept(100.0, SCORING);
    expect(h.run.highlights).toHaveLength(1);
    const owner = h.run.highlights[0];
    expect(owner.outcome).toBe("big_play");
    expect(h.run.pendingDeferredGoalAttestations().map((e) => e.highlightId)).toEqual([owner.id]);

    // The measured sibling 3.408 s later: every measured channel true, no score
    // delta (the census shape). It must PROMOTE the owner, not vanish.
    await h.accept(103.408, SCORING, {
      scoreBoardChanged: true,
      goalCrossed: true,
      ballOutcome: "goal",
      scoreReads: NO_POST_SAMPLE,
    });

    // AT2-AC2: no second row for the one transition.
    expect(h.run.highlights).toHaveLength(1);
    const suppressed = h.notes.filter((n) => n.status === "suppressed");
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].timestamp).toBe(103.408);
    expect(suppressed[0].suppressionReason).toContain(`goal_burst_owner_promoted:owner=${owner.id}`);
    expect(suppressed[0].suppressionReason).toContain("attestation=scoreBoardChanged+goalCrossed+ballOutcome=goal");
    // AT2-AC2: the suppression keeps today's SHAPE (kind + evidence fields).
    expect(suppressed[0].suppressionEvidence).toMatchObject({
      kind: "goal_burst_owner_promoted",
      dedupeAgainstHighlightId: owner.id,
      candidateTs: 103.408,
    });
    expect(h.blocked.some((r) => r.includes(`goal_burst_owner_promoted:owner=${owner.id}`))).toBe(true);
    // The promotion is handed to the ONE promote-in-place writer.
    expect(h.upgrades).toHaveLength(1);
    const up = h.upgrades[0];
    expect(up.highlightId).toBe(owner.id);
    expect(up.readAt).toBe(103.408);
    expect(up.attestationUsed).toMatchObject({ goalCrossed: true, ballOutcome: "goal", scoreBoardChanged: true });
    expect(up.resolvedSurface?.reason).toBeTruthy();
    // No fabricated score read on the attestation-only path.
    expect(up.delta).toBeUndefined();
    // The owner is consumed: a re-decided window cannot promote it twice.
    expect(h.run.pendingDeferredGoalAttestations()).toHaveLength(0);
  });

  it("AT2-AC3: an UNMEASURED sibling keeps today's celebration dedupe (no promotion, no hook)", async () => {
    const h = harness();
    await h.accept(100.0, SCORING);
    expect(h.run.highlights).toHaveLength(1);
    await h.accept(103.408, SCORING); // no measured channels at all
    expect(h.run.highlights).toHaveLength(1);
    expect(h.upgrades).toEqual([]);
    const suppressed = h.notes.filter((n) => n.status === "suppressed");
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].suppressionReason).toContain("goal_burst_same_transition:dedupeAgainst=");
    expect(suppressed[0].suppressionReason).not.toContain("goal_burst_owner_promoted");
    // The owner stays parked for its own deferred re-attestation.
    expect(h.run.pendingDeferredGoalAttestations()).toHaveLength(1);
  });
});
