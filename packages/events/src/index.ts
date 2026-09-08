// Shared contracts for highlights.live.
// Freeze these before wiring UI or models. Generated as JSON Schema for the
// Python runners + frontend. Any new required field is a version bump.
import { z } from "zod";

export const MAX_TRACKS = 2 as const;

// --- geometry / detector primitives ---------------------------------------

export const BBoxSchema = z.tuple([
  z.number(), // x1 (normalized 0..1)
  z.number(), // y1
  z.number(), // x2
  z.number(), // y2
]);
export type BBox = z.infer<typeof BBoxSchema>;

export const TrackKindSchema = z.enum([
  "player",
  "vehicle",
  "ball",
  "proj",
  "structure",
  "unknown",
]);
export type TrackKind = z.infer<typeof TrackKindSchema>;

export const TrackObservationSchema = z.object({
  trackId: z.string(),
  slot: z.union([z.literal(0), z.literal(1)]), // 0 | 1
  bbox: BBoxSchema,
  kind: TrackKindSchema,
  label: z.string().optional(),
  lostFrames: z.number().int().min(0).default(0),
});
export type TrackObservation = z.infer<typeof TrackObservationSchema>;

export const DetectedObjectSchema = z.object({
  label: z.string(),
  confidence: z.number().min(0).max(1).default(0),
  bbox: BBoxSchema,
});
export type DetectedObject = z.infer<typeof DetectedObjectSchema>;

// --- observations / events -------------------------------------------------

export const FrameObservationSchema = z.object({
  type: z.literal("observation"),
  sessionId: z.string(),
  streamId: z.string().optional(),
  seq: z.number().int().min(0),
  timestamp: z.number(), // seconds from stream start
  tracks: z.array(TrackObservationSchema).max(MAX_TRACKS),
  objects: z.array(DetectedObjectSchema).default([]),
  ocr: z.array(z.string()).default([]),
});
export type FrameObservation = z.infer<typeof FrameObservationSchema>;

export const CandidateEventSchema = z.object({
  type: z.literal("candidate"),
  sessionId: z.string(),
  streamId: z.string().optional(),
  eventType: z.string(), // KILL | GOAL | DUNK | CLUTCH | ...
  timestamp: z.number(),
  seq: z.number().int().min(0).optional(),
});
export type CandidateEvent = z.infer<typeof CandidateEventSchema>;

// --- decide --------------------------------------------------------------

export const ContextSnapshotSchema = z.object({
  sessionId: z.string(),
  streamId: z.string().optional(),
  gameHint: z.string().optional(),
  detectInstructions: z.string().optional(),
  eventType: z.string().optional(),
  timestamp: z.number(),
  // JPEGs passed out-of-band via multipart; here only metadata about them.
  images: z
    .array(
      z.object({
        role: z.enum(["full", "track0", "track1", "confirm"]),
        seq: z.number().int().min(0),
        timestamp: z.number(),
      })
    )
    .max(6)
    .default([]),
});
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;

export const HighlightDecisionSchema = z.object({
  isHighlight: z.boolean(),
  score: z.number().min(0).max(100),
  eventType: z.string().optional(),
  reason: z.string().optional(),
  snapshot: ContextSnapshotSchema.optional(),
});
export type HighlightDecision = z.infer<typeof HighlightDecisionSchema>;

// --- outbound events (SSE + trickle events-out) ---------------------------

export const OutboundEventSchema = z.discriminatedUnion("type", [
  FrameObservationSchema,
  CandidateEventSchema,
  z.object({
    type: z.literal("decision"),
    sessionId: z.string(),
    decision: HighlightDecisionSchema,
  }),
  z.object({
    type: z.literal("clip"),
    sessionId: z.string(),
    clipId: z.string(),
    clipUri: z.string(),
    start: z.number(),
    end: z.number(),
    decision: HighlightDecisionSchema.optional(),
  }),
  z.object({
    type: z.literal("health"),
    sessionId: z.string(),
    vramMb: z.number().int().optional(),
    slots: z.number().int().min(0).max(MAX_TRACKS).default(0),
    model: z.string().optional(),
  }),
]);
export type OutboundEvent = z.infer<typeof OutboundEventSchema>;

// --- control (WS + trickle control) ---------------------------------------

export const ControlMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("configure"),
    preferLabels: z.array(z.string()).default([]),
    sampleFps: z.number().positive().default(1),
    gameHint: z.string().optional(),
  }),
  z.object({
    type: z.literal("seed"),
    slot: z.union([z.literal(0), z.literal(1)]).optional(),
    bbox: BBoxSchema,
    kind: TrackKindSchema,
    label: z.string().optional(),
  }),
  z.object({ type: z.literal("evict"), slot: z.union([z.literal(0), z.literal(1)]) }),
  z.object({ type: z.literal("lock"), slot: z.union([z.literal(0), z.literal(1)]) }),
  z.object({ type: z.literal("analyze-still"), timestamp: z.number() }),
  z.object({ type: z.literal("confirm"), timestamp: z.number(), pre: z.number(), post: z.number() }),
  z.object({ type: z.literal("clip"), start: z.number(), end: z.number() }),
  z.object({ type: z.literal("ping") }),
]);
export type ControlMessage = z.infer<typeof ControlMessageSchema>;

// --- session ---

export const RunnerSessionSchema = z.object({
  sessionId: z.string(),
  streamId: z.string(),
  kind: z.enum(["perceive", "decide"]),
  orchAddress: z.string().optional(),
  signerState: z.unknown().optional(),
  gameHint: z.string().optional(),
  preferLabels: z.array(z.string()).default([]),
  sampleFps: z.number().positive().default(1),
});
export type RunnerSession = z.infer<typeof RunnerSessionSchema>;

// --- server public API ---

export const JobSchema = z.object({
  id: z.string(),
  source: z.enum(["file", "rtmp", "webrtc", "screenshare"]),
  sourceUrl: z.string().optional(),
  gameHint: z.string().optional(),
  preferLabels: z.array(z.string()).default([]),
  status: z.enum(["queued", "active", "done", "failed"]).default("queued"),
  perceiveSessionId: z.string().optional(),
  createdAt: z.string(),
});
export type Job = z.infer<typeof JobSchema>;

export const HighlightRecordSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  clipUri: z.string(),
  start: z.number(),
  end: z.number(),
  eventType: z.string().optional(),
  score: z.number().min(0).max(100),
  reason: z.string().optional(),
  status: z.enum(["pending", "accepted", "rejected"]).default("pending"),
  createdAt: z.string(),
});
export type HighlightRecord = z.infer<typeof HighlightRecordSchema>;
