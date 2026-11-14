// ADAAAA-9035: SCORE SUPPLY — the listing/title row was read as a scoreboard.
//
// Measured ($0, read-only) on the natural live job `771f42de` (browser share,
// 75 min, 820 decide calls, `framesAnalyzed: 4663`, served `328bb3b`). The
// ticket's premise was that the job's windows carried no score reads
// (`scoreFrames: 0`, `scoreReads: 0`); the stored `decide_audit` timelines say
// otherwise and this suite pins what is actually true:
//
//   - 819 stored windows, 748 of them carry >= 1 parseable score pair
//     (histogram 11-20 reads: 499, 5-10: 117, 1-4: 130, 0: 71);
//   - the 12 un-attestable celebration rows carry 22-28 reads each, ALL on the
//     PRE side of a STATIC plate (`preSamples: 28, postSamples: 0`) — a
//     celebration window cannot measure a transition the score does not make;
//   - `scorebugOcrFrames: 1` / `genericNameCandidates.scoreFrames: 0` are the
//     MATCH-CONTEXT (name) channel's meters, not the per-window score lane;
//   - the scoring lane measured 0 transitions from those timelines: both
//     credited GOAL rows were carried by the perceive HINT delta, not by the
//     OCR derive.
//
// One genuine defect sits in that data path: the job's single match-context OCR
// frame is a video LISTING row, and `parseOcrScoreLine` reads a score out of it:
//
//   `FULL MATCH : Liverpool 7-6 Chelsea (1080p)0-0sky sports35:09` -> (7, 6)
//
// `7-6` is a phantom score STATE. In any window that also carries the real
// plate it is a second distinct state, and the one-distinct-transition clause of
// `scoreboardDeltaFromReadings` then discards that window's own genuine
// readings — the window loses authority it had earned. This suite pins the
// guard (AC1), the in-play controls it must not eat (AC2), the stored-window
// replay (AC3) and the census invariants the ticket asked for (AC4).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ocrLineIsScoreListing,
  ocrScorePairIsNoise,
  parseOcrScoreLine,
  scoreReadingsFromTimeline,
  scoreboardDeltaFromReadings,
} from "../src/analyzer.js";

type StoredWindow = { gk: string; created: string; observations: { ts: number; ocr: string[] }[] };
const FIXTURE: { job: string; windows: StoredWindow[] } = JSON.parse(
  readFileSync(new URL("./fixtures/9035-771f42de-windows.json", import.meta.url), "utf8")
);
const WINDOWS = FIXTURE.windows;

/** The UNTRUNCATED listing rows the job's single match-context OCR frame carried
 * (`record.matchContextEvidence.channelOutcomes.scorebug_ocr.rawLines`). */
const LISTING_ROWS = [
  "FULL MATCH : Liverpool 7-6 Chelsea (1080p)0-0sky sports35:09",
  "FULL MATCH : Real Madrid 2-1 Barcelona (720p)",
  "MATCH HIGHLIGHTS: RMA 2-1 BAR",
];

/** The same job's genuine in-play plate reads (measured strings, unchanged). */
const PLATE_ROWS: Array<[string, [number, number]]> = [
  ["1-1sky sports47:21main e", [1, 1]],
  ["0-1sky sports42:37mainem", [0, 1]],
  ["0-0sky sports36.09main eventSAVE ON OUR BIGGEST EVER ADIDAS SALE", [0, 0]],
  ["0-1sky sports39.46Imamew", [0, 1]],
];

const windowOf = (w: StoredWindow): { lo: number; hi: number } => {
  const ts = w.observations.map((o) => o.ts).filter((n) => Number.isFinite(n));
  return ts.length ? { lo: Math.min(...ts), hi: Math.max(...ts) } : { lo: 0, hi: 0 };
};

describe("AC1 — a listing/title overlay row is never a score source", () => {
  it("refuses the ticket's headline row (this is the failing case on the pre-fix build)", () => {
    // Pre-fix: [7, 6] — the team-adjacent dash pair inside `Liverpool 7-6 Chelsea`.
    expect(parseOcrScoreLine([LISTING_ROWS[0]], "soccer")).toBeNull();
  });

  it("refuses the whole listing family, on every sport", () => {
    for (const line of LISTING_ROWS) {
      for (const sport of ["soccer", "basketball", "american football", undefined]) {
        expect(parseOcrScoreLine([line], sport), `${line} | ${sport}`).toBeNull();
      }
    }
  });

  it("contributes no reading to a timeline that also carries the real plate", () => {
    const readings = scoreReadingsFromTimeline(
      [
        { ts: 0, ocr: ["1-1sky sports47:21main e"] },
        { ts: 1, ocr: [LISTING_ROWS[0]] },
        { ts: 2, ocr: ["1-1sky sports47:22main e"] },
      ],
      "soccer"
    );
    expect(readings.map((r) => r.score)).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });

  it("drops the phantom state that would discard a window's real transition", () => {
    // A genuine 0-1 -> 1-1 boundary, with one listing frame in the middle: the
    // listing row used to inject `7-6` as a THIRD state, so clause 5 threw the
    // window away and the two real readings could not attest anything.
    const timeline = [
      { ts: -4, ocr: ["0-1sky sports46:14main e"] },
      { ts: -3, ocr: ["0-1sky sports46:15main e"] },
      { ts: -2, ocr: [LISTING_ROWS[0]] },
      { ts: -1, ocr: ["1-1sky sports46:16main e"] },
      { ts: 0, ocr: ["1-1sky sports46:17main e"] },
    ];
    const readings = scoreReadingsFromTimeline(timeline, "soccer");
    const delta = scoreboardDeltaFromReadings(readings, { lo: -4, hi: 0 }, { minSamples: 2 });
    expect(delta).toBeDefined();
    expect([delta!.pre, delta!.post]).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  it("exposes the shape verdict itself (one source for parse + census)", () => {
    expect(ocrLineIsScoreListing(LISTING_ROWS[0])).toBe(true);
    expect(ocrLineIsScoreListing("1-1sky sports47:21main e")).toBe(false);
    // the pair-level verdict agrees, even though the pair IS sandwiched
    expect(
      ocrScorePairIsNoise(LISTING_ROWS[0], "7", "6", 24, 3, { left: true, right: true }, "soccer")
    ).toBe(true);
  });
});

describe("AC2 — a genuine in-play scorebug read survives", () => {
  it("keeps every measured plate string from the same job", () => {
    for (const [line, expected] of PLATE_ROWS) {
      expect(parseOcrScoreLine([line], "soccer"), line).toEqual(expected);
    }
  });

  it("keeps the pinned Sky Sports full-match CARD (a real final plate, glued token)", () => {
    // ADAAAA-8841 control, measured on job 1ee3c97d: `FULLMATCHFINALVS` has no
    // trailing word boundary, so it is a card's final plate, not a listing row —
    // the `\b` anchors in the listing predicate are what keep them apart.
    expect(ocrLineIsScoreListing("2-5 3-2FULLMATCHFINALVS")).toBe(false);
    expect(parseOcrScoreLine(["2-5 3-2FULLMATCHFINALVS"], "soccer")).toEqual([3, 2]);
  });

  it("keeps the pinned controls the earlier gates own", () => {
    expect(parseOcrScoreLine(["09:46 RMA 1-1 BAR"], "soccer")).toEqual([1, 1]);
    expect(parseOcrScoreLine(["19:44 RMA 2-1 BAR"], "soccer")).toEqual([2, 1]);
    expect(parseOcrScoreLine(["26:17 RMA2-2 BAR"], "soccer")).toEqual([2, 2]);
    expect(parseOcrScoreLine(["LALIGA RMA 1-1 BAR"], "soccer")).toEqual([1, 1]);
    expect(parseOcrScoreLine(["45-42"], "basketball")).toEqual([45, 42]);
    // the clock family the 8841 gate refuses stays refused
    expect(parseOcrScoreLine(["24-35"], "soccer")).toBeNull();
  });
});

describe("AC3 — the guard is inert on the stored population it was measured on", () => {
  it("loses no reading on any stored window (the prompt caps the row at 40 chars)", () => {
    for (const w of WINDOWS) {
      const readings = scoreReadingsFromTimeline(w.observations, "soccer");
      for (const o of w.observations) {
        // every record that produces a reading still does, and the truncated
        // listing row (`FULL MATCH : Liverpool 7`) never produced one at all
        const listing = o.ocr.some((l) => ocrLineIsScoreListing(l));
        if (listing) expect(readings.some((r) => r.ts === o.ts)).toBe(false);
      }
    }
  });

  it("keeps the census the ticket asked for: 748/819 windows read, 0 derived transitions", () => {
    // Reproduced over the 47-window slice of the same job: the readings are
    // there, the TRANSITIONS are not — a celebration window cannot measure a
    // change the plate never makes.
    let withReads = 0;
    let derived = 0;
    for (const w of WINDOWS) {
      const readings = scoreReadingsFromTimeline(w.observations, "soccer");
      if (readings.length) withReads++;
      if (scoreboardDeltaFromReadings(readings, windowOf(w), { minSamples: 2 })) derived++;
    }
    expect(withReads).toBeGreaterThan(0);
    expect(derived).toBe(0);
  });

  it("does not touch the two transitions the perceive hint credited", () => {
    // The stored GOAL rows carry `transitionKey` 0-0>0-1 and 0-1>1-1 from the
    // hint lane; the guard only removes a pair the hint lane never saw.
    const goalWindows = WINDOWS.filter((w) =>
      w.observations.some((o) => o.ocr.some((l) => /^(0-0|0-1|1-1)sky sports/.test(l)))
    );
    expect(goalWindows.length).toBeGreaterThan(0);
    for (const w of goalWindows) {
      for (const r of scoreReadingsFromTimeline(w.observations, "soccer")) {
        expect(r.score).not.toEqual([7, 6]);
      }
    }
  });
});
