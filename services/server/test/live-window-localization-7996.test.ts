// ADAAAA-7996: LIVE media-rail localization + scoring-lane attestation gate.
//
// Regression source: live job 44aaeaf6 (file-sim of `kids300_7935.mp4`, GT goals
// at 100 s and 159 s, posture LIVE_DECIDE_CONFIRM=0). The run failed three ways:
//
// 1. every GOAL was delivered at its TRAILING window's CENTRE (112.1 / 118.8 /
//    120.0 against the 100 s goal => +12.1 s), because localization only scanned
//    FORWARD from `candidate.timestamp` (== the window's `nowTs`);
// 2. a score-steady lull window @289.5 s shipped `scoring_play` off the model's
//    read alone ("The 'GOL' graphic appears") — a postable false GOAL;
// 3. the AUDIO_BURST-only accept leg had no deterministic reject, because the
//    only corroboration gate (the Stage-2 confirm dive) is OFF on the live rail.
import { describe, expect, it } from "vitest";
import {
  LIVE_UNATTESTED_GOAL_NOTE,
  deriveWindowAttestation,
  downgradeUnattestedLiveGoal,
  firstAttestedFrameTs,
  frameAttestationChannel,
  liveAnchorTs,
  liveGoalHasMeasuredEvidence,
  localizeLiveWindowInstant,
  type DecisionResult,
  type LocalizeFrameInput,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer.js";
import { clipWindow } from "../src/config.js";
import { isPostableHighlight } from "../src/highlight-postable.js";
import type { HighlightRecord } from "@highlights/events";

/** Frames of the live trailing window [101, 111] carrying the measured
 *  scoreboard transition at 103 (2 fps content sampling). */
const TRAILING_WINDOW: LocalizeFrameInput[] = [
  { ts: 101, signal: {}, detectionConfidence: 0.9 },
  { ts: 102, signal: {}, detectionConfidence: 0.95 },
  { ts: 103, signal: { scoreBoardChanged: true }, detectionConfidence: 0.4 },
  { ts: 105, signal: {}, detectionConfidence: 0.98 },
  { ts: 109, signal: {}, detectionConfidence: 0.99 },
];

const DELTA: ScoreboardDeltaEvidence = {
  pre: [0, 0],
  post: [1, 0],
  preTs: 101,
  postTs: 103,
  deltaTs: 103,
  preSamples: 2,
  postSamples: 3,
};

describe("frameAttestationChannel (ADAAAA-7996)", () => {
  it("ranks measured goal attestations and scores a confident frame 0", () => {
    expect(frameAttestationChannel({ ts: 1, signal: { ballInNet: true } })).toBe(100);
    expect(frameAttestationChannel({ ts: 1, signal: { goalCrossed: true } })).toBe(80);
    expect(frameAttestationChannel({ ts: 1, signal: { ballOutcome: "goal" } })).toBe(70);
    expect(frameAttestationChannel({ ts: 1, signal: { scoreBoardChanged: true } })).toBe(60);
    // Detection confidence is NOT evidence: a window of confidently tracked
    // objects must never anchor a delivery or attest a goal on its own.
    expect(frameAttestationChannel({ ts: 1, signal: {}, detectionConfidence: 1 })).toBe(0);
    expect(frameAttestationChannel({ ts: 1 })).toBe(0);
  });
});

describe("firstAttestedFrameTs (ADAAAA-7996)", () => {
  it("returns the EARLIEST attested frame inside the window", () => {
    expect(firstAttestedFrameTs(TRAILING_WINDOW, 101, 111)).toBe(103);
  });

  it("ignores frames outside the judged window", () => {
    const late = [...TRAILING_WINDOW, { ts: 115, signal: { goalCrossed: true } }];
    expect(firstAttestedFrameTs(late, 101, 111)).toBe(103);
    expect(firstAttestedFrameTs(late, 110, 120)).toBe(115);
  });

  it("returns undefined when only confidence is present", () => {
    expect(firstAttestedFrameTs([{ ts: 104, signal: {}, detectionConfidence: 0.99 }], 101, 111)).toBeUndefined();
    expect(firstAttestedFrameTs(undefined, 0, 10)).toBeUndefined();
  });
});

describe("localizeLiveWindowInstant (ADAAAA-7996)", () => {
  it("anchors on the measured scoreboard transition instant, not the window centre", () => {
    const loc = localizeLiveWindowInstant(111, TRAILING_WINDOW, [], 15, { lo: 101, hi: 111 }, DELTA);
    expect(loc.ts).toBe(103);
    expect(loc.signal).toBe("peak_frame");
    expect(loc.anchorReason).toBe("frame_attestation");
    expect(loc.deltaSec).toBe(0);
    // The defect: the old path returned the window centre (111 => +12.1 s off
    // the 100 s goal). The transition instant is 8 s EARLIER.
    expect(111 - loc.ts).toBe(8);
  });

  it("falls back to the earliest attested frame when no legible delta exists", () => {
    const loc = localizeLiveWindowInstant(111, TRAILING_WINDOW, [], 15, { lo: 101, hi: 111 });
    expect(loc.ts).toBe(103);
    expect(loc.anchorReason).toBe("frame_attestation");
  });

  it("clamps a delta instant into the judged window", () => {
    const outOfWindow: ScoreboardDeltaEvidence = { ...DELTA, preTs: 90, postTs: 98, deltaTs: 98 };
    expect(localizeLiveWindowInstant(111, TRAILING_WINDOW, [], 15, { lo: 101, hi: 111 }, outOfWindow).ts).toBe(101);
  });

  it("keeps the pre-existing trigger/peak-audio path when nothing is attested", () => {
    const bare: LocalizeFrameInput[] = [
      { ts: 105, signal: {}, detectionConfidence: 0.9 },
      { ts: 109, signal: {}, detectionConfidence: 0.9 },
    ];
    const loc = localizeLiveWindowInstant(111, bare, [], 15, { lo: 101, hi: 111 });
    expect(loc.ts).toBe(111);
    expect(loc.anchorReason).toBe("trigger_evidence");
  });
});

describe("liveGoalHasMeasuredEvidence (ADAAAA-7996)", () => {
  it("credits each measured attestation", () => {
    expect(liveGoalHasMeasuredEvidence({ scoreBoardChanged: true })).toBe(true);
    expect(liveGoalHasMeasuredEvidence({ goalCrossed: true })).toBe(true);
    expect(liveGoalHasMeasuredEvidence({ ballOutcome: "goal" })).toBe(true);
    expect(liveGoalHasMeasuredEvidence({ corroborated: true })).toBe(true);
    expect(liveGoalHasMeasuredEvidence({ goalConfirmed: "confirmed_goal" })).toBe(true);
  });

  it("refuses a model-only read (the 289.5 s false goal)", () => {
    // Job 44aaeaf6 @289.5 s: trigger kind `motion`, score steady 2-2, no
    // goal-line signal, reason "The 'GOL' graphic appears".
    expect(liveGoalHasMeasuredEvidence({})).toBe(false);
    expect(liveGoalHasMeasuredEvidence({ ballOutcome: "saved", goalConfirmed: "near_miss" })).toBe(false);
    expect(liveGoalHasMeasuredEvidence({ scoreBoardChanged: false, goalCrossed: false })).toBe(false);
  });
});

describe("downgradeUnattestedLiveGoal (ADAAAA-7996)", () => {
  const scoring: DecisionResult = {
    isHighlight: true,
    score: 65,
    eventType: "GOAL",
    outcome: "scoring_play",
    reason: "The 'GOL' graphic appears.",
  };

  it("leaves the scoring lane and stays deliverable as a celebration", () => {
    const d = downgradeUnattestedLiveGoal(scoring);
    expect(d.isHighlight).toBe(true);
    expect(d.outcome).toBe("big_play");
    expect(d.eventType).toBe("BIG_PLAY");
    expect(d.reason).toContain(LIVE_UNATTESTED_GOAL_NOTE);
    expect(d.reason).toContain("The 'GOL' graphic appears.");
  });

  it("can never be postable as a GOAL", () => {
    const d = downgradeUnattestedLiveGoal(scoring);
    const rec = {
      id: "hl-1",
      jobId: "job-1",
      start: 282.5,
      end: 297.5,
      eventType: d.eventType,
      outcome: d.outcome,
      score: d.score,
      reason: d.reason,
      status: "pending",
    } as unknown as HighlightRecord;
    expect(isPostableHighlight(rec)).toBe(false);
    // The downgrade note itself also trips the contradicting-verdict rule, so a
    // row that somehow kept `scoring_play` is still not postable.
    expect(isPostableHighlight({ ...rec, outcome: "scoring_play" })).toBe(false);
    expect(isPostableHighlight({ ...rec, outcome: "scoring_play", reason: "The 'GOL' graphic appears." })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ADAAAA-8152 (ACC-2): the LIVE clip must centre the MEASURED goal instant.
//
// Regression source: leg 6c900ab5 (build 6486e09, 10 s trailing window, 4/2
// cell, kids300_7935 fixture). Both accepted GOAL rows stored
// `localizedTs == trigger.timestamp - 10` — the window's FIRST frame — so with
// clipBeforeS=7 / clipAfterS=8 the delivered 15 s clip was `[goal-14.4,
// goal+0.6]`: the score transition sat at 0.92-0.99 of the clip and there was
// no post-goal footage.
//
// Mechanism (named before changing it):
//   * perceive's score channel is STICKY — `ScoreboardTracker.changed(ts)` is
//     true whenever a legible transition exists anywhere in the trailing 60 s,
//     so from the window's first frame onward every frame carries
//     `scoreBoardChanged: true`;
//   * the run's one-transition ledger refuses to credit the same transition to
//     every overlapping window (`claimScoreTransition`), and the derive path
//     DROPPED the delta with the credit;
//   * with no delta on the candidate, localization fell to
//     `firstAttestedFrameTs`, which returns the earliest attested frame = the
//     window's start, because the sticky flag makes every frame look attested.
//
// The measured instant was already in the window's own perceive timeline; it
// just never reached the anchor. These tests pin the anchor to it.
// ---------------------------------------------------------------------------

/** 4 image frames of the trailing window [58.36, 68.36], ALL carrying the sticky
 * score flag (the shape the rail actually produces after the transition). */
const STICKY_FRAMES: LocalizeFrameInput[] = [
  { ts: 58.363, signal: { scoreBoardChanged: true }, detectionConfidence: 0.9 },
  { ts: 61.697, signal: { scoreBoardChanged: true }, detectionConfidence: 0.9 },
  { ts: 65.03, signal: { scoreBoardChanged: true }, detectionConfidence: 0.9 },
  { ts: 68.363, signal: { scoreBoardChanged: true }, detectionConfidence: 0.9 },
];

const WINDOW_2 = { lo: 58.363, hi: 68.363 };
const MEASURED_TS = 66.663; // first frame reading `22:13 RMA 2-2` (t=-1.7 s)

/** The window's perceive timeline: 2-1 until 66.263, then 2-2. */
const OBSERVATIONS = (() => {
  const out: { ts: number; ocr: string[] }[] = [];
  for (let i = 0; i <= 23; i++) {
    const ts = 58.363 + i * 0.33;
    out.push({ ts, ocr: ["22:06 RMA2-1 BAR"] });
  }
  for (let i = 0; i <= 6; i++) {
    out.push({ ts: 66.263 + i * 0.33, ocr: ["22:13 RRMA2-2 BARAszende"] });
  }
  return out.sort((a, b) => a.ts - b.ts);
})();

describe("localizeLiveWindowInstant measured anchor (ADAAAA-8152)", () => {
  it("documents the pre-fix shape: sticky frames with no delta anchor on the window START", () => {
    const loc = localizeLiveWindowInstant(68.363, STICKY_FRAMES, [], 8, WINDOW_2);
    expect(loc.ts).toBe(58.363);
  });

  it("anchors on the measured transition instant when the delta was not credited", () => {
    const loc = localizeLiveWindowInstant(68.363, STICKY_FRAMES, [], 8, WINDOW_2, undefined, MEASURED_TS);
    expect(loc.ts).toBe(MEASURED_TS);
    expect(loc.anchorReason).toBe("measured_transition");
    expect(loc.evidenceTs).toBe(MEASURED_TS);
    expect(loc.deltaSec).toBe(0);
  });

  it("puts the goal in the middle third of a default 7/8 clip", () => {
    const loc = localizeLiveWindowInstant(68.363, STICKY_FRAMES, [], 8, WINDOW_2, undefined, MEASURED_TS);
    const win = clipWindow(loc.ts, 7, 8, 15);
    const d = win.end - win.start;
    const offset = loc.ts - win.start;
    expect(d).toBe(15);
    expect(offset).toBeGreaterThanOrEqual(d / 3);
    expect(offset).toBeLessThanOrEqual((2 * d) / 3);
    // >= 2 s of post-goal footage.
    expect(win.end - loc.ts).toBeGreaterThanOrEqual(2);
  });

  it("ignores a measured instant outside the judged window", () => {
    const loc = localizeLiveWindowInstant(68.363, STICKY_FRAMES, [], 8, WINDOW_2, undefined, 200);
    expect(loc.ts).toBe(58.363);
  });

  it("still prefers a credited delta and keeps the audit reason", () => {
    const credited: ScoreboardDeltaEvidence = { ...DELTA, preTs: 66.263, postTs: 66.663, deltaTs: 66.663 };
    const loc = localizeLiveWindowInstant(68.363, STICKY_FRAMES, [], 8, WINDOW_2, credited);
    expect(loc.ts).toBe(66.663);
    expect(loc.anchorReason).toBe("frame_attestation");
  });
});

describe("liveAnchorTs (ADAAAA-8152)", () => {
  it("uses the window's own measured transition instant inside the window", () => {
    expect(liveAnchorTs(MEASURED_TS, undefined, WINDOW_2)).toBe(MEASURED_TS);
  });

  it("falls back to the pooled read span's boundary when it lands inside the window", () => {
    const pooled = { scoreReads: 46, preSamples: 40, postSamples: 6, need: 2, newestTransitionTs: MEASURED_TS };
    expect(liveAnchorTs(undefined, pooled, WINDOW_2)).toBe(MEASURED_TS);
  });

  it("never guesses: out-of-window or absent evidence yields undefined", () => {
    const pooled = { scoreReads: 46, preSamples: 40, postSamples: 6, need: 2, newestTransitionTs: 53.0 };
    expect(liveAnchorTs(undefined, pooled, WINDOW_2)).toBeUndefined();
    expect(liveAnchorTs(120, undefined, WINDOW_2)).toBeUndefined();
    expect(liveAnchorTs(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe("deriveWindowAttestation keeps the instant when credit is refused (ADAAAA-8152)", () => {
  const payload = {
    centerTs: 68.363,
    frames: STICKY_FRAMES.map((f) => ({ ts: f.ts })),
    observations: OBSERVATIONS,
    biasHints: [{ eventType: "SPORTING_EVENT", ts: 68.363, scoreBoardChanged: true }],
  };

  it("exposes scoreTransitionTs even when the run already credited the transition", () => {
    const att = deriveWindowAttestation(payload, { claimScoreTransition: () => false });
    expect(att.scoreBoardDelta).toBeUndefined(); // no second credit / no second GOAL
    expect(att.scoreTransitionTs).toBeCloseTo(66.263, 2);
  });

  it("credits the delta when the ledger allows it, with the same instant", () => {
    const att = deriveWindowAttestation(payload, { claimScoreTransition: () => true });
    expect(att.scoreBoardDelta?.deltaTs).toBeCloseTo(66.263, 2);
    expect(att.scoreTransitionTs).toBeCloseTo(66.263, 2);
  });
});

