// Worker orchestration: one persistent perceive session per job, sample 1fps,
// feed frames to perceive, compute evidence, call decide on candidates, cut a
// clip on each highlight, and stop the session in `finally`.
import { randomUUID } from "node:crypto";
import type { HighlightRecord, TrackObservation } from "@highlights/events";
import { StageAMetrics } from "./stage-a-metrics";

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
export function buildReactionEvidence(
  candidate: {
    audio?: AudioCandidate["audio"];
    ballVelocity?: { speedMps?: number };
    ballPossession?: { possessingPlayerId?: string };
  },
  humansInMotion: number
): ReactionEvidence {
  return {
    crowdEnergy: candidate.audio?.peakEnergy ?? 0,
    audioKind: candidate.audio?.kind ?? "",
    humansInMotion,
    ballSpeedMps: candidate.ballVelocity?.speedMps ?? 0,
    ballPossessionId: candidate.ballPossession?.possessingPlayerId ?? "",
  };
}
export interface DecisionResult {
  isHighlight: boolean;
  score: number;
  eventType?: string;
  reason?: string;
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
    opts?: { gameHint?: string; preferLabels?: string[] }
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
    }
  ): Promise<DecisionResult>;
  stopPerceive(sessionId: string): Promise<void>;
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
    this.trackCount = obs.tracks.length;
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

function nearestFrameImage(
  window: Map<number, { timestamp: number; imageB64: string }>,
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
  private frames = new Map<number, { timestamp: number; imageB64: string }>();
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

  /** Record a sampled frame into the rolling anchor window. Ring size is the
   * decide window (legacy DECIDE_FRAME_WINDOW, or the detail-first knob). */
  addFrame(seq: number, timestamp: number, imageB64: string): void {
    this.frames.set(seq, { timestamp, imageB64 });
    if (this.frames.size > this.windowN) {
      const oldest = this.frames.keys().next().value;
      if (oldest !== undefined) this.frames.delete(oldest);
    }
  }
  /** Nearest sampled frame image to ``ts`` (for anchoring a candidate that
   * fired off-cycle, e.g. an audio onset between video samples), or undefined
   * when no frame is in the window yet. */
  anchor(timestamp: number): string | undefined {
    return nearestFrameImage(this.frames, timestamp);
  }
  /** The rolling frame window as decide() `frames[]` ImageRefs (detail-first:
   * the temporal SEQUENCE Gemma reasons across). Ordered oldest -> newest. */
  framesWindow(): { role: string; base64: string }[] {
    return [...this.frames.values()].map((f) => ({ role: "full", base64: f.imageB64 }));
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
): { gameHint: string; imageB64: string | undefined; frames?: { role: string; base64: string }[]; audioB64?: string } {
  const opts: { gameHint: string; imageB64: string | undefined; frames?: { role: string; base64: string }[]; audioB64?: string } = {
    gameHint: cfg.gameHint,
    imageB64: anchoredImage,
  };
  if (cfg.decideWindowN !== undefined) {
    opts.frames = shared.framesWindow();
    const audio = shared.audioClipB64();
    if (audio) opts.audioB64 = audio;
  }
  return opts;
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
  const decision = await client.decide(
    {
      eventType: candidate.eventType,
      trackCount: shared.evidence.trackCount,
      maxVelocity: shared.evidence.maxVelocity,
      ocrHits: 0,
      reaction: buildReactionEvidence(candidate, shared.evidence.trackCount),
    },
    detailDecideOpts(cfg, shared, anchoredImage)
  );
  // Track the Stage-A FP-rate metric (INC-2 / ADAAAA-4325 slice 5): whether
  // Gemma accepted this audio-gate candidate as a highlight, plus the gate's
  // reported onset latency. Feeds job.stageAMetrics fpRate = rejected / total.
  shared.stageA.recordOutcome(decision.isHighlight, candidate.audio?.onsetLatencyS);
  if (!decision.isHighlight) return;
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
      const vocab = { gameHint: cfg.gameHint, preferLabels: cfg.preferLabels };
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
      if (res.candidate) {
        onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "candidate", candidate: res.candidate });

        // Send the ACTUAL candidate frame so the Gemma vision decide runner can
        // see the moment, plus the game hint. Evidence remains as context. The
        // candidate is ANCHORED at the peak-motion (strike) frame's timestamp,
        // so resolve that frame's image from the rolling window — a candidate
        // fired on the late post-strike frame must still be judged on the strike.
        const anchoredImage = run.anchor(res.candidate.timestamp) ?? frame.imageB64;
        const decision = await client.decide(
          {
            eventType: res.candidate.eventType,
            trackCount: evidence.trackCount,
            maxVelocity: evidence.maxVelocity,
            ocrHits: 0,
            reaction: buildReactionEvidence(res.candidate, evidence.trackCount),
          },
          detailDecideOpts(cfg, run, anchoredImage)
        );
        if (decision.isHighlight) {
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
          onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "highlight", highlight: rec });
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
  return { sessionId, highlights, framesAnalyzed };
}
