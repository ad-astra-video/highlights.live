import { describe, it, expect } from "vitest";
import {
  JobSchema,
  HighlightRecordSchema,
  JobCandidateSchema,
  HighlightTriggerSchema,
} from "../src/index";

describe("ADAAAA-6798 job title + per-highlight trigger contract (additive)", () => {
  const baseJob = { id: "j1", source: "file", sourceUrl: "u", status: "done", createdAt: "2026-10-18T00:00:00Z" };

  it("JobSchema accepts an optional `title` and legacy jobs omit it", () => {
    const withTitle = JobSchema.parse({ ...baseJob, title: "Soccer — 3 goals, 1 near miss" });
    expect(withTitle.title).toBe("Soccer — 3 goals, 1 near miss");
    const legacy = JobSchema.parse(baseJob);
    expect(legacy.title).toBeUndefined();
    // Non-string title is rejected.
    expect(JobSchema.safeParse({ ...baseJob, title: 5 }).success).toBe(false);
  });

  it("HighlightRecordSchema accepts candidateId + trigger; legacy records degrade without error", () => {
    const trig = HighlightTriggerSchema.parse({ kind: "audio_burst", timestamp: 3.2, eventType: "GOAL" });
    const rec = HighlightRecordSchema.parse({
      id: "h1", jobId: "j1", clipUri: "u", start: 0, end: 4, score: 80,
      status: "accepted", candidateId: "c1", trigger: trig, createdAt: "2026-10-18T00:00:00Z",
    });
    expect(rec.candidateId).toBe("c1");
    expect(rec.trigger).toEqual({ kind: "audio_burst", timestamp: 3.2, eventType: "GOAL" });
    // Legacy record with neither field parses and exposes undefined (degrades to
    // the highlight's own anchored metadata; no re-inference).
    const legacy = HighlightRecordSchema.parse({
      id: "h2", jobId: "j1", clipUri: "u", start: 0, end: 4, score: 80, createdAt: "2026-10-18T00:00:00Z",
    });
    expect(legacy.candidateId).toBeUndefined();
    expect(legacy.trigger).toBeUndefined();
  });

  it("JobCandidateSchema accepts a trigger; legacy candidates degrade", () => {
    const cand = JobCandidateSchema.parse({
      id: "c1", jobId: "j1", seq: 3, timestamp: 3.2, eventType: "GOAL", score: 80,
      isHighlight: true, status: "accepted",
      trigger: { kind: "score_change", timestamp: 3.2, eventType: "GOAL", scoreBoardChanged: true },
      createdAt: "2026-10-18T00:00:00Z",
    });
    expect(cand.trigger?.kind).toBe("score_change");
    expect(cand.trigger?.scoreBoardChanged).toBe(true);
    const legacy = JobCandidateSchema.parse({
      id: "c2", jobId: "j1", seq: 0, timestamp: 1, eventType: "KILL", score: 50, isHighlight: false, createdAt: "2026-10-18T00:00:00Z",
    });
    expect(legacy.trigger).toBeUndefined();
  });

  it("HighlightTriggerSchema validates the kind enum and rejects bad input", () => {
    for (const kind of ["audio_burst", "audio_swell", "motion", "ball_signal", "score_change", "goal_line", "corroborated"]) {
      expect(HighlightTriggerSchema.safeParse({ kind, timestamp: 1, eventType: "X" }).success).toBe(true);
    }
    expect(HighlightTriggerSchema.safeParse({ kind: "nope", timestamp: 1, eventType: "X" }).success).toBe(false);
    expect(HighlightTriggerSchema.safeParse({ kind: "audio_burst", timestamp: -1, eventType: "X" }).success).toBe(false);
  });
});
