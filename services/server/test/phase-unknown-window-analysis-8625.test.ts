import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCandidateNote, type AnalyzerConfig, type CandidateSignal, type DecisionResult } from "../src/analyzer";
import { AnalysisResponseSchema, JobCandidateSchema, WindowAnalysisSchema } from "@highlights/events";
import type { HighlightTrigger, JobCandidate, WindowAnalysis } from "@highlights/events";

// ADAAAA-8625: live decide window analyses were dropped on the floor.
//
// Two producers disagreed about "unknown":
//   * the live compact contract never asks the model for `phase`, so
//     `parse_decision` stamped `phase: null` on every live reply (ADAAAA-8325
//     added the field, the live rail never fills it);
//   * `AnalysisResponseSchema.phase` was `.optional()`, which accepts an ABSENT
//     phase and rejects an explicit `null`.
//
// `buildCandidateNote` parses the analysis with `WindowAnalysisSchema` inside a
// try/catch, so the rejection was logged (`[decide-note:…] window analysis
// rejected: response.phase: Expected 'live' | 'replay', received null`) and the
// whole per-window analysis — prompt, dataItems, frames, model response — was
// dropped for EVERY live window. Decides, accepts and deliveries were unaffected;
// only the job-detail request inspection lost its evidence.
//
// Fixture provenance (PROBE-FREE): `decide-live-analysis-phase-null-8625.json`
// is built from the VERBATIM `raw_reply` of a real live-rail `decide_audit` row
// on the deployed build (`highlights-live-decide:8603`, `max_tokens=400` = the
// compact live contract, job `a6d4380e`) fed through the deployed
// `_response_block(parse_decision(...))` + `_window_analysis(...)` code path. No
// probe call against the engine produced it.

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "decide-live-analysis-phase-null-8625.json"), "utf8")
) as { provenance: Record<string, string>; analysis: WindowAnalysis };

const deployedLiveAnalysis = fixture.analysis;

const cfg = (onDecision: (c: JobCandidate) => void): AnalyzerConfig =>
  ({ jobId: "j8625", onDecision } as unknown as AnalyzerConfig);

const candidate: CandidateSignal = { eventType: "AUDIO_BURST", timestamp: 0.7, seq: 1 };
const trigger: HighlightTrigger = { kind: "goal_line", timestamp: 0.7, eventType: "AUDIO_BURST" };

describe("AnalysisResponseSchema.phase tolerates null (ADAAAA-8625)", () => {
  it("accepts an explicit null phase as UNKNOWN", () => {
    const parsed = AnalysisResponseSchema.parse({ isHighlight: false, outcome: "not_highlight", phase: null });
    expect(parsed.phase).toBeNull();
  });

  it("still accepts an absent phase and both taxonomy members", () => {
    expect(AnalysisResponseSchema.parse({ isHighlight: true }).phase).toBeUndefined();
    expect(AnalysisResponseSchema.parse({ phase: "live" }).phase).toBe("live");
    expect(AnalysisResponseSchema.parse({ phase: "replay" }).phase).toBe("replay");
  });

  it("still rejects a phase outside the taxonomy", () => {
    expect(AnalysisResponseSchema.safeParse({ phase: "halftime" }).success).toBe(false);
    expect(AnalysisResponseSchema.safeParse({ phase: 42 }).success).toBe(false);
  });
});

describe("the deployed live window analysis now persists (ADAAAA-8625)", () => {
  it("parses the real producer payload that used to be rejected", () => {
    // The deployed fixture literally carries `response.phase === null`.
    expect(deployedLiveAnalysis.response?.phase).toBeNull();
    const parsed = WindowAnalysisSchema.parse(deployedLiveAnalysis);
    expect(parsed.response?.outcome).toBe("not_highlight");
    expect(parsed.response?.phase).toBeNull();
    // the evidence the job-detail view lost survives intact
    expect(parsed.prompt.length).toBeGreaterThan(0);
    expect(parsed.response?.reasoning).toContain("timeline and frames");
  });

  it("persists the analysis onto the emitted candidate note (no rejection log)", () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    const collected: JobCandidate[] = [];
    const decision: DecisionResult = {
      isHighlight: false,
      score: 0,
      eventType: "AUDIO_BURST",
      outcome: "not_highlight",
      reason: "ball in play",
      analysis: deployedLiveAnalysis,
    };
    buildCandidateNote(cfg((c) => collected.push(c)), candidate, decision, "rejected", "cid-8625", trigger, deployedLiveAnalysis);
    spy.mockRestore();

    expect(errors.join("\n")).not.toContain("window analysis rejected");
    expect(collected).toHaveLength(1);
    const persisted = JobCandidateSchema.parse(collected[0]);
    expect(persisted.analysis).toBeDefined();
    expect(persisted.analysis?.response?.outcome).toBe("not_highlight");
    // an unknown phase must not be persisted as a phase the engine never read
    expect(persisted.analysis?.response?.phase).toBeNull();
  });

  it("also persists the post-8625 producer shape (no phase key at all)", () => {
    const patched = JSON.parse(JSON.stringify(deployedLiveAnalysis)) as WindowAnalysis & {
      response: Record<string, unknown>;
    };
    delete patched.response.phase;
    const collected: JobCandidate[] = [];
    const decision: DecisionResult = {
      isHighlight: false,
      score: 0,
      eventType: "AUDIO_BURST",
      outcome: "not_highlight",
      reason: "ball in play",
      analysis: patched,
    };
    buildCandidateNote(cfg((c) => collected.push(c)), candidate, decision, "rejected", "cid-8626", trigger, patched);
    const persisted = JobCandidateSchema.parse(collected[0]);
    expect(persisted.analysis?.response?.phase).toBeUndefined();
    expect(persisted.analysis?.response?.runningSummary).toContain("defender contests");
  });
});
