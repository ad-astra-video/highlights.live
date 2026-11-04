// ADAAAA-8022: the residual §2 rows of job 34f9f2d1-dba7-4c39-97c1-eaec9e9066fc
// re-graded on the ladder itself (the ladder is derived at read time, so the same
// stored job re-grades the new code).
//
// Both stored `text` values are complete-LOOKING sentences whose PREDICATE the
// write gate deleted, so build `d6c9a9f` served them unchanged — 5 and 8 words, so
// the `words.length <= 2` fragment rule never fired, and `servedShape()` returned
// the candidate before the raw-sentence reduction path was reached:
//
//   seq 32  303  "A player in the midfield."              <- "... dribbles in the midfield."
//   seq 56  684  "A player for the ball in center circle." <- "... contests for the ball ..."
//
// seq 32 also feeds chapter 7's digest (goal-cluster lead = entry nearest the 301
// goal) and the `matchSummary` bullet, so the exact strings the ADAAAA-8015
// re-grade read on the page are asserted at both surfaces. On the unfixed build
// this fixture renders all four of those strings; the assertions below are the
// negative/positive pair.
//
// The fixture is the job's whole stored `summaryLog` (58 rows, verbatim) plus its
// nine accepted highlights (301/395/601 are its GOALs), so chapter boundaries and
// the "2 accepted goals (0 corroborated)" note are the ones the page carried.
import { describe, it, expect } from "vitest";
import { captionLead, servedShapeViolations } from "@highlights/events";
import { buildSummaryLadder } from "../src/summary-ladder";

type Row = { seq: number; windowTs: number; text: string; text_raw?: string; verdict?: string };

/** Verbatim `summaryLog` rows of job 34f9f2d1. */
const LOG: Row[] = [
  { seq: 1, windowTs: 0, verdict: "not_highlight", text: "Player in purple dribbles in the center circle", text_raw: "Player in purple jersey dribbles in the center circle" },
  { seq: 2, windowTs: 3, verdict: "not_highlight", text: "Player in purple jersey dribbles in the box.", text_raw: "Player in purple jersey dribbles in the penalty area." },
  { seq: 3, windowTs: 9, verdict: "not_highlight", text: "Player in purple jersey falls in the box.", text_raw: "Player in purple jersey falls in the penalty area." },
  { seq: 4, windowTs: 18, verdict: "not_highlight", text: "Player in white is tackled in the box.", text_raw: "Player in white is tackled in the penalty area." },
  { seq: 5, windowTs: 21, verdict: "not_highlight", text: "Player dribbles in the center of the field.", text_raw: "Player in white dribbles in the center of the field." },
  { seq: 6, windowTs: 63, verdict: "not_highlight", text: "Referee interacts with a child in center circle.", text_raw: "Referee interacts with a child in the center circle." },
  { seq: 7, windowTs: 75, verdict: "not_highlight", text: "A player moves toward the goal area.", text_raw: "A player in white moves toward the goal area." },
  { seq: 8, windowTs: 84, verdict: "not_highlight", text: "A player in a blue dribbles the ball.", text_raw: "A player in a blue jersey dribbles the ball in the center of the pitch." },
  { seq: 9, windowTs: 93, verdict: "not_highlight", text: "A player in a white dribbles the ball.", text_raw: "A player in a white jersey dribbles the ball in the center of the pitch." },
  { seq: 10, windowTs: 99, verdict: "not_highlight", text: "The player in white dribbles into the box.", text_raw: "The player in white dribbles into the penalty area." },
  { seq: 11, windowTs: 108, verdict: "big_play", text: "The striker shoots in midfield", text_raw: "Manuel Ordo\u00f1ez scores \u2014 Real Madrid celebrates the goal." },
  { seq: 12, windowTs: 111, verdict: "not_highlight", text: "The striker celebrates a shot on the left", text_raw: "Manuel Ordo\u00f1ez celebrates a goal \u2014 players in white jerseys cheer." },
  { seq: 13, windowTs: 117, verdict: "scoring_play", text: "The No. 9 in white shoots on the left", text_raw: "The No. 9 in white scores a goal \u2014 players celebrate." },
  { seq: 14, windowTs: 120, verdict: "not_highlight", text: "Manuel Ordo\u00f1ez celebrates a shot on the left", text_raw: "Manuel Ordo\u00f1ez celebrates a goal \u2014 players in white jerseys cheer." },
  { seq: 15, windowTs: 126, verdict: "not_highlight", text: "The players move into the penalty area." },
  { seq: 16, windowTs: 153, verdict: "not_highlight", text: "A player in a blue controls the ball.", text_raw: "A player in a blue jersey controls the ball in the center circle." },
  { seq: 17, windowTs: 159, verdict: "big_play", text: "The winger shoots wide in midfield", text_raw: "The winger shoots into the net \u2014 players celebrate" },
  { seq: 18, windowTs: 162, verdict: "scoring_play", text: "The striker shoots to level the game in midfield", text_raw: "David Saez scores to level the game 2-2 \u2014 players celebrate" },
  { seq: 19, windowTs: 177, verdict: "not_highlight", text: "The keeper makes a save in the box.", text_raw: "The keeper makes a save in the penalty area." },
  { seq: 20, windowTs: 180, verdict: "not_highlight", text: "The keeper makes a save.", text_raw: "The keeper makes a save in the goal area." },
  { seq: 21, windowTs: 186, verdict: "not_highlight", text: "A player takes a shot in midfield", text_raw: "A player takes a shot from the center of the field." },
  { seq: 22, windowTs: 195, verdict: "not_highlight", text: "A player moves toward the center in midfield", text_raw: "A player in white moves toward the center of the field." },
  { seq: 23, windowTs: 198, verdict: "not_highlight", text: "Players move in the midfield area." },
  { seq: 24, windowTs: 234, verdict: "not_highlight", text: "A player in a white strikes the ball.", text_raw: "A player in a white kit strikes the ball into the center of the field." },
  { seq: 25, windowTs: 240, verdict: "not_highlight", text: "A player in a white dribbles.", text_raw: "A player in a white kit dribbles and passes the ball in the center of the field." },
  { seq: 26, windowTs: 249, verdict: "not_highlight", text: "A player in a purple controls the ball.", text_raw: "A player in a purple kit controls the ball in the center." },
  { seq: 27, windowTs: 276, verdict: "not_highlight", text: "No. 3 player attempts a shot.", text_raw: "The No. 3 player in white attempts a shot from the penalty area." },
  { seq: 28, windowTs: 285, verdict: "big_play", text: "A player in a white kit shoots in midfield", text_raw: "A player in a white kit scores a goal \u2014 celebration erupts" },
  { seq: 29, windowTs: 288, verdict: "scoring_play", text: "A player in a white kit shoots on the left", text_raw: "A player in a white kit scores a goal \u2014 crowd erupts" },
  { seq: 30, windowTs: 294, verdict: "not_highlight", text: "A defender blocks a shot in the box.", text_raw: "A defender blocks a shot in the penalty area." },
  { seq: 31, windowTs: 297, verdict: "not_highlight", text: "A player in a white shoots in midfield", text_raw: "A player in a white kit scores a goal \u2014 crowd erupts" },
  { seq: 32, windowTs: 303, verdict: "not_highlight", text: "A player in the midfield.", text_raw: "A player in a purple kit dribbles in the midfield." },
  { seq: 33, windowTs: 312, verdict: "scoring_play", text: "The player in purple shoots wide on the left", text_raw: "The player in purple shoots into the net \u2014 Score changes to 3-2" },
  { seq: 34, windowTs: 318, verdict: "scoring_play", text: "The player in white shoots on the left \u2014 noise spikes over the play", text_raw: "The player in white scores a goal \u2014 crowd erupts" },
  { seq: 35, windowTs: 345, verdict: "not_highlight", text: "The player is tackled in the box.", text_raw: "The player in blue is tackled in the penalty area." },
  { seq: 36, windowTs: 348, verdict: "not_highlight", text: "The player in white shoots in midfield", text_raw: "The player in white scores a goal \u2014 crowd erupts" },
  { seq: 37, windowTs: 366, verdict: "not_highlight", text: "Referee and players stand in the center circle." },
  { seq: 38, windowTs: 390, verdict: "not_highlight", text: "Players contest for the ball in center circle.", text_raw: "Players contest for the ball in the center circle." },
  { seq: 39, windowTs: 393, verdict: "not_highlight", text: "No. 6 player controls the ball.", text_raw: "The No. 6 player controls the ball in the center circle." },
  { seq: 40, windowTs: 402, verdict: "big_play", text: "The No. 6 player controls the ball in the center circle.", text_raw: "The No. 6 player controls the ball in the center circle. \u2014 Real Madrid scores 2-1" },
  { seq: 41, windowTs: 408, verdict: "scoring_play", text: "Real Madrid shoots 2-1 near the touchline", text_raw: "Real Madrid scores 2-1 \u2014 players celebrate in the box" },
  { seq: 42, windowTs: 426, verdict: "not_highlight", text: "A player takes a shot from the box.", text_raw: "A player takes a shot from the penalty area." },
  { seq: 43, windowTs: 462, verdict: "scoring_play", text: "No. 6 player strikes the ball wide on the right", text_raw: "No. 6 player strikes the ball into the net \u2014 Score 2-2" },
  { seq: 44, windowTs: 471, verdict: "not_highlight", text: "No. 9 controls the ball in the box.", text_raw: "David Saez controls the ball in the penalty area." },
  { seq: 45, windowTs: 477, verdict: "scoring_play", text: "David Saez controls the ball in the penalty area.", text_raw: "David Saez controls the ball in the penalty area. \u2014 Players celebrate a goal." },
  { seq: 46, windowTs: 480, verdict: "scoring_play", text: "The winger shoots and shoots in midfield", text_raw: "The winger shoots and scores a goal \u2014 Players celebrate a goal." },
  { seq: 47, windowTs: 504, verdict: "not_highlight", text: "A player.", text_raw: "A player in a blue jersey moves toward the center circle." },
  { seq: 48, windowTs: 567, verdict: "not_highlight", text: "A player in a white maneuvers the ball.", text_raw: "A player in a white kit maneuvers the ball in the penalty area." },
  { seq: 49, windowTs: 585, verdict: "big_play", text: "A player in a white kit shoots the ball wide in midfield", text_raw: "A player in a white kit shoots the ball into the net \u2014 crowd erupts" },
  { seq: 50, windowTs: 588, verdict: "scoring_play", text: "The white kit player shoots in midfield", text_raw: "The white kit player scores a goal \u2014 crowd erupts" },
  { seq: 51, windowTs: 609, verdict: "scoring_play", text: "The player in blue shoots in midfield", text_raw: "The player in blue scores a goal \u2014 crowd erupts" },
  { seq: 52, windowTs: 618, verdict: "scoring_play", text: "The player in white shoots on the right \u2014 noise spikes over the play", text_raw: "The player in white scores a goal \u2014 crowd erupts" },
  { seq: 53, windowTs: 663, verdict: "not_highlight", text: "Referee speaks to players in the center circle" },
  { seq: 54, windowTs: 666, verdict: "not_highlight", text: "Referee and players walk on the pitch" },
  { seq: 55, windowTs: 672, verdict: "not_highlight", text: "Players stand on the pitch" },
  { seq: 56, windowTs: 684, verdict: "not_highlight", text: "A player for the ball in center circle.", text_raw: "A player in a blue kit contests for the ball in the center circle." },
  { seq: 57, windowTs: 708, verdict: "big_play", text: "The side No. 11 shoots in midfield", text_raw: "Real Madrid's No. 11 scores a goal \u2014 players celebrate in the box." },
  { seq: 58, windowTs: 729, verdict: "not_highlight", text: "The ball is in the center circle." },
];

/** The job's accepted highlights, verbatim (id/jobId shortened to `34f9f2d1`). */
export const GOALS = [
  {"id": "25929400-9bed-42c9-97bb-f4399d0f56df", "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc", "start": 101.7999999999981, "eventType": "BIG_PLAY", "status": "accepted"},
  {"id": "86d3b413-e558-4705-a4a1-d42de9e8b8dd", "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc", "start": 152, "eventType": "BIG_PLAY", "status": "accepted"},
  {"id": "6db8f964-8e0b-4173-8694-ec20b3d69af6", "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc", "start": 278, "eventType": "BIG_PLAY", "status": "accepted"},
  {"id": "24177d4e-df64-4c20-a3da-68451d695c00", "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc", "start": 301, "eventType": "GOAL", "status": "accepted"},
  {"id": "3bf5f473-bf99-412d-a886-13996e5395b9", "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc", "start": 395, "eventType": "GOAL", "status": "accepted"},
  {"id": "dd802ee6-85ac-4052-a2f7-54850d4d8dc5", "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc", "start": 452, "eventType": "BIG_PLAY", "status": "accepted"},
  {"id": "0ffd56d3-b0af-4d27-9beb-cdcc7db5f901", "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc", "start": 578, "eventType": "BIG_PLAY", "status": "accepted"},
  {"id": "1fb8388b-48c0-4008-8a79-1c7d302150aa", "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc", "start": 601, "eventType": "GOAL", "status": "accepted"},
  {"id": "e632fa24-c881-4128-b953-b4e6cef4e7fc", "jobId": "34f9f2d1-dba7-4c39-97c1-eaec9e9066fc", "start": 701.8000000000926, "eventType": "BIG_PLAY", "status": "accepted"},
];

const build = () =>
  buildSummaryLadder({
    summaryLog: LOG as any,
    highlights: GOALS as any,
    gameHint: "Kids soccer",
    fastRail: true,
  });

const ladder = build();
const rows = ladder.chapters.flatMap((c) => c.entries);
const textOf = (seq: number) => rows.find((r) => r.seq === seq)?.text;

describe("job 34f9f2d1 re-grades without the two §2 rows (ADAAAA-8022)", () => {
  it("seq 32 restores the predicate `dribbles` instead of serving five verbless words", () => {
    expect(textOf(32)).toBe("A player dribbles in the midfield.");
    expect(textOf(32)).not.toBe("A player in the midfield.");
  });

  it("seq 56 restores the verb `contests` and keeps its object `for the ball`", () => {
    // The ticket wrote this form as "8 words"; it is 9 tokens, so the quiet row
    // would breach the 8-word budget. `center circle -> center` is the existing
    // compressed-place family, and it lands the repaired row on 8 words.
    expect(textOf(56)).toBe("A player contests for the ball in center.");
    expect(textOf(56)).not.toBe("A player for the ball in center circle.");
    expect(textOf(56)).toContain("for the ball");
  });

  it("keeps both repaired rows inside the quiet 8-word budget", () => {
    for (const seq of [32, 56]) {
      expect(textOf(seq)!.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(8);
    }
  });

  it("chapter 7's digest opens on the repaired sentence, not the verbless one", () => {
    const chapter = ladder.chapters[7];
    expect(chapter.seqFrom).toBe(31);
    expect(chapter.seqTo).toBe(41);
    expect(chapter.summary).toBe("A player dribbles in the midfield. 2 accepted goals (0 corroborated).");
    expect(chapter.summary.startsWith("A player in the midfield.")).toBe(false);
  });

  it("the matchSummary rollup bullet carries the same repaired sentence", () => {
    const bullet = ladder.matchSummary.text
      .split("\n")
      .filter((l) => l.startsWith("- ") && l.includes("2 accepted goals"));
    expect(bullet).toEqual(["- Phase · 4:57–6:51: A player dribbles in the midfield. 2 accepted goals (0 corroborated)."]);
  });

  it("passes the served post-condition on every rendered row", () => {
    for (const row of rows) {
      const source = LOG.find((r) => r.seq === row.seq)!;
      const sources = [captionLead(source.text), captionLead(source.text_raw ?? "")].filter(Boolean);
      expect(servedShapeViolations(row.text, sources)).toEqual([]);
    }
  });

  it("loses no row to the verbless rule (seq 20 is the pre-existing duplicate collapse)", () => {
    // seq 19 already serves "The keeper makes a save in the box." and seq 20's raw
    // sentence repairs to the same line, so the display cap collapses it — the same
    // drop the unfixed build makes (ADAAAA-8014 AC1/AC2), not a new loss.
    const have = new Set(rows.map((r) => r.seq));
    expect(LOG.filter((r) => !have.has(r.seq)).map((r) => r.seq)).toEqual([20]);
    expect(textOf(19)).toBe("The keeper makes a save in the box.");
  });

  it("is deterministic across reads", () => {
    const again = build();
    expect(again.chapters).toEqual(ladder.chapters);
    expect(again.matchSummary).toEqual(ladder.matchSummary);
  });
});
