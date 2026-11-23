// ADAAAA-8866: the MATCH SUMMARY banner counted frame-attested goals
// (`verifiedGoalCount`) while the same rows' cards badge CONFIRMED on their
// confirmation lane (`measured` / `dive`), which can be true WITHOUT frame
// attestation. On the long-form VOD ladder job `e37db9fe` the served banner read
// "2 accepted goals (0 corroborated)" beside two CONFIRMED cards, which reads as
// a contradiction.
//
// Resolution (this ticket's ACs): keep the two counters separate (collapsing
// them would overclaim on `measured`), make the banner NAME the strength it
// counts, and OMIT the clause when it would print a zero — a zero is a claim, an
// omission is not. Copy only: `goalCount` / `verifiedGoalCount` are untouched.
//
//   AC1  no bare "(0 corroborated)"; strength named ("frame-corroborated") when
//        non-zero, clause omitted at zero
//   AC2  verifiedGoalCount byte-identical for every job (counters untouched)
//   AC3  card badges unchanged (lane -> CONFIRMED/HELD/UNCONFIRMED)
//   AC4  $0: stored rows in, ladder out — no leg, no GPU, no DB write
import { describe, it, expect } from "vitest";
import { buildSummaryLadder, legacyPairCorroborated } from "../src/summary-ladder";
import { laneConfirmsGoal } from "../src/confirmation-lane";

const LOG = [
  { seq: 1, ts: "2026-11-09T00:00:00Z", windowTs: 0, text: "The keeper rolls the ball out to the left back." },
  { seq: 2, ts: "2026-11-09T00:00:00Z", windowTs: 20, text: "The blue shirt drives into the box and shoots." },
  { seq: 3, ts: "2026-11-09T00:00:00Z", windowTs: 40, text: "Play restarts from the centre circle." },
  { seq: 4, ts: "2026-11-09T00:00:00Z", windowTs: 77, text: "The white shirt clears the ball wide." },
];

/**
 * The stored shape of the two `e37db9fe` rows: a Stage-1 score measurement that
 * the card badges CONFIRMED (`confirmation.lane === "measured"`) while the row
 * carries `corroborated: false` — no frame attestation.
 */
function measuredRow(id: string, start: number) {
  return {
    id,
    jobId: "e37db9fe",
    clipUri: `/clips/${id}.mp4`,
    start,
    end: start + 8,
    eventType: "GOAL",
    status: "accepted",
    score: 90,
    confirmation: { lane: "measured", label: "measured" },
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

const NO_PAREN_ZERO = /\(0 (?:frame-)?corroborated/;

describe("banner names the corroboration strength it counts (ADAAAA-8866)", () => {
  it("a ladder job with measured rows and no frame attestation prints no zero clause", () => {
    // The e37db9fe shape on the rail it was served from: the long-form VOD
    // (`file`) ladder, which reads the legacy top-level pair.
    const rows = [measuredRow("95617c79", 20), measuredRow("da53da56", 77)];
    const ladder = buildSummaryLadder({ summaryLog: LOG as any, highlights: rows as any, gameHint: "Soccer" });

    expect(ladder.matchSummary.goalCount).toBe(2);
    expect(ladder.matchSummary.text).toContain("2 accepted goals");
    expect(ladder.matchSummary.text).not.toMatch(NO_PAREN_ZERO);
    // The strength is never silently asserted at zero: the CLAUSE is absent (the
    // per-goal "(never corroborated)" suffix on the timeline line is a row fact).
    expect(ladder.matchSummary.text).not.toMatch(/\(\d+ (?:frame-)?corroborated\)/);
  });

  it("names the strength when a row carries frame attestation", () => {
    const rows = [{ ...measuredRow("95617c79", 20), corroborated: true }, measuredRow("da53da56", 77)];
    const ladder = buildSummaryLadder({ summaryLog: LOG as any, highlights: rows as any, gameHint: "Soccer" });

    expect(ladder.matchSummary.verifiedGoalCount).toBe(1);
    expect(ladder.matchSummary.text).toContain("2 accepted goals (1 frame-corroborated)");
    expect(ladder.matchSummary.text).not.toMatch(NO_PAREN_ZERO);
  });

  it("chapter digests carry the same phrase, and the rollup keeps it whole", () => {
    const rows = [measuredRow("95617c79", 20), measuredRow("da53da56", 77)];
    const ladder = buildSummaryLadder({ summaryLog: LOG as any, highlights: rows as any, gameHint: "Soccer" });

    const withGoals = ladder.chapters.filter((c) => c.goalCount > 0);
    expect(withGoals.length).toBeGreaterThan(0);
    for (const chapter of withGoals) {
      expect(chapter.summary).toMatch(/\d+ accepted goals?\.$/);
      expect(chapter.summary).not.toMatch(NO_PAREN_ZERO);
    }
    const bullets = ladder.matchSummary.text.split("\n").filter((line) => line.startsWith("- "));
    for (const bullet of bullets.filter((b) => /\d+ accepted goal/.test(b))) {
      // A whole sentence: never `(0…`, never a bare `(` and never a cut suffix.
      expect(bullet).toMatch(/\d+ accepted goals?(?: \(\d+ frame-corroborated\))?\.$/);
    }
  });

  it("a zero corroboration count with pending rows names only the approval clause", () => {
    const rows = [
      { ...measuredRow("95617c79", 20), status: "pending" },
      measuredRow("da53da56", 77),
    ];
    const ladder = buildSummaryLadder({ summaryLog: LOG as any, highlights: rows as any, gameHint: "Soccer" });

    expect(ladder.matchSummary.verifiedGoalCount).toBe(0);
    expect(ladder.matchSummary.text).toContain("2 goals (1 awaiting approval)");
    expect(ladder.matchSummary.text).not.toMatch(NO_PAREN_ZERO);
    expect(ladder.matchSummary.text).not.toContain("accepted goals");
  });
});

describe("the counters are untouched (ADAAAA-8866 AC2)", () => {
  it("verifiedGoalCount equals the legacy pair count on every row set", () => {
    const sets: any[][] = [
      [],
      [measuredRow("a", 20)],
      [measuredRow("a", 20), measuredRow("b", 77)],
      [{ ...measuredRow("a", 20), corroborated: true }],
      [{ ...measuredRow("a", 20), goalConfirmed: "confirmed_goal" }],
      [{ ...measuredRow("a", 20), corroborated: true }, measuredRow("b", 77)],
    ];
    for (const rows of sets) {
      const ladder = buildSummaryLadder({ summaryLog: LOG as any, highlights: rows as any, gameHint: "Soccer" });
      // AC2: the pre-change expression, byte for byte.
      expect(ladder.matchSummary.verifiedGoalCount).toBe(rows.filter(legacyPairCorroborated).length);
      // ... and the number the banner prints IS that count, never a re-derivation.
      expect(ladder.matchSummary.verifiedGoalCount).toBe(
        ladder.matchSummary.goalTimeline.filter((g) => g.verified).length
      );
      const named = ladder.matchSummary.text.match(/\((\d+) frame-corroborated\)/);
      expect(named ? Number(named[1]) : 0).toBe(ladder.matchSummary.verifiedGoalCount);
    }
  });

  it("goalCount is the served card population, unchanged by the copy", () => {
    const rows = [measuredRow("a", 20), measuredRow("b", 77), { ...measuredRow("c", 40), status: "rejected" }];
    const ladder = buildSummaryLadder({ summaryLog: LOG as any, highlights: rows as any, gameHint: "Soccer" });
    expect(ladder.matchSummary.goalCount).toBe(2);
  });
});

describe("card badge mapping is untouched (ADAAAA-8866 AC3)", () => {
  it("measured and dive confirm; held, disagreed and unconfirmed do not", () => {
    expect(laneConfirmsGoal("measured")).toBe(true);
    expect(laneConfirmsGoal("dive")).toBe(true);
    expect(laneConfirmsGoal("dive_held")).toBe(false);
    expect(laneConfirmsGoal("dive_disagreed")).toBe(false);
    expect(laneConfirmsGoal("unconfirmed")).toBe(false);
  });
});
