import { describe, it, expect } from "vitest";
import {
  FrameObservationSchema,
  CandidateEventSchema,
  BallVelocitySchema,
  BallPossessionSchema,
  AudioSignalSchema,
  ContextSnapshotSchema,
  HighlightDecisionSchema,
  OutboundEventSchema,
  ControlMessageSchema,
  TrackObservationSchema,
  RunnerSessionSchema,
  JobSchema,
  StageAMetricsSnapshotSchema,
  MAX_TRACKS,
  LIVE_MAX_TRACKS,
} from "../src/index";

describe("TrackObservation", () => {
  it("accepts a valid track with slot 1 and tracked-object semantics", () => {
    const t = TrackObservationSchema.parse({
      trackId: "t0",
      slot: 1,
      bbox: [0.1, 0.2, 0.3, 0.4],
      kind: "player",
      selected: true,
      onScreen: true,
      ontoFrames: 12,
      accuracy: 0.92,
    });
    expect(t.lostFrames).toBe(0);
    expect(t.selected).toBe(true);
    expect(t.accuracy).toBe(0.92);
  });
  it("accepts slots up to VOD max (7)", () => {
    const t = TrackObservationSchema.parse({
      trackId: "t7",
      slot: 7,
      bbox: [0, 0, 1, 1],
      kind: "player",
    });
    expect(t.slot).toBe(7);
  });
  it("rejects slot >= MAX_TRACKS and negative slot", () => {
    expect(() =>
      TrackObservationSchema.parse({ trackId: "t", slot: 8, bbox: [0, 0, 1, 1], kind: "player" })
    ).toThrow();
    expect(() =>
      TrackObservationSchema.parse({ trackId: "t", slot: -1, bbox: [0, 0, 1, 1], kind: "player" })
    ).toThrow();
  });
  it("rejects out-of-range accuracy", () => {
    expect(() =>
      TrackObservationSchema.parse({ trackId: "t", slot: 0, bbox: [0, 0, 1, 1], kind: "player", accuracy: 1.2 })
    ).toThrow();
  });
});

describe("MAX_TRACKS", () => {
  it("is 8 (VOD chart target)", () => expect(MAX_TRACKS).toBe(8));
  it("live capacity is 3 (charter target)", () => expect(LIVE_MAX_TRACKS).toBe(3));
  it("FrameObservation rejects > MAX_TRACKS tracks", () => {
    const tracks = Array.from({ length: 9 }, (_, i) => ({
      trackId: `t${i}`,
      slot: i,
      bbox: [0, 0, 1, 1] as [number, number, number, number],
      kind: "player" as const,
    }));
    expect(() => FrameObservationSchema.parse({ type: "observation", sessionId: "s", seq: 1, timestamp: 1, tracks })).toThrow();
  });
});

describe("FrameObservation", () => {
  it("parses a full observation with 2 tracks", () => {
    const obs = FrameObservationSchema.parse({
      type: "observation",
      sessionId: "sess-1",
      streamId: "job-1",
      seq: 5,
      timestamp: 6.0,
      tracks: [
        { trackId: "a", slot: 0, bbox: [0, 0, 0.5, 0.9], kind: "player" },
        { trackId: "b", slot: 1, bbox: [0.2, 0.1, 0.8, 0.7], kind: "vehicle", lostFrames: 2 },
      ],
      objects: [{ label: "agent", confidence: 0.9, bbox: [0, 0, 0.5, 0.9] }],
      ocr: ["12-0"],
    });
    expect(obs.tracks.length).toBe(2);
    expect(obs.ocr).toEqual(["12-0"]);
  });
});

describe("OutboundEvent", () => {
  it("accepts all union members", () => {
    const evts = [
      { type: "observation", sessionId: "s", seq: 1, timestamp: 0, tracks: [] },
      { type: "candidate", sessionId: "s", eventType: "KILL", timestamp: 3 },
      { type: "decision", sessionId: "s", decision: { isHighlight: true, score: 88, eventType: "KILL" } },
      { type: "clip", sessionId: "s", clipId: "c1", clipUri: "/clips/c1.mp4", start: 2, end: 12 },
      { type: "health", sessionId: "s", slots: 2, model: "florence-2" },
    ];
    for (const e of evts) {
      expect(OutboundEventSchema.parse(e).type).toBe(e.type);
    }
  });
  it("rejects a bad eventType string", () => {
    expect(() => OutboundEventSchema.parse({ type: "nope", sessionId: "s" })).toThrow();
  });
});

describe("ControlMessage", () => {
  it("parses configure + seed + ping", () => {
    expect(ControlMessageSchema.parse({ type: "configure", preferLabels: ["agent"], sampleFps: 2 }).type).toBe("configure");
    expect(ControlMessageSchema.parse({ type: "seed", bbox: [0, 0, 1, 1], kind: "player", label: "p1" }).type).toBe("seed");
    expect(ControlMessageSchema.parse({ type: "ping" }).type).toBe("ping");
  });
});

describe("Ball signal on CandidateEvent (INC-2b)", () => {
  it("accepts a candidate WITHOUT ball fields (backward compatible)", () => {
    const c = CandidateEventSchema.parse({
      type: "candidate",
      sessionId: "s",
      eventType: "GOAL",
      timestamp: 12.5,
      seq: 7,
    });
    expect(c.ballVelocity).toBeUndefined();
    expect(c.ballPossession).toBeUndefined();
  });

  it("accepts homography-corrected velocity + possession", () => {
    const c = CandidateEventSchema.parse({
      type: "candidate",
      sessionId: "s",
      eventType: "GOAL",
      timestamp: 12.5,
      ballVelocity: {
        vxMps: 24.1,
        vyMps: -3.2,
        speedMps: 24.3,
        posXm: 12.5,
        posYm: -3.0,
        homography: true,
      },
      ballPossession: { possessingPlayerId: "track-9", distanceM: 1.4 },
    });
    expect(c.ballVelocity?.homography).toBe(true);
    expect(c.ballVelocity?.speedMps).toBe(24.3);
    expect(c.ballPossession?.possessingPlayerId).toBe("track-9");
  });

  it("accepts loose ball (possession 'none') and image-space fallback", () => {
    const v = BallVelocitySchema.parse({ speedMps: 18.0 });
    expect(v.homography).toBe(false);
    const p = BallPossessionSchema.parse({ possessingPlayerId: "none" });
    expect(p.distanceM).toBeUndefined();
    const c = CandidateEventSchema.parse({
      type: "candidate",
      sessionId: "s",
      eventType: "MOVE",
      timestamp: 1.0,
      ballVelocity: { speedMps: 18.0 },
      ballPossession: { possessingPlayerId: "none" },
    });
    expect(c.ballVelocity?.speedMps).toBe(18.0);
    expect(c.ballPossession?.possessingPlayerId).toBe("none");
  });

  it("rejects negative speedMps / distanceM", () => {
    expect(() => BallVelocitySchema.parse({ speedMps: -1 })).toThrow();
    expect(
      () => BallPossessionSchema.parse({ possessingPlayerId: "t", distanceM: -0.5 })
    ).toThrow();
  });
});

describe("Audio gate signal on CandidateEvent (INC-2)", () => {
  const audio = {
    kind: "burst" as const,
    ts: 12.0,
    firedAt: 12.9,
    onsetLatencyS: 0.9,
    peakEnergy: 0.62,
    baselineEnergy: 0.02,
  };

  it("accepts a candidate WITHOUT audio (backward compatible)", () => {
    const c = CandidateEventSchema.parse({
      type: "candidate",
      sessionId: "s",
      eventType: "GOAL",
      timestamp: 12.5,
    });
    expect(c.audio).toBeUndefined();
  });

  it("accepts an audio burst signal (candidate, not decision)", () => {
    const c = CandidateEventSchema.parse({
      type: "candidate",
      sessionId: "s",
      eventType: "CROWD",
      timestamp: audio.ts,
      audio,
    });
    expect(c.audio?.kind).toBe("burst");
    expect(c.audio?.onsetLatencyS).toBeLessThanOrEqual(5);
    // no highlight/decision field on the candidate itself
    expect((c as Record<string, unknown>).isHighlight).toBeUndefined();
  });

  it("accepts a sustained swell with 3 s onset latency", () => {
    const c = CandidateEventSchema.parse({
      type: "candidate",
      sessionId: "s",
      eventType: "CROWD",
      timestamp: 30.0,
      audio: { ...audio, kind: "swell", ts: 30.0, firedAt: 33.0, onsetLatencyS: 3.0 },
    });
    expect(c.audio?.kind).toBe("swell");
    expect(c.audio?.onsetLatencyS).toBe(3.0);
  });

  it("rejects onset latency outside the 1-5 s live budget", () => {
    expect(() =>
      AudioSignalSchema.parse({ ...audio, onsetLatencyS: 5.5 })
    ).toThrow();
    expect(() => AudioSignalSchema.parse({ ...audio, onsetLatencyS: -0.1 })).toThrow();
  });

  it("rejects unknown kind and out-of-range energies", () => {
    expect(() => AudioSignalSchema.parse({ ...audio, kind: "quiet" })).toThrow();
    expect(() => AudioSignalSchema.parse({ ...audio, peakEnergy: 1.5 })).toThrow();
    expect(() =>
      AudioSignalSchema.parse({ ...audio, baselineEnergy: -0.1 })
    ).toThrow();
  });
});

describe("ContextSnapshot + HighlightDecision", () => {
  it("round-trips", () => {
    const snap = ContextSnapshotSchema.parse({
      sessionId: "s",
      eventType: "KILL",
      timestamp: 12,
      images: [{ role: "full", seq: 12, timestamp: 12 }],
    });
    const d = HighlightDecisionSchema.parse({ isHighlight: true, score: 90, snapshot: snap });
    expect(d.snapshot?.images[0].role).toBe("full");
  });
});

describe("RunnerSession", () => {
  it("defaults sampleFps + prefLabels", () => {
    const s = RunnerSessionSchema.parse({ sessionId: "x", streamId: "j", kind: "perceive" });
    expect(s.sampleFps).toBe(1);
    expect(s.preferLabels).toEqual([]);
  });
});

describe("Job + StageAMetricsSnapshot (INC-2 / ADAAAA-4325 slice 5: FP-rate metric)", () => {
  it("accepts a job carrying a stageAMetrics snapshot; field is optional", () => {
    const j = JobSchema.parse({
      id: "job",
      source: "rtmp",
      status: "done",
      createdAt: "2026-09-24T00:00:00Z",
      stageAMetrics: {
        totalCandidates: 5,
        accepted: 2,
        rejected: 3,
        fpRate: 0.6,
        meanOnsetLatencyS: 1.2,
        maxOnsetLatencyS: 4.8,
        fpRateWithinBudget: true,
      },
    });
    expect(j.stageAMetrics?.fpRate).toBe(0.6);
    expect(j.stageAMetrics?.fpRateWithinBudget).toBe(true);
    // Older / non-audio jobs without the field still parse.
    expect(JobSchema.parse({ id: "j2", source: "file", createdAt: "2026-09-24T00:00:00Z" }).stageAMetrics).toBeUndefined();
  });

  it("rejects an out-of-range fpRate or corrupted snapshot counts", () => {
    const base = {
      totalCandidates: 5, accepted: 2, rejected: 3, fpRate: 0.6,
      meanOnsetLatencyS: 1, maxOnsetLatencyS: 4, fpRateWithinBudget: true,
    };
    expect(() => StageAMetricsSnapshotSchema.parse({ ...base, fpRate: 1.5 })).toThrow();
    expect(() => StageAMetricsSnapshotSchema.parse({ ...base, rejected: -1 })).toThrow();
  });

  it("accepts the detail-first VOD cost/volume fields, all optional (ADAAAA-4954 §4.5)", () => {
    const j = JobSchema.parse({
      id: "job-vod",
      source: "file",
      status: "done",
      createdAt: "2026-09-26T00:00:00Z",
      sampleFps: 2,
      frameScale: "640:360",
      decideWindowN: 24,
      framesAnalyzed: 10800,
      candidatesTriggered: 14,
      decideCalls: 14,
      perceiveSessionS: 5400,
      costUsd: 0.16,
      scheduledAt: "2026-09-26T00:00:00Z",
      completedAt: "2026-09-26T01:30:00Z",
    });
    expect(j.sampleFps).toBe(2);
    expect(j.costUsd).toBe(0.16);
    expect(j.decideWindowN).toBe(24);
    // Old records without the fields still parse (no version bump).
    expect(JobSchema.parse({ id: "j", source: "file", createdAt: "2026-09-24T00:00:00Z" }).costUsd).toBeUndefined();
  });
});
