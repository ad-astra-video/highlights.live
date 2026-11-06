// ADAAAA-8189: the live score gate died on a SEPARATOR, not on coverage.
//
// Measured on live job `348bd511` (the ADAAAA-8185 read): the scoreboard text
// reached the decide prompts correctly — 2900 `ocr="…"` readings, 597 distinct —
// but the score pair was glued with `/` (1450 readings) or `.` (the `1.0`
// variant) and 0 of 2900 readings carried a hyphen. The parser only accepted a
// hyphen, so `scoreReadingsFromTimeline` was empty in EVERY judged window, the
// live goal gate saw `scoreReads=0` and demoted every GOAL accept to a
// celebration (ADAAAA-7996), and the deferred re-attestation of ADAAAA-8077 had
// nothing to re-attest.
//
// The families below are the job's own strings (fixture: the distinct glued
// strings with their read counts). The replay blocks are the job's own measured
// timelines around the two real transitions (`1-0 -> 1-1` at content ~1136 s,
// `1-1 -> 1-2` at content ~2024.5 s) and a steady window either side.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S,
  OCR_SCORE_PAIR_MAX_GLUED,
  SCOREBOARD_MIN_CONSISTENT_READS,
  deriveWindowAttestation,
  parseOcrScoreLine,
  scoreReadingsFromTimeline,
  scoreboardDeltaFromPooledReadings,
  scoreboardDeltaFromReadings,
  type TimelineScoreReading,
} from "../src/analyzer.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/8189-glued-ocr-strings.json", import.meta.url), "utf8")
) as { strings: { ocr: string; reads: number }[] };

const timeline = (w: { centre: number; obs: { t: number; ocr: string[] }[] }): { ts: number; ocr: string[] }[] =>
  w.obs.map((o) => ({ ts: w.centre + o.t, ocr: o.ocr }));
const windowOf = (obs: { ts: number }[]): { lo: number; hi: number } => ({
  lo: Math.min(...obs.map((o) => o.ts)),
  hi: Math.max(...obs.map((o) => o.ts)),
});

const read = (ts: number, score: [number, number]): TimelineScoreReading => ({ ts, score });

/** Content ts of the two real score steps in the stored job (the OCR clock in
 *  the same strings steps 21:03 -> 21:06 and 35:51 -> 35:54 across them). */
const T1 = 1136.218;
const T2 = 2024.536;

// Job 348bd511 windows, verbatim (t = seconds from the window centre).
const W_STEADY_1 = {
  centre: 1135.147,
  obs: [
    { t: -7.1, ocr: ["RMA 1/0 FCB 20:57SUPERCO"] },
    { t: -6.1, ocr: ["RMA 1/0 FCB 20:57SUPERCO"] },
    { t: -5.0, ocr: ["RMA 1.0 FCB21:00"] },
    { t: -3.9, ocr: ["RMA 1.0 FCB21:00"] },
    { t: -2.1, ocr: ["RMA 1.0 FCB 21:03"] },
    { t: -1.1, ocr: ["RMA 1.0 FCB 21:03"] },
    { t: 0.0, ocr: ["RMA 1.0 FCB 21:03"] },
  ],
};
const W_STEP_1 = {
  centre: 1140.918,
  obs: [
    { t: -9.7, ocr: ["RMA 1.0 FCB21:00"] },
    { t: -7.9, ocr: ["RMA 1.0 FCB 21:03"] },
    { t: -6.8, ocr: ["RMA 1.0 FCB 21:03"] },
    { t: -5.8, ocr: ["RMA 1.0 FCB 21:03"] },
    { t: -4.7, ocr: ["RMA 1/1 FCB21:06"] },
    { t: -2.8, ocr: ["RMA 1/1 FCB21:06"] },
    { t: -1.7, ocr: ["RMA 1 1 FCB 2110"] },
    { t: -0.7, ocr: ["RMA 1 1 FCB 2110"] },
  ],
};
const W_STEADY_2 = {
  centre: 1146.285,
  obs: [
    { t: -9.3, ocr: ["RMA 1/1 FCB21:06"] },
    { t: -8.2, ocr: ["RMA 1/1 FCB21:06"] },
    { t: -7.1, ocr: ["RMA 1 1 FCB 2110"] },
    { t: -6.0, ocr: ["RMA 1 1 FCB 2110"] },
    { t: -4.3, ocr: ["RMA 1 1 FCB 2110"] },
    { t: -3.2, ocr: ["RMA 1/1 FCB2113"] },
    { t: -2.2, ocr: ["RMA 1/1 FCB2113"] },
    { t: -1.1, ocr: ["RMA 1/1 FCB2113"] },
    // `1U1` is a garbled reading: absent evidence, never a parsed pair.
    { t: 0.0, ocr: ["RMA 1U1 FCB 21117"] },
  ],
};
const W_STEP_2 = {
  centre: 2024.552,
  obs: [
    { t: -9.6, ocr: ["RMA 1U1 FCB35144"] },
    { t: -8.5, ocr: ["RMA 1U1 FCB35144"] },
    { t: -7.4, ocr: ["RMA 1/1 FCB 35:47CRAFTED"] },
    { t: -6.4, ocr: ["RMA 1/1 FCB 35:47CRAFTED"] },
    { t: -4.6, ocr: ["RMA 1/1 FCB 35:51oboLITP"] },
    { t: -0.0, ocr: ["RMA 1/2 FCB 35:54"] },
  ],
};
const W_AFTER_2 = {
  centre: 2030.936,
  obs: [
    { t: -6.4, ocr: ["RMA 1/2 FCB 35:54"] },
    { t: -5.6, ocr: ["RMA 1/2 FCB 35:54"] },
    { t: -4.9, ocr: ["RMA 1/2 FCB 35:57"] },
    { t: -3.8, ocr: ["RMA 1/2 FCB 35:57"] },
    { t: -2.7, ocr: ["RMA 1/2 FCB 35:57"] },
    { t: -0.8, ocr: ["RMA 1/2 FCB36:01"] },
  ],
};

describe("parseOcrScoreLine — the glued score pair the live rail emits (ADAAAA-8189)", () => {
  it("reads `1/2`, `1.0` and the space-separated pair, ignoring the clock", () => {
    // The three shapes in the ticket, verbatim.
    expect(parseOcrScoreLine(["RMA 1/2 FCB36:54"])).toEqual([1, 2]);
    expect(parseOcrScoreLine(["RMA 1.0 FCB 17:22HOTELSK"])).toEqual([1, 0]);
    expect(parseOcrScoreLine(["RMA 1 1 FCB 27:067"])).toEqual([1, 1]);
  });

  it("keeps the score when a clock OCR'd with the SAME separator follows it", () => {
    // `10/47`, `20/47`, `20/44` are clocks read with the score's separator: the
    // pair BETWEEN the team tokens is the score, and a two-digit component can
    // never be one.
    expect(parseOcrScoreLine(["RMA 1/0 FCB10/47"])).toEqual([1, 0]);
    expect(parseOcrScoreLine(["RMA 1.0 FCB 20/47SUPERCO"])).toEqual([1, 0]);
    expect(parseOcrScoreLine(["RMA 1/2 FCB 37:06SUPERCOR"])).toEqual([1, 2]);
  });

  it("reads the glued families the box actually produced", () => {
    for (const [line, want] of [
      ["[RMA 1/0 FCB 06:57ESPIT ", [1, 0]],
      ["FIV BETTERRMA 1/0 FCB 04", [1, 0]],
      ["RMA 1.0 FCB1143SUPERCOPA", [1, 0]],
      ["RMA 1/1 FCB21133", [1, 1]],
      ["RMA 1.0 FCB17.141(Clu-Av", [1, 0]],
      ["RMA 1/2 FCB37:06SUPERCOR", [1, 2]],
      ["RMA 1.1 FCB31:10Duxpobet", [1, 1]],
    ] as [string, [number, number]][]) {
      expect(parseOcrScoreLine([line])).toEqual(want);
    }
  });

  it("never reads a clock (or a garbled pair) as a score", () => {
    for (const line of ["36:54", "17:22", "27:067", "12:07", "0:00"]) {
      expect(parseOcrScoreLine([line])).toBeNull();
    }
    // A clock that OCR'd with the score's separator, alone on the line.
    for (const line of ["10/47", "20/44", "17.141", "04/47"]) {
      expect(parseOcrScoreLine([line])).toBeNull();
    }
    // Merged/garbled digits: a phantom `1-5` would be a phantom goal, so the
    // dot and slash families refuse a two-digit side outright.
    for (const line of ["RMA 1.50 FCB 08:00", "RMA 1/50 FCB08:26ESPIT o", "RMA 1SO FCB 04/47"]) {
      expect(parseOcrScoreLine([line])).toBeNull();
    }
    expect(OCR_SCORE_PAIR_MAX_GLUED).toBe(9);
  });

  it("leaves every dash-separated reading on its ADAAAA-8134 selection", () => {
    expect(parseOcrScoreLine(["19-41 RMA-2-1 BAR"])).toEqual([2, 1]);
    expect(parseOcrScoreLine(["19-41 RMA 1-1 BAR"])).toEqual([1, 1]);
    expect(parseOcrScoreLine(["18:01 RMA 1-1 BAR"])).toEqual([1, 1]);
    expect(parseOcrScoreLine(["18:13 |RMA2-1 BAR"])).toEqual([2, 1]);
    expect(parseOcrScoreLine(["20.02 RHA 2-1 BAR"])).toEqual([2, 1]);
    expect(parseOcrScoreLine(["2 - 1"])).toEqual([2, 1]);
    expect(parseOcrScoreLine(["18:13"])).toBeNull();
  });

  it("AC1: >= 95 % of the job's 1450 glued readings parse; 100 % of clock-likes stay null", () => {
    let reads = 0;
    let parsed = 0;
    const states = new Set<string>();
    for (const { ocr, reads: n } of FIXTURE.strings) {
      reads += n;
      const p = parseOcrScoreLine([ocr]);
      if (p) {
        parsed += n;
        states.add(`${p[0]}-${p[1]}`);
      }
    }
    expect(reads).toBe(1450);
    expect(parsed / reads).toBeGreaterThanOrEqual(0.95);
    // The stored job only ever displayed 1-0 / 1-1 / 1-2: any other state would
    // be a phantom injected into the window's timeline.
    expect([...states].sort()).toEqual(["1-0", "1-1", "1-2"]);
    // eslint-disable-next-line no-console -- the AC asks for the measured rates
    console.log(`ADAAAA-8189 AC1 parse rate: ${parsed}/${reads} = ${((100 * parsed) / reads).toFixed(2)}%`);
    for (const clock of ["36:54", "17:22", "27:067", "12:07", "0:00"]) {
      expect(parseOcrScoreLine([clock])).toBeNull();
    }
  });
});

describe("stored-timeline replay (ADAAAA-8189 AC2/AC3)", () => {
  it("AC2: the steady windows carry >= 2 score reads (pre-fix: 0)", () => {
    for (const w of [W_STEADY_1, W_STEP_1, W_STEADY_2, W_STEP_2, W_AFTER_2]) {
      expect(scoreReadingsFromTimeline(timeline(w)).length).toBeGreaterThanOrEqual(2);
    }
    expect(scoreReadingsFromTimeline(timeline(W_STEADY_1)).every((r) => r.score[0] === 1 && r.score[1] === 0)).toBe(true);
    expect(scoreReadingsFromTimeline(timeline(W_AFTER_2)).every((r) => r.score[0] === 1 && r.score[1] === 2)).toBe(true);
  });

  it("AC2: the 1-0 -> 1-1 step at content ~1136 s derives as a legible delta", () => {
    const obs = timeline(W_STEP_1);
    const delta = scoreboardDeltaFromReadings(scoreReadingsFromTimeline(obs), windowOf(obs));
    expect(delta).toBeDefined();
    expect(delta!.pre).toEqual([1, 0]);
    expect(delta!.post).toEqual([1, 1]);
    expect(delta!.deltaTs).toBeCloseTo(T1, 2);
    expect(delta!.preSamples).toBeGreaterThanOrEqual(SCOREBOARD_MIN_CONSISTENT_READS);
    expect(delta!.postSamples).toBeGreaterThanOrEqual(SCOREBOARD_MIN_CONSISTENT_READS);
  });

  it("AC2: the 1-1 -> 1-2 step at content ~2024.5 s is legible with the deferred lookahead", () => {
    const obs = timeline(W_STEP_2);
    const win = windowOf(obs);
    const readings = scoreReadingsFromTimeline(obs);
    // ADAAAA-8078's bar is unchanged: this window ends AT the transition and
    // carries ONE post read, so it cannot attest on its own.
    expect(readings.filter((r) => r.score[1] === 2)).toHaveLength(1);
    expect(scoreboardDeltaFromReadings(readings, win)).toBeUndefined();
    // The reads the run holds once the deferred lookahead has elapsed: the
    // window that closes just after the step.
    const ledger = [...readings, ...scoreReadingsFromTimeline(timeline(W_AFTER_2))].sort((a, b) => a.ts - b.ts);
    // At accept time the ledger stops at this window's own last read, so the
    // POST side has ONE read and both lanes refuse (ADAAAA-8078's bar intact).
    expect(scoreboardDeltaFromPooledReadings({ readings, window: win })).toBeUndefined();
    const deferred = scoreboardDeltaFromPooledReadings({
      readings: ledger,
      window: win,
      trailS: LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S,
      deltaRange: { lo: win.lo, hi: win.hi + LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S },
    });
    expect(deferred).toBeDefined();
    expect(deferred!.pre).toEqual([1, 1]);
    expect(deferred!.post).toEqual([1, 2]);
    expect(deferred!.deltaTs).toBeCloseTo(T2, 2);
  });

  it("AC3: a score-steady window reports no change and never attests", () => {
    for (const w of [W_STEADY_1, W_STEADY_2]) {
      const obs = timeline(w);
      expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(obs), windowOf(obs))).toBeUndefined();
      const att = deriveWindowAttestation({ centerTs: w.centre, frames: [], seeds: [], observations: obs, biasHints: [] });
      expect(att.scoreBoardChanged).toBeFalsy();
      expect(att.scoreBoardDelta).toBeUndefined();
    }
  });

  it("AC3: only the two real transitions attest — no phantom step from a clock", () => {
    // The drilled-in `1/0` vs `1-0` families must agree: the clock variants in
    // W_STEADY_1 (`20:57`) never contribute a reading of their own.
    const readings = scoreReadingsFromTimeline(timeline(W_STEADY_1));
    expect(readings).toHaveLength(7);
    expect(readings.every((r) => r.score[0] === 1 && r.score[1] === 0)).toBe(true);
    // And a two-goal jump can never be credited as one step.
    const jump = [read(1, [1, 0]), read(2, [1, 0]), read(3, [1, 2]), read(4, [1, 2])];
    expect(scoreboardDeltaFromReadings(jump, { lo: 1, hi: 4 })).toBeUndefined();
  });
});
