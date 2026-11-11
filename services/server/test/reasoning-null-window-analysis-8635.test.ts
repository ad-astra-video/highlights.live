import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCandidateNote, type AnalyzerConfig, type CandidateSignal, type DecisionResult } from "../src/analyzer";
import { AnalysisResponseSchema, JobCandidateSchema, WindowAnalysisSchema } from "@highlights/events";
import type { HighlightTrigger, JobCandidate, WindowAnalysis } from "@highlights/events";

// ADAAAA-8635: the same drop, one field over from ADAAAA-8625.
//
// `phase` was fixed on both sides. `reasoning` was not: the decide boundary
// stamped it unconditionally, so a decision built WITHOUT a rationale reached
// the wire as an explicit `"reasoning": null`. Two producers do that, and the
// measured one on job 22ff6ca2-96c0-4b97-bcb3-d762c14e6b1a was the second:
//   * `_response_block` used `decision.get("reasoning")`, which is `None` for a
//     decision dict that never had the key;
//   * the deterministic rule-fallback dict has no `reasoning` key at all — a
//     prose (unparseable) gemma reply takes that path. Six `decide_audit` rows in
//     that job carry prose instead of JSON, and one window lost its whole
//     analysis block: `window analysis rejected: response.reasoning: Expected
//     string, received null`.
//
// `AnalysisResponseSchema.reasoning` was `.optional()`: it accepted an ABSENT
// key and rejected an explicit null, so `WindowAnalysisSchema.parse` in
// `buildCandidateNote` threw and its try/catch deleted the whole per-window
// analysis (prompt, dataItems, frames, response).
//
// Fixture provenance (PROBE-FREE): `decide-live-analysis-reasoning-null-8635.json`
// is the verbatim analysis capture of the DEPLOYED producer build (`f1e7cc3`)
// on the rule-fallback path — `decide_with_gemma(..., url=unreachable)` ->
// `_window_analysis(response=_response_block(result))`. That is exactly the shape
// the live server rejected for the prose replies measured in job 22ff6ca2. No
// decide/gemma call produced it.

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "decide-live-analysis-reasoning-null-8635.json"), "utf8")
) as { provenance: Record<string, string>; analysis: WindowAnalysis };

const deployedRuleFallbackAnalysis = fixture.analysis;

const cfg = (onDecision: (c: JobCandidate) => void): AnalyzerConfig =>
  ({ jobId: "j8635", onDecision } as unknown as AnalyzerConfig);

const candidate: CandidateSignal = { eventType: "BIG_PLAY", timestamp: 12.0, seq: 0 };
const trigger: HighlightTrigger = { kind: "audio_burst", timestamp: 12.0, eventType: "BIG_PLAY" };

describe("AnalysisResponseSchema tolerates a null optional audit string (ADAAAA-8635)", () => {
  it("accepts an explicit null reasoning as 'no rationale'", () => {
    const parsed = AnalysisResponseSchema.parse({ isHighlight: false, outcome: "not_highlight", reasoning: null });
    expect(parsed.reasoning).toBeNull();
  });

  it("still accepts an absent reasoning and a real one", () => {
    expect(AnalysisResponseSchema.parse({ isHighlight: true }).reasoning).toBeUndefined();
    expect(AnalysisResponseSchema.parse({ reasoning: "observed, then tested" }).reasoning).toBe("observed, then tested");
  });

  it("tolerates null on the sibling optional strings the same producers omit", () => {
    // the rule-fallback dict / a raw group verdict can leave any of these out,
    // and each one used to delete the whole analysis on its own
    const parsed = AnalysisResponseSchema.parse({
      isHighlight: false,
      eventType: null,
      reason: null,
      reasoning: null,
      runningSummary: null,
      phase: null,
    });
    expect(parsed.eventType).toBeNull();
    expect(parsed.reason).toBeNull();
    expect(parsed.reasoning).toBeNull();
    expect(parsed.runningSummary).toBeNull();
    expect(parsed.phase).toBeNull();
  });
});

describe("the rule-fallback window analysis now persists (ADAAAA-8635)", () => {
  it("parses the real producer payload that used to be rejected", () => {
    // the deployed fixture literally carries `response.reasoning === null`
    expect(deployedRuleFallbackAnalysis.response?.reasoning).toBeNull();
    // ... and no phase key at all (ADAAAA-8625 behaviour, unchanged)
    expect("phase" in (deployedRuleFallbackAnalysis.response as object)).toBe(false);
    const parsed = WindowAnalysisSchema.parse(deployedRuleFallbackAnalysis);
    expect(parsed.response?.outcome).toBe("not_highlight");
    expect(parsed.response?.reasoning).toBeNull();
    expect(parsed.dataItems.length).toBeGreaterThan(0);
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
      eventType: "BIG_PLAY",
      outcome: "not_highlight",
      reason: "no attested goal criterion",
      analysis: deployedRuleFallbackAnalysis,
    };
    buildCandidateNote(cfg((c) => collected.push(c)), candidate, decision, "rejected", "cid-8635", trigger, deployedRuleFallbackAnalysis);
    spy.mockRestore();

    expect(errors.join("\n")).not.toContain("window analysis rejected");
    expect(collected).toHaveLength(1);
    const persisted = JobCandidateSchema.parse(collected[0]);
    expect(persisted.analysis).toBeDefined();
    expect(persisted.analysis?.response?.outcome).toBe("not_highlight");
    expect(persisted.analysis?.dataItems.length).toBeGreaterThan(0);
  });

  it("also persists the post-8635 producer shape (no reasoning key at all)", () => {
    const patched = JSON.parse(JSON.stringify(deployedRuleFallbackAnalysis)) as WindowAnalysis & {
      response: Record<string, unknown>;
    };
    delete patched.response.reasoning;
    const collected: JobCandidate[] = [];
    const decision: DecisionResult = {
      isHighlight: false,
      score: 0,
      eventType: "BIG_PLAY",
      outcome: "not_highlight",
      reason: "no attested goal criterion",
      analysis: patched,
    };
    buildCandidateNote(cfg((c) => collected.push(c)), candidate, decision, "rejected", "cid-8635b", trigger, patched);
    const persisted = JobCandidateSchema.parse(collected[0]);
    expect(persisted.analysis?.response?.reasoning).toBeUndefined();
    // the evidence the job-detail view needs survives
    expect(persisted.analysis?.prompt).toBe("");
    expect(persisted.analysis?.response?.source).toBe("rule-fallback");
  });

  it("keeps a real rationale byte-for-byte", () => {
    const withReasoning = JSON.parse(JSON.stringify(deployedRuleFallbackAnalysis)) as WindowAnalysis & {
      response: Record<string, unknown>;
    };
    withReasoning.response.reasoning = "observed the net ripple first";
    const parsed = WindowAnalysisSchema.parse(withReasoning);
    expect(parsed.response?.reasoning).toBe("observed the net ripple first");
  });
});
