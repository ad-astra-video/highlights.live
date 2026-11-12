// ADAAAA-8714 (AC2/AC3) integration through the REAL accept seam.
//
// Drives `acceptVideoDecision` exactly as the live observer does (trailing judged
// window `[now-10, now]`, `liveObserveLoop` on, confirm off) and asserts the two
// halves of the ruling on the persisted row AND on the window handed to the cut:
//
// - a reaction/celebration cue with no goal instant => `celebration_tail`:
//   `[cue - 13, cue + 2]` on a 15 s card, cue at 13.000 s of 15 s, length 15 s;
// - a row that names its goal instant (`measured_transition` / `frame_attestation`)
//   => `goal_anchor`: the ADAAAA-8152 window, unchanged (ACC-2);
// - no decide/confirm call is added by either path (AC4: $0 static).
import { describe, it, expect } from "vitest";
import {
  LiveRunShared,
  acceptVideoDecision,
  type AnalyzerConfig,
  type CandidateSignal,
  type DecisionResult,
  type LocalizeFrameInput,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer.js";

/** Live rail posture of the graded legs: confirm OFF, observe loop ON. */
function liveCfg(over: Partial<AnalyzerConfig> = {}): AnalyzerConfig {
  return {
    jobId: "job-8714",
    gameHint: "soccer",
    clipBeforeS: 7,
    clipAfterS: 8,
    clipWindowMinSec: 15,
    preferLabels: [],
    confirmEnabled: false,
    liveObserveLoop: true,
    ...over,
  } as AnalyzerConfig;
}

/** A motion/crowd trigger candidate as the live observe loop builds it: no
 * measured attestation (audio/motion cannot attest a score). */
function motionCandidate(ts: number, extra: Partial<CandidateSignal> = {}): CandidateSignal {
  return { eventType: "SPORTING_EVENT", timestamp: ts, ...extra } as CandidateSignal;
}

/** The decide verdict the graded legs stored for these windows: a scoring READ
 * whose model LABEL is the celebration class. On the live lane the measured-
 * attestation gate demotes it to a celebration row (`attestationUsed` all-false),
 * which is exactly the row shape AC1 measured on the stored corpus. */
function scoringWithCelebrationLabel(): DecisionResult {
  return {
    isHighlight: true,
    score: 78,
    outcome: "scoring_play",
    eventType: "BIG_PLAY",
    reason: "The crowd erupts and the players run to the corner.",
  } as DecisionResult;
}

/** A measured single-goal transition inside the judged window. */
const LEGIBLE_DELTA: ScoreboardDeltaEvidence = {
  pre: [1, 0],
  post: [2, 0],
  preTs: 99.1,
  postTs: 100.6,
  deltaTs: 100.6,
  preSamples: 4,
  postSamples: 4,
};

interface Call {
  ts: number;
  window?: { start: number; end: number; cueTail?: boolean };
}

/** Drive the real accept seam; the cut records the placed window it was given. */
async function accept(
  ts: number,
  stage1: DecisionResult,
  opts: { candidateExtra?: Partial<CandidateSignal>; frames?: LocalizeFrameInput[]; clipWindowMinSec?: number } = {}
): Promise<{ rec: any; calls: Call[] }> {
  const run = new LiveRunShared({ audioRetainS: 400 });
  const calls: Call[] = [];
  const cut = async (t: number, window?: { start: number; end: number; cueTail?: boolean }) => {
    calls.push({ ts: t, window });
    return { clipId: `clip-${t}`, clipUri: `file://clip-${t}.mp4` };
  };
  const client = {
    decide: () => {
      throw new Error("decide must NOT run on the accept seam (AC4: 0 added calls)");
    },
    confirm: () => {
      throw new Error("confirm must NOT run with confirmEnabled=false (AC4: 0 added calls)");
    },
  } as any;
  await acceptVideoDecision(
    client,
    run,
    cut,
    liveCfg(opts.clipWindowMinSec ? { clipWindowMinSec: opts.clipWindowMinSec } : {}),
    undefined,
    { seq: 1, timestamp: ts },
    motionCandidate(ts, opts.candidateExtra),
    stage1,
    opts.frames,
    undefined,
    undefined,
    // The live rail's trailing judged window.
    { lo: ts - 10, hi: ts }
  );
  expect(run.highlights).toHaveLength(1);
  return { rec: run.highlights[0], calls };
}

describe("ADAAAA-8714 AC2 — a reaction cue with no goal instant ends the card", () => {
  it("persists celebration_tail + clipCelebrationOffsetSec and cuts [cue-13, cue+2]", async () => {
    const cue = 473.9;
    const { rec, calls } = await accept(cue, scoringWithCelebrationLabel());
    expect(rec.localizeAnchorReason).toBe("trigger_evidence");
    expect(rec.clipPlacementReason).toBe("celebration_tail");
    expect(rec.clipWindowSec).toBeCloseTo(15, 6);
    expect(rec.clipGoalOffsetSec).toBeCloseTo(13, 6);
    expect(rec.clipCelebrationOffsetSec).toBeCloseTo(13, 6);
    expect(rec.start).toBeCloseTo(cue - 13, 6);
    expect(rec.end).toBeCloseTo(cue + 2, 6);
    // AC2: cue >= clipWindowSec - 2.5, and the card starts >= 13 s before it.
    expect(rec.clipCelebrationOffsetSec).toBeGreaterThanOrEqual(rec.clipWindowSec - 2.5);
    expect(cue - rec.start).toBeGreaterThanOrEqual(13);
    // The cut got the PLACED window, with the tail flag that stops the flip probe
    // from re-centring the card on the goal.
    expect(calls).toHaveLength(1);
    expect(calls[0].ts).toBeCloseTo(cue, 6);
    expect(calls[0].window?.start).toBeCloseTo(cue - 13, 6);
    expect(calls[0].window?.end).toBeCloseTo(cue + 2, 6);
    expect(calls[0].window?.cueTail).toBe(true);
  });

  it("holds for a crowd-roar (peak_audio_reaction) cue too", async () => {
    const cue = 628.786;
    const { rec, calls } = await accept(cue, scoringWithCelebrationLabel(), {
      candidateExtra: { audio: { kind: "crowd", peakEnergy: 0.62 } as any },
    });
    expect(rec.clipPlacementReason).toBe("celebration_tail");
    expect(rec.clipGoalOffsetSec).toBeCloseTo(13, 6);
    expect(calls[0].window?.cueTail).toBe(true);
  });
});

describe("ADAAAA-8714 AC3 — evidence-backed rows keep the 8152 placement", () => {
  it("keeps the measured-transition window (goal at 7 of 15, cueTail false)", async () => {
    const cue = 100.6;
    const { rec, calls } = await accept(cue, scoringWithCelebrationLabel(), { candidateExtra: { scoreBoardDelta: LEGIBLE_DELTA } });
    expect(rec.localizeAnchorReason).toBe("measured_transition");
    expect(rec.clipPlacementReason).toBe("goal_anchor");
    expect(rec.clipCelebrationOffsetSec).toBeUndefined();
    expect(rec.start).toBeCloseTo(cue - 7, 6);
    expect(rec.end).toBeCloseTo(cue + 8, 6);
    expect(rec.clipWindowSec).toBeCloseTo(15, 6);
    expect(rec.clipGoalOffsetSec).toBeCloseTo(7, 6);
    // ACC-2 band: the goal instant stays in [d/3, 2d/3].
    expect(rec.clipGoalOffsetSec).toBeGreaterThanOrEqual(15 / 3);
    expect(rec.clipGoalOffsetSec).toBeLessThanOrEqual((2 * 15) / 3);
    expect(calls[0].window?.start).toBeCloseTo(cue - 7, 6);
    expect(calls[0].window?.cueTail).toBe(false);
  });

  it("keeps the frame-attestation window (the corroborated-dive row)", async () => {
    const cue = 42;
    const frames: LocalizeFrameInput[] = [
      { ts: 41.2, signal: { scoreBoardChanged: true } },
      { ts: 41.8, signal: { goalCrossed: true } }, // earliest measured goal frame
    ];
    const { rec, calls } = await accept(cue, scoringWithCelebrationLabel(), { frames });
    expect(rec.localizeAnchorReason).toBe("frame_attestation");
    expect(rec.clipPlacementReason).toBe("goal_anchor");
    expect(rec.start).toBeCloseTo(41.2 - 7, 6);
    expect(rec.clipGoalOffsetSec).toBeCloseTo(7, 6);
    expect(calls[0].window?.cueTail).toBe(false);
  });

  it("leaves the delivered length at the configured 15 s on both paths", async () => {
    for (const extra of [undefined, { scoreBoardDelta: LEGIBLE_DELTA }]) {
      const { rec } = await accept(300, scoringWithCelebrationLabel(), extra ? { candidateExtra: extra } : {});
      expect(rec.end - rec.start).toBeCloseTo(15, 6);
    }
  });
});
