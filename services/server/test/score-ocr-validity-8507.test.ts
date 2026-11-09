// ADAAAA-8507: SCORE-OCR — the browser (customer) live share read the sponsor
// banner as the scoreboard.
//
// Regression source: job `c4d33a26` (browser share, 147 decide calls, 11.1 min,
// STATIC scorebug). The decide prompts' `- score:` line read `5-40` (x19),
// `53-1` (x18), `29-1` (x4), `9-40` (x3) — none a possible soccer score — and
// 79 of 147 windows carried `scoreboard score change observed: yes`. Every one
// of those claims came from broadcast chrome parsed as a score:
//
//   `LALIGA|0JALIGA05-40 AL1UberFC B`            -> (5,40)
//   `LALIGA|LALIGA09-40-1GIMODGIMOOG`            -> (9,40)
//   `LALIGAMootballnike.com/f|LALIGA02:28-1om…`  -> (28,1)   clock `02:28` + `-1`
//   `…|ALB 04:53-1NEWALBUM-0 NE`                 -> (53,1)   clock `04:53` + `-1`
//
// The fix is a read-validity gate (AC1), the +1-to-one-side delta rule for a
// hint-carried delta (AC2), and an honesty rule on the live rail: a hint's
// `scoreBoardChanged` is a CLAIM, so only accepted reads may carry it (AC3).
// The census runs over the STORED audits of `c4d33a26` at $0, and the rtmp/file
// leg `ec4c3e0e` (whose GOAL row is `2/2 post samples, scoreReads 13`) is
// replayed through the same gate as the no-regression control (AC4).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  deriveWindowAttestation,
  ocrScorePairIsNoise,
  parseOcrScoreLine,
  scoreReadDiagnostics,
  scoreReadingsFromTimeline,
  scoreboardDeltaFromPooledReadings,
  scoreboardDeltaFromReadings,
  scoreboardDeltaSingleGoalStep,
} from "../src/analyzer.js";

type StoredWindow = {
  gk: string;
  sbStored: "yes" | "no";
  scoreStored: string | null;
  observations: { ts: number; ocr: string[] }[];
};
const load = (file: string): { job: string; windows: StoredWindow[] } =>
  JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"));

const BROWSER = load("8507-c4d33a26-windows.json");
const RTMP = load("8507-ec4c3e0e-windows.json");

/** ADAAAA-8507: the judged span a stored window covers. The audits persist the
 * timeline's offsets (t from the window centre) and the frame COUNT, not the
 * frame instants, so the observation span is the replay's window — the same
 * offsets the derivation runs on, so no transition can move in or out of it. */
const windowOf = (w: StoredWindow): { lo: number; hi: number } => {
  const ts = w.observations.map((o) => o.ts).filter((n) => Number.isFinite(n));
  if (!ts.length) return { lo: 0, hi: 0 };
  return { lo: Math.min(...ts), hi: Math.max(...ts) };
};

const replay = (
  w: StoredWindow,
  hints: { scoreBoardChanged?: boolean }[] = []
): ReturnType<typeof deriveWindowAttestation> => {
  const win = windowOf(w);
  return deriveWindowAttestation({
    centerTs: (win.lo + win.hi) / 2,
    frames: [{ ts: win.lo }, { ts: win.hi }],
    observations: w.observations,
    biasHints: hints as never,
  });
};

// The exact strings the stored prompts of `c4d33a26` carried. Printed by the
// browser share's crop next to each garbage score.
const GARBAGE = {
  "5-40": "LALIGA|0JALIGA05-40 AL1UberFC B",
  "53-1": "LALIGANEWALBUMNEW ALBUM|ALB 04:53-1NEWALBUM-0 NE",
  "29-1": "BIMDOBIMDLALIGA|LALIGA03:29-1at a Spotif",
  "9-40": "LALIGA|LALIGA09-40-1GIMODGIMOOG",
  // the same clock / chrome classes, measured on the same job:
  "28-1": "LALIGAMootballnike.com/f|LALIGA02:28-1om/football",
  "15-0": "LALIGACcomiglow GLOW Fre|0LALIGA04:15-0LOW-free-t",
  "30-1": "LALIGA|LALIGA00:30-1STRELLI28%4",
  "8-10": "LALIGALALIGASTANLEYSTANL|EY08-10 AM1STANLEYSTANLE",
} as const;

describe("AC1 — a score read is a score-plate token, not a clock or chrome", () => {
  it("rejects every garbage score the stored browser-share prompts carried", () => {
    for (const [score, line] of Object.entries(GARBAGE)) {
      expect(parseOcrScoreLine([line]), `${score} from ${line}`).toBeNull();
    }
  });

  it("rejects them inside a mixed line list, and contributes no reading", () => {
    const lines = ["LALIGA", ...Object.values(GARBAGE), "whitebitwhitebitLALIGA"];
    expect(parseOcrScoreLine(lines)).toBeNull();
    expect(scoreReadingsFromTimeline([
      { ts: 0, ocr: lines.slice(0, 3) },
      { ts: 1, ocr: lines.slice(3) },
    ])).toEqual([]);
  });

  it("keeps the ADAAAA-8459 legible series (1-1 / 2-1 / 2-2)", () => {
    expect(parseOcrScoreLine(["RMA 1-1 BAR"])).toEqual([1, 1]);
    expect(parseOcrScoreLine(["RMA 2-1 BAR"])).toEqual([2, 1]);
    expect(parseOcrScoreLine(["RMA 2-2 BAR"])).toEqual([2, 2]);
    expect(parseOcrScoreLine(["19-41 RMA-2-1 BAR"])).toEqual([2, 1]);
    expect(parseOcrScoreLine(["18:13 |RMA2-1 BAR"])).toEqual([2, 1]);
    expect(parseOcrScoreLine(["18:01 RMA 1-1 BAR"])).toEqual([1, 1]);
  });

  it("keeps a double-digit basketball plate (no leading zero) legible", () => {
    expect(parseOcrScoreLine(["45-42"])).toEqual([45, 42]);
    expect(parseOcrScoreLine(["Q3 45-42"])).toEqual([45, 42]);
  });

  it("keeps a real LaLiga scorebug pair even when the line carries the sponsor", () => {
    // The pair is sandwiched between the two team tokens: it is a plate, not
    // chrome, so the chrome rule must not throw it away.
    expect(parseOcrScoreLine(["LALIGA RMA 1-1 BAR"])).toEqual([1, 1]);
  });

  it("exposes the shape verdict itself (single source for parse + census)", () => {
    // clock-glued: `02:28-1`
    expect(ocrScorePairIsNoise("LALIGA02:28-1om", "28", "1", 8, 4, { left: false, right: true })).toBe(true);
    // clock-shaped: `05-40` = 05:40
    expect(ocrScorePairIsNoise("JALIGA05-40 AL1", "05", "40", 6, 5, { left: false, right: true })).toBe(true);
    // a real plate is not noise, chrome line or not
    expect(ocrScorePairIsNoise("LALIGA RMA 1-1 BAR", "1", "1", 12, 3, { left: true, right: true })).toBe(false);
  });
});

describe("AC2 — a soccer delta is +1 to exactly one side; the stored census falls to <= 3", () => {
  it("a static scorebug window (chrome-only reads) yields no transition", () => {
    const w = BROWSER.windows.find((x) => x.gk === "g21");
    expect(w).toBeTruthy();
    expect(replay(w!, [])).toMatchObject({ scoreBoardChanged: undefined });
  });

  it("replays the 147 stored windows: no derived score change anywhere", () => {
    const derived = BROWSER.windows.map((w) => replay(w, []));
    const changed = derived.filter((a) => a.scoreBoardChanged === true);
    expect(changed, `stored sb_yes was ${BROWSER.windows.filter((w) => w.sbStored === "yes").length}`).toEqual([]);
  });

  it("refuses a non-single-step delta (a jump is noise, not a transition)", () => {
    const readings = [
      ...Array.from({ length: 3 }, (_, i) => ({ ts: i, score: [1, 1] as [number, number] })),
      ...Array.from({ length: 3 }, (_, i) => ({ ts: 3 + i, score: [3, 1] as [number, number] })),
    ];
    expect(scoreboardDeltaFromReadings(readings, { lo: 0, hi: 6 })).toBeUndefined();
    expect(
      scoreboardDeltaSingleGoalStep({ pre: [1, 1], post: [3, 1], preTs: 0, postTs: 1, deltaTs: 1, preSamples: 2, postSamples: 2 })
    ).toBe(false);
  });

  it("still credits a genuine one-goal step from accepted reads", () => {
    const readings = [
      ...Array.from({ length: 3 }, (_, i) => ({ ts: i, score: [1, 1] as [number, number] })),
      ...Array.from({ length: 3 }, (_, i) => ({ ts: 3 + i, score: [2, 1] as [number, number] })),
    ];
    const delta = scoreboardDeltaFromReadings(readings, { lo: 0, hi: 6 });
    expect(delta).toMatchObject({ pre: [1, 1], post: [2, 1], postSamples: 3 });
  });
});

describe("AC3 — attestation honesty: only accepted reads may claim a score change", () => {
  it("drops a bare perceive hint on a static-scorebug window", () => {
    const w = BROWSER.windows.find((x) => x.sbStored === "yes")!;
    expect(w).toBeTruthy();
    const att = replay(w, [{ scoreBoardChanged: true }]);
    expect(att.scoreBoardChanged).toBeUndefined();
    expect(att.scoreBoardDelta).toBeUndefined();
  });

  it("replays the stored 79 'yes' windows: none keeps the claim without reads", () => {
    const yes = BROWSER.windows.filter((w) => w.sbStored === "yes");
    expect(yes.length).toBe(79);
    const kept = yes.filter((w) => replay(w, [{ scoreBoardChanged: true }]).scoreBoardChanged === true);
    expect(kept).toEqual([]);
  });

  it("never prints scoreBoardChanged:true with postSamples:0 over the whole job", () => {
    for (const w of BROWSER.windows) {
      const att = replay(w, w.sbStored === "yes" ? [{ scoreBoardChanged: true }] : []);
      if (att.scoreBoardChanged === true) {
        expect(att.scoreBoardDelta?.postSamples ?? 0).toBeGreaterThanOrEqual(2);
        expect(att.scoreBoardDelta?.preSamples ?? 0).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe("AC4 — no regression on the rtmp/file leg ec4c3e0e", () => {
  /** The stored GOAL row (`1e56d981`): scoring_play, `localizedTs: 123`, and
   * `attestationUsed {scoreBoardChanged:true, scoreReads:13, preSamples:6,
   * postSamples:2, need:2}`. The row was accepted by the `g41` window
   * (`decideGroupKey(123) === "g41"`), and 6/2 are exactly the contiguous
   * sample counts that window's own timeline carries. */
  const goalWindow = RTMP.windows.find((w) => w.gk === "g41")!;

  it("replays the accepting window: the 2-1 -> 2-2 GOAL is still credited", () => {
    expect(goalWindow).toBeTruthy();
    const att = replay(goalWindow, [{ scoreBoardChanged: true }]);
    expect(att.scoreBoardChanged).toBe(true);
    expect(att.scoreBoardDelta).toMatchObject({ pre: [2, 1], post: [2, 2] });
    expect(scoreboardDeltaSingleGoalStep(att.scoreBoardDelta)).toBe(true);
  });

  it("reproduces the GOAL row's 2/2 post samples (and 6 pre samples)", () => {
    const att = replay(goalWindow, [{ scoreBoardChanged: true }]);
    expect(att.scoreBoardDelta).toMatchObject({ preSamples: 6, postSamples: 2 });
    expect(att.scoreAttestationSource).toBeTruthy();
  });

  it("does not turn the leg's steady windows into score changes", () => {
    const steady = RTMP.windows.filter((w) => {
      const states = new Set(scoreReadingsFromTimeline(w.observations).map((r) => `${r.score[0]}-${r.score[1]}`));
      return states.size === 1;
    });
    expect(steady.length).toBeGreaterThan(0);
    for (const w of steady) expect(replay(w, [{ scoreBoardChanged: true }]).scoreBoardChanged).toBeUndefined();
  });
});
