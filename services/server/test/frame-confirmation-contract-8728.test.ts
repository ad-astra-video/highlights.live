// ADAAAA-8728 — the frame-confirmation contract: ASR is a cue, never a GOAL
// authority. One falsifier per binding rule, all $0 static (pure predicates, no
// decide call, no OCR, no perceive, no GPU).
//
// RED-at-base / GREEN-at-fix: the observables below are the pre-fix defects, so
// this file fails on `a50cc82` for the reason each rule names, not for a missing
// helper's TypeError (the accessors added by the fix are imported through the
// namespace and asserted to exist first).
import { describe, expect, it } from "vitest";
import {
  confirmDiveAdoption,
  scoreLaneProducedNoSamples,
  type ConfirmDiveVerdict,
  type DegradedSignal,
} from "../src/live-confirm-async.js";
import * as lane from "../src/live-confirm-async.js";
import { confirmationForHighlightRow } from "../src/confirmation-lane.js";
import {
  downgradeUnattestedLiveGoal,
  goalHasIndependentTransitionEvidence,
  liveGoalAttestationUsed,
  liveGoalHasMeasuredEvidence,
} from "../src/analyzer.js";
import * as acceptance from "../src/acceptance-lane.js";

const meta = {
  diveAt: "2026-11-12T09:00:00.000Z",
  diveLatencyMs: 12_000,
  contextDegraded: ["motion_trajectories", "optical_flow", "audio_clip", "audio_levels"] as DegradedSignal[],
  // R3: one persisted frame inside the judged window (the dive loaded it).
  frameRefs: [{ seq: 41, ts: 233.6 }],
};

/** The disclosure job 50b7aed6 stored on a dead browser rail (`scoreReads=0`). */
const DEAD_LANE = {
  scoreBoardChanged: false,
  goalCrossed: false,
  ballOutcome: null,
  corroborated: false,
  goalConfirmed: null,
  scoreReads: 0,
  preSamples: 0,
  postSamples: 0,
  need: 2,
};

/** A lane that WAS read and measured no transition (the 8239 hold shape). */
const READ_NO_TRANSITION = { ...DEAD_LANE, scoreReads: 4, preSamples: 2, postSamples: 0 };

const PROVISIONAL = {
  status: "provisional" as const,
  cues: ["asr_goal_call" as const],
  declaredTs: 233.67,
  note: "provisional goal: ASR goal call",
};

/** Mid-field frames: the model read the apparatus OFF in both channels. */
const MIDFIELD_READS = { ballInNet: false, ballTrajectoryCrossedLine: false };

function row(attestationUsed: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    start: 226,
    end: 245,
    outcome: "big_play",
    eventType: "BIG_PLAY",
    provisionalGoal: { ...PROVISIONAL },
    attestationUsed,
    ...over,
  };
}

function verdict(over: Partial<ConfirmDiveVerdict> = {}): ConfirmDiveVerdict {
  return { goalConfirmed: "confirmed_goal", corroborated: true, corroborationSource: "frame_attestation", ...over };
}

describe("AC-1 / R1 / R4 — commentary corroboration never promotes (even on a dead lane)", () => {
  it("audio_text + confirmed_goal + corroborated + scoreReads=0 stays big_play / dive_held", () => {
    const a = confirmDiveAdoption(
      row({ ...DEAD_LANE }),
      { goalConfirmed: "confirmed_goal", corroborated: true, corroborationSource: "audio_text" },
      meta
    );
    // Never GOAL, never scoring_play, never postable.
    expect(a.kind).not.toBe("promoted");
    expect(a.patch.outcome).toBeUndefined();
    expect(a.patch.eventType).toBeUndefined();
    expect(a.patch.eventType).not.toBe("GOAL");
    // HELD (not refuted): the dive confirmed, the window has no authority.
    const provisional = a.patch.provisionalGoal as any;
    expect(provisional).toMatchObject({ status: "provisional", held: true, holdReason: "text_only_corroboration" });
    expect(provisional.refuted).toBe(false);
    // The row DISCLOSES the authority it refused (R7).
    expect((a.patch.confirmAttestation as any).authority).toBe("none");
    expect((a.patch.confirmAttestation as any).refusalReason).toBe("text_only_corroboration");
    expect((a.patch.attestationUsed as any).authority).toBe("none");
    expect((a.patch.attestationUsed as any).refusalReason).toBe("text_only_corroboration");
    // The served badge is HELD, not CONFIRMED.
    const served = confirmationForHighlightRow({ status: "accepted", provisionalGoal: provisional } as any);
    expect(served?.lane).toBe("dive_held");
  });

  it("the dead-lane disclosure is still the pre-condition (falsifier sanity)", () => {
    expect(scoreLaneProducedNoSamples({ attestationUsed: DEAD_LANE })).toBe(true);
  });
});

describe("AC-2 / R3 — a frame attestation must CITE a frame", () => {
  it("zero cited refs is refused exactly like text", () => {
    const a = confirmDiveAdoption(row({ ...DEAD_LANE }), verdict(), { ...meta, frameRefs: [] });
    expect(a.kind).not.toBe("promoted");
    expect(a.patch.outcome).toBeUndefined();
    const provisional = a.patch.provisionalGoal as any;
    expect(provisional).toMatchObject({ held: true, holdReason: "frame_attestation_uncited" });
    expect((a.patch.confirmAttestation as any).authority).toBe("none");
    expect((a.patch.confirmAttestation as any).refusalReason).toBe("frame_attestation_uncited");
  });

  it("an undisclosed ref list is treated as zero (fail-closed)", () => {
    const a = confirmDiveAdoption(row({ ...DEAD_LANE }), verdict(), {
      diveAt: meta.diveAt,
      diveLatencyMs: meta.diveLatencyMs,
      contextDegraded: meta.contextDegraded,
    });
    expect(a.kind).not.toBe("promoted");
    expect((a.patch.provisionalGoal as any).holdReason).toBe("frame_attestation_uncited");
  });

  it("refs outside the judged window are dropped (inWindowFrameRefs, R3)", () => {
    const filter = (lane as any).inWindowFrameRefs;
    expect(typeof filter).toBe("function"); // RED at base: undefined
    const window = { lo: 221, hi: 249 };
    expect(filter([{ seq: 7, ts: 200 }, { seq: 41, ts: 233.6 }, { seq: 99, ts: 300 }], window)).toEqual([
      { seq: 41, ts: 233.6 },
    ]);
    expect(filter([{ seq: 7, ts: 200 }], window)).toEqual([]);
    expect(filter(null, window)).toEqual([]);
  });
});

describe("AC-3 / R5 — the recall guard: a frame attestation WITH a ref still promotes on a dead lane", () => {
  it("promotes in place, names the basis, and discloses authority=frame", () => {
    const a = confirmDiveAdoption(row({ ...DEAD_LANE }), verdict(), meta);
    expect(a.kind).toBe("promoted");
    expect(a.patch.outcome).toBe("scoring_play");
    expect(a.patch.eventType).toBe("GOAL");
    const att = a.patch.confirmAttestation as any;
    expect(att.promotionBasis).toBe("frame_attestation_over_unread_score_lane");
    expect(att.authority).toBe("frame");
    expect(att.frameRefs).toEqual([{ seq: 41, ts: 233.6 }]);
    expect((a.patch.attestationUsed as any).authority).toBe("frame");
  });

  it("a promotion clears the accept lane's refusal on the same disclosure object", () => {
    const a = confirmDiveAdoption(row({ ...DEAD_LANE, authority: "none", refusalReason: "recap_window_open_play" }), verdict(), meta);
    expect(a.kind).toBe("promoted");
    const used = a.patch.attestationUsed as any;
    expect(used.authority).toBe("frame");
    expect(used.refusalReason).toBeUndefined();
  });

  it("does NOT widen the guard to a lane that WAS read (8239 hold survives)", () => {
    const a = confirmDiveAdoption(row({ ...READ_NO_TRANSITION }), verdict(), meta);
    expect(a.kind).not.toBe("promoted");
    expect((a.patch.provisionalGoal as any).holdReason).toBe("score_lane_read_no_transition");
  });

  it("a scoreboard corroboration still needs no transition (unchanged)", () => {
    const a = confirmDiveAdoption(
      row({ ...READ_NO_TRANSITION }),
      verdict({ corroborationSource: "scoreboard" }),
      meta
    );
    expect(a.kind).toBe("promoted");
    expect((a.patch.confirmAttestation as any).authority).toBe("scoreboard");
  });
});

describe("AC-4 / R6 — the recap discriminator", () => {
  it("mid-field frames + ASR goal call + in-window score flip is refused", () => {
    const recap = (lane as any).recapWindowRefusal;
    expect(typeof recap).toBe("function"); // RED at base: undefined
    expect(recap({ frameReads: MIDFIELD_READS, asrGoalCall: true, scoreBoardChanged: true })).toBe(true);
    // The dive's own confirmed_goal does not override the frames.
    expect(recap({ frameReads: MIDFIELD_READS, diveConfirms: true })).toBe(true);
  });

  it("does not refuse when the frames assert the apparatus or leave it UNKNOWN", () => {
    const recap = (lane as any).recapWindowRefusal;
    expect(typeof recap).toBe("function");
    // ball in the net -> a goal apparatus read, not a recap.
    expect(
      recap({ frameReads: { ballInNet: true, ballTrajectoryCrossedLine: false }, asrGoalCall: true })
    ).toBe(false);
    // unknown reads are not denials (recall is preserved).
    expect(
      recap({
        frameReads: { ballInNet: null, ballTrajectoryCrossedLine: null },
        asrGoalCall: true,
        scoreBoardChanged: true,
      })
    ).toBe(false);
    // no cue at all -> the row is already outside the scoring lane.
    expect(recap({ frameReads: MIDFIELD_READS })).toBe(false);
  });

  it("the refused row ships as big_play with a recap note, never GOAL", () => {
    const used = liveGoalAttestationUsed({
      attribution: { scoreBoardChanged: true, goalCrossed: false },
      corroborated: true,
      corroborationSource: "audio_text",
      refusalReason: "recap_window_open_play",
      // the flip inside the window the recap window displayed
      transitionKey: "1-1>2-1",
      scoreReads: { scoreReads: 9, preSamples: 4, postSamples: 4, need: 2 } as any,
    });
    expect(used.authority).toBe("scoreboard"); // the row DID measure a flip…
    const demoted = downgradeUnattestedLiveGoal(
      { isHighlight: true, score: 0.9, outcome: "scoring_play", eventType: "GOAL", reason: "It's a goal!" },
      used
    );
    // …but the recap refusal still leaves the scoring lane.
    expect(demoted.outcome).toBe("big_play");
    expect(demoted.eventType).toBe("BIG_PLAY");
    expect(demoted.reason).toMatch(/recap of an earlier goal/i);

    // And the adoption path refuses a dive that confirms over its own mid-field reads.
    const a = confirmDiveAdoption(
      row({ ...DEAD_LANE }),
      verdict({ corroborationSource: "audio_text", evidence: MIDFIELD_READS }),
      meta
    );
    expect(a.kind).not.toBe("promoted");
    expect((a.patch.provisionalGoal as any).holdReason).toBe("recap_window_open_play");
  });
});

describe("AC-5 / R7 — a delivered GOAL must name a non-none authority", () => {
  it("the acceptance lane counts delivered GOAL rows with authority none", () => {
    const count = (acceptance as any).countDeliveredGoalsWithoutAuthority;
    expect(typeof count).toBe("function"); // RED at base: undefined
    // A delivered GOAL with no authority is the defect and IS counted.
    expect(count([{ status: "accepted", eventType: "GOAL", authority: "none" }])).toBe(1);
    // Fail-closed: an ABSENT authority on a delivered GOAL counts too (every row
    // written before R7 landed carries no field at all).
    expect(count([{ status: "accepted", eventType: "GOAL" }])).toBe(1);
    // Named authorities, non-GOAL rows and suppressed rows are not.
    expect(
      count([
        { status: "accepted", eventType: "GOAL", authority: "scoreboard" },
        { status: "accepted", eventType: "GOAL", authority: "frame" },
        { status: "accepted", eventType: "BIG_PLAY", authority: "none" },
        { status: "suppressed", eventType: "GOAL", authority: "none" },
      ])
    ).toBe(0);
  });

  it("every row the contract produces names its authority", () => {
    // promoted (frame)
    const promoted = confirmDiveAdoption(row({ ...DEAD_LANE }), verdict(), meta);
    expect((promoted.patch.attestationUsed as any).authority).toBe("frame");
    // held (text)
    const held = confirmDiveAdoption(
      row({ ...DEAD_LANE }),
      verdict({ corroborationSource: "audio_text" }),
      meta
    );
    expect((held.patch.attestationUsed as any).authority).toBe("none");
    // accept-lane disclosure: scoreboard / frame / none
    const base = { scoreBoardChanged: false, goalCrossed: false };
    expect(liveGoalAttestationUsed({ attribution: base, corroborated: true, corroborationSource: "audio_text" }).authority).toBe(
      "none"
    );
    expect(
      liveGoalAttestationUsed({
        attribution: { ...base, scoreBoardChanged: true },
        scoreReads: { scoreReads: 4, preSamples: 2, postSamples: 2, need: 2 } as any,
        transitionKey: "1-1>2-1",
      }).authority
    ).toBe("scoreboard");
    expect(liveGoalAttestationUsed({ attribution: { ...base, goalCrossed: true } }).authority).toBe("frame");
  });
});

describe("seam falsifiers — the three pre-fix authorities", () => {
  it("seam 1: corroborated=true alone no longer counts as MEASURED evidence", () => {
    const contradicted = { scoreReads: 8, preSamples: 4, postSamples: 4, need: 2 } as any;
    // The pre-fix defect: a dive that only heard the announcer certified a GOAL.
    expect(liveGoalHasMeasuredEvidence({ corroborated: true, scoreReads: contradicted })).toBe(false);
    expect(
      liveGoalHasMeasuredEvidence({ corroborated: true, corroborationSource: "audio_text", scoreReads: contradicted })
    ).toBe(false);
    // An uncited frame claim is not an attestation either (R3).
    expect(
      liveGoalHasMeasuredEvidence({
        corroborated: true,
        corroborationSource: "frame_attestation",
        frameRefCount: 0,
      })
    ).toBe(false);
    // A NAMED measured source still attests.
    expect(
      liveGoalHasMeasuredEvidence({ corroborated: true, corroborationSource: "scoreboard", scoreReads: contradicted })
    ).toBe(true);
    expect(
      liveGoalHasMeasuredEvidence({
        corroborated: true,
        corroborationSource: "frame_attestation",
        frameRefCount: 1,
      })
    ).toBe(true);
  });

  it("seam 3: a goal CALL in the audio is not independent transition evidence", () => {
    expect(goalHasIndependentTransitionEvidence({ corroborationSource: "audio_text" })).toBe(false);
    expect(goalHasIndependentTransitionEvidence({ corroborationSource: "scoreboard" })).toBe(true);
    expect(goalHasIndependentTransitionEvidence({ scoreboardDeltaLegible: true })).toBe(true);
  });

  it("seam 2: the dead-lane promotion requires a frame citation, not just a non-score source", () => {
    // audio_text on a dead lane: held, never promoted (the pre-fix defect).
    expect(
      confirmDiveAdoption(row({ ...DEAD_LANE }), verdict({ corroborationSource: "audio_text" }), meta).kind
    ).not.toBe("promoted");
    // frame_attestation with a citation: still the ADAAAA-8417 recall guard.
    expect(confirmDiveAdoption(row({ ...DEAD_LANE }), verdict(), meta).kind).toBe("promoted");
  });
});
