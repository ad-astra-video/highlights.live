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
  downgradeUnattestedLiveGoal,
  firstAttestedFrameTs,
  frameAttestationChannel,
  liveGoalHasMeasuredEvidence,
  localizeLiveWindowInstant,
  type DecisionResult,
  type LocalizeFrameInput,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer.js";
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
