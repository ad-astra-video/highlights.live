// Shared contracts for highlights.live.
// Freeze these before wiring UI or models. Generated as JSON Schema for the
// Python runners + frontend. Any new required field is a version bump.
import { z } from "zod";

// Track capacity (INC-6 / ADAAAA-4330): the charter target is 3 live / 8 VOD
// objects. Today's code capped at 2. The schema ceiling is the VOD target (8);
// live sessions run at 3. A session advertises its ACTUAL capacity (via
// health.slots) so the UI never reserves more slots than the runner supports,
// while the schema accepts records from either mode.
export const MAX_TRACKS = 8 as const; // schema ceiling (VOD target)
export const LIVE_MAX_TRACKS = 3 as const; // live capacity
export const VOD_MAX_TRACKS = 8 as const; // VOD capacity
export type Slot = number;

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

// Tracked-object semantics (INC-6 / ADAAAA-4330). A "tracked object" is an
// on-demand, user-selected object (Florence find + SAM3 track) that persists
// across frames while on screen. We surface that persistence as:
//   - `selected`    true for the user-picked find-and-track target(s)
//   - `onScreen`    whether the target is currently being tracked this frame
//   - `ontoFrames`  cumulative frames the target has been followed while on screen
//   - `lostFrames`  frames it was absent while we were still tracking it
//   - `accuracy`    0..1 continuity metric = matched / (matched + lost) over the
//                   tracked window (1.0 = never dropped while on screen)
export const TrackObservationSchema = z.object({
  trackId: z.string(),
  slot: z.number().int().min(0).max(MAX_TRACKS - 1), // 0..7 (mode capacity caps the live session)
  bbox: BBoxSchema,
  kind: TrackKindSchema,
  label: z.string().optional(),
  lostFrames: z.number().int().min(0).default(0),
  // INC-6 tracked-object semantics (all optional -> backward compatible)
  selected: z.boolean().optional(),
  onScreen: z.boolean().optional(),
  ontoFrames: z.number().int().min(0).optional(),
  accuracy: z.number().min(0).max(1).optional(),
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

// Ball-centric candidate signal (INC-2b / research §4b). All fields optional:
// a candidate without them is exactly today's event (backward compatible, no
// version bump). perceive populates them when the ball track + pitch
// homography are available; they feed INC-3 candidate generation and the
// decide() context as corroborating signal, not the highlight arbiter.
export const BallVelocitySchema = z.object({
  // Ground-plane (homography-corrected) ball velocity in m/s, field coords.
  vxMps: z.number().optional(),
  vyMps: z.number().optional(),
  // Scalar ground-plane speed in m/s (set whenever vx/vy are available).
  speedMps: z.number().min(0),
  // Ball center in real field meters (origin/axes per the calibration used).
  posXm: z.number().optional(),
  posYm: z.number().optional(),
  // True when speedMps comes from the pitch homography; false/omitted means
  // image-space fallback (no calibrated pitch).
  homography: z.boolean().default(false),
});
export type BallVelocity = z.infer<typeof BallVelocitySchema>;

export const BallPossessionSchema = z.object({
  // Track id of the nearest player to the ball center, or "none" when the
  // nearest player is beyond the loose-ball distance threshold.
  possessingPlayerId: z.string(),
  // Distance (m) from ball center to that player's bbox centroid.
  distanceM: z.number().min(0).optional(),
});
export type BallPossession = z.infer<typeof BallPossessionSchema>;

// Stage-A audio noise-change gate signal (INC-2 / ADAAAA-4325). Cheap
// pure-DSP candidate evidence (RMS energy burst / sustained swell) — the
// gate NEVER decides a highlight; it only marks the frame as a candidate so
// the decide stage (Gemma) runs on candidates only. All fields optional on
// CandidateEvent: backward compatible, no version bump.
export const AudioSignalSchema = z.object({
  // "burst" (fast path, ~1 s from onset) or "swell" (sustained, ~3 s window).
  kind: z.enum(["burst", "swell"]),
  // Onset timestamp (seconds from stream start) of the energy change — the
  // candidate is anchored here, not at the reaction time.
  ts: z.number(),
  // When the gate actually fired (>= ts).
  firedAt: z.number().min(0),
  // firedAt - ts; must be within the live 1–5 s budget.
  onsetLatencyS: z.number().min(0).max(5),
  // Max frame energy (RMS, 0..1) in the trigger window.
  peakEnergy: z.number().min(0).max(1),
  // Quiet-baseline energy at fire time (feeds the FP-rate cost metric).
  baselineEnergy: z.number().min(0).max(1),
});
export type AudioSignal = z.infer<typeof AudioSignalSchema>;

export const CandidateEventSchema = z.object({
  type: z.literal("candidate"),
  sessionId: z.string(),
  streamId: z.string().optional(),
  eventType: z.string(), // KILL | GOAL | DUNK | CLUTCH | ...
  timestamp: z.number(),
  seq: z.number().int().min(0).optional(),
  ballVelocity: BallVelocitySchema.optional(),
  ballPossession: BallPossessionSchema.optional(),
  // Stage-A audio gate evidence (INC-2); present when the candidate was
  // triggered by the audio noise-change gate (or corroboration carried it).
  audio: AudioSignalSchema.optional(),
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
    // Optional image->field pitch homography (9 floats, row-major 3x3) for
    // the ball-centric candidate signal (INC-2b). Absent -> uncalibrated, and
    // perceive falls back to image-space velocity/possession.
    homography: z.array(z.number()).length(9).optional(),
  }),
  z.object({
    type: z.literal("seed"),
    slot: z.number().int().min(0).max(MAX_TRACKS - 1).optional(),
    bbox: BBoxSchema,
    kind: TrackKindSchema,
    label: z.string().optional(),
    selected: z.boolean().optional(), // INC-6: mark this slot as the find-and-track target
  }),
  z.object({ type: z.literal("evict"), slot: z.number().int().min(0).max(MAX_TRACKS - 1) }),
  z.object({ type: z.literal("lock"), slot: z.number().int().min(0).max(MAX_TRACKS - 1) }),
  // INC-6 / ADAAAA-4330: on-demand find-and-track — the user picks an object
  // (bbox, optionally a slot) and perceive follows it across frames while on
  // screen. `bbox` normalizes to a slot via Florence find/SAM track; this is
  // the surfaced, company-bounded version of the low-level `seed`.
  z.object({
    type: z.literal("track"),
    slot: z.number().int().min(0).max(MAX_TRACKS - 1).optional(),
    bbox: BBoxSchema.optional(), // explicit region; omit to find the nearest detected object
    kind: TrackKindSchema.optional(),
    label: z.string().optional(),
  }),
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

// Stage-A (audio noise-change gate) FP-rate + latency metric snapshot (INC-2 /
// ADAAAA-4325 slice 5). Recorded on the job when the live pass routes audio-gate
// candidates through decide(). All fields present (snapshot is atomic); the
// field itself is optional on Job so older records parse fine (no version bump).
export const StageAMetricsSnapshotSchema = z.object({
  // Candidates the gate fired that Gemma decide() actually judged.
  totalCandidates: z.number().int().min(0),
  // Gemini accepted (highlight cut) vs rejected (no highlight) of those.
  accepted: z.number().int().min(0),
  rejected: z.number().int().min(0),
  // Noise-trigger false-positive rate = rejected / total (0..1). Cost bound:
  // must be <= 0.6 (<= 60%) for the gate to stay on budget.
  fpRate: z.number().min(0).max(1),
  // Observed onset->fire latency (s) across candidates (mean / max). The gate
  // bounds each at <= 5 s; this verifies the live 1-5 s budget in aggregate.
  meanOnsetLatencyS: z.number().min(0),
  maxOnsetLatencyS: z.number().min(0),
  // True when fpRate is within the <= 60% acceptance bound (cost gate passed).
  fpRateWithinBudget: z.boolean(),
});
export type StageAMetricsSnapshot = z.infer<typeof StageAMetricsSnapshotSchema>;

export const JobSchema = z.object({
  id: z.string(),
  ownerId: z.string().optional(),
  source: z.enum(["file", "rtmp", "webrtc", "screenshare", "browser"]),
  sourceUrl: z.string().optional(),
  gameHint: z.string().optional(),
  preferLabels: z.array(z.string()).default([]),
  status: z.enum(["queued", "active", "done", "failed"]).default("queued"),
  perceiveSessionId: z.string().optional(),
  // Stage-A audio-gate metric snapshot (INC-2 / ADAAAA-4325); absent on VOD /
  // non-audio jobs and on older records.
  stageAMetrics: StageAMetricsSnapshotSchema.optional(),
  createdAt: z.string(),
});
export type Job = z.infer<typeof JobSchema>;

export const HighlightRecordSchema = z.object({
  id: z.string(),
  ownerId: z.string().optional(),
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
