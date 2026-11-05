// ADAAAA-8085: the CELEBRATION lane must deliver at most ONE row per delivered
// goal event on the 4/2 live cell. This replays the stored payload shape of the
// graded leg — live job `00edb27a-33e1-485f-abf8-c1f9c6160f86` (build 52ce909),
// 300 s `kids300_7935.mp4` media-rail leg, cell LIVE_OBSERVE_MAX_FRAMES=4 /
// LIVE_OBSERVE_IN_FLIGHT=2:
//
//   row 182.29  status=accepted outcome=big_play eventType=BIG_PLAY attestationUsed all-false
//   row 185.49  status=accepted outcome=big_play eventType=BIG_PLAY attestationUsed all-false
//
// Both rows carry the SAME decide description ("The ball clearly enters the net
// and the keeper is beaten.") and were fired by two motion triggers 3.2 s apart.
// `attestationUsed` is only set by the ADAAAA-7996/8071 demotion gate, so the
// pre-downgrade verdict WAS goal-shaped; the stored BIG_PLAY is the demoted
// label. The control leg `f0c9c6fb` (same fixture) stored the analog read as
// `status=suppressed outcome=scoring_play eventType=GOAL` instead — it never
// reached the board.
//
// ROOT CAUSE (the key mismatch this test pins): the burst ledger is consulted
// with `decision.eventType ?? candidate.eventType` while the demotion gate keys
// on `highlightEventType(decision, candidate.eventType)` (outcome-derived). A
// live accept whose model label is not GOAL ("BIG_PLAY" / "SPORTING_EVENT") but
// whose outcome is `scoring_play` therefore SKIPS the 30 s `suppressIfGoalBurst`
// ledger and is then demoted into a delivered celebration row — one goal, two
// cards.
import { describe, it, expect } from "vitest";
import {
  LiveRunShared,
  SHOOTOUT_KICK_DEDUP_S,
  acceptVideoDecision,
  LIVE_UNATTESTED_GOAL_NOTE,
  type AnalyzerConfig,
  type CandidateSignal,
  type DecisionResult,
  type ScoreboardDeltaEvidence,
} from "../src/analyzer.js";

/** Live rail posture of the graded leg: confirm is OFF (LIVE_DECIDE_CONFIRM=0)
 * and `liveObserveLoop` is on with `decideWindowN` unset — the two conditions
 * the ADAAAA-7996 gate itself keys on. */
function liveCfg(over: Partial<AnalyzerConfig> = {}): AnalyzerConfig {
  return {
    jobId: "job-8085",
    gameHint: "soccer",
    clipBeforeS: 6,
    clipAfterS: 9,
    clipWindowMinSec: 15,
    preferLabels: [],
    confirmEnabled: false,
    liveObserveLoop: true,
    ...over,
  } as AnalyzerConfig;
}

/** A motion trigger candidate exactly as the live observe loop builds it: the
 * bias hint's event type, no attestation (audio/motion cannot attest a score). */
function motionCandidate(ts: number, extra: Partial<CandidateSignal> = {}): CandidateSignal {
  return { eventType: "SPORTING_EVENT", timestamp: ts, ...extra } as CandidateSignal;
}

/** The decide verdict the graded leg stored pre-downgrade: a scoring read whose
 * model LABEL is the celebration class ("big_play") — this is what made the
 * burst ledger skip. `eventType` is the label the decide service returned. */
function scoringWithCelebrationLabel(eventType = "BIG_PLAY"): DecisionResult {
  return {
    isHighlight: true,
    score: 78,
    outcome: "scoring_play",
    eventType,
    reason: "The ball clearly enters the net and the keeper is beaten.",
  } as DecisionResult;
}

/** A genuine celebration read: outcome `big_play` (not scoring). */
function celebrationRead(): DecisionResult {
  return {
    isHighlight: true,
    score: 61,
    outcome: "big_play",
    eventType: "BIG_PLAY",
    reason: "The keeper is beaten and the net ripples.",
  } as DecisionResult;
}

/** A measured score transition: the ONLY live attestation that carries a goal. */
const LEGIBLE_DELTA: ScoreboardDeltaEvidence = {
  pre: [1, 0],
  post: [2, 0],
  preTs: 99.1,
  postTs: 100.6,
  deltaTs: 100.6,
  preSamples: 4,
  postSamples: 4,
};

interface Harness {
  run: LiveRunShared;
  notes: Array<{ status: string; outcome?: string; eventType: string; timestamp: number }>;
  blocked: string[];
  accept: (ts: number, stage1: DecisionResult, candidateExtra?: Partial<CandidateSignal>) => Promise<void>;
}

/** Drive the REAL accept seam (`acceptVideoDecision`) the live observer uses,
 * with the trailing judged window the live rail passes (ADAAAA-7996). */
function harness(over: Partial<AnalyzerConfig> = {}): Harness {
  const run = new LiveRunShared({ audioRetainS: 400 });
  const notes: Harness["notes"] = [];
  const blocked: string[] = [];
  const cfg = liveCfg({
    onDecision: (n: any) => notes.push(n),
    ...over,
  });
  const cut = async (t: number) => ({ clipId: `clip-${t.toFixed(3)}`, clipUri: `file://clip-${t.toFixed(3)}.mp4` });
  const client = { decide: async () => ({}) as any, confirm: async () => ({}) as any } as any;
  let seq = 0;
  const accept = async (ts: number, stage1: DecisionResult, candidateExtra: Partial<CandidateSignal> = {}) => {
    seq += 1;
    await acceptVideoDecision(
      client,
      run,
      cut,
      cfg,
      (ev: any) => {
        if (ev?.type === "candidateBlocked") blocked.push(String(ev.reason ?? ""));
      },
      { seq, timestamp: ts },
      motionCandidate(ts, candidateExtra),
      stage1,
      undefined,
      undefined,
      undefined,
      // The live rail's trailing judged window `[now-10, now]`.
      { lo: ts - 10, hi: ts }
    );
  };
  return { run, notes, blocked, accept };
}

describe("ADAAAA-8085 celebration lane delivers one row per delivered goal", () => {
  it("collapses the stored 182.29 / 185.49 pair (scoring read labelled BIG_PLAY) to ONE row", async () => {
    const h = harness();
    await h.accept(182.29, scoringWithCelebrationLabel("BIG_PLAY"));
    await h.accept(185.49, scoringWithCelebrationLabel("BIG_PLAY"));

    // Pre-fix this was 2 (one goal, two celebration cards). The ledger key must
    // agree with the lane key the demotion gate uses.
    expect(h.run.highlights.length).toBe(1);
    const row = h.run.highlights[0];
    // The ADAAAA-7996/8071 contract is untouched: still a celebration (never a
    // postable GOAL), still naming every missing attestation.
    expect(row.outcome).toBe("big_play");
    expect(row.eventType).toBe("BIG_PLAY");
    expect(row.attestationUsed).toEqual({
      scoreBoardChanged: false,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
    });
    expect(row.reason ?? "").toContain(LIVE_UNATTESTED_GOAL_NOTE.slice(0, 40));
    // The second window is recorded as a suppressed candidate, exactly like the
    // control leg's `status=suppressed` analog read — the decision trail keeps
    // the window, the board does not get a second card.
    const suppressed = h.notes.filter((n) => n.status === "suppressed");
    expect(suppressed.length).toBe(1);
    expect(suppressed[0].timestamp).toBe(185.49);
  });

  it("keys the same way when the decide label is the observe default (SPORTING_EVENT)", async () => {
    const h = harness();
    await h.accept(182.29, scoringWithCelebrationLabel("SPORTING_EVENT"));
    await h.accept(185.49, scoringWithCelebrationLabel("SPORTING_EVENT"));
    expect(h.run.highlights.length).toBe(1);
  });

  it("keeps the control-build behaviour when the label already reads GOAL", async () => {
    // The control leg `f0c9c6fb` shape: label GOAL + outcome scoring_play, no
    // attestation. This path already suppressed the second window pre-fix; the
    // fix must not change it.
    const h = harness();
    await h.accept(183.66, scoringWithCelebrationLabel("GOAL"));
    await h.accept(186.9, scoringWithCelebrationLabel("GOAL"));
    expect(h.run.highlights.length).toBe(1);
    expect(h.run.highlights[0].outcome).toBe("big_play");
  });

  it("collapses a same-event celebration PAIR within SHOOTOUT_KICK_DEDUP_S to one row", async () => {
    // Neither read is goal-shaped, so the goal-burst ledger never sees them —
    // this needs the celebration-side bound. `saves` is the live-rail label that
    // admits a `big_play` accept (NON_GOAL_LABEL_OUTCOMES).
    const h = harness({ preferLabels: ["saves"] });
    await h.accept(184.29, celebrationRead());
    await h.accept(187.49, celebrationRead());
    expect(h.run.highlights.length).toBe(1);
    expect(h.run.highlights[0].eventType).toBe("BIG_PLAY");
    const suppressed = h.notes.filter((n) => n.status === "suppressed");
    expect(suppressed.length).toBe(1);
  });

  it("collapses a celebration that re-reads an already-delivered GOAL (161.586 after 156.325)", async () => {
    // Graded-leg row 3/4: GOAL 156.325 then BIG_PLAY 161.586, 5.3 s apart.
    const h = harness({ preferLabels: ["saves"] });
    await h.accept(156.325, scoringWithCelebrationLabel("GOAL"), {
      // The 159 s goal's own measured transition (the graded leg read 2-1 -> 2-2).
      scoreBoardDelta: { ...LEGIBLE_DELTA, pre: [2, 1], post: [2, 2], preTs: 158.1, postTs: 159.6, deltaTs: 159.6 },
      scoreBoardChanged: true,
    });
    // Delivered as a real GOAL: the measured delta attests it.
    expect(h.run.highlights[0].eventType).toBe("GOAL");
    await h.accept(161.586, celebrationRead());
    expect(h.run.highlights.length).toBe(1);
  });

  it("does not over-collapse: distinct celebrations > 8 s apart both ship", async () => {
    const h = harness({ preferLabels: ["saves"] });
    await h.accept(120.0, celebrationRead());
    await h.accept(120.0 + SHOOTOUT_KICK_DEDUP_S + 1, celebrationRead());
    expect(h.run.highlights.length).toBe(2);
  });

  it("ships a goal-shaped re-read 20 s after a DEMOTED celebration as its own row (ADAAAA-8140 supersedes the 30 s breadth)", async () => {
    // ADAAAA-8085 collapsed this pair (170.0 / 190.0, different copy) on the 30 s
    // burst reference. ADAAAA-8140 measured that breadth as a LOSS path: the
    // reference was a row that never shipped as a GOAL, and a real goal 26 s
    // later was dropped silently. A demoted celebration is therefore only a
    // same-MOMENT reference (the tight re-read window), and a distinct moment
    // ships as its own (non-postable) row instead of being dropped.
    const h = harness();
    await h.accept(170.0, scoringWithCelebrationLabel("BIG_PLAY"));
    await h.accept(190.0, {
      ...scoringWithCelebrationLabel("BIG_PLAY"),
      reason: "The keeper is left standing as the net bulges.",
    } as DecisionResult);
    expect(h.run.highlights.length).toBe(2);
    expect(h.run.highlights.every((r) => r.outcome === "big_play")).toBe(true);
  });

  it("does not cost recall: an attested GOAL 59 s later still ships as GOAL", async () => {
    // The fixture's two GT goals (100 s / 159 s, 59 s apart) — the bound must
    // never drop the second scoring event.
    const h = harness();
    await h.accept(100.8, scoringWithCelebrationLabel("GOAL"), {
      scoreBoardDelta: LEGIBLE_DELTA,
      scoreBoardChanged: true,
    });
    await h.accept(159.4, scoringWithCelebrationLabel("GOAL"), {
      scoreBoardDelta: { ...LEGIBLE_DELTA, pre: [2, 0], post: [2, 1], preTs: 158.1, postTs: 159.6, deltaTs: 159.6 },
      scoreBoardChanged: true,
    });
    expect(h.run.highlights.length).toBe(2);
    expect(h.run.highlights.map((r) => r.eventType)).toEqual(["GOAL", "GOAL"]);
  });
});
