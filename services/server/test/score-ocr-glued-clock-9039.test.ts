/**
 * ADAAAA-9039 — a score plate GLUED to its own clock reads as one pair.
 *
 * Measured on the natural live Sky Sports share `771f42de` (artifact of
 * ADAAAA-9035): the window that owns the FIRST goal boundary (`g84`, created
 * 14:10:24.455) carries `sky sports0-139:21` — the POST plate `0-1` immediately
 * followed by its clock `39:21`. `OCR_SCORE_PAIR_RE` reads the whole run as one
 * pair `(0,139)`, `parseOcrScoreLine` refuses it on the per-side `<= 99` bar, so
 * `g84` carried ZERO score reads and the derive lane had no POST side: the
 * transition could only be attested 13.650 s after the last PRE read, past the
 * shipped `SCOREBOARD_MAX_CONFIRM_GAP_S = 10`.
 *
 * The fix is one narrow, mirrored predicate — `ocrGluedClockScorePair` here and
 * `_glued_clock_score_pair` in `services/perceive/app/scoreboard.py` — with the
 * shared table `8841-ocr-parity-table.json` pinning both layers. This suite
 * covers:
 *   1. the predicate and its precision refusals (sport scope, zero-run,
 *      one-digit-minute ambiguity, mid-run, no clock);
 *   2. precedence — it can only ADD a reading, never move or outrank one;
 *   3. the $0 replay over the STORED boundary windows: the POST side appears at
 *      the measured glued frame and the boundary derives ONE transition at the
 *      shipped 10 s bar, with the same stored bytes still refusing without it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ocrGluedClockScorePair,
  parseOcrScoreLine,
  SCOREBOARD_MAX_CONFIRM_GAP_S,
  scoreboardDeltaFromReadings,
  scoreReadingsFromTimeline,
} from "../src/analyzer.js";

type Window = { gk: string; created: string; observations: { ts: number; ocr: string[] }[] };
const BOUNDARY: { job: string; sport: string; windows: Window[] } = JSON.parse(
  readFileSync(new URL("./fixtures/9037-letter-o-boundary-windows.json", import.meta.url), "utf8")
);

type SharedCase = { line: string; sport: string | null; expected: [number, number] | null; why: string };
const TABLE: { cases: SharedCase[] } = JSON.parse(
  readFileSync(new URL("./fixtures/8841-ocr-parity-table.json", import.meta.url), "utf8")
) as { cases: SharedCase[] };

const win = (gk: string): Window => {
  const w = BOUNDARY.windows.find((x) => x.gk === gk);
  if (!w) throw new Error(`fixture has no window ${gk}`);
  return w;
};
const reads = (gk: string) => scoreReadingsFromTimeline(win(gk).observations, BOUNDARY.sport);
const distinct = (gk: string) => [...new Set(reads(gk).map((r) => `${r.score[0]}-${r.score[1]}`))];

/** The plate-glued-to-clock shape, exactly as the predicate keys it. */
const GLUED = /(?<![\d\-–—])(\d)(\s*[-–—]\s*)([1-9])(\d{2}):([0-5]\d)(?!\d)/;

describe("ADAAAA-9039 glued plate-and-clock: the predicate", () => {
  it("reads the measured glued forms as the plate they carry", () => {
    expect(ocrGluedClockScorePair("sky sports0-139:21", "soccer")).toEqual([0, 1]);
    expect(ocrGluedClockScorePair("0-142:15ELIN", "soccer")).toEqual([0, 1]);
    expect(ocrGluedClockScorePair("0-142:31PENDERSSKIN30", "soccer")).toEqual([0, 1]);
    expect(ocrGluedClockScorePair("sky sports1-149:36PREDAT", "soccer")).toEqual([1, 1]);
    expect(ocrGluedClockScorePair("0-164:16arabao", "soccer")).toEqual([0, 1]);
  });

  it("agrees with the full line parse (the table's measured rows)", () => {
    expect(parseOcrScoreLine(["sky sports0-139:21"], "soccer")).toEqual([0, 1]);
    expect(parseOcrScoreLine(["0-142:31PENDERSSKIN30"], "soccer")).toEqual([0, 1]);
    expect(parseOcrScoreLine(["sky sports1-149:36PREDAT"], "soccer")).toEqual([1, 1]);
  });

  it("is SPORT-SCOPED: a sport that can print two-digit plates keeps today's verdict", () => {
    for (const sport of ["basketball", "american football", undefined]) {
      expect(ocrGluedClockScorePair("sky sports0-139:21", sport), String(sport)).toBeUndefined();
      expect(parseOcrScoreLine(["sky sports0-139:21"], sport), String(sport)).toBeNull();
    }
    // the pinned two-digit pairs are untouched by this rule
    expect(parseOcrScoreLine(["45-42"], "basketball")).toEqual([45, 42]);
    expect(parseOcrScoreLine(["24-17"], "american football")).toEqual([24, 17]);
    expect(parseOcrScoreLine(["45-42"], "soccer")).toBeNull();
  });

  it("refuses the ambiguous families (fail closed, no invented score)", () => {
    // no clock on the line: the run is not a plate-and-clock pair
    expect(ocrGluedClockScorePair("0-139", "soccer")).toBeUndefined();
    expect(parseOcrScoreLine(["0-139"], "soccer")).toBeNull();
    // zero-run: B=0 is indistinguishable from the clock's own leading zero
    expect(ocrGluedClockScorePair("0-038:37", "soccer")).toBeUndefined();
    expect(parseOcrScoreLine(["0-038:37"], "soccer")).toBeNull();
    expect(parseOcrScoreLine(["0-019:57"], "soccer")).toBeNull();
    expect(parseOcrScoreLine(["0-01951"], "soccer")).toBeNull();
    // one-digit-minute run: the same characters are a lost plate digit plus a
    // plausible clock (`rea1-50:22` = plate `1-` + clock `50:22`, measured at
    // 14:26 where the true plate is `1-1`, so `1-5` would flap)
    expect(ocrGluedClockScorePair("rea1-50:22", "soccer")).toBeUndefined();
    expect(parseOcrScoreLine(["rea1-50:22"], "soccer")).toBeNull();
    expect(parseOcrScoreLine(["1-71:57G Google GerminGe"], "soccer")).toBeNull();
    // mid-run: a legible plate in front of an ad clock is never re-sliced
    expect(ocrGluedClockScorePair("1-1-148:51-3 MINSLIVE", "soccer")).toBeUndefined();
    expect(parseOcrScoreLine(["1-1-148:51-3 MINSLIVE"], "soccer")).toEqual([1, 1]);
  });

  it("keeps the ticket's control set unchanged", () => {
    expect(parseOcrScoreLine(["RMA 1-1 BAR"], "soccer")).toEqual([1, 1]);
    expect(parseOcrScoreLine(["2-5 3-2FULLMATCHFINALVS"], "soccer")).toEqual([3, 2]);
    expect(parseOcrScoreLine(["0-01951"], "soccer")).toBeNull();
    expect(parseOcrScoreLine(["24-35"], "soccer")).toBeNull();
    expect(parseOcrScoreLine(["1-1sky soccer45:11LIVE3"], "soccer")).toEqual([1, 1]);
  });
});

describe("ADAAAA-9039 glued plate-and-clock: precedence", () => {
  it("never outranks a legible digit plate on another line, in either order", () => {
    const digit = "1-1sky sports47:21main e";
    expect(parseOcrScoreLine(["sky sports0-139:21", digit], "soccer")).toEqual([1, 1]);
    expect(parseOcrScoreLine([digit, "sky sports0-139:21"], "soccer")).toEqual([1, 1]);
  });

  it("never outranks a legible digit plate on the SAME line", () => {
    expect(parseOcrScoreLine(["0-1sky sports39.24main e|sky sports0-139:21"], "soccer")).toEqual([0, 1]);
    expect(parseOcrScoreLine(["1-1sky sports49:36PREDATsky sports1-149:36PREDAT"], "soccer")).toEqual([1, 1]);
  });

  it("outranks the letter-O glyph lane (real digits are stronger evidence)", () => {
    const glyph = "O-O39.02";
    expect(parseOcrScoreLine([glyph, "sky sports0-139:21"], "soccer")).toEqual([0, 1]);
    expect(parseOcrScoreLine(["sky sports0-139:21", glyph], "soccer")).toEqual([0, 1]);
  });
});

describe("ADAAAA-9039 glued plate-and-clock: shared parity table", () => {
  it("carries the measured family in the table both layers read", () => {
    const rows = TABLE.cases.filter((c) => GLUED.test(c.line));
    // four sport variants of the measured line + two other measured plates
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const lines = TABLE.cases.map((c) => c.line);
    for (const refused of ["0-038:37", "rea1-50:22", "1-71:57G Google GerminGe", "1-1-148:51-3 MINSLIVE"]) {
      expect(lines).toContain(refused);
    }
    expect(rows.some((c) => c.line === "sky sports0-139:21" && c.sport === "soccer" && c.expected?.[0] === 0 && c.expected?.[1] === 1)).toBe(true);
    for (const c of rows) {
      expect(parseOcrScoreLine([c.line], c.sport ?? undefined), `${c.line}|${c.sport}`).toEqual(c.expected);
    }
  });
});

describe("ADAAAA-9039 glued plate-and-clock: $0 replay of the stored boundary windows", () => {
  it("gives window g84 (which owns the boundary) its POST reads at the measured frames", () => {
    expect(reads("g84")).toHaveLength(2);
    expect(distinct("g84")).toEqual(["0-1"]);
    // ...and the reads come from the glued line alone: strip it and the window is
    // back to the 0 reads the baseline carried.
    const stripped = win("g84").observations.map((o) => ({ ts: o.ts, ocr: (o.ocr ?? []).filter((l) => !GLUED.test(l)) }));
    expect(scoreReadingsFromTimeline(stripped, BOUNDARY.sport)).toHaveLength(0);
    // the neighbouring POST windows keep reading the same plate
    for (const gk of ["g85", "g86", "g87"]) expect(distinct(gk), gk).toEqual(["0-1"]);
  });

  it("derives ONE transition at the shipped 10 s bar (no bar change)", () => {
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

    // SHIPPED constants only: no maxConfirmGapS / minSamples override.
    const derived = scoreboardDeltaFromReadings(span, { lo, hi }, { minSamples: 2 });
    expect(derived).toBeDefined();
    expect(derived!.pre).toEqual([0, 0]);
    expect(derived!.post).toEqual([0, 1]);
    expect(derived!.preSamples).toBeGreaterThanOrEqual(2);
    expect(derived!.postSamples).toBeGreaterThanOrEqual(2);
    expect(new Date(derived!.deltaTs * 1000).toISOString().slice(11, 23)).toBe("14:10:23.455");

    // the PRE side is the measured one ADAAAA-9037 restored
    const pre = span.filter((r) => r.score[0] === 0 && r.score[1] === 0);
    const lastPre = pre[pre.length - 1].ts;
    expect(new Date(lastPre * 1000).toISOString().slice(11, 23)).toBe("14:10:13.561");

    // the first POST read is the glued frame, and it sits INSIDE the shipped bar
    const firstPost = span.find((r) => r.score[0] === 0 && r.score[1] === 1)!;
    expect(new Date(firstPost.ts * 1000).toISOString().slice(11, 23)).toBe("14:10:23.455");
    expect(firstPost.ts - lastPre).toBeLessThanOrEqual(SCOREBOARD_MAX_CONFIRM_GAP_S);
    expect(+(firstPost.ts - lastPre).toFixed(3)).toBe(9.894);
  });

  it("the same stored bytes still refuse without the normalisation (before/after)", () => {
    // Drop only the glued lines: that is the baseline lane's input, and its first
    // POST read is 3.756 s later, past the shipped bar.
    const pooled = new Map<number, [number, number]>();
    for (const w of BOUNDARY.windows) {
      const base = Date.parse(w.created) / 1000;
      for (const o of w.observations) {
        const p = parseOcrScoreLine((o.ocr ?? []).filter((l) => !GLUED.test(l)), BOUNDARY.sport);
        if (!p) continue;
        const abs = Math.round((base + o.ts) * 1000) / 1000;
        if (!pooled.has(abs)) pooled.set(abs, p);
      }
    }
    const series = [...pooled.entries()].sort((a, b) => a[0] - b[0]).map(([ts, score]) => ({ ts, score }));
    const lo = Date.parse("2026-11-14T14:10:05.000Z") / 1000;
    const hi = Date.parse("2026-11-14T14:10:40.000Z") / 1000;
    const span = series.filter((r) => r.ts >= lo - 12 && r.ts <= hi + 20);
    const lastPre = span.filter((r) => r.score[0] === 0 && r.score[1] === 0).pop()!;
    const firstPost = span.find((r) => r.score[0] === 0 && r.score[1] === 1)!;
    expect(new Date(firstPost.ts * 1000).toISOString().slice(11, 23)).toBe("14:10:27.211");
    expect(+(firstPost.ts - lastPre.ts).toFixed(3)).toBe(13.65);
    expect(scoreboardDeltaFromReadings(span, { lo, hi }, { minSamples: 2 })).toBeUndefined();
  });
});
