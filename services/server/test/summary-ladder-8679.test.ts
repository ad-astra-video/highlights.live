// ADAAAA-8679 (follow-up to ADAAAA-8645 AC6): the `file` (long-form VOD) rail's
// ladder must stay byte-identical to the pre-8645 output. Measured on the served
// build `8e192f9` with read-only `GET /jobs/:id/detail` on two done VOD jobs whose
// rows predate the deploy (the 8645 diff is read-path only, so the stored bytes
// did not move — the PREDICATE did):
//
//   e24bc0e4  rows 95617c79 (20 s), da53da56 (77 s)  served 2 corroborated, legacy pair 0
//   fb571425  row  6bf926d0 (20 s)                    served 1 corroborated, legacy pair 0
//
// Both rows store `attestationUsed = { scoreBoardChanged: true, goalCrossed: false,
// ballOutcome: null, corroborated: false, goalConfirmed: null }` and no
// `confirmAttestation`. `goalTimelineFrom`'s predicate-less fallback
// (`isCorroboratedHighlight`) read that measured scoreboard change as
// corroboration, which the legacy top-level pair does not.
//
// The decision of record (this ticket): PRESERVE THE BYTES. The VOD rail derives
// its ladder without candidate records, so it has no card `confirmation` lane and
// no CONFIRMED badge for the banner to agree with — the 8645 widening exists for
// banner/badge parity on the fast rail, so it stays there. These tests pin both
// halves: the VOD rail reads the legacy pair only, and the fast rail still honours
// the lane (and, predicate-less, the row-only rule).
import { describe, it, expect } from "vitest";
import { buildSummaryLadder, legacyPairCorroborated } from "../src/summary-ladder";

const LOG = [
  { seq: 1, ts: "2026-11-09T00:00:00Z", windowTs: 0, text: "The keeper rolls the ball out to the left back." },
  { seq: 2, ts: "2026-11-09T00:00:00Z", windowTs: 20, text: "The blue shirt drives into the box and shoots." },
  { seq: 3, ts: "2026-11-09T00:00:00Z", windowTs: 40, text: "Play restarts from the centre circle." },
  { seq: 4, ts: "2026-11-09T00:00:00Z", windowTs: 77, text: "The white shirt clears the ball wide." },
];

/** The exact stored shape of the two e24bc0e4 / fb571425 rows. */
function measuredTransitionRow(id: string, start: number) {
  return {
    id,
    jobId: "e24bc0e4",
    clipUri: `/clips/${id}.mp4`,
    start,
    end: start + 8,
    eventType: "GOAL",
    status: "accepted",
    score: 90,
    attestationUsed: {
      scoreBoardChanged: true,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
      scoreReads: 18,
    },
  };
}

const E24_ROWS = [measuredTransitionRow("95617c79", 20), measuredTransitionRow("da53da56", 77)];

function ladderOf(rows: unknown[], fastRail: boolean, corroborated?: (h: any) => boolean) {
  return buildSummaryLadder({
    summaryLog: LOG as any,
    highlights: rows as any,
    gameHint: "soccer",
    fastRail,
    ...(corroborated ? { corroborated } : {}),
  });
}

describe("file/VOD ladder keeps the pre-8645 banner rule (ADAAAA-8679, AC6)", () => {
  it("a row whose only evidence is a measured scoreboard change is NOT corroborated on the VOD rail", () => {
    const vod = ladderOf(E24_ROWS, false);
    // The served header for e24bc0e4 read "2 accepted goals (2 corroborated)" on
    // 8e192f9; pre-change it read "(0 corroborated)".
    expect(vod.matchSummary.goalCount).toBe(2);
    expect(vod.matchSummary.verifiedGoalCount).toBe(0);
    expect(vod.matchSummary.goalTimeline.map((g) => g.verified)).toEqual([false, false]);
    expect(vod.matchSummary.text).toContain("2 accepted goals (0 corroborated)");
    expect(vod.matchSummary.text).toContain("Goals in order: #1 0:20 (never corroborated), #2 1:17 (never corroborated)");
  });

  it("the same rows still count on the fast rail when its card lane confirms them (8645 widening intact)", () => {
    const live = ladderOf(E24_ROWS, true, () => true);
    expect(live.matchSummary.verifiedGoalCount).toBe(2);
    expect(live.matchSummary.text).toContain("2 accepted goals (2 corroborated)");
  });

  it("a predicate-less fast caller still reads the row-only rule", () => {
    const live = ladderOf(E24_ROWS, true);
    expect(live.matchSummary.verifiedGoalCount).toBe(2);
  });

  it("a stored Stage-2 verdict does not widen the VOD rail either", () => {
    const rows = [
      {
        ...measuredTransitionRow("dive", 20),
        attestationUsed: undefined,
        confirmAttestation: { goalConfirmed: "confirmed_goal", corroborated: true },
      },
    ];
    expect(ladderOf(rows, false).matchSummary.verifiedGoalCount).toBe(0);
    // Same row on the predicate-less fast path is corroborated, so the rail — not
    // the rule — is what differs.
    expect(ladderOf(rows, true).matchSummary.verifiedGoalCount).toBe(1);
  });

  it("the legacy top-level pair a VOD row carries still counts, byte-identically", () => {
    const rows = [
      { ...measuredTransitionRow("pair-true", 20), attestationUsed: undefined, corroborated: true },
      { ...measuredTransitionRow("pair-confirmed", 77), attestationUsed: undefined, goalConfirmed: "confirmed_goal" },
    ];
    const vod = ladderOf(rows, false);
    expect(vod.matchSummary.verifiedGoalCount).toBe(2);
    expect(vod.matchSummary.text).toContain("2 accepted goals (2 corroborated)");
    expect(vod.matchSummary.text).not.toContain("(never corroborated)");
  });

  it("matches the literal pre-change expression over a mixed VOD row set", () => {
    const rows = [
      measuredTransitionRow("a", 0),
      { ...measuredTransitionRow("b", 1), attestationUsed: undefined, corroborated: true },
      { ...measuredTransitionRow("c", 2), attestationUsed: undefined, goalConfirmed: "confirmed_goal" },
      { ...measuredTransitionRow("d", 3), attestationUsed: undefined, goalConfirmed: " confirmed_goal " },
      { ...measuredTransitionRow("e", 4), attestationUsed: undefined, goalConfirmed: "Confirmed_Goal" },
      { ...measuredTransitionRow("f", 5), attestationUsed: undefined, corroborated: false, goalConfirmed: null },
      { ...measuredTransitionRow("g", 6), attestationUsed: undefined, confirmAttestation: { goalConfirmed: "near_miss", corroborated: false } },
    ];
    // `e806932 services/server/src/summary-ladder.ts:446`, verbatim.
    const preChange = rows.filter((r: any) => r.corroborated === true || r.goalConfirmed === "confirmed_goal").length;
    const vod = ladderOf(rows, false);
    expect(preChange).toBe(2);
    expect(vod.matchSummary.goalCount).toBe(rows.length);
    expect(vod.matchSummary.verifiedGoalCount).toBe(preChange);
    // The comparison is exact (the pre-change expression was), never normalised.
    expect(vod.matchSummary.goalTimeline.map((g) => g.verified)).toEqual([
      false, true, true, false, false, false, false,
    ]);
  });

  it("legacyPairCorroborated is the pre-change expression itself", () => {
    expect(legacyPairCorroborated({ corroborated: true } as any)).toBe(true);
    expect(legacyPairCorroborated({ goalConfirmed: "confirmed_goal" } as any)).toBe(true);
    expect(legacyPairCorroborated({ goalConfirmed: " confirmed_goal " } as any)).toBe(false);
    expect(legacyPairCorroborated({ attestationUsed: { scoreBoardChanged: true } } as any)).toBe(false);
    expect(legacyPairCorroborated({} as any)).toBe(false);
  });

  it("ignores a supplied fast-rail predicate on the VOD rail (AC8)", () => {
    const vod = ladderOf(E24_ROWS, false, () => true);
    expect(vod.matchSummary.verifiedGoalCount).toBe(0);
  });
});
