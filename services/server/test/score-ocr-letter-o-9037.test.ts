/**
 * ADAAAA-9037 — a score plate whose ZEROS the OCR rendered as letter `O`.
 *
 * Measured on the natural live Sky Sports share `771f42de` (artifact of
 * ADAAAA-9035): 354 of 11849 timeline records (3.0 %, 48 windows) carry a
 * plate like `O-O38:55` / `O-Osky Sports36.09main e`. `parseOcrScoreLine`
 * refuses a letter pair, correctly (a letter is not evidence), so those windows
 * carried ZERO score reads — including the four straddling the first goal
 * boundary, which is why the derive lane had no PRE side for that transition.
 *
 * The fix is one narrow predicate, `ocrLetterOScorePair`, mirrored by
 * `_letter_o_score_pair` in `services/perceive/app/scoreboard.py`: a letter-O
 * pair that is otherwise PLATE-SHAPED (the line carries a clock within
 * `OCR_LETTER_O_CLOCK_MAX_GAP` of the pair, and the pair is not sandwiched
 * between two team tokens) normalises to `(0, 0)` — and is used at the LOWEST
 * precedence, so a legible digit plate on any line still wins.
 *
 * This suite pins the three things the ticket asks for:
 *   1. the predicate + its precision refusals (the shared 8841 parity table
 *      carries the strings; the positive/negative controls are asserted here);
 *   2. precedence: the normalisation can only ADD a reading, never move one;
 *   3. the $0 replay of the stored boundary windows — the PRE side appears, and
 *      the transition itself still needs the SEPARATE glued-POST seam (`0-139:21`)
 *      that this ticket does not change.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OCR_LETTER_O_CLOCK_MAX_GAP,
  ocrLetterOScorePair,
  parseOcrScoreLine,
  scoreReadingsFromTimeline,
  scoreboardDeltaFromReadings,
  SCOREBOARD_MAX_CONFIRM_GAP_S,
} from "../src/analyzer.js";

type Window = { gk: string; created: string; observations: { ts: number; ocr: string[] }[] };
const BOUNDARY: { job: string; sport: string; windows: Window[] } = JSON.parse(
  readFileSync(new URL("./fixtures/9037-letter-o-boundary-windows.json", import.meta.url), "utf8")
);

const win = (gk: string): Window => {
  const w = BOUNDARY.windows.find((x) => x.gk === gk);
  if (!w) throw new Error(`fixture has no window ${gk}`);
  return w;
};
const reads = (gk: string) => scoreReadingsFromTimeline(win(gk).observations, BOUNDARY.sport);
const distinct = (gs: string[]) => [...new Set(gs.flatMap((g) => reads(g).map((r) => `${r.score[0]}-${r.score[1]}`)))];

describe("ADAAAA-9037 letter-O plate: the predicate", () => {
  it("normalises the measured plate forms to (0,0)", () => {
    for (const line of [
      "O-O38:55",
      "O-O39.02",
      "O-Osky Sports36.09main e",
      "O-Osky SPORTS37:51",
      "sky sportsALO-O38:40",
      "O-O-OPY SPORTS36:15|0-0O-OJAY SPORTS36:15BER",
    ]) {
      expect(ocrLetterOScorePair(line, "soccer"), line).toEqual([0, 0]);
    }
  });

  it("refuses a letter-O pair that is not plate-shaped (precision set)", () => {
    // no clock on the line => no plate
    expect(ocrLetterOScorePair("O-O", "soccer")).toBeUndefined();
    // between two team tokens => the O's are a NAME
    expect(ocrLetterOScorePair("RMA O-O BAR", "soccer")).toBeUndefined();
    expect(ocrLetterOScorePair("RMA O-O BAR 38:55", "soccer")).toBeUndefined();
    // clock too far away => an ad board, not a one-crop plate
    expect(ocrLetterOScorePair("O-O betway main event 36:09", "soccer")).toBeUndefined();
    expect(ocrLetterOScorePair("O-O" + " ".repeat(OCR_LETTER_O_CLOCK_MAX_GAP + 1) + "36:09", "soccer")).toBeUndefined();
    // the inherited chrome refusal still applies to the normalised pair
    expect(ocrLetterOScorePair("LALIGA|LALIGA O-O 09-40", "soccer")).toBeUndefined();
    // the measured separator-less shape stays unreadable
    expect(ocrLetterOScorePair("OALsky sportsmain eventL", "soccer")).toBeUndefined();
  });

  it("keeps the ticket's control set unchanged", () => {
    expect(parseOcrScoreLine(["1-1sky sports47:21main e"], "soccer")).toEqual([1, 1]);
    expect(parseOcrScoreLine(["0-1sky sports39.24main e"], "soccer")).toEqual([0, 1]);
    expect(parseOcrScoreLine(["RMA 1-1 BAR"], "soccer")).toEqual([1, 1]);
    expect(parseOcrScoreLine(["2-5 3-2FULLMATCHFINALVS"], "soccer")).toEqual([3, 2]);
  });
});

describe("ADAAAA-9037 letter-O plate: precedence", () => {
  it("never outranks a legible plate on another line, in either order", () => {
    const digit = "0-1sky sports39.24main e";
    expect(parseOcrScoreLine(["O-O39.02", digit], "soccer")).toEqual([0, 1]);
    expect(parseOcrScoreLine([digit, "O-O39.02"], "soccer")).toEqual([0, 1]);
    const oneOne = "1-1sky sports47:21main e";
    expect(parseOcrScoreLine(["O-O38:55", oneOne], "soccer")).toEqual([1, 1]);
  });

  it("never outranks a digit plate on the SAME line", () => {
    expect(parseOcrScoreLine(["O-Osky SPORTS35:36|0-1sky sports35:36EXCUE "], "soccer")).toEqual([0, 1]);
  });

  it("only adds a reading where the digit lane found none", () => {
    // the same line with the letter-O glyphs read as digits is untouched
    expect(parseOcrScoreLine(["0-0sky sports36.09main e"], "soccer")).toEqual([0, 0]);
    // ...and the letter form reaches the same verdict
    expect(parseOcrScoreLine(["O-O36.09sky sportsmain e"], "soccer")).toEqual([0, 0]);
  });
});

describe("ADAAAA-9037 letter-O plate: $0 replay of the stored boundary windows", () => {
  it("restores the PRE side of the first goal boundary", () => {
    // 0 reads each at 5455d64 — the only plate lines in these five windows are
    // the letter-O form; every read now present is (0,0).
    for (const gk of ["g79", "g79:call2", "g81", "g82", "g83"]) {
      expect(reads(gk).length, gk).toBeGreaterThan(0);
      expect(distinct([gk]), gk).toEqual(["0-0"]);
    }
    expect([reads("g81").length, reads("g82").length, reads("g83").length]).toEqual([13, 9, 3]);
  });

  it("keeps the POST side identical (the fix adds no POST read)", () => {
    for (const gk of ["g85", "g86", "g87"]) expect(distinct([gk]), gk).toEqual(["0-1"]);
    expect([reads("g85").length, reads("g86").length, reads("g87").length]).toEqual([2, 6, 13]);
  });

  it("names the seam that still blocks the transition: the glued POST plate", () => {
    // g84 owns the boundary and carries `sky sports0-139:21`: the POST plate
    // `0-1` glued to its own clock `39:21`, which the digit lane reads as ONE
    // pair `0-139` and refuses (>99 per side). That is a separate ticket.
    const g84Lines = [...new Set(win("g84").observations.flatMap((o) => o.ocr))];
    expect(g84Lines).toContain("sky sports0-139:21");
    expect(parseOcrScoreLine(["sky sports0-139:21"], BOUNDARY.sport)).toBeNull();
    expect(reads("g84")).toHaveLength(0);
  });

  it("derives the boundary over the pooled read span, and the shipped gap is the only clause that refuses it", () => {
    // Rebuild the run's pooled ledger from the stored windows: one reading per
    // content frame, absolute instant = window created + observation ts.
    const pooled = new Map<number, [number, number]>();
    for (const w of BOUNDARY.windows) {
      const base = Date.parse(w.created) / 1000;
      for (const o of w.observations) {
        const p = parseOcrScoreLine(o.ocr, BOUNDARY.sport);
        if (!p) continue;
        const abs = Math.round((base + o.ts) * 1000) / 1000;
        if (!pooled.has(abs)) pooled.set(abs, p);
      }
    }
    const series = [...pooled.entries()].sort((a, b) => a[0] - b[0]).map(([ts, score]) => ({ ts, score }));
    const lo = Date.parse("2026-11-14T14:10:05.000Z") / 1000;
    const hi = Date.parse("2026-11-14T14:10:40.000Z") / 1000;
    const span = series.filter((r) => r.ts >= lo - 12 && r.ts <= hi + 20);

    // The PRE side is real and contiguous: the last PRE read is measured, and
    // without the fix there is none at all.
    const pre = span.filter((r) => r.score[0] === 0 && r.score[1] === 0);
    expect(pre.length).toBeGreaterThanOrEqual(10);
    const lastPre = pre[pre.length - 1].ts;
    expect(new Date(lastPre * 1000).toISOString().slice(11, 23)).toBe("14:10:13.561");

    // Shipped bar: no derive, because the plate is occluded for 13.65 s across
    // the goal wipe and the clause measures PRE read -> transition.
    const shownGap = span.find((r) => r.score[0] === 0 && r.score[1] === 1)!;
    expect((shownGap.ts - lastPre).toFixed(3)).toBe("13.650");
    expect(shownGap.ts - lastPre).toBeGreaterThan(SCOREBOARD_MAX_CONFIRM_GAP_S);
    expect(scoreboardDeltaFromReadings(span, { lo, hi }, { minSamples: 2 })).toBeUndefined();

    // Every OTHER clause passes: with the confirm gap widened the same stored
    // bytes attest one forward single-goal step.
    const wide = scoreboardDeltaFromReadings(span, { lo, hi }, { minSamples: 2, maxConfirmGapS: 30 });
    expect(wide).toBeDefined();
    expect(wide!.pre).toEqual([0, 0]);
    expect(wide!.post).toEqual([0, 1]);
    expect(wide!.preSamples).toBeGreaterThanOrEqual(2);
    expect(wide!.postSamples).toBeGreaterThanOrEqual(2);
  });
});
