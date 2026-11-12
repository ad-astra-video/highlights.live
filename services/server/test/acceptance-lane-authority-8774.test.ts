// ADAAAA-8774 — the acceptance lane's authority must be the DELIVERED card's
// authority. The QA seed replay on ADAAAA-8768 found the lane falsifier counting
// a delivered GOAL whose own stored `attestationUsed.authority` says `frame`,
// because `laneRowAuthority()` derived from the CANDIDATE record (a bare
// `{kind: motion}` trigger + a decision-only `confirm`) and never read the row's
// disclosure. All $0 static: pure predicates + the tombstone builder, no decide
// call, no DB, no HTTP.
import { describe, expect, it } from "vitest";
import type { JobCandidate } from "@highlights/events";
import {
  acceptanceLaneCounts,
  acceptanceLaneRow,
  buildDeletedJobTombstone,
  candidateRowAuthority,
  countDeliveredGoalsWithoutAuthority,
  deliveredAuthorityByCandidate,
  laneRowAuthority,
} from "../src/acceptance-lane.js";
import { liveGoalAttestationUsed } from "../src/analyzer.js";

/** Job 70400b1d's row 5f32f6f4 (ts 17s): the candidate carries only a motion
 *  trigger and a decision/request confirm — no scoreboard, goal-line or
 *  corroborated signal. A candidate-only derivation reads `none`. */
function motionCandidate(over: Record<string, unknown> = {}): JobCandidate {
  return {
    id: "5f32f6f4",
    jobId: "70400b1d",
    seq: 3,
    timestamp: 17,
    eventType: "GOAL",
    score: 0.91,
    isHighlight: true,
    outcome: "scoring_play",
    status: "accepted",
    reason: "It's a goal!",
    trigger: { kind: "motion", timestamp: 17, eventType: "GOAL" },
    confirm: {
      request: { prompt: "P", dataItems: [], frames: [], keyframes: [], trajectories: [], audioLevels: [] },
      decision: { goalConfirmed: "confirmed_goal", confidence: 0.8 },
    },
    createdAt: "2026-11-12T07:55:00.000Z",
    ...over,
  } as unknown as JobCandidate;
}

/** The SAME moment's delivered card: `attestationUsed.authority = frame`, a
 *  corroborated confirmed goal with ball-in-net evidence. */
const DELIVERED_FRAME = {
  candidateId: "5f32f6f4",
  status: "accepted",
  corroborationSource: "frame_attestation",
  attestationUsed: {
    scoreBoardChanged: false,
    goalCrossed: true,
    ballOutcome: "in_net",
    corroborated: true,
    goalConfirmed: "confirmed_goal",
    authority: "frame",
    frameRefCount: 1,
  },
};

describe("laneRowAuthority prefers the delivered row's disclosure (ADAAAA-8774)", () => {
  it("the seed card: candidate says none, the delivered row says frame — the lane says frame", () => {
    const c = motionCandidate();
    // The defect's basis: the candidate record alone cannot see the authority.
    expect(candidateRowAuthority(c)).toBe("none");
    expect(laneRowAuthority(c)).toBe("none");
    // With the delivered row the lane agrees with the card it is describing.
    expect(laneRowAuthority(c, DELIVERED_FRAME)).toBe("frame");
  });

  it("projects both bases on the lane row, so a disagreement is visible not silent", () => {
    const row = acceptanceLaneRow(motionCandidate(), DELIVERED_FRAME);
    expect(row.authority).toBe("frame");
    expect(row.authoritySource).toBe("row");
    expect(row.candidateAuthority).toBe("none");
    // The trigger half of the projection is untouched (it describes the decide
    // record, not the attestation).
    expect(row.trigger).toMatchObject({ kind: "motion", scoreBoardChanged: null });
  });

  it("AC-5 falsifier: the delivered GOAL that names a measured authority is NOT a violation", () => {
    const row = acceptanceLaneRow(motionCandidate(), DELIVERED_FRAME);
    expect(countDeliveredGoalsWithoutAuthority([row])).toBe(0);
    // Without the disclosure the same candidate is the pre-fix violation (1).
    expect(countDeliveredGoalsWithoutAuthority([acceptanceLaneRow(motionCandidate())])).toBe(1);
  });

  it("a delivered `none` is final: the candidate fallback never re-credits a demoted card", () => {
    const c = motionCandidate({
      trigger: { kind: "score_change", timestamp: 17, eventType: "GOAL", scoreBoardChanged: true },
    });
    const demoted = { candidateId: "5f32f6f4", status: "accepted", attestationUsed: { authority: "none", refusalReason: "text_only_corroboration" } };
    const row = acceptanceLaneRow(c, demoted);
    expect(row.authority).toBe("none");
    expect(row.authoritySource).toBe("row");
    // The candidate DID see a score change — reported beside it, not preferred.
    expect(row.candidateAuthority).toBe("scoreboard");
    expect(countDeliveredGoalsWithoutAuthority([row])).toBe(1);
  });

  it("pre-R7 lanes (no attestationUsed) fall back to the candidate basis", () => {
    // Lane a44acd8a's shape: the row persisted `attestationUsed` without
    // `authority`; the trigger carried `scoreBoardChanged: true`.
    const c = motionCandidate({
      id: "d6440869",
      trigger: { kind: "score_change", timestamp: 41, eventType: "GOAL", scoreBoardChanged: true },
    });
    const legacy = { candidateId: "d6440869", status: "accepted", attestationUsed: { scoreBoardChanged: true, goalCrossed: true, ballOutcome: "in_net", corroborated: true, goalConfirmed: "confirmed_goal" } };
    const row = acceptanceLaneRow(c, legacy);
    expect(row.authority).toBe("scoreboard");
    expect(row.authoritySource).toBe("candidate");
    expect(countDeliveredGoalsWithoutAuthority([row])).toBe(0);
  });
});

describe("deliveredAuthorityByCandidate (ADAAAA-8774)", () => {
  it("indexes accepted rows by candidateId and drops unattributable/undelivered ones", () => {
    const map = deliveredAuthorityByCandidate([
      DELIVERED_FRAME as any,
      // no candidateId -> cannot be attributed to a lane row
      { status: "accepted", attestationUsed: { authority: "scoreboard" } },
      // not delivered -> its disclosure never describes a lane accept
      { candidateId: "rej", status: "rejected", attestationUsed: { authority: "none" } },
      // no disclosure at all -> nothing to prefer
      { candidateId: "bare", status: "accepted" },
      // a re-attested row replaces the earlier one (single row per candidate)
      { candidateId: "5f32f6f4", status: "accepted", attestationUsed: { authority: "scoreboard" } },
    ]);
    expect([...map.keys()]).toEqual(["5f32f6f4"]);
    expect(map.get("5f32f6f4")!.attestationUsed!.authority).toBe("scoreboard");
  });
});

describe("tombstone keeps the delivered authority (ADAAAA-8774)", () => {
  const job = { id: "70400b1d", ownerId: "u1", status: "done", source: "browser" } as any;

  it("counts 0 violations on the seed lane — the whole point of the falsifier fix", () => {
    const candidates = [motionCandidate()];
    const withDelivered = buildDeletedJobTombstone(
      job,
      candidates,
      { highlights: 1, alternatives: 0, observations: 0, delivered: [DELIVERED_FRAME as any] },
      "u1",
      "2026-11-12T13:00:00.000Z"
    );
    expect(withDelivered.counts.goalsWithNoAuthority).toBe(0);
    expect(withDelivered.candidates[0].authority).toBe("frame");
    expect(withDelivered.candidates[0].authoritySource).toBe("row");

    // Pre-fix shape (no `delivered` handed to the builder): 1 violation, i.e.
    // the tombstone would have contradicted the card it outlives.
    const without = buildDeletedJobTombstone(
      job,
      candidates,
      { highlights: 1, alternatives: 0, observations: 0 },
      "u1",
      "2026-11-12T13:00:00.000Z"
    );
    expect(without.counts.goalsWithNoAuthority).toBe(1);
    expect(without.candidates[0].authority).toBe("none");
  });

  it("the extra counts still come out of the same rows (no double projection)", () => {
    const rows = [acceptanceLaneRow(motionCandidate(), DELIVERED_FRAME)];
    const counts = acceptanceLaneCounts(rows, { highlights: 2, alternatives: 1, observations: 3 });
    expect(counts).toMatchObject({
      candidates: 1,
      accepted: 1,
      confirmed: 1,
      goalsWithNoAuthority: 0,
      highlights: 2,
      alternatives: 1,
      observations: 3,
    });
  });
});

describe("R3 is re-derivable offline from the stored row (ADAAAA-8774)", () => {
  it("a frame attestation discloses its cited-frame count", () => {
    const cited = liveGoalAttestationUsed({
      attribution: { scoreBoardChanged: false, goalCrossed: false },
      corroborated: true,
      corroborationSource: "frame_attestation",
      frameRefCount: 1,
    });
    expect(cited.authority).toBe("frame");
    expect(cited.frameRefCount).toBe(1);

    // Cited nothing -> refused, and the count says so on the row itself.
    const uncited = liveGoalAttestationUsed({
      attribution: { scoreBoardChanged: false, goalCrossed: false },
      corroborated: true,
      corroborationSource: "frame_attestation",
      frameRefCount: 0,
      refusalReason: "frame_attestation_uncited",
    });
    expect(uncited.authority).toBe("none");
    expect(uncited.frameRefCount).toBe(0);
    expect(uncited.refusalReason).toBe("frame_attestation_uncited");
  });

  it("absent means 'no frame claim', NOT zero cited frames", () => {
    // A goal-line/net-attested row is `authority: frame` with no dive claim; a
    // strict re-application of R3 must not read it as uncited.
    const goalLine = liveGoalAttestationUsed({
      attribution: { scoreBoardChanged: false, goalCrossed: true, ballOutcome: "in_net" },
    });
    expect(goalLine.authority).toBe("frame");
    expect("frameRefCount" in goalLine).toBe(false);

    // A scoreboard/audio-text attestation discloses no citation count either.
    const scoreboard = liveGoalAttestationUsed({
      attribution: { scoreBoardChanged: true },
      scoreReads: { scoreReads: 4, preSamples: 2, postSamples: 2, need: 2 } as any,
      transitionKey: "1-1>2-1",
    });
    expect(scoreboard.authority).toBe("scoreboard");
    expect("frameRefCount" in scoreboard).toBe(false);
  });
});
