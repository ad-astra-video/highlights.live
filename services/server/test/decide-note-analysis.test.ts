import { describe, expect, it } from "vitest";
import { buildCandidateNote, type AnalyzerConfig, type CandidateSignal, type ConfirmDecision, type DecisionResult } from "../src/analyzer";
import type { ConfirmRecord, HighlightTrigger, JobCandidate, WindowAnalysis } from "@highlights/events";

// ADAAAA-7156 Increment B: buildCandidateNote must persist the Stage-1 per-window
// LLM analysis (exact prompt / dataItems / full response) and the Stage-2
// confirm record onto the JobCandidate that the analyzer emits, so the
// job-detail API can expose them. Observability only.

const analysis: WindowAnalysis = {
  prompt: "You are a sports/esports highlight judge...",
  dataItems: [
    { type: "candidate", label: "Candidate event type", value: "GOAL" },
    { type: "tracking", label: "Track count", value: 3 },
  ],
  frames: [{ seq: 5, uri: "/jobs/j/frames/5" }],
  images: [],
  audio: { uri: "", sampleRate: 16000, path: "none" },
  asr: { transcript: "goal!", url: "" },
  response: { isHighlight: true, score: 92, outcome: "scoring_play", reasoning: "ball crossed the line", evidenceAttested: ["ball in net"] },
};

const confirmRecord: ConfirmRecord = {
  request: {
    prompt: "You are a sports highlight CONFIRMATION judge...",
    dataItems: [{ type: "confirm", label: "Stage-1 verdict", value: "scoring_play" }],
    frames: [{ seq: 0, uri: "" }],
    keyframes: [{ seq: 1, uri: "" }],
    trajectories: ["- ball (track t1) path: t=0.0s (0.50,0.50)"],
    opticalFlowMagnitude: 1.5,
    audioLevels: [0.2, 0.8],
    transcript: "goal!",
    stage1: { outcome: "scoring_play", isHighlight: true },
  },
  decision: { enabled: true, goalConfirmed: "confirmed_goal", confidence: 0.95, evidence: { ballInNet: true }, stage1Disagreed: false, outcome: "scoring_play" },
};

function cfg(onDecision: (c: JobCandidate) => void): AnalyzerConfig {
  return { jobId: "j", onDecision } as unknown as AnalyzerConfig;
}

const candidate: CandidateSignal = { eventType: "GOAL", timestamp: 2.1, seq: 5 };
const trigger: HighlightTrigger = { kind: "goal_line", timestamp: 2.1, eventType: "GOAL" };
const decision: DecisionResult = { isHighlight: true, score: 92, eventType: "GOAL", outcome: "scoring_play", reason: "ball in net", analysis };

describe("buildCandidateNote (ADAAAA-7156 Increment B)", () => {
  it("persists the per-window analysis + confirm record onto the emitted candidate", () => {
    const collected: JobCandidate[] = [];
    buildCandidateNote(cfg((c) => collected.push(c)), candidate, decision, "accepted", "cid-1", trigger, analysis, confirmRecord);

    expect(collected).toHaveLength(1);
    const c = collected[0];
    // Stage-1 window analysis survives to the persistence boundary.
    expect(c.analysis?.prompt).toContain("highlight judge");
    expect(c.analysis?.dataItems).toHaveLength(2);
    expect(c.analysis?.dataItems[0].value).toBe("GOAL");
    expect(c.analysis?.response?.reasoning).toContain("ball crossed");
    expect(c.analysis?.response?.evidenceAttested).toEqual(["ball in net"]);
    // Stage-2 deep-frame dive (incl. stage1Disagreed) rides along.
    expect(c.confirm?.request?.prompt).toContain("CONFIRMATION");
    expect(c.confirm?.decision?.goalConfirmed).toBe("confirmed_goal");
    expect(c.confirm?.decision?.stage1Disagreed).toBe(false);
  });

  it("leaves analysis/confirm undefined when no capture was made (legacy)", () => {
    const collected: JobCandidate[] = [];
    buildCandidateNote(cfg((c) => collected.push(c)), candidate, decision, "accepted", "cid-2", trigger);
    expect(collected[0].analysis).toBeUndefined();
    expect(collected[0].confirm).toBeUndefined();
  });

  it("skips a malformed analysis block but still persists the note (defensive)", () => {
    const collected: JobCandidate[] = [];
    // `prompt` is required by WindowAnalysisSchema; omit it => malformed.
    const badAnalysis = { dataItems: [{ type: "candidate", label: "x", value: "GOAL" }] } as unknown as WindowAnalysis;
    buildCandidateNote(cfg((c) => collected.push(c)), candidate, decision, "accepted", "cid-4", trigger, badAnalysis, confirmRecord);
    expect(collected).toHaveLength(1);
    // The note persists; the malformed analysis is dropped rather than failing
    // the whole candidate note at recordJobCandidate.
    expect(collected[0].analysis).toBeUndefined();
    // The conforming confirm record still rides along.
    expect(collected[0].confirm?.decision?.goalConfirmed).toBe("confirmed_goal");
  });

  it("no-ops when there is no onDecision hook", () => {
    const empty = { jobId: "j" } as unknown as AnalyzerConfig;
    expect(() => buildCandidateNote(empty, candidate, decision, "accepted", "cid-3", trigger, analysis, confirmRecord)).not.toThrow();
  });
});
