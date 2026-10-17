import { describe, it, expect } from "vitest";
import {
  MediaJobRequestSchema,
  MediaResultEventSchema,
  type MediaJobRequest,
} from "../src/index";

describe("Phase 0 media-server contract (ADAAAA-6865)", () => {
  it("parses a VOD file handoff job request", () => {
    const req: MediaJobRequest = {
      jobId: "job-123",
      source: "file",
      inputPath: "/recordings/job-123/src.mp4",
      gameHint: "basketball",
      preferLabels: ["ball", "player"],
      sampleFps: 2,
      detailFps: 8,
      decideWindowN: 6,
      frameScale: "full",
      clipBeforeS: 3,
      clipAfterS: 5,
      reasoningEffort: "none",
    };
    const parsed = MediaJobRequestSchema.parse(req);
    expect(parsed.jobId).toBe("job-123");
    expect(parsed.source).toBe("file");
    expect(parsed.preferLabels).toEqual(["ball", "player"]);
  });

  it("parses a live browser handoff with defaults for optional knobs", () => {
    const parsed = MediaJobRequestSchema.parse({ jobId: "job-9", source: "browser" });
    expect(parsed.source).toBe("browser");
    expect(parsed.preferLabels).toEqual([]);
    expect(parsed.clipBeforeS).toBeUndefined();
  });

  it("rejects an unknown media job source", () => {
    expect(() =>
      MediaJobRequestSchema.parse({ jobId: "x", source: "not-a-source" })
    ).toThrow();
  });

  it("parses a typed observation result event", () => {
    const ev = MediaResultEventSchema.parse({
      type: "observation",
      seq: 12,
      timestamp: 6.5,
      observation: {
        type: "observation",
        sessionId: "s1",
        seq: 12,
        timestamp: 6.5,
        tracks: [],
        objects: [],
        ocr: [],
      },
    });
    expect(ev.type).toBe("observation");
  });

  it("parses a typed candidate + highlight result event and rejects a missing highlight field", () => {
    const cand = MediaResultEventSchema.parse({
      type: "candidate",
      seq: 20,
      timestamp: 10,
      candidate: {
        type: "candidate",
        sessionId: "s1",
        eventType: "GOAL",
        timestamp: 10,
        seq: 20,
      },
    });
    expect(cand.type).toBe("candidate");

    const hl = MediaResultEventSchema.parse({
      type: "highlight",
      seq: 20,
      timestamp: 10,
      highlight: {
        id: "h1",
        jobId: "job-9",
        clipUri: "/clips/h1.mp4",
        start: 7,
        end: 15,
        eventType: "GOAL",
        score: 90,
        status: "accepted",
        createdAt: "2026-10-17T00:00:00.000Z",
      },
    });
    expect(hl.type).toBe("highlight");

    // A highlight event missing the highlight payload must be rejected.
    expect(() => MediaResultEventSchema.parse({ type: "highlight", seq: 20 })).toThrow();
  });

  it("parses a stage-A metrics and cost result event", () => {
    const m = MediaResultEventSchema.parse({
      type: "stageAMetrics",
      metrics: {
        totalCandidates: 10,
        accepted: 4,
        rejected: 6,
        fpRate: 0.6,
        meanOnsetLatencyS: 2.1,
        maxOnsetLatencyS: 4.9,
        fpRateWithinBudget: true,
      },
    });
    expect(m.type).toBe("stageAMetrics");

    const c = MediaResultEventSchema.parse({ type: "cost", costUsd: 0.42, perceiveSessionS: 90 });
    expect(c.type).toBe("cost");
  });
});
