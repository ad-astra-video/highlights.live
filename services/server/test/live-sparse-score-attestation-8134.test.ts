// ADAAAA-8134: the LIVE scoring lane's read-side attestation for a screen share
// whose scorebug is only read on part of the window's frames.
//
// Regression source: the 5 demotions on the 18 browser screen-share legs of
// 2026-11-05 14:30-15:51Z (parent ADAAAA-8133), read back from the stored
// `decide_audit.prompt_text` timelines. Two measurable defects, both zero-GPU:
//
//  1. a broadcast clock OCR'd with a dash separator (`"19-41 RMA-2-1 BAR"` on job
//     68a4c53d g5/g7) was read as the score `(19,41)`, injecting a third score
//     state into a window whose real score never changed — which the
//     "one transition per window" clause then threw away;
//  2. the PRE side of the transition lived in the window that closed before the
//     judged one (job 95e454a3 g4 reads `2-1` on every one of its 20 records), so
//     a window that carried plenty of reads still had no legible transition.
//
// The fix folds the reads the rail already paid for into a run ledger and
// re-reads it over a bounded span wider than the judged window. These tests pin
// the legibility bar (unchanged), the attribution bounds (unchanged), the lull
// precision case, and the read-count disclosure the AC asks for.
import { describe, expect, it } from "vitest";
import {
  LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S,
  LiveRunShared,
  SCOREBOARD_MAX_CONFIRM_GAP_S,
  SCORE_READ_SUPPORT_LEAD_S,
  SCORE_READ_SUPPORT_TRAIL_S,
  liveGoalAttestationUsed,
  liveUnattestedGoalNote,
  parseOcrScoreLine,
  scoreReadDiagnostics,
  scoreReadingsFromTimeline,
  scoreboardDeltaFromPooledReadings,
  scoreboardDeltaFromReadings,
  type TimelineScoreReading,
} from "../src/analyzer.js";
import { HighlightRecordSchema } from "@highlights/events";

const read = (ts: number, score: [number, number]): TimelineScoreReading => ({ ts, score });

describe("parseOcrScoreLine — a dash-separated clock is not a score (ADAAAA-8134)", () => {
  it("reads the score, not the clock, when both match", () => {
    // The measured job 68a4c53d line: first-match-wins read the clock as (19,41).
    expect(parseOcrScoreLine(["19-41 RMA-2-1 BAR"])).toEqual([2, 1]);
    expect(parseOcrScoreLine(["19-41 RMA 1-1 BAR"])).toEqual([1, 1]);
    expect(parseOcrScoreLine(["19-41 RHA-2-1 BARazende"])).toEqual([2, 1]);
  });

  it("keeps every scorebug variant the live rail actually emits", () => {
    expect(parseOcrScoreLine(["18:01 RMA 1-1 BAR"])).toEqual([1, 1]);
    expect(parseOcrScoreLine(["18:13 |RMA2-1 BAR"])).toEqual([2, 1]);
    expect(parseOcrScoreLine(["18:18 |RM2-1 BARLPE"])).toEqual([2, 1]);
    expect(parseOcrScoreLine(["20.02 RHA 2-1 BAR"])).toEqual([2, 1]);
    expect(parseOcrScoreLine(["ONARIOBMW18.16 IRMA 2-1 "])).toEqual([2, 1]);
  });

  it("still yields a score when the line carries no team text", () => {
    expect(parseOcrScoreLine(["2 - 1"])).toEqual([2, 1]);
    expect(parseOcrScoreLine(["VITALDE", "20:25 |RMA 2-1 BAR"])).toEqual([2, 1]);
  });

  it("never reads a colon clock or noise as a score", () => {
    expect(parseOcrScoreLine(["18:13"])).toBeNull();
    expect(parseOcrScoreLine(["Aszende"])).toBeNull();
    expect(parseOcrScoreLine([])).toBeNull();
    expect(parseOcrScoreLine(undefined)).toBeNull();
  });
});

describe("scoreboardDeltaFromPooledReadings (ADAAAA-8134)", () => {
  const WINDOW = { lo: 100, hi: 107 };

  it("attests a transition whose PRE support sits in the previous window", () => {
    // The measured shape: 1 read inside the window at each side, the PRE reads
    // recorded by the window that closed before it.
    const inWindow = [read(101.0, [2, 1]), read(105.5, [2, 2]), read(106.4, [2, 2])];
    expect(scoreboardDeltaFromReadings(inWindow, WINDOW)).toBeUndefined();
    const ledger = [read(97.0, [2, 1]), read(99.4, [2, 1]), ...inWindow];
    const delta = scoreboardDeltaFromPooledReadings({ readings: ledger, window: WINDOW });
    expect(delta).toMatchObject({ pre: [2, 1], post: [2, 2], deltaTs: 105.5, preSamples: 3, postSamples: 2 });
  });

  it("attests a transition whose POST support sits just past the window close", () => {
    const ledger = [
      read(101.0, [1, 2]),
      read(104.0, [1, 2]),
      read(106.8, [2, 2]),
      read(109.0, [2, 2]),
      read(111.5, [2, 2]),
    ];
    // One window's own timeline cannot (it carries the transition and one post read).
    expect(scoreboardDeltaFromReadings(ledger.filter((r) => r.ts <= WINDOW.hi), WINDOW)).toBeUndefined();
    const delta = scoreboardDeltaFromPooledReadings({ readings: ledger, window: WINDOW });
    expect(delta).toMatchObject({ pre: [1, 2], post: [2, 2], deltaTs: 106.8, postSamples: 3 });
  });

  it("never credits a transition that lies before the judged window", () => {
    // A transition BEFORE `lo` belongs to the earlier window's content.
    const ledger = [read(94.0, [1, 1]), read(96.0, [1, 1]), read(98.0, [2, 1]), read(99.0, [2, 1]), read(103.0, [2, 1])];
    expect(scoreboardDeltaFromPooledReadings({ readings: ledger, window: WINDOW })).toBeUndefined();
  });

  it("never credits a transition that lies past the judged window at accept time", () => {
    const ledger = [read(96.0, [1, 1]), read(98.0, [1, 1]), read(101.0, [1, 1]), read(109.0, [2, 1]), read(110.0, [2, 1])];
    expect(scoreboardDeltaFromPooledReadings({ readings: ledger, window: WINDOW })).toBeUndefined();
  });

  it("keeps the lull precision bar: a score-steady span yields no delta", () => {
    // The ADAAAA-8120 / 159-299 s score-steady class: many reads, one score.
    const steady: TimelineScoreReading[] = [];
    for (let t = 90; t <= 120; t += 0.5) steady.push(read(t, [1, 1]));
    expect(scoreboardDeltaFromPooledReadings({ readings: steady, window: WINDOW })).toBeUndefined();
    expect(scoreboardDeltaFromPooledReadings({ readings: [], window: WINDOW })).toBeUndefined();
    expect(scoreboardDeltaFromPooledReadings({ readings: [read(101, [1, 1])], window: WINDOW })).toBeUndefined();
  });

  it("fails closed on ambiguity inside the judged window", () => {
    // Two distinct transitions inside `[lo, hi]`: the delta cannot say which goal
    // the accept belongs to.
    const ledger = [
      read(100.0, [0, 0]),
      read(101.0, [1, 0]),
      read(102.0, [1, 0]),
      read(105.0, [1, 1]),
      read(106.5, [1, 1]),
    ];
    expect(scoreboardDeltaFromPooledReadings({ readings: ledger, window: WINDOW })).toBeUndefined();
  });

  it("fails closed on a two-goal jump and on a stale PRE read", () => {
    const jump = [read(97.0, [1, 1]), read(98.0, [1, 1]), read(102.0, [3, 1]), read(103.0, [3, 1])];
    expect(scoreboardDeltaFromPooledReadings({ readings: jump, window: WINDOW })).toBeUndefined();
    // PRE support 12 s before the transition is beyond the confirm gap.
    const stale = [read(94.0, [1, 1]), read(95.0, [1, 1]), read(106.0, [2, 1]), read(106.5, [2, 1])];
    expect(106.0 - 95.0).toBeGreaterThan(SCOREBOARD_MAX_CONFIRM_GAP_S);
    expect(scoreboardDeltaFromPooledReadings({ readings: stale, window: WINDOW })).toBeUndefined();
  });

  it("credits a boundary transition for the deferred path within its own lookahead", () => {
    // The transition lands 2 s past the window close; only the deferred range may
    // consume it, and the ADAAAA-8006 lookahead bound still governs.
    const ledger = [read(101.0, [2, 1]), read(103.0, [2, 1]), read(109.0, [2, 2]), read(110.0, [2, 2])];
    expect(scoreboardDeltaFromPooledReadings({ readings: ledger, window: WINDOW })).toBeUndefined();
    const deferred = scoreboardDeltaFromPooledReadings({
      readings: ledger,
      window: WINDOW,
      trailS: LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S,
      deltaRange: { lo: WINDOW.lo, hi: WINDOW.hi + LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S },
    });
    expect(deferred).toMatchObject({ pre: [2, 1], post: [2, 2], deltaTs: 109 });
    // The bound is real: a transition 30 s past the close is never credited.
    const late = [read(101.0, [2, 1]), read(103.0, [2, 1]), read(137.0, [2, 2]), read(138.0, [2, 2])];
    expect(
      scoreboardDeltaFromPooledReadings({
        readings: late,
        window: WINDOW,
        trailS: LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S,
        deltaRange: { lo: WINDOW.lo, hi: WINDOW.hi + LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S },
      })
    ).toBeUndefined();
  });
});

describe("scoreReadDiagnostics — the demoted row's read counts (AC-R4)", () => {
  it("reports the span's reads and the support around the newest transition", () => {
    const ledger = [read(96.0, [1, 1]), read(99.0, [1, 1]), read(101.0, [1, 1]), read(105.0, [2, 1])];
    const d = scoreReadDiagnostics(ledger, { lo: 100, hi: 107 });
    expect(d).toEqual({ scoreReads: 4, preSamples: 3, postSamples: 1, need: 2 });
  });

  it("reports 0 reads for an unreadable span and all-pre for a steady one", () => {
    expect(scoreReadDiagnostics([], { lo: 100, hi: 107 })).toEqual({ scoreReads: 0, preSamples: 0, postSamples: 0, need: 2 });
    expect(scoreReadDiagnostics([read(101, [1, 1]), read(103, [1, 1])], { lo: 100, hi: 107 })).toEqual({
      scoreReads: 2,
      preSamples: 2,
      postSamples: 0,
      need: 2,
    });
  });

  it("names the counts in the demotion note and on the stored attestation record", () => {
    const used = liveGoalAttestationUsed({
      attribution: { scoreBoardChanged: false, goalCrossed: false, ballOutcome: undefined },
      corroborated: false,
      goalConfirmed: null,
      scoreReads: { scoreReads: 5, preSamples: 1, postSamples: 1, need: 2 },
    });
    expect(used).toMatchObject({ scoreReads: 5, preSamples: 1, postSamples: 1, need: 2 });
    const note = liveUnattestedGoalNote(used);
    expect(note).toContain("scoreReads=5 preSamples=1 postSamples=1 need=2");
    // No counts known (VOD / non-live shape) => the note stays the ADAAAA-8071 one.
    expect(liveUnattestedGoalNote(liveGoalAttestationUsed({ attribution: {} }))).not.toContain("scoreReads=");
  });

  it("round-trips through the highlight record schema (additive optional)", () => {
    const base = {
      id: "hl1",
      jobId: "j1",
      clipUri: "/clips/j1-0.mp4",
      start: 0,
      end: 15,
      score: 50,
      reason: "x",
      eventType: "BIG_PLAY",
      outcome: "big_play" as const,
      status: "accepted" as const,
      createdAt: "2026-11-05T15:38:30.000Z",
    };
    const parsed = HighlightRecordSchema.parse({
      ...base,
      attestationUsed: {
        scoreBoardChanged: false,
        goalCrossed: false,
        ballOutcome: null,
        corroborated: false,
        goalConfirmed: null,
        scoreReads: 20,
        preSamples: 20,
        postSamples: 0,
        need: 2,
      },
    });
    expect(parsed.attestationUsed?.scoreReads).toBe(20);
    // Legacy rows (no counts) still parse.
    expect(
      HighlightRecordSchema.parse({
        ...base,
        attestationUsed: {
          scoreBoardChanged: false,
          goalCrossed: false,
          ballOutcome: null,
          corroborated: false,
          goalConfirmed: null,
        },
      }).attestationUsed?.scoreReads
    ).toBeUndefined();
  });
});

describe("LiveRunShared score-read ledger (ADAAAA-8134)", () => {
  it("keeps one ordered reading per content frame across overlapping windows", () => {
    const run = new LiveRunShared();
    const added = run.noteScoreReadings([
      { ts: 101.5, ocr: ["18:01 RMA 1-1 BAR"] },
      { ts: 100.0, ocr: ["18:01 RMA 1-1 BAR"] },
    ]);
    expect(added).toBe(2);
    // The overlapping window re-carries frame 101.5 (with a flicker read): the
    // ledger keeps the FIRST reading of a frame.
    expect(run.noteScoreReadings([{ ts: 101.5, ocr: ["19-41 RMA 2-1 BAR"] }])).toBe(0);
    expect(run.scoreReadBuffer().map((r) => [r.ts, r.score])).toEqual([
      [100, [1, 1]],
      [101.5, [1, 1]],
    ]);
  });

  it("never fabricates a reading from an unreadable scorebug", () => {
    const run = new LiveRunShared();
    expect(run.noteScoreReadings([{ ts: 10, ocr: ["Aszende"] }, { ts: 11 }])).toBe(0);
    expect(run.scoreReadBuffer()).toEqual([]);
  });

  it("attests a window from two windows' worth of already-received reads", () => {
    const run = new LiveRunShared();
    // Window A (content [90, 97]) read the pre score twice.
    run.noteScoreReadings([
      { ts: 91.0, ocr: ["19-41 RMA 1-1 BAR"] },
      { ts: 93.5, ocr: ["19.58 |RKA 1-1 BAR"] },
    ]);
    // Window B (content [95, 102]) reads the post score, past the transition.
    run.noteScoreReadings([
      { ts: 99.0, ocr: ["20.02 RHA 2-1 BAR"] },
      { ts: 101.0, ocr: ["20.02 RHA 2-1 BAR"] },
    ]);
    const window = { lo: 95, hi: 102 };
    // Neither window alone could attest it (B has no pre read inside its span).
    const own = scoreReadingsFromTimeline([
      { ts: 99.0, ocr: ["20.02 RHA 2-1 BAR"] },
      { ts: 101.0, ocr: ["20.02 RHA 2-1 BAR"] },
    ]);
    expect(scoreboardDeltaFromReadings(own, window)).toBeUndefined();
    const delta = scoreboardDeltaFromPooledReadings({ readings: run.scoreReadBuffer(), window });
    expect(delta).toMatchObject({ pre: [1, 1], post: [2, 1], deltaTs: 99, preSamples: 2, postSamples: 2 });
    // The span bound is the documented one (AC: "say the new bound").
    expect(SCORE_READ_SUPPORT_LEAD_S).toBe(6);
    expect(SCORE_READ_SUPPORT_TRAIL_S).toBe(6);
  });
});
