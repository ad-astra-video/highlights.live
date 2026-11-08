// ADAAAA-8441 (ATTEST-1, D2): the demotion note must name the REAL refusal.
//
// Regression source: live job `b55c5781` (browser share, 480-wide rail). All 14
// accepted rows shipped as `big_play` with `reason_raw` asserting
// "live scoring lane: no measured attestation in this window", yet four of them
// carried their own evidence to the contrary:
//
//   ab1071b5  scoreBoardChanged=true scoreReads=2 preSamples=2 postSamples=0
//   dbaeea34  scoreBoardChanged=true scoreReads=5 preSamples=5 postSamples=0
//   a88d198c  scoreBoardChanged=true scoreReads=3 preSamples=3 postSamples=0
//   e4214be4  scoreBoardChanged=true scoreReads=9 preSamples=6 postSamples=3
//
// The refusal on the first three was the SPAN reading one steady score (the
// transition landed after the window closed); on the fourth it was a boundary
// that was not a single forward goal step. AT-AC2 grades this from the stored
// rows alone: zero rows may say "no measured attestation" while
// `attestationUsed.scoreReads >= need` or `scoreBoardChanged=true`.
//
// Copy-only change: the gate, the ledger, the accept lane and the field
// parenthetical are untouched (the 7996/8134/8140 refusals still happen).
import { describe, expect, it } from "vitest";
import {
  LIVE_UNATTESTED_GOAL_NOTE,
  downgradeUnattestedLiveGoal,
  liveGoalAttestationUsed,
  liveUnattestedGoalNote,
  liveUnattestedGoalRefusal,
  type DecisionResult,
  type LiveGoalAttestationUsed,
} from "../src/analyzer.js";

/** The four measured rows of `b55c5781`, verbatim from `highlights.attestationUsed`. */
const MEASURED_ROWS: Array<[string, LiveGoalAttestationUsed]> = [
  [
    "ab1071b5",
    {
      need: 2,
      preSamples: 2,
      scoreReads: 2,
      ballOutcome: null,
      goalCrossed: false,
      postSamples: 0,
      corroborated: false,
      goalConfirmed: null,
      scoreBoardChanged: true,
    },
  ],
  [
    "dbaeea34",
    {
      need: 2,
      preSamples: 5,
      scoreReads: 5,
      ballOutcome: null,
      goalCrossed: false,
      postSamples: 0,
      corroborated: false,
      goalConfirmed: null,
      scoreBoardChanged: true,
    },
  ],
  [
    "a88d198c",
    {
      need: 2,
      preSamples: 3,
      scoreReads: 3,
      ballOutcome: null,
      goalCrossed: false,
      postSamples: 0,
      corroborated: false,
      goalConfirmed: null,
      scoreBoardChanged: true,
    },
  ],
  [
    "e4214be4",
    {
      need: 2,
      preSamples: 6,
      scoreReads: 9,
      ballOutcome: null,
      goalCrossed: false,
      postSamples: 3,
      corroborated: false,
      goalConfirmed: null,
      scoreBoardChanged: true,
    },
  ],
];

/** AT-AC2's census predicate, as the board grades it on `reason_raw`. */
function censusViolation(used: LiveGoalAttestationUsed, note: string): boolean {
  const measured = used.scoreBoardChanged === true || (used.scoreReads ?? 0) >= (used.need ?? 0);
  return measured && note.includes("no measured attestation");
}

describe("liveUnattestedGoalRefusal — names the refusal the row measured", () => {
  it("names the steady span when the transition landed after the window closed", () => {
    for (const [, used] of MEASURED_ROWS.slice(0, 3)) {
      const refusal = liveUnattestedGoalRefusal(used);
      expect(refusal).not.toContain("no measured attestation");
      expect(refusal).toContain("one steady score");
      expect(refusal).toContain("transition landed after the window closed");
    }
  });

  it("names an unlegible boundary when the span met `need` on both sides", () => {
    const used = MEASURED_ROWS[3][1];
    const refusal = liveUnattestedGoalRefusal(used);
    expect(refusal).not.toContain("no measured attestation");
    expect(refusal).toContain("not a legible single forward goal step");
  });

  it("names an unread scorebug separately from a steady one", () => {
    const unread = liveUnattestedGoalRefusal({
      scoreBoardChanged: true,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
      scoreReads: 0,
      preSamples: 0,
      postSamples: 0,
      need: 2,
    });
    expect(unread).toContain("scorebug was never read in this span");
    expect(unread).not.toContain("one steady score");

    const noHint = liveUnattestedGoalRefusal({
      scoreBoardChanged: false,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
      scoreReads: 0,
      need: 2,
    });
    expect(noHint).toContain("scorebug was never read");
    expect(noHint).not.toContain("no measured attestation");
  });

  it("names the tail-only transition with its own counts", () => {
    const refusal = liveUnattestedGoalRefusal({
      scoreBoardChanged: true,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
      scoreReads: 7,
      preSamples: 4,
      postSamples: 1,
      need: 2,
    });
    expect(refusal).toContain("only at the span's tail");
    expect(refusal).toContain("1 post-transition read(s)");
    expect(refusal).toContain("of the 2 needed");
  });

  it("keeps the legacy sentence only when no counts were read at all", () => {
    const legacy = liveGoalAttestationUsed({ attribution: {} });
    expect(liveUnattestedGoalNote(legacy)).toContain("no measured attestation in this window");
    expect(liveUnattestedGoalRefusal(legacy)).toBe("no measured attestation in this window");
  });
});

describe("liveUnattestedGoalNote — copy shape is unchanged where it already worked", () => {
  it("keeps the field parenthetical byte-identical", () => {
    const note = liveUnattestedGoalNote(MEASURED_ROWS[3][1]);
    expect(note).toContain(
      "scoreBoardChanged=true goalCrossed=false ballOutcome=none corroborated=false goalConfirmed=none " +
        "scoreReads=9 preSamples=6 postSamples=3 need=2"
    );
    expect(note).toContain(
      "audio/motion reaction is corroborating evidence only and cannot attest a score — " +
        "delivered as a celebration, not a GOAL"
    );
    expect(note.startsWith("live scoring lane: ")).toBe(true);
  });

  it("returns the ADAAAA-7996 constant when the caller passes no fields", () => {
    expect(liveUnattestedGoalNote()).toBe(LIVE_UNATTESTED_GOAL_NOTE);
  });

  it("still delivers the row as a celebration with the note appended", () => {
    const scoring: DecisionResult = {
      isHighlight: true,
      outcome: "scoring_play",
      eventType: "GOAL",
      score: 90,
      reason: "Scoreboard changes from 1-0 to 2-0.",
    };
    const demoted = downgradeUnattestedLiveGoal(scoring, MEASURED_ROWS[3][1]);
    expect(demoted.outcome).toBe("big_play");
    expect(demoted.eventType).toBe("BIG_PLAY");
    expect(demoted.reason).toContain("Scoreboard changes from 1-0 to 2-0.");
    expect(demoted.reason).toContain("live scoring lane:");
  });
});

describe("AT-AC2 census — zero rows say 'no measured attestation' over a measurement", () => {
  it("passes on the four measured rows of b55c5781", () => {
    const violations = MEASURED_ROWS.filter(([, used]) => censusViolation(used, liveUnattestedGoalNote(used)));
    expect(violations.map(([id]) => id)).toEqual([]);
  });

  it("would have flagged all four before the fix (the old tail was unconditional)", () => {
    const oldTail = "live scoring lane: no measured attestation in this window (fields)";
    const violations = MEASURED_ROWS.filter(([, used]) => censusViolation(used, liveUnattestedGoalNote(used)));
    // The predicate is the AC, not the fixture: assert the old sentence WOULD trip it.
    expect(MEASURED_ROWS.filter(([, used]) => censusViolation(used, oldTail)).length).toBe(4);
    expect(violations.length).toBe(0);
  });
});
