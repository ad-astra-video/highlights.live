// ADAAAA-8071: the live scoring lane must credit a score transition the window's
// OWN perceive timeline displays.
//
// Regression source: pass 1 of ADAAAA-8052 on the 4-image media-rail leg (job
// `8024a341`, build `458e301`). The 100 s GT goal shipped as BIG_PLAY while the
// decide prompt for its window displayed the transition in its own timeline:
//
//   -10.0s ocr="18:01 RMA 1-1 BAR"
//   -6.8s  ocr="18.05 RMA 1-1 BARVITALDE"
//   -3.5s  ocr="18.05 RMA 1-1 BARVITALDE"
//   -3.2s  ocr="18:13 |RMA2-1 BAR"
//   -0.0s  ocr="18:13 |RMA2-1 BAR"
//
// Those readings ARE a measured, legible single-goal step (3 samples on 1-1,
// 2 on 2-1). The ADAAAA-7996 gate only credited a score change when perceive's
// own tracker oracle fired on a frame the window carried as a hint, so this
// window looked unattested and the accept was demoted to a celebration.
//
// The fix re-reads the same OCR lines with perceive's legibility bar and folds
// the measured delta into the window's attestation. No model prose, no second
// VLM call.
import { describe, expect, it } from "vitest";
import {
  LIVE_UNATTESTED_GOAL_NOTE,
  deriveWindowAttestation,
  downgradeUnattestedLiveGoal,
  liveGoalAttestationUsed,
  liveGoalHasMeasuredEvidence,
  liveUnattestedGoalNote,
  parseOcrScoreLine,
  scoreReadingsFromTimeline,
  scoreboardDeltaFromReadings,
  type DecisionResult,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer.js";

/** The GT-goal-1 window from job 8024a341, exactly as the decide prompt showed
 *  it (t relative to the window center, here expressed as content seconds). */
const GOAL1_TIMELINE = [
  { ts: 95.4, ocr: ["18:01 RMA 1-1 BAR"] },
  { ts: 98.6, ocr: ["18.05 RMA 1-1 BARVITALDE"] },
  { ts: 101.9, ocr: ["18.05 RMA 1-1 BARVITALDE"] },
  { ts: 102.2, ocr: ["18:13 |RMA2-1 BAR"] },
  { ts: 105.4, ocr: ["18:13 |RMA2-1 BAR"] },
];
const GOAL1_WINDOW = { lo: 95.4, hi: 105.4 };

describe("parseOcrScoreLine (ADAAAA-8071)", () => {
  it("parses the score out of a broadcast scorebug line", () => {
    expect(parseOcrScoreLine(["18:01 RMA 1-1 BAR"])).toEqual([1, 1]);
    expect(parseOcrScoreLine(["18:13 |RMA2-1 BAR"])).toEqual([2, 1]);
    expect(parseOcrScoreLine(["18:18 |RM2-1 BARLPE"])).toEqual([2, 1]);
  });

  it("never reads a clock, a bare number or noise as a score", () => {
    expect(parseOcrScoreLine(["18:13"])).toBeNull();
    expect(parseOcrScoreLine(["20:25"])).toBeNull();
    expect(parseOcrScoreLine(["Aszende"])).toBeNull();
    expect(parseOcrScoreLine([])).toBeNull();
    expect(parseOcrScoreLine(undefined)).toBeNull();
  });

  it("takes the first clean score line of a multi-line OCR read", () => {
    expect(parseOcrScoreLine(["VITALDE", "20:25 |RMA 2-1 BAR"])).toEqual([2, 1]);
  });
});

describe("scoreReadingsFromTimeline (ADAAAA-8071)", () => {
  it("keeps only parseable readings, ordered by content ts", () => {
    const readings = scoreReadingsFromTimeline([
      { ts: 105.4, ocr: ["18:13 |RMA2-1 BAR"] },
      { ts: 95.4, ocr: ["18:01 RMA 1-1 BAR"] },
      { ts: 97.1, ocr: ["Aszende"] },
      { ts: 98.6, ocr: ["18.05 RMA 1-1 BARVITALDE"] },
    ]);
    expect(readings.map((r) => r.ts)).toEqual([95.4, 98.6, 105.4]);
    expect(readings[2].score).toEqual([2, 1]);
  });
});

describe("scoreboardDeltaFromReadings (ADAAAA-8071)", () => {
  /** The stored `perceive_timeline` block from the goal-1 candidate on job
   *  8024a341 (prompt text, verbatim). `t` is seconds from the window center
   *  (105.393 s), so content ts = center + t. */
  const STORED_TIMELINE = `perceive timeline (perceive's 3 fps view of this window, one record per frame, ordered; t = seconds from the window center):
  -10.0s tracks=3 objects=player,ball ocr="18:01 RMA 1-1 BAR" poss=none
  -6.8s tracks=3 objects=player,ball ocr="18.05 RMA 1-1 BARVITALDE" poss=none
  -3.5s tracks=3 objects=player,ball ocr="18.05 RMA 1-1 BARVITALDE" poss=none
  -3.2s tracks=3 objects=player,ball ocr="18:13 |RMA2-1 BAR" poss=none
  -0.0s tracks=3 objects=player ocr="18:13 |RMA2-1 BAR" poss=none`;
  const GOAL1_CENTER = 105.393;
  function storedTimelineRecords(): { ts: number; ocr: string[] }[] {
    const out: { ts: number; ocr: string[] }[] = [];
    for (const line of STORED_TIMELINE.split("\n")) {
      const m = /^\s*([-+]?\d+(?:\.\d+)?)s\b.*?ocr="([^"]*)"/.exec(line);
      if (!m) continue;
      out.push({ ts: GOAL1_CENTER + Number(m[1]), ocr: [m[2]] });
    }
    return out;
  }

  it("credits the REAL goal-1 window from its stored decide timeline", () => {
    const records = storedTimelineRecords();
    expect(records).toHaveLength(5);
    const readings = scoreReadingsFromTimeline(records);
    expect(readings.map((r) => r.score)).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
      [2, 1],
      [2, 1],
    ]);
    const delta = scoreboardDeltaFromReadings(readings, { lo: records[0].ts, hi: records[records.length - 1].ts });
    expect(delta).toBeDefined();
    expect(delta!.pre).toEqual([1, 1]);
    expect(delta!.post).toEqual([2, 1]);
    expect(delta!.deltaTs).toBeCloseTo(102.193, 2);
    // ... and the same replay attests the window through the full derivation.
    const att = deriveWindowAttestation({
      centerTs: GOAL1_CENTER,
      frames: records.map((r) => ({ ts: r.ts })),
      observations: records,
      biasHints: [{ eventType: "AUDIO_BURST", ts: GOAL1_CENTER }],
    });
    expect(att.scoreBoardChanged).toBe(true);
    expect(liveGoalHasMeasuredEvidence(liveGoalAttestationUsed({ attribution: att }))).toBe(true);
  });

  it("credits the 100 s goal's 1-1 -> 2-1 transition from its own window", () => {
    const delta = scoreboardDeltaFromReadings(scoreReadingsFromTimeline(GOAL1_TIMELINE), GOAL1_WINDOW);
    expect(delta).toBeDefined();
    expect(delta!.pre).toEqual([1, 1]);
    expect(delta!.post).toEqual([2, 1]);
    expect(delta!.deltaTs).toBe(102.2);
    expect(delta!.preSamples).toBe(3);
    expect(delta!.postSamples).toBe(2);
  });

  it("credits nothing on a score-steady window (no false attestation)", () => {
    const steady = [
      { ts: 95, ocr: ["20:00 |RMA 2-1 BAR"] },
      { ts: 98, ocr: ["20:00 |RMA 2-1 BAR"] },
      { ts: 101, ocr: ["20:00 |RMA 2-1 BAR"] },
      { ts: 105, ocr: ["19:40 RMA2-1 BAR"] },
    ];
    expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(steady), { lo: 95, hi: 105 })).toBeUndefined();
  });

  it("rejects a single-frame misread (both sides need 2 contiguous reads)", () => {
    const misread = [
      { ts: 95, ocr: ["18:01 RMA 1-1 BAR"] },
      { ts: 98, ocr: ["18:05 RMA 1-1 BAR"] },
      { ts: 101, ocr: ["18:09 RMA 3-2 BAR"] }, // one-frame OCR misread
      { ts: 104, ocr: ["18:13 RMA 1-1 BAR"] },
      { ts: 107, ocr: ["18:17 RMA 1-1 BAR"] },
    ];
    expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(misread), { lo: 95, hi: 107 })).toBeUndefined();
  });

  it("rejects a multi-goal jump (ambiguous attribution)", () => {
    const jump = [
      { ts: 95, ocr: ["18:01 RMA 0-0 BAR"] },
      { ts: 98, ocr: ["18:05 RMA 0-0 BAR"] },
      { ts: 101, ocr: ["18:09 RMA 2-0 BAR"] },
      { ts: 104, ocr: ["18:13 RMA 2-0 BAR"] },
    ];
    expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(jump), { lo: 95, hi: 104 })).toBeUndefined();
  });

  it("fires once: a window that already re-reads the stable new score credits nothing", () => {
    const later = [
      { ts: 95, ocr: ["18:01 RMA 1-1 BAR"] },
      { ts: 98, ocr: ["18:05 RMA 1-1 BAR"] },
      { ts: 101, ocr: ["18:09 RMA 2-1 BAR"] },
      { ts: 104, ocr: ["18:13 RMA 2-1 BAR"] },
      { ts: 107, ocr: ["18:17 RMA 2-1 BAR"] },
    ];
    expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(later), { lo: 95, hi: 107 })).toBeUndefined();
    // ... while the window that COMPLETES the transition still credits it.
    expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(later.slice(0, 4)), { lo: 95, hi: 104 })).toBeDefined();
  });

  it("rejects a transition outside the judged window", () => {
    const outside = [
      { ts: 80, ocr: ["18:01 RMA 1-1 BAR"] },
      { ts: 83, ocr: ["18:05 RMA 1-1 BAR"] },
      { ts: 86, ocr: ["18:09 RMA 2-1 BAR"] },
      { ts: 89, ocr: ["18:13 RMA 2-1 BAR"] },
    ];
    expect(scoreboardDeltaFromReadings(scoreReadingsFromTimeline(outside), { lo: 95, hi: 105 })).toBeUndefined();
  });
});

describe("deriveWindowAttestation (ADAAAA-8071)", () => {
  it("attests the goal-1 window from its own perceive timeline", () => {
    const att = deriveWindowAttestation({
      centerTs: 105.393,
      frames: GOAL1_TIMELINE.slice(-5).map((r) => ({ ts: r.ts })),
      observations: GOAL1_TIMELINE,
      biasHints: [{ eventType: "AUDIO_BURST", ts: 105.393 }],
    });
    expect(att.scoreBoardChanged).toBe(true);
    expect(att.scoreAttestationSource).toBe("perceive_timeline");
    expect(att.scoreBoardDelta?.deltaTs).toBe(102.2);
    // The gate now sees a measured attestation, so the accept keeps the GOAL.
    expect(liveGoalHasMeasuredEvidence(liveGoalAttestationUsed({ attribution: att }))).toBe(true);
  });

  it("keeps the perceive hint's precedence when it already carried the change", () => {
    const hintDelta: ScoreboardDeltaEvidence = {
      pre: [1, 1],
      post: [2, 1],
      preTs: 101.9,
      postTs: 102.2,
      deltaTs: 102.2,
      preSamples: 3,
      postSamples: 2,
    };
    const att = deriveWindowAttestation({
      centerTs: 105.393,
      frames: GOAL1_TIMELINE.map((r) => ({ ts: r.ts })),
      observations: GOAL1_TIMELINE,
      biasHints: [{ eventType: "AUDIO_BURST", ts: 102.2, scoreBoardChanged: true, scoreBoardDelta: hintDelta }],
    });
    expect(att.scoreBoardChanged).toBe(true);
    expect(att.scoreAttestationSource).toBe("perceive_hint");
    expect(att.scoreBoardDelta).toEqual(hintDelta);
  });

  it("leaves a VOD payload (no observations) exactly as the hint fold", () => {
    const att = deriveWindowAttestation({
      centerTs: 105.393,
      frames: GOAL1_TIMELINE.map((r) => ({ ts: r.ts })),
      biasHints: [{ eventType: "AUDIO_BURST", ts: 105.393 }],
    });
    expect(att.scoreBoardChanged).toBeUndefined();
    expect(att.scoreBoardDelta).toBeUndefined();
    expect(att.scoreAttestationSource).toBeUndefined();
  });

  it("does not attest a score-steady window even with a whole timeline", () => {
    const steady = [
      { ts: 95, ocr: ["20:00 |RMA 2-1 BAR"] },
      { ts: 98, ocr: ["20:00 |RMA 2-1 BAR"] },
      { ts: 101, ocr: ["20:00 |RMA 2-1 BAR"] },
      { ts: 105, ocr: ["19:40 RMA2-1 BAR"] },
    ];
    const att = deriveWindowAttestation({
      centerTs: 105,
      frames: steady.map((r) => ({ ts: r.ts })),
      observations: steady,
      biasHints: [{ eventType: "AUDIO_BURST", ts: 105 }],
    });
    expect(att.scoreBoardChanged).toBeUndefined();
    expect(liveGoalHasMeasuredEvidence(liveGoalAttestationUsed({ attribution: att }))).toBe(false);
  });
});

describe("liveUnattestedGoalNote (ADAAAA-8071)", () => {
  it("names the attestations the gate read and why reaction cannot carry a goal", () => {
    const note = liveUnattestedGoalNote({
      scoreBoardChanged: false,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
    });
    expect(note).toContain("scoreBoardChanged=false");
    expect(note).toContain("goalCrossed=false");
    expect(note).toContain("ballOutcome=none");
    expect(note).toContain("corroborated=false");
    expect(note).toContain("goalConfirmed=none");
    expect(note).toContain("audio/motion reaction is corroborating evidence only");
    expect(note).toContain("not a GOAL");
  });

  it("falls back to the legacy note when no fields are supplied", () => {
    expect(liveUnattestedGoalNote()).toBe(LIVE_UNATTESTED_GOAL_NOTE);
  });

  it("keeps the demotion deliverable and names the fields on the row", () => {
    const scoring: DecisionResult = {
      isHighlight: true,
      score: 85,
      eventType: "GOAL",
      outcome: "scoring_play",
      reason: "The scoreboard updates from 1-1 to 2-1.",
    };
    const d = downgradeUnattestedLiveGoal(scoring, {
      scoreBoardChanged: false,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
    });
    expect(d.outcome).toBe("big_play");
    expect(d.eventType).toBe("BIG_PLAY");
    expect(d.reason).toContain("The scoreboard updates from 1-1 to 2-1.");
    expect(d.reason).toContain("scoreBoardChanged=false");
  });
});
