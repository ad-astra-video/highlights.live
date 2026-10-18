// Worker orchestration: one persistent perceive session per job, sample 1fps,
// feed frames to perceive, compute evidence, call decide on candidates, cut a
// clip on each highlight, and stop the session in `finally`.
import { randomUUID } from "node:crypto";
import type { HighlightRecord, JobCandidate, TrackObservation } from "@highlights/events";
import { StageAMetrics } from "./stage-a-metrics";
import type { TrainArtifact } from "./db";

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
/** The I4 / ADAAAA-6361 evidence extension forwarded to decide(): per-detection
 * geometry + ball position + audio-energy level curve. Optional so the live
 * baseline (which forwards none) renders without it. */
export interface RichEvidence {
  detections?: DetectionEvidence[];
  ballPosition?: [number, number] | null;
  distanceToGoal?: number;
  goalLineDelta?: number;
  audioLevels?: number[];
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
/** I4 / ADAAAA-6361: assemble the per-detection geometry + ball position +
 * audio-energy level curve for a candidate at `timestamp`, from the shared
 * window's cached findings and buffered audio taps (no re-analysis, no extra
 * GPU). All fields optional — detail-first mode forwards them, the live baseline
 * forwards none so its prompt is unchanged. */
export function buildRichEvidence(shared: LiveRunShared, timestamp: number): RichEvidence {
  const detections = shared.richDetections(timestamp);
  return {
    detections: detections.length ? detections : undefined,
    ballPosition: shared.ballPosition(timestamp) ?? null,
    audioLevels: shared.audioLevelSeries(),
  };
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

export interface PipelineClient {
  reservePerceive(): Promise<ReserveResult>;
  analyze(
    sessionId: string,
    frame: { seq: number; timestamp: number; imageB64: string; clipPath?: string },
    opts?: { gameHint?: string; preferLabels?: string[]; loraRef?: string; trackingPlan?: Record<string, unknown> }
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
    }
  ): Promise<DecisionResult>;
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
   * ADAAAA-6854: bounded decide concurrency for the VOD pass. `analyzeJob` runs
   * up to this many candidate decide() calls in flight at once (the vLLM decide
   * runner is already sized for 4-way concurrency), while delivering the accept
   * side-effects (goal-burst suppression, clip cut, highlight record, SSE event
   * -> decision-time billing) strictly in candidate timestamp order. Default 2;
   * set to 1 to preserve today's fully-serial VOD behavior. Live never sets this
   * (the live/decideWindowN=undefined path stays serial at 1 to keep the 1-5 s
   * latency budget). `VOD_DECIDE_CONCURRENCY`.
   */
   decideConcurrency?: number;
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
   * Every audio candidate routed through decideOnCandidate() records its
   * outcome here; the job runner snapshots it onto the job at completion. */
  readonly stageA = new StageAMetrics();
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
}

/** Seconds of audio tap kept for the decide() surrounding-audio clip
 * (ADAAAA-4954 detail-first; bounded so a long VOD pass doesn't grow unbounded).
 * Roughly the clip-relevant window around a trigger. */
export const AUDIO_CLIP_KEEP_S = 10;

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

/** Build the decide() opts for a candidate. Always anchors the candidate to
 * its nearest frame image; in DETAIL-FIRST mode (cfg.decideWindowN set,
 * ADAAAA-4954) additionally forwards the temporal `frames[]` SEQUENCE and the
 * surrounding audio clip so Gemma reasons deeper per trigger than the single
 * still-image live baseline. Live/default passes (no decideWindowN) send only
 * the anchored image, keeping the deployed baseline byte-for-byte unchanged. */
function detailDecideOpts(
  cfg: AnalyzerConfig,
  shared: LiveRunShared,
  anchoredImage: string | undefined,
  candidate: { timestamp: number; peakAudioTs?: number },
  burstFrames?: { role: string; base64: string }[]
): {
  gameHint: string;
  imageB64: string | undefined;
  frames?: { role: string; base64: string }[];
  audioB64?: string;
  preferLabels?: string[];
  priorContextText?: string;
} {
  const opts: {
    gameHint: string;
    imageB64: string | undefined;
    frames?: { role: string; base64: string }[];
    audioB64?: string;
    preferLabels?: string[];
    priorContextText?: string;
  } = {
    gameHint: cfg.gameHint,
    imageB64: anchoredImage,
  };
  // ADAAAA-6855: forward the job's requested highlight labels so the decide
  // runner's accept gate exports a requested non-goal class as a distinct
  // highlight instead of swallowing it.
  if (cfg.preferLabels?.length) opts.preferLabels = cfg.preferLabels;
  // A2: every decide call for an in-window candidate carries the current 60 s
  // window's facts as bounded text tokens (pure server assembly; cached
  // findings, no re-analysis). Included unconditionally — live and detail-first
  // alike. Empty when the window has nothing to add (behavior identical).
  opts.priorContextText = shared.windowFactsText();
  // Increment F / ADAAAA-6465: Frames are the PRIMARY evidence on EVERY trigger
  // (live + VOD). Assemble the capped sequence — sampled at analysis_fps,
  // keyframe set (trigger-onset, peak-audio, window-end), hard-capped at
  // max_frames_per_analysis — so the LLM watches the actual play. Audio stays a
  // cheap, fallible trigger/corroboration (crowds erupt for near misses / wrong
  // calls / replays). This replaces the detail-first-only `frames[]` gating so
  // the analysis call always receives the assembled sequence, never a single
  // still (live baseline no longer sends a bare anchored image).
  const seq = shared.frameSequenceFor(candidate.timestamp, candidate.peakAudioTs, {
    analysisFps: cfg.analysisFps,
    maxFramesPerAnalysis: cfg.maxFramesPerAnalysis,
    preWindowS: cfg.preWindowS,
    postWindowS: cfg.postWindowS,
  });
  // I7 / ADAAAA-6361: when a higher-FPS burst was re-sampled around the trigger,
  // prefer it (it already contains the ball-goal-crossing instant); else use the
  // assembled capped sequence.
  opts.frames = burstFrames?.length ? burstFrames : seq;
  const audio = shared.audioClipB64();
  if (audio) opts.audioB64 = audio;
  return opts;
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
  candidate: { eventType: string; timestamp: number; seq?: number },
  decision: DecisionResult,
  status: "accepted" | "suppressed" | "rejected"
): void {
  if (!cfg.onDecision) return;
  try {
    cfg.onDecision({
      id: randomUUID(),
      jobId: cfg.jobId,
      seq: candidate.seq ?? 0,
      timestamp: candidate.timestamp,
      eventType: decision.eventType ?? candidate.eventType,
      score: decision.score,
      isHighlight: decision.isHighlight,
      outcome: decision.outcome,
      nearMiss: decision.nearMiss,
      reason: decision.reason,
      status,
      createdAt: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error(`[decide-note:${cfg.jobId}] persist failed:`, String(e?.message || e));
  }
}

/**
 * ADAAAA-6854: bounded-concurrency decide dispatcher for the VOD pass.
 *
 * Runs up to `w` candidate decide() calls in flight at once — the vLLM decide
 * runner is already sized for `GEMMA_MAX_CONCURRENCY=4`, so overlapping the
 * expensive inference is exactly the throughput win the runner was provisioned
 * for. The DECIDE calls run concurrently, but every ACCEPT side-effect
 * (goal-burst suppression, clip cut, highlight record, SSE `highlight` event ->
 * decision-time persist + bill + quota-debit) is delivered strictly in
 * candidate timestamp order via an ordered reorder buffer — so parallelising
 * the inference never reorders clip assembly, never accepts/suppresses a goal
 * out of date order, and never double-bills (each accepted candidate fires
 * exactly one `highlight` event).
 *
 * Live never uses this (w=1 / the `decideWindowN`-unset path in `analyzeJob`
 * stays fully serial), so the live 1-5 s latency budget is untouched.
 */
export class OrderedDecidePipeline {
  private readonly w: number;
  private readonly client: PipelineClient;
  private readonly accept: (
    candidate: { eventType: string; timestamp: number; seq?: number; audio?: AudioCandidate["audio"]; goalCrossed?: boolean; ballOutcome?: string; scoreBoardChanged?: boolean },
    emit: { seq: number; timestamp: number },
    decision: DecisionResult
  ) => Promise<void>;
  private queue: { index: number; evidence: Parameters<PipelineClient["decide"]>[0]; opts: Parameters<PipelineClient["decide"]>[1]; candidate: any; emit: { seq: number; timestamp: number } }[] = [];
  /** In-flight decide() calls (the only thing that runs concurrently). */
  private active = 0;
  /** Successful decide results, keyed by submission index, awaiting their turn to
   * be accepted (a reorder buffer: a result is only accepted once every earlier
   * result has been accepted/discarded). */
  private results = new Map<number, { decision: DecisionResult; candidate: any; emit: { seq: number; timestamp: number } }>();
  /** Next result index to accept (accepted strictly in submission/timestamp order). */
  private nextAccept = 0;
  private total = 0;
  /** True while one accept side-effect is running — accepts are serialized, so
   * clip cut / highlight record / SSE event / billing never reorder. */
  private accepting = false;
  /** Set on the first decide or accept failure. Once set the pipeline stops
   * launching decides and delivering accepts, and `drain()` rejects — mirroring
   * the serial path where a decide/accept failure aborts the whole job. */
  private aborting = false;
  private firstError?: Error;
  private settleResolve?: () => void;
  private settled = false;

  constructor(
    client: PipelineClient,
    w: number,
    accept: (candidate: any, emit: { seq: number; timestamp: number }, decision: DecisionResult) => Promise<void>
  ) {
    this.client = client;
    this.w = Math.max(1, w);
    this.accept = accept;
  }

  /** Enqueue one candidate decide. Returns immediately (does NOT block the
   * frame-analysis loop); the decide + ordered accept run in the pipeline. */
  submit(
    candidate: { eventType: string; timestamp: number; seq?: number; audio?: AudioCandidate["audio"]; goalCrossed?: boolean; ballOutcome?: string; scoreBoardChanged?: boolean },
    emit: { seq: number; timestamp: number },
    evidence: Parameters<PipelineClient["decide"]>[0],
    opts: Parameters<PipelineClient["decide"]>[1]
  ): void {
    if (this.aborting) return; // after a failure nothing is launched or accepted
    const index = this.total++;
    this.queue.push({ index, evidence, opts, candidate, emit });
    this.pump();
  }

  /** True once any decide or accept failed — the frame loop checks this to stop
   * analyzing the rest of the job (mirrors the serial path, which aborts on the
   * first failure). */
  get aborted(): boolean {
    return this.aborting;
  }

  private pump(): void {
    while (!this.aborting && this.active < this.w && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active++;
      void this.runJob(job);
    }
  }

  private async runJob(job: { index: number; evidence: any; opts: any; candidate: any; emit: { seq: number; timestamp: number } }): Promise<void> {
    try {
      const decision = await this.client.decide(job.evidence, job.opts);
      this.results.set(job.index, { decision, candidate: job.candidate, emit: job.emit });
    } catch (e) {
      this.abort(e);
    } finally {
      this.active--;
      this.pump();
      this.drainReady();
      this.maybeSettle();
    }
  }

  /** Settle the pipeline with `err`, drop anything not yet accepted, and stop
   * launching/accepting further work. In-flight decides are left to finish (so
   * `drain()` can resolve once they settle); their results are discarded, never
   * accepted, because a decide failure aborts the whole job (as in the serial
   * path). `nextAccept` is set to `total` so settlement cannot be blocked by a
   * failed index that never lands a result. */
  private abort(err: unknown): void {
    if (!this.firstError) this.firstError = err instanceof Error ? err : new Error(String(err));
    this.aborting = true;
    this.queue.length = 0;
    this.results.clear();
    this.nextAccept = this.total;
    this.maybeSettle();
  }

  /** Deliver accepted highlights in candidate (submission/timestamp) order,
   * one at a time. Results that arrive out of order are buffered until their
   * predecessor has been accepted; a failure stops delivery. */
  private drainReady(): void {
    if (this.accepting || this.aborting) return;
    if (!this.results.has(this.nextAccept)) return;
    const r = this.results.get(this.nextAccept)!;
    this.results.delete(this.nextAccept);
    this.nextAccept++;
    this.accepting = true;
    this.accept(r.candidate, r.emit, r.decision)
      .catch((e) => this.abort(e))
      .finally(() => {
        this.accepting = false;
        this.drainReady();
        this.maybeSettle();
      });
  }

  private maybeSettle(): void {
    if (this.settled) return;
    const allDecidesDone = this.queue.length === 0 && this.active === 0;
    const allAccepted = this.aborting || this.nextAccept >= this.total;
    if (allDecidesDone && allAccepted && !this.accepting) {
      this.settled = true;
      this.settleResolve?.();
    }
  }

  /** Wait for every submitted decide + ordered accept to complete. Rejects if
   * any decide or accept failed (mirrors the serial path: a decide failure
   * aborts the job). Never hangs: a failure settles the pipeline (see `abort`). */
  async drain(): Promise<void> {
    if (this.queue.length === 0 && this.active === 0 && this.results.size === 0 && !this.accepting) {
      if (this.firstError) throw this.firstError;
      return;
    }
    await new Promise<void>((resolve) => {
      this.settleResolve = resolve;
    });
    if (this.firstError) throw this.firstError;
  }
}

/** Build the decide() evidence + opts for a single candidate, exactly as the
 * serial paths produce it so parallelisation never changes an individual
 * verdict (ADAAAA-6854). The (slow, optional) burst re-sample + window reads
 * happen here — at dispatch time — so the payload is a faithful snapshot
 * regardless of how many later frames stream in while the decide is in flight. */
async function buildVideoDecideRequest(
  cfg: AnalyzerConfig,
  run: LiveRunShared,
  evidenceTracker: EvidenceTracker,
  candidate: NonNullable<ObservationResult["candidate"]>,
  observation: ObservationResult["observation"],
  anchoredImage: string | undefined
): Promise<{ evidence: Parameters<PipelineClient["decide"]>[0]; opts: Parameters<PipelineClient["decide"]>[1] }> {
  // I7 / ADAAAA-6361: re-sample a higher-FPS burst around the trigger on the
  // detail-first VOD pass so the crossing instant is in the decide window.
  let burstFrames: { role: string; base64: string }[] | undefined;
  if (cfg.decideWindowN !== undefined && cfg.resampleFrames) {
    try {
      const burst = await cfg.resampleFrames(candidate.timestamp);
      if (burst?.length) burstFrames = burst.map((f) => ({ role: "full", base64: f.imageB64 }));
    } catch {
      /* degrade to rolling window */
    }
  }
  const evidence: Parameters<PipelineClient["decide"]>[0] = {
    eventType: candidate.eventType,
    trackCount: evidenceTracker.trackCount,
    maxVelocity: evidenceTracker.maxVelocity,
    ocrHits: observation?.ocr?.length ?? 0,
    reaction: buildReactionEvidence(candidate, evidenceTracker.trackCount),
    goalCrossed: candidate.goalCrossed,
    ballOutcome: candidate.ballOutcome,
    scoreBoardChanged: candidate?.scoreBoardChanged,
    // I4 / ADAAAA-6361: forward per-detection geometry + audio level curve on
    // the detail-first (VOD) pass.
    ...(cfg.decideWindowN !== undefined ? buildRichEvidence(run, candidate.timestamp) : {}),
  };
  const opts = detailDecideOpts(cfg, run, anchoredImage, { timestamp: candidate.timestamp, peakAudioTs: candidate.audio?.ts }, burstFrames);
  return { evidence, opts };
}

/** Accept (or suppress) a decided candidate with exactly the serial semantics:
 * goal-burst suppression applied in timestamp order, then cut + record + SSE
 * `highlight` event (which drives decision-time persist/bill/quota exactly
 * once). Shared by the serial (live / w=1) inline path and the ordered VOD
 * pipeline so both are byte-for-byte identical. */
async function acceptVideoDecision(
  run: LiveRunShared,
  cut: (ts: number) => Promise<{ clipId: string; clipUri: string }>,
  cfg: AnalyzerConfig,
  onEvent: ((ev: AnalyzeEvent) => void) | undefined,
  emit: { seq: number; timestamp: number },
  candidate: { eventType: string; timestamp: number },
  decision: DecisionResult
): Promise<void> {
  // ADAAAA-6851 Inc 2: persist EVERY decide evaluation — accepted highlight,
  // burst-suppressed, near-miss, not-highlight. This runs on both the serial
  // (live / w=1) path and the ordered pipeline accept path (ADAAAA-6854), so
  // the decision-time note trail stays identical either way.
  if (!isAcceptedHighlight(decision, cfg.preferLabels)) {
    buildCandidateNote(cfg, candidate, decision, "rejected");
    return;
  }
  // ADAAAA-6610 temporal burst suppression (see decideOnCandidate): a GOAL
  // accepted within `goalBurstWindowS` of a previous one is a start-of-clip
  // burst duplicate and is dropped, not recorded.
  if (run.suppressIfGoalBurst(candidate.timestamp, decision.eventType ?? candidate.eventType)) {
    buildCandidateNote(cfg, candidate, decision, "suppressed");
    onEvent?.({
      seq: emit.seq,
      timestamp: emit.timestamp,
      type: "candidateBlocked",
      candidate: { eventType: decision.eventType ?? candidate.eventType, timestamp: candidate.timestamp },
      reason: "goal highlight suppressed (burst: within goal burst window of an accepted goal)",
    });
    return;
  }
  buildCandidateNote(cfg, candidate, decision, "accepted");
  const { clipId, clipUri } = await cut(candidate.timestamp);
  const rec: HighlightRecord = {
    id: randomUUID(),
    jobId: cfg.jobId,
    clipUri,
    start: Math.max(0, candidate.timestamp - cfg.clipBeforeS),
    end: candidate.timestamp + cfg.clipAfterS,
    eventType: decision.eventType,
    score: decision.score,
    reason: decision.reason,
    // Increment F / ADAAAA-6465: near-miss surface at a lower score, labeled
    // distinctly via the outcome/nearMiss flag.
    outcome: decision.outcome,
    nearMiss: decision.nearMiss,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  run.highlights.push(rec);
  onEvent?.({ seq: emit.seq, timestamp: emit.timestamp, type: "highlight", highlight: rec });
}

/**
 * Route ONE candidate through the decide stage on the anchored frame (INC-2 /
 * ADAAAA-4325 slice 4). Shared by the video /analyze leg and the Stage-A audio
 * tap leg so both: emit a live-console candidate, anchor the decide frame image
 * to the candidate's timestamp, run the Gemma decide runner with the shared
 * video evidence, and — when it is a highlight — cut a clip and record it.
 *
 * The candidate marks a possible highlight only; only ``decide()`` decides.
 * ``emit`` carries the caller's seq/timestamp for live-console events.
 */
export async function decideOnCandidate(
  client: PipelineClient,
  shared: LiveRunShared,
  cut: (ts: number) => Promise<{ clipId: string; clipUri: string }>,
  cfg: AnalyzerConfig,
  candidate: { eventType: string; timestamp: number; seq?: number; audio?: AudioCandidate["audio"]; goalCrossed?: boolean; ballOutcome?: string; scoreBoardChanged?: boolean },
  onEvent?: (ev: AnalyzeEvent) => void,
  emit?: { seq: number; timestamp: number }
): Promise<void> {
  const evSeq = emit?.seq ?? candidate.seq ?? 0;
  const evTs = emit?.timestamp ?? candidate.timestamp;
  onEvent?.({ seq: evSeq, timestamp: evTs, type: "candidate", candidate });
  const anchoredImage = shared.anchor(candidate.timestamp);
  // I7 / ADAAAA-6361: on the detail-first VOD pass, re-sample a higher-FPS burst
  // of frames around the trigger so the ball-goal-crossing instant is present in
  // the decide window (a low-FPS sample can skip it). Any failure degrades to the
  // rolling window — never a dead decide call.
  let burstFrames: { role: string; base64: string }[] | undefined;
  if (cfg.decideWindowN !== undefined && cfg.resampleFrames) {
    try {
      const burst = await cfg.resampleFrames(candidate.timestamp);
      if (burst?.length) burstFrames = burst.map((f) => ({ role: "full", base64: f.imageB64 }));
    } catch {
      /* degrade to rolling window */
    }
  }
  // Cache the candidate (type + timestamp + reaction) into the 60 s window so
  // it participates in the window's factual context (plan §A / A2).
  shared.addCandidate({
    timestamp: candidate.timestamp,
    eventType: candidate.eventType,
    reaction: buildReactionEvidence(candidate, shared.evidence.trackCount),
  });
  const decision = await client.decide(
    {
      eventType: candidate.eventType,
      trackCount: shared.evidence.trackCount,
      maxVelocity: shared.evidence.maxVelocity,
      ocrHits: shared.ocrHitsAt(candidate.timestamp),
      reaction: buildReactionEvidence(candidate, shared.evidence.trackCount),
      goalCrossed: candidate.goalCrossed,
      ballOutcome: candidate.ballOutcome,
      scoreBoardChanged: candidate.scoreBoardChanged,
      // I4 / ADAAAA-6361: forward per-detection geometry + audio level curve on
      // the detail-first (VOD) pass so the prompt can cite concrete evidence.
      ...(cfg.decideWindowN !== undefined ? buildRichEvidence(shared, candidate.timestamp) : {}),
    },
    detailDecideOpts(cfg, shared, anchoredImage, { timestamp: candidate.timestamp, peakAudioTs: candidate.audio?.ts }, burstFrames)
  );
  // Track the Stage-A FP-rate metric (INC-2 / ADAAAA-4325 slice 5): whether
  // Gemma accepted this audio-gate candidate as a highlight, plus the gate's
  // reported onset latency. Feeds job.stageAMetrics fpRate = rejected / total.
  shared.stageA.recordOutcome(decision.isHighlight, candidate.audio?.onsetLatencyS);
  // ADAAAA-6851 Inc 2: persist EVERY decide evaluation — accepted highlight,
  // burst-suppressed, near-miss, not-highlight — before the accept gate so no
  // non-accepted decision is lost.
  const acceptedDecision = isAcceptedHighlight(decision, cfg.preferLabels);
  // ADAAAA-6598: accept gate — only a frame-confirmed scoring_play is a board
  // highlight. A near_miss / big_play read is recorded distinctly (outcome
  // preserved) but never cut as a GOAL highlight/clip. ADAAAA-6855: a non-goal
  // class explicitly requested in the job's preferLabels is exported as a
  // DISTINCT highlight (never a goal).
  if (!acceptedDecision) {
    buildCandidateNote(cfg, candidate, decision, "rejected");
    return;
  }
  // ADAAAA-6610 temporal burst suppression: at most one GOAL highlight per
  // window. A GOAL accepted within `goalBurstWindowS` of a previous one is a
  // burst duplicate (start-of-clip confabulated-goal flood) and is dropped,
  // not recorded.
  if (shared.suppressIfGoalBurst(candidate.timestamp, decision.eventType ?? candidate.eventType)) {
    buildCandidateNote(cfg, candidate, decision, "suppressed");
    onEvent?.({
      seq: evSeq,
      timestamp: evTs,
      type: "candidateBlocked",
      candidate: { eventType: decision.eventType ?? candidate.eventType, timestamp: candidate.timestamp },
      reason: "goal highlight suppressed (burst: within goal burst window of an accepted goal)",
    });
    return;
  }
  buildCandidateNote(cfg, candidate, decision, "accepted");
  const { clipId, clipUri } = await cut(candidate.timestamp);
  const rec: HighlightRecord = {
    id: randomUUID(),
    jobId: cfg.jobId,
    clipUri,
    start: Math.max(0, candidate.timestamp - cfg.clipBeforeS),
    end: candidate.timestamp + cfg.clipAfterS,
    eventType: decision.eventType,
    score: decision.score,
    reason: decision.reason,
    // Increment F / ADAAAA-6465: near-miss surface at a lower score, labeled
    // distinctly via the outcome/nearMiss flag on the highlight record.
    outcome: decision.outcome,
    nearMiss: decision.nearMiss,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  shared.highlights.push(rec);
  onEvent?.({ seq: evSeq, timestamp: evTs, type: "highlight", highlight: rec });
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
  // ADAAAA-6854: bounded decide concurrency for the VOD pass. The frame loop
  // dispatches candidate decides into a W-wide pool (default 2) without
  // awaiting them, so the next frames' perceive analysis overlaps the in-flight
  // vLLM decide. Accept side-effects (burst suppression, cut, record, SSE
  // event -> billing) are delivered in candidate timestamp order. Live never
  // sets decideConcurrency and its `decideWindowN` is undefined, so it stays on
  // the fully-serial inline path below (W=1) — the 1-5 s latency budget holds.
  const decidePipeline = new OrderedDecidePipeline(
    client,
    cfg.decideConcurrency ?? 1,
    (candidate, emit, decision) => acceptVideoDecision(run, cut, cfg, onEvent, emit, candidate, decision)
  );
  let framesAnalyzed = 0;
  let planApplied = false;
  try {
    for await (const frame of iterFrames) {
      // ADAAAA-6854: fail fast on a decide/accept failure — stop analyzing the
      // rest of the job (the pipeline has aborted; `drain()` will reject below).
      // The previous frame's `await client.analyze` yielded to the event loop, so
      // the async abort has landed by the time we reach here.
      if (decidePipeline.aborted) break;
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
      };
      let stoppedRun = false;
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
        // detection; never blocks the current candidate's decide()).
        void planController.onCandidate(client, run.anchor(res.candidate.timestamp) ?? frame.imageB64);
        // Fold the candidate into the window's factual context (plan §A).
        run.addCandidate({ timestamp: res.candidate.timestamp, eventType: res.candidate.eventType });
        onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "candidate", candidate: res.candidate });

        // Send the ACTUAL candidate frame so the Gemma vision decide runner can
        // see the moment, plus the game hint. Evidence remains as context. The
        // candidate is ANCHORED at the peak-motion (strike) frame's timestamp,
        // so resolve that frame's image from the rolling window — a candidate
        // fired on the late post-strike frame must still be judged on the strike.
        const anchoredImage = run.anchor(res.candidate.timestamp) ?? frame.imageB64;
        // Build the decide payload (evidence + opts) as a faithful snapshot at
        // dispatch time, then either dispatch it to the bounded pool (VOD
        // concurrency) or run it inline (live / w=1) — byte-identical verdict
        // either way (AC2).
        const { evidence: decideEvidence, opts: decideOpts } = await buildVideoDecideRequest(
          cfg,
          run,
          evidence,
          res.candidate,
          res.observation,
          anchoredImage
        );
        if (cfg.decideWindowN !== undefined && (cfg.decideConcurrency ?? 1) > 1) {
          // ADAAAA-6854: VOD bounded-concurrency path — do NOT await the decide;
          // the ordered pipeline runs it in the W-wide pool and delivers accept
          // side-effects in candidate timestamp order (clips/billing exactly
          // once, burst suppression in order). Each decide evaluation is still
          // persisted via buildCandidateNote (ADAAAA-6851 Inc 2) inside
          // acceptVideoDecision, so the accept path stays byte-identical to the
          // serial path (AC2).
          decidePipeline.submit(res.candidate, { seq: frame.seq, timestamp: frame.timestamp }, decideEvidence, decideOpts);
        } else {
          // Live (decideWindowN unset) / w=1 opt-out: fully serial, unchanged.
          const decision = await client.decide(decideEvidence, decideOpts);
          await acceptVideoDecision(run, cut, cfg, onEvent, { seq: frame.seq, timestamp: frame.timestamp }, res.candidate, decision);
        }
      }
    }
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
  // ADAAAA-6854: wait for every in-flight VOD decide + ordered accept (cut,
  // record, SSE `highlight` -> decision-time billing) before returning. Throws
  // if any decide/accept failed, aborting the job like the serial path.
  await decidePipeline.drain();
  return { sessionId, highlights, framesAnalyzed };
}
