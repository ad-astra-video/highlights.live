import { describe, expect, it } from "vitest";
import { HighlightRecordSchema, type HighlightRecord } from "@highlights/events";
import { buildPostableHighlights } from "../src/highlight-postable";
import { confirmationForHighlightRow, laneConfirmsGoal } from "../src/confirmation-lane";
import { buildSummaryLadder } from "../src/summary-ladder";

// ADAAAA-8678: measured on the served build `8e192f9`, job
// `bc2d3460-f4f1-488a-b5b5-eb765c784642` (a `file-sim` stub-decide fixture).
//
// Stored rows `93ac1b1b` (start 62 s) and `b0aee4d9` (start 94 s) carry
// `status: "pending"` with `outcome: "scoring_play"`, plus two `pending`
// `big_play` siblings. Measured on the page: 2 postable GOAL cards, BOTH with no
// `confirmation` block at all (their `candidateId` window measured nothing, so no
// lane derived) and the badge UNCONFIRMED — beside a MATCH SUMMARY reading
// `goalCount 0`, because the ladder re-filtered `status === "accepted"` while the
// cards did not.
//
// The contract this file pins:
//
//  1. `pending` SHIPS. `status` is a PUBLISH state, not an evidence verdict:
//     auto-publish off (`config.autoPublishHighlights`) stores `pending`, and the
//     card's own Approve control (`verdictAction`) is what settles it. Dropping
//     the row would strand that flow and blank every such box. `rejected` stays
//     the only status-level drop, and a settled (`accepted`) row — what an
//     exported clip flips to — is served unchanged. `published` is not a member
//     of the enum (pending|accepted|rejected).
//  2. A shipped row never asserts a GOAL with no disclosure: an unapproved row
//     with no measurement and no dive carries `confirmation.lane = "unconfirmed"`
//     worded as the approve queue ("Awaiting approval — …"), never the
//     "Accepted …" sentence, and still badges UNCONFIRMED.
//  3. The banner reads the SAME population as the cards: the ladder receives
//     `postable.highlights` and counts every GOAL card in it, so `goalCount` can
//     never disagree with the rendered list. A counted-but-unapproved goal is
//     worded "awaiting approval", never "accepted".
const JOB = "bc2d3460-f4f1-488a-b5b5-eb765c784642";

/** One persisted row of the measured fixture (defaults: GOAL scoring_play at 15 s). */
function row(over: Partial<HighlightRecord> & { id: string; start: number }): HighlightRecord {
  return HighlightRecordSchema.parse({
    jobId: JOB,
    ownerId: "owner-1",
    clipUri: `clips/${over.id}.mp4`,
    end: over.start + 15,
    eventType: "GOAL",
    score: 80,
    outcome: "scoring_play",
    reason: "A shot is struck from the edge of the box and the ball ends in the net.",
    status: "pending",
    createdAt: "2026-11-11T13:00:00.000Z",
    ...over,
  });
}

/** The two GOAL rows + two big_play siblings, exactly as stored (all pending). */
const MEASURED: HighlightRecord[] = [
  row({ id: "93ac1b1b", start: 62 }),
  row({ id: "b0aee4d9", start: 94 }),
  row({ id: "celeb-1", start: 68, eventType: "BIG_PLAY", outcome: "big_play", score: 40 }),
  row({ id: "celeb-2", start: 100, eventType: "BIG_PLAY", outcome: "big_play", score: 40 }),
];

/** A stored window narrative covering both goal instants (the ladder's chapters). */
const LOG = [
  { seq: 0, ts: "2026-11-11T13:00:00.000Z", windowTs: 60, text: "The attack builds through midfield." },
  { seq: 1, ts: "2026-11-11T13:00:03.000Z", windowTs: 66, text: "A shot is taken from the edge of the box." },
  { seq: 2, ts: "2026-11-11T13:00:06.000Z", windowTs: 92, text: "A second attack forms down the left side." },
  { seq: 3, ts: "2026-11-11T13:00:09.000Z", windowTs: 98, text: "The ball is played into the box again." },
];

/** The card's lane, i.e. the exact predicate the served routes thread into the
 *  ladder (`corroborated: (h) => laneConfirmsGoal(confirmationFor(h)?.lane)`). */
const cardConfirmsGoal = (h: HighlightRecord) => laneConfirmsGoal(confirmationForHighlightRow(h)?.lane);

describe("postability contract: a pending row ships (ADAAAA-8678)", () => {
  const postable = buildPostableHighlights(MEASURED);

  it("serves both pending scoring_play GOAL rows as postable cards", () => {
    expect(postable.highlights.map((h) => h.id)).toEqual(["93ac1b1b", "b0aee4d9"]);
    expect(postable.counts.postable).toBe(2);
    expect(postable.counts.rejected).toBe(0);
  });

  it("keeps the pending big_play siblings in the notable lane (never a GOAL card)", () => {
    const notableIds = postable.notableMoments.moments.flatMap((m) => [m.owner.id, ...m.options.map((o) => o.id)]);
    expect(notableIds.sort()).toEqual(["celeb-1", "celeb-2"]);
    expect(postable.highlights.some((h) => notableIds.includes(h.id))).toBe(false);
  });

  it("accounts every shipped row on the page (no silent gap, no new drop reason)", () => {
    // The two big_play siblings are ONE notable moment (owner + rail option),
    // which is the ADAAAA-8443 grouping — both rows still reach the page.
    expect(postable.rowAccounting.served.map((s) => `${s.id}:${s.representation}`)).toEqual([
      "93ac1b1b:card",
      "b0aee4d9:card",
      "celeb-1:notable_card",
      "celeb-2:sibling_clip",
    ]);
    expect(postable.rowAccounting.unrepresented).toEqual([]);
  });

  it("still refuses a rejected row, and a settled accepted row is served unchanged", () => {
    const out = buildPostableHighlights([
      ...MEASURED,
      row({ id: "rej-1", start: 200, status: "rejected" }),
      row({ id: "acc-1", start: 300, status: "accepted" }),
    ]);
    expect(out.highlights.map((h) => h.id)).toEqual(["93ac1b1b", "b0aee4d9", "acc-1"]);
    expect(out.counts.rejected).toBe(1);
    expect(out.rowAccounting.unrepresented).toEqual([{ id: "rej-1", reason: "rejected" }]);
  });
});

describe("card accounting: an unapproved GOAL row states its lane", () => {
  it("derives `unconfirmed` worded as the approve queue when nothing measured and no dive ran", () => {
    const conf = confirmationForHighlightRow(row({ id: "93ac1b1b", start: 62 }));
    expect(conf?.lane).toBe("unconfirmed");
    expect(conf?.label).toMatch(/^Awaiting approval — /);
    expect(conf?.label).not.toMatch(/Accepted/);
    // The badge rule is unchanged: unconfirmed is NOT a CONFIRMED card.
    expect(laneConfirmsGoal(conf?.lane)).toBe(false);
  });

  it("does not hide a pending row's own measured attestation", () => {
    const conf = confirmationForHighlightRow(
      row({
        id: "att-1",
        start: 62,
        trigger: { kind: "goal_line", timestamp: 62, eventType: "GOAL", goalCrossed: true },
      })
    );
    expect(conf?.lane).toBe("measured");
    expect(laneConfirmsGoal(conf?.lane)).toBe(true);
  });

  it("does not hide a pending row's own dive verdict", () => {
    const conf = confirmationForHighlightRow(
      row({
        id: "dive-1",
        start: 62,
        confirmAttestation: {
          goalConfirmed: "confirmed_goal",
          corroborated: true,
          corroborationSource: "frame_attestation",
          diveAt: "2026-11-11T13:00:30.000Z",
          diveLatencyMs: 1200,
          contextDegraded: [],
        },
      })
    );
    expect(conf?.lane).toBe("dive");
    expect(laneConfirmsGoal(conf?.lane)).toBe(true);
  });

  it("leaves a settled accepted row's legacy sentence untouched", () => {
    const conf = confirmationForHighlightRow(row({ id: "acc-1", start: 62, status: "accepted" }));
    expect(conf?.lane).toBe("unconfirmed");
    expect(conf?.label).toBe("Accepted — confirmation lane not recorded (legacy row)");
  });

  it("still serves no lane at all for a rejected row", () => {
    expect(confirmationForHighlightRow(row({ id: "rej-1", start: 62, status: "rejected" }))).toBeUndefined();
  });
});

describe("the banner counts the SAME population the cards serve (ADAAAA-8678)", () => {
  const postable = buildPostableHighlights(MEASURED);
  const ladder = buildSummaryLadder({
    summaryLog: LOG as any,
    highlights: postable.highlights,
    gameHint: "Soccer",
    fastRail: true,
    corroborated: cardConfirmsGoal,
  });

  it("goalCount equals the served GOAL cards (was 0 beside 2 cards)", () => {
    expect(ladder.matchSummary.goalCount).toBe(postable.highlights.length);
    expect(ladder.matchSummary.goalCount).toBe(2);
  });

  it("verifiedGoalCount equals the CONFIRMED cards (none here)", () => {
    expect(ladder.matchSummary.verifiedGoalCount).toBe(
      postable.highlights.filter((h) => cardConfirmsGoal(h)).length
    );
    expect(ladder.matchSummary.verifiedGoalCount).toBe(0);
  });

  it("names the counted goal rows as awaiting approval, never as `accepted`", () => {
    expect(ladder.matchSummary.text).toContain("2 goals (0 corroborated, 2 awaiting approval)");
    expect(ladder.matchSummary.text).not.toContain("accepted goals");
    expect(ladder.matchSummary.text).not.toContain("0 goals");
    expect(ladder.matchSummary.text).not.toContain("none accepted");
  });

  it("carries the same wording into the chapter digest (and the note stays a whole sentence)", () => {
    const withGoals = ladder.chapters.filter((c) => c.goalCount > 0);
    expect(withGoals.length).toBeGreaterThan(0);
    for (const c of withGoals) {
      expect(c.summary).toMatch(/\d+ goals? \(\d+ corroborated, \d+ awaiting approval\)\.$/);
      expect(c.summary).not.toContain("accepted goals");
    }
  });

  it("counts a pending row's own evidence (a corroborated dive is CONFIRMED and corroborated)", () => {
    const evidenced: HighlightRecord[] = MEASURED.map((h) =>
      h.id === "93ac1b1b"
        ? HighlightRecordSchema.parse({
            ...h,
            confirmAttestation: {
              goalConfirmed: "confirmed_goal",
              corroborated: true,
              corroborationSource: "frame_attestation",
              diveAt: "2026-11-11T13:00:30.000Z",
              diveLatencyMs: 1200,
              contextDegraded: [],
            },
          })
        : h
    );
    const out = buildPostableHighlights(evidenced);
    const l = buildSummaryLadder({
      summaryLog: LOG as any,
      highlights: out.highlights,
      gameHint: "Soccer",
      fastRail: true,
      corroborated: cardConfirmsGoal,
    });
    expect(l.matchSummary.goalCount).toBe(2);
    expect(l.matchSummary.verifiedGoalCount).toBe(1);
    expect(l.matchSummary.text).toContain("2 goals (1 corroborated, 2 awaiting approval)");
  });

  it("says the same thing when the job stores no window narratives", () => {
    const l = buildSummaryLadder({ highlights: postable.highlights, gameHint: "Soccer", fastRail: true, corroborated: cardConfirmsGoal });
    expect(l.matchSummary.goalCount).toBe(2);
    expect(l.matchSummary.text).toContain("2 goals (0 corroborated, 2 awaiting approval)");
  });

  it("leaves an all-ACCEPTED goal set byte-identical to the pre-8678 ladder", () => {
    const accepted = MEASURED.map((h) => ({ ...h, status: "accepted" as const }));
    const out = buildPostableHighlights(accepted);
    const l = buildSummaryLadder({
      summaryLog: LOG as any,
      highlights: out.highlights,
      gameHint: "Soccer",
      fastRail: true,
      corroborated: cardConfirmsGoal,
    });
    expect(l.matchSummary.goalCount).toBe(2);
    expect(l.matchSummary.text).toContain("2 accepted goals (0 corroborated)");
    expect(l.matchSummary.text).toContain("2 accepted highlights; no extra inference.");
    expect(l.matchSummary.text).not.toContain("awaiting approval");
  });

  it("does not count a pending non-GOAL scoring clip as a goal", () => {
    const kill = row({ id: "kill-1", start: 400, eventType: "KILL", outcome: "scoring_play" });
    const out = buildPostableHighlights([kill]);
    expect(out.highlights.map((h) => h.id)).toEqual(["kill-1"]);
    const l = buildSummaryLadder({ highlights: out.highlights, gameHint: "Esports", fastRail: true, corroborated: cardConfirmsGoal });
    expect(l.matchSummary.goalCount).toBe(0);
    expect(l.matchSummary.text).toContain("0 accepted goals (0 corroborated)");
  });
});
