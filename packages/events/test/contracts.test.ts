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
  MAX_TRACKS,
} from "../src/index";

describe("TrackObservation", () => {
  it("accepts a valid track with slot 0/1", () => {
    const t = TrackObservationSchema.parse({
      trackId: "t0",
      slot: 1,
      bbox: [0.1, 0.2, 0.3, 0.4],
      kind: "player",
    });
    expect(t.lostFrames).toBe(0);
  });
  it("rejects slot outside 0|1", () => {
    expect(() =>
      TrackObservationSchema.parse({
        trackId: "t",
        slot: 2,
        bbox: [0, 0, 1, 1],
        kind: "player",
      })
    ).toThrow();
  });
});

describe("MAX_TRACKS", () => {
  it("is 2", () => expect(MAX_TRACKS).toBe(2));
  it("FrameObservation rejects > MAX_TRACKS tracks", () => {
    const tracks = Array.from({ length: 3 }, (_, i) => ({
      trackId: `t${i}`,
      slot: i as 0 | 1,
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
