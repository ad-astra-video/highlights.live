import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCandidateNote, withWindowFrameRefs, type AnalyzerConfig, type CandidateSignal, type ConfirmDecision, type DecisionResult } from "../src/analyzer";
import { ConfirmRecordSchema, JobCandidateSchema } from "@highlights/events";
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

// ADAAAA-7848: the Stage-2 confirm record never reached persistence — job
// dee44c2f stored 103/103 window analyses and 0/103 confirm blocks. The decide
// `/confirm` producer emits its optical-flow / audio-envelope curves as number
// ARRAYS inside `request.dataItems`, and the shared contract's scalar-only value
// union rejected the whole record inside a silent `catch {}`.
//
// `confirm-analysis-goal.json` is the VERBATIM output of
// `services/decide/app/confirm.py::_confirm_analysis` (12 dense frames, 3
// keyframes, 2 trajectory tracks, both curves, ASR transcript, reconciled
// decision), so this is a producer->consumer contract test, not a hand-shaped
// fixture that could drift with the schema.
const decideConfirmAnalysis = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "confirm-analysis-goal.json"), "utf8")
) as ConfirmRecord;

describe("Stage-2 confirm record contract (ADAAAA-7848)", () => {
  it("accepts the real decide _confirm_analysis shape, curve series included", () => {
    const parsed = ConfirmRecordSchema.parse(decideConfirmAnalysis);
    const curve = parsed.request.dataItems.find((i) => i.label === "Optical-flow magnitude curve");
    const envelope = parsed.request.dataItems.find((i) => i.label === "Audio-energy envelope");
    // The two series items that used to fail the union and drop the record.
    expect(curve?.value).toEqual([0.1, 0.42, 0.91, 0.63, 0.22]);
    expect(envelope?.value).toEqual([0.18, 0.51, 0.93, 0.77, 0.34]);
    expect(parsed.request.frames).toHaveLength(12);
    expect(parsed.request.trajectories).toHaveLength(2);
  });

  it("persists the confirm block onto the emitted candidate note", () => {
    const collected: JobCandidate[] = [];
    buildCandidateNote(
      cfg((c) => collected.push(c)),
      candidate,
      decision,
      "accepted",
      "cid-5",
      trigger,
      analysis,
      decideConfirmAnalysis
    );

    expect(collected).toHaveLength(1);
    // Parse exactly what recordJobCandidate parses: the real persistence boundary.
    const persisted = JobCandidateSchema.parse(collected[0]);
    expect(persisted.confirm).toBeDefined();
    expect(persisted.confirm?.request.prompt).toContain("CONFIRMATION judge");
    expect(persisted.confirm?.request.dataItems).toHaveLength(14);
    // The model's measured inputs are queryable off the note.
    expect(persisted.confirm?.decision.evidence).toMatchObject({
      ballInNet: true,
      scoreboardChanged: false,
      penaltyShootout: false,
    });
    expect(persisted.confirm?.decision.goalConfirmed).toBe("confirmed_goal");
    expect(persisted.confirm?.decision.confidence).toBe(0.88);
    expect(persisted.confirm?.decision.outcome).toBe("scoring_play");
    expect(persisted.confirm?.decision.stage1Disagreed).toBe(false);
  });

  it("tolerates a null outcome / confidence on the decision block", () => {
    const rec = JSON.parse(JSON.stringify(decideConfirmAnalysis)) as ConfirmRecord;
    (rec.decision as { outcome?: unknown }).outcome = null;
    (rec.decision as { confidence?: unknown }).confidence = null;
    const parsed = ConfirmRecordSchema.parse(rec);
    expect(parsed.decision.outcome).toBeNull();
    // The note still persists with the confirm block attached.
    const collected: JobCandidate[] = [];
    buildCandidateNote(cfg((c) => collected.push(c)), candidate, decision, "accepted", "cid-7", trigger, analysis, rec);
    expect(JobCandidateSchema.parse(collected[0]).confirm?.decision.confidence).toBeNull();
  });

  it("logs the rejection (job id + field path) and salvages a drifting dataItem value", () => {
    const rec = JSON.parse(JSON.stringify(decideConfirmAnalysis)) as any;
    // Simulate producer drift the contract does not model: a structured object
    // where a scalar/series was expected.
    rec.request.dataItems[9].value = { series: [0.1, 0.9], unit: "px/s" };
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    const collected: JobCandidate[] = [];
    buildCandidateNote(cfg((c) => collected.push(c)), candidate, decision, "accepted", "cid-6", trigger, analysis, rec);
    spy.mockRestore();

    const logged = errors.join("\n");
    // Visible, actionable drift: the job id and the exact offending field.
    expect(logged).toContain("[decide-note:j] confirm record rejected");
    expect(logged).toContain("request.dataItems.9.value");
    // And the record still reaches persistence with its evidence intact.
    const persisted = JobCandidateSchema.parse(collected[0]);
    expect(persisted.confirm?.decision.evidence).toMatchObject({ ballInNet: true });
    expect(String(persisted.confirm?.request.dataItems[9].value)).toContain("px/s");
  });
});

// ADAAAA-7734: the decide service returns `analysis.frames[]` as index-based
// placeholder refs with `uri: ""` (its ImageRef only carries role/base64), so a
// media-rail note pointed at no image at all. The server rewrites those refs from
// the observe window's frames — each carrying its GLOBAL seq — so every note names
// the exact JPEGs it was fed and each uri resolves on the frame route.
describe("withWindowFrameRefs (ADAAAA-7734)", () => {
  const placeholder: WindowAnalysis = {
    prompt: "p",
    dataItems: [],
    frames: [{ seq: 0, uri: "" }],
    images: [],
    audio: { uri: "", sampleRate: 16000, path: "none" },
    asr: { transcript: "" },
    response: { evidenceAttested: [] },
  };

  it("names the window's frames with resolvable uris", () => {
    const refs = withWindowFrameRefs(placeholder, [{ seq: 4 }, { seq: 7 }, { seq: 8 }], "job-9")!;
    expect(refs.frames).toEqual([
      { seq: 4, uri: "/jobs/job-9/frames/4" },
      { seq: 7, uri: "/jobs/job-9/frames/7" },
      { seq: 8, uri: "/jobs/job-9/frames/8" },
    ]);
    // one ref per frame that was actually in the window
    expect(refs.frames).toHaveLength(3);
    // the rest of the capture survives untouched
    expect(refs.prompt).toBe("p");
    expect(refs.audio?.path).toBe("none");
  });

  it("leaves the analysis alone when the rail has no global seq (VOD path)", () => {
    const untouched = withWindowFrameRefs(placeholder, [{}, {}], "job-9");
    expect(untouched).toBe(placeholder);
    expect(untouched!.frames[0].uri).toBe("");
    // no frames, no analysis: both no-ops
    expect(withWindowFrameRefs(placeholder, [], "job-9")).toBe(placeholder);
    expect(withWindowFrameRefs(undefined, [{ seq: 1 }], "job-9")).toBeUndefined();
  });
});
