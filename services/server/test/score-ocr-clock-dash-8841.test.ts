/**
 * ADAAAA-8841 — a `mm:ss` clock whose colon OCR'd as a dash is not a score.
 *
 * The pre-8841 gate refused the clock shape only when the LEFT group was a
 * two-character `0\d` (`05-40`, `09-40`), a rule fitted to an early-match
 * sample. Minutes >= 10 (`24-35`) and minute-0 clocks whose seconds field
 * reached the pair as `0-019` / `0-034` therefore passed the gate and became the
 * window's score reading. On the live Sky Sports share `1ee3c97d` (617 windows,
 * 72 stored `sb_yes`) that attested two PHANTOM goals that were pure clock ticks
 * (`0-19 -> 0-20`, `0-33 -> 0-34`): a forward +1 on exactly one side, which the
 * 8507 delta sanity cannot refuse.
 *
 * The fix is one predicate in both layers (`ocrScorePairIsNoise` /
 * `_pair_is_noise`), with three keys this suite pins:
 *  (a) a zero-padded group is never a plate;
 *  (b) a sport whose plate cannot reach two digits (football) refuses any pair
 *      with a two-digit side — the ceiling stays sport-scoped, so `45-42` stays
 *      legible for basketball and for an unknown sport;
 *  (c) a pair equal to the clock the SAME line carries is refused (GT-2).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  deriveWindowAttestation,
  ocrScorePairIsNoise,
  parseOcrScoreLine,
  scoreReadingsFromTimeline,
} from "../src/analyzer.js";

type SharedCase = { line: string; sport: string | null; expected: [number, number] | null; why: string };

const TABLE: { cases: SharedCase[] } = JSON.parse(
  readFileSync(new URL("./fixtures/8841-ocr-parity-table.json", import.meta.url), "utf8")
) as { cases: SharedCase[] };

type Window = { gk: string; sbStored: string; observations: { ts: number; ocr: string[] }[] };
const JOB: { job: string; windows: Window[] } = JSON.parse(
  readFileSync(new URL("./fixtures/8841-1ee3c97d-windows.json", import.meta.url), "utf8")
);

/** AC2: how many OCR records on the job parse to a two-digit-side pair (the
 * clock-injection class), and how many lines in the job even carry that shape
 * (the positive control: the fixture is not an empty population). */
function injectionReads(
  windows: Window[],
  parse: (line: string, sport?: string) => [number, number] | null
): { records: number; distinct: string[] } {
  let records = 0;
  const distinct = new Set<string>();
  for (const w of windows) {
    for (const o of w.observations) {
      for (const line of o.ocr) {
        const p = parse(line);
        if (p && Math.max(p[0], p[1]) > 9) {
          records++;
          distinct.add(line.slice(0, 90));
        }
      }
    }
  }
  return { records, distinct: [...distinct] };
}

/** Lines that carry a dash pair with at least one two-digit side — the raw
 * injection CANDIDATE class, independent of any gate. */
function candidateLines(windows: Window[]): number {
  let n = 0;
  for (const w of windows) {
    for (const o of w.observations) {
      for (const line of o.ocr) {
        const re = /(\d{1,3})\s*[-–—]\s*(\d{1,3})/g;
        let m: RegExpExecArray | null;
        let hit = false;
        while ((m = re.exec(line)) !== null) {
          if (Number(m[1]) > 9 || Number(m[2]) > 9) hit = true;
        }
        if (hit) n++;
      }
    }
  }
  return n;
}

const windowScores = (windows: Window[], sport?: string) =>
  windows.map((w) => {
    const readings = scoreReadingsFromTimeline(w.observations, sport);
    return readings.length ? readings[readings.length - 1].score : null;
  });

const derivedChanges = (windows: Window[], sport?: string) => {
  const out: { gk: string; pre: string; post: string }[] = [];
  for (const w of windows) {
    const ts = w.observations.map((o) => o.ts).filter((n) => Number.isFinite(n));
    const att = deriveWindowAttestation({
      centerTs: (Math.min(...ts) + Math.max(...ts)) / 2,
      frames: [{ ts: Math.min(...ts) }, { ts: Math.max(...ts) }],
      observations: w.observations,
      biasHints: [],
      sport,
    });
    if (att.scoreBoardChanged === true) {
      out.push({
        gk: w.gk,
        pre: (att.scoreBoardDelta?.pre ?? []).join("-"),
        post: (att.scoreBoardDelta?.post ?? []).join("-"),
      });
    }
  }
  return out;
};

describe("ADAAAA-8841 AC1/F4 — the clock-dash shape is refused, the controls are not", () => {
  for (const { line, sport, expected, why } of TABLE.cases) {
    it(`${JSON.stringify(line)} [${sport ?? "unknown sport"}] -> ${JSON.stringify(expected)} — ${why}`, () => {
      expect(parseOcrScoreLine([line], sport ?? undefined)).toEqual(expected);
    });
  }

  it("AC1 seeds the four ticket strings as no-score under the football sport", () => {
    for (const line of ["24-35", "36-54", "RMA24-35 BAR"]) {
      expect(parseOcrScoreLine([line], "soccer")).toBeNull();
    }
  });

  it("F2 refuses a pair that IS the clock the same line carries, under any sport", () => {
    // sport-independent: the line itself names the clock.
    expect(parseOcrScoreLine(["24-35 24:35"], undefined)).toBeNull();
    expect(parseOcrScoreLine(["LAL 45-42 45:42"], "basketball")).toBeNull();
    // ...and keeps a plate that is NOT the clock.
    expect(parseOcrScoreLine(["45-42 Q3 12:00"], "basketball")).toEqual([45, 42]);
    expect(parseOcrScoreLine(["1-1 1:01"], undefined)).toEqual([1, 1]);
  });

  it("F3 keeps the ceiling sport-scoped: no lower global ceiling", () => {
    expect(parseOcrScoreLine(["45-42"], "basketball")).toEqual([45, 42]);
    expect(parseOcrScoreLine(["45-42"], undefined)).toEqual([45, 42]);
    expect(parseOcrScoreLine(["45-42"], "soccer")).toBeNull();
  });

  it("8507's chrome/glue rules still refuse their measured strings", () => {
    const text = "LALIGA|0JALIGA05-40 AL1UberFC B";
    expect(parseOcrScoreLine([text], "soccer")).toBeNull();
    expect(ocrScorePairIsNoise(text, "5", "40", 14, 4, { left: false, right: true }, "soccer")).toBe(true);
  });
});

describe("ADAAAA-8841 AC2/AC4 — the live job replay (job 1ee3c97d, 617 windows)", () => {
  const windows = JOB.windows;

  it("quotes the census population", () => {
    expect(JOB.job).toBe("1ee3c97d-6bed-40cf-86c3-905af5f84a00");
    expect(windows.length).toBe(617);
    expect(windows.filter((w) => w.sbStored === "yes").length).toBe(72);
  });

  it("AC2: clock-injection reads fall from the measured 931 to 0", () => {
    // Measured on the PRE-fix code (origin/master's analyzer, same fixture):
    // 931 OCR records parsed to a pair with a two-digit side, 47 distinct score
    // states, 572 windows carrying a read. Post-fix, with the job's sport:
    const after = injectionReads(windows, (line) => parseOcrScoreLine([line], "soccer"));
    expect(after.records).toBe(0);
    // positive control: the fixture really carries the injection class (931 of
    // these candidate lines were the measured class), so 0 is not an empty set.
    expect(candidateLines(windows)).toBeGreaterThan(500);
    expect(JSON.parse(readFileSync(new URL("./fixtures/8841-1ee3c97d-windows.json", import.meta.url), "utf8")).windows.length).toBe(617);
  });

  it("AC2: the score reads collapse to the four real states", () => {
    const states = new Set(windowScores(windows, "soccer").filter(Boolean).map((s) => s!.join("-")));
    expect([...states].sort()).toEqual(["0-0", "0-1", "1-1", "3-2"]);
    // the pre-fix code read 47 distinct states from the same 617 windows.
    expect(windowScores(windows, "soccer").filter(Boolean).length).toBeGreaterThan(500);
  });

  it("AC4: no window attests a change that is a clock tick — only the real goal survives", () => {
    // Pre-fix (measured): g65 (the real 0-0 -> 0-1 goal) + g401 / g686, whose
    // pairs were pure clock ticks (0-19 -> 0-20, 0-33 -> 0-34).
    const changes = derivedChanges(windows, "soccer");
    expect(changes).toEqual([{ gk: "g65", pre: "0-0", post: "0-1" }]);
    // sport-blind is the same list: the zero-pad and same-line-clock keys (a)/(c)
    // already kill the measured ticks, so the sport is an extra, not the only one.
    expect(derivedChanges(windows).map((c) => c.gk)).toEqual(["g65"]);
    for (const c of changes) {
      const pre = c.pre.split("-").map(Number);
      const post = c.post.split("-").map(Number);
      const clockTick = post[0] === pre[0] + 1 && post[1] <= pre[1];
      expect(clockTick, `${c.gk} ${c.pre} -> ${c.post}`).toBe(false);
    }
  });

  it("AC2: no real transition is lost — the 0-0 -> 0-1 goal is still attested", () => {
    const changes = derivedChanges(windows, "soccer");
    expect(changes.some((c) => c.gk === "g65" && c.pre === "0-0" && c.post === "0-1")).toBe(true);
    // the job's other real transition (0-1 -> 1-1) was never attested before the
    // fix either: no window carried both samples. Nothing to lose, nothing lost.
    const states = windowScores(windows, "soccer").filter(Boolean).map((s) => s!.join("-"));
    expect(states).toContain("0-1");
    expect(states).toContain("1-1");
  });
});

describe("ADAAAA-8841 AC3 — parity table shape", () => {
  it("carries at least 30 shared strings, including the measured families", () => {
    expect(TABLE.cases.length).toBeGreaterThanOrEqual(30);
    const lines = TABLE.cases.map((c) => c.line);
    for (const measured of ["24-35", "0-01951", "0-034.02GREATEST FANSTHE", "45-42"]) {
      expect(lines).toContain(measured);
    }
  });
});
