// Worker orchestration: one persistent perceive session per job, sample 1fps,
// feed frames to perceive, compute evidence, call decide on candidates, cut a
// clip on each highlight, and stop the session in `finally`.
import { randomUUID } from "node:crypto";
import type { HighlightRecord, TrackObservation } from "@highlights/events";
import { StageAMetrics } from "./stage-a-metrics";
import type { TrainArtifact } from "./db";
// C — in-memory vector store of prior-window facts (long-horizon memory,
// plan §C). Per-stream/job CPU-embedding vector memory; see fact-memory.ts.
import { FactMemory } from "./fact-memory";
import { EntityIdentityResolver, extractJersey } from "./entity-identity";

export interface ReserveResult {
  sessionId: string;
  appUrl: string;
  controlUrl: string;
}
export interface ObservationResult {
  observation: { tracks: TrackObservation[]; seq: number; timestamp: number };
  candidate?: {
    eventType: string;
    timestamp: number;
    // INC-2 audio-gate signal and INC-2b ball signal ride the CandidateEvent
    // from perceive; the server folds them into decide() reaction evidence.
    audio?: AudioCandidate["audio"];
    ballVelocity?: { speedMps?: number };
    ballPossession?: { possessingPlayerId?: string };
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
export interface DecisionResult {
  isHighlight: boolean;
  score: number;
  eventType?: string;
  reason?: string;
  /** Grounded-evidence output of the paid decide call (ADAAAA-6028 / plan §G).
   * The decide LLM ties a claimed event (esp. a high-value label like GOAL) to
   * explicit visual evidence. The server-side grounding gate (G3) rejects a
   * claimed highlight whose event type has no supporting vision evidence. */
  grounding?: Grounding;
  source?: string;
}
/** Grounded-evidence object returned by the paid decide call (plan §G). The
 * model names the tracked object(s)/regions it is looking at, any OCR /
 * scoreboard delta, a statement of why the frame content supports (or refutes)
 * the claimed event type, and whether the frames actually support it. */
export interface Grounding {
  objects?: string[];
  ocrDelta?: string;
  evidence?: string;
  supports?: boolean;
}
export interface GroundingGateResult {
  accepted: boolean;
  /** Non-empty when rejected — the reason to log. */
  reason: string;
}
/**
 * The grounded-evidence verification gate (ADAAAA-6028 / plan G3). Runs between
 * the raw decide call and highlight creation: a candidate that CLAIMS a
 * highlight (isHighlight=true) but whose decision output carries no supporting
 * vision evidence is rejected — not surfaced — and the rejection is logged.
 *
 * Rejection rules (deterministic, unit-testable):
 *  - no grounding object at all            -> reject ("no grounding evidence")
 *  - grounding.supports === false          -> reject ("grounding refutes …")
 *  - grounding cites neither objects, nor
 *    evidence text, nor an ocrDelta        -> reject ("claims … with no cited evidence")
 *
 * Non-highlight decisions are never surfaced regardless, so the gate is a no-op
 * for them (accepted=false with an empty reason — not a rejection the highlight
 * path counts).
 */
export function applyGroundingGate(
  decision: DecisionResult,
  claimedEventType: string
): GroundingGateResult {
  if (!decision.isHighlight) return { accepted: false, reason: "" };
  const ev = claimedEventType || "event";
  const g = decision.grounding;
  if (!g) {
    return { accepted: false, reason: `no grounding evidence for claimed event type ${ev}` };
  }
  if (g.supports === false) {
    return { accepted: false, reason: `grounding refutes claimed event type ${ev}` };
  }
  const hasEvidence =
    !!g.evidence?.trim() ||
    (Array.isArray(g.objects) && g.objects.length > 0) ||
    !!g.ocrDelta?.trim();
  if (!hasEvidence) {
    return { accepted: false, reason: `grounding claims ${ev} with no cited evidence` };
  }
  return { accepted: true, reason: "" };
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
export interface PipelineClient {
  reservePerceive(): Promise<ReserveResult>;
  analyze(
    sessionId: string,
    frame: { seq: number; timestamp: number; imageB64: string; clipPath?: string },
    opts?: { gameHint?: string; preferLabels?: string[]; loraRef?: string }
  ): Promise<ObservationResult>;
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
      /** Dense burst frame SEQUENCE around a CONFIRMED candidate moment (plan §E /
       * ADAAAA-6030 motion-aware confirmation tight tier): `burstFrames[]` in the
       * decide request, over ≈±2.5 s around T, bounded count/resolution. Server
       * pulls it from the already-cached 60 s window — no re-analysis, no extra
       * GPU. Only present on the confirmation call, never every window. */
      burstFrames?: { role: string; base64: string }[];
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
  /** Count of candidates whose claimed event type was rejected by the
   * grounded-evidence verification gate (plan G3) in this pass. Measurable so
   * the gate's rejection behaviour can be asserted in eval. */
  groundingRejections: number;
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

// --- Motion-aware confirmation burst tier (ADAAAA-6030, plan §E) -----------
/** Full span (seconds) of the dense burst window around a confirmed candidate
 * moment T: T−BURST_SPAN_S/2 .. T+BURST_SPAN_S/2 (≈ ±2.5 s each side). */
export const BURST_SPAN_S = 5;
/** Frame-count cap for the burst in the LIVE path (E). Live ingests at ~1 fps,
 * so a ±2.5 s span yields ~5–6 cached frames; the cap is a bound, not a fill. */
export const LIVE_BURST_MAX = 6;
/** Frame-count cap for the burst in the VOD / detail-first path (E: "larger
 * burst cap allowed"; higher-fps VOD supplies a denser cached window). */
export const VOD_BURST_MAX = 16;

/** Already-computed perception findings for one in-window sampled frame (A1).
 * These come from the `/analyze` result the server already paid for — cached
 * and REUSED by window-facts assembly, never re-analyzed (no extra GPU). */
/** Area (normalized units) of a [x1,y1,x2,y2] box; used to pick the dominant
 * player track for OCR jersey binding (plan §D). */
function boxArea(b: number[]): number {
  const w = Math.max(0, b[2] - b[0]);
  const h = Math.max(0, b[3] - b[1]);
  return w * h;
}

export interface FrameFindings {
  /** Tracked-object bboxes + labels (ResNet/Florence + SAM tracking). */
  tracks: {
    trackId: string;
    label?: string;
    bbox: number[];
    /** Stable entity identity this track resolves to (plan §D / ADAAAA-6032):
     * `j:<jersey>` when a jersey/OCR identity is bound, else `ent:<uuid>`.
     * Consumed by the vector-memory `entityRef` (plan §C) and the narrative
     * case (A4). Empty when the track is a transient blip with no binding yet. */
    entityRef?: string;
    /** Jersey/number/name token bound to this entity, when available ('' else). */
    jersey?: string;
  }[];
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
  /** Cross-window entity identity continuity (plan §D / ADAAAA-6032): resolves
   * the same player/entity across windows (trackId / jersey / OCR) into stable
   * entity identities consumed by the vector-memory `entityRef` and the
   * narrative case (A4: yellow at T -> red at T+30 for the SAME entity). */
  readonly identity = new EntityIdentityResolver();
  /** Per-entity high-signal event history for the run (the arc store, plan §D /
   * A4): salient events (confirmed highlights keyed to the entity they involved)
   * recorded so a later decide on the same entity references the earlier one
   * (e.g. red-card prior context carries the earlier yellow booking). */
  private readonly entityEvents = new Map<string, { ts: number; eventType: string; reason?: string }[]>();
  /** Candidates rejected by the grounded-evidence gate (plan G3): the decide
   * model CLAIMED a highlight but supplied no supporting vision evidence. */
  groundingRejections = 0;
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
  /** C — in-memory vector store of high-signal facts from at/outside the 60 s
   * window (long-horizon memory, plan §C). Per-stream/job; salience-gated
   * ingestion; CPU embedding; small top-k retrieval appended to the decide
   * prompt's prior context. See fact-memory.ts. */
  readonly memory = new FactMemory();
  /** Detail-first decide window length (frames kept for the temporal SEQUENCE).
   * Defaults to the live baseline (DECIDE_FRAME_WINDOW); the VOD knob
   * `decideWindowN` raises it (ADAAAA-4954). */
  private readonly windowN: number;
  /** Raw mono 16 kHz int16 PCM taps (base64 per ~100 ms chunk) + end timestamp,
   * kept as a short rolling clip so the surrounding audio can be handed to
   * decide() (ADAAAA-4954 detail-first). */
  private audio: { ts: number; samples: string }[] = [];

  constructor(opts: { decideWindowN?: number } = {}) {
    this.windowN = opts.decideWindowN ?? DECIDE_FRAME_WINDOW;
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
    const ts = this.frames.get(seq)?.timestamp ?? seq;
    // D: resolve each track to a stable entity identity (trackId continuity /
    // IoU reassignment-stitch / jersey+OCR binding). Feed the in-roster label
    // as the jersey hint (extractJersey discards coarse class labels like
    // "player"; a numeric roster label binds automatically). OCR is currently
    // empty on the perceive path (a call-out), so jersey binding is dormant on
    // real data but first-class + unit-tested below.
    //
    // Optional OCR jersey binding (plan §D "jersey / OCR"): when the frame's OCR
    // yields a single jersey token, bind it to the dominant (largest) player
    // track (strong cross-window identity). Built into ONE resolve so no
    // vestigial entity is created for the pre-binding state.
    const ocrJersey = obs.ocr?.map((o) => extractJersey(o)).find((j) => j) ?? "";
    const hinted = obs.tracks.map((t) => {
      let hint = t.label;
      if (ocrJersey && t.kind === "player") {
        const players = obs.tracks.filter((p) => p.kind === "player" && p.bbox);
        const dom = players.length
          ? players.reduce((a, b) => (boxArea(b.bbox as number[]) > boxArea(a.bbox as number[]) ? b : a))
          : undefined;
        if (dom && dom.trackId === t.trackId) hint = ocrJersey;
      }
      return { trackId: t.trackId, bbox: t.bbox as number[], jersey: hint };
    });
    const resolved = this.identity.resolve(ts, hinted);
    const findings: FrameFindings = {
      tracks: obs.tracks.map((t) => {
        const r = resolved.get(t.trackId);
        return {
          trackId: t.trackId,
          label: t.label,
          bbox: t.bbox as number[],
          // Only surface stable (narrative-safe) identities; transient blips
          // carry no entityRef so the narrative layer never merges on a blip.
          ...(r && r.stability === "stable"
            ? { entityRef: r.entityRef, ...(r.jersey ? { jersey: r.jersey } : {}) }
            : {}),
        };
      }),
      objects: (obs.objects ?? []).map((o) => ({ label: o.label, confidence: o.confidence, bbox: o.bbox as number[] })),
      ocr: obs.ocr ?? [],
    };
    const existing = this.frames.get(seq);
    if (existing) existing.findings = findings;
    else this.frames.set(seq, { timestamp: seq, imageB64: "", findings });
  }
  /** Cache a candidate event (type + timestamp + reaction signal) into the
   * window context, bounded so it never grows on long streams. */
  addCandidate(c: WindowCandidate): void {
    this.candidates.push(c);
    if (this.candidates.length > CACHE_MAX_FRAMES) this.candidates.shift();
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
  /** The dense burst frame SEQUENCE around a confirmed candidate moment ``ts``
   * (plan §E, motion-aware confirmation tight tier): the cached frames within
   * [ts−BURST_SPAN_S/2, ts+BURST_SPAN_S/2], ordered oldest -> newest, bounded
   * to ``max`` frames (kept centered on ``ts`` when trimming). Pulled ONLY from
   * the already-cached 60 s window — no re-analysis, no extra GPU — so burst
   * assembly is sub-millisecond and never blocks the paid decision path (A5).
   * Live (~1 fps) yields ~5–6 frames inside the cap; a denser VOD cache is
   * trimmed to the VOD cap. Returns [] when the window holds no in-span frame. */
  burstFrames(ts: number, opts: { max?: number } = {}): { role: string; base64: string }[] {
    const max = opts.max ?? LIVE_BURST_MAX;
    const half = BURST_SPAN_S / 2;
    const inRange = [...this.frames.values()]
      .filter((f) => Math.abs(f.timestamp - ts) <= half)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (!inRange.length) return [];
    if (inRange.length > max) {
      const start = Math.floor((inRange.length - max) / 2);
      inRange.splice(0, start);
      inRange.length = max;
    }
    return inRange.map((f) => ({ role: "full", base64: f.imageB64 }));
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
            tracks
              .map((t) => {
                // Stable entity identity (plan §D): surface the narrative-safe
                // entityRef so a later decide on the same entity can reference
                // this one (the whole-picture/yellow->red arc). Transient blips
                // (no entityRef) fall back to the raw trackId.
                const id = t.entityRef || t.trackId;
                const jes = t.jersey ? `#${t.jersey}` : "";
                return `${t.label || id}${jes}@${(t.bbox as number[]).map((b) => b.toFixed(2)).join(",")}`;
              })
              .join(";")
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
  /**
   * C — the decide prompt's prior context: the current 60 s window's facts
   * (plan §B/A2) PLUS a bounded block of retrieved long-horizon facts from the
   * in-memory vector store (plan §C/A3). Retrieval embeds the window's salient
   * facts and pulls top-k similar prior facts from earlier in the SAME stream
   * (e.g. "player #9 (red) booked at 34:00"). CPU embedding, sub-ms, bounded
   * top-k + char cap — never blocks the paid decision path (A5) and keeps the
   * per-decision token-cost increase bounded (A6). Returns the window text
   * alone when the store is empty (behavior identical to the pre-C baseline).
   */
  decideContextText(opts: { retrieverK?: number; retrieverMaxChars?: number } = {}): string {
    const windowText = this.windowFactsText();
    const prior = this.memory.retrievedContextText(windowText, opts.retrieverK, opts.retrieverMaxChars);
    if (!prior) return windowText;
    const header =
      "Prior long-horizon facts (earlier in this stream, retrieved by relevance) — corroborating context, verify against the current frames:\n";
    return windowText ? `${windowText}\n\n${header}${prior}` : `${header}${prior}`;
  }

  /** The stable entity identity dominant at time `ts` (plan §D): the largest
   * stable-entity track among the cached window frames nearest `ts`, or
   * undefined when no stable identity is present there (or window is empty).
   * Used to key a candidate/highlight to an entity for the arc. */
  resolveEntityAt(ts: number): string | undefined {
    let bestDiff = Infinity;
    let ref: string | undefined;
    for (const f of this.frames.values()) {
      const d = Math.abs(f.timestamp - ts);
      if (d >= bestDiff) continue;
      bestDiff = d;
      ref = undefined;
      if (f.findings && f.findings.tracks.length) {
        // Dominant (largest) track at the nearest frame -> its identity from
        // the registry. We use refOfTrack (not the surfaced entityRef) so a
        // confirmed-highlight event keys to its entity even when that entity is
        // young/transient and not yet surfaced to the general narrative window.
        const dom = f.findings.tracks.reduce((a, b) => (boxArea(b.bbox) > boxArea(a.bbox) ? b : a));
        ref = this.identity.refOfTrack(dom.trackId) ?? dom.entityRef;
      }
    }
    return ref;
  }

  /** Record a high-signal event against an entity for the run (plan §D, the arc
   * store). Salience-gated by the caller (we only call it from the confirmed-
   * highlight path). Bounded per entity so a long stream never grows unbounded. */
  recordEntityEvent(entityRef: string, ev: { ts: number; eventType: string; reason?: string }): void {
    const arr = this.entityEvents.get(entityRef) ?? [];
    arr.push({ ts: ev.ts, eventType: ev.eventType, reason: ev.reason });
    if (arr.length > 8) arr.shift();
    this.entityEvents.set(entityRef, arr);
  }

  /** Called when a highlight is CONFIRMED (decision.isHighlight & gate passed):
   * key the highlight to the dominant stable entity at `ts` and append it to
   * that entity's arc, so a later event on the SAME entity can reference it
   * (A4: the red card's prior context carries the earlier yellow booking). */
  recordHighlightEntity(ts: number, decision: { eventType?: string; reason?: string }): void {
    const ref = this.resolveEntityAt(ts);
    if (!ref) return;
    this.recordEntityEvent(ref, { ts, eventType: decision.eventType || "highlight", reason: decision.reason });
  }

  /** Bounded text of an entity's PRIOR salient events (events strictly before
   * `excludeTs`), oldest -> newest — the narrative arc the decide prompt gets so
   * a later event on the same entity references the earlier one (A4). "" when
   * the entity has no prior events or is unknown. */
  entityArcContext(entityRef: string, opts: { excludeTs?: number; maxChars?: number } = {}): string {
    const maxChars = opts.maxChars ?? 800;
    const excludeTs = opts.excludeTs ?? Infinity;
    const evs = (this.entityEvents.get(entityRef) ?? []).filter((e) => e.ts < excludeTs);
    const lines = evs.map((e) => `[t=${e.ts.toFixed(1)}s] ${e.eventType}${e.reason ? `: ${e.reason}` : ""}`);
    let text = lines.join("\n");
    if (text.length > maxChars) text = text.slice(0, maxChars) + "…";
    return text;
  }

  /** The narrative arc block for whatever entity is dominant at `ts`: the
   * candidate's entity's prior salient events, as bounded text. "" when no
   * stable entity / no prior events — behavior identical to the baseline. */
  entityArcContextForCandidate(ts: number): string {
    const ref = this.resolveEntityAt(ts);
    if (!ref) return "";
    return this.entityArcContext(ref, { excludeTs: ts });
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
  anchoredImage: string | undefined
): {
  gameHint: string;
  imageB64: string | undefined;
  frames?: { role: string; base64: string }[];
  audioB64?: string;
  priorContextText?: string;
} {
  const opts: {
    gameHint: string;
    imageB64: string | undefined;
    frames?: { role: string; base64: string }[];
    audioB64?: string;
    priorContextText?: string;
  } = {
    gameHint: cfg.gameHint,
    imageB64: anchoredImage,
  };
  // A2 + C: every decide call for an in-window candidate carries the current
  // 60 s window's facts PLUS a bounded block of retrieved long-horizon facts
  // from the in-memory vector store (plan §C/A3). Pure server assembly (cached
  // findings + CPU embedding), no re-analysis, bounded tokens. Included
  // unconditionally — live and detail-first alike. Empty when nothing to add.
  opts.priorContextText = shared.decideContextText();
  if (cfg.decideWindowN !== undefined) {
    opts.frames = shared.framesWindow();
    const audio = shared.audioClipB64();
    if (audio) opts.audioB64 = audio;
  }
  return opts;
}

/** Frame-count cap for the motion-aware confirmation burst tier, by path (E):
 * the detail-first / VOD pass allows the larger cap; the live baseline (no
 * decideWindowN) uses the smaller live cap. */
function burstCap(cfg: AnalyzerConfig): number {
  return cfg.decideWindowN !== undefined ? VOD_BURST_MAX : LIVE_BURST_MAX;
}

/** Result of a two-tier decide on one candidate (plan §E, ADAAAA-6030). */
export interface TieredDecision {
  /** The authoritative decision: the burst-confirmation verdict when a burst
   * tier ran, otherwise the coarse tier's verdict. */
  decision: DecisionResult;
  /** True when a dense burst confirmation call actually ran and its verdict is
   * authoritative. */
  ranBurst: boolean;
  /** True when a burst was ASSEMBLED (cached frames exist around T) even if the
   * confirmation call was skipped/failed and the coarse verdict was kept. */
  hadBurst: boolean;
}

/**
 * Run the two-tier decide for ONE candidate (plan §E): the coarse tier first —
 * the 60 s window context (priorContext + coarse frames/anchor) — then, only
 * when the coarse tier CONFIRMS a highlight (isHighlight), a motion-aware
 * confirmation tier that adds a dense `burstFrames[]` sequence around the
 * candidate moment to pin down the precise event time/type.
 *
 * A5: the burst tier never blocks the paid decision path. Burst assembly is a
 * pure in-memory pull from the cached 60 s window (sub-ms); if no cached frame
 * lies within the burst span the burst is skipped, and if the confirmation
 * call itself throws the coarse verdict is kept. Non-highlights pay exactly one
 * (coarse) decide call — the burst only ever runs on confirmed candidates.
 */
export async function decideWithTwoTiers(
  client: PipelineClient,
  cfg: AnalyzerConfig,
  shared: LiveRunShared,
  anchoredImage: string | undefined,
  candidate: {
    eventType: string;
    timestamp: number;
    audio?: AudioCandidate["audio"];
    ballVelocity?: { speedMps?: number };
    ballPossession?: { possessingPlayerId?: string };
  }
): Promise<TieredDecision> {
  const evidence = {
    eventType: candidate.eventType,
    trackCount: shared.evidence.trackCount,
    maxVelocity: shared.evidence.maxVelocity,
    ocrHits: 0,
    reaction: buildReactionEvidence(candidate, shared.evidence.trackCount),
  };
  const base = detailDecideOpts(cfg, shared, anchoredImage);
  // D (plan §D / A4): augment the window prior-context with the candidate
  // entity's PRIOR salient events from the run's arc store, so a later event on
  // the same entity (e.g. red card at T+30) explicitly carries the earlier one
  // (e.g. the yellow booking at T). Bounded; "" when none -> baseline unchanged.
  const arc = shared.entityArcContextForCandidate(candidate.timestamp);
  if (arc) {
    base.priorContextText = [base.priorContextText, `[entity arc] ${arc}`].filter(Boolean).join("\n");
  }
  const coarse = await client.decide(evidence, base);
  if (!coarse.isHighlight) return { decision: coarse, ranBurst: false, hadBurst: false };
  // Coarse tier CONFIRMED -> assemble the dense burst around T from the cache.
  const burst = shared.burstFrames(candidate.timestamp, { max: burstCap(cfg) });
  if (!burst.length) return { decision: coarse, ranBurst: false, hadBurst: false };
  const confirmOpts = { ...base, burstFrames: burst };
  let confirm: DecisionResult;
  try {
    confirm = await client.decide(evidence, confirmOpts);
  } catch {
    // A5: burst must never block the paid path — keep the coarse verdict.
    return { decision: coarse, ranBurst: false, hadBurst: true };
  }
  return { decision: confirm, ranBurst: true, hadBurst: true };
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
  candidate: { eventType: string; timestamp: number; seq?: number; audio?: AudioCandidate["audio"] },
  onEvent?: (ev: AnalyzeEvent) => void,
  emit?: { seq: number; timestamp: number }
): Promise<void> {
  const evSeq = emit?.seq ?? candidate.seq ?? 0;
  const evTs = emit?.timestamp ?? candidate.timestamp;
  onEvent?.({ seq: evSeq, timestamp: evTs, type: "candidate", candidate });
  const anchoredImage = shared.anchor(candidate.timestamp);
  // Cache the candidate (type + timestamp + reaction) into the 60 s window so
  // it participates in the window's factual context (plan §A / A2).
  shared.addCandidate({
    timestamp: candidate.timestamp,
    eventType: candidate.eventType,
    reaction: buildReactionEvidence(candidate, shared.evidence.trackCount),
  });
  // Two-tier decide (plan §E / ADAAAA-6030): coarse tier first, then a dense
  // burst confirmation tier ONLY for a confirmed candidate (A5 fallback keeps
  // the paid path alive). The authoritative decision feeds the gate + record.
  const { decision } = await decideWithTwoTiers(client, cfg, shared, anchoredImage, candidate);
  // Track the Stage-A FP-rate metric (INC-2 / ADAAAA-4325 slice 5): whether
  // Gemma accepted this audio-gate candidate as a highlight, plus the gate's
  // reported onset latency. Feeds job.stageAMetrics fpRate = rejected / total.
  shared.stageA.recordOutcome(decision.isHighlight, candidate.audio?.onsetLatencyS);
  if (!decision.isHighlight) return;
  // Grounded-evidence verification gate (plan G3 / ADAAAA-6028): only surface a
  // claimed highlight when the decision ties it to supporting vision evidence.
  const gate = applyGroundingGate(decision, candidate.eventType);
  if (!gate.accepted) {
    shared.groundingRejections += 1;
    onEvent?.({
      seq: evSeq,
      timestamp: evTs,
      type: "candidateBlocked",
      reason: `grounding gate: ${gate.reason}`,
    });
    return;
  }
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
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  shared.highlights.push(rec);
  // C — ingest the confirmed highlight into the long-horizon vector store so
  // later windows in the same stream can retrieve it as prior context (A3).
  ingestHighlightFact(shared, rec, decision);
  // D / A4: key the confirmed highlight to its dominant stable entity so a
  // later event on the SAME entity references it (the narrative arc).
  shared.recordHighlightEntity(candidate.timestamp, decision);
  onEvent?.({ seq: evSeq, timestamp: evTs, type: "highlight", highlight: rec });
}

/**
 * C — salience-gated ingestion into the per-stream in-memory vector store
 * (plan §C): a CONFIRMED highlight is a high-confidence fact and is embedded
 * so later windows in the same stream can retrieve it as prior context (A3,
 * the yellow→red narrative case). A bare audio-gate / low-score / non-salient
 * firing is never ingested — that is the noise trigger. Never throws (a memory
 * hiccup must not sink the paid path).
 */
function ingestHighlightFact(shared: LiveRunShared, rec: HighlightRecord, decision: DecisionResult): void {
  try {
    const entityRef = (decision.grounding?.objects ?? []).slice(0, 3).join(", ") || undefined;
    shared.memory.ingestIfSalient(
      {
        timestamp: rec.start,
        factText: `highlight ${rec.eventType}${rec.reason ? `: ${rec.reason}` : ""}${entityRef ? ` — ${entityRef}` : ""}`,
        type: "highlight",
        entityRef,
        eventType: rec.eventType,
      },
      { confirmed: true, score: rec.score, eventType: rec.eventType }
    );
  } catch {
    // ignore — memory must never block highlight creation
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
  shared_?: LiveRunShared
): Promise<AnalyzeOutcome> {
  const maxReReserves = cfg.maxReReserves ?? 3;
  const first = initialSession ?? (await client.reservePerceive());
  let sessionId = first.sessionId;
  // Every session we reserved (initial + any re-reserves) must be stopped /
  // un-paid in `finally`, even the ones go-livepeer already released (the
  // server-side released ones still hold a payment refiller in the adapter).
  const reserved = new Set<string>([first.sessionId]);
  // Live path shares frame window / evidence / highlights with the audio tap so
  // decide sees the anchored moment; VOD path gets a private namespace.
  const run = shared_ ?? new LiveRunShared();
  const evidence = run.evidence;
  const highlights = run.highlights;
  let framesAnalyzed = 0;
  try {
    for await (const frame of iterFrames) {
      framesAnalyzed++;
      run.addFrame(frame.seq, frame.timestamp, frame.imageB64);
      let res: ObservationResult;
      let reReserved = 0;
      // The perceive live-runner's health can flap mid-pass; go-livepeer then
      // marks it unavailable and releases all its sessions, so our next
      // /analyze returns 404 "runner not found". Re-reserve a fresh session
      // and retry this frame (the 404 frame was never processed) up to the
      // bounded cap, then surface the error cleanly.
      // Deliver the job's closed vocabulary (gameHint/preferLabels) on EVERY
      // /analyze (ADAAAA-4109): a fresh session — including one re-reserved
      // after a 404 session-lost — inherits the config the moment its first
      // frame runs, before resolve_vocabulary() gates the <OD> prompt.
      const vocab = { gameHint: cfg.gameHint, preferLabels: cfg.preferLabels, loraRef: cfg.loraRef };
      for (;;) {
        try {
          res = await client.analyze(sessionId, frame, vocab);
          break;
        } catch (err) {
          if (!(err instanceof SessionLostError)) throw err;
          if (reReserved >= maxReReserves) throw err;
          reReserved++;
          const fresh = await client.reservePerceive();
          sessionId = fresh.sessionId;
          reserved.add(fresh.sessionId);
        }
      }
      evidence.step(res.observation);
      onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "observation", observation: res.observation });
      // A1: cache this frame's already-computed findings (tracks/OCR/objects)
      // into the 60 s window. Reused by windowFactsText — never re-analyzed.
      run.setFindings(frame.seq, res.observation);
      if (res.candidate) {
        // Fold the candidate into the window's factual context (plan §A).
        run.addCandidate({ timestamp: res.candidate.timestamp, eventType: res.candidate.eventType });
        onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "candidate", candidate: res.candidate });

        // Send the ACTUAL candidate frame so the Gemma vision decide runner can
        // see the moment, plus the game hint. Evidence remains as context. The
        // candidate is ANCHORED at the peak-motion (strike) frame's timestamp,
        // so resolve that frame's image from the rolling window — a candidate
        // fired on the late post-strike frame must still be judged on the strike.
        const anchoredImage = run.anchor(res.candidate.timestamp) ?? frame.imageB64;
        // Two-tier decide (plan §E / ADAAAA-6030): coarse tier first, then a
        // dense burst confirmation tier ONLY for a confirmed candidate.
        const { decision } = await decideWithTwoTiers(client, cfg, run, anchoredImage, res.candidate);
        if (decision.isHighlight) {
          // Grounded-evidence verification gate (plan G3 / ADAAAA-6028).
          const gate = applyGroundingGate(decision, res.candidate.eventType);
          if (!gate.accepted) {
            run.groundingRejections += 1;
            onEvent?.({
              seq: frame.seq,
              timestamp: frame.timestamp,
              type: "candidateBlocked",
              reason: `grounding gate: ${gate.reason}`,
            });
          } else {
            const { clipId, clipUri } = await cut(res.candidate.timestamp);
            const rec: HighlightRecord = {
              id: randomUUID(),
              jobId: cfg.jobId,
              clipUri,
              start: Math.max(0, res.candidate.timestamp - cfg.clipBeforeS),
              end: res.candidate.timestamp + cfg.clipAfterS,
              eventType: decision.eventType,
              score: decision.score,
              reason: decision.reason,
              status: "pending",
              createdAt: new Date().toISOString(),
            };
            highlights.push(rec);
            // C — ingest the confirmed highlight into the long-horizon vector
            // store for later windows in the same stream (plan §C/A3).
            ingestHighlightFact(run, rec, decision);
            // D / A4: key this confirmed highlight to its dominant stable entity
            // so a later event on the SAME entity references it (the arc).
            run.recordHighlightEntity(res.candidate.timestamp, decision);
            onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "highlight", highlight: rec });
          }
        }
      }
    }
  } finally {
    // Stop / un-pay every session we reserved this pass. Sessions the server
    // already released are a no-op on the orchestrator but still drop their
    // adapter payment refiller, so stopping them is required to avoid leaks.
    for (const s of reserved) {
      await client.stopPerceive(s).catch(() => {});
    }
  }
  return { sessionId, highlights, framesAnalyzed, groundingRejections: run.groundingRejections };
}
