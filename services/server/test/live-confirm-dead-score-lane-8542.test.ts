// ADAAAA-8542: the browser/media rail's score lane can produce ZERO reads for a
// whole job (`scoreReads=0` on 4/4 rows over 18.5 min, job 50b7aed6 — ADAAAA-8508).
// ADAAAA-8239's hold assumes a "later score read" will arrive; on that rail it
// never does, so three dive-confirmed goals shipped as celebrations (the
// ADAAAA-8417 symptom).
//
// The rule pinned here:
//   - a window whose lane produced NO samples at all (scoreReads=0,
//     preSamples=0, postSamples=0 — DISCLOSED on the row) may be promoted on the
//     dive's own frame attestation, and the row says so
//     (`promotionBasis` + the read counts);
//   - a window that WAS read (scoreReads > 0) and measured no transition keeps
//     the 8239 hold exactly as before — the guard is not widened;
//   - a row that discloses nothing keeps holding (absent evidence is never a
//     measurement of the lane's state);
//   - a HELD row and a REFUTED row are different stored states and different
//     served badges (`dive_held` vs `dive_disagreed`/`unconfirmed`).
import { describe, expect, it } from "vitest";
import {
  confirmDiveAdoption,
  describeRowMeasurement,
  scoreLaneProducedNoSamples,
  type ConfirmDiveVerdict,
  type DegradedSignal,
} from "../src/live-confirm-async.js";
import { confirmationForHighlightRow } from "../src/confirmation-lane.js";

const meta = {
  diveAt: "2026-11-10T02:35:00.000Z",
  diveLatencyMs: 42_000,
  contextDegraded: ["motion_trajectories", "optical_flow", "audio_clip", "audio_levels"] as DegradedSignal[],
};

/** The exact disclosure job 50b7aed6 stored on every delivered row. */
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

/** A lane that WAS read and measured no transition (the 8239 falsifier shape). */
const READ_NO_TRANSITION = {
  scoreBoardChanged: false,
  goalCrossed: false,
  ballOutcome: null,
  corroborated: false,
  goalConfirmed: null,
  scoreReads: 4,
  preSamples: 2,
  postSamples: 0,
  need: 2,
};

const PROVISIONAL = {
  status: "provisional" as const,
  cues: ["frame_celebration" as const],
  declaredTs: 233.67,
  note: "provisional goal: frame celebration in the judged window, no measured scoreboard change yet",
};

function frameVerdict(over: Partial<ConfirmDiveVerdict> = {}): ConfirmDiveVerdict {
  return { goalConfirmed: "confirmed_goal", corroborated: true, corroborationSource: "frame_attestation", ...over };
}

function row(attestationUsed: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    outcome: "big_play",
    eventType: "BIG_PLAY",
    provisionalGoal: { ...PROVISIONAL },
    attestationUsed,
    ...over,
  };
}

describe("scoreLaneProducedNoSamples — dead lane vs read-and-unchanged", () => {
  it("is true only when the row discloses zero reads AND zero samples", () => {
    expect(scoreLaneProducedNoSamples({ attestationUsed: DEAD_LANE })).toBe(true);
  });

  it("is false for a lane that was read (scoreReads > 0), even with no post samples", () => {
    expect(scoreLaneProducedNoSamples({ attestationUsed: READ_NO_TRANSITION })).toBe(false);
    expect(
      scoreLaneProducedNoSamples({ attestationUsed: { ...DEAD_LANE, scoreReads: 1, preSamples: 1, postSamples: 0 } })
    ).toBe(false);
  });

  it("is false when the row discloses no read counts at all (fail-closed)", () => {
    expect(scoreLaneProducedNoSamples({ attestationUsed: { scoreBoardChanged: false, postSamples: 0, need: 2 } })).toBe(
      false
    );
    expect(scoreLaneProducedNoSamples({})).toBe(false);
    expect(scoreLaneProducedNoSamples({ attestationUsed: null })).toBe(false);
  });
});

describe("confirmDiveAdoption — a dive-confirmed goal over a DEAD score lane", () => {
  it("promotes in place on the frame attestation and stores the missing lane", () => {
    const a = confirmDiveAdoption(row({ ...DEAD_LANE }), frameVerdict(), meta);
    expect(a.kind).toBe("promoted");
    expect(a.patch).toMatchObject({
      outcome: "scoring_play",
      eventType: "GOAL",
      provisionalGoal: undefined,
      pendingConfirmDive: undefined,
    });
    // The promotion names its basis and the read counts that proved the lane dead.
    const att = a.patch.confirmAttestation as any;
    expect(att).toMatchObject({
      goalConfirmed: "confirmed_goal",
      corroborated: true,
      corroborationSource: "frame_attestation",
      promotionBasis: "frame_attestation_over_unread_score_lane",
      scoreLane: { scoreReads: 0, preSamples: 0, postSamples: 0, need: 2 },
    });
    // The audit line states why this was allowed past the 8239 hold.
    expect(a.reason).toMatch(/score lane produced no samples/i);
    expect(a.reason).toMatch(/scoreReads=0/);
    expect(a.reason).toMatch(/postSamples=0/);
  });

  it("promotes even when the row carries no provisional marker (no marker to refute)", () => {
    const a = confirmDiveAdoption(
      { outcome: "big_play", eventType: "BIG_PLAY", attestationUsed: { ...DEAD_LANE } },
      frameVerdict(),
      meta
    );
    expect(a.kind).toBe("promoted");
    expect(a.patch.outcome).toBe("scoring_play");
  });

  it("keeps the 8239 hold for a window that WAS read and measured no transition", () => {
    const a = confirmDiveAdoption(row({ ...READ_NO_TRANSITION }), frameVerdict(), meta);
    expect(a.kind).toBe("refuted");
    expect(a.patch.outcome).toBeUndefined();
    expect(a.patch.eventType).toBeUndefined();
    expect(a.patch.provisionalGoal).toMatchObject({
      status: "provisional",
      refuted: false,
      held: true,
      holdReason: "score_lane_read_no_transition",
    });
    expect(a.reason).toMatch(/no measured score transition/i);
  });

  it("keeps the 8239 hold when the row discloses no read counts", () => {
    const a = confirmDiveAdoption(
      row({ scoreBoardChanged: false, postSamples: 0, need: 2 }),
      frameVerdict(),
      meta
    );
    expect(a.kind).not.toBe("promoted");
    expect(a.patch.outcome).toBeUndefined();
  });

  it("does not promote a dead-lane row the dive did NOT corroborate", () => {
    for (const v of [frameVerdict({ corroborated: false }), frameVerdict({ goalConfirmed: "near_miss" })]) {
      const a = confirmDiveAdoption(row({ ...DEAD_LANE }), v, meta);
      expect(a.kind).toBe("refuted");
      expect(a.patch.outcome).toBeUndefined();
      // A real refutation keeps the refuted marker (no holdReason).
      expect(a.patch.provisionalGoal).toMatchObject({ status: "provisional", refuted: true });
      expect((a.patch.provisionalGoal as any).held).toBeUndefined();
    }
  });

  it("never widens the guard for a scoreboard corroboration (it needs no transition)", () => {
    const a = confirmDiveAdoption(row({ ...READ_NO_TRANSITION }), frameVerdict({ corroborationSource: "scoreboard" }), meta);
    expect(a.kind).toBe("promoted");
    expect((a.patch.confirmAttestation as any).promotionBasis).toBeUndefined();
  });

  it("renders the lane state in the audit measurement line", () => {
    expect(describeRowMeasurement({ attestationUsed: DEAD_LANE })).toContain("scoreReads=0");
    expect(describeRowMeasurement({ attestationUsed: { scoreBoardChanged: false, postSamples: 0, need: 2 } })).not.toContain(
      "scoreReads"
    );
  });
});

describe("served confirmation — HELD and REFUTED do not render the same badge", () => {
  const candidate = (goalConfirmed: string) => ({
    status: "accepted" as const,
    eventType: "BIG_PLAY",
    confirm: { decision: { goalConfirmed: goalConfirmed as any, outcome: null, confidence: 0.6, stage1Disagreed: true } } as any,
  });

  it("a HELD row serves the dive_held lane, distinct from the dive lane", () => {
    const held = confirmationForHighlightRow(
      { status: "accepted", provisionalGoal: { held: true, refuted: false } } as any,
      candidate("confirmed_goal") as any
    );
    expect(held?.lane).toBe("dive_held");
    expect(held?.label).toMatch(/held/i);

    const confirmedDive = confirmationForHighlightRow(
      { status: "accepted", provisionalGoal: undefined } as any,
      candidate("confirmed_goal") as any
    );
    expect(confirmedDive?.lane).toBe("dive");
  });

  it("a REFUTED row still serves dive_disagreed (never dive_held)", () => {
    const refuted = confirmationForHighlightRow(
      { status: "accepted", provisionalGoal: { refuted: true } } as any,
      candidate("not_goal") as any
    );
    expect(refuted?.lane).toBe("dive_disagreed");
  });

  it("an ordinary row is unchanged by the held branch", () => {
    expect(
      confirmationForHighlightRow({ status: "accepted", provisionalGoal: null } as any, candidate("confirmed_goal") as any)
        ?.lane
    ).toBe("dive");
  });
});
