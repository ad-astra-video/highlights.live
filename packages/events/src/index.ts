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

// Tracked-object semantics (INC-6 / ADAAAA-4330; definition ADAAAA-5050).
// A "tracked object" is a detected object promoted into a persistent identity
// (a Track) carried across frames while on screen. Selection rules: operator /
// on-demand `track`/`seed` (selected target), auto-detection into a free slot
// up to the mode capacity (live 3 / VOD 8), or the dedicated eviction-guarded
// ball slot. ID-persistence rules: a detection keeps a track's identity when
// it IoU-overlaps (>=0.05) or is within the centroid gate (<0.20); an unmatched
// track survives `lost_before_evict` (8) frames unless locked; selected/locked
// slots are never auto-evicted. See docs/tracked-object.md (authoritative) and
// the labeled eval set + accuracy harness (evals/track_*.py). We surface the
// persistence on selected targets as:
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

// --- Florence-2 detection training data (ADAAAA-5164, fine-tune data path) --
//
// The unit of data built by the Dataset Curation page and handed to a
// Florence-2 fine-tune job. Frozen as a contract: the webapp curates against
// it, the server validates with it before writing `evals/*_manifest.jsonl`,
// and a future training leg consumes it verbatim. Any new required field is a
// version bump.
//
// Closed 5-label soccer vocabulary. Mirrors the soccer alias group in
// services/perceive/app/florence.py `_GAME_VOCABULARIES["soccer"]` so curated
// labels are the same labels the deployed detector prefers.
export const SOCCER_TRAINING_LABELS = [
  "player",
  "soccer ball",
  "goalkeeper",
  "goal",
  "referee",
] as const;
export type TrainingLabel = (typeof SOCCER_TRAINING_LABELS)[number];

export const TrainingLabelSchema = z.enum(SOCCER_TRAINING_LABELS);

// A bbox whose four coordinates are enforced normalized 0..1 with a valid
// (non-empty) ordering -- stricter than BBoxSchema, because a fine-tune sample
// must never carry an out-of-frame or inverted box.
export const NormalizedBBoxSchema = z
  .tuple([
    z.number().min(0).max(1), // x1
    z.number().min(0).max(1), // y1
    z.number().min(0).max(1), // x2
    z.number().min(0).max(1), // y2
  ])
  .refine(([x1, , x2]) => x2 >= x1, { message: "bbox x2 must be >= x1" })
  .refine(([, y1, , y2]) => y2 >= y1, { message: "bbox y2 must be >= y1" });
export type NormalizedBBox = z.infer<typeof NormalizedBBoxSchema>;

// One labelled detection in a curated frame. `bbox` is normalized 0..1
// [x1,y1,x2,y2] (top-left, bottom-right), the same convention as BBoxSchema
// on the live/VOD detection path, but range-checked for the training set.
export const DetectionTrainingBoxSchema = z.object({
  label: TrainingLabelSchema,
  bbox: NormalizedBBoxSchema,
});
export type DetectionTrainingBox = z.infer<typeof DetectionTrainingBoxSchema>;

// One frame's worth of labelled detections -- the row unit of the train/val
// manifests. `imageRef` is a stable pointer to the extracted frame (object
// storage key, or a file path under `data/training/`).
export const DetectionTrainingSampleSchema = z.object({
  id: z.string(),
  imageRef: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  objects: z.array(DetectionTrainingBoxSchema),
});
export type DetectionTrainingSample = z.infer<typeof DetectionTrainingSampleSchema>;

// Which side of the 85/15 train/val split a sample lands on (assigned at
// export time; not part of a sample's identity).
export const SampleSplitSchema = z.enum(["train", "val"]);
export type SampleSplit = z.infer<typeof SampleSplitSchema>;

// A persisted, server-side dataset record (ADAAAA-5396, Change 3). When a
// curated dataset is "sent" from the curation UI (POST /training/manifests),
// the server persists a row of this shape so it is retrievable across reloads
// and new sessions while the owning account stays active on a paid
// (non-starter) plan. The train/val manifests carry the same
// DetectionTrainingSample rows the curation page exports; `imageRefs` is the
// flattened, de-duplicated list of frame image references so a persisted
// dataset can be re-materialized or zipped for the user to keep locally.
export const DatasetSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  /** Optional human label the user gives the dataset (defaults to a timestamp). */
  name: z.string().optional(),
  train: z.array(DetectionTrainingSampleSchema),
  val: z.array(DetectionTrainingSampleSchema),
  imageRefs: z.array(z.string()),
  trainCount: z.number().int().nonnegative(),
  valCount: z.number().int().nonnegative(),
  status: z.enum(["active"]).default("active"),
  createdAt: z.string(),
});
export type Dataset = z.infer<typeof DatasetSchema>;

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

// Decide-leg I2 (ADAAAA-6359): goal-line / ball-outcome ground-truth signal.
// perceive emits these when the ball's ground-plane position crosses the
// goal-line plane; the decide leg uses ballOutcome as a hard gate. Optional on
// CandidateEvent: absent == no goal-line calibration / no field signal.
export const BallOutcomeSchema = z.enum([
  "goal",
  "off_target",
  "blocked",
  "no_shot",
  "cross",
]);
export type BallOutcome = z.infer<typeof BallOutcomeSchema>;

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
  // Identity of the threshold/operating point that fired, e.g.
  // `stageA/burst/1.3x` (ADAAAA-7658 AC5: the trigger record states WHICH
  // threshold produced it, so live and VOD agree on what a trigger is).
  // Optional for backward compatibility with already-persisted candidates.
  thresholdId: z.string().optional(),
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
  // Decide-leg I2 (ADAAAA-6359): goal-line crossing + ball-outcome ground
  // truth. Optional; when present the decide leg treats ballOutcome as a hard
  // gate (a non-"goal" outcome forces rejection).
  goalCrossed: z.boolean().optional(),
  ballOutcome: BallOutcomeSchema.optional(),
  // Stage-A audio gate evidence (INC-2); present when the candidate was
  // triggered by the audio noise-change gate (or corroboration carried it).
  audio: AudioSignalSchema.optional(),
  // I3 (ADAAAA-6360): a scoreboard score change was detected across the
  // candidate window — a hard, independent goal-confirmation signal. Optional:
  // absent/undefined == weak/absent evidence, never on its own a goal.
  scoreBoardChanged: z.boolean().optional(),
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
  // Increment F / ADAAAA-6465: outcome taxonomy member + near-miss flag. A
  // near miss is notable but NOT a scoring play — surfaced at a lower score and
  // flagged so downstream highlight assembly labels it distinctly.
  outcome: z.enum(["scoring_play", "near_miss", "big_play", "not_highlight"]).optional(),
  nearMiss: z.boolean().optional(),
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
    // Decide-leg I2 (ADAAAA-6359): goal-line plane spec in the calibration's
    // field coords so perceive can emit goalCrossed / ballOutcome. Absent ->
    // no goal-line signal on candidates.
    goalLine: z
      .object({
        axis: z.enum(["x", "y"]).default("y"),
        position: z.number(),
        mouthMin: z.number().optional(),
        mouthMax: z.number().optional(),
      })
      .optional(),
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
  // Latency percentiles p50 / p95 over the observed onset->fire samples (s),
  // so the live 1-5 s acceptance budget is verified on the distribution, not
  // just the mean/max. 0 when no latency sample was observed yet.
  p50LatencyS: z.number().min(0).default(0),
  p95LatencyS: z.number().min(0).default(0),
  // Explicit gemma-call FP rate (ADAAAA-4785): gemma invocations judged with no
  // true event (rejected) / total invocations on the noise-trigger path. Same
  // value as fpRate but surfaced under the acceptance's exact metric name.
  gemmaFpRate: z.number().min(0).max(1).default(0),
  // True when fpRate is within the <= 60% acceptance bound (cost gate passed).
  fpRateWithinBudget: z.boolean(),
});
export type StageAMetricsSnapshot = z.infer<typeof StageAMetricsSnapshotSchema>;

// --- live decision-trail entry (ADAAAA-6870, Increment 3 T1) ---------------
// One entry in the bounded `candidates` array carried on the Job record. It is
// the additive, persisted in-flight decision trail (candidate trigger ->
// accepted highlight) that a subscribed SSE client sees live AND that survives
// a server restart on the completed job. Distinct from JobCandidate (the
// per-candidate decide note persisted in `job_candidates`): this is the compact
// ordered trail on the job record itself. All fields optional on the parent Job
// so older records parse unchanged (no contract version bump).
export const JobDecisionSchema = z.object({
  seq: z.number().int().min(0),
  ts: z.number(),
  eventType: z.string(),
  decision: z.string(),
  highlightId: z.string().optional(),
});
export type JobDecision = z.infer<typeof JobDecisionSchema>;
// Stage-2 goal/near-miss confirmation-pass metric snapshot (ADAAAA-6797).
// Recorded on the job when the VOD pass routes un-attested goal-type candidates
// through the decide /confirm deep frame dive. Additive + optional on Job (no
// contract version bump); absent on non-confirm / older records.
export const ConfirmMetricsSnapshotSchema = z.object({
  // Confirm passes actually run (dive attempted).
  totalRuns: z.number().int().min(0),
  // Runs where the confirmation pass corrected the Stage-1 read.
  disagreed: z.number().int().min(0),
  // Stage-1 vs Stage-2 disagreement rate = disagreed / totalRuns (0..1; 0 when
  // totalRuns is 0). The core value metric for the feature.
  gapRate: z.number().min(0).max(1),
});
export type ConfirmMetricsSnapshot = z.infer<typeof ConfirmMetricsSnapshotSchema>;

// Live decide-observer cadence + decide gemma E2E latency snapshot (ADAAAA-7011).
// Recorded on a live job when the decide-observer is enabled, so the cadence +
// gemma end-to-end latency (the ~30 s budget = ~3 s cadence + gemma E2E) is
// inspectable on the Livepeer runner. Additive + optional on Job (no contract
// version bump); absent when the observer was not enabled and on older records.
export const ObserveMetricsSnapshotSchema = z.object({
  // Decide invocations that fired on the cadence.
  decideCalls: z.number().int().min(0),
  // Decisions that became an accepted highlight.
  accepted: z.number().int().min(0),
  // Max frames in a single decide payload (<= the 30-frame cap).
  maxFrames: z.number().int().min(0),
  // Mean / max decide gemma end-to-end latency (ms).
  meanE2eMs: z.number().min(0),
  maxE2eMs: z.number().min(0),
  // Mean / max content-time cadence between consecutive fired ticks (ms).
  meanCadenceMs: z.number().min(0),
  maxCadenceMs: z.number().min(0),
  // ADAAAA-7691: anchored-window evidence. `triggerFires` counts decide windows
  // the audio-trigger scheduler anchored to a trigger onset; `cadenceFires` the
  // blind-cadence ones, so `triggerFires + cadenceFires == decideCalls`. The
  // analyzer has always COMPUTED these, but they were absent from this schema,
  // so `JobSchema.parse` (store.patchJob) stripped them before persistence and
  // no reader could see an anchored-window count. Optional additive: absent on
  // records written before this field existed.
  triggerFires: z.number().int().min(0).optional(),
  cadenceFires: z.number().int().min(0).optional(),
  // ADAAAA-7007: VOD decide-observer per-call input-size + cap report. Additive
  // optional (absent on live-only / older records). `subsampledCalls>0` proves
  // the <=30-frame cap was actually exercised; `framesPerCall` is the per-call
  // decide input-size distribution (the -67% cost measure input).
  subsampledCalls: z.number().int().min(0).optional(),
  framesPerCall: z.array(z.number().int().min(0)).optional(),
  // ADAAAA-7676: live observe lag bound. A live window whose content time is
  // further behind wall time than the budget is DROPPED instead of decided
  // late; `skippedStaleWindows` is the counter that proves the queue is bounded
  // (a window labelled T+42s used to reach the feed at wall +242s). Additive
  // optional (absent on older rows / when no stale window was dropped).
  skippedStaleWindows: z.number().int().min(0).optional(),
  // ADAAAA-7758: windows a live run did NOT decide because another live job held
  // the box's single live decide slot (admission control). Additive optional:
  // absent/zero when admission control is off, which is the shipped default.
  admissionSkippedWindows: z.number().int().min(0).optional(),
  // ADAAAA-7771: live observe PIPELINING evidence. `maxDecideInFlight` is the
  // deepest in-flight decide queue the pass observed (>1 proves the in-flight
  // depth was used; the serial loop reads 1); `backpressureSkippedWindows`
  // counts cadence windows the depth itself refused (all K slots busy). Kept
  // apart from `skippedStaleWindows` (content was late) and
  // `admissionSkippedWindows` (another live job held the box slot). Additive
  // optional: absent on records written before these fields existed.
  maxDecideInFlight: z.number().int().min(0).optional(),
  backpressureSkippedWindows: z.number().int().min(0).optional(),
  // ADAAAA-7799: decide opportunities the rate cap DROPPED (LIVE_DECIDE_KEEP_RATIO
  // keeps only a fraction of them). Additive optional: absent when the cap is off.
  throttleSkippedWindows: z.number().int().min(0).optional(),
  // ADAAAA-7808: stale FRAMES the lag budget dropped (`droppedFrames` on the
  // `[live-lag] summary` line) and the SUPPLY skip total (stale + backpressure +
  // admission). `supplySkippedWindows` never includes `throttleSkippedWindows`:
  // the throttle is a funded rate decision, the supply total is the rail's own
  // shortfall. Additive optional.
  droppedFrames: z.number().int().min(0).optional(),
  supplySkippedWindows: z.number().int().min(0).optional(),
  // ADAAAA-7774: the LIVE perceive stride (ingest -> analysis fps). The live
  // ingest delivers ~5 fps while the decide window only carries ~2 fps of
  // content, so the pass now CONSUMES frames at the analysis fps and runs the
  // adaptive perceive cadence on that set: `perceiveCalls < framesAnalyzed`
  // proves the cool stride, `framesStrided` of `framesSeen` never entered
  // perceive at all (they were never perceived, recorded or seeded — each
  // recorded skipped frame carries an EMPTY seed, i.e. `signal: undefined`).
  // Additive optional: absent on records written before this field existed and
  // on the media-rail share (its perceive runs in the media node).
  perceive: z
    .object({
      framesSeen: z.number().int().min(0),
      framesAnalyzed: z.number().int().min(0),
      framesStrided: z.number().int().min(0),
      perceiveCalls: z.number().int().min(0),
      perceiveSkipped: z.number().int().min(0),
      perceiveBudgetSkipped: z.number().int().min(0).optional(),
      perceiveHotCalls: z.number().int().min(0),
      analysisFps: z.number().min(0),
      // ADAAAA-7774: mean measured `client.analyze` wall cost (ms); the
      // cost-aware stride steps by it, so `> 1000/analysisFps` proves the box's
      // shared-GPU perceive limit (not the ingest rate) is the binding rate.
      perceiveMeanCostMs: z.number().min(0).optional(),
    })
    .optional(),
  // Worst / mean wall-clock content-vs-wall lag (ms) seen on a dropped frame,
  // and the worst COMPLETED lag (ms) of a decided window (what a live viewer
  // experiences: `summaryLog` `windowTs` vs wall `ts`).
  maxLagMs: z.number().min(0).optional(),
  meanLagMs: z.number().min(0).optional(),
  maxCompletedLagMs: z.number().min(0).optional(),
  // ADAAAA-7707: the Stage-B (band-limited whistle) crowding counters. The CEO
  // spend envelope (ADAAAA-7713) makes the whistle SHARE of a window's decides
  // the hard tripwire (>25%) and added volume the alert threshold, so both
  // numbers must be measurable on a deployed window instead of a post-hoc
  // audit. `whistleFires` = whistle triggers the run recorded (the emission
  // volume); `whistleDecides` = decide windows anchored on a whistle trigger
  // (the crowding numerator); `whistleShare` = whistleDecides / decideCalls.
  // Additive optional: absent on records written before this field existed.
  whistleFires: z.number().int().min(0).optional(),
  whistleDecides: z.number().int().min(0).optional(),
  whistleShare: z.number().min(0).optional(),
  // ADAAAA-7722: the crowding DENOMINATOR, persisted next to the numerator so
  // `whistleShare` is computable from TWO explicit counts (`whistleDecides /
  // allDecides`) instead of only from the `decideCalls` alias. `allDecides`
  // counts EVERY decide invocation this run made (whistle-anchored + all other
  // anchoring), so it must equal `decideCalls`; the pair is what makes the
  // ADAAAA-7713 25% tripwire machine-checkable post-run. Additive optional.
  allDecides: z.number().int().min(0).optional(),
  // ADAAAA-7722: the anchored window RECORDS, one entry per whistle-anchored
  // decide, carrying the trigger identity that scheduled it
  // (`stageB/whistle/2.4-3.4k/5x/0.3s`). Before this the family existed only
  // inside the in-flight `ObserveDecidePayload.trigger`, so a whistle decide
  // could not be identified after the run. Bounded (newest kept) and additive
  // optional — absent on records written before this field existed.
  whistleWindows: z
    .array(
      z.object({
        centerTs: z.number(),
        thresholdId: z.string(),
        family: z.string(),
      })
    )
    .optional(),
  // ADAAAA-7723: the audio-trigger coverage LEDGER. Every trigger the scheduler
  // ACCEPTED must be accounted for — `accepted === fired + covered + expired +
  // pending` — so a share can never report a healthy `triggers` count while
  // silently dropping the anchored analysis of an audible event (measured on
  // the deployed rail: 4 accepted, 1 anchored, and no counter saying where the
  // other 3 went). `fired` = anchored a decide window; `covered` = a decided
  // window judged its onset; `expired` = its frames left the retained window;
  // `coalesced` = folded into an accepted neighbour (never queued); `invalid` =
  // a structurally broken record. Additive optional (older rows lack it).
  triggerWindows: z
    .object({
      accepted: z.number().int().min(0),
      coalesced: z.number().int().min(0),
      invalid: z.number().int().min(0),
      covered: z.number().int().min(0),
      expired: z.number().int().min(0),
      fired: z.number().int().min(0),
      pending: z.number().int().min(0).optional(),
    })
    .optional(),
  // ADAAAA-7723: whether that ledger balances (`unaccounted === 0`).
  triggerReconciled: z.boolean().optional(),
  // ADAAAA-7723 AC-2: onset -> judging-window latency per trigger FAMILY. The
  // anchored arm is the decide window the trigger anchored itself; the covered
  // arm is the window that judged its onset without anchoring it (the only
  // latency a covered trigger has); `judged*` pools both. Reported instead of
  // one pooled number so the Stage-B (whistle) path is measurable on its own.
  triggerLatencyByFamily: z
    .array(
      z.object({
        family: z.string(),
        samples: z.number().int().min(0),
        p50Ms: z.number().min(0),
        p95Ms: z.number().min(0),
        maxMs: z.number().min(0),
        coveredSamples: z.number().int().min(0),
        coveredP50Ms: z.number().min(0),
        coveredP95Ms: z.number().min(0),
        judgedSamples: z.number().int().min(0),
        judgedP50Ms: z.number().min(0),
        judgedP95Ms: z.number().min(0),
      })
    )
    .optional(),
  // ADAAAA-8005 (gate 3): the per-row TRIGGER -> DELIVERED latency, the metric
  // the live gate-3 AC ("trigger -> delivered p50 <= 5 s") is graded from.
  // "Delivered" is pinned as the instant the highlight row is READABLE on the
  // delivered surface (the store write-through acked), and each row carries the
  // stage breakdown so a replay can blame fire lag / decide e2e / accept wait /
  // accept work / persist ack instead of joining `[live-lag]` + `[ingest-gap]`
  // log families by hand. Additive optional: absent on records written before
  // this field existed, and on a run that delivered no highlight.
  deliveredLatency: z
    .object({
      samples: z.number().int().min(0),
      p50Ms: z.number().min(0),
      p95Ms: z.number().min(0),
      maxMs: z.number().min(0),
      rows: z
        .array(
          z.object({
            /** The row's own `trigger.timestamp` (content seconds) — the value
             *  the gate-3 formula subtracts. */
            triggerTs: z.number(),
            /** Trigger -> delivered total (ms); the AC's number. */
            deliveredLatencyMs: z.number().min(0),
            /** Content ts -> cadence fire (frame arrival / relay lag). */
            fireLagMs: z.number().min(0),
            /** Fire -> decide settle (gemma E2E). */
            decideE2eMs: z.number().min(0),
            /** Decide settle -> accept gate entry (content-order head of line). */
            acceptWaitMs: z.number().min(0),
            /** Accept gate duration (localize + suppress + record + emit). */
            acceptMs: z.number().min(0),
            /** Emit -> store write-through ack. */
            persistAckMs: z.number().min(0),
          })
        )
        .max(200),
    })
    .optional(),
});
export type ObserveMetricsSnapshot = z.infer<typeof ObserveMetricsSnapshotSchema>;

// ADAAAA-7007: VOD decide-observer per-call input-size + cap snapshot. Additive
// optional on Job. `subsampledCalls>0` proves the <=30-frame cap was actually
// exercised on the VOD pass; `framesPerCall` is the per-call decide input-size
// distribution (the -67% per-call cost-measure input).
export const VodObserveMetricsSnapshotSchema = z.object({
  decideCalls: z.number().int().min(0),
  accepted: z.number().int().min(0),
  maxFrames: z.number().int().min(0),
  subsampledCalls: z.number().int().min(0),
  framesPerCall: z.array(z.number().int().min(0)),
});
export type VodObserveMetricsSnapshot = z.infer<typeof VodObserveMetricsSnapshotSchema>;

// ADAAAA-7237: one entry in the append-only per-pass summary time log. Each
// cadence decide pass appends a new entry; past entries are NEVER overwritten,
// dropped, or reordered. `seq` is a job-monotonic sequence (strictly
// increasing per job); `ts` is the wall-clock time the entry was appended;
// `windowTs` (when known) is the timestamp of the summarize window / observe
// tick it maps to; `text` is the summary content the model concluded for that
// window (the incremental detail, distinct from the bounded rolling in-model
// story-so-far). Additive optional on Job — absent on jobs that predate it.
/**
 * ADAAAA-7965 (contract v5 §3.1, R18): the signal reference a delivered colour
 * beat carries. ADAAAA-7964 measured the per-window audio-noise delta as the
 * ONLY stored signal that grounds a beat at the 20-40% band with 0 contradicted
 * beats, so a beat stores the measurement it was derived from and the frame that
 * confirms it. Additive optional.
 */
export const ColourSignalSchema = z.object({
  signal: z.literal("audio_noise"),
  ratio: z.number().finite(),
  sustained: z.number().min(0).max(1),
  peak: z.number().min(0),
  peakT: z.number().finite(),
  frameTs: z.number().min(0).optional(),
  frameSeq: z.number().int().min(0).optional(),
});
export type ColourSignalRecord = z.infer<typeof ColourSignalSchema>;

export const ColourTraceSchema = z.object({
  windowTs: z.number().finite().optional(),
  verdict: z.string().nullable().optional(),
  signalPresent: z.boolean(),
  signal: ColourSignalSchema.nullable().optional(),
  signalReason: z
    .enum(["no-window-ts", "insufficient-taps", "low-energy", "no-frame"])
    .optional(),
  clause: z.enum(["beat", "quiet-cap", "wording-filter", "derivation-not-reached"]),
  reason: z.string().optional(),
  beat: z.string().optional(),
});

export const SummaryLogEntrySchema = z.object({
  seq: z.number().int().min(1),
  ts: z.string(),
  // ADAAAA-7711: the observe cadence reports `payload.centerTs`, which is a
  // float whenever a window centre is not a whole second (e.g. a 14 s clip
  // whose last tap lands at 11.666666666666666). Requiring `.int()` here made
  // `store.patchJob`'s `JobSchema.parse` reject the WHOLE patch, and the
  // best-effort `.catch` silently dropped that pass's summary entry. A finite
  // float is the honest window timestamp and matches the sibling consumer
  // `summary-ladder.ts` (which already accepts any finite number), so the
  // contract accepts it rather than rounding at the writer. NaN/Infinity stay
  // rejected — the writer sanitises those away.
  windowTs: z.number().finite().optional(),
  text: z.string(),
  /**
   * ADAAAA-7962 (contract v4 §3.1): the window's STORED verdict, carried on the
   * entry so write-seam dedupe/colour budgeting can tell a quiet row from a
   * loud one WITHOUT re-deriving it at read time (no second build). Additive
   * optional: rows written before this field existed carry none.
   */
  verdict: z.enum(["scoring_play", "near_miss", "big_play", "not_highlight"]).nullable().optional(),
  /**
   * AUDIT-ONLY (contract v4 §3.1). The model's UNGATED text for this row, kept
   * only when the gate changed it, so a grader can compare the model's line to
   * the delivered line. It is never customer copy: no API route and no UI may
   * serve `text_raw` as a narrative, and the delivered text is `text`.
   */
  text_raw: z.string().optional(),
  /**
   * ADAAAA-7965 (contract v5 §3.1): the signal reference for the colour beat
   * this row carries (only set when the beat was derived from a firing
   * audio-noise signal). A row with no `colour` carries no beat.
   */
  colour: ColourSignalSchema.optional(),
  /**
   * ADAAAA-8053 (contract v8 §3b.3): the per-row COLOUR DECISION — whether the
   * write seam saw a measurable signal, which gate clause decided (beat /
   * quiet-cap / wording-filter / derivation-not-reached) and the beat the row
   * carries. Audit-only; no surface renders it. Additive optional: rows written
   * before it existed carry none.
   */
  colourTrace: ColourTraceSchema.optional(),
});
export type SummaryLogEntry = z.infer<typeof SummaryLogEntrySchema>;

// ADAAAA-7821: measured per-job VOD cost meter (see services/server/src/vod-meter.ts).
// `sourceDurationS` / `perVideoHourCostUsd` / `rtf` are null
// when the source duration probe failed, so a completed job never implies a
// runtime it could not measure.
export const VodMeterSchema = z.object({
  wallClockS: z.number().min(0),
  decideCalls: z.number().int().min(0),
  sourceDurationS: z.number().min(0).nullable(),
  costUsd: z.number().min(0),
  decideFeeUsd: z.number().min(0),
  perVideoHourCostUsd: z.number().min(0).nullable(),
  rtf: z.number().min(0).nullable(),
});
export type VodMeter = z.infer<typeof VodMeterSchema>;

// ADAAAA-7928 (Inc 1 of ADAAAA-7925): per-stage timings on a completed VOD job.
// Additive optional — absent on live jobs and on every record written before
// this block landed (legacy rows are counted as `excluded.noStageTimings` by the
// admin aggregate and are NEVER fabricated from `startedAt`/`finishedAt`).
//
// The five top-level stages partition the run (claim -> done):
//   preroll + extract + capacityWait + analyze + finalize == totalMs
// and the three subset measures are nested, not additive:
//   clipEncodeMs  ⊆ analyzeMs   (cumulative ffmpeg cut time inside the loop)
//   audioGateMs   ⊆ analyzeMs   (Stage-A audio loop, CONCURRENT with analyze)
//   sourceProbeMs ⊆ finalizeMs  (probeDuration, inside finalize)
// `perceiveSessionMs` is acquisition -> release (ADAAAA-7928 fixes the meter
// clock that used to start before the capacity wait), and `totalMs` equals
// `vodMeter.wallClockS * 1000`.
//
// Derived by `services/server/src/vod-stage-timings.ts` (pure) and written in
// the same `patchJob` that marks the job `done`.
export const StageTimingsSchema = z.object({
  version: z.literal(1).default(1),
  /** claim -> extract start (plus unattributed inter-stage setup, see builder). */
  prerollMs: z.number().min(0),
  /** frame extraction (ffmpeg decode, CPU). */
  extractMs: z.number().min(0),
  /** reservePerceiveWithBackoff window (GPU capacity queue). */
  capacityWaitMs: z.number().min(0),
  /** analyzeJob wall clock (video + audio + decide). */
  analyzeMs: z.number().min(0),
  /** CUMULATIVE ffmpeg cut time, a subset of analyzeMs. */
  clipEncodeMs: z.number().min(0),
  /** Stage-A audio loop wall clock, CONCURRENT subset of analyzeMs. */
  audioGateMs: z.number().min(0),
  /** probe + title + persistence -> done. */
  finalizeMs: z.number().min(0),
  /** probeDuration, a subset of finalizeMs. */
  sourceProbeMs: z.number().min(0),
  /** perceive session acquisition -> release (excludes capacity wait). */
  perceiveSessionMs: z.number().min(0),
  /** claim -> done. */
  totalMs: z.number().min(0),
  measuredAt: z.string(),
});
export type StageTimings = z.infer<typeof StageTimingsSchema>;

// ADAAAA-7855: the once-per-job match context (who is playing, which colour
// each team wears, and how confident the resolver was). Additive optional, the
// same precedent as `runningSummary` / `summaryLog`: absent on every older row,
// no contract version bump. `services/perceive/app/match_context.py` builds it
// and `services/server/src/match-context.ts` persists it; the sibling prompt
// injection issue (ADAAAA-7856) reads it into the decide prompt, and
// `GET /jobs/:id` surfaces it beside `runningSummary` so the board can inspect
// what the model was told.
export const MatchContextTeamSchema = z.object({
  name: z.string(),
  side: z.enum(["home", "away", "unknown"]),
  kitColors: z
    .array(
      z.object({
        primary: z.string(),
        secondary: z.string().optional(),
      })
    )
    .default([]),
  confidence: z.number().min(0).max(1),
  evidence: z
    .array(
      z.object({
        source: z.string(),
        snippet: z.string(),
      })
    )
    .default([]),
});
export type MatchContextTeam = z.infer<typeof MatchContextTeamSchema>;

export const MatchContextSchema = z.object({
  sport: z.string(),
  teams: z.array(MatchContextTeamSchema),
  inferredAt: z.string(),
  resolverVersion: z.number().int().min(0),
  ambiguous: z.boolean(),
  // AC4 audit surface: one bounded entry per resolver pass (job start, >=25%,
  // >=50%) showing the names/confidences at that point and what the monotonic
  // guard did ("kept Portugal at home" / "flipped ..."). Bounded in the writer.
  trail: z
    .array(
      z.object({
        at: z.string(),
        progressPct: z.number(),
        names: z
          .array(
            z.object({
              side: z.string().optional(),
              name: z.string().optional(),
              confidence: z.number().optional(),
            })
          )
          .default([]),
        action: z.array(z.string()).default([]),
      })
    )
    .default([]),
});
export type MatchContext = z.infer<typeof MatchContextSchema>;

// ADAAAA-7868 (AC-P8): the resolver's `evidenceStatus`, persisted beside
// `matchContext` so an operator can read WHY a team has (or has not) a kit
// colour straight off `GET /jobs/:id` instead of a server log line. It is a
// plain COPY of what `POST /app/match-context` already returned — zero new GPU,
// model or sampling work (E4). Every key is optional because the resolver emits
// only the ones it could produce on that pass, and a pass with no status writes
// no field at all (E2). Additive optional: older records parse untouched, no
// contract version bump, no migration.
//
// `.passthrough()` is deliberate. The declared keys are still validated (a
// wrong type is rejected), but an evidence key this contract does not know yet
// (e.g. a new kit-attribution channel) survives onto the record instead of
// being silently stripped by zod — the field's whole purpose is faithfulness to
// what the resolver reported.
export const MatchContextEvidenceSchema = z
  .object({
    /** Anchor frames whose scorebug lines were read (Stage 0/1). */
    scorebugOcrFrames: z.number().int().min(0).optional(),
    /** Commentary characters the bounded ASR probe returned (Stage 2). */
    commentaryChars: z.number().int().min(0).optional(),
    kitSamples: z.number().int().min(0).optional(),
    /** Distinct frames / tracks that contributed a torso kit sample. */
    kitSampleFrames: z.number().int().min(0).optional(),
    kitSampleTracks: z.number().int().min(0).optional(),
    scorebugSwatches: z.number().int().min(0).optional(),
    /** Per source: present (`asr`) or `asr:not_captured` (AC6 degradation). */
    sources: z.array(z.string()).optional(),
    /** Candidates folded below the usable threshold (never attributed). */
    suppressedCandidates: z.array(z.string()).optional(),
    /** Kit clusters the resolver actually observed (colour names). */
    kitClusterColors: z.array(z.string()).optional(),
    /** Sides with a team but no linking evidence for a kit colour. */
    kitColorsUnattributed: z.array(z.string()).optional(),
    /** ADAAAA-7889: observed kit cluster colours that NO side owns — the kit
     * channel's own inspectability when no team resolved (the side list above is
     * empty in that case even though colours were seen). */
    kitClustersUnattributed: z.array(z.string()).optional(),
    /** Sides the curated kit-colour prior attributed (ADAAAA-7866). */
    kitPriorUsed: z.array(z.string()).optional(),
    /** Sides with no usable prior hit — the pass publishes nothing. */
    kitPriorMiss: z.array(z.string()).optional(),
    /** Sides whose priors landed on ONE cluster — separation failed. */
    kitPriorConflict: z.array(z.string()).optional(),
    sessionId: z.string().nullable().optional(),
    sessionEvidence: z.boolean().optional(),
    sport: z.string().optional(),
    /** ADAAAA-7889 (AC2): per-channel outcome detail, so an `unknown` job is
     * diagnosable from `GET /jobs/:id` alone. The flat counters above stay (they
     * are the shipped contract); this block adds WHAT each channel saw — the raw
     * scorebug OCR line, the commentary mention with its span, the metadata
     * candidate and its field, and the folded confidence per side. */
    channelOutcomes: z
      .object({
        scorebug_ocr: z
          .object({
            frames: z.number().int().min(0).optional(),
            /** Non-empty OCR lines read across those frames. */
            lines: z.number().int().min(0).optional(),
            /** Lines where a team token resolved (0 = no team text in the crop). */
            teamLines: z.number().int().min(0).optional(),
            teams: z.array(z.object({ name: z.string(), side: z.string().optional() }).passthrough()).optional(),
            /** Raw OCR text: team-bearing lines when any, else what was read. */
            rawLines: z.array(z.string()).optional(),
          })
          .passthrough()
          .optional(),
        asr: z
          .object({
            chars: z.number().int().min(0).optional(),
            mentions: z
              .array(
                z
                  .object({
                    name: z.string(),
                    snippet: z.string().optional(),
                    start: z.number().int().nullable().optional(),
                    end: z.number().int().nullable().optional(),
                    kitColor: z.string().nullable().optional(),
                  })
                  .passthrough()
              )
              .optional(),
          })
          .passthrough()
          .optional(),
        metadata: z
          .object({
            candidates: z
              .array(
                z
                  .object({
                    name: z.string(),
                    side: z.string().optional(),
                    /** Which hint produced it: title / gameHint / filename / hint. */
                    field: z.string().nullable().optional(),
                    fuzzy: z.boolean().optional(),
                  })
                  .passthrough()
              )
              .optional(),
          })
          .passthrough()
          .optional(),
        fold: z
          .object({
            usableConfidence: z.number().optional(),
            singleSourceCap: z.number().optional(),
            home: z
              .object({
                name: z.string(),
                confidence: z.number(),
                sources: z.array(z.string()).optional(),
              })
              .nullable()
              .optional(),
            away: z
              .object({
                name: z.string(),
                confidence: z.number(),
                sources: z.array(z.string()).optional(),
              })
              .nullable()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    /** ADAAAA-7889 (AC2): one-line reason the pass published no team (absent
     * when teams resolve). Names each channel's outcome plus the fold result. */
    unknownReason: z.string().optional(),
  })
  .passthrough();
export type MatchContextEvidence = z.infer<typeof MatchContextEvidenceSchema>;

// ---------------------------------------------------------------------------
// ADAAAA-7906 (VOD resume, Increments 1+2): the per-job resume checkpoint.
// Additive OPTIONAL block on the Job contract (`job.resume`); no contract
// version bump. Written through the SAME `store.patchJob` as the progress
// watermark, so a record never carries one without the other.
//
// `cursorTs` is the content timestamp (seconds) of the last FULLY decided
// window — derived from frame order / sampleFps, so it is reproducible across
// attempts and does not depend on wall-clock timing. It is forward-only.
// ---------------------------------------------------------------------------

/** The phase a resume would restart from. `phase` is the last phase STARTED. */
export const ResumePhaseSchema = z.enum(["extract", "analyze", "finalize"]);
export type ResumePhase = z.infer<typeof ResumePhaseSchema>;

/** Proof that frame extraction completed for a given source identity. A resume
 * skips extraction entirely only when this is present, the frame directory is
 * still non-empty, and `sourceBytes` + `sourceMtimeMs` still match the file. */
export const ResumeExtractionSchema = z.object({
  complete: z.literal(true),
  frameCount: z.number().int().min(0),
  fps: z.number().positive(),
  scale: z.string(),
  sourceBytes: z.number().int().min(0),
  sourceMtimeMs: z.number().min(0),
  completedAt: z.string(),
});
export type ResumeExtraction = z.infer<typeof ResumeExtractionSchema>;

/** The analysis cursor: how far content-order analysis got. */
export const ResumeAnalyzeSchema = z.object({
  /** Content seconds of the last fully decided (applied) window. Forward-only. */
  cursorTs: z.number().min(0),
  framesAnalyzed: z.number().int().min(0).optional(),
  decideWindows: z.number().int().min(0).optional(),
  highlightsFound: z.number().int().min(0).optional(),
  lastWindowAt: z.string().optional(),
});
export type ResumeAnalyze = z.infer<typeof ResumeAnalyzeSchema>;

/** Cost accumulators carried across attempts (consumed by Increment 4's
 * accounting; persisted here so the checkpoint is one record). */
export const ResumeAccumulatorsSchema = z.object({
  decideCalls: z.number().int().min(0).default(0),
  perceiveSessionS: z.number().min(0).default(0),
  costUsd: z.number().min(0).default(0),
  /** ADAAAA-7907 (Inc 4): processing wall clock (seconds) summed over every
   * attempt. `vodMeter.wallClockS` on a resumed job reports the total, so a
   * retried pass does not read as a shorter job than the work it did. Additive
   * optional — absent on records that predate it (read as 0). */
  wallClockS: z.number().min(0).optional(),
  stageAMetrics: StageAMetricsSnapshotSchema.optional(),
  confirmMetrics: ConfirmMetricsSnapshotSchema.optional(),
  vodObserveMetrics: VodObserveMetricsSnapshotSchema.optional(),
});
export type ResumeAccumulators = z.infer<typeof ResumeAccumulatorsSchema>;

/** One attempt at the job, in claim order. */
export const ResumeAttemptSchema = z.object({
  attempt: z.number().int().min(1),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  failedAtPhase: ResumePhaseSchema.optional(),
  failureReason: z
    .enum(["media-session-lost", "server-restart", "user-stop", "pipeline-error", "decide-unavailable", "perceive-session-lost", "capacity-exhausted"])
    .optional(),
  error: z.string().optional(),
  // ADAAAA-7907 (AC10): the values this attempt STARTED from, recorded at claim,
  // plus its running counters as of the LAST checkpoint write. A hard kill
  // (SIGKILL / OOM / a deploy recreate) cannot run the attempt's exit hook, so
  // without these the killed attempt has no `[vod-resume]` evidence row at all
  // and a grep can no longer count attempts. Additive optional: absent on
  // records written before they existed.
  resumedFromTs: z.number().min(0).optional(),
  skippedFrames: z.number().int().min(0).optional(),
  warmupFrames: z.number().int().min(0).optional(),
  decideCalls: z.number().int().min(0).optional(),
  perceiveCalls: z.number().int().min(0).optional(),
  usdSpent: z.number().min(0).optional(),
});
export type ResumeAttempt = z.infer<typeof ResumeAttemptSchema>;

export const ResumeCheckpointSchema = z.object({
  version: z.literal(1).default(1),
  phase: ResumePhaseSchema,
  extraction: ResumeExtractionSchema.optional(),
  analyze: ResumeAnalyzeSchema.optional(),
  accumulators: ResumeAccumulatorsSchema.optional(),
  attempts: z.array(ResumeAttemptSchema).default([]),
  totalAttempts: z.number().int().min(0).default(0),
  lastError: z
    .object({
      reason: z.string(),
      message: z.string().optional(),
      at: z.string(),
    })
    .optional(),
  /** Auto-retry schedule. Present only while a retry is armed (status `queued`). */
  nextAttemptAt: z.string().optional(),
  resumedAt: z.string().optional(),
  /** What the user sees: "resumed from T+mm:ss". */
  resumedFromTs: z.number().min(0).optional(),
  /** ADAAAA-7907: total CLAIMS this job's retry policy allows (initial attempt +
   * `VOD_RESUME_MAX_ATTEMPTS`). Lets the operator surface render "attempt 2 of
   * 3" without duplicating the server's config. Additive optional — absent on
   * records written before it existed. */
  maxAttempts: z.number().int().min(1).optional(),
});
export type ResumeCheckpoint = z.infer<typeof ResumeCheckpointSchema>;

export const JobSchema = z.object({
  id: z.string(),
  ownerId: z.string().optional(),
  // Short human-readable job title (ADAAAA-6798 Inc 1). Generated once at job
  // completion by a single text-only `/app/title` decide call; falls back to a
  // deterministic `<gameHint or source> · <n> highlights · <date>` when the
  // decide service is unavailable. Additive optional — absent on older records
  // and on jobs that predate title generation (no contract version bump).
  title: z.string().optional(),
  // ADAAAA-7111 (Increment D): the decide/gemma running video summary
  // (story-so-far), re-persisted on each cadence observe tick. Monotonic
  // (extends the prior summary) and bounded (compacted). Additive optional —
  // absent on jobs that predate it / that never ran the observe cadence.
  runningSummary: z.string().optional(),
  // ADAAAA-7237: append-only per-pass summary time log. Each cadence pass
  // appends a { seq, ts, text } entry; past entries are never overwritten,
  // dropped, or reordered. Distinct from `runningSummary` (the bounded rolling
  // in-model story-so-far). Additive optional — absent on jobs that predate it.
  summaryLog: z.array(SummaryLogEntrySchema).optional(),
  // ADAAAA-7855: inferred teams + kit colours, resolved once per VOD job and
  // re-checked at bounded progress points. Additive optional — absent on jobs
  // that predate the resolver, on jobs whose evidence was unusable (the
  // resolver still writes an `ambiguous: true` context rather than a guess),
  // and whenever the resolver is switched off.
  matchContext: MatchContextSchema.optional(),
  // ADAAAA-7868 (AC-P8): WHY the resolver attributed (or did not attribute) a
  // kit colour on this job — a copy of the resolver's `evidenceStatus`, written
  // in the SAME `patchJob` as `matchContext` so a record never carries one
  // without the other. Additive optional — absent on records that predate it and
  // on any pass where the resolver returned no status.
  matchContextEvidence: MatchContextEvidenceSchema.optional(),
  // `file-sim` = loop a local file at real-time rate as a synthetic live source
  // (LiveIngest kind `file-sim`); used by QA/dev to run the live pipeline
  // deterministically without an RTMP encoder or a display (ADAAAA-5777).
  source: z.enum(["file", "rtmp", "webrtc", "screenshare", "browser", "file-sim"]),
  sourceUrl: z.string().optional(),
  gameHint: z.string().optional(),
  preferLabels: z.array(z.string()).default([]),
  // Durable lifecycle state machine (ADAAAA-6873): a VOD job moves
  // queued -> extracting -> analyzing -> finalizing -> done | failed, plus
  // cancelled. "active" is kept for live/browser-capture jobs and older rows.
  status: z
    .enum(["queued", "active", "extracting", "analyzing", "finalizing", "done", "failed", "cancelled"])
    .default("queued"),
  // Set when the job fails (status === "failed") to the server-side error text
  // so GET /jobs / GET /jobs/:id and the webapp processing-jobs surface render
  // the real reason instead of a generic client string (ADAAAA-6781).
  error: z.string().optional(),
  // ADAAAA-7700: machine-readable attribution of WHY a job failed, separate from
  // both the free-text `error` and the `status`. A browser share that dies with
  // the media node is NOT a user stop, and before this field the row was a bare
  // `failed` with 0 frames — indistinguishable from "the pipeline never ran".
  //   media-session-lost  the media/RTC session carrying the share went away
  //                       (media node restart/crash, session dropped)
  //   server-restart      the control plane restarted mid-run and the in-flight
  //                       job could not be resumed
  //   user-stop           the operator stopped it (explicit /stop, session close)
  //   pipeline-error      the analyze/decide pipeline threw
  //   decide-unavailable  the GPU decide service failed (5xx/timeout/fallback)  (ADAAAA-7906)
  //   perceive-session-lost  the perceive session was lost after re-reserves    (ADAAAA-7906)
  //   capacity-exhausted  the perceive runner stayed at no-capacity after backoff (ADAAAA-7906)
  // Additive optional — absent on rows written before this field existed.
  failureReason: z
    .enum([
      "media-session-lost",
      "server-restart",
      "user-stop",
      "pipeline-error",
      "decide-unavailable",
      "perceive-session-lost",
      "capacity-exhausted",
    ])
    .optional(),
  // ADAAAA-7906 (VOD resume Increments 1+2): the durable resume checkpoint.
  // Additive optional; absent on rows that predate the feature and on the first
  // pass until the first checkpoint write. Written through `store.patchJob` in
  // the SAME call as the progress watermark (see `saveResumeCheckpoint`).
  resume: ResumeCheckpointSchema.optional(),
  perceiveSessionId: z.string().optional(),
  // Per-job VOD sampling override (ADAAAA-5059). When present, overrides the
  // `vodSampleFpsDefault` config for this job; still bounded by runner
  // capability and `vodSampleMaxFps` in resolveSampleFps.
  sampleFps: z.number().positive().optional(),
  // Stage-A audio-gate metric snapshot (INC-2 / ADAAAA-4325); absent on VOD /
  // non-audio jobs and on older records.
  stageAMetrics: StageAMetricsSnapshotSchema.optional(),
  // Stage-2 goal/near-miss confirmation-pass metric snapshot (ADAAAA-6797);
  // absent when no VOD confirm dive ran and on older records.
  confirmMetrics: ConfirmMetricsSnapshotSchema.optional(),
  // Live decide-observer cadence + decide gemma E2E latency snapshot
  // (ADAAAA-7011); absent when the live observer was not enabled / on VOD and
  // on older records.
  observeMetrics: ObserveMetricsSnapshotSchema.optional(),
  // ADAAAA-7007: VOD decide-observer per-call input-size + cap snapshot
  // (decideCalls / maxFrames / subsampledCalls / framesPerCall); absent when the
  // VOD observer was not enabled and on older records.
  vodObserveMetrics: VodObserveMetricsSnapshotSchema.optional(),
  // Detail-first VOD knobs + build-phase cost/volume record (ADAAAA-4954, spec
  // §4.5). All optional on Job — additive, no contract version bump. Persisted
  // by runVodJob so the per-video cost + FP gate are measurable exactly as on
  // the live path.
  frameScale: z.string().optional(),
  decideWindowN: z.number().int().positive().optional(),
  framesAnalyzed: z.number().int().min(0).optional(),
  // Durable job progress (ADAAAA-6873). Throttled + monotonic (never regresses);
  // `stage` mirrors the processing statuses; `framesAnalyzed` tracks frames fed
  // to the pipeline; `highlightsFound` increments the moment a highlight is
  // decided; `attempts` counts worker re-claims so a restart never double-debits.
  stage: z.string().optional(),
  framesTotal: z.number().int().min(0).optional(),
  framesPct: z.number().min(0).max(100).optional(),
  highlightsFound: z.number().int().min(0).default(0),
  // ADAAAA-7984: how many celebration/replay alternative clips this job
  // delivered (attached to their owning GOAL highlight). Alternatives are NOT
  // highlights, so `highlightsFound` above is unchanged by them; this counter is
  // the delivered-alternative count for the job. Additive optional — absent on
  // records that predate alternatives.
  alternativeClipsDelivered: z.number().int().min(0).optional(),
  // ADAAAA-7854: the canonical user-facing clip count for this job, and the raw
  // audit row count it is derived from. `postableHighlights` is the DEDUPED
  // postable moment count (`buildPostableHighlights(...).highlights.length`);
  // `mergedHighlights` is how many overlapping clip rows were absorbed into a
  // moment and therefore do NOT count; `rawHighlights` is the persisted row total
  // (includes rejected / contradicting / merged-away rows). These are a READ-TIME
  // projection — the routes recompute them from the stored rows on every read and
  // never persist them, so `highlightsFound` (a raw, monotonic progress counter)
  // and the stored record stay untouched. Additive optional: absent on older rows.
  rawHighlights: z.number().int().min(0).optional(),
  postableHighlights: z.number().int().min(0).optional(),
  mergedHighlights: z.number().int().min(0).optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  attempts: z.number().int().min(0).optional(),
  candidatesTriggered: z.number().int().min(0).optional(),
  // ADAAAA-7624: which trigger path actually produced `candidatesTriggered`.
  // `observe` = the VOD/live cadence decide observer (ADAAAA-7007/7008) — the
  // only path that runs on the deployed pipeline, so a job of 24 observed
  // highlights must read `candidatesTriggered: 24` with `candidatePath:
  // "observe"`, never a raw-event 0. `perceive_gate` = the legacy perceive
  // candidate trigger; `none` = no candidate path ran. Additive optional — absent
  // on older records.
  candidatePath: z.enum(["observe", "perceive_gate", "none"]).optional(),
  // ADAAAA-7624: whether the Stage-A audio-gate counters on this job are a real
  // measurement. `measured` only when the gate actually judged >= 1 candidate
  // (so `stageAMetrics` is present and non-zero); `n/a` when the audio Stage-A
  // path produced nothing, in which case `stageAMetrics` is ABSENT and readers
  // must show `n/a` rather than a fabricated `0`. Additive optional — absent on
  // older records (treat as `n/a`).
  stageAMetricsStatus: z.enum(["measured", "n/a"]).optional(),
  decideCalls: z.number().int().min(0).optional(),
  perceiveSessionS: z.number().min(0).optional(),
  // ADAAAA-7722: measured live WATCH-MINUTES for this session — the wall-clock
  // minutes the live rail was attached and observing (live RTMP/file-sim: the
  // time from session start to completion; browser/RTC: the media node's
  // `sessionSeconds`). Before this field the ADAAAA-7713 spend envelope had to
  // name a continuous-attachment basis (1,440 min/day x 30.44 days) instead of
  // citing a measurement; `GET /admin/live-watch-minutes` aggregates it into a
  // month-to-date total. Additive optional — absent on VOD jobs and older rows.
  liveWatchMinutes: z.number().min(0).optional(),
  costUsd: z.number().min(0).optional(),
  scheduledAt: z.string().optional(),
  completedAt: z.string().optional(),
  // ADAAAA-8061: when the job stopped accruing (any terminal transition: done,
  // failed, cancelled — including a boot-swept stranded job). The sweep and the
  // stop/failure paths set this so a job that ended without a clean completion
  // is never indistinguishable from a job that never ran. Additive optional.
  endedAt: z.string().optional(),
  // ADAAAA-8061: named reason the spend could not be fully measured (e.g.
  // `decide-count-not-persisted`, `perceive-session-lost`). Written together
  // with `partialCostUsd` so a reader can tell "not measured" from a genuine
  // zero; a measured record never carries it. Additive optional.
  costUnavailable: z.string().optional(),
  // ADAAAA-8061: best-effort partial cost (the perceive-session leg only) when
  // the decide count could not be measured. Never written in place of a real
  // `costUsd`. Additive optional.
  partialCostUsd: z.number().min(0).optional(),
  // ADAAAA-8061: set by POST /jobs/:id/stop so the pass unwinds gracefully
  // (settling `cancelled` + cost) instead of losing its decide runner.
  stopRequestedAt: z.string().optional(),
  // Async-VOD job progress (ADAAAA-6760): additive optional 0-100 progress +
  // human label, updated by runVodJob at stage boundaries. No contract version
  // bump — both are purely additive and absent on older records / live jobs.
  progress: z.number().min(0).max(100).optional(),
  progressLabel: z.string().optional(),
  // Source-media runtime in ms (ADAAAA-6838 / D-I2.2): set on a completed VOD
  // job so the webapp result card can show the clip's source duration. Additive
  // optional — absent on live jobs and older records.
  durationMs: z.number().min(0).optional(),
  // ADAAAA-7821: measured per-job VOD cost meter. Converts the three inputs the
  // ratified price points modelled (wall clock, decide count, source duration)
  // into values recorded on the completed record, so $/video-hour is measured
  // rather than derived. Additive optional — absent on live jobs and older rows.
  vodMeter: VodMeterSchema.optional(),
  // ADAAAA-7928 (Inc 1 of ADAAAA-7925): per-stage timings for the completed VOD
  // run (see StageTimingsSchema). Additive optional — absent on live jobs and
  // legacy rows; `vodMeter` keeps its shape unchanged.
  stageTimings: StageTimingsSchema.optional(),
  // Live decision trail (ADAAAA-6870, Increment 3 T1): bounded ordered array of
  // candidate/highlight decisions appended by runVodJob via the onEvent hook
  // (throttled patchJob). Additive optional — absent on older records.
  candidates: z.array(JobDecisionSchema).optional(),
  createdAt: z.string(),
});
export type Job = z.infer<typeof JobSchema>;

// --- per-highlight trigger metadata (ADAAAA-6798 Inc 2) ---------------------
// The decide stage already computes the trigger signal that started a candidate
// (audio gate, ball signal, scoreboard change, goal-line crossing, ...). This
// additive type persists that signal onto both the JobCandidate and the
// HighlightRecord so the UI can show "what trigger started this highlight".
// Populated from the candidate object at decision time — NO new inference.
// Absent on legacy rows without a candidate; those degrade to "trigger unknown"
// (the highlight's own anchored eventType/timestamp) with no re-inference.
export const HighlightTriggerSchema = z.object({
  kind: z.enum([
    "audio_burst",
    "audio_swell",
    "motion",
    "ball_signal",
    "score_change",
    "goal_line",
    "corroborated",
  ]),
  /** Trigger timestamp (s from stream start) the candidate was anchored to. */
  timestamp: z.number().min(0),
  /** The event class that fired the trigger (KILL | GOAL | DUNK | ...). */
  eventType: z.string(),
  // Reaction evidence derived from the same candidate object (all optional/
  // absent when the signal was not present). These mirror the decide evidence
  // fields so no re-inference is required to display the trigger provenance.
  crowdEnergy: z.number().min(0).optional(),
  audioKind: z.string().optional(),
  ballSpeedMps: z.number().min(0).optional(),
  ballPossessionId: z.string().optional(),
  goalCrossed: z.boolean().optional(),
  ballOutcome: z.string().optional(),
  scoreBoardChanged: z.boolean().optional(),
});
export type HighlightTrigger = z.infer<typeof HighlightTriggerSchema>;

export const HighlightRecordSchema = z.object({
  id: z.string(),
  ownerId: z.string().optional(),
  jobId: z.string(),
  // ADAAAA-6874 (Phase 2): deterministic per-highlight idempotency key derived
  // from (jobId, candidate seq, eventType). A re-claimed/resumed job that
  // re-decides the same candidate must not double-persist or double-bill. The
  // store's addHighlight dedups on this key (first insert wins; billing/debit
  // only on first insert). Additive optional — older rows carry none.
  idempotencyKey: z.string().optional(),
  clipUri: z.string(),
  start: z.number(),
  end: z.number(),
  // ADAAAA-7232: the deterministic localized highlight instant (seconds from
  // stream start) the delivered clip is centered on, plus the signal that
  // produced it ("peak_frame" | "peak_audio" | "trigger"). Additive optional —
  // legacy rows carry none; when absent the clip is centered on the coarse
  // candidate trigger. Records Acc-3 so the clip center is queryable.
  // ADAAAA-7253 (ACC-3): "peak_frame" records a frame-based localization — the
  // delivered clip is centered on the per-frame signal peak (ball-in-net /
  // goal-crossed / scoreboard-change / tracking-detection confidence), not the
  // coarse trigger.
  localizedTs: z.number().min(0).optional(),
  localizeSignal: z.enum(["peak_frame", "peak_audio", "trigger"]).optional(),
  // ADAAAA-7845 (AC2): WHY the delivered clip sits where it does, plus the
  // accepting evidence instant and |localizedTs - evidenceTs|. Peak audio is a
  // secondary cue: an energy peak further than ~2 s from the evidence instant
  // only moves the clip when it reads as a crowd/react burst (and is then capped
  // to that tolerance edge); a far narration peak is recorded as rejected and
  // the evidence instant anchors the clip. Additive optional — legacy rows carry
  // none.
  localizeAnchorReason: z
    .enum([
      "frame_attestation",
      "peak_audio_reaction",
      "peak_audio_far_burst_capped",
      "peak_audio_far_rejected",
      "trigger_evidence",
    ])
    .optional(),
  localizeEvidenceTs: z.number().min(0).optional(),
  localizeAnchorDeltaSec: z.number().min(0).optional(),
  // ADAAAA-7247 (ACC-7): the per-company clip-window setting that produced this
  // clip — configured pre-roll (clipWindowBeforeS) and post-roll
  // (clipWindowAfterS) seconds, plus the delivered window length
  // (clipWindowSec = end - start once the >=15 s floor is applied). Persisted
  // on the record so the delivered clip window is auditable (Acc-3). Additive
  // optional — legacy rows carry none.
  clipWindowBeforeS: z.number().min(0).optional(),
  clipWindowAfterS: z.number().min(0).optional(),
  clipWindowSec: z.number().min(0).optional(),
  eventType: z.string().optional(),
  score: z.number().min(0).max(100),
  reason: z.string().optional(),
  /**
   * AUDIT-ONLY (ADAAAA-7962, contract v4 §3.1). The model's UNGATED decide
   * `reason` for this highlight, kept only when the write-seam gate changed the
   * delivered `reason`. Never customer copy: no route or UI may serve
   * `reason_raw` as a narrative.
   */
  reason_raw: z.string().optional(),
  // Set when a highlight's clip could NOT be cut from the source recording at
  // finalize (missing/incomplete recording, or a cut failure). The UI renders a
  // failure card instead of a silent empty player when clipUri is "" but
  // clipError is present (ADAAAA-6522). An empty clipUri with no clipError means
  // the clip is simply deferred until stop-time finalize.
  clipError: z.string().optional(),
  // ADAAAA-7248: whether the source this highlight's clip was cut from carried
  // an audio stream. Set at clip-cut time (ffprobe). false => the delivered
  // clip is silent because the source had no audio track (e.g. a screen/window
  // share, or an audio-less upload), which the UI surfaces as an explicit
  // "no audio captured" state instead of silently implying sound. Additive
  // optional — absent on pre-existing rows / when the probe was skipped.
  hasAudio: z.boolean().optional(),
  // ADAAAA-7248: the ASR transcript computed in the decide runner for this
  // highlight's audio context, surfaced on the card so textual corroboration is
  // available when the clip has no audible audio. Additive optional; populated
  // by the decide->persist follow-up (ACC-3) so absent today on new rows.
  asrTranscript: z.string().optional(),
  // Increment F / ADAAAA-6465: outcome taxonomy member + near-miss flag, so a
  // near miss surfaces at a lower score labeled distinctly (shorter clip / a
  // distinct label downstream); a scoring play is the full highlight score.
  outcome: z.enum(["scoring_play", "near_miss", "big_play", "not_highlight"]).optional(),
  nearMiss: z.boolean().optional(),
  // Stage-2 confirmation-pass verdict (ADAAAA-6797): set on a goal-type
  // highlight that went through the /confirm deep frame dive. null on the
  // passthrough path. Additive + optional.
  goalConfirmed: z.enum(["confirmed_goal", "near_miss", "not_goal"]).optional(),
  // Stage-1 vs Stage-2 disagreement flag for this highlight (ADAAAA-6797).
  stage1Disagreed: z.boolean().optional(),
  // ADAAAA-7185: independent corroboration evidence for an accepted GOAL.
  // Whether the /confirm pass found an independent corroboration signal
  // (measured scoreboard change, goal-calling audio/commentary text, or the
  // ADAAAA-7543 two-signal frame attestation) and which one. Persisted so
  // accepted == corroborated is queryable post hoc.
  corroborated: z.boolean().optional(),
  corroborationSource: z.enum(["audio_text", "scoreboard", "frame_attestation"]).optional(),
  status: z.enum(["pending", "accepted", "rejected"]).default("pending"),
  // ADAAAA-6798 Inc 2: link the highlight to the JobCandidate that started it,
  // and de-normalize that candidate's trigger metadata so GET /highlights and
  // GET /jobs/:id/detail can show "what trigger started this highlight" with
  // zero drift and no read-time join. Both additive optional — legacy rows
  // without a candidate degrade to the highlight's own anchored metadata.
  candidateId: z.string().optional(),
  trigger: HighlightTriggerSchema.optional(),
  // ADAAAA-7621: overlap dedupe of the postable list. Overlapping clip windows
  // collapse into ONE moment; the winning clip carries `duplicateCount` (number
  // of clips merged into it) and `mergedIds`, while each merged-away clip is
  // returned (out of the postable list) with `duplicateOf` = the winner's id.
  // Additive optional — absent on records that had no overlapping sibling, so
  // legacy rows and single-clip moments are unchanged.
  duplicateOf: z.string().optional(),
  duplicateCount: z.number().int().min(0).optional(),
  mergedIds: z.array(z.string()).optional(),
  // ADAAAA-7865: why a delivered highlight was DOWNGRADED out of the scoring
  // lane. Set on a repeat GOAL accept that re-read an already-delivered goal
  // event (post-goal celebration frames attested by ball-in-net) and carried no
  // independent score-transition evidence: the clip is still delivered as a
  // celebration (`outcome: "big_play"`), and this field names the goal highlight
  // it duplicates so the downgrade is auditable from the record alone. Additive
  // optional — absent on every scoring highlight and on legacy rows.
  dedupeReason: z.string().optional(),
  /** ADAAAA-8006: the deferred scoreboard read that re-attested a demoted LIVE
   * goal. A live goal-shaped accept whose score transition only became legible
   * AFTER its judged window closed is delivered as a `big_play` celebration (the
   * ADAAAA-7996 gate), then upgraded back into the scoring lane when a later
   * window's scoreboard read measures the transition inside a bounded lookahead.
   * Records the measurement (transition instant, the read instant, the judged
   * window it was attributed to, pre -> post score) so the re-emit is auditable
   * from the row alone. Additive optional — absent on every row the gate did not
   * have to demote. */
  deferredAttestation: z
    .object({
      /** First legible read of the new score (the transition instant). */
      deltaTs: z.number(),
      /** Content timestamp of the window whose read resolved it. */
      readAt: z.number(),
      /** The judged window the transition was attributed to. */
      windowLo: z.number(),
      windowHi: z.number(),
      pre: z.tuple([z.number(), z.number()]),
      post: z.tuple([z.number(), z.number()]),
    })
    .optional(),
  // When the clip entered `rejected` (soft-delete undo grace start). Set on
  // reject, cleared on reject->accept (cancels pending TTL purge). Only
  // `rejected` clips with a `rejectedAt` aged >= rejectTtlMs are ever purge
  // candidates — accepted/published/pending/queued clips are never touched.
  rejectedAt: z.string().optional(),
  // ADAAAA-7896: export state — set the FIRST time this highlight's clip leaves
  // the app (an export-URL fetch, or a copy/batch intent call). First write
  // wins: later exports never overwrite the earliest stamp, so exactly one row
  // write happens per clip per lifetime. Additive optional — legacy rows carry
  // none, and there is no schema version bump.
  exportedAt: z.string().optional(),
  exportedVia: z.enum(["download", "copy_link", "batch_zip", "copy_urls"]).optional(),
  /** The user who was served the export URL / fired the intent. */
  exportedBy: z.string().optional(),
  // ADAAAA-7896: an OPERATOR (role=admin) rejected a clip that was already
  // exported — the reject exemption is recorded beside the export stamp so the
  // override is auditable from the record alone. Never set on an owner reject
  // (that path is refused with 409 `clip_exported`).
  rejectedAfterExport: z.boolean().optional(),
  // ADAAAA-7896: PROJECTION-ONLY export URL (clip path + per-highlight token).
  // Minted per caller by GET /jobs/:id/detail and never persisted by the store,
  // so the webapp never has to mint a token itself.
  exportUri: z.string().optional(),
  // ADAAAA-7965 (contract v5 §3.5, R22): the surface strings the page renders
  // for this highlight — stored at the write seam so the caption and every card
  // option is byte-identical to a gated value (no read-time truncation, no
  // dropped colour clause, no dropped punctuation). Additive optional; absent on
  // legacy rows and on the VOD rail, which keep their own render path (AC8).
  caption: z.string().optional(),
  cardTitles: z.array(z.string()).optional(),
  // ADAAAA-7965 (contract v5 §3.1, R18): the measured signal the colour beat in
  // `reason` was derived from, with the frame that confirms it.
  colour: ColourSignalSchema.optional(),
  createdAt: z.string(),
});
export type HighlightRecord = z.infer<typeof HighlightRecordSchema>;

// --- ADAAAA-7984: celebration/replay clips delivered as ALTERNATIVES ---------
// A post-goal celebration/replay window has no independent score transition, so
// it is never a second scoring highlight (ADAAAA-7865 dedup, ADAAAA-7938 prompt).
// Dropping it entirely lost the goal aftermath (ADAAAA-7953 option A + board
// decision 2026-11-04): the window is delivered as a clip ATTACHED TO the GOAL
// highlight it follows, presented as an alternative of that highlight — never as
// a top-level highlight and never in the notable lane. It carries its own row in
// `highlight_alternatives`, so it cannot inflate `highlightsFound`,
// `postableHighlights`, `notScoringHighlights` or `notableHighlights`.
/** The one event label a celebration alternative may carry. Never "GOAL". */
export const CELEBRATION_ALTERNATIVE_EVENT_TYPE = "celebration" as const;
/** The explicit alternative relation a surface groups on. */
export const HIGHLIGHT_ALTERNATIVE_RELATION = "alternative_of" as const;
/** Hard cap per owning highlight (board decision: "2 per goal cap makes sense"). */
export const MAX_ALTERNATIVES_PER_HIGHLIGHT = 2;

export const HighlightAlternativeSchema = z.object({
  id: z.string(),
  ownerId: z.string().optional(),
  jobId: z.string(),
  /** The owning top-level highlight. Resolves to an entry in the payload's
   * `highlights[]` (a scoring GOAL); an alternative belongs to exactly one goal. */
  highlightId: z.string(),
  /** Explicit alternative relation so a surface groups instead of listing. */
  relation: z.literal(HIGHLIGHT_ALTERNATIVE_RELATION),
  /** ADAAAA-7984 §3: `celebration` (new non-scoring value) — never `GOAL`. */
  eventType: z.literal(CELEBRATION_ALTERNATIVE_EVENT_TYPE),
  /** Never `scoring_play`: the alternative inherits the celebration window's
   * non-scoring verdict class (`big_play` / `near_miss`). */
  outcome: z.enum(["big_play", "near_miss"]),
  /** The decide window anchor (content seconds) this alternative was cut for;
   * half of the idempotency key (owning highlight id + window anchor). */
  windowAnchorTs: z.number().min(0),
  /** |windowAnchorTs - owning highlight clip end| used by the deterministic
   * selection (nearest to the goal clip end first). */
  distanceToGoalEndS: z.number().min(0),
  /** The celebration window's decide confidence (selection tie-break, audit). */
  score: z.number().min(0).max(100),
  /** Delivered clip window + the cut media path. */
  start: z.number(),
  end: z.number(),
  clipId: z.string().optional(),
  clipUri: z.string(),
  clipError: z.string().optional(),
  /** Deterministic dedupe key: owning highlight id + window anchor. Re-running
   * the same windows can never persist a second row or cut a second clip. */
  dedupeKey: z.string(),
  /** The celebration window's own verdict reason (audit only; the surface shows
   * a plain "Celebration" label, never a model rationale). */
  reason: z.string().optional(),
  createdAt: z.string(),
});
export type HighlightAlternative = z.infer<typeof HighlightAlternativeSchema>;

/** A top-level highlight as it is DELIVERED on the job-detail payload: the
 * stored record plus the celebration alternatives tied to it (ADAAAA-7984). The
 * grouped array is the surface contract — an alternative is never its own card. */
export const HighlightWithAlternativesSchema = HighlightRecordSchema.extend({
  alternatives: z.array(HighlightAlternativeSchema).optional(),
});
export type HighlightWithAlternatives = z.infer<typeof HighlightWithAlternativesSchema>;

// --- job detail / per-candidate decide persistence (ADAAAA-6851) ------------
// Every decide evaluation is persisted (accepted highlight, burst-suppressed,
// near-miss, not-highlight) so the full-screen Job detail can show the decide
// LLM's note on EVERY trigger, not just accepted clips. All types below are
// additive: no existing required field changed, no contract version bump.

// --- per-window LLM analysis payload (ADAAAA-7137 / ADAAAA-7155 Increment A) -
// Observability/inspectability ONLY: exactly what was fed to the decide LLM for
// a window and what it returned. Additive + optional everywhere; no contract
// version bump, no inference change. Frames/images stay lazy (refs only, image
// bytes delivered via the existing /frames/:seq / frames delivery). The `prompt`
// is the exact text handed to the model; `dataItems` is an ordered structured
// view of the same context so the UI can render each item independently.
export const AnalysisDataItemSchema = z.object({
  /** Category of the item: candidate | game | tracking | ocr | scoreboard |
   * goal_line | reaction | audio_level | detections | asr | frames | images |
   * audio | summary | confirm | corroboration | motion | trajectory. */
  type: z.string(),
  /** Human label for the UI (e.g. "Track count", "Goal-line ground-truth"). */
  label: z.string(),
  /** The value fed for this item: a scalar, a bounded scalar SERIES, or null.
   * ADAAAA-7848: the Stage-2 confirm pass carries its flow-magnitude /
   * audio-envelope curves as number arrays ("Optical-flow magnitude curve",
   * "Audio-energy envelope"), so a scalar-only union rejected the WHOLE
   * ConfirmRecord and the deep-dive evidence was never persisted. Series are
   * part of the real producer shape, not drift — model them here. */
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string(), z.number(), z.boolean()])),
    ])
    .nullable()
    .optional(),
  // Additive extras (e.g. a unit / count) never drop the item or the block.
}).passthrough();
export type AnalysisDataItem = z.infer<typeof AnalysisDataItemSchema>;

/** A lazy media ref (image bytes stay out-of-band via the existing frame delivery). */
export const AnalysisMediaRefSchema = z.object({
  seq: z.number().int().min(0),
  uri: z.string(),
});
export type AnalysisMediaRef = z.infer<typeof AnalysisMediaRefSchema>;

/** Which audio channel actually reached the model for this window. */
export const AnalysisAudioSchema = z.object({
  uri: z.string().optional(),
  sampleRate: z.number().int().positive().optional(),
  /** native input_audio bytes, the ASR->text transcript, or none. */
  path: z.enum(["input_audio", "asr_text", "none"]).optional(),
});
export type AnalysisAudio = z.infer<typeof AnalysisAudioSchema>;

/** ASR (audio->text) context block fed as the transcript. */
export const AnalysisAsrSchema = z.object({
  transcript: z.string().optional(),
  url: z.string().optional(),
  latencyS: z.number().min(0).optional(),
});
export type AnalysisAsr = z.infer<typeof AnalysisAsrSchema>;

/** The full decide LLM response, retained at the decide boundary (not just the
 * note fields JobCandidate already stores). */
export const AnalysisResponseSchema = z.object({
  isHighlight: z.boolean().optional(),
  score: z.number().min(0).max(100).optional(),
  eventType: z.string().optional(),
  reason: z.string().optional(),
  outcome: z.enum(["scoring_play", "near_miss", "big_play", "not_highlight"]).optional(),
  nearMiss: z.boolean().optional(),
  reasoning: z.string().optional(),
  verdict: z.unknown().optional(),
  evidenceAttested: z.array(z.string()).default([]),
  audioContext: z.unknown().optional(),
  runningSummary: z.string().optional(),
  source: z.string().optional(),
});
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;

/** One per-chunk audio energy-vs-baseline inspection point (ADAAAA-7255):
 * ``t`` seconds over the stream, ``energy`` and ``baseline`` both normalized
 * 0..1 (the Stage-A gate's per-chunk RMS energy and its rolling ambient
 * baseline). Carried by the per-window analysis so the request-inspection view
 * can render the energy-vs-baseline graph. Additive optional — absent on legacy
 * analyses / windows without an audio tap. */
export const AudioSeriesPointSchema = z.object({
  t: z.number().min(0),
  energy: z.number().min(0).max(1),
  baseline: z.number().min(0).max(1),
});
export type AudioSeriesPoint = z.infer<typeof AudioSeriesPointSchema>;

/** Per-window capture of exactly what was fed to the decide LLM + what it returned. */
export const WindowAnalysisSchema = z.object({
  /** The exact prompt text sent to the model for this window. */
  prompt: z.string(),
  /** Ordered structured list of the context items fed to the model. */
  dataItems: z.array(AnalysisDataItemSchema).default([]),
  /** Lazy refs to the temporal frame sequence shown (1 FPS). */
  frames: z.array(AnalysisMediaRefSchema).default([]),
  /** Lazy refs to the context crop images. */
  images: z.array(AnalysisMediaRefSchema).default([]),
  audio: AnalysisAudioSchema.optional(),
  asr: AnalysisAsrSchema.optional(),
  response: AnalysisResponseSchema.optional(),
  // ADAAAA-7255: the bounded per-chunk (t, energy, baseline) audio gate series
  // for this window, for the energy-vs-baseline graph. Additive optional —
  // absent when the audio tap produced nothing for the window.
  audioSeries: z.array(AudioSeriesPointSchema).optional(),
});
export type WindowAnalysis = z.infer<typeof WindowAnalysisSchema>;

/** Stage-2 confirmation-pass record (request summary + decision), attached to a
 * candidate or a section's decide-note. Additive optional. */
export const ConfirmRecordSchema = z.object({
  /** The confirm request: exact prompt + the context items it was fed. */
  request: z.object({
    prompt: z.string(),
    dataItems: z.array(AnalysisDataItemSchema).default([]),
    frames: z.array(AnalysisMediaRefSchema).default([]),
    keyframes: z.array(AnalysisMediaRefSchema).default([]),
    trajectories: z.array(z.string()).default([]),
    opticalFlowMagnitude: z.number().min(0).optional(),
    audioLevels: z.array(z.number()).default([]),
    transcript: z.string().optional(),
    stage1: z.unknown().optional(),
  }),
  /** The ConfirmDecision: goalConfirmed / confidence / evidence / stage1Disagreed /
   * reason, plus the reconciled HighlightDecision fields the decide pass carries.
   * ADAAAA-7848: the decide `_confirm_analysis` decision block is derived from the
   * full confirm response (`decision.get("decision")`), so it also carries
   * eventType / score / isHighlight / nearMiss and the corroboration fields, and
   * any one of them being unmodelled used to drop the whole record. Extras are
   * modelled where they are load-bearing and passed through otherwise. */
  decision: z.object({
    enabled: z.boolean().optional(),
    goalConfirmed: z.enum(["confirmed_goal", "near_miss", "not_goal"]).nullable().optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    reason: z.string().optional(),
    evidence: z.unknown().optional(),
    stage1Disagreed: z.boolean().optional(),
    // Absent/null whenever the reconciled decision has no outcome (legacy verdict
    // or a passthrough that never reconciled) — null must not fail the parse.
    outcome: z.enum(["scoring_play", "near_miss", "big_play", "not_highlight"]).nullable().optional(),
    // ADAAAA-7848: the reconciled HighlightDecision fields the deep dive adopts.
    eventType: z.string().optional(),
    score: z.number().min(0).max(100).nullable().optional(),
    isHighlight: z.boolean().optional(),
    nearMiss: z.boolean().optional(),
    // ADAAAA-7162/7185/7402: independent corroboration + which signal supplied it
    // (scoreboard | audio_text | frame_attestation). Free-form: a new source
    // token must never drop the record.
    corroborated: z.boolean().optional(),
    corroborationSource: z.string().nullable().optional(),
    transcript: z.string().optional(),
  }).passthrough().default({}),
});
export type ConfirmRecord = z.infer<typeof ConfirmRecordSchema>;

export const JobCandidateSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  ownerId: z.string().optional(),
  /** The sampled frame seq the candidate was anchored to (0 when unknown). */
  seq: z.number().int().min(0).default(0),
  /** Trigger timestamp (s from stream start) the decide LLM reasoned over. */
  timestamp: z.number(),
  eventType: z.string(),
  score: z.number().min(0).max(100),
  /** Whether the decide verdict itself said this is a highlight (before the
   * server accept gate / burst suppression). */
  isHighlight: z.boolean(),
  /** Outcome taxonomy from the decide verdict (mirrors HighlightDecision.outcome). */
  outcome: z.enum(["scoring_play", "near_miss", "big_play", "not_highlight"]).optional(),
  nearMiss: z.boolean().optional(),
  reason: z.string().optional(),
  /** Why this evaluation did/didn't become a highlight record:
   *   accepted   -> cut as an accepted highlight (surfaces as a HighlightRecord)
   *   suppressed -> model accepted but the Goal burst-suppression window dropped it
   *   rejected   -> not an accepted scoring highlight (near-miss / not-highlight) */
  status: z.enum(["accepted", "suppressed", "rejected"]).default("rejected"),
  // ADAAAA-6798 Inc 2: the trigger signal that started this candidate, derived
  // from the candidate object at decision time and persisted so the UI can show
  // its provenance with no re-inference. Additive optional — absent on legacy
  // rows (which predate trigger persistence).
  trigger: HighlightTriggerSchema.optional(),
  // ADAAAA-7155 Increment A: the per-window LLM analysis payload (exact prompt /
  // ordered dataItems / media refs / full response) for this candidate's decide
  // read. Additive optional — absent on legacy rows. Observability only.
  analysis: WindowAnalysisSchema.optional(),
  // ADAAAA-7156 Increment B: the Stage-2 confirmation-pass record (request
  // context summary + ConfirmDecision) for this candidate, set when the
  // goal-type candidate ran the decide /confirm deep frame dive. Additive
  // optional — absent on non-confirm / legacy rows. Observability only.
  confirm: ConfirmRecordSchema.optional(),
  createdAt: z.string(),
});
export type JobCandidate = z.infer<typeof JobCandidateSchema>;

/** One aggregated tracked-object identity for a job (ADAAAA-6851 Inc 3). */
export const JobTraceSchema = z.object({
  trackId: z.string(),
  slot: z.number().int().min(0),
  kind: TrackKindSchema,
  label: z.string().optional(),
  /** Number of sampled frames the track appeared on. */
  onScreen: z.number().int().min(0),
  ontoFrames: z.number().int().min(0).optional(),
  lostFrames: z.number().int().min(0).optional(),
  accuracy: z.number().min(0).max(1).optional(),
  selected: z.boolean().optional(),
});
export type JobTrace = z.infer<typeof JobTraceSchema>;

/** A decide note surfaced in a 3 s frame section (ADAAAA-6851 Inc 2). */
export const DecideNoteSchema = z.object({
  seq: z.number().int().min(0),
  timestamp: z.number(),
  eventType: z.string(),
  score: z.number().min(0).max(100),
  outcome: z.enum(["scoring_play", "near_miss", "big_play", "not_highlight"]).optional(),
  nearMiss: z.boolean().optional(),
  isHighlight: z.boolean(),
  status: z.enum(["accepted", "suppressed", "rejected"]),
  reason: z.string().optional(),
  // ADAAAA-7155 Increment A: the per-window analysis (prompt / dataItems /
  // media refs / full response) + the Stage-2 confirm record for this
  // section's decide note. Additive optional — absent on legacy notes.
  analysis: WindowAnalysisSchema.optional(),
  confirm: ConfirmRecordSchema.optional(),
});
export type DecideNote = z.infer<typeof DecideNoteSchema>;

/** Metadata for one frame in a section (image bytes stay lazy via /frames/:seq). */
export const JobDetailFrameSchema = z.object({
  seq: z.number().int().min(0),
  timestamp: z.number(),
  uri: z.string(),
  tracks: z.array(TrackObservationSchema).default([]),
});
export type JobDetailFrame = z.infer<typeof JobDetailFrameSchema>;

/** A fixed 3 s bucket of frames + the decide notes whose trigger falls in it. */
export const FrameSectionSchema = z.object({
  index: z.number().int().min(0),
  startS: z.number(),
  endS: z.number(),
  frames: z.array(JobDetailFrameSchema).default([]),
  decideNotes: z.array(DecideNoteSchema).default([]),
});
export type FrameSection = z.infer<typeof FrameSectionSchema>;

// ADAAAA-7623: the SUMMARY LADDER derived from STORED data only (the
// append-only `job.summaryLog` + persisted accepted highlights). No inference,
// no GPU seconds: the server derives it at read time, so a cost delta of ~$0 is
// structural rather than promised. Rungs (broadest first):
//   match summary -> chapters (<= 10) -> window narratives -> frame/decide audit.
//
// The fact gate lives in the same derivation: any scoreboard/score string the
// accepted evidence does not corroborate is SUPPRESSED (and reported in
// `refusedScoreClaims` for audit), the goal timeline is monotonic by
// construction (index 1..N in time order), and stock template openers are
// stripped from the narrative text.
export const SummaryChapterGoalSchema = z.object({
  /** 1-based, monotonic in time order across the whole match. */
  index: z.number().int().min(1),
  /** Video-relative seconds of the accepted GOAL moment. */
  ts: z.number(),
  /** Corroborated by a measured attestation (frame_attestation / scoreboard / audio). */
  verified: z.boolean(),
});
export type SummaryChapterGoal = z.infer<typeof SummaryChapterGoalSchema>;

export const SummaryChapterSchema = z.object({
  index: z.number().int().min(0),
  kind: z.enum(["build-up", "goal-cluster", "lull", "phase"]),
  title: z.string(),
  startS: z.number(),
  endS: z.number(),
  /** One-line chapter rollup (fact-gated, de-templated). */
  summary: z.string(),
  goalCount: z.number().int().min(0),
  goals: z.array(SummaryChapterGoalSchema).default([]),
  /** Inclusive summary-log seq range covered by this chapter (detail-on-demand). */
  seqFrom: z.number().int().min(1),
  seqTo: z.number().int().min(1),
  /** Fact-gated window narratives for this chapter (rung 3). */
  entries: z
    .array(z.object({ seq: z.number().int().min(1), windowTs: z.number(), text: z.string() }))
    .default([]),
});
export type SummaryChapter = z.infer<typeof SummaryChapterSchema>;

export const MatchSummarySchema = z.object({
  /** <= 1500 chars by construction. */
  text: z.string(),
  charCount: z.number().int().min(0),
  chapterCount: z.number().int().min(0),
  goalCount: z.number().int().min(0),
  verifiedGoalCount: z.number().int().min(0),
  /** Goal timeline in order; strictly increasing indices = monotonic count. */
  goalTimeline: z.array(SummaryChapterGoalSchema).default([]),
  /** Score strings the fact gate REFUSED (audit trail of what was suppressed). */
  refusedScoreClaims: z.array(z.string()).default([]),
});
export type MatchSummary = z.infer<typeof MatchSummarySchema>;

export const SummaryLadderSchema = z.object({
  chapters: z.array(SummaryChapterSchema).max(10).default([]),
  matchSummary: MatchSummarySchema,
  /** Provenance: this ladder adds zero decide calls / GPU seconds. */
  derivedFrom: z.object({
    summaryLogEntries: z.number().int().min(0),
    acceptedHighlights: z.number().int().min(0),
  }),
});
export type SummaryLadder = z.infer<typeof SummaryLadderSchema>;

/** ADAAAA-7741: the customer-facing "how live is this job" projection.
 *
 * Derived at READ time from stored data (the content-clock anchor, the
 * append-only `summaryLog` wall/content pairs and the newest persisted
 * observation) — zero decide calls, zero GPU seconds. It is the customer-safe
 * projection of the internal lag diagnostics: `observeMetrics`, `costUsd`,
 * `decideCalls` and `stageAMetrics` are NEVER part of it (and stay admin-gated
 * by ADAAAA-7727). Additive optional on the job payloads, so no contract
 * version bump. */
export const LiveProgressSchema = z.object({
  /** Content seconds available at the tap. */
  liveEdgeTs: z.number().min(0),
  /** Content ts of the newest decided window. */
  processedThroughTs: z.number().min(0),
  /** liveEdgeTs - processedThroughTs, clamped >= 0. */
  lagSec: z.number().min(0),
  /** Cadence windows dropped past the lag budget this run. */
  skippedWindows: z.number().int().min(0),
  /** `unknown` when the derivation has no anchor / no decided window yet, and
   * for a terminal job (no live edge — the UI shows the completion state). */
  state: z.enum(["caught_up", "behind", "unknown"]),
  updatedAt: z.string(),
});
export type LiveProgress = z.infer<typeof LiveProgressSchema>;

/** ADAAAA-7750: WHY a live job has no analysis windows yet, as a customer-safe
 * projection derived read-time from stored counters. Additive optional on the
 * job-detail payload, so no contract version bump; absent on servers that
 * predate it. `cause` + `action` are user-facing copy, `frames`/`windows`/
 * `highlights` are counters the job page already renders. */
export const LiveCaptureSchema = z.object({
  state: z.enum([
    "connecting",
    "waiting_first_window",
    "capturing",
    "interrupted",
    "no_capture",
    "no_highlights",
    "unknown",
  ]),
  frames: z.number().int().min(0),
  windows: z.number().int().min(0),
  highlights: z.number().int().min(0),
  /** Seconds until the first window is due; only on connecting/waiting states. */
  firstWindowInS: z.number().min(0).nullable(),
  cause: z.string().nullable(),
  action: z.string().nullable(),
  updatedAt: z.string(),
});
export type LiveCapture = z.infer<typeof LiveCaptureSchema>;



/** Composite payload of GET /jobs/:id/detail (ADAAAA-6851 Inc 3). */
export const JobDetailSchema = z.object({
  job: JobSchema,
  /** ADAAAA-7621: the POSTABLE list — precision-gated (rejected / non-scoring /
   * self-contradicting records excluded) and deduped, so no two windows overlap.
   * The full audit trail of every decide evaluation stays in `sections`.
   * ADAAAA-7984: each entry may carry the celebration alternatives delivered for
   * it (`alternatives`), so the surface groups them UNDER their owning highlight
   * instead of rendering them as separate highlight cards. */
  highlights: z.array(HighlightWithAlternativesSchema).default([]),
  /** ADAAAA-7621: "notable, not a goal" lane — non-rejected near_miss /
   * big_play clips, which are never postable as a GOAL. */
  notableHighlights: z.array(HighlightRecordSchema).default([]),
  /** ADAAAA-7621: overlapping clips merged out of `highlights`, each carrying
   * `duplicateOf` = the id of the moment that owns the footage. */
  duplicateHighlights: z.array(HighlightRecordSchema).default([]),
  traces: z.array(JobTraceSchema).default([]),
  sections: z.array(FrameSectionSchema).default([]),
  /** Capacity budget the job ran under (3 live / 8 VOD) so the UI can show headroom. */
  maxTraces: z.number().int().min(0),
  /** ADAAAA-7623: summary ladder derived from stored data (additive optional). */
  summaryLadder: SummaryLadderSchema.optional(),
  /** ADAAAA-7741: customer-facing processing-lag projection (additive optional —
   * absent on servers that predate it / payloads that never carried it). */
  liveProgress: LiveProgressSchema.optional(),
  /** ADAAAA-7750: the capture-state projection for a zero-window job (additive
   * optional — absent on servers that predate it). */
  capture: LiveCaptureSchema.optional(),
});
export type JobDetail = z.infer<typeof JobDetailSchema>;

// --- training pipeline re-exports (ADAAAA-5164) -----------------------------
// The dataset-curation pipeline (perceptual-hash bucketing, coverage, split,
// JSONL manifests) ships in ./training. Re-exported here so consumers use one
// import specifier (`@highlights/events`); safe because ./training only uses
// the schemas at call time, never at module-eval time (no init-cycle hazard).
export * from "./training";

// ADAAAA-7948 (Inc 3): the deterministic caption grounding gate every
// user-visible fast caption crosses (verdict-gated goal claims, sourced names,
// no internal tokens). Re-exported from the barrel, like ./training, so the
// server summary seam and the webapp seeded-caption seam share ONE import
// specifier and cannot drift (`@highlights/events`).
export * from "./caption-grounding";
