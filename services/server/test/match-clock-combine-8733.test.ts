// ADAAAA-8733 (GT-2): parse the scorebug MATCH CLOCK and combine clips on it.
//
// Measured defect this pins: live job `9a6b1d8f` shipped ONE `1-1 -> 2-1` goal
// THREE times — 0 s, 37 s and 82 s apart — because every existing combine lane
// (footage overlap, the 30 s burst window, the 60 s duplicate reach, the 120 s
// same-transition horizon) is a guess about the STREAM. The clock on the
// scorebug is the only on-screen signal that says "same game moment" without a
// score transition to parse.
//
// Tolerances are GT-1's census measurements (ADAAAA-8732): the largest |Δclock|
// between two re-reads of the SAME event was 7 s => CLOCK_SAME_MOMENT_S = 10; the
// smallest |Δclock| between genuinely distinct goals on one coherent segment was
// 309 s => CLOCK_DISTINCT_S = 30 is a safe floor (3 ca the same-moment spread).
import { describe, expect, it } from "vitest";
import { HighlightRecordSchema, MatchClockReadingSchema, type HighlightRecord } from "@highlights/events";
import {
  parseOcrMatchClock,
  parseOcrMatchClockLine,
  parseOcrMatchClockPeriod,
  matchClockFromTimeline,
} from "../src/analyzer";
import {
  CLOCK_COHERENCE_TOLERANCE_S,
  CLOCK_DISTINCT_S,
  CLOCK_SAME_MOMENT_S,
  buildPostableHighlights,
  clockCombineForJob,
  clockLaneEnabledForJob,
  clockPairRelation,
  sharesTransition,
  transitionIdentity,
} from "../src/highlight-postable";

const JOB = "9a6b1d8f-0000-4000-8000-000000000000";

/** One persisted accepted GOAL row; `end = start + 15` unless overridden. */
function goal(
  over: Partial<HighlightRecord> & { id: string; start: number }
): HighlightRecord {
  const start = over.start;
  return HighlightRecordSchema.parse({
    jobId: JOB,
    clipUri: `/clips/${over.id}.mp4`,
    end: start + 15,
    status: "accepted",
    outcome: "scoring_play",
    eventType: "GOAL",
    score: 100,
    createdAt: "2026-11-12T00:00:00.000Z",
    ...over,
  });
}

/** The clock reading a row carries, as the accept path persists it. */
function clock(seconds: number, ts: number, period: string | null = null, shape: "mm:ss" | "hh:mm:ss" | "dot" | "bare_minute" = "mm:ss") {
  return MatchClockReadingSchema.parse({ seconds, ts, period, shape, legible: true, token: "25:20" });
}

// ---------------------------------------------------------------------------
// 1. Parser — the measured strings of the GT-1 census
// ---------------------------------------------------------------------------
// These strings are copied from the census (`decide_audit.prompt_text`), not
// invented: they are what the scorebug crop actually returned.
describe("parseOcrMatchClockLine (ADAAAA-8733 clock shapes)", () => {
  it("reads the mm:ss clock glued to the LaLiga bug", () => {
    expect(parseOcrMatchClockLine("LALIGA00:56")).toMatchObject({ seconds: 56, shape: "mm:ss", legible: true });
    expect(parseOcrMatchClockLine("LALIGA25:27 ATM")).toMatchObject({ seconds: 1527, shape: "mm:ss" });
  });

  it("reads a clock glued to the score pair, and leaves the score to the score parser", () => {
    expect(parseOcrMatchClockLine("RMA 1/2 FCB36:54")).toMatchObject({ seconds: 2214, shape: "mm:ss", token: "36:54" });
    expect(parseOcrMatchClockLine("RMA 1.0 FCB 17:22HOTELSK")).toMatchObject({ seconds: 1042 });
  });

  it("accepts minutes above 59 (the FOX Euro multi-match bug)", () => {
    expect(parseOcrMatchClockLine("GER 4 1 SCO86:35FOXEURO2")).toMatchObject({ seconds: 86 * 60 + 35 });
    expect(parseOcrMatchClockLine("POL 1 2NED82:45EURO2024G")).toMatchObject({ seconds: 82 * 60 + 45 });
  });

  it("accepts the dot form — the colon lost to the crop (392 of 444 windows on one fixture)", () => {
    expect(parseOcrMatchClockLine("ENG82.29")).toMatchObject({ seconds: 82 * 60 + 29, shape: "dot" });
    expect(parseOcrMatchClockLine("HUN99.34")).toMatchObject({ seconds: 99 * 60 + 34, shape: "dot" });
  });

  it("reads hh:mm:ss and the bare-minute apostrophe form", () => {
    expect(parseOcrMatchClockLine("Q3 1:05:30 LAL")).toMatchObject({ seconds: 3930, shape: "hh:mm:ss", period: "Q3" });
    expect(parseOcrMatchClockLine("RMA 27' FCB")).toMatchObject({ seconds: 1620, shape: "bare_minute" });
    expect(parseOcrMatchClockLine("RMA 45+2' FCB")).toMatchObject({ seconds: 2820, shape: "bare_minute" });
  });

  it("refuses the media timecode trap (`0:03:04:800` player scrub overlay)", () => {
    // The census's e5538461 trap: 100 % mm:ss windows that are a progress bar.
    expect(parseOcrMatchClockLine("0:03:04:800 3696")).toBeNull();
    // ... and a dot-glued SCORE pair is not a clock (the score parser owns it)
    expect(parseOcrMatchClockLine("BAR0LALIGA 022 ALAMERCUR")).toBeNull();
    expect(parseOcrMatchClockLine("")).toBeNull();
    expect(parseOcrMatchClockLine(undefined)).toBeNull();
  });

  it("never turns a colon-form score pair (`2:1`) into a clock", () => {
    expect(parseOcrMatchClockLine("RMA2:1 BAR")).toBeNull();
  });

  it("normalizes the period markers the measured bugs show", () => {
    expect(parseOcrMatchClockPeriod("RMA 1/2 FCB36:54 1H")).toBe("1H");
    expect(parseOcrMatchClockPeriod("2H 36:54")).toBe("2H");
    expect(parseOcrMatchClockPeriod("Q3 01:20")).toBe("Q3");
    expect(parseOcrMatchClockPeriod("1.Ç 05:12")).toBe("Q1");
    expect(parseOcrMatchClockPeriod("HT 0-0")).toBe("HT");
    expect(parseOcrMatchClockPeriod("LALIGA36:54")).toBeNull();
  });

  it("returns the first legible clock among a window's OCR lines", () => {
    expect(parseOcrMatchClock(["LALIGA", "LALIGA27:00 KM"])).toMatchObject({ seconds: 1620 });
    expect(parseOcrMatchClock(["LALIGA", "STANLEY"])).toBeNull();
    expect(parseOcrMatchClock(undefined)).toBeNull();
  });
});

describe("matchClockFromTimeline (ADAAAA-8733 anchor-tight read)", () => {
  const observations = [
    { ts: 90.0, ocr: ["LALIGA25:15 ATM"] },
    { ts: 100.0, ocr: ["LALIGA25:20 ATM"] },
    { ts: 140.0, ocr: ["LALIGA25:59 ATM"] },
  ];

  it("reads the clock AT the goal instant, not at the window centre", () => {
    // The point of the anchor rule: a re-read window's centre shows a LATER
    // clock, which would make one goal's duplicate look 40 s newer than it is.
    expect(matchClockFromTimeline(observations, { anchorTs: 100 })).toMatchObject({ seconds: 1520, ts: 100 });
    expect(matchClockFromTimeline(observations, { anchorTs: 140 })).toMatchObject({ seconds: 1559, ts: 140 });
  });

  it("carries NO clock when no reading sits on the instant (fail closed)", () => {
    expect(matchClockFromTimeline(observations, { anchorTs: 120 })).toBeUndefined();
    expect(matchClockFromTimeline([], { anchorTs: 100 })).toBeUndefined();
  });

  it("proves the value came from the text already returned — an OCR-free parse (AC-GT6)", () => {
    const reading = matchClockFromTimeline(observations, { anchorTs: 100 })!;
    expect(observations[1].ocr[0]).toContain(reading.token!);
  });
});

// ---------------------------------------------------------------------------
// 2. Pairwise relation — R1 / R2 / R4
// ---------------------------------------------------------------------------
describe("clockPairRelation (ADAAAA-8733 R1/R2/R4)", () => {
  it("R1: agreeing clocks on one coherent segment are the SAME moment", () => {
    expect(clockPairRelation(goal({ id: "a", start: 93, matchClock: clock(1520, 100) }), goal({ id: "b", start: 175, matchClock: clock(1527, 104) }))).toBe(
      "same_moment"
    );
    // ... even when the windows do not overlap at all (that is the whole point).
    expect(clockPairRelation(goal({ id: "a", start: 93, matchClock: clock(1520, 100) }), goal({ id: "b", start: 400, matchClock: clock(1520, 100) }))).toBe(
      "same_moment"
    );
  });

  it("R2: clocks >= CLOCK_DISTINCT_S apart are DISTINCT events", () => {
    const a = goal({ id: "a", start: 193, matchClock: clock(1520, 200) });
    const b = goal({ id: "b", start: 253, matchClock: clock(1520 + CLOCK_DISTINCT_S, 200 + CLOCK_DISTINCT_S) });
    expect(clockPairRelation(a, b)).toBe("distinct");
  });

  it("R4: a REWOUND read is a replay inset, never a same-moment proof", () => {
    // 25:20 -> 24:05 while content advances 45 s: the bug rewound, i.e. the
    // window is showing a replay inset, not the same game moment.
    expect(clockPairRelation(goal({ id: "a", start: 93, matchClock: clock(1520, 100) }), goal({ id: "b", start: 138, matchClock: clock(1445, 145) }))).toBe(
      "rewound"
    );
  });

  it("R4: a clock that does not track content time is a cut (jumping), not a merge", () => {
    // The census's measured bumper/cut-away: +124 s of clock in 3 s of content.
    expect(clockPairRelation(goal({ id: "a", start: 10, matchClock: clock(356, 10) }), goal({ id: "b", start: 13, matchClock: clock(480, 13) }))).toBe(
      "jumping"
    );
  });

  it("never merges across periods, and a null clock is a no-op", () => {
    expect(
      clockPairRelation(goal({ id: "a", start: 93, matchClock: clock(1520, 100, "1H") }), goal({ id: "b", start: 175, matchClock: clock(1520, 100, "2H") }))
    ).toBe("distinct");
    expect(clockPairRelation(goal({ id: "a", start: 93, matchClock: clock(1520, 100, "1H") }), goal({ id: "b", start: 175, matchClock: clock(1520, 100, "1H") }))).toBe(
      "same_moment"
    );
    expect(clockPairRelation(goal({ id: "a", start: 93 }), goal({ id: "b", start: 175, matchClock: clock(1520, 100) }))).toBe("unknown");
    expect(
      clockPairRelation(
        goal({ id: "a", start: 93, matchClock: MatchClockReadingSchema.parse({ seconds: null, shape: null, period: null, legible: false }) }),
        goal({ id: "b", start: 175, matchClock: clock(1520, 100) })
      )
    ).toBe("unknown");
  });

  it("stays inside the two measured tolerances (10 s / 30 s) and is a no-op between them", () => {
    const a = goal({ id: "a", start: 100, matchClock: clock(1520, 100) });
    expect(clockPairRelation(a, goal({ id: "b", start: 110, matchClock: clock(1520 + CLOCK_SAME_MOMENT_S, 110) }))).toBe("same_moment");
    expect(clockPairRelation(a, goal({ id: "b", start: 120, matchClock: clock(1520 + 20, 120) }))).toBe("inconclusive");
    expect(CLOCK_COHERENCE_TOLERANCE_S).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2b. transitionIdentity (ADAAAA-8754 R7) — the score's own event identity
// ---------------------------------------------------------------------------
describe("transitionIdentity (ADAAAA-8754 R7)", () => {
  it("reads the disclosed transitionScore pair first", () => {
    const row = goal({
      id: "a",
      start: 0,
      attestationUsed: {
        scoreBoardChanged: true,
        goalCrossed: false,
        ballOutcome: null,
        corroborated: false,
        goalConfirmed: null,
        transitionKey: "9-9>9-9",
        transitionScore: { pre: [1, 1], post: [2, 1] },
      },
    });
    expect(transitionIdentity(row)).toBe("1-1>2-1");
  });

  it("reads the transitionKey string in either separator form", () => {
    const key = (transitionKey: string) =>
      goal({
        id: "a",
        start: 0,
        attestationUsed: {
          scoreBoardChanged: true,
          goalCrossed: false,
          ballOutcome: null,
          corroborated: false,
          goalConfirmed: null,
          transitionKey,
        },
      });
    expect(transitionIdentity(key("1-1>2-1"))).toBe("1-1>2-1");
    expect(transitionIdentity(key("1-1 -> 2-1"))).toBe("1-1>2-1");
  });

  it("falls back to the verdict sentence on rows written before ADAAAA-8663", () => {
    expect(transitionIdentity(goal({ id: "a", start: 0, reason: "Scoreboard changes from 1-1 to 2-1 at t=-5.1s." }))).toBe(
      "1-1>2-1"
    );
  });

  it("is null when the row names no score pair (every rule stays as it was)", () => {
    expect(transitionIdentity(goal({ id: "a", start: 0 }))).toBeNull();
    expect(transitionIdentity(goal({ id: "b", start: 0, reason: "players celebrate, no score graphic" }))).toBeNull();
  });

  it("ties only rows that name the SAME pair", () => {
    const goalA = goal({ id: "a", start: 0, reason: "Scoreboard changes from 1-1 to 2-1." });
    const goalA2 = goal({ id: "b", start: 90, reason: "Scoreboard changes from 1-1 to 2-1." });
    const goalB = goal({ id: "c", start: 180, reason: "Scoreboard changes from 2-1 to 3-1." });
    expect(sharesTransition(goalA, goalA2)).toBe(true);
    expect(sharesTransition(goalA, goalB)).toBe(false);
    // A row without evidence never shares a transition with one that has it.
    expect(sharesTransition(goalA, goal({ id: "d", start: 270 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. AC-GT2 (ADAAAA-8754) — the 9a6b1d8f shape, clock read at each row's ANCHOR
// ---------------------------------------------------------------------------
// Production-faithful: `matchClockFromTimeline` stores `ts` = the OCR frame
// nearest THAT window's own anchor, so the three deliveries of one goal carry
// ts 2.603 / 38.730 / 84.941 — never one shared content instant. The old fixture
// (one shared `ts: 100`) reached 1 moment on HEAD for the wrong reason: it handed
// the lane three reads at the same content instant, which production cannot
// write. With per-row ts every clock value that merges these rows is a value the
// score already proves: all three name the same `1-1 -> 2-1` transition.
const STORED_9A6B1D8F = [
  {
    id: "e17aecb0",
    start: 0,
    end: 15,
    localizedTs: 2.6029999256134033,
    score: 95,
    reason: "Scoreboard changes from 1-1 to 2-1 at t=-5.1s and players celebrate.",
    attestationUsed: {
      scoreBoardChanged: true,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
      scoreReads: 30,
      preSamples: 15,
      postSamples: 15,
      need: 2,
    },
  },
  {
    id: "7f1091c8",
    start: 31.730000019073486,
    end: 46.730000019073486,
    localizedTs: 38.730000019073486,
    score: 85,
    reason: "Scoreboard changes from 1-1 to 2-1 at t=-3.5s, confirmed by player celebration.",
    attestationUsed: {
      scoreBoardChanged: true,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
      scoreReads: 45,
      preSamples: 34,
      postSamples: 11,
      need: 2,
    },
  },
  {
    id: "081785e2",
    start: 77.94099998474121,
    end: 92.94099998474121,
    localizedTs: 84.94099998474121,
    score: 85,
    reason: "Scoreboard changes from 1-1 to 2-1 at t=-3.3s, confirmed by player celebration.",
    attestationUsed: {
      scoreBoardChanged: true,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
      scoreReads: 44,
      preSamples: 34,
      postSamples: 10,
      need: 2,
    },
  },
].map((r) => goal({ ...r, jobId: JOB }));

describe("AC-GT2 (ADAAAA-8754): one goal re-delivered three times, per-row clock ts", () => {
  const anchorTs = (r: HighlightRecord) => r.localizedTs as number;

  /** The three deliveries with the clock read at their own anchors. */
  const withClocks = (seconds: (i: number) => number) =>
    STORED_9A6B1D8F.map((r, i) => ({ ...r, matchClock: clock(seconds(i), anchorTs(r)) }));

  const assertOneMoment = (rows: HighlightRecord[]) => {
    const out = buildPostableHighlights(rows);
    expect(out.highlights).toHaveLength(1);
    const moment = out.highlights[0];
    expect(moment.id).toBe("e17aecb0");
    expect(moment.duplicateCount).toBe(2);
    expect([...(moment.mergedIds ?? [])].sort()).toEqual(["081785e2", "7f1091c8"]);
    expect(out.duplicates.map((d) => d.id).sort()).toEqual(["081785e2", "7f1091c8"]);
    expect(out.duplicates.every((d) => d.duplicateOf === "e17aecb0")).toBe(true);
    expect(out.counts).toMatchObject({ total: 3, postable: 1, merged: 2, rejected: 0, notScoring: 0, contradicting: 0 });
    expect(out.counts.total - out.counts.postable).toBe(
      out.counts.merged + out.counts.rejected + out.counts.notScoring + out.counts.contradicting
    );
    // R3/R6: the surviving row is the SAME delivered row — untouched footage.
    expect(moment.outcome).toBe("scoring_play");
    expect(moment.start).toBe(0);
    expect(moment.end).toBe(15);
    expect(moment.clipUri).toBe("/clips/e17aecb0.mp4");
    expect(out.notable).toHaveLength(0);
    expect(out.counts.notScoring).toBe(0);
    return out;
  };

  it("held clock (1520 re-shown at every anchor) delivers ONE moment", () => {
    // The measured production read: the frozen-bug gate must not disable a lane
    // whose frozen pair the score ties to one transition.
    const rows = withClocks(() => 1520);
    expect(clockLaneEnabledForJob(rows)).toBe(true);
    assertOneMoment(rows);
  });

  it("advancing clock (1520 / 1556 / 1602) delivers ONE moment", () => {
    // The same running bug sampled at each later anchor: Δclock = Δcontent, so
    // R2 must not call these distinct.
    assertOneMoment(withClocks((i) => 1520 + [0, 36, 82][i]));
  });

  it("a re-read within CLOCK_SAME_MOMENT_S of the first delivers ONE moment", () => {
    assertOneMoment(withClocks((i) => 1520 + [0, 4, 7][i]));
  });

  it("the relation names the class: same_event, not distinct/jumping", () => {
    const held = withClocks(() => 1520);
    const advancing = withClocks((i) => 1520 + [0, 36, 82][i]);
    expect(clockPairRelation(held[0], held[1])).toBe("same_event");
    expect(clockPairRelation(advancing[0], advancing[1])).toBe("same_event");
    expect(clockPairRelation(held[0], held[2])).toBe("same_event");
    expect(sharesTransition(held[0], held[2])).toBe(true);
    expect(transitionIdentity(held[0])).toBe("1-1>2-1");
  });

  it("post-8663 rows (disclosed transitionKey) with an advancing clock deliver ONE moment", () => {
    const keyed = withClocks((i) => 1520 + [0, 36, 82][i]).map((r) => ({
      ...r,
      attestationUsed: { ...r.attestationUsed!, transitionKey: "1-1>2-1" },
    }));
    assertOneMoment(keyed);
  });

  it("post-8663 rows (disclosed transitionScore) deliver ONE moment", () => {
    const scored = withClocks((i) => 1520 + [0, 36, 82][i]).map((r) => ({
      ...r,
      attestationUsed: {
        ...r.attestationUsed!,
        transitionKey: "1-1>2-1",
        transitionScore: { pre: [1, 1] as [number, number], post: [2, 1] as [number, number] },
      },
    }));
    assertOneMoment(scored);
  });

  it("DIFFERENT score transitions with the same held clock stay TWO moments", () => {
    // The score, not the clock, keeps genuinely different goals apart: a frozen
    // value can never merge rows that name different transitions (R5 + R2).
    const rows = withClocks(() => 1520).map((r, i) => ({
      ...r,
      attestationUsed: { ...r.attestationUsed!, transitionKey: i === 2 ? "2-1>3-1" : "1-1>2-1" },
    }));
    const out = buildPostableHighlights(rows);
    // `e17aecb0` + `7f1091c8` share `1-1>2-1`; `081785e2` is the next goal.
    expect(out.highlights.map((h) => h.id)).toEqual(["e17aecb0", "081785e2"]);
    expect(out.duplicates.map((d) => d.id)).toEqual(["7f1091c8"]);
    expect(out.counts).toMatchObject({ postable: 2, merged: 1 });
  });

  it("a REWOUND re-read is a replay inset, not a duplicate", () => {
    const rows = STORED_9A6B1D8F.map((r, i) => ({
      ...r,
      matchClock: clock(i === 2 ? 1440 : 1520, anchorTs(r)),
    }));
    expect(clockPairRelation(rows[0], rows[2])).toBe("rewound");
    const out = buildPostableHighlights(rows);
    expect(out.highlights.map((h) => h.id)).toEqual(["e17aecb0", "081785e2"]);
    expect(out.counts.merged).toBe(1);
  });

  it("CROSS-MATCH: one multi-match bug showing three matches' clocks never merges", () => {
    // The GT-1 mandatory case: a FOX-Euro-shaped job carries several matches at
    // once (86:35 / 82:45 / 95:55) and every match's transition text can read
    // the same `1-1 -> 2-1`. A clock that jumps or rewinds between content
    // neighbours is a match cut, so the identity tie cannot merge across it.
    const rows = [
      goal({ id: "m1", start: 0, end: 15, localizedTs: 7, matchClock: clock(86 * 60 + 35, 7), reason: "Scoreboard changes from 1-1 to 2-1." }),
      goal({ id: "m2", start: 40, end: 55, localizedTs: 47, matchClock: clock(82 * 60 + 45, 47), reason: "Scoreboard changes from 1-1 to 2-1." }),
      goal({ id: "m3", start: 80, end: 95, localizedTs: 87, matchClock: clock(95 * 60 + 55, 87), reason: "Scoreboard changes from 1-1 to 2-1." }),
    ];
    expect(sharesTransition(rows[0], rows[1])).toBe(true);
    expect(clockPairRelation(rows[0], rows[1])).toBe("rewound");
    expect(clockPairRelation(rows[0], rows[2])).toBe("jumping");
    const out = buildPostableHighlights(rows);
    expect(out.highlights.map((h) => h.id)).toEqual(["m1", "m2", "m3"]);
    expect(out.duplicates).toHaveLength(0);
    expect(out.counts).toMatchObject({ postable: 3, merged: 0 });
  });

  it("is a no-op without the clock (master behaviour for legacy rows)", () => {
    const noClock = STORED_9A6B1D8F.map((r) => ({ ...r, matchClock: undefined }));
    const out = buildPostableHighlights(noClock);
    expect(out.highlights).toHaveLength(3);
    expect(out.duplicates).toHaveLength(0);
    expect(out.counts).toMatchObject({ postable: 3, merged: 0 });
  });

  it("a clockless earlier row cannot break the merge loop (mixed-order job)", () => {
    // The clockless row sorts first, so it owns an open cluster when the clocked
    // rows are visited — the join test must skip it instead of reading a missing
    // clock.
    const rows = [
      goal({ id: "hl-early", start: 10, end: 25 }),
      goal({ id: "hl-a", start: 400, end: 415, matchClock: clock(2000, 407), reason: "Scoreboard changes from 1-1 to 2-1." }),
      goal({ id: "hl-b", start: 480, end: 495, matchClock: clock(2080, 487), reason: "Scoreboard changes from 1-1 to 2-1." }),
    ];
    const out = buildPostableHighlights(rows);
    expect(out.highlights.map((h) => h.id)).toEqual(["hl-early", "hl-a"]);
    expect(out.duplicates.map((d) => d.id)).toEqual(["hl-b"]);
  });
});

// ---------------------------------------------------------------------------
// 4. AC-GT3 — two genuine goals whose clocks are >= CLOCK_DISTINCT_S apart
// ---------------------------------------------------------------------------
describe("AC-GT3: clock-distinct goals are never absorbed or downgraded", () => {
  const rows = [
    goal({ id: "hl-a", start: 193, end: 208, score: 96, corroborated: true, matchClock: clock(1520, 200) }),
    goal({ id: "hl-b", start: 253, end: 268, score: 96, corroborated: true, matchClock: clock(1580, 260) }),
  ];

  it("delivers 2 moments, 0 absorbed, 0 downgraded", () => {
    const out = buildPostableHighlights(rows);
    expect(out.highlights.map((h) => h.id)).toEqual(["hl-a", "hl-b"]);
    expect(out.duplicates).toHaveLength(0);
    expect(out.counts).toMatchObject({ postable: 2, merged: 0, notScoring: 0, contradicting: 0 });
    expect(out.highlights.every((h) => h.outcome === "scoring_play")).toBe(true);
    expect(out.highlights.every((h) => h.duplicateCount === undefined)).toBe(true);
  });

  it("also holds inside the 60 s duplicate reach / 120 s horizon spacing", () => {
    // 40 s apart in content, 40 s apart on the clock: the READ-side lanes must
    // not combine them either (R2), which is the case the stream-time guesses
    // get wrong.
    const close = [
      goal({ id: "hl-a", start: 200, end: 215, matchClock: clock(1500, 202) }),
      goal({ id: "hl-b", start: 240, end: 255, matchClock: clock(1540, 242) }),
    ];
    const out = buildPostableHighlights(close);
    expect(out.highlights).toHaveLength(2);
    expect(out.duplicates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. AC-GT4 — attestation unchanged when the clock is legible but the score is not
// ---------------------------------------------------------------------------
describe("AC-GT4: a clock read produces no new GOAL and no new demotion", () => {
  // The ATTEST-shaped leg: the score pair is unreadable (no measured transition)
  // while the clock is legible. Two goals whose clocks prove them distinct.
  const attestation = {
    scoreBoardChanged: false,
    goalCrossed: true,
    ballOutcome: "goal",
    corroborated: true,
    goalConfirmed: "confirmed_goal",
    scoreReads: 0,
  } as const;
  const base = [
    goal({ id: "hl-a", start: 300, end: 315, attestationUsed: { ...attestation } }),
    goal({ id: "hl-b", start: 400, end: 415, attestationUsed: { ...attestation } }),
  ];

  it("keeps the accepted GOAL count and every attestation field identical to master", () => {
    const withClock = base.map((r, i) => ({ ...r, matchClock: clock(2000 + i * 60, r.start + 7) }));
    const master = buildPostableHighlights(base);
    const clocked = buildPostableHighlights(withClock);
    expect(clocked.highlights.length).toBe(master.highlights.length);
    expect(clocked.highlights.map((h) => h.id)).toEqual(master.highlights.map((h) => h.id));
    expect(clocked.highlights.map((h) => h.outcome)).toEqual(master.highlights.map((h) => h.outcome));
    expect(clocked.highlights.map((h) => h.attestationUsed)).toEqual(master.highlights.map((h) => h.attestationUsed));
    expect(clocked.counts).toEqual(master.counts);
    expect(clocked.duplicates).toEqual(master.duplicates);
    expect(clocked.notable.map((h) => h.id)).toEqual(master.notable.map((h) => h.id));
  });

  it("a clock that AGREES on two score-distinct rows still only moves rows to the duplicate lane", () => {
    // R1 explicitly merges even when the transition keys disagree; R3's contract
    // is that the clock never attests/demotes, so `outcome` stays `scoring_play`
    // and no row leaves the GOAL lane for the notable one.
    const rows = [
      goal({ id: "hl-a", start: 300, end: 315, attestationUsed: { ...attestation, transitionKey: null } }),
      goal({ id: "hl-b", start: 400, end: 415, attestationUsed: { ...attestation, transitionKey: null } }),
    ].map((r) => ({ ...r, matchClock: clock(2000, 305) }));
    const out = buildPostableHighlights(rows);
    expect(out.highlights).toHaveLength(1);
    expect(out.highlights[0].outcome).toBe("scoring_play");
    expect(out.counts.notScoring).toBe(0);
    expect(out.counts.contradicting).toBe(0);
    expect(out.duplicates.every((d) => d.outcome === "scoring_play")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. AC-GT5 — a static/frozen bug is a byte-identical no-op
// ---------------------------------------------------------------------------
describe("AC-GT5: a frozen clock can never merge genuinely distinct goals", () => {
  // A static/placeholder bug: the clock sits at 0:00 while content advances.
  const rows = [
    goal({ id: "hl-a", start: 100, end: 115, localizedTs: 107 }),
    goal({ id: "hl-b", start: 200, end: 215, localizedTs: 207 }),
    goal({ id: "hl-c", start: 300, end: 315, localizedTs: 307 }),
  ];
  const frozen = rows.map((r) => ({
    ...r,
    matchClock: MatchClockReadingSchema.parse({ seconds: 0, shape: "mm:ss", period: null, legible: true, ts: r.localizedTs }),
  }));

  it("disables the clock lane for the whole job", () => {
    expect(clockLaneEnabledForJob(frozen)).toBe(false);
    expect(clockCombineForJob([], frozen)).toEqual({ moments: [], duplicates: [], merged: 0 });
  });

  it("delivers a byte-identical projection to master", () => {
    const master = buildPostableHighlights(rows);
    const staticBug = buildPostableHighlights(frozen);
    const strip = (out: ReturnType<typeof buildPostableHighlights>) =>
      JSON.parse(
        JSON.stringify({
          ...out,
          highlights: out.highlights.map(({ matchClock: _mc, ...rest }) => rest),
          duplicates: out.duplicates.map(({ matchClock: _mc, ...rest }) => rest),
          notable: out.notable.map(({ matchClock: _mc, ...rest }) => rest),
        })
      );
    expect(strip(staticBug)).toEqual(strip(master));
    expect(staticBug.counts).toEqual(master.counts);
    expect(staticBug.highlights.map((h) => h.mergedIds)).toEqual(master.highlights.map((h) => h.mergedIds));
    expect(staticBug.highlights.map((h) => h.duplicateCount)).toEqual(master.highlights.map((h) => h.duplicateCount));
  });

  it("keeps the lane live for a bug whose clock does advance", () => {
    expect(clockLaneEnabledForJob(frozen.slice(0, 1))).toBe(false); // one read: nothing to combine
    expect(
      clockLaneEnabledForJob([
        goal({ id: "x", start: 100, matchClock: clock(1000, 107) }),
        goal({ id: "y", start: 200, matchClock: clock(1100, 207) }),
      ])
    ).toBe(true);
  });

  it("is also a no-op for a job with no clock at all (legacy rows)", () => {
    expect(clockLaneEnabledForJob(rows)).toBe(false);
    const master = buildPostableHighlights(rows);
    expect(buildPostableHighlights(rows)).toEqual(master);
  });

  it("R3: a clockless moment in a clocked job keeps its own card", () => {
    // Two rows prove the lane live; the third carries no clock, so it can be
    // neither a merge owner nor a merge target — it ships unchanged.
    const mixed = [
      goal({ id: "hl-a", start: 93, matchClock: clock(1520, 100) }),
      goal({ id: "hl-b", start: 175, matchClock: clock(1527, 100) }),
      goal({ id: "hl-c", start: 400 }),
    ];
    const out = buildPostableHighlights(mixed);
    expect(out.highlights.map((h) => h.id)).toEqual(["hl-a", "hl-c"]);
    expect(out.duplicates.map((d) => d.id)).toEqual(["hl-b"]);
    expect(out.counts).toMatchObject({ postable: 2, merged: 1 });
  });
});

// ---------------------------------------------------------------------------
// 7. AC-GT6 — zero added OCR calls / zero added GPU-seconds
// ---------------------------------------------------------------------------
describe("AC-GT6: the lane adds no OCR call and no GPU-second", () => {
  it("reads ONLY fields already on the row (no OCR client, no image, no inference)", () => {
    const touched = new Set<string>();
    const watched = (row: HighlightRecord) =>
      new Proxy(row as unknown as Record<string, unknown>, {
        get(target, prop: string) {
          touched.add(prop);
          return target[prop];
        },
      }) as unknown as HighlightRecord;
    const rows = [
      goal({ id: "hl-a", start: 93, matchClock: clock(1520, 100) }),
      goal({ id: "hl-b", start: 175, matchClock: clock(1527, 100) }),
    ].map(watched);
    // The merge lane's own entry point on the already-collapsed moments.
    const out = clockCombineForJob([rows[0], rows[1]], rows);
    expect(out.merged).toBe(1);
    // Every field the lane touches is a DECLARED field of the persisted record
    // schema — the lane can only read the row it was handed, never reach for
    // something that would imply a fresh read.
    const declared = new Set(Object.keys(HighlightRecordSchema.shape));
    for (const key of touched) expect(declared.has(key), `touched:${key}`).toBe(true);
    // ...and nothing that would be an OCR / image / model read.
    for (const forbidden of ["ocr", "image", "imageB64", "frames", "observations", "analyze", "decide"]) {
      expect(touched.has(forbidden)).toBe(false);
    }
  });

  it("costs nothing on a job the lane disables", () => {
    const rows = [goal({ id: "hl-a", start: 93 }), goal({ id: "hl-b", start: 175, matchClock: clock(1520, 100) })];
    expect(clockCombineForJob([], rows)).toEqual({ moments: [], duplicates: [], merged: 0 });
  });
});
