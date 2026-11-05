// ADAAAA-8078: a decide window must credit the score transition its own perceive
// timeline shows, whatever the POST side length is — and the RUN, not the pure
// derive function, must credit each transition once.
//
// Regression source: job `f0c9c6fb-2a03-4501-a9bc-2cbf7259ba4f` — the 300 s
// media-rail leg at box HEAD `9d9a0b6`, cell `LIVE_OBSERVE_MAX_FRAMES=4` /
// `LIVE_OBSERVE_IN_FLIGHT=2`, graded on ADAAAA-8073. Replaying the shipped gate
// (analyzer.ts `preSamples < need || postSamples !== need`, need = 2) over its 60
// stored `decide_audit` rows derived NOTHING, and GOAL-typed recall graded 1/2.
//
// The four stored timelines below are transcribed VERBATIM from the `perceive
// timeline` block of those rows (`g34`, `g36`, `g54`, `g56`, one record per
// perceive frame with `ocr` split into its rendered lines). `t` is the row's own
// "seconds from the window center"; content ts = WINDOW_CENTER + t, where the
// centers are the leg-relative instants of the row times (leg t0 ~= 08:28:10.5Z,
// stop at `liveEdgeTs 302.497`). Records without an OCR finding carry `ocr: []`
// and contribute no reading (`parseOcrScoreLine` returns null for them).
//
// Replay verdict on this build:
//   g34 08:29:53  1-1 -> 2-1  pre 7  post  1  -> NOT credited (one post read)
//   g36 08:30:01  1-1 -> 2-1  pre 2  post 12  -> credited (the 100 s goal)
//   g54 08:31:00  2-1 -> 2-2  pre 24 post  5  -> credited (the 159 s goal)
//   g56 08:31:06  2-1 -> 2-2  pre 10 post 19  -> credited (same transition as g54)
// (The issue's table quoted 17/1 and 2/33 for the first two rows; a window here
// carries 8 and 14 score-bearing readings, so those counts were not this row's
// own side lengths. The clause under test is the same one.)
import { describe, expect, it, vi } from "vitest";
import {
  CREDITED_SCORE_TRANSITIONS_MAX,
  LiveRunShared,
  deriveWindowAttestation,
  liveGoalAttestationUsed,
  liveGoalHasMeasuredEvidence,
  liveUnattestedGoalNote,
  scoreReadingsFromTimeline,
  scoreTransitionKey,
  scoreboardDeltaFromReadings,
  observeAcceptOnly,
  SCOREBOARD_MAX_CONFIRM_GAP_S,
  type AnalyzerConfig,
  type DecisionResult,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer.js";

interface TimelineRecord {
  ts: number;
  ocr: string[];
}

/** Content ts from the row's "seconds from the window center" offset. */
const at = (center: number, t: number): number => Number((center + t).toFixed(3));

/** The judged span a live window covers: its own records (frames' ts in prod). */
const spanOf = (records: ReadonlyArray<{ ts: number }>) => ({
  lo: records[0].ts,
  hi: records[records.length - 1].ts,
});

/** decide_audit `g34` - window 08:29:53Z, transition 1-1 -> 2-1. */
const GOAL1_EARLY_RECORDS: TimelineRecord[] = [
  { ts: at(102.5, -9.6), ocr: ["18:01 RMA 1-1 BAR"] },
  { ts: at(102.5, -9.2), ocr: ["18:01 RMA 1-1 BAR"] },
  { ts: at(102.5, -8.9), ocr: ["18:01 RMA 1-1 BAR"] },
  { ts: at(102.5, -8.5), ocr: ["18:01 RMA 1-1 BAR"] },
  { ts: at(102.5, -8.2), ocr: ["18:01 RMA 1-1 BAR"] },
  { ts: at(102.5, -7.8), ocr: [] },
  { ts: at(102.5, -7.5), ocr: [] },
  { ts: at(102.5, -7.1), ocr: [] },
  { ts: at(102.5, -6.8), ocr: [] },
  { ts: at(102.5, -6.4), ocr: [] },
  { ts: at(102.5, -6.0), ocr: [] },
  { ts: at(102.5, -5.7), ocr: [] },
  { ts: at(102.5, -5.3), ocr: [] },
  { ts: at(102.5, -5.0), ocr: [] },
  { ts: at(102.5, -4.6), ocr: [] },
  { ts: at(102.5, -4.2), ocr: [] },
  { ts: at(102.5, -3.9), ocr: ["18.05 RMA 1-1 BARVITALDE"] },
  { ts: at(102.5, -3.5), ocr: ["18.05 RMA 1-1 BARVITALDE"] },
  { ts: at(102.5, -3.2), ocr: [] },
  { ts: at(102.5, -2.8), ocr: [] },
  { ts: at(102.5, -2.5), ocr: [] },
  { ts: at(102.5, -2.1), ocr: [] },
  { ts: at(102.5, -1.7), ocr: [] },
  { ts: at(102.5, -1.4), ocr: [] },
  { ts: at(102.5, -1.0), ocr: [] },
  { ts: at(102.5, -0.7), ocr: [] },
  { ts: at(102.5, -0.3), ocr: [] },
  { ts: at(102.5, -0.0), ocr: ["18:13 ", "RMA2-1 BAR"] },
];

/** decide_audit `g36` - window 08:30:01Z, transition 1-1 -> 2-1. */
const GOAL1_DENSE_RECORDS: TimelineRecord[] = [
  { ts: at(110.5, -9.3), ocr: [] },
  { ts: at(110.5, -8.9), ocr: [] },
  { ts: at(110.5, -8.5), ocr: [] },
  { ts: at(110.5, -8.2), ocr: [] },
  { ts: at(110.5, -7.8), ocr: ["18.05 RMA 1-1 BARVITALDE"] },
  { ts: at(110.5, -7.5), ocr: ["18.05 RMA 1-1 BARVITALDE"] },
  { ts: at(110.5, -7.1), ocr: [] },
  { ts: at(110.5, -6.7), ocr: [] },
  { ts: at(110.5, -6.4), ocr: [] },
  { ts: at(110.5, -6.0), ocr: [] },
  { ts: at(110.5, -5.7), ocr: [] },
  { ts: at(110.5, -5.3), ocr: [] },
  { ts: at(110.5, -5.0), ocr: [] },
  { ts: at(110.5, -4.6), ocr: [] },
  { ts: at(110.5, -4.3), ocr: [] },
  { ts: at(110.5, -3.9), ocr: ["18:13 ", "RMA2-1 BAR"] },
  { ts: at(110.5, -3.6), ocr: ["18:13 ", "RMA2-1 BAR"] },
  { ts: at(110.5, -3.2), ocr: ["18:13 ", "RMA2-1 BAR"] },
  { ts: at(110.5, -2.9), ocr: ["18:13 ", "RMA2-1 BAR"] },
  { ts: at(110.5, -2.5), ocr: ["18:13 ", "RMA2-1 BAR"] },
  { ts: at(110.5, -2.2), ocr: ["18:18 ", "RM2-1 BARLPE"] },
  { ts: at(110.5, -1.8), ocr: ["18:18 ", "RM2-1 BARLPE"] },
  { ts: at(110.5, -1.4), ocr: ["18:18 ", "RM2-1 BARLPE"] },
  { ts: at(110.5, -1.1), ocr: ["18:18 ", "RM2-1 BARLPE"] },
  { ts: at(110.5, -0.7), ocr: ["18:18 ", "RM2-1 BARLPE"] },
  { ts: at(110.5, -0.4), ocr: ["18:18 ", "RM2-1 BARLPE"] },
  { ts: at(110.5, -0.0), ocr: ["18:18 ", "RM2-1 BARLPE"] },
];

/** decide_audit `g54` - window 08:31:00Z, transition 2-1 -> 2-2. */
const GOAL2_DENSE_RECORDS: TimelineRecord[] = [
  { ts: at(169.5, -10.0), ocr: ["22.03 RMA 2-1 BAR"] },
  { ts: at(169.5, -9.7), ocr: ["22.08 IRMA 2-1 BARAszend"] },
  { ts: at(169.5, -9.3), ocr: ["22.08 IRMA 2-1 BARAszend"] },
  { ts: at(169.5, -8.9), ocr: ["22.08 IRMA 2-1 BARAszend"] },
  { ts: at(169.5, -8.6), ocr: ["22.08 IRMA 2-1 BARAszend"] },
  { ts: at(169.5, -8.2), ocr: ["22.08 IRMA 2-1 BARAszend"] },
  { ts: at(169.5, -7.9), ocr: ["22.08 IRMA 2-1 BARAszend"] },
  { ts: at(169.5, -7.5), ocr: ["22.08 IRMA 2-1 BARAszend"] },
  { ts: at(169.5, -7.2), ocr: ["22.08 IRMA 2-1 BARAszend"] },
  { ts: at(169.5, -6.8), ocr: ["22.08 IRMA 2-1 BARAszend"] },
  { ts: at(169.5, -6.5), ocr: ["22.08 IRMA 2-1 BARAszend"] },
  { ts: at(169.5, -6.1), ocr: ["22.08 IRMA 2-1 BARAszend"] },
  { ts: at(169.5, -5.7), ocr: ["22.08 IRMA 2-1 BARAszend"] },
  { ts: at(169.5, -5.4), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(169.5, -5.0), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(169.5, -4.7), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(169.5, -4.3), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(169.5, -3.9), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(169.5, -3.6), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(169.5, -3.2), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(169.5, -2.9), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(169.5, -2.5), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(169.5, -2.1), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(169.5, -1.8), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(169.5, -1.4), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(169.5, -1.1), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(169.5, -0.7), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(169.5, -0.4), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(169.5, +0.0), ocr: ["22:19 ", "RMA 2-2 BAR"] },
];

/** decide_audit `g56` - window 08:31:06Z, transition 2-1 -> 2-2. */
const GOAL2_FULL_RECORDS: TimelineRecord[] = [
  { ts: at(175.5, -10.0), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(175.5, -9.7), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(175.5, -9.3), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(175.5, -8.9), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(175.5, -8.6), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(175.5, -8.2), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(175.5, -7.9), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(175.5, -7.5), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(175.5, -7.1), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(175.5, -6.8), ocr: ["22:12 IRMA 2: 1 BARAszen", "22.12 RMA 2-1 BARAszende"] },
  { ts: at(175.5, -6.4), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -6.1), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -5.7), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -5.4), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -5.0), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -4.7), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -4.3), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -4.0), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -3.6), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -3.2), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -2.9), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -2.5), ocr: ["22:19 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -2.2), ocr: ["22:24 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -1.8), ocr: ["22:24 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -1.5), ocr: ["22:24 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -1.1), ocr: ["22:24 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -0.7), ocr: ["22:24 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, -0.4), ocr: ["22:24 ", "RMA 2-2 BAR"] },
  { ts: at(175.5, +0.0), ocr: ["22:24 ", "RMA 2-2 BAR"] },
];

const readingsOf = (records: TimelineRecord[]) => scoreReadingsFromTimeline(records);

/** A minimal legible delta used only to drive the run's claim ledger. */
function deltaOf(pre: [number, number], post: [number, number], deltaTs = 1): ScoreboardDeltaEvidence {
  return { pre, post, preTs: 0, postTs: deltaTs, deltaTs, preSamples: 2, postSamples: 2 };
}

describe("scoreboardDeltaFromReadings - dense decide window (ADAAAA-8078)", () => {
  it("credits the 100 s goal transition with 12 post reads (g36 08:30:01Z)", () => {
    const delta = scoreboardDeltaFromReadings(readingsOf(GOAL1_DENSE_RECORDS), spanOf(GOAL1_DENSE_RECORDS));
    expect(delta).toBeDefined();
    expect(delta!.pre).toEqual([1, 1]);
    expect(delta!.post).toEqual([2, 1]);
    expect(delta!.preSamples).toBe(2);
    expect(delta!.postSamples).toBe(12);
    expect(delta!.preTs).toBe(at(110.5, -7.5));
    expect(delta!.deltaTs).toBe(at(110.5, -3.9));
  });

  it("credits the 159 s goal transition with 5 post reads (g54 08:31:00Z)", () => {
    const delta = scoreboardDeltaFromReadings(readingsOf(GOAL2_DENSE_RECORDS), spanOf(GOAL2_DENSE_RECORDS));
    expect(delta).toBeDefined();
    expect(delta!.pre).toEqual([2, 1]);
    expect(delta!.post).toEqual([2, 2]);
    expect(delta!.preSamples).toBe(24);
    expect(delta!.postSamples).toBe(5);
    expect(delta!.deltaTs).toBe(at(169.5, -1.4));
  });

  it("credits the same transition from the later window with 19 post reads (g56 08:31:06Z)", () => {
    const delta = scoreboardDeltaFromReadings(readingsOf(GOAL2_FULL_RECORDS), spanOf(GOAL2_FULL_RECORDS));
    expect(delta).toBeDefined();
    expect(delta!.pre).toEqual([2, 1]);
    expect(delta!.post).toEqual([2, 2]);
    expect(delta!.preSamples).toBe(10);
    expect(delta!.postSamples).toBe(19);
    expect(delta!.deltaTs).toBe(at(175.5, -6.4));
  });

  it("still refuses the window whose POST side is a single read (g34 08:29:53Z)", () => {
    const readings = readingsOf(GOAL1_EARLY_RECORDS);
    // The window ends AT the transition: 7 reads on 1-1, then exactly one on 2-1.
    expect(readings).toHaveLength(8);
    expect(scoreboardDeltaFromReadings(readings, spanOf(GOAL1_EARLY_RECORDS))).toBeUndefined();
    // ... and the overlapping window that DOES carry >= 2 post reads credits the
    // same goal, so the transition is not lost (g36 above).
  });

  it("identifies the two views of one transition as the same event", () => {
    const early = scoreboardDeltaFromReadings(readingsOf(GOAL2_DENSE_RECORDS), spanOf(GOAL2_DENSE_RECORDS))!;
    const late = scoreboardDeltaFromReadings(readingsOf(GOAL2_FULL_RECORDS), spanOf(GOAL2_FULL_RECORDS))!;
    // Different windows, different side lengths, a ~1 s flicker in where the OCR
    // boundary lands ...
    expect(early.deltaTs).not.toBe(late.deltaTs);
    expect(early.postSamples).not.toBe(late.postSamples);
    // ... and ONE identity, so the run credits it once.
    expect(scoreTransitionKey(early)).toBe(scoreTransitionKey(late));
    expect(scoreTransitionKey(early)).toBe("2-1>2-2");
    expect(scoreTransitionKey(scoreboardDeltaFromReadings(readingsOf(GOAL1_DENSE_RECORDS), spanOf(GOAL1_DENSE_RECORDS))!)).toBe("1-1>2-1");
  });

  it("refuses a single post read however long the pre side is", () => {
    const pre = Array.from({ length: 20 }, (_, i) => ({ ts: 100 + i * 0.3, ocr: ["18:01 RMA 1-1 BAR"] }));
    const single = [...pre, { ts: 107, ocr: ["18:13 |RMA2-1 BAR"] }];
    expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(single), spanOf(single))).toBeUndefined();
    // Two post reads are enough (the bar), five are fine; one is not evidence.
    const two = [...pre, { ts: 107, ocr: ["18:13 |RMA2-1 BAR"] }, { ts: 107.4, ocr: ["18:13 |RMA2-1 BAR"] }];
    expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(two), spanOf(two))?.postSamples).toBe(2);
  });

  it("refuses a non-single-goal step even with a long post side", () => {
    const jump = [
      { ts: 100, ocr: ["18:01 RMA 0-0 BAR"] },
      { ts: 100.4, ocr: ["18:05 RMA 0-0 BAR"] },
      { ts: 101, ocr: ["18:09 RMA 2-0 BAR"] },
      { ts: 101.4, ocr: ["18:13 RMA 2-0 BAR"] },
      { ts: 101.8, ocr: ["18:17 RMA 2-0 BAR"] },
      { ts: 102.2, ocr: ["18:21 RMA 2-0 BAR"] },
    ];
    expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(jump), spanOf(jump))).toBeUndefined();
  });

  it("refuses a transition further than the confirm gap from the last pre read", () => {
    const late = [
      { ts: 100, ocr: ["18:01 RMA 1-1 BAR"] },
      { ts: 100.4, ocr: ["18:05 RMA 1-1 BAR"] },
      { ts: 100 + SCOREBOARD_MAX_CONFIRM_GAP_S + 0.6, ocr: ["18:13 RMA 2-1 BAR"] },
      { ts: 100 + SCOREBOARD_MAX_CONFIRM_GAP_S + 1.0, ocr: ["18:13 RMA 2-1 BAR"] },
    ];
    expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(late), spanOf(late))).toBeUndefined();
  });

  it("refuses a window that carries two distinct transitions (matured tail guard)", () => {
    // A window long enough to run past the NEXT goal: 1-1 -> 2-1 -> 2-2. Crediting
    // the last boundary would attribute the later goal to this window's candidate,
    // so neither transition may attest from here (each has its own window).
    const twoGoals = [
      { ts: 100, ocr: ["18:01 RMA 1-1 BAR"] },
      { ts: 100.4, ocr: ["18:05 RMA 1-1 BAR"] },
      { ts: 101, ocr: ["18:13 RMA 2-1 BAR"] },
      { ts: 101.4, ocr: ["18:17 RMA 2-1 BAR"] },
      { ts: 101.8, ocr: ["18:21 RMA 2-1 BAR"] },
      { ts: 102.2, ocr: ["22:19 RMA 2-2 BAR"] },
      { ts: 102.6, ocr: ["22:23 RMA 2-2 BAR"] },
      { ts: 103, ocr: ["22:27 RMA 2-2 BAR"] },
    ];
    expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(twoGoals), spanOf(twoGoals))).toBeUndefined();
    // Each transition is still credited from a window that carries only that one.
    expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(twoGoals.slice(0, 5)), { lo: 100, hi: 101.8 })?.post)
      .toEqual([2, 1]);
    expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(twoGoals.slice(2)), { lo: 101, hi: 103 })?.post)
      .toEqual([2, 2]);
  });

  it("counts a misread that flickers back to a seen score as ONE transition", () => {
    // The guard counts NEW score states, not boundaries: a single-frame misread in
    // the middle of a window must not disqualify an otherwise legible transition.
    const flicker = [
      { ts: 100, ocr: ["18:01 RMA 1-1 BAR"] },
      { ts: 100.4, ocr: ["18:05 RMA 1-1 BAR"] },
      { ts: 100.8, ocr: ["18:09 RMA 2-1 BAR"] },
      { ts: 101.2, ocr: ["18:13 RMA 1-1 BAR"] },
      { ts: 101.6, ocr: ["18:17 RMA 1-1 BAR"] },
      { ts: 102, ocr: ["18:21 RMA 2-1 BAR"] },
      { ts: 102.4, ocr: ["18:25 RMA 2-1 BAR"] },
    ];
    const delta = scoreboardDeltaFromReadings(scoreReadingsFromTimeline(flicker), spanOf(flicker));
    expect(delta).toBeDefined();
    expect(delta!.pre).toEqual([1, 1]);
    expect(delta!.post).toEqual([2, 1]);
    expect(delta!.deltaTs).toBe(102);
    expect(delta!.preSamples).toBe(2);
    expect(delta!.postSamples).toBe(2);
  });

  it("refuses a window that spans TWO distinct transitions (ambiguous attribution)", () => {
    // A matured post side can run past the NEXT goal; crediting the later
    // boundary to this window's candidate would lift a demotion with the wrong
    // goal, so a two-transition window attests nothing.
    const two = [
      { ts: 100, ocr: ["18:01 RMA 1-1 BAR"] },
      { ts: 100.4, ocr: ["18:01 RMA 1-1 BAR"] },
      { ts: 101, ocr: ["18:05 RMA 2-1 BAR"] },
      { ts: 101.4, ocr: ["18:05 RMA 2-1 BAR"] },
      { ts: 102, ocr: ["18:09 RMA 2-2 BAR"] },
      { ts: 102.4, ocr: ["18:09 RMA 2-2 BAR"] },
    ];
    expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(two), spanOf(two))).toBeUndefined();
    // An OCR flicker back to an already-seen score is ONE transition, not two
    // (the last boundary still needs >= 2 contiguous reads on each side).
    const flicker = [
      { ts: 100, ocr: ["18:01 RMA 1-1 BAR"] },
      { ts: 100.4, ocr: ["18:01 RMA 1-1 BAR"] },
      { ts: 100.8, ocr: ["18:05 RMA 2-1 BAR"] },
      { ts: 101.2, ocr: ["18:05 RMA 1-1 BAR"] },
      { ts: 101.6, ocr: ["18:09 RMA 1-1 BAR"] },
      { ts: 102, ocr: ["18:13 RMA 2-1 BAR"] },
      { ts: 102.4, ocr: ["18:13 RMA 2-1 BAR"] },
    ];
    const delta = scoreboardDeltaFromReadings(scoreReadingsFromTimeline(flicker), spanOf(flicker));
    expect(delta?.post).toEqual([2, 1]);
  });

  it("accepts any post side >= minSamples (the clause this issue fixes)", () => {
    for (const postReads of [2, 3, 4, 12, 33]) {
      const recs: TimelineRecord[] = [
        { ts: 100, ocr: ["18:01 RMA 1-1 BAR"] },
        { ts: 100.4, ocr: ["18:05 RMA 1-1 BAR"] },
      ];
      for (let i = 0; i < postReads; i++) recs.push({ ts: 101 + i * 0.4, ocr: ["18:13 |RMA2-1 BAR"] });
      const delta = scoreboardDeltaFromReadings(scoreReadingsFromTimeline(recs), spanOf(recs));
      expect(delta?.postSamples).toBe(postReads);
      expect(delta?.post).toEqual([2, 1]);
    }
  });
});

describe("deriveWindowAttestation - one credit per score transition per run (ADAAAA-8078)", () => {
  it("attests the g54 window from its own perceive timeline", () => {
    const att = deriveWindowAttestation({
      centerTs: 169.5,
      frames: GOAL2_DENSE_RECORDS.map((r) => ({ ts: r.ts })),
      observations: GOAL2_DENSE_RECORDS,
      biasHints: [],
    });
    expect(att.scoreBoardChanged).toBe(true);
    expect(att.scoreAttestationSource).toBe("perceive_timeline");
    expect(att.scoreBoardDelta?.postSamples).toBe(5);
    expect(liveGoalHasMeasuredEvidence(liveGoalAttestationUsed({ attribution: att }))).toBe(true);
  });

  it("credits the transition once: the next overlapping window is unattested", () => {
    const run = new LiveRunShared();
    const claim = (delta: ScoreboardDeltaEvidence) => run.claimScoreTransition(delta);
    const payload = (records: TimelineRecord[], centerTs: number) => ({
      centerTs,
      frames: records.map((r) => ({ ts: r.ts })),
      observations: records,
      biasHints: [],
    });

    const first = deriveWindowAttestation(payload(GOAL2_DENSE_RECORDS, 169.5), { claimScoreTransition: claim });
    expect(first.scoreBoardChanged).toBe(true);
    expect(first.scoreBoardDelta?.deltaTs).toBe(at(169.5, -1.4));

    // The later window re-reads the same 2-1 -> 2-2 transition (19 post reads):
    // it derives, but the run already credited it, so it cannot attest again.
    const second = deriveWindowAttestation(payload(GOAL2_FULL_RECORDS, 175.5), { claimScoreTransition: claim });
    expect(second.scoreBoardChanged).toBeUndefined();
    expect(second.scoreBoardDelta).toBeUndefined();
    expect(second.scoreAttestationSource).toBeUndefined();
    expect(liveGoalHasMeasuredEvidence(liveGoalAttestationUsed({ attribution: second }))).toBe(false);
    expect(run.creditedScoreTransitionKeys()).toEqual(["2-1>2-2"]);

    // A DISTINCT transition (the other goal) is still credited.
    const other = deriveWindowAttestation(payload(GOAL1_DENSE_RECORDS, 110.5), { claimScoreTransition: claim });
    expect(other.scoreBoardChanged).toBe(true);
    expect(run.creditedScoreTransitionKeys()).toEqual(["2-1>2-2", "1-1>2-1"]);
  });

  it("keeps a VOD payload (no observations) byte-identical and never claims", () => {
    const claim = vi.fn(() => true);
    const att = deriveWindowAttestation(
      {
        centerTs: 169.5,
        frames: GOAL2_DENSE_RECORDS.map((r) => ({ ts: r.ts })),
        biasHints: [{ eventType: "AUDIO_BURST", ts: 169.5 }],
      },
      { claimScoreTransition: claim }
    );
    expect(claim).not.toHaveBeenCalled();
    expect(att.scoreBoardChanged).toBeUndefined();
    expect(att.scoreBoardDelta).toBeUndefined();
    expect(att.scoreAttestationSource).toBeUndefined();
  });

  it("names the attestation fields on the demotion of an uncredited re-read", () => {
    const run = new LiveRunShared();
    const claim = (delta: ScoreboardDeltaEvidence) => run.claimScoreTransition(delta);
    deriveWindowAttestation(
      { centerTs: 169.5, frames: GOAL2_DENSE_RECORDS.map((r) => ({ ts: r.ts })), observations: GOAL2_DENSE_RECORDS, biasHints: [] },
      { claimScoreTransition: claim }
    );
    const reRead = deriveWindowAttestation(
      { centerTs: 175.5, frames: GOAL2_FULL_RECORDS.map((r) => ({ ts: r.ts })), observations: GOAL2_FULL_RECORDS, biasHints: [] },
      { claimScoreTransition: claim }
    );
    const used = liveGoalAttestationUsed({ attribution: reRead });
    expect(used.scoreBoardChanged).toBe(false);
    const note = liveUnattestedGoalNote(used);
    expect(note).toContain("scoreBoardChanged=false");
    expect(note).toContain("goalCrossed=false");
    expect(note).toContain("ballOutcome=none");
    expect(note).toContain("corroborated=false");
    expect(note).toContain("goalConfirmed=none");
  });
});

describe("LiveRunShared.claimScoreTransition (ADAAAA-8078)", () => {
  it("claims one transition once", () => {
    const run = new LiveRunShared();
    expect(run.claimScoreTransition(deltaOf([2, 1], [2, 2]))).toBe(true);
    expect(run.claimScoreTransition(deltaOf([2, 1], [2, 2], 1.5))).toBe(false);
    expect(run.creditedScoreTransitionKeys()).toEqual(["2-1>2-2"]);
  });

  it("treats a flicker-shifted transition instant as the same transition", () => {
    const run = new LiveRunShared();
    expect(run.claimScoreTransition(deltaOf([1, 1], [2, 1], 102.2))).toBe(true);
    // The overlapping window re-lands the boundary a second later: same event.
    expect(run.claimScoreTransition(deltaOf([1, 1], [2, 1], 103.1))).toBe(false);
  });

  it("claims a genuinely different transition", () => {
    const run = new LiveRunShared();
    expect(run.claimScoreTransition(deltaOf([1, 1], [2, 1]))).toBe(true);
    expect(run.claimScoreTransition(deltaOf([2, 1], [2, 2]))).toBe(true);
    expect(run.creditedScoreTransitionKeys()).toEqual(["1-1>2-1", "2-1>2-2"]);
  });

  it("fails closed on an illegible delta (a one-read side)", () => {
    const run = new LiveRunShared();
    expect(run.claimScoreTransition({ ...deltaOf([1, 1], [2, 1]), postSamples: 1 })).toBe(false);
    expect(run.claimScoreTransition(undefined)).toBe(false);
    expect(run.claimScoreTransition(null)).toBe(false);
    expect(run.creditedScoreTransitionKeys()).toEqual([]);
  });

  it("stays bounded", () => {
    const run = new LiveRunShared();
    for (let n = 0; n < CREDITED_SCORE_TRANSITIONS_MAX + 1; n++) {
      const a = n % 100;
      const b = Math.floor(n / 100) % 99;
      expect(run.claimScoreTransition(deltaOf([a, b], [a, b + 1]))).toBe(true);
    }
    // The oldest entry is evicted under pressure (a re-claim is then possible).
    expect(run.creditedScoreTransitionKeys()).toHaveLength(CREDITED_SCORE_TRANSITIONS_MAX);
    expect(run.claimScoreTransition(deltaOf([0, 0], [0, 1]))).toBe(true);
    expect(run.creditedScoreTransitionKeys()).toHaveLength(CREDITED_SCORE_TRANSITIONS_MAX);
  });
});

describe("accept path wiring - the claim reaches the live gate (ADAAAA-8078)", () => {
  /** A live observe payload for one stored window: the FULL observation set plus
   *  the 4 delivered images the cell actually shipped. */
  function livePayloadOf(records: TimelineRecord[], centerTs: number) {
    const n = records.length;
    // 4 images spread across the window (the shipped image budget), the last one
    // AT the window's end so the judged span is the whole stored window.
    const picks = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1];
    const frames = picks.map((i, seq) => ({ ts: records[i].ts, imageB64: "f", seq }));
    return {
      centerTs,
      frames,
      seeds: records.map((r) => ({ ts: r.ts, tracks: [], objects: [], ocr: r.ocr })),
      observations: records,
      biasHints: [],
      capped: false,
      droppedCount: 0,
    } as any;
  }
  function goalDecision() {
    return {
      isHighlight: true,
      score: 92,
      outcome: "scoring_play",
      eventType: "GOAL",
      reason: "the ball enters the net",
    } as DecisionResult;
  }
  function liveCfg() {
    return {
      jobId: "job-8078",
      gameHint: "soccer",
      clipBeforeS: 6,
      clipAfterS: 9,
      clipWindowMinSec: 15,
      preferLabels: [],
      confirmEnabled: false,
      liveObserveLoop: true,
      observeWindowS: 10,
      sampleFps: 3,
    } as unknown as AnalyzerConfig;
  }

  it("accepts the crediting window as a GOAL and demotes the uncredited re-read", async () => {
    const run = new LiveRunShared({ goalBurstWindowS: 1 });
    const cut = async (t: number) => ({ clipId: `clip-${t}`, clipUri: "" });
    const client = { decide: async () => goalDecision(), confirm: async () => ({ enabled: false }) } as any;

    // Window g54 (169.5 s) carries 2-1 -> 2-2 with 5 post reads: it claims the
    // transition and its GOAL accept keeps the scoring lane.
    await observeAcceptOnly(client, run, cut, liveCfg(), undefined, livePayloadOf(GOAL2_DENSE_RECORDS, 169.5), goalDecision());
    // Window g56 (175.5 s) re-reads the SAME transition with 19 post reads: it
    // derives it, the run refuses the second credit, and the gate demotes it.
    await observeAcceptOnly(client, run, cut, liveCfg(), undefined, livePayloadOf(GOAL2_FULL_RECORDS, 175.5), goalDecision());

    expect(run.highlights.map((h) => h.eventType)).toEqual(["GOAL", "BIG_PLAY"]);
    expect(run.creditedScoreTransitionKeys()).toEqual(["2-1>2-2"]);
    // ADAAAA-8140: an ACCEPTED goal row discloses the attestation that carried it
    // (this used to assert `undefined` — "a GOAL row appeared" was unauditable).
    expect(run.highlights[0].attestationUsed?.scoreBoardChanged).toBe(true);
    expect(run.highlights[0].attestationUsed?.transitionKey).toBe("2-1>2-2");
    expect(run.highlights[0].attestationUsed?.scoreReads).toBeGreaterThan(0);
    // The demotion names the attestations the gate read (all false: the
    // transition was already credited by the earlier window).
    expect(run.highlights[1].attestationUsed?.scoreBoardChanged).toBe(false);
    expect(run.highlights[1].reason).toContain("scoreBoardChanged=false");
    expect(run.highlights[1].reason).toContain("delivered as a celebration, not a GOAL");
  });
});
