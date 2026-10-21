// Worker orchestration: one persistent perceive session per job, sample 1fps,
// feed frames to perceive, compute evidence, call decide on candidates, cut a
// clip on each highlight, and stop the session in `finally`.
import { randomUUID } from "node:crypto";
import type { HighlightRecord, HighlightTrigger, JobCandidate, TrackObservation } from "@highlights/events";
import { StageAMetrics } from "./stage-a-metrics";
import type { TrainArtifact } from "./db";
import {
  ObserveDecider,
  LiveObserver,
  applyOnDemandRecall,
  type ObserveDecidePayload,
  type PerFrameSeed,
  type PerFrameSignal,
  type ObserveBiasHint,
  type SignalGateOptions,
  OBSERVE_MAX_FRAMES,
  LIVE_OBSERVE_MAX_FRAMES,
  OBSERVE_CONTENT_FPS,
  OBSERVE_WINDOW_S,
} from "./observe-loop";
import { PerceiveCadence, type PerceiveCadenceOptions } from "./perceive-cadence";

export interface ReserveResult {
  sessionId: string;
  appUrl: string;
  controlUrl: string;
}
export interface ObservationResult {
  observation: {
    tracks: TrackObservation[];
    seq: number;
    timestamp: number;
    // I3 (ADAAAA-6360): the perceive OCR pass reads the scoreboard on candidate
    // anchor frames; the server folds the count into decide `ocrHits`.
    ocr?: string[];
    objects?: { label: string; confidence?: number; bbox: number[] }[];
    // ADAAAA-7145: perceive's additive per-frame `evidence` (goal/ball signal
    // fields: goalCrossed / ballOutcome / ballVelocity / ballPossession).
    // Consumed by the Tier-2 signal gate; absent when no goal-line/ball channel
    // judged the frame (recall-safe: the gate escalates).
    evidence?: PerFrameSignal;
  };
  candidate?: {
    eventType: string;
    timestamp: number;
    // INC-2 audio-gate signal and INC-2b ball signal ride the CandidateEvent
    // from perceive; the server folds them into decide() reaction evidence.
    audio?: AudioCandidate["audio"];
    ballVelocity?: { speedMps?: number };
    ballPossession?: { possessingPlayerId?: string };
    // Decide-leg I2 (ADAAAA-6359): goal-line / ball-outcome ground-truth
    // signal. Forwarded first-class to decide as a hard gate.
    goalCrossed?: boolean;
    ballOutcome?: string;
    // I3 (ADAAAA-6360): a scoreboard score change detected across the candidate
    // window — a hard, independent goal-confirmation signal.
    scoreBoardChanged?: boolean;
  };
}
/** People-reaction context (INC-4 / ADAAAA-4328) forwarded to decide() so the
 * Gemma prompt can reason about the humans' reaction. Corroborating evidence
 * only — never the highlight arbiter. All-zero == no reaction signal. */
export interface ReactionEvidence {
  crowdEnergy: number; // 0..1 peak of the INC-2 audio gate burst/swell
  audioKind: string; // "burst" | "swell" | "" when no audio reaction
  humansInMotion: number; // cheap visual celebration cue (tracked players counted)
  ballSpeedMps: number; // INC-2b ground-plane ball speed (0 when absent)
  ballPossessionId: string; // INC-2b possessor player id ("" when absent)
}
/** One per-detection geometry item forwarded to decide() (I4 / ADAAAA-6361) so
 * the prompt can cite concrete positions instead of guessing them from vision.
 * `bbox` is normalized [x1, y1, x2, y2] in 0..1 frame space. */
export interface DetectionEvidence {
  label: string;
  bbox: number[];
  confidence: number;
  trackId: string;
}
/** Normalized RMS energy (0..1) of a mono 16-bit PCM buffer — used to build the
 * audio-energy level curve (I4). Silent buffer -> 0. */
export function rmsNormalized(pcm: Buffer): number {
  if (!pcm || pcm.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    sum += s * s;
    n++;
  }
  if (!n) return 0;
  return Math.min(1, Math.sqrt(sum / n) / 32768);
}
/** Build the reaction evidence object for a candidate from whatever reaction
 * signals it carries (audio gate energy, ball velocity/possession) plus the
 * cheap visual cue (tracked-object count as humans-in-motion proxy). Fields
 * that are absent default to "no signal", so a candidate with no reaction data
 * forwards an all-zero reaction block (prompt renders without it). */
/** Clamp a numerical signal into the decide schema's accepted band. The decide
 * service enforces strict `le` bounds on crowdEnergy/trackCount (ADAAAA-4736):
 * real media sometimes reports peakEnergy > 1.0 or many tracked objects, and an
 * out-of-bounds value makes FastAPI reject the WHOLE request with HTTP 422,
 * killing the clip. The server is the owner of truth, so we clamp here to keep
 * the paid path inside schema bounds. */
export function clamp01(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
export function clampTrackCount(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return 0;
  return Math.min(2, Math.max(0, Math.round(v)));
}
/**
 * ADAAAA-7145: map perceive's per-frame signal `evidence` (goal/ball fields)
 * into the Tier-2 gate's {@link PerFrameSignal}. An absent evidence => undefined
 * (no signal reported; the gate escalates — recall-safe). A goal-line judgment
 * (goalCrossed / ballOutcome / ballInNet present) is marked `goalInfra: true` so
 * an explicit non-goal frame can be suppressed by the gate.
 */
export function seedSignalFromEvidence(evidence: PerFrameSignal | undefined): PerFrameSignal | undefined {
  if (!evidence) return undefined;
  const out: PerFrameSignal = { ...evidence };
  if (evidence.goalCrossed !== undefined || evidence.ballOutcome !== undefined || evidence.ballInNet !== undefined) {
    out.goalInfra = true;
  }
  return out;
}
export function buildReactionEvidence(
  candidate: {
    audio?: AudioCandidate["audio"];
    ballVelocity?: { speedMps?: number };
    ballPossession?: { possessingPlayerId?: string };
  },
  humansInMotion: number
): ReactionEvidence {
  return {
    crowdEnergy: clamp01(candidate.audio?.peakEnergy),
    audioKind: candidate.audio?.kind ?? "",
    humansInMotion: clampTrackCount(humansInMotion),
    ballSpeedMps: candidate.ballVelocity?.speedMps ?? 0,
    ballPossessionId: candidate.ballPossession?.possessingPlayerId ?? "",
  };
}
/**
 * The candidate signal shape a trigger is derived from (ADAAAA-6798 Inc 2).
 * Mirrors the candidate object produced by perceive / the video + audio legs so
 * the trigger provenance is a pure function of the candidate — no re-inference.
 */
export interface CandidateSignal {
  eventType: string;
  timestamp: number;
  seq?: number;
  audio?: AudioCandidate["audio"];
  ballVelocity?: { speedMps?: number };
  ballPossession?: { possessingPlayerId?: string };
  goalCrossed?: boolean;
  ballOutcome?: string;
  scoreBoardChanged?: boolean;
}

/**
 * Derive the trigger metadata for a candidate from the signal already computed
 * at decision time (ADAAAA-6798 Inc 2). Deterministic and purely derived from the
 * candidate object — NO new inference, no re-analysis. The `kind` is the
 * dominant trigger (or `corroborated` when >= 2 independent signals are present);
 * the raw reaction evidence is carried alongside so the UI can show provenance.
 */
export function deriveHighlightTrigger(c: CandidateSignal): HighlightTrigger {
  const audioKind = c.audio?.kind ?? "";
  const goalCrossed = c.goalCrossed === true;
  const scoreChanged = c.scoreBoardChanged === true;
  const ballSpeed = c.ballVelocity?.speedMps ?? 0;
  const ballPos = c.ballPossession?.possessingPlayerId ?? "";
  const signals: string[] = [];
  if (audioKind === "burst") signals.push("audio_burst");
  else if (audioKind === "swell") signals.push("audio_swell");
  if (goalCrossed) signals.push("goal_line");
  if (scoreChanged) signals.push("score_change");
  if (ballSpeed > 0 || ballPos) signals.push("ball_signal");
  let kind: HighlightTrigger["kind"];
  if (signals.length >= 2) kind = "corroborated";
  else if (signals.length === 1) kind = signals[0] as HighlightTrigger["kind"];
  else kind = "motion";
  return {
    kind,
    timestamp: c.timestamp,
    eventType: c.eventType,
    crowdEnergy: clamp01(c.audio?.peakEnergy) || undefined,
    audioKind: audioKind || undefined,
    ballSpeedMps: ballSpeed > 0 ? ballSpeed : undefined,
    ballPossessionId: ballPos || undefined,
    goalCrossed: goalCrossed || undefined,
    ballOutcome: c.ballOutcome || undefined,
    scoreBoardChanged: scoreChanged || undefined,
  };
}
/** ADAAAA-7028 Inc 2: the frame-group partition key for a candidate timestamp.
 * Mirrors the plan's 3 s frame-group window (FRAME_GROUP_WINDOW_S=3) so each
 * decide call resolves to a stable (sessionId, groupKey) and, once the
 * grouped-decide path lands, one decide_audit row per frame group. */
export function decideGroupKey(timestamp: number): string {
  return `g${Math.floor(timestamp / 3)}`;
}
export interface DecisionResult {
  isHighlight: boolean;
  score: number;
  eventType?: string;
  reason?: string;
  // Increment F / ADAAAA-6465: outcome taxonomy member + near-miss flag. A
  // near miss is notable but NOT a scoring play — surfaced at a lower score and
  // flagged so the highlight-clip is labeled distinctly downstream.
  outcome?: "scoring_play" | "near_miss" | "big_play" | "not_highlight";
  nearMiss?: boolean;
  // ADAAAA-7008 / ADAAAA-7012: when the verdict is uncertain and asks for MORE
  // evidence for this moment before finalizing, the server calls perceive
  // on-demand (`recallPerceive`) and folds the fresh context into the payload.
  // Absent / false => no recall (default). Optional + backward compatible.
  recall?: boolean;
  // ADAAAA-7111 (Increment D): the running video summary (story-so-far) the
  // decide brain updated for this window. The server persists it onto the job
  // and forwards it into the next cadence tick. Optional + additive.
  runningSummary?: string;
}
// ADAAAA-6855: map job-requested highlight labels (preferLabels) to the
// outcome taxonomy members they authorize for export. A requested non-goal
// class may be recorded as a DISTINCT highlight even though it is not a
// scoring play. Conservative — never widens goal acceptance. Mirrors the
// decide service's NON_GOAL_LABEL_OUTCOMES in gemma.py (keep in sync).
const NON_GOAL_LABEL_OUTCOMES: Record<string, Set<string>> = {
  goals: new Set(["scoring_play"]),
  "near-misses": new Set(["near_miss"]),
  saves: new Set(["near_miss", "big_play"]),
  "red cards": new Set(["big_play"]),
  "counter-attacks": new Set(["big_play"]),
};

function requestedOutcomes(preferLabels?: string[]): Set<string> {
  const out = new Set<string>();
  for (const lab of preferLabels ?? []) {
    const mapped = NON_GOAL_LABEL_OUTCOMES[lab.trim().toLowerCase()];
    if (mapped) for (const m of mapped) out.add(m);
  }
  return out;
}

/** ADAAAA-6969: derive the TRUE public `eventType` label from the outcome
 * taxonomy member. A non-scoring highlight (`near_miss` / `big_play`) is never
 * published as "GOAL" — the label reflects the outcome class (NEAR_MISS /
 * BIG_PLAY), so a keeper save / near-miss surfaces as a distinct non-goal
 * highlight. A frame-confirmed `scoring_play` stays "GOAL". Any other / unknown
 * outcome defers to `fallback` (the candidate/model label).
 *
 * Kept in sync with `event_type_for_outcome` in services/decide/app/gemma.py
 * (ADAAAA-6969) so the public label and the decide-note always agree. */
export function eventTypeForOutcome(
  outcome: DecisionResult["outcome"],
  fallback?: string
): string | undefined {
  switch (outcome) {
    case "scoring_play":
      return "GOAL";
    case "near_miss":
      return "NEAR_MISS";
    case "big_play":
      return "BIG_PLAY";
    default:
      return fallback;
  }
}

/** ADAAAA-6969: the eventType a highlight carries: the outcome-derived label
 * when the outcome is known (never a stale candidate/model "GOAL" on a
 * non-scoring class), else the decision's own eventType / candidate type. */
function highlightEventType(decision: DecisionResult, fallback?: string): string {
  return eventTypeForOutcome(decision.outcome, decision.eventType ?? fallback) ?? "";
}

/**
 * ADAAAA-6598: the single server-side accept gate. ONLY a frame-confirmed
 * scoring_play is a board-accepted GOAL highlight. A near_miss / big_play /
 * not_highlight read is never surfaced as a scoring highlight, even when a
 * rogue/misconfigured decide verdict sets isHighlight=true — so no false
 * positive reaches the board. A legacy verdict with no `outcome` is treated
 * per its isHighlight (backward compatible). This is defense-in-depth on top of
 * the decide service's own finalize_goal_acceptance.
 *
 * ADAAAA-6855: when the job explicitly requested a non-goal class in
 * `preferLabels`, that class is accepted as a DISTINCT highlight (outcome /
 * eventType preserved, never a goal) so a correctly-detected near-miss / save /
 * red-card / counter-attack is exported rather than swallowed.
 */
export function isAcceptedHighlight(d: DecisionResult, preferLabels?: string[]): boolean {
  if (!d.isHighlight) return false;
  if (d.outcome === undefined) return true; // legacy verdict, trust isHighlight
  if (d.outcome === "scoring_play") return true; // goal always a highlight
  return requestedOutcomes(preferLabels).has(d.outcome);
}

// ---------------------------------------------------------------------------
// Stage-2 goal/near-miss CONFIRMATION pass (ADAAAA-6797) — server-side VOD
// driver. The decide /confirm endpoint (services/decide/app/confirm.py) is the
// owner of the actual deep-frame-dive verdict; this file only (1) detects the
// trigger population (goal-type + no independent attestation + Stage-1
// scoring_play accept), (2) assembles the higher-fidelity confirm context from
// data the server already holds (cached frame window / trajectories / audio
// tap), (3) routes the candidate through the adapter `confirm()` call, and
// (4) adopts the reconciled decision (or keeps Stage-1 on passthrough / any
// failure). It is gated by `cfg.confirmEnabled` (VOD-first; the live pass
// never sets it) so the flag-off path is a strict no-op.
// ---------------------------------------------------------------------------

/** The Stage-2 confirmation-pass response (mirror of ConfirmDecision). */
export interface ConfirmDecision {
  /** Was the pass enabled on the decide side. */
  enabled: boolean;
  /** Structured verdict: confirmed_goal | near_miss | not_goal, or null on the
   * passthrough path (disabled / unparseable). */
  goalConfirmed?: "confirmed_goal" | "near_miss" | "not_goal" | null;
  /** Model self-confidence 0..1. */
  confidence: number;
  /** Short grounded reason naming the deciding evidence. */
  reason: string;
  /** Per-evidence tri-state read (true / false / null). */
  evidence: Record<string, boolean | null>;
  /** Whether this pass corrected the Stage-1 read (the core value metric). */
  stage1Disagreed: boolean;
  /** The reconciled HighlightDecision-shaped dict to adopt in place of the
   * Stage-1 verdict. On passthrough it is the (unchanged) Stage-1 verdict. */
  decision: DecisionResult;
}

/** The confirmation-pass request the adapter forwards to decide `/confirm`. */
export interface ConfirmRequest {
  eventType: string;
  timestamp: number;
  gameHint: string;
  /** Stage-1 primary-pass verdict, presented back to the model. */
  stage1: DecisionResult;
  /** Denser temporal frame window (~10-15 fps) around the event instant. */
  frames: { role: string; base64: string }[];
  /** Precise pre-event / event-instant / post-event keyframes. */
  keyframes: { role: string; base64: string }[];
  /** Object/ball trajectory tracks: { label, trackId, path: [[t,x,y],..] }. */
  trajectories: { label: string; trackId: string; path: number[][] }[];
  /** Motion / optical-flow magnitude at the event (0 when unavailable). */
  opticalFlowMagnitude: number;
  /** Motion magnitude series across the sample ([] when unavailable). */
  flowMagnitudes: number[];
  /** Short RMS audio-energy envelope ([] when unavailable). */
  audioLevels: number[];
  /** Surrounding audio clip (mono 16 kHz WAV base64) — "" when unavailable. */
  audioB64: string;
  /** Optional independent corroboration — INPUT only, never a gate. */
  ballOutcome?: string;
  goalCrossed?: boolean;
  scoreBoardChanged?: boolean;
}
/** One audio chunk fed to the Stage-A noise-change gate (INC-2 / ADAAAA-4325).
 * Owned by the server's ffmpeg audio tap: short (default ~100 ms) mono int16
 * little-endian PCM, base64-encoded, matched to perceive's AudioChunkRequest. */
export interface AudioChunk {
  /** Optional chunk sequence; <0 -> perceive uses its per-session counter. */
  seq: number;
  /** Seconds from stream start (this chunk's end timestamp). */
  timestamp: number;
  /** base64 of planar mono int16 LE PCM (ffmpeg `-ac 1 -c:a pcm_s16le -f s16le`). */
  samples: string;
  streamId?: string;
}
/** The audio noise-change gate fired a Stage-A candidate (INC-2 / ADAAAA-4325).
 * Returned by perceive /audio when the gate tripped; ``null`` when it did not.
 * The gate marks a candidate only — it never decides a highlight. The server
 * routes this to ``decide()`` on the anchored frame (slice 4). */
export interface AudioCandidate {
  eventType: string;
  seq: number;
  timestamp: number;
  audio?: {
    kind: string;
    ts: number;
    firedAt: number;
    onsetLatencyS: number;
    peakEnergy: number;
    baselineEnergy: number;
  };
}
/** The decide brain's single-shot what-to-track plan (plan §4.4 / §7 D).
 * Returned by PipelineClient.plan(). `maxTracks` arrives already clamped to
 * the mode cap (3 live / 8 VOD) by the decide runner. */
export interface TrackingPlanResult {
  planVersion: number;
  category: string;
  intent: string;
  source: "planner" | "planner-fallback";
  plannedAt?: number;
  anchor?: Record<string, unknown>;
  targets?: { label: string; role?: string; slotPriority?: number; track?: boolean }[];
  zones?: Record<string, unknown>[];
  discovery?: Record<string, unknown> | null;
  maxTracks: number;
  reason?: string;
  [k: string]: unknown;
}

export interface PlanRequest {
  intent: string;
  category: string;
  gameHint?: string;
  mode?: "live" | "vod";
  context?: Record<string, unknown>;
  /** ONE representative frame (base64 JPEG), never a sequence. */
  imageB64?: string;
}

/** ADAAAA-6489 / ADAAAA-7159 Gap 2: a REAL per-camera/per-clip goal-line
 * calibration delivered to perceive on every /analyze so the goal-line signal
 * (goalCrossed/ballOutcome) is genuine — never a fabricated uncalibrated flip.
 * `homography` is the row-major 3x3 image->field pitch homography (9 numbers)
 * for THIS session's camera/clip; `goalLine` is the goal-line plane spec in the
 * calibration's field coords `{axis, position, mouthMin, mouthMax}`. Absent ->
 * perceive falls back to image space / no goal-line signal (reported as
 * not_captured, never fabricated). */
export interface GoalLineCalibration {
  homography?: number[];
  goalLine?: { axis?: string; position?: number; mouthMin?: number; mouthMax?: number };
}

/** ADAAAA-6935: one Stage-A candidate trigger accumulated within a 3 s frame
 * group, carrying its own decide-evidence snapshot so a single merged group
 * review can return a per-trigger verdict (per-trigger accept / exactly-once
 * billing preserved, AC7). */
export interface GroupCandidate {
  /** The frame-group partition key: timestamp of the frame that fired it. */
  timestamp: number;
  eventType: string;
  /** Decide evidence snapshot captured at candidate fire time. */
  evidence: Parameters<PipelineClient["decide"]>[0];
}

/** ADAAAA-6935: the payload of ONE merged decide review over a 3 s frame
 * group. `frames` is the group's frame sequence (temporal order); the decide
 * service runs a SINGLE gemma review over them + every `candidates` entry and
 * returns one verdict per candidate (in order), so decide GPU calls drop from
 * ~#triggers to ~#groups-with-a-trigger. */
export interface GroupDecodeRequest {
  gameHint?: string;
  preferLabels?: string[];
  reasoningEffort?: string;
  /** The whole group's frame sequence (full frames, temporal order). */
  frames?: { role: string; base64: string }[];
  /** Surrounding audio clip (mono 16 kHz WAV, base64) for the group. */
  audioB64?: string;
  candidates: GroupCandidate[];
}

export interface PipelineClient {
  reservePerceive(): Promise<ReserveResult>;
  analyze(
    sessionId: string,
    frame: { seq: number; timestamp: number; imageB64: string; clipPath?: string },
    opts?: { gameHint?: string; preferLabels?: string[]; loraRef?: string; trackingPlan?: Record<string, unknown> } & GoalLineCalibration
  ): Promise<ObservationResult>;
  /** Single-shot what-to-track planner call (plan §4.4 / §7 D). The worker
   * fires this at stream-start warm-up + out-of-band re-check cadence — NEVER
   * from the per-frame hot path (the 1-5 s live budget rule). Priced like a
   * decide /highlight call. Returns a validated TrackingPlan or, on ANY
   * failure, a safe-default fallback (source "planner-fallback") — never an
   * exception, so a bad planner reply never kills a stream. */
  plan(req: PlanRequest): Promise<TrackingPlanResult>;
  /** Feed one audio chunk to the perceive session's Stage-A noise-change gate.
   * Pure DSP on the perceive side — never touches the detector/SAM/Gemma, so
   * this path bills no GPU. Fires a *candidate* only (returned to the caller so
   * the server can route it to ``decide()``); ``null`` when the gate didn't
   * trip. The gate never decides a highlight itself. */
  postAudio(sessionId: string, chunk: AudioChunk): Promise<AudioCandidate | null>;
  /**
   * Deliver an operator/find-and-track control intent (INC-6 / ADAAAA-4330) to
   * the perceive session over HTTP: `track`/`seed`/`lock`/`evict`, plus the
   * pre-existing configure/ping. The UI surfaces object selection (bbox) as a
   * `track` intent; perceive marks the slot selected and follows it. Best-effort:
   * a 404 (fresh session after re-reserve) is dropped, never fatal.
   */
  controlForward(sessionId: string, control: { type: string; [k: string]: any }): Promise<void>;
  /**
   * On-demand perceive recall (ADAAAA-7008 / ADAAAA-7012). When a decide verdict
   * requests more evidence for a moment, the server asks perceive for the
   * per-frame derived context (tracks / objects / ocr) ALREADY computed by
   * process_frame — WITHOUT re-running the detector — and the caller folds it
   * into the payload via `applyOnDemandRecall` before finalizing. `seeds` is `[]`
   * on a no-op (nothing cached / best-effort failure), which the caller treats
   * as "no new evidence" so a recall never regresses a decision. Optional so a
   * client/FAKE without recall support simply never recalls (no regression).
   */
  recallPerceive?(
    sessionId: string,
    req: { centerTs?: number; windowS?: number; startTs?: number; endTs?: number }
  ): Promise<{ centerTs?: number; seeds: PerFrameSeed[] }>;
  /**
   * Decide whether a candidate is a highlight. `imageB64` is the candidate
   * frame so the Gemma 12B QAT decide runner sees the actual moment (vision),
   * not just scalar evidence. Adapt the call site to forward it.
   */
  decide(
    evidence: {
      eventType: string;
      trackCount: number;
      maxVelocity: number;
      ocrHits: number;
      reaction?: ReactionEvidence; // INC-4 people-reaction context
      // Decide-leg I2 (ADAAAA-6359): goal-line / ball-outcome ground-truth
      // signal, forwarded first-class so decide can hard-gate on it.
      goalCrossed?: boolean;
      ballOutcome?: string;
      /** I3 (ADAAAA-6360): a scoreboard score change was detected across the
       * candidate window — a hard, independent goal-confirmation signal. The
       * decide runner must force isHighlight=true for a goal when set, and
       * treat absence as weak/absent evidence (never on its own a goal). */
      scoreBoardChanged?: boolean;
      // I4 / ADAAAA-6361: per-detection geometry + ball position + audio level
      // curve so the prompt can cite concrete evidence (all optional).
      detections?: DetectionEvidence[];
      ballPosition?: [number, number] | null;
      distanceToGoal?: number;
      goalLineDelta?: number;
      audioLevels?: number[];
    },
    opts?: {
      gameHint?: string;
      imageB64?: string;
      reasoningEffort?: string;
      /** Detail-first (ADAAAA-4954): temporal frame SEQUENCE the Gemma runner
       * reasons across (decideWindowN-length). Absent = single image (live). */
      frames?: { role: string; base64: string }[];
      /** Surrounding audio clip (mono 16 kHz WAV, base64) at the trigger. */
      audioB64?: string;
      /** The current 60 s window's already-computed facts as bounded text (A2,
       * ADAAAA-6029). Assembled on the server from cached findings — no
       * re-analysis. The decide-runner contract add (ADAAAA-6030) wires this
       * into the prompt; empty when the window has nothing to add. */
      priorContextText?: string;
      /** ADAAAA-7028 Inc 2 audit identity forwarded so the decide audit
       * descriptor keys the durable index by (sessionId, groupKey). */
      jobId?: string;
      groupKey?: string;
      /** ADAAAA-7111 (Increment D): the running video summary (story-so-far)
       * carried into this cadence decide so the model EXTENDS it. Empty on the
       * first tick. Absent = no prior summary (unchanged behaviour). */
      storySoFar?: string;
    }
  ): Promise<DecisionResult>;
  /**
   * Decide ALL candidates in one 3 s frame group with a SINGLE gemma review
   * (ADAAAA-6935). `req.frames` is the group's frame sequence; the decide
   * service runs ONE inference over them + every `req.candidates` entry and
   * returns a verdict per candidate, in candidate order. Per-trigger accept
   * side-effects (cut / highlight record / billing exactly once) are applied
   * by the caller, so merged grouping never drops a genuine highlight or
   * double-bills (AC7). Optional: a client (or test fake) that does not
   * implement the merged review falls back to a per-candidate `decide` loop,
   * preserving the old per-trigger behavior with no regression.
   */
  decideGroup?(req: GroupDecodeRequest): Promise<{ verdicts: DecisionResult[] }>;
  /**
   * Stage-2 goal/near-miss confirmation pass (ADAAAA-6797). For a goal-type
   * candidate that carried no independent attestation and read as a Stage-1
   * scoring_play, run the decide `/confirm` deep frame dive with the Stage-1
   * verdict + the higher-fidelity confirm context, and return the reconciled
   * verdict. Reuses the same fixed-price decide-runner path as `decide`/`
   * /highlight` (1 billable unit; 402 -> signer -> retry). The runner returns a
   * passthrough (goalConfirmed null) when disabled/unparseable, and a transport
   * failure is a rejected promise — either way the caller keeps Stage-1.
   */
  confirm(req: ConfirmRequest, opts?: { reasoningEffort?: string }): Promise<ConfirmDecision>;
  /**
   * Submit a single-shot fine-tune job to the highlights-train runner
   * (Florence-2 <OD> LoRA). The runner blocks until the job finishes and the
   * 200 body carries the trained checkpoint path + eval delta report, which the
   * server folds into the surfaced TrainRun result.
   */
  train(request: TrainRunRequest): Promise<TrainResult>;
  stopPerceive(sessionId: string): Promise<void>;
}

/** Manifest + hyper-params for a highlights-train single-shot job. Mirrors the
 * env contract of the train-entrypoint (docker/train-entrypoint.sh). */
export interface TrainRunRequest {
  manifest: string; // JSONL DetectionTrainingSample manifest (newline-delimited JSON)
  val?: string; // optional held-out val manifest (JSONL)
  epochs?: number; // default 5
  batchSize?: number; // default 8
  lr?: number; // default 1e-4
  baseModel?: string; // default microsoft/Florence-2-base
}

/** Result of a completed highlights-train job (mirrors fine_tune_od.py output). */
export interface TrainResult {
  run?: string;
  checkpoint?: string;
  out?: string;
  adapter?: string;
  eval?: {
    eval?: string; // "skipped" when no val manifest
    reason?: string;
    precision?: number;
    recall?: number;
    f1?: number;
    [k: string]: unknown;
  };
  /** Run-scoped downloadable artifact metadata (fileName + integrity hash). */
  artifact?: TrainArtifact;
  epochs?: number;
  samples?: number;
  [k: string]: unknown;
}

export interface AnalyzerConfig {
  clipBeforeS: number;
  clipAfterS: number;
  jobId: string;
  gameHint: string;
  /**
   /** Operator closed-vocabulary labels (ADAAAA-4109). Delivered to the perceive
    * session on every /analyze alongside gameHint so the paid VOD path activates
    * the closed soccer roster (`resolve_vocabulary`) instead of open-set OD.
    */
   preferLabels?: string[];
  /** Per-stream LoRA injection (ADAAAA-5324): optional ref to this job's
   * stream-attached merged Florence-2 model dir. When unset the perceive
   * session serves the base model (no regression on base-stream detection).
   * Flowed to perceive on every /analyze exactly like gameHint/preferLabels. */
  loraRef?: string;
  /** Per-camera/per-clip goal-line calibration (ADAAAA-6489 / ADAAAA-7159 Gap 2):
   * a REAL image->field pitch homography + goal-line plane spec for THIS
   * session's clip/camera, delivered to the perceive session on every /analyze
   * (with gameHint/preferLabels/trackingPlan) so the goal-line crossing signal
   * (goalCrossed/ballOutcome) is genuine, not a single static env value. When a
   * clip has no calibrated homography/spec the fields are simply absent, so
   * perceive emits no ballOutcome/goalCrossed and the metric reports
   * not_captured (never a fabricated signal). */
  calibration?: GoalLineCalibration;
  /** Detail-first VOD knobs (ADAAAA-4954, spec §1). When absent the pass runs at
    * the live/default depth (1 fps frames, 16-frame window, single decide image).
    * When `decideWindowN` is set the pass is "detail-first": the shared frame
    * window is that long, and each decide() call forwards the temporal
    * `frames[]` SEQUENCE (+ surrounding audio clip) so Gemma reasons deeper per
    * trigger than the single-image live baseline. `frameScale` is the extract
    * scale for OD + decide images. */
   sampleFps?: number;
   frameScale?: string;
   decideWindowN?: number;
   /** I7 / ADAAAA-6361: higher-FPS re-sample around a trigger. When set (detail-
    * first VOD), the decide call site re-samples frames around the candidate
    * timestamp at a higher FPS so the ball-goal-crossing instant is actually in
    * the decide window (a 1 FPS / low-fps sample can skip it). Returns absolute-
    * timestamped frames (always >= 1); a throw/[] degrades to the rolling window. */
   resampleFrames?: (timestamp: number) => Promise<{ timestamp: number; imageB64: string }[]>;
   /**
   * ADAAAA-6314 Path 2: forward the surrounding audio clip on the LIVE baseline
   * too (bounded to trigger candidates — never every frame; no `frames[]`
   * change, so live frame depth is untouched). The go-livepeer decide runner
   * (or the ASR endpoint it calls) transcribes it to text for the gemma prompt.
   * Default off so the deployed live baseline sends no new payload until an
   * operator enables it. `LIVE_AUDIO_CONTEXT`.
   */
   audioContext?: boolean;
  /** Increment F / ADAAAA-6465 (plan §4.9): analysis FPS cap for the assembly
   * of the frame sequence the LLM watches per trigger. Default 5 (live). The
   * sequence is sampled at this rate around the trigger, always includes the
   * keyframe set, and is HARD-CAPPED at `maxFramesPerAnalysis`. Frames are the
   * PRIMARY evidence; audio is a cheap, fallible trigger/corroboration. Raising
   * the cap is a per-call Livepeer GPU cost decision. `ANALYSIS_FPS` /
   * `VOD_ANALYSIS_FPS` (VOD detail-first gets a higher cap). */
   analysisFps?: number;
  /** Hard cap on the number of frames that reach the LLM in ONE analysis call
   * (never exceeded — plan §4.9D). Live default ≈ 25 + 3 keyframes = 30.
   * `MAX_FRAMES_PER_ANALYSIS` / `VOD_MAX_FRAMES_PER_ANALYSIS`. */
   maxFramesPerAnalysis?: number;
  /** Pre/post window (seconds) around the trigger the assembler samples.
   * Default 2 s pre / 3 s post (plan §4.9A). VOD may lengthen these (detail-
   * first; speed secondary). `ANALYSIS_PRE_WINDOW_S` / `ANALYSIS_POST_WINDOW_S`. */
   preWindowS?: number;
   postWindowS?: number;
  /**
   * Max times the job will re-reserve a fresh perceive session after the
   * current one is lost mid-pass (HTTP 404 "runner not found" / "runner
   * session not found"). The perceive live-runner's health can flap and
   * go-livepeer then releases all its sessions, turning the in-flight
   * `/analyze` into a 404. Bounded re-reserve lets a VOD pass ride through a
   * transient perceive restart by reconnecting to the recovered runner;
   * beyond this we abort cleanly instead of spinning. Default 3.
   */
  maxReReserves?: number;
  /**
   * ADAAAA-6577: base delay (ms) of the bounded exponential backoff slept
   * between a session-lost re-reserve and the next retry of the same frame.
   * A flapping perceive runner 404s every /analyze; backing off (500ms -> 1s
   * -> 2s -> …, capped) keeps the re-reserve cadence near ~1/sec and lets the
   * pass ride through a brief runner recovery instead of hammering the
   * orchestrator. Wired from `VOD_SESSION_RETRY_BACKOFF_MS` (default 500).
   */
  sessionRetryBackoffMs?: number;
  /** ADAAAA-6577: upper bound (ms) of the exponential backoff above. The delay
   * never exceeds this, so a long-lived flap still re-reserves at most
   * `maxReReserves` times per frame at the capped cadence and then aborts.
   * Wired from `VOD_SESSION_RETRY_BACKOFF_MAX_MS` (default 8000). */
  sessionRetryBackoffMaxMs?: number;
  /**
   * Increment D (ADAAAA-6467): the stream-start warm-up window (seconds)
   * within which exactly ONE planner call must deliver a valid TrackingPlan
   * before the per-frame loop begins steady-state tracking. The worker does
   * NOT block the per-frame loop on the planner; it applies a safe-default
   * interim roster (via the session's trackingPlan from perceive's canned
   * map) until the plan lands. Exceeding the window just means the plan
   * applies late — never a per-frame planner call. `WARMUP_SECONDS` (default
   * 3).
   */
  warmupSeconds?: number;
  /**
   * Increment D (ADAAAA-6467): the out-of-band re-check cadence (seconds).
   * A scheduler samples a few frames from the rolling frame window OFF the
   * per-frame path and re-plans the TrackingPlan, swapping the active roster
   * within (~) this interval when the brain detects a type change (scene cut
   * / different feed). Default 10. `RECHECK_INTERVAL_SECONDS`.
   */
  recheckIntervalSeconds?: number;
  /**
   * The pass mode (live | vod), forwarded to the planner so it proposes
   * within the correct cap (3 live / 8 VOD). The live path is "live"; the
   * detail-first VOD path is "vod". Default "live".
   */
  planMode?: "live" | "vod";
  /**
   * ADAAAA-6610 GOAL burst-suppression window (seconds) for this pass. At most
   * one GOAL highlight is accepted per this window so a start-of-clip burst of
   * confabulated goals cannot flood the accepted list. Default 30.
   */
  goalBurstWindowS?: number;
  /**
   * ADAAAA-6851 Inc 2: persist EVERY decide evaluation (accepted highlight,
   * burst-suppressed, near-miss, not-highlight) with its trigger timestamp +
   * reason/score/eventType/outcome. Wired in the server to a durable store
   * write-through so the full-screen job detail can show decide notes on every
   * trigger after a restart. Best-effort: a throwing callback is caught and
   * logged by the caller, never allowed to fail the frame loop.
   */
  onDecision?: (cand: JobCandidate) => void;
  /** ADAAAA-6797: run the Stage-2 goal/near-miss confirmation pass on this
   * pass. Only the VOD path sets it (from `DECIDE_CONFIRM_ENABLED`); the live
   * pass leaves it unset so live is untouched during VOD-first rollout. When
   * set, an un-attested goal-type candidate whose Stage-1 read is a
   * scoring_play accept is routed through the decide `/confirm` deep frame
   * dive and the reconciled verdict is adopted in its place. */
  confirmEnabled?: boolean;
  /**
   * ADAAAA-7162 (CEO feedback on ADAAAA-7134): extra seconds (each side) the
   * Stage-2 confirmation frame window is expanded beyond the Stage-1 pre/post
   * window, so the confirm pass sees the ball actually cross the line / enter
   * the net rather than a single boundary frame. Default 4 s (a 3-5 s window
   * per the requirement); `DECIDE_CONFIRM_EXTRA_WINDOW_S`.
   */
  confirmWindowExtraS?: number;
  /**
   * ADAAAA-7007: enable the VOD decide-observer architecture. When set (with
   * `decideWindowN` also set, i.e. the VOD detail-first pass), the vision LLM
   * becomes the primary observer: decide is invoked on a ~3 s cadence with a
   * ~10 s overlapping reference window (<=30 frames), and perceive becomes a
   * data seeder + on-demand provider rather than the candidate on/off gate.
   * Default off; the candidate-gated path stays the live/default behavior until
   * the observer pass is validated end-to-end. Wired from
   * `VOD_OBSERVE_LOOP` (server config). */
  observeLoop?: boolean;
  /**
   * ADAAAA-7007: observe-loop cadence (content seconds) between decide
   * invocations. Default 3 (`OBSERVE_CADENCE_S`). Optional so the flag-on path
   * can be tuned without code change.
   */
  observeCadenceS?: number;
  /**
   * ADAAAA-7007: observe reference window length (content seconds) assembled
   * around the current moment. Default 10 (`OBSERVE_WINDOW_S`). Decides only
   * fire after the window cadence elapses so consecutive windows overlap.
   */
  observeWindowS?: number;
  /**
   * ADAAAA-7007: observe hard frame cap per decide invocation. Default 30
   * (`OBSERVE_MAX_FRAMES`). A denser window is subsampled to this cap.
   */
  observeMaxFrames?: number;
  /**
   * ADAAAA-7145: enable the Tier-2 signal gate on the decide-observer so a
   * billable decide call only fires on a window with a real highlight signal
   * (ball-in-net / goal-crossed / scoreboard change / confident motion+audio),
   * cutting per-job decide volume + latency. Recall-safe: an uncalibrated /
   * unsignaled window always escalates, so a genuine goal is never starved.
   * Default off (existing high-recall cadence unchanged) until box QA confirms
   * goal recall after the perceive goal-line/homography channels are enabled.
   * `OBSERVE_SIGNAL_GATE` (server config).
   */
  observeSignalGate?: boolean;
  /**
   * ADAAAA-7147: tuning for the Tier-2 signal gate's calibration-free
   * ball-velocity discriminator. `ballMinSpeedMps` is the image-space
   * `speedMps` at/above which a frame is a "meaningful ball"; `suppressQuiet`
   * drops a quiet uncalibrated no-signal window instead of recall-escalating
   * (the fix that makes the gate actually cut decide volume on a box with no
   * goal-line/homography/scoreboard channel). Both absent => the gate keeps the
   * recall-safe baseline. Wired from `OBSERVE_SIGNAL_GATE_BALL_MIN_SPEED` /
   * `OBSERVE_SIGNAL_GATE_SUPPRESS_QUIET`.
   */
  observeSignalGateOpts?: SignalGateOptions;
  /**
   * ADAAAA-7152 Gap 1: adaptive perceive cadence for the VOD detail-first pass.
   * When active, the per-frame `client.analyze` (the expensive perceive pass that
   * dominates VOD E2E) runs at a REDUCED cadence in "cool" (no-signal) regions
   * and at FULL cadence around any window the Tier-2 signal gate escalates, so
   * the escalated goal window is never starved and non-goal clips do not flood.
   * Tri-state: `true` forces on, `false` forces off, `undefined` auto-enables
   * exactly when the gap-1 target configuration is present (`observeLoop` AND
   * `observeSignalGate` both set with `decideWindowN`, i.e. the gated VOD
   * detail-first pass). Default undefined (auto). `PERCEIVE_CADENCE`.
   */
  perceiveCadence?: boolean;
  /** ADAAAA-7152 Gap 1: cool-region perceive stride (perceive every
   * `quietStride`-th frame where no signal escalated). 1 = full pass.
   * `PERCEIVE_QUIET_STRIDE` (default 2). */
  perceiveQuietStride?: number;
  /** ADAAAA-7152 Gap 1: seconds of FULL-perceive treatment after a frame
   * escalates the Tier-2 gate (covers the decide observer's reference window).
   * Default the observe window (`observeWindowS`). `PERCEIVE_HOT_AFTER_S`. */
  perceiveHotAfterS?: number;
  /**
   * ADAAAA-7011: enable the LIVE decide-observer architecture. When set (with
   * `decideWindowN` UNSET, i.e. the live/default pass), decide is driven on the
   * ~3 s cadence REGARDLESS of whether perceive emitted a candidate, using the
   * `LiveObserver` (rolling PAST ~10 s window, <=30-frame cap). Perceive becomes
   * a data seeder + on-demand provider; candidate triggers are folded into
   * `biasHints` (provenance) and never gate decide, so trigger-FP gating no
   * longer limits recall. Accepts share `acceptVideoDecision` (clip cut + record
   * + SSE highlight + decision-time billing). Default off; the candidate-gated
   * live baseline stays the behavior until the observer pass is validated.
   * Wired from `LIVE_OBSERVE_LOOP` (server config).
   */
  liveObserveLoop?: boolean;
  /** ADAAAA-7028 Inc 2: persist the decide audit descriptor returned on the
   * decision (`_audit`) so the durable decide_audit index + decision-trail has
   * one row per frame group. Best-effort: a throwing onDecideAudit is caught
   * + logged, never a pipeline failure. */
  onDecideAudit?: (desc: unknown) => void;
  /** ADAAAA-7111 (Increment D): read the job's current running video summary
   * (story-so-far) so the next cadence decide request can carry it forward.
   * Absent => no prior summary (the decide runs without one). */
  getRunningSummary?: () => string;
  /** ADAAAA-7111 (Increment D): persist the updated running video summary after
   * a cadence decide, so the job-detail endpoint + web UI surface it growing.
   * Best-effort: a throwing callback is caught + logged, never a pipeline
   * failure. */
  onRunningSummary?: (summary: string) => void;
}

/**
 * The perceive session/runner disappeared while a pass was in flight (the
 * orchestrator returned HTTP 404 "runner not found" / "runner session not
 * found" for our proxied analyze call — released because the static runner's
 * health flapped, or the session was explicitly released). A caller may safely
 * re-reserve a fresh session and retry the current frame. Any other analyze
 * error stays a plain Error and aborts the pass.
 */
export class SessionLostError extends Error {
  constructor(msg = "perceive session/runner lost (404)") {
    super(msg);
    this.name = "SessionLostError";
  }
}

/** ADAAAA-6577: sleep `ms` milliseconds (returns when the timeout elapses).
 * Pure async util so the bounded-backoff cadence is observable in tests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** ADAAAA-6577: bounded exponential backoff delay (ms) for the `attempt`-th
 * re-reserve of a lost perceive session. `baseMs` doubles per attempt and is
 * capped at `maxMs`, so a flapping runner never gets a request storm (base
 * 500ms -> 1s -> 2s -> 4s, cap 8s). Pure function — trivially unit-testable. */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs);
}

/** Compute per-job evidence from the observation stream. */
export class EvidenceTracker {
  private prev = new Map<string, { cx: number; cy: number }>();
  maxVelocity = 0;
  trackCount = 0;
  step(obs: { tracks: TrackObservation[] }): void {
    // Clamp into the decide schema's accepted band ([0,2], ADAAAA-4736): real
    // multi-player tracking can exceed 2 objects and an out-of-range value
    // makes FastAPI 422-reject the whole payload. Server is owner of truth.
    this.trackCount = clampTrackCount(obs.tracks.length);
    for (const t of obs.tracks) {
      const [bx1, by1, bx2, by2] = t.bbox;
      const cx = (bx1 + bx2) / 2;
      const cy = (by1 + by2) / 2;
      const p = this.prev.get(t.trackId);
      if (p) {
        const d = Math.abs(cx - p.cx) + Math.abs(cy - p.cy);
        if (d > this.maxVelocity) this.maxVelocity = d;
      }
      this.prev.set(t.trackId, { cx, cy });
    }
  }
}

export interface AnalyzeOutcome {
  sessionId: string;
  highlights: HighlightRecord[];
  framesAnalyzed: number;
  /** ADAAAA-7152 Gap 1: number of frames actually sent to perceive (<=
   * `framesAnalyzed` when the adaptive perceive cadence is active; equal to it
   * on the full pass). Metric for confirming the VOD perceive cost was cut. */
  perceiveCalls?: number;
  /** ADAAAA-7011: live decide-observer cadence + decide gemma E2E latency
   * snapshot (absent when the live observer was not enabled). Populated from
   * LiveObserver.latencySamples() so the Livepeer runner shows the ~30 s budget
   * utilization (cadence + gemma E2E). */
  observeMetrics?: LiveObserveMetricsSnapshot;
  /** ADAAAA-7007: VOD decide-observer per-call input-size + cap snapshot
   * (absent when the VOD observer was not enabled). Populated from
   * ObserveDecider so the VOD job record carries the <=30-frame cap-exercised
   * count + per-call decide input size for the -67% cost measure. */
  vodObserveMetrics?: VodObserveMetricsSnapshot;
}

/** ADAAAA-7011: live decide-observer cadence + decide gemma E2E latency
 * snapshot, recorded onto the live job so the cadence + gemma E2E latency are
 * inspectable on the Livepeer runner (the ~30 s budget = ~3 s cadence + the
 * gemma end-to-end latency). Mirrors the StageAMetrics snapshot convention. */
export interface LiveObserveMetricsSnapshot {
  /** Number of decide invocations that fired on the cadence. */
  decideCalls: number;
  /** Decisions that became an accepted highlight. */
  accepted: number;
  /** Max frames in a single decide payload (<= LIVE_OBSERVE_MAX_FRAMES). */
  maxFrames: number;
  /** Mean decide gemma end-to-end latency (ms). */
  meanE2eMs: number;
  /** Max decide gemma end-to-end latency (ms). */
  maxE2eMs: number;
  /** Mean content-time cadence between consecutive fired ticks (ms). */
  meanCadenceMs: number;
  /** Max content-time cadence between consecutive fired ticks (ms). */
  maxCadenceMs: number;
}

/** ADAAAA-7007: VOD decide-observer per-call input-size + cap snapshot, recorded
 * onto the VOD job so the acceptance criteria are inspectable per job: the
 * <=30-frame cap actually exercised (`subsampledCalls>0`) and the per-call
 * decide input-size distribution (`framesPerCall`, the -67% cost-measure
 * input). Mirrors the live {@link LiveObserveMetricsSnapshot} convention. */
export interface VodObserveMetricsSnapshot {
  /** Number of decide invocations that fired on the cadence. */
  decideCalls: number;
  /** Decisions that became an accepted highlight. */
  accepted: number;
  /** Max frames in a single decide payload (<= OBSERVE_MAX_FRAMES = 30). */
  maxFrames: number;
  /** Calls where the max-frames cap forced a subsample (proves cap exercised). */
  subsampledCalls: number;
  /** Per-call decide input-size distribution (frame count per invocation). */
  framesPerCall: number[];
}

/** Build the VOD decide-observer per-call input-size + cap snapshot from the
 * decider's report ticks (pure aggregation of {@link ObserveDecider}). */
export function buildVodObserveMetrics(obs: ObserveDecider): VodObserveMetricsSnapshot {
  return {
    decideCalls: obs.decideCalls(),
    accepted: obs.acceptedCount(),
    maxFrames: obs.maxFrameCount(),
    subsampledCalls: obs.subsampledCallCount(),
    framesPerCall: obs.inputSizeSamples(),
  };
}

/** Build the live decide-observer latency/cadence snapshot from the observer's
 * measured samples (pure aggregation of {@link LiveObserver.latencySamples}). */
export function buildLiveObserveMetrics(obs: LiveObserver): LiveObserveMetricsSnapshot {
  const samples = obs.latencySamples();
  const cadences = samples.map((s) => s.cadenceMs).filter((c) => c > 0);
  const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    decideCalls: obs.decideCalls(),
    accepted: obs.acceptedCount(),
    maxFrames: obs.maxFrameCount(),
    meanE2eMs: Number(obs.meanE2eMs().toFixed(1)),
    maxE2eMs: Number(obs.maxE2eMs().toFixed(1)),
    meanCadenceMs: Number(avg(cadences).toFixed(1)),
    maxCadenceMs: cadences.length ? Number(Math.max(...cadences).toFixed(1)) : 0,
  };
}

/**
 * Rolling window of the most recent sampled frames (seq -> {timestamp, image}).
 * A tracker candidate may be ANCHORED at an earlier (peak-motion / strike) frame
 * than the one whose /analyze triggered it, so `decide` should see that anchored
 * frame's image — not the late post-strike frame — to judge the actual moment.
 */
const DECIDE_FRAME_WINDOW = 16;

/** Rolling cache window (seconds) — the "current-context buffer" (plan §A,
 * ADAAAA-6029). Frames (and their already-computed findings) older than this
 * drop out of the window and are no longer part of a decide() call's context.
 * Grows the legacy 16-frame default to a 60 s window. */
export const DECIDE_WINDOW_SECONDS = 60;
/** Hard memory bound for the cache: at ~1 fps, 60 s ≈ 60 frames. The cache
 * never grows on long streams — a higher-fps VOD pass is still hard-capped at
 * this many retained frames. */
export const CACHE_MAX_FRAMES = 60;
/** Token-budget cap for the assembled window-facts text (A2). ~2400 chars ≈
 * ~500–600 tokens; the prior-context the decide prompt is augmented with never
 * exceeds this. Content beyond the cap is dropped oldest-first at assembly. */
export const WINDOW_FACTS_MAX_CHARS = 2400;
/** ADAAAA-6610 temporal burst suppression window (seconds): at most one GOAL
 * highlight is accepted per this window in a run, so a start-of-clip burst of
 * confabulated goals cannot flood the accepted list. */
export const DEFAULT_GOAL_BURST_SUPPRESS_S = 30;

// ---------------------------------------------------------------------------
// Increment F / ADAAAA-6465: frame-watching assembler (plan §4.9C).
// The analysis LLM watches a bounded SEQUENCE of actual stream frames around
// each trigger — this is the PRIMARY evidence path; audio is a cheap, explicitly
// fallible trigger/corroboration (crowds erupt for near misses / wrong calls /
// replays). The sequence is sampled from the already-cached frame window at
// `analysis_fps` (default 5), always includes a keyframe set (trigger-onset,
// peak-audio, window-end), and is HARD-CAPPED at `max_frames_per_analysis`.
// ---------------------------------------------------------------------------

/** Default analysis FPS cap for the live pass (plan §4.9A): ~5 fps over a
 * ~5 s window ≈ 25 frames + 3 keyframes. Raising this is a per-call Livepeer
 * GPU cost decision, not a code change. */
export const DEFAULT_ANALYSIS_FPS = 5;
/** Hard cap on the number of frames that can reach the LLM in ONE analysis
 * call (plan §4.9D / §14.6). Never exceeded. Live default ≈ 25 + 3 keyframes. */
export const DEFAULT_MAX_FRAMES_PER_ANALYSIS = 30;
/** Pre/post window (seconds) around the trigger the assembler samples (plan
 * §4.9A: default ~2 s pre / ~3 s post — covers the play, the crossing/contact
 * moment, and the reaction). */
export const DEFAULT_PRE_WINDOW_S = 2;
export const DEFAULT_POST_WINDOW_S = 3;

/** A single candidate frame the assembler may select. `keyframe` is one of
 * "trigger" | "peak_audio" | "window_end" (plan §4.9A keyframe set) or null for
 * a regular sampled frame. */
export interface AssembledFrame {
  timestamp: number;
  base64: string;
  keyframe?: "trigger" | "peak_audio" | "window_end";
}

/** Assemble the capped frame sequence for one analysis call (increment F).
 *
 * Pure + deterministic so it is unit-testable. Input is the already-cached
 * rolling frame window (oldest -> newest, each with a timestamp + base64 image).
 * Selection rules (plan §4.9A):
 *   1. Keep only frames inside [triggerTs - preWindowS, triggerTs + postWindowS].
 *   2. Sample down to `analysis_fps` — pick frames whose timestamp is nearest to
 *      an even `1/analysis_fps` grid across the window (so a ~5 s window at 5 fps
 *      yields ~25 frames). Always keeps the first and last in-window frame.
 *   3. Add the keyframe set: trigger-onset (nearest frame to triggerTs),
 *      peak-audio (nearest frame to `peakAudioTs`, when supplied), window-end
 *      (the last in-window frame) — deduped.
 *   4. HARD-CAP at `maxFramesPerAnalysis` (default 30). If over, keep the
 *      keyframes and thin the regular sample oldest-first so the total never
 *      exceeds the cap.
 * Returns ImageRef-shaped `[{ role: "full", base64 }]` ordered oldest -> newest,
 * EXACTLY the shape gemma `ask(frames=...)` consumes. An empty window yields [].
 */
export function assembleFrameSequence(
  frames: { timestamp: number; imageB64: string }[],
  opts: {
    triggerTs: number;
    analysisFps?: number;
    maxFramesPerAnalysis?: number;
    preWindowS?: number;
    postWindowS?: number;
    peakAudioTs?: number;
  }
): { role: string; base64: string }[] {
  const {
    triggerTs,
    analysisFps = DEFAULT_ANALYSIS_FPS,
    maxFramesPerAnalysis = DEFAULT_MAX_FRAMES_PER_ANALYSIS,
    preWindowS = DEFAULT_PRE_WINDOW_S,
    postWindowS = DEFAULT_POST_WINDOW_S,
    peakAudioTs,
  } = opts;
  const inWindow = frames
    .filter((f) => f.timestamp >= triggerTs - preWindowS && f.timestamp <= triggerTs + postWindowS)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!inWindow.length) return [];

  // --- keyframe set (always included) --------------------------------------
  const keyframes = new Map<string, AssembledFrame>();
  const nearest = (ts: number): AssembledFrame | undefined => {
    if (!Number.isFinite(ts)) return undefined;
    let best: AssembledFrame | undefined;
    let bestDiff = Infinity;
    for (const f of inWindow) {
      const d = Math.abs(f.timestamp - ts);
      if (d < bestDiff) {
        bestDiff = d;
        best = { timestamp: f.timestamp, base64: f.imageB64 };
      }
    }
    return best;
  };
  const trigger = nearest(triggerTs);
  if (trigger) keyframes.set(`trigger@${trigger.timestamp}`, { ...trigger, keyframe: "trigger" });
  if (peakAudioTs !== undefined) {
    const peak = nearest(peakAudioTs);
    if (peak && !keyframes.has(`trigger@${peak.timestamp}`)) {
      keyframes.set(`peak@${peak.timestamp}`, { ...peak, keyframe: "peak_audio" });
    }
  }
  const end = inWindow[inWindow.length - 1];
  if (!keyframes.has(`trigger@${end.timestamp}`) && !keyframes.has(`peak@${end.timestamp}`)) {
    keyframes.set(`end@${end.timestamp}`, { timestamp: end.timestamp, base64: end.imageB64, keyframe: "window_end" });
  }

  // --- regular sample at analysis_fps ---------------------------------------
  const step = analysisFps > 0 ? 1 / analysisFps : Infinity;
  const start = inWindow[0].timestamp;
  const endTs = inWindow[inWindow.length - 1].timestamp;
  const sampled: AssembledFrame[] = [];
  for (let t = start; t <= endTs + 1e-9; t += step) {
    const n = nearest(t);
    if (n) sampled.push(n);
  }
  // Dedupe by timestamp, keep first occurrence (grid order).
  const seen = new Set<number>();
  const grid: AssembledFrame[] = [];
  for (const s of sampled) {
    if (!seen.has(s.timestamp)) {
      seen.add(s.timestamp);
      grid.push(s);
    }
  }
  // Merge keyframes (they are decision-relevant even if the grid thinned them).
  const merged = new Map<number, AssembledFrame>();
  for (const s of grid) merged.set(s.timestamp, s);
  for (const k of keyframes.values()) merged.set(k.timestamp, k);
  let ordered = [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);

  // --- hard cap ---------------------------------------------------------------
  if (ordered.length > maxFramesPerAnalysis) {
    const keepTs = new Set(ordered.filter((f) => f.keyframe).map((f) => f.timestamp));
    const nonKey = ordered.filter((f) => !keepTs.has(f.timestamp));
    let extra = maxFramesPerAnalysis - keepTs.size;
    if (extra < 0) extra = 0;
    const keptKey = ordered.filter((f) => keepTs.has(f.timestamp));
    // Spread the remaining budget evenly across the non-key frames oldest-first.
    const thinned = nonKey.filter((_, i) => i < extra);
    ordered = [...keptKey, ...thinned].sort((a, b) => a.timestamp - b.timestamp);
    // Final safety clamp (defensive; guarantees the hard cap is never breached).
    if (ordered.length > maxFramesPerAnalysis) ordered = ordered.slice(0, maxFramesPerAnalysis);
  }
  return ordered.map((f) => ({ role: "full", base64: f.base64 }));
}

/** Already-computed perception findings for one in-window sampled frame (A1).
 * These come from the `/analyze` result the server already paid for — cached
 * and REUSED by window-facts assembly, never re-analyzed (no extra GPU). */
export interface FrameFindings {
  /** Tracked-object bboxes + labels (ResNet/Florence + SAM tracking). */
  tracks: { trackId: string; label?: string; bbox: number[] }[];
  /** Open-set detections (label + confidence). */
  objects: { label: string; confidence?: number; bbox: number[] }[];
  /** OCR text (scoreboard / jersey / caption readings). */
  ocr: string[];
}
/** A candidate event observed inside the window (plan §A: candidate event
 * types + reaction signals are cached as findings). */
export interface WindowCandidate {
  timestamp: number;
  eventType: string;
  reaction?: ReactionEvidence;
}

function nearestFrameImage(
  window: ReadonlyMap<number, { timestamp: number; imageB64: string }>,
  ts: number
): string | undefined {
  let best: string | undefined;
  let bestDiff = Infinity;
  for (const v of window.values()) {
    const d = Math.abs(v.timestamp - ts);
    if (d < bestDiff) {
      bestDiff = d;
      best = v.imageB64;
    }
  }
  return best;
}

/**
 * Shared state for one run, used by BOTH legs that feed the same perceive
 * session (INC-2 / ADAAAA-4325 slice 4):
 *   - the video /analyze leg (inside analyzeJob), and
 *   - the Stage-A audio tap leg (POSTing chunks to /audio) — live and, since
 *     ADAAAA-4954, the detail-first VOD pass too.
 *
 * The audio gate fires on its own ~10 Hz cadence, decoupled from the 1 fps
 * video rail, so when an audio CandidateEvent lands the server must anchor it
 * to the video frame nearest the audio onset and hand that image + the current
 * video evidence to the Gemma decide runner. The two legs share this object so
 * decide sees the actual moment, not a bare scalar candidate.
 *
 * A VOD pass supplies one via `analyzeJob`'s `shared_` slot (exactly like the
 * live path) so its audio leg reuses the same anchor window. The decide window
 * length defaults to the legacy DECIDE_FRAME_WINDOW (16) — the live baseline —
 * and is raised by the detail-first `decideWindowN` knob (ADAAAA-4954).
 */
export class LiveRunShared {
  readonly evidence = new EvidenceTracker();
  readonly highlights: HighlightRecord[] = [];
  /** Stage-A audio-gate FP-rate + latency metric (INC-2 / ADAAAA-4325 slice 5).
   * Every audio gate outcome records here; the job runner snapshots it onto the
   * job at completion. */
  readonly stageA = new StageAMetrics();
  /** Stage-1 vs Stage-2 confirmation-pass metric (ADAAAA-6797). Every confirm
   * dive attempted records its outcome here; runVodJob snapshots it onto the
   * job at completion as `confirmMetrics` (disagreement rate = disagreed /
   * totalRuns). */
  readonly confirmMetrics = { totalRuns: 0, disagreed: 0 };
  /** Rolling window of cached frames + their already-computed findings (plan
   * §A). Time-bounded to DECIDE_WINDOW_SECONDS and hard-capped at
   * CACHE_MAX_FRAMES, so it never grows on long streams. Findings are REUSED
   * by window-facts assembly — never re-analyzed. */
  private frames = new Map<number, { timestamp: number; imageB64: string; findings?: FrameFindings }>();
  /** Candidate events observed inside the current window (bounded, folded into
   * the assembled window facts). */
  private candidates: WindowCandidate[] = [];
  /** Detail-first decide window length (frames kept for the temporal SEQUENCE).
   * Defaults to the live baseline (DECIDE_FRAME_WINDOW); the VOD knob
   * `decideWindowN` raises it (ADAAAA-4954). */
  private readonly windowN: number;
  /** GOAL burst-suppression window (seconds, ADAAAA-6610). Default 30. */
  private readonly goalBurstWindowS: number;
  /** Raw mono 16 kHz int16 PCM taps (base64 per ~100 ms chunk) + end timestamp,
   * kept as a short rolling clip so the surrounding audio can be handed to
   * decide() (ADAAAA-4954 detail-first). */
  private audio: { ts: number; samples: string }[] = [];
  /** Timestamp of the last ACCEPTED GOAL highlight in this run (ADAAAA-6610
   * burst suppression). Used to drop a GOAL accepted within `goalBurstWindowS`
   * of a prior one. */
  private lastGoalHighlightTs: number | null = null;

  constructor(opts: { decideWindowN?: number; goalBurstWindowS?: number } = {}) {
    this.windowN = opts.decideWindowN ?? DECIDE_FRAME_WINDOW;
    this.goalBurstWindowS = opts.goalBurstWindowS ?? DEFAULT_GOAL_BURST_SUPPRESS_S;
  }

  /** Record a sampled frame into the rolling window. The window is
   * time-bounded (DECIDE_WINDOW_SECONDS) and hard-capped (CACHE_MAX_FRAMES),
   * so it never grows on long streams. Frame findings arrive later (after the
   * /analyze round-trip) via setFindings(). */
  addFrame(seq: number, timestamp: number, imageB64: string): void {
    this.frames.set(seq, { timestamp, imageB64 });
    this.evictOldest(timestamp);
  }
  /** Attach the already-computed perception findings to an in-window frame
   * (A1). The findings are produced by the `/analyze` call the server already
   * paid for and are cached for reuse — never re-analyzed, no extra GPU. */
  setFindings(
    seq: number,
    obs: {
      tracks: TrackObservation[];
      objects?: { label: string; confidence?: number; bbox: number[] }[];
      ocr?: string[];
    }
  ): void {
    const findings: FrameFindings = {
      tracks: obs.tracks.map((t) => ({ trackId: t.trackId, label: t.label, bbox: t.bbox as number[] })),
      objects: (obs.objects ?? []).map((o) => ({ label: o.label, confidence: o.confidence, bbox: o.bbox as number[] })),
      ocr: obs.ocr ?? [],
    };
    const existing = this.frames.get(seq);
    if (existing) existing.findings = findings;
    else this.frames.set(seq, { timestamp: seq, imageB64: "", findings });
  }
  /** OCR string count for the cached frame nearest ``ts`` (from already-computed
   * findings — never re-analyzed). Used to populate decide ``ocrHits`` evidence
   * (I3 / ADAAAA-6360); 0 when no OCR findings are cached for the moment. */
  ocrHitsAt(ts: number): number {
    let best: FrameFindings | undefined;
    let bestDiff = Infinity;
    for (const v of this.frames.values()) {
      if (!v.findings) continue;
      const d = Math.abs(v.timestamp - ts);
      if (d < bestDiff) {
        bestDiff = d;
        best = v.findings;
      }
    }
    return best?.ocr?.length ?? 0;
  }
  /** Cache a candidate event (type + timestamp + reaction signal) into the
   * window context, bounded so it never grows on long streams. */
  addCandidate(c: WindowCandidate): void {
    this.candidates.push(c);
    if (this.candidates.length > CACHE_MAX_FRAMES) this.candidates.shift();
  }
  /**
   * ADAAAA-6610 temporal burst suppression: at most ONE GOAL highlight is
   * accepted per `goalBurstWindowS` (default 30 s). The observed false-positive
   * run accepted 26 GOAL highlights, all templated, all within the first ~30 s
   * of a VOD (start-of-clip burst). Call ONLY for an already model-accepted
   * highlight (after `decision.isHighlight`): returns true when this GOAL is a
   * burst duplicate within the window and should be DROPPED (it does NOT
   * advance the last-accepted reference, so a burst cannot extend itself). A
   * non-GOAL event is never suppressed.
   */
  suppressIfGoalBurst(ts: number, eventType?: string): boolean {
    const ev = (eventType || "").toUpperCase().trim();
    if (ev !== "GOAL" && ev !== "GOL") return false;
    if (this.lastGoalHighlightTs != null && ts - this.lastGoalHighlightTs < this.goalBurstWindowS) {
      return true;
    }
    this.lastGoalHighlightTs = ts;
    return false;
  }
  /** Drop frames (and stale candidates) outside the 60 s window and enforce the
   * hard size cap. Oldest entries are removed first. */
  private evictOldest(nowTs: number): void {
    const cutoff = nowTs - DECIDE_WINDOW_SECONDS;
    for (const [k, v] of this.frames) {
      if (v.timestamp < cutoff) this.frames.delete(k);
    }
    this.candidates = this.candidates.filter((c) => c.timestamp >= cutoff);
    while (this.frames.size > CACHE_MAX_FRAMES) {
      const oldest = this.frames.keys().next().value;
      if (oldest === undefined) break;
      this.frames.delete(oldest);
    }
    while (this.candidates.length > CACHE_MAX_FRAMES) this.candidates.shift();
  }
  /** Nearest sampled frame image to ``ts`` (for anchoring a candidate that
   * fired off-cycle, e.g. an audio onset between video samples), or undefined
   * when no frame is in the window yet. */
  anchor(timestamp: number): string | undefined {
    return nearestFrameImage(this.frames, timestamp);
  }
  /** Number of frames currently cached in the 60 s window (memory bound check:
   * never exceeds CACHE_MAX_FRAMES, and old frames fall off the time window). */
  cachedFrameCount(): number {
    return this.frames.size;
  }
  /** Timestamp of the newest cached frame (the representative frame for the
   * out-of-band re-check sampler), or 0 when the window is empty. */
  lastTimestamp(): number {
    let max = 0;
    for (const v of this.frames.values()) if (v.timestamp > max) max = v.timestamp;
    return max;
  }
  /** The rolling frame window as decide() `frames[]` ImageRefs (detail-first:
   * the temporal SEQUENCE Gemma reasons across). Ordered oldest -> newest, and
   * SLICED to the decide window length (legacy DECIDE_FRAME_WINDOW or the
   * detail-first `decideWindowN` knob) so a large 60 s cache never inflates the
   * per-decision vision sequence. */
  framesWindow(): { role: string; base64: string }[] {
    const all = [...this.frames.values()];
    const sliced = all.slice(-this.windowN);
    return sliced.map((f) => ({ role: "full", base64: f.imageB64 }));
  }
  /** Increment F / ADAAAA-6465: assemble the capped frame sequence for one
   * analysis call — sampled at `analysis_fps`, always including the keyframe
   * set (trigger-onset, peak-audio, window-end) and HARD-CAPPED at
   * `maxFramesPerAnalysis`. Frames are the PRIMARY evidence; audio is a cheap,
   * fallible trigger/corroboration. Samples from the already-cached window
   * (no re-extraction — no extra GPU). Empty when nothing is in the window. */
  frameSequenceFor(triggerTs: number, peakAudioTs?: number, opts: { analysisFps?: number; maxFramesPerAnalysis?: number; preWindowS?: number; postWindowS?: number } = {}): { role: string; base64: string }[] {
    const cached = [...this.frames.values()]
      .filter((f) => f.imageB64)
      .map((f) => ({ timestamp: f.timestamp, imageB64: f.imageB64 }));
    return assembleFrameSequence(cached, { triggerTs, peakAudioTs, ...opts });
  }
  /**
   * Assemble the current 60 s window's factual content as compact text (A2) —
   * the "current-context buffer" every decide() call for an in-window candidate
   * is augmented with. Pure server assembly from cached findings (tracks /
   * objects / OCR / candidates / confirmed highlights): no GPU inference, no
   * re-analysis. Returns "" when the window has nothing to add (behavior
   * identical to the pre-window baseline). Bounded by `maxChars`
   * (default WINDOW_FACTS_MAX_CHARS) — content is truncated oldest-first so
   * token growth is hard-capped.
   */
  windowFactsText(opts: { maxChars?: number; maxPerFrame?: number } = {}): string {
    const maxChars = opts.maxChars ?? WINDOW_FACTS_MAX_CHARS;
    const maxPerFrame = opts.maxPerFrame ?? 3;
    const frames = [...this.frames.values()].sort((a, b) => a.timestamp - b.timestamp);
    const lines: string[] = [];
    for (const f of frames) {
      if (!f.findings) continue; // frame with no cached findings contributes nothing
      const parts: string[] = [];
      const tracks = f.findings.tracks.slice(0, maxPerFrame);
      if (tracks.length) {
        parts.push(
          "tracks:" +
            tracks.map((t) => `${t.label || t.trackId}@${(t.bbox as number[]).map((b) => b.toFixed(2)).join(",")}`).join(";")
        );
      }
      const objs = f.findings.objects.slice(0, maxPerFrame);
      if (objs.length) parts.push("objs:" + objs.map((o) => o.label).join(";"));
      if (f.findings.ocr.length) parts.push("ocr:" + f.findings.ocr.slice(0, 3).join(" | "));
      if (parts.length) lines.push(`[t=${f.timestamp.toFixed(1)}s] ${parts.join(" ")}`);
    }
    const cands = [...this.candidates].sort((a, b) => a.timestamp - b.timestamp).slice(-maxPerFrame);
    for (const c of cands) {
      const sig = c.reaction && c.reaction.crowdEnergy > 0 ? ` (rxn:e=${c.reaction.crowdEnergy.toFixed(2)})` : "";
      lines.push(`[t=${c.timestamp.toFixed(1)}s] candidate:${c.eventType}${sig}`);
    }
    // Confirmed highlights that fall inside the current window.
    if (this.highlights.length) {
      const newestTs = frames.length ? frames[frames.length - 1].timestamp : NaN;
      const lo = newestTs - DECIDE_WINDOW_SECONDS;
      for (const h of this.highlights) {
        if (h.start >= lo || (Number.isNaN(lo) && h.start >= 0)) {
          lines.push(`[t=${h.start.toFixed(1)}s] highlight:${h.eventType}`);
        }
      }
    }
    let text = lines.join("\n");
    if (text.length > maxChars) text = text.slice(0, maxChars) + "…";
    return text;
  }
  /** Buffer one audio tap chunk (base64 mono 16 kHz int16 PCM, ~100 ms) into
   * the rolling clip, kept ~AUDIO_CLIP_KEEP_S seconds behind `ts`. */
  addAudioChunk(ts: number, samples: string): void {
    this.audio.push({ ts, samples });
    const cutoff = ts - AUDIO_CLIP_KEEP_S;
    while (this.audio.length > 1 && this.audio[0].ts < cutoff) this.audio.shift();
  }
  /** The buffered audio as a mono 16 kHz 16-bit PCM WAV (base64), covering the
   * last `AUDIO_CLIP_KEEP_S` seconds — the surrounding audio clip for decide().
   * "" when the tap has buffered nothing yet. */
  audioClipB64(): string {
    if (!this.audio.length) return "";
    return pcmInt16ToWavB64(this.audio.map((a) => a.samples).join(""));
  }
  /**
   * I4 / ADAAAA-6361: the audio-energy level CURVE (not just one scalar peak).
   * Computes a normalized RMS energy per buffered tap (~100 ms), newest-first
   * trimmed to `maxPoints`, so the decide prompt can cite the shape of the
   * crowd/commentary energy around the trigger. [] when nothing buffered yet.
   */
  audioLevelSeries(maxPoints = 48): number[] {
    const out = this.audio.map((a) => rmsNormalized(Buffer.from(a.samples, "base64")));
    return out.slice(-Math.max(1, maxPoints));
  }
  /** I4 / ADAAAA-6361: per-detection boxes (tracks + open-set objects) for the
   * frame FINDINGS nearest `timestamp`, so the decide prompt gets real geometry
   * (bboxes) instead of asking Gemma to guess positions from vision alone. []
   * when no in-window frame has cached findings yet. */
  richDetections(timestamp: number): DetectionEvidence[] {
    let best: FrameFindings | undefined;
    let bestDiff = Infinity;
    for (const v of this.frames.values()) {
      if (!v.findings) continue;
      const d = Math.abs(v.timestamp - timestamp);
      if (d < bestDiff) {
        bestDiff = d;
        best = v.findings;
      }
    }
    if (!best) return [];
    const out: DetectionEvidence[] = [];
    for (const t of best.tracks) {
      out.push({ label: t.label || "player", bbox: t.bbox as number[], confidence: 0, trackId: t.trackId });
    }
    for (const o of best.objects) {
      out.push({ label: o.label, bbox: o.bbox as number[], confidence: o.confidence ?? 0, trackId: "" });
    }
    return out.slice(0, 16);
  }
  /** I4 / ADAAAA-6361: normalized [x, y] center of the soccer ball detection in
   * the findings nearest `timestamp`, or undefined when no ball is tracked yet.
   * Uses the label shallow-match used elsewhere in the soccer closed roster. */
  ballPosition(timestamp: number): [number, number] | undefined {
    const dets = this.richDetections(timestamp);
    const ball = dets.find((d) => /ball/i.test(d.label));
    if (!ball || ball.bbox.length < 4) return undefined;
    const [x1, y1, x2, y2] = ball.bbox;
    return [(x1 + x2) / 2, (y1 + y2) / 2];
  }
  /** Record one confirmation-pass dive into the Stage-1 vs Stage-2 metric
   * (ADAAAA-6797). `stage1Disagreed` is only counted when a real reconciled
   * verdict came back (a transport failure / passthrough records a run with no
   * disagreement). */
  recordConfirm(result: { stage1Disagreed?: boolean }): void {
    this.confirmMetrics.totalRuns++;
    if (result.stage1Disagreed === true) this.confirmMetrics.disagreed++;
  }
  /** Sampled frames inside [ts-windowS, ts+windowS] as raw {timestamp, imageB64}
   * pairs (oldest -> newest), for the Stage-2 denser window / keyframes. Uses
   * the already-cached frame window — no new GPU. [] when nothing cached. */
  framesNear(timestamp: number, windowS: number): { timestamp: number; imageB64: string }[] {
    return [...this.frames.values()]
      .filter((f) => f.imageB64 && f.timestamp >= timestamp - windowS && f.timestamp <= timestamp + windowS)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((f) => ({ timestamp: f.timestamp, imageB64: f.imageB64 }));
  }
  /** Build the Stage-2 object/ball trajectory tracks + motion/optical-flow
   * magnitude (ADAAAA-6797) from the ALREADY-COMPUTED cached findings — no new
   * GPU inference. For each tracked object it assembles a per-timestep
   * [t, cx, cy] center path across the in-window frames; `opticalFlowMagnitude`
   * is the max single-step center displacement (a motion proxy) and
   * `flowMagnitudes` is the per-frame max displacement series. Empty / 0 when
   * no track findings are cached in the window. */
  motionContext(timestamp: number): {
    trajectories: { label: string; trackId: string; path: number[][] }[];
    opticalFlowMagnitude: number;
    flowMagnitudes: number[];
  } {
    const frames = [...this.frames.values()]
      .filter((f) => f.findings && f.timestamp >= timestamp - CONFIRM_MOTION_WINDOW_S && f.timestamp <= timestamp + CONFIRM_MOTION_WINDOW_S)
      .sort((a, b) => a.timestamp - b.timestamp);
    const byTrack = new Map<string, { label: string; path: number[][] }>();
    const prevPos = new Map<string, [number, number]>();
    let opticalFlowMagnitude = 0;
    const flowMagnitudes: number[] = [];
    for (const f of frames) {
      let frameMax = 0;
      for (const t of f.findings!.tracks) {
        const bbox = t.bbox as number[];
        if (!bbox || bbox.length < 4) continue;
        const cx = (bbox[0] + bbox[2]) / 2;
        const cy = (bbox[1] + bbox[3]) / 2;
        const key = t.trackId || t.label || "obj";
        const entry = byTrack.get(key) ?? { label: t.label || "object", path: [] };
        entry.path.push([f.timestamp, cx, cy]);
        byTrack.set(key, entry);
        const prev = prevPos.get(key);
        if (prev) {
          const d = Math.hypot(cx - prev[0], cy - prev[1]);
          if (d > frameMax) frameMax = d;
          if (d > opticalFlowMagnitude) opticalFlowMagnitude = d;
        }
        prevPos.set(key, [cx, cy]);
      }
      flowMagnitudes.push(frameMax);
    }
    const trajectories = [...byTrack.values()]
      .map((e) => ({ label: e.label, trackId: e.label, path: e.path }))
      .slice(0, 8);
    return { trajectories, opticalFlowMagnitude, flowMagnitudes };
  }
}

/** Seconds of audio tap kept for the decide() surrounding-audio clip
 * (ADAAAA-4954 detail-first; bounded so a long VOD pass doesn't grow unbounded).
 * Roughly the clip-relevant window around a trigger. */
export const AUDIO_CLIP_KEEP_S = 10;
/** Stage-2 confirmation-pass motion-context window (s on each side of the
 * event instant) the server samples cached track findings from (ADAAAA-6797).
 * Roughly the dense-dive window; no new GPU (reuses cached findings). */
export const CONFIRM_MOTION_WINDOW_S = 5;
/** ADAAAA-7162: extra seconds (each side) the Stage-2 confirmation frame window
 * is expanded beyond the Stage-1 pre/post window, so the confirm pass sees the
 * ball actually cross the line / enter the net. 4 s is within the required
 * 3-5 s window. Tune via `DECIDE_CONFIRM_EXTRA_WINDOW_S`. */
export const DEFAULT_CONFIRM_WINDOW_EXTRA_S = 4;

/** Wrap a run of base64 mono 16 kHz int16 PCM samples into a RIFF/WAVE file and
 * return it as base64. Pure + deterministic so it is unit-testable. The decide
 * runner accepts a mono WAV at any of the common PCM bit depths; 16-bit is the
 * natural format our ffmpeg tap already emits (pcm_s16le). */
export function pcmInt16ToWavB64(samplesB64: string, sampleRate = 16_000): string {
  const pcm = Buffer.from(samplesB64, "base64");
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]).toString("base64");
}


/**
 * Increment D (ADAAAA-6467): the what-to-track plan orchestrator on the
 * worker. Owns the SINGLE stream-start warm-up plan call and the out-of-band
 * re-check cadence, and holds the active TrackingPlan that the per-frame
 * /analyze path delivers to perceive (so detect/seeding stays scoped to the
 * plan's roster). CRITICAL INVARIANT: it NEVER calls the planner from the
 * per-frame loop — planner calls happen exactly at warm-up and on the
 * re-check cadence, so per-frame planner/discovery invocations = 0 and the
 * 1-5 s live detection budget is preserved.
 *
 * Guardrails (applied here + by perceive's TrackingPlan contract):
 *  - maxTracks is clamped to the mode cap (3 live / 8 VOD) — both the decide
 *    runner and here; a plan can never exceed the company cap.
 *  - Narrow-only: a plan can only narrow the roster to what is detectable; it
 *    may not widen past the closed-vocab gate. perceive already degrades any
 *    untrackable/off-plan target, so a bad plan yields an empty roster ->
 *    canned/safe-default. The controller additionally drops a plan whose
 *    maxTracks exceeds the cap or whose targets are empty/untrackable.
 *  - Degrade-to-canned/safe-default: on an absent/invalid planner reply the
 *    controller keeps the previous plan (or no plan) and lets perceive run the
 *    canned gameHint roster — never a dead stream, never a per-frame planner
 *    retry.
 */
export class TrackingPlanController {
  private activePlan: TrackingPlanResult | null = null;
  private plannedAt = 0;
  private warmup = false;
  private recheckTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly warmupSeconds: number;
  private readonly recheckIntervalSeconds: number;
  private readonly planMode: "live" | "vod";
  /** Sequential re-check marker so overlapping re-plan calls cannot race. */
  private replanning = false;
  onPlan?: (plan: TrackingPlanResult | null, source: "warmup" | "recheck" | "candidate") => void;

  constructor(cfg: { warmupSeconds?: number; recheckIntervalSeconds?: number; planMode?: "live" | "vod" }) {
    this.warmupSeconds = cfg.warmupSeconds ?? 3;
    this.recheckIntervalSeconds = cfg.recheckIntervalSeconds ?? 10;
    this.planMode = cfg.planMode ?? "live";
  }

  get active(): TrackingPlanResult | null {
    return this.activePlan;
  }
  get lastPlanAt(): number {
    return this.plannedAt;
  }
  /** The plan dict to deliver on the next /analyze (or null for the canned
   * /safe-default interim). `maxTracks` is already clamped. */
  delivery(): Record<string, unknown> | null {
    return this.activePlan ? { ...this.activePlan } : null;
  }

  private buildRequest(imageB64: string | undefined): PlanRequest {
    return {
      intent: "",
      category: (this.activePlan?.category as string) || "",
      gameHint: undefined,
      mode: this.planMode,
      imageB64,
      context: this.activePlan ? { previousPlan: this.activePlan } : undefined,
    };
  }

  private apply(plan: TrackingPlanResult | null): void {
    if (plan && plan.maxTracks > (this.planMode === "vod" ? 8 : 3)) {
      // Hard clamp — a plan can NEVER exceed the mode cap (company invariant).
      plan = { ...plan, maxTracks: this.planMode === "vod" ? 8 : 3 };
    }
    this.activePlan = plan;
    this.plannedAt = plan?.plannedAt ?? Date.now() / 1000;
  }

  /** Fire exactly ONE warm-up plan call (blocking the first frame's plan
   * delivery, NOT the per-frame loop). Returns the plan or null. */
  async warmUp(client: PipelineClient, imageB64?: string): Promise<TrackingPlanResult | null> {
    if (this.warmup) return this.activePlan;
    this.warmup = true;
    const plan = await this.replan(client, imageB64, "warmup");
    this.onPlan?.(plan, "warmup");
    return plan;
  }

  /** Start the out-of-band re-check cadence. `sample` returns a representative
   * in-window frame (imageB64) for the planner, or undefined when the window
   * has none yet. Runs OFF the per-frame path; the timer never blocks a frame. */
  startRecheck(client: PipelineClient, sample: () => string | undefined): void {
    if (this.recheckTimer || this.stopped) return;
    this.recheckTimer = setInterval(async () => {
      if (this.stopped || this.replanning) return;
      try {
        const plan = await this.replan(client, sample(), "recheck");
        if (plan) this.onPlan?.(plan, "recheck");
      } catch {
        /* re-check is best-effort — the last good plan stays active */
      }
    }, Math.max(1, this.recheckIntervalSeconds) * 1000);
    // Let the timer not keep the process alive after the job ends.
    if (typeof this.recheckTimer.unref === "function") this.recheckTimer.unref();
  }

  /** Immediate re-plan on a candidate event (out of band from the per-frame
   * detection; invoked by the worker's candidate handler). */
  async onCandidate(client: PipelineClient, imageB64?: string): Promise<void> {
    if (this.stopped || this.replanning) return;
    const plan = await this.replan(client, imageB64, "candidate");
    if (plan) this.onPlan?.(plan, "candidate");
  }

  /** One planner call (warm-up / re-check / candidate). Never throws; on any
   * failure keeps the current plan (perceive degrades to canned/safe-default
   * if there is none). Bound so it never becomes a per-frame call. */
  private async replan(
    client: PipelineClient,
    imageB64: string | undefined,
    _why: string
  ): Promise<TrackingPlanResult | null> {
    if (this.replanning) return this.activePlan;
    this.replanning = true;
    try {
      let res: TrackingPlanResult | null = null;
      try {
        res = await client.plan(this.buildRequest(imageB64));
      } catch {
        // planner call failed (unreachable / 4xx): keep the current plan, so
        // perceive degrades to canned/safe-default if there is none. Never an
        // unhandled rejection from the warm-up / re-check paths.
        return this.activePlan;
      }
      if (!res || typeof res !== "object") return this.activePlan;
      // Narrow-only guard: a plan with no trackable targets or an empty roster
      // is dropped (perceive will run the canned/safe-default roster), unless
      // it is an explicit safe-default fallback (source planner-fallback with
      // empty targets is still valid — it means "degrade to canned").
      const targets = Array.isArray(res.targets) ? res.targets : [];
      const trackable = targets.some((t) => t && typeof t.label === "string" && t.label.trim() !== "");
      if (!trackable && !targets.length) {
        // empty roster — valid only as an explicit degrade signal; keep active
        // plan unchanged so prior scoping is preserved, else hand the fallback.
        if (res.source === "planner-fallback" && !this.activePlan && targets.length === 0) {
          this.apply(res);
          return this.activePlan;
        }
        return this.activePlan;
      }
      this.apply(res);
      return this.activePlan;
    } finally {
      this.replanning = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.recheckTimer) {
      clearInterval(this.recheckTimer);
      this.recheckTimer = null;
    }
  }
}

/** Build + emit a persisted decide note for one evaluation (ADAAAA-6851 Inc 2).
 * `status` captures why the trigger did/didn't become a highlight record
 * (accepted / suppressed / rejected). Called at the SAME decision point that
 * builds the HighlightRecord, so every decide() result is recorded, not just
 * accepted ones. Best-effort: a throwing onDecision is caught + logged and
 * never fails the frame loop. */
function buildCandidateNote(
  cfg: AnalyzerConfig,
  candidate: CandidateSignal,
  decision: DecisionResult,
  status: "accepted" | "suppressed" | "rejected",
  candidateId: string,
  trigger: HighlightTrigger
): void {
  if (!cfg.onDecision) return;
  try {
    cfg.onDecision({
      id: candidateId,
      jobId: cfg.jobId,
      seq: candidate.seq ?? 0,
      timestamp: candidate.timestamp,
      eventType: highlightEventType(decision, candidate.eventType),
      score: decision.score,
      isHighlight: decision.isHighlight,
      outcome: decision.outcome,
      nearMiss: decision.nearMiss,
      reason: decision.reason,
      status,
      trigger,
      createdAt: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error(`[decide-note:${cfg.jobId}] persist failed:`, String(e?.message || e));
  }
}
/** Accept (or suppress) a decided candidate with exactly the serial semantics:
 * goal-burst suppression applied in timestamp order, then cut + record + SSE
 * `highlight` event (which drives decision-time persist/bill/quota exactly
 * once). Shared by the serial (live / w=1) inline path and the ordered VOD
 * pipeline so both are byte-for-byte identical. */
/** ADAAAA-6874 (Phase 2): deterministic per-highlight idempotency key anchored
 * on the job + candidate frame seq + event type. A re-claimed/resumed job that
 * re-decides the same candidate produces the SAME key, so the server's
 * addHighlight dedup prevents double-persist and double-billing. */
export function highlightIdempotencyKey(jobId: string, seq: number, eventType?: string): string {
  return `hl:${jobId}:${seq}:${eventType ?? "highlight"}`;
}

/** ADAAAA-7118: the dedup key the VOD onEvent guard (and any caller mirroring
 * store.addHighlight) must use. It is the SAME key store.addHighlight dedups on
 * (a persisted record's `idempotencyKey`), so a candidate that emits two
 * `highlight` events with an identical key (e.g. the GOAL anchor at the same seq)
 * increments `highlightsFound` exactly once and the live counter matches the
 * persisted count during processing. Legacy persisted rows without an
 * idempotencyKey fall back to the legacy `start|eventType` form so resume
 * protection still holds for them. */
export function highlightDedupKey(h: { idempotencyKey?: string; start: number; eventType?: string }): string {
  return h.idempotencyKey ?? `${Math.round(h.start)}|${h.eventType ?? "highlight"}`;
}

async function acceptVideoDecision(
  client: PipelineClient,
  run: LiveRunShared,
  cut: (ts: number) => Promise<{ clipId: string; clipUri: string }>,
  cfg: AnalyzerConfig,
  onEvent: ((ev: AnalyzeEvent) => void) | undefined,
  emit: { seq: number; timestamp: number },
  candidate: CandidateSignal,
  stage1: DecisionResult
): Promise<void> {
  // ADAAAA-6797: Stage-2 confirmation dive — for an un-attested goal-type
  // candidate whose Stage-1 read is a scoring_play accept, run the decide
  // /confirm deep frame dive and adopt the reconciled verdict in its place.
  // Strict no-op when the trigger doesn't fire or the flag (confirmEnabled) is
  // off; the Stage-1 verdict is kept on passthrough / transport failure.
  const { decision, confirm } = await confirmReconcile(client, run, cfg, stage1, candidate);
  // ADAAAA-6798 Inc 2: derive the trigger provenance ONCE from the candidate
  // (pure function, no inference) and share one candidateId across the
  // persisted JobCandidate and the HighlightRecord so the trigger kind +
  // timestamp match the candidate with zero drift.
  const trigger = deriveHighlightTrigger(candidate);
  const candidateId = randomUUID();
  // ADAAAA-6851 Inc 2: persist EVERY decide evaluation — accepted highlight,
  // burst-suppressed, near-miss, not-highlight. This runs on both the serial
  // (live / w=1) path and the ordered pipeline accept path (ADAAAA-6854), so
  // the decision-time note trail stays identical either way.
  if (!isAcceptedHighlight(decision, cfg.preferLabels)) {
    buildCandidateNote(cfg, candidate, decision, "rejected", candidateId, trigger);
    return;
  }
  // ADAAAA-6610 temporal burst suppression: a GOAL
  // accepted within `goalBurstWindowS` of a previous one is a start-of-clip
  // burst duplicate and is dropped, not recorded.
  if (run.suppressIfGoalBurst(candidate.timestamp, decision.eventType ?? candidate.eventType)) {
    buildCandidateNote(cfg, candidate, decision, "suppressed", candidateId, trigger);
    onEvent?.({
      seq: emit.seq,
      timestamp: emit.timestamp,
      type: "candidateBlocked",
      candidate: { eventType: highlightEventType(decision, candidate.eventType), timestamp: candidate.timestamp },
      reason: "goal highlight suppressed (burst: within goal burst window of an accepted goal)",
    });
    return;
  }
  buildCandidateNote(cfg, candidate, decision, "accepted", candidateId, trigger);
  const { clipId, clipUri } = await cut(candidate.timestamp);
  const rec: HighlightRecord = {
    id: randomUUID(),
    jobId: cfg.jobId,
    // ADAAAA-6874 (Phase 2): deterministic idempotency key so a resumed job that
    // re-decides the same candidate cannot double-persist/double-bill.
    idempotencyKey: highlightIdempotencyKey(cfg.jobId, emit.seq, decision.eventType ?? candidate.eventType),
    clipUri,
    start: Math.max(0, candidate.timestamp - cfg.clipBeforeS),
    end: candidate.timestamp + cfg.clipAfterS,
    eventType: highlightEventType(decision),
    score: decision.score,
    reason: decision.reason,
    // Increment F / ADAAAA-6465: near-miss surface at a lower score, labeled
    // distinctly via the outcome/nearMiss flag.
    outcome: decision.outcome,
    nearMiss: decision.nearMiss,
    // Stage-2 confirmation verdict (ADAAAA-6797), set when the trigger fired.
    goalConfirmed: confirm?.goalConfirmed ?? undefined,
    stage1Disagreed: confirm?.stage1Disagreed ?? undefined,
    status: "pending",
    // ADAAAA-6798 Inc 2: link the highlight to the candidate that started it
    // and carry that candidate's trigger provenance (no read-time join).
    candidateId,
    trigger,
    createdAt: new Date().toISOString(),
  };
  run.highlights.push(rec);
  onEvent?.({ seq: emit.seq, timestamp: emit.timestamp, type: "highlight", highlight: rec });
}

// ---------------------------------------------------------------------------
// ADAAAA-7007: decide-observer request builders + helpers. The vision LLM is
// the primary observer; perceive-derived per-frame context (seeds) + per-window
// bias hints (provenance) ride the payload, and candidate triggers never gate.
// ---------------------------------------------------------------------------

/** A generic observe-window event label used when the window carries no bias
 * hint (a moment with no perceived trigger). The outcome enum still governs
 * whether it can be a GOAL — never published as GOAL unless scoring_play. */
export function observeDefaultEventType(_payload: ObserveDecidePayload): string {
  return "SPORTING_EVENT";
}

/** Derive a monotonic, schema-valid frame sequence for an observe-window decide
 * emit (ADAAAA-7007). The observe payload frames carry only `ts`/`imageB64`
 * (no per-frame seq), so we derive the anchor's frame index from `centerTs` at
 * the content fps used to assemble the window. Clamped to 0 so a zero-anchored
 * timeline never yields a negative seq — the candidate / JobDecision trail
 * schema requires `seq >= 0` (packages/events). Replaces the previous hardcoded
 * `seq: -1`, which made every observe-loop highlight hit a ZodError
 * (`candidates[N].seq` must be >= 0) and fail the VOD job before it completed. */
export function observeEmitSeq(centerTs: number, fps: number): number {
  const f = Number.isFinite(fps) && fps > 0 ? fps : OBSERVE_CONTENT_FPS;
  return Math.max(0, Math.round(centerTs * f));
}

/** True when an unknown error is the recoverable-but-unpayable TicketParams
 * expiry (ADAAAA-7003). Mirrors the OrderedDecidePipeline guard. */
export function isTicketParamsExpired(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { ticketParamsExpired?: boolean }).ticketParamsExpired === true;
}

// ADAAAA-7022: clamp observer-built evidence to the decide service's schema
// caps before sending. A real multi-object broadcast window exceeds both
// bounds, and because decide is now the SOLE driver of the live loop a 422
// aborts the whole live job (`decide failed: HTTP 422`). These mirror the
// decide contract (services/decide/app/__init__.py: Evidence.trackCount le=8,
// Evidence.detections max_length=16, Detection.bbox max_length=4,
// Detection.confidence ge=0 le=1) so the observer never produces a payload the
// decide schema rejects.
export const DECIDE_MAX_TRACK_COUNT = 8;
export const DECIDE_MAX_DETECTIONS = 16;
export const DECIDE_MAX_DETECTION_BBOX = 4;

/** Fold the goal-attestation signals (goalCrossed / ballOutcome /
 * scoreBoardChanged) carried by a set of in-window bias hints into a single
 * window-level attestation. Any hint carrying a true attestation attests the
 * window; the strongest signal wins (a goal attestation stands over a
 * near-miss / absent). Returns `{}` when nothing attests — the correct
 * "no attestation, provenance-only" case. Pure + deterministic (ADAAAA-7021). */
export function foldWindowAttestation(
  hints: { goalCrossed?: boolean; ballOutcome?: string; scoreBoardChanged?: boolean }[] | ReadonlyArray<ObserveBiasHint>
): { goalCrossed?: boolean; ballOutcome?: string; scoreBoardChanged?: boolean } {
  const out: { goalCrossed?: boolean; ballOutcome?: string; scoreBoardChanged?: boolean } = {};
  for (const h of hints) {
    if (h.goalCrossed === true) out.goalCrossed = true;
    if (typeof h.ballOutcome === "string" && /^goal$/i.test(h.ballOutcome.trim())) out.ballOutcome = h.ballOutcome;
    if (h.scoreBoardChanged === true) out.scoreBoardChanged = true;
  }
  return out;
}

/** Build the decide() evidence + opts for an observe window. The temporal
 * window frames + the perceive-seeded per-frame context are the primary
 * evidence; candidate triggers inside the window are folded as bias hints
 * (provenance), and the frozen candidate/event vocabulary is preserved.
 * Deterministic per payload so the decision is reproducible. */
export function buildObserveDecideRequest(
  cfg: AnalyzerConfig,
  run: LiveRunShared,
  payload: ObserveDecidePayload
): { evidence: Parameters<PipelineClient["decide"]>[0]; opts: Parameters<PipelineClient["decide"]>[1] } {
  const bias = payload.biasHints[0] as ObserveBiasHint | undefined;
  const eventType = bias?.eventType ?? observeDefaultEventType(payload);
  const center = payload.centerTs;
  // Fold the window's perceive-derived context into the scalar evidence the
  // decide contract expects (track count / OCR / reaction) from the seeds.
  const seeds = payload.seeds;
  let maxTrackCount = 0;
  let ocrHits = 0;
  for (const s of seeds) {
    maxTrackCount = Math.max(maxTrackCount, s.tracks?.length ?? 0);
    ocrHits += s.ocr?.length ?? 0;
  }
  // ADAAAA-7022: clamp to the decide Evidence schema caps so a multi-object
  // window never builds a payload decide rejects (trackCount le=8).
  const trackCount = Math.min(maxTrackCount, DECIDE_MAX_TRACK_COUNT);
  const detections: DetectionEvidence[] = [];
  for (const s of seeds) {
    for (const o of s.objects ?? []) {
      detections.push({
        label: o.label,
        confidence: o.confidence ?? 0,
        // ADAAAA-7022: Detection.bbox is max_length=4 and confidence ge=0 le=1.
        bbox: (o.bbox ?? []).slice(0, DECIDE_MAX_DETECTION_BBOX),
        trackId: "",
      });
    }
  }
  // ADAAAA-7021 fix: fold the perceive candidate's goal-attestation signals that
  // rode the in-window bias hints (goalCrossed / ballOutcome / scoreBoardChanged).
  // Any hint in the window carrying a true attestation attests the whole window;
  // the strongest signal (goal attests over near-miss) wins. Absent everywhere =
  // no attestation (provenance only). This keeps the goal-attestation gate able
  // to independently confirm a scoring_play instead of rejecting every goal.
  const windowAttestation = foldWindowAttestation(payload.biasHints);
  const evidence: Parameters<PipelineClient["decide"]>[0] = {
    eventType,
    trackCount,
    maxVelocity: run.evidence.maxVelocity,
    ocrHits,
    reaction: buildReactionEvidence({}, trackCount),
    // Perceive-derived per-detection geometry + audio level curve (I4).
    // ADAAAA-7022: keep the FIRST DECIDE_MAX_DETECTIONS (oldest frames) so the
    // payload never breaches Evidence.detections max_length=16.
    detections: detections.slice(0, DECIDE_MAX_DETECTIONS),
    // ADAAAA-7021 fix: forward the perceive candidate's goal-attestation signals
    // (folded into the in-window bias hints) FIRST-CLASS so the decide
    // goal-attestation gate can independently attest a `scoring_play`. Previously
    // scoreBoardChanged was hardcoded false and goalCrossed/ballOutcome were never
    // forwarded, so the decide runner rejected every goal ("model reason alone is
    // not sufficient") — collapsing goal recall to 0% (ADAAAA-7021). Absent/undefined
    // = no attestation (provenance only), never a fabricated false attestation.
    goalCrossed: windowAttestation.goalCrossed || undefined,
    ballOutcome: windowAttestation.ballOutcome || undefined,
    scoreBoardChanged: windowAttestation.scoreBoardChanged || undefined,
  };
  const opts: Parameters<PipelineClient["decide"]>[1] = {
    gameHint: cfg.gameHint,
    reasoningEffort: "none",
    frames: payload.frames.map((f) => ({ role: "full", base64: f.imageB64 })),
    // ADAAAA-7028 Inc 2: audit identity — forward the job + frame-group
    // partition key so the decide service's `_audit` descriptor keys the
    // durable decide_audit index by (sessionId, groupKey). One row per frame
    // group regardless of how many decide invocations the group spans.
    jobId: cfg.jobId,
    groupKey: decideGroupKey(center),
    // ADAAAA-7111 (Increment D): carry the job's running video summary
    // (story-so-far) so the decide brain EXTENDS it (monotonic growth).
    storySoFar: cfg.getRunningSummary?.() ?? "",
  };
  return { evidence, opts };
}

/**
 * Run the on-demand perceive recall for an observe payload (ADAAAA-7008 /
 * ADAAAA-7012). When a decide verdict requests more evidence for a moment, the
 * server calls perceive on demand (`recall` callback -> adapter -> perceive
 * `/app/evidence`) and folds the freshly derived per-frame context into the
 * payload via {@link applyOnDemandRecall} BEFORE finalizing.
 *
 * `recall` is the injectable transport (the adapter's `recallPerceive`); it
 * returns the recall's seeds (empty `[]` / undefined on a no-op). A no-op
 * recall returns the SAME payload object unmodified, so a recall can never
 * regress a decision — the caller checks `!== payload` to decide whether to
 * re-decide with the richer payload.
 */
export async function applyObserveRecall(
  payload: ObserveDecidePayload,
  recall: (centerTs: number, windowS?: number) => Promise<{ centerTs?: number; seeds: PerFrameSeed[] } | undefined>
): Promise<ObserveDecidePayload> {
  if (!payload) return payload;
  const result = await recall(payload.centerTs, undefined);
  // A no-op recall (nothing new) returns the SAME payload object, so a recall
  // can never regress a decision.
  if (!result || result.seeds.length === 0) return payload;
  return applyOnDemandRecall(payload, { centerTs: result.centerTs ?? payload.centerTs, seeds: result.seeds });
}

/**
 * ADAAAA-7111 (Increment D): derive the updated running video summary to
 * persist after a cadence decide. Returns the bounded summary string when it
 * actually changed vs the prior one (carried in), else null (no write needed —
 * avoids redundant DB writes on a stable/compact summary). Pure + testable.
 */
export function nextRunningSummary(prior: string | undefined, decision: DecisionResult): string | null {
  const rs = (decision as any).runningSummary;
  if (typeof rs !== "string" || !rs.trim()) return null;
  return rs === (prior ?? "") ? null : rs;
}

/**
 * ADAAAA-7011: shared decide+accept callback for BOTH decide-observer paths
 * (the VOD ObserveDecider and the live LiveObserver). Builds the decide request
 * from an observe window payload, runs the gemma decide (with on-demand
 * perceive recall when the verdict asks for more evidence), then routes the
 * verdict through the same `acceptVideoDecision` path used by the
 * candidate-gated live/VOD paths (clip cut + highlight record + SSE highlight +
 * decision-time billing). Returns whether the moment was accepted (for the
 * observer's cost/accept report). Keeping it identical across both paths means
 * the observer verdict contract never diverges from the candidate-gated one.
 */
export async function observeOnDecide(
  client: PipelineClient,
  run: LiveRunShared,
  cut: (ts: number) => Promise<{ clipId: string; clipUri: string }>,
  cfg: AnalyzerConfig,
  onEvent: ((ev: AnalyzeEvent) => void) | undefined,
  sessionId: string,
  payload: ObserveDecidePayload
): Promise<boolean> {
  let { evidence, opts } = buildObserveDecideRequest(cfg, run, payload);
  let decision: DecisionResult;
  try {
    decision = await client.decide(evidence, opts);
  } catch (e) {
    if (isTicketParamsExpired(e)) {
      console.error(`[observe] decide @${payload.centerTs} skipped (TicketParams expired)`);
      return false;
    }
    throw e;
  }
  // ADAAAA-7008 / ADAAAA-7012: on-demand perceive recall. When the verdict asks
  // for MORE evidence for this moment, call perceive on demand (per-frame
  // derived context already computed — no detector re-run), fold it into the
  // payload via applyOnDemandRecall, and re-decide before finalizing. A no-op
  // recall returns the SAME payload (refreshed === payload), so we keep the
  // original decision — a recall can never regress it.
  if (decision.recall && client.recallPerceive) {
    const refreshed = await applyObserveRecall(payload, (centerTs, windowS) =>
      client.recallPerceive!(sessionId, { centerTs, windowS })
    );
    if (refreshed !== payload) {
      const rebuilt = buildObserveDecideRequest(cfg, run, refreshed);
      evidence = rebuilt.evidence;
      opts = rebuilt.opts;
      decision = await client.decide(evidence, opts);
    }
  }
  // ADAAAA-7028 Inc 2: ingest the decide audit descriptor into the durable
  // decide_audit index (best-effort; never a pipeline failure). Gated by
  // `cfg.onDecideAudit` (wired to recordDecideAudit in the server). Captured
  // ONCE here, after any on-demand recall re-decide settles, using the final
  // `decision` — so exactly one row is persisted per frame group (the
  // (sessionId, groupKey) upsert in recordDecideAudit also makes it idempotent
  // across repeated decide invocations for the same group).
  if (cfg.onDecideAudit) {
    try {
      cfg.onDecideAudit((decision as any).audit);
    } catch (e: any) {
      console.error(`[decide-audit:${cfg.jobId}] onDecideAudit failed:`, String(e?.message || e));
    }
  }
  // ADAAAA-7111 (Increment D): persist the running video summary (story-so-far)
  // the decide brain updated for this window, so the job-detail endpoint + web
  // UI surface it growing across cadence ticks. Only writes when the summary
  // actually changed (avoids redundant DB writes on a stable/compact summary).
  // Best-effort: a throwing callback is caught + logged, never a pipeline failure.
  if (cfg.onRunningSummary) {
    const next = nextRunningSummary(cfg.getRunningSummary?.(), decision);
    if (next !== null) {
      try {
        cfg.onRunningSummary(next);
      } catch (e: any) {
        console.error(`[running-summary:${cfg.jobId}] persist failed:`, String(e?.message || e));
      }
    }
  }
  // ADAAAA-7021 fix: the window's goal-attestation signals (folded from the
  // in-window bias hints) ride the candidate too, so acceptVideoDecision's
  // Stage-2 confirm reconcile + deriveHighlightTrigger see the attestation
  // (hasIndependentAttestation excludes an attested goal from the un-attested
  // confirm dive) rather than treating the goal as un-attested.
  const windowAttestation = { ...foldWindowAttestation(payload.biasHints) };
  const candidate: CandidateSignal = {
    eventType: payload.biasHints[0]?.eventType ?? observeDefaultEventType(payload),
    timestamp: payload.centerTs,
    goalCrossed: windowAttestation.goalCrossed,
    ballOutcome: windowAttestation.ballOutcome,
    scoreBoardChanged: windowAttestation.scoreBoardChanged,
  };
  await acceptVideoDecision(client, run, cut, cfg, onEvent, { seq: observeEmitSeq(payload.centerTs, cfg.sampleFps ?? cfg.analysisFps ?? OBSERVE_CONTENT_FPS), timestamp: payload.centerTs }, candidate, decision);
  return isAcceptedHighlight(decision, cfg.preferLabels);
}

// ---------------------------------------------------------------------------
// Stage-2 confirmation-pass driver (ADAAAA-6797): trigger detection + confirm
// context assembly + reconcile adoption. Pure/helpers are unit-testable.
// ---------------------------------------------------------------------------

/** Goal-type event categories eligible for the confirmation pass. A near-miss
 * as a GOAL is the user-facing false positive the pass guards against. */
const GOAL_TYPE_EVENTS = new Set(["GOAL", "GOL", "TOUCHDOWN", "BASKET", "KILL"]);

/** Is `eventType` a goal-type event (goal / touchdown / basket / kill)? */
export function isGoalTypeEvent(eventType: string | undefined): boolean {
  return GOAL_TYPE_EVENTS.has((eventType || "").toUpperCase().trim());
}

/** Whether a candidate carries INDEPENDENT attestation of the goal: perceive
 * `ballOutcome=goal`, `goalCrossed`, or a scoreboard score change. When any is
 * present the candidate is already independently confirmed and the Stage-2
 * dive is NOT needed — this is exactly the exclusion that keeps the confirm
 * pass scoped to the un-attested population. */
export function hasIndependentAttestation(c: {
  ballOutcome?: string;
  goalCrossed?: boolean;
  scoreBoardChanged?: boolean;
}): boolean {
  if (typeof c.ballOutcome === "string" && /^goal$/i.test(c.ballOutcome.trim())) return true;
  if (c.goalCrossed === true) return true;
  if (c.scoreBoardChanged === true) return true;
  return false;
}

/** The Stage-2 trigger: only an un-attested goal-type candidate whose Stage-1
 * read is a scoring_play accept (goal-shaped) enters the confirmation dive.
 * Everything else (non-goal type, attested, or a Stage-1 non-accept) keeps the
 * existing 1-5 s path unchanged. `cfg.confirmEnabled` is the VOD-first config
 * gate — when off this is a strict no-op. */
export function shouldRunConfirm(
  cfg: AnalyzerConfig,
  candidate: { eventType: string; ballOutcome?: string; goalCrossed?: boolean; scoreBoardChanged?: boolean },
  stage1Decision: DecisionResult
): boolean {
  if (!cfg.confirmEnabled) return false;
  if (!isGoalTypeEvent(candidate.eventType)) return false;
  if (hasIndependentAttestation(candidate)) return false;
  return isAcceptedHighlight(stage1Decision);
}

/** Select the precise pre-event / event-instant / post-event keyframes from a
 * dense frame list (nearest frame to each target timestamp). Returns [] when no
 * frame matches. Deterministic + pure so it is unit-testable. */
export function selectConfirmKeyframes(
  frames: { timestamp: number; imageB64: string }[],
  eventTs: number,
  preS: number,
  postS: number
): { role: string; base64: string }[] {
  const targets = [eventTs - preS, eventTs, eventTs + postS];
  const out: { role: string; base64: string }[] = [];
  for (const t of targets) {
    let best: { timestamp: number; imageB64: string } | undefined;
    let bestDiff = Infinity;
    for (const f of frames) {
      const d = Math.abs(f.timestamp - t);
      if (d < bestDiff) {
        bestDiff = d;
        best = f;
      }
    }
    if (best && best.imageB64) out.push({ role: "full", base64: best.imageB64 });
  }
  return out;
}

/** Assemble the higher-fidelity Stage-2 confirm context (ADAAAA-6797): a denser
 * temporal frame window + precise pre/event/post keyframes + object/ball
 * trajectory tracks + motion/optical-flow magnitude + audio-energy envelope.
 * Wherever a tool is unavailable, send the empty default — the decide /confirm
 * endpoint handles absent context (no crash, no regression). */
export async function buildConfirmContext(
  shared: LiveRunShared,
  cfg: AnalyzerConfig,
  candidate: { timestamp: number },
  stage1: DecisionResult
): Promise<Omit<ConfirmRequest, "eventType" | "timestamp" | "gameHint" | "stage1">> {
  // Denser frame window: prefer the detail-first higher-FPS burst re-sample
  // (I7 / ADAAAA-6361) around the trigger; else the cached window; else [].
  // ADAAAA-7162: expand the confirm window by `confirmWindowExtraS` on each side
  // so the model sees the ball actually cross the line / enter the net, not a
  // single boundary frame.
  const extra = Math.max(0, cfg.confirmWindowExtraS ?? DEFAULT_CONFIRM_WINDOW_EXTRA_S);
  let dense: { timestamp: number; imageB64: string }[] = [];
  if (cfg.resampleFrames) {
    try {
      dense = (await cfg.resampleFrames(candidate.timestamp)) ?? [];
    } catch {
      dense = [];
    }
  }
  if (!dense.length) dense = shared.framesNear(candidate.timestamp, CONFIRM_MOTION_WINDOW_S + extra);
  const frames = dense.map((f) => ({ role: "full", base64: f.imageB64 }));
  const keyframes = selectConfirmKeyframes(
    dense,
    candidate.timestamp,
    (cfg.preWindowS ?? DEFAULT_PRE_WINDOW_S) + extra,
    (cfg.postWindowS ?? DEFAULT_POST_WINDOW_S) + extra
  );
  const motion = shared.motionContext(candidate.timestamp);
  const audioLevels = shared.audioLevelSeries();
  const audioB64 = shared.audioClipB64();
  return {
    frames,
    keyframes,
    trajectories: motion.trajectories,
    opticalFlowMagnitude: motion.opticalFlowMagnitude,
    flowMagnitudes: motion.flowMagnitudes,
    audioLevels,
    audioB64,
  };
}

/** Run the Stage-2 confirmation dive (if the trigger fires) and return the
 * effective decision to use downstream. On the no-trigger / flag-off path the
 * Stage-1 verdict is returned unchanged (strict no-op). On a real dive it
 * adopts the reconciled `decision` when the pass produced one (goalConfirmed
 * non-null); on passthrough (disabled/unparseable) or any transport failure it
 * keeps the Stage-1 verdict (no behavior change). Also records the disagreement
 * metric on `shared`. */
export async function confirmReconcile(
  client: PipelineClient,
  shared: LiveRunShared,
  cfg: AnalyzerConfig,
  stage1: DecisionResult,
  candidate: {
    eventType: string;
    timestamp: number;
    ballOutcome?: string;
    goalCrossed?: boolean;
    scoreBoardChanged?: boolean;
  }
): Promise<{ decision: DecisionResult; confirmRan: boolean; confirm?: ConfirmDecision }> {
  if (!shouldRunConfirm(cfg, candidate, stage1)) {
    return { decision: stage1, confirmRan: false };
  }
  const ctx = await buildConfirmContext(shared, cfg, candidate, stage1);
  try {
    const confirm = await client.confirm({
      eventType: candidate.eventType,
      timestamp: candidate.timestamp,
      gameHint: cfg.gameHint,
      stage1,
      ...ctx,
      ballOutcome: candidate.ballOutcome,
      goalCrossed: candidate.goalCrossed,
      scoreBoardChanged: candidate.scoreBoardChanged,
    } as ConfirmRequest);
    shared.recordConfirm({ stage1Disagreed: confirm.stage1Disagreed === true });
    // Adopt the reconciled verdict only when the pass actually produced one; on
    // passthrough (goalConfirmed null) keep the Stage-1 verdict unchanged.
    if (confirm.goalConfirmed && confirm.decision && typeof confirm.decision === "object") {
      return { decision: confirm.decision, confirmRan: true, confirm };
    }
    return { decision: stage1, confirmRan: true, confirm };
  } catch {
    // Transport failure — keep the Stage-1 verdict (no behavior change).
    shared.recordConfirm({ stage1Disagreed: false });
    return { decision: stage1, confirmRan: true };
  }
}


/** Live-console event: pushed to SSE subscribers for a job as analysis runs. */
export interface AnalyzeEvent {
  seq: number;
  timestamp: number;
  type: "observation" | "candidate" | "highlight" | "candidateBlocked";
  observation?: { tracks: TrackObservation[] };
  candidate?: { eventType: string; timestamp: number };
  highlight?: HighlightRecord;
  reason?: string;
}

export async function analyzeJob(
  client: PipelineClient,
  iterFrames: AsyncIterable<{ seq: number; timestamp: number; imageB64: string }>,
  cut: (ts: number) => Promise<{ clipId: string; clipUri: string }>,
  cfg: AnalyzerConfig,
  onEvent?: (ev: AnalyzeEvent) => void,
  /** Optional pre-reserved session (shared with a concurrent audio tap so both
   * the video /analyze and audio /audio legs feed the SAME perceive session).
   * When absent, analyzedJob reserves one itself. */
  initialSession?: ReserveResult,
  /** Optional shared live-run context (INC-2 / ADAAAA-4325 slice 4). When a
   * Stage-A audio tap is concurrently feeding the same percieve session, pass a
   * LiveRunShared so both legs share the frame-anchor window, video evidence,
   * and collected highlights. When absent (VOD), a private namespace is used
   * and behavior is unchanged. */
  shared_?: LiveRunShared,
  /** Live-slot hooks (ADAAAA-6561). `onReserve` fires on every reservation
   * (the initial session and each re-reserve) so the caller can track the job's
   * CURRENT perceive session and release it synchronously from the stop path —
   * independent of the in-flight GPU /analyze that analyzeJob's `finally`
   * would otherwise wait for. `isStopped` tells the loop to stop re-reserving
   * a fresh session once the job has been stopped (otherwise the stop-path
   * slot release would make the in-flight analyze 404 and re-bind a new slot
   * on a job that is already stopping). */
  slotRef?: { onReserve?: (res: ReserveResult) => void; isStopped?: () => boolean },
  /** Progress hook (ADAAAA-6873): fires with the running frames-processed count
   * after each frame is fed to the pipeline, so the durable worker can persist
   * a throttled, monotonic progress snapshot without waiting for job
   * completion. Optional and trailing so existing positional callers are
   * unaffected. */
  onProgress?: (framesAnalyzed: number) => void
): Promise<AnalyzeOutcome> {
  const maxReReserves = cfg.maxReReserves ?? 3;
  // ADAAAA-6577: bounded exponential backoff between a perceive session-lost
  // re-reserve and the retry of the same frame. A flapping perceive runner
  // 404s every /analyze; backing off keeps the re-reserve cadence near
  // ~1/sec at the base and lets the pass ride through a brief runner recovery
  // instead of hammering the orchestrator (see backoffDelayMs).
  const sessionRetryBackoffMs = cfg.sessionRetryBackoffMs ?? 500;
  const sessionRetryBackoffMaxMs = cfg.sessionRetryBackoffMaxMs ?? 8000;
  const first = initialSession ?? (await client.reservePerceive());
  let sessionId = first.sessionId;
  slotRef?.onReserve?.(first);
  // Every session we reserved (initial + any re-reserves) must be stopped /
  // un-paid in `finally`, even the ones go-livepeer already released (the
  // server-side released ones still hold a payment refiller in the adapter).
  const reserved = new Set<string>([first.sessionId]);
  // Live path shares frame window / evidence / highlights with the audio tap so
  // decide sees the anchored moment; VOD path gets a private namespace.
  const run = shared_ ?? new LiveRunShared({ decideWindowN: cfg.decideWindowN, goalBurstWindowS: cfg.goalBurstWindowS });
  const evidence = run.evidence;
  const highlights = run.highlights;
  // Increment D (ADAAAA-6467): the what-to-track plan orchestrator. Fires the
  // SINGLE warm-up planner call near stream start and the out-of-band re-check
  // cadence — never the planner from the per-frame loop. The resulting plan is
  // delivered to perceive alongside gameHint/preferLabels on every /analyze
  // (mirrors ADAAAA-4109 delivery so a re-reserved session inherits it too).
  const planController = new TrackingPlanController({
    warmupSeconds: cfg.warmupSeconds,
    recheckIntervalSeconds: cfg.recheckIntervalSeconds,
    planMode: cfg.planMode ?? "live",
  });
  // ADAAAA-7007: decide-observer architecture for the VOD detail-first pass.
  // The vision LLM is the PRIMARY observer: decide is invoked on a ~3 s cadence
  // with a ~10 s overlapping window (<=30 frames) and perceive is a data seeder
  // + on-demand provider, NOT the candidate on/off gate. Candidate trigger
  // signals inside the window are folded in as per-window bias hints
  // (provenance metadata). The decision path is shared via
  // observeOnDecide -> acceptVideoDecision.
  const observeDecider =
    cfg.observeLoop && cfg.decideWindowN !== undefined
      ? new ObserveDecider({
          cadenceS: cfg.observeCadenceS,
          windowS: cfg.observeWindowS,
          maxFrames: cfg.observeMaxFrames ?? OBSERVE_MAX_FRAMES,
          fps: cfg.sampleFps ?? cfg.analysisFps ?? 2,
          signalGate: cfg.observeSignalGate,
          signalGateOpts: cfg.observeSignalGateOpts,
          onDecide: (payload) => observeOnDecide(client, run, cut, cfg, onEvent, sessionId, payload),
        })
      : null;
  // ADAAAA-7011: LIVE decide-observer. When enabled on the live/default pass
  // (decideWindowN UNSET), decide is driven on the ~3 s cadence REGARDLESS of
  // whether perceive emitted a candidate, using the rolling-PAST LiveObserver.
  // Perceive becomes a data seeder (per-frame tracks/objects/ocr ride every
  // payload) and candidate triggers are folded into biasHints (provenance) —
  // they never gate decide, so trigger-FP gating no longer limits recall. The
  // accept path is shared via observeOnDecide -> acceptVideoDecision.
  const liveObserver =
    cfg.liveObserveLoop && cfg.decideWindowN === undefined
      ? new LiveObserver({
          cadenceS: cfg.observeCadenceS,
          windowS: cfg.observeWindowS,
          maxFrames: cfg.observeMaxFrames ?? LIVE_OBSERVE_MAX_FRAMES,
          fps: cfg.sampleFps ?? cfg.analysisFps ?? 2,
          signalGate: cfg.observeSignalGate,
          signalGateOpts: cfg.observeSignalGateOpts,
          onDecide: (payload) => observeOnDecide(client, run, cut, cfg, onEvent, sessionId, payload),
        })
      : null;
  let framesAnalyzed = 0;
  let planApplied = false;
  // ADAAAA-7152 Gap 1: adaptive perceive cadence for the VOD detail-first pass.
  // The per-frame `client.analyze` (perceive `process_frame` -> Florence detect)
  // is the dominant VOD E2E cost. When active, cool (no-signal) regions run at a
  // reduced `quietStride` cadence and the escalated goal window is forced to FULL
  // perceive. Auto-enable (unless explicitly forced by `cfg.perceiveCadence`)
  // exactly when the gated VOD detail-first pass is present — the configuration
  // the gap targets (ObserveDecider + Tier-2 signal gate + decideWindowN).
  // see perceive-cadence.ts for the recall-safety argument.
  const perceiveCadenceEnabled =
    cfg.perceiveCadence === true ||
    (cfg.perceiveCadence === undefined &&
      cfg.observeLoop === true &&
      cfg.observeSignalGate === true &&
      cfg.decideWindowN !== undefined);
  const perceiveCadence: PerceiveCadence | null = perceiveCadenceEnabled
    ? new PerceiveCadence({
        quietStride: cfg.perceiveQuietStride,
        hotAfterS: cfg.perceiveHotAfterS ?? cfg.observeWindowS ?? OBSERVE_WINDOW_S,
      })
    : null;
  let perceiveCalls = 0;
  try {
    for await (const frame of iterFrames) {
      framesAnalyzed++;
      onProgress?.(framesAnalyzed);
      run.addFrame(frame.seq, frame.timestamp, frame.imageB64);
      let res!: ObservationResult;
      let reReserved = 0;
      // Warm-up: fire exactly ONE planner call at stream start (on the first
      // sampled frame, so the plan is grounded in the feed). The per-frame
      // loop does NOT await the planner — it proceeds on the canned/safe-
      // default interim (no trackingPlan yet) and the plan applies the moment
      // it lands. Within the warm-up window the plan is applied before steady-
      // state tracking (plan §7 D).
      const planImage = run.anchor(frame.timestamp) ?? frame.imageB64;
      if (!planApplied) {
        void planController.warmUp(client, planImage).then(() => {
          planApplied = true;
        });
        // Start the out-of-band re-check cadence (sampling the rolling window,
        // off the per-frame path).
        planController.startRecheck(client, () => run.anchor(run.lastTimestamp()));
      }
      // Deliver the job's closed vocabulary (gameHint/preferLabels) on EVERY
      // /analyze (ADAAAA-4109): a fresh session — including one re-reserved
      // after a 404 session-lost — inherits the config the moment its first
      // frame runs, before resolve_vocabulary() gates the <OD> prompt.
      // The active TrackingPlan rides the same per-frame delivery so the
      // detect/seeding stays scoped to the plan's roster.
      const vocab = {
        gameHint: cfg.gameHint,
        preferLabels: cfg.preferLabels,
        loraRef: cfg.loraRef,
        trackingPlan: planController.delivery() ?? undefined,
        // ADAAAA-6489 / ADAAAA-7159 Gap 2: deliver this session's per-camera/
        // per-clip goal-line calibration (homography + goal-line spec) on every
        // /analyze so a fresh or re-reserved session inherits it and the
        // goal-line signal (goalCrossed/ballOutcome) flows into decide. Absent
        // -> perceive emits no signal (not_captured, never fabricated).
        ...(cfg.calibration?.homography ? { homography: cfg.calibration.homography } : {}),
        ...(cfg.calibration?.goalLine ? { goalLine: cfg.calibration.goalLine } : {}),
      };
      // ADAAAA-7152 Gap 1: decide whether this frame gets the expensive perceive
      // pass. In a cool (no-signal) region only every `quietStride`-th frame is
      // sent to perceive; once the Tier-2 gate escalates, the armed hot window
      // forces FULL perceive on every frame (the escalated goal window is never
      // starved). When the cadence is active and this frame is skipped, we still
      // feed it to the decide observer below with NO fabricated signal — the gate
      // treats an absent signal as recall-safe — so the decide window keeps full
      // frame coverage and the decide cadence keeps ticking.
      const shouldPerceive = perceiveCadence ? perceiveCadence.shouldPerceive(frame.timestamp) : true;
      let stoppedRun = false;
      if (shouldPerceive) {
        perceiveCalls++;
        for (;;) {
          try {
            res = await client.analyze(sessionId, frame, vocab);
            break;
          } catch (err) {
            // ADAAAA-6561: the stop path released the perceive slot synchronously,
            // so the in-flight /analyze may now fail. On a stopped job do NOT
            // re-reserve a fresh session (that would re-bind a capacity-1 slot to
            // a job that is already stopping) — just exit the frame loop.
            if (slotRef?.isStopped?.()) {
              stoppedRun = true;
              break;
            }
            if (!(err instanceof SessionLostError)) throw err;
            if (reReserved >= maxReReserves) throw err;
            // ADAAAA-6577: bounded exponential backoff before re-reserving so a
            // flapping perceive runner (every /analyze 404s) doesn't get a
            // request storm — ride through a brief recovery, then still abort
            // cleanly once maxReReserves is exhausted.
            await sleep(backoffDelayMs(reReserved, sessionRetryBackoffMs, sessionRetryBackoffMaxMs));
            reReserved++;
            const fresh = await client.reservePerceive();
            sessionId = fresh.sessionId;
            reserved.add(fresh.sessionId);
            slotRef?.onReserve?.(fresh);
          }
        }
        if (stoppedRun) break;
        evidence.step(res.observation);
        onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "observation", observation: res.observation });
        // A1: cache this frame's already-computed findings (tracks/OCR/objects)
        // into the 60 s window. Reused by windowFactsText — never re-analyzed.
        run.setFindings(frame.seq, res.observation);
        if (res.candidate) {
          // Immediate re-plan on a candidate event (out of band from the per-frame
          // detection; never blocks the observer cadence).
          void planController.onCandidate(client, run.anchor(res.candidate.timestamp) ?? frame.imageB64);
          // Fold the candidate into the window's factual context (plan §A).
          run.addCandidate({ timestamp: res.candidate.timestamp, eventType: res.candidate.eventType });
          onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "candidate", candidate: res.candidate });
          // ADAAAA-7007/7008: a perceive candidate is ONLY a bias hint (per-window
          // provenance) — it NEVER gates decide. The decide-observer (ObserveDecider
          // for VOD, LiveObserver for live) drives every decide on the ~3 s cadence
          // below regardless of whether perceive emitted a candidate, so trigger-FP
          // gating no longer limits recall. Perceive is a data seeder here.
          // ADAAAA-7021 fix: the candidate's goal-attestation signals (goalCrossed /
          // ballOutcome / scoreBoardChanged) are folded into the hint so the decide
          // goal-attestation gate can attest a `scoring_play` rather than reject it.
          observeDecider?.addHint(res.candidate.eventType, res.candidate.timestamp, {
            goalCrossed: res.candidate.goalCrossed,
            ballOutcome: res.candidate.ballOutcome,
            scoreBoardChanged: res.candidate.scoreBoardChanged,
          });
          liveObserver?.addHint(res.candidate.eventType, res.candidate.timestamp, {
            goalCrossed: res.candidate.goalCrossed,
            ballOutcome: res.candidate.ballOutcome,
            scoreBoardChanged: res.candidate.scoreBoardChanged,
          });
        }
      }
      // ADAAAA-7007/7008: drive the decide-observer on cadence, feeding EVERY
      // frame's perceive-derived context (tracks / objects / ocr) as the payload
      // seed. The vision LLM is the PRIMARY observer; decide runs on the ~3 s
      // cadence REGARDLESS of candidates. maybeFire no-ops until the cadence
      // elapses (so the analyze hot path is not blocked between ticks) and the
      // live observer never decodes ahead (rolling PAST window).
      if (observeDecider || liveObserver) {
        // A skipped (cool-region) frame carries NO perceive-derived context and NO
        // signal. Empty tracks/objects/ocr + `signal: undefined` is recall-safe at
        // the gate (absent signal escalates, never starves) and never fabricates a
        // goal/ball signal the frame did not report.
        const seed: PerFrameSeed = shouldPerceive
          ? {
              ts: frame.timestamp,
              tracks: res.observation.tracks.map((t) => ({ trackId: t.trackId, label: t.label ?? t.kind, bbox: t.bbox as number[] })),
              objects: res.observation.objects,
              ocr: res.observation.ocr,
              // ADAAAA-7145: fold perceive's per-frame goal/ball signal evidence into
              // the seed so the Tier-2 signal gate can judge the window. Mark a
              // goal-line judgment (goalCrossed / ballOutcome / ballInNet present) as
              // goalInfra so an explicit non-goal frame can be suppressed; an absent
              // evidence is recall-safe (the gate escalates, never starving a goal).
              signal: seedSignalFromEvidence(res.observation.evidence),
            }
          : { ts: frame.timestamp, tracks: [], objects: [], ocr: [], signal: undefined };
        observeDecider?.record(frame.timestamp, frame.imageB64, seed);
        liveObserver?.record(frame.timestamp, frame.imageB64, seed);
        if (observeDecider) await observeDecider.maybeFire(frame.timestamp);
        if (liveObserver) await liveObserver.maybeFire(frame.timestamp);
        // ADAAAA-7152 Gap 1: arm the full-perceive hot window when this frame
        // escalates the Tier-2 gate (the SAME predicate the decide observer uses),
        // so the goal window around it keeps FULL perceive treatment going forward.
        if (perceiveCadence) {
          perceiveCadence.noteFrameSignal(frame.timestamp, seed.signal, cfg.observeSignalGateOpts ?? {});
        }
      }
    }
    // Force one final observer tick at end-of-stream so the tail of the feed is
    // still observed (no-op if nothing was recorded).
    await observeDecider?.flush();
    await liveObserver?.flush();
  } finally {
    // Stop / un-pay every session we reserved this pass. Sessions the server
    // already released are a no-op on the orchestrator but still drop their
    // adapter payment refiller, so stopping them is required to avoid leaks.
    // Stop the planner's re-check timer so it cannot outlive the job.
    planController.stop();
    for (const s of reserved) {
      await client.stopPerceive(s).catch(() => {});
    }
  }
  // ADAAAA-7007/7008: the observer already awaited every cadence decide above
  // (observeOnDecide runs each decide + accept inline on the cadence), so
  // nothing further to drain before returning.
  return {
    sessionId,
    highlights,
    framesAnalyzed,
    ...(perceiveCadenceEnabled ? { perceiveCalls } : {}),
    ...(liveObserver ? { observeMetrics: buildLiveObserveMetrics(liveObserver) } : {}),
    ...(observeDecider ? { vodObserveMetrics: buildVodObserveMetrics(observeDecider) } : {}),
  };
}
