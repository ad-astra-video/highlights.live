// ADAAAA-7699: candidate/trigger -> decide -> highlight wiring for the
// media-server (RTC / media rail).
//
// The browser screen-share rail is: browser -> media node (WebRTC) -> perceive
// runner -> the media node POSTs each observation to `/jobs/:id/observe`. Until
// this module the control plane only stepped evidence and fanned the
// observation to the live console: a live share produced observations and
// audio-gate triggers into nothing (measured 2026-11-01: 34 `source: browser`
// jobs, 0 highlights, 0 candidates, 0 decide calls).
//
// This module gives that rail the SAME decide observer the live RTMP rail uses:
//
//   media node observation (+ the decoded anchor JPEG it already holds)
//     -> LiveRunShared (frame + perceive-derived seed + retained audio)
//     -> LiveObserver   (cadence-bound decide, audio-trigger anchored windows)
//     -> onDecide       (the caller's gemma decide + accept/highlight path)
//
// Invariants this module exists to protect:
//
// - ONE decide budget. The observer spends one token per `cadenceS` of content
//   and an anchored (audio-triggered) fire spends the SAME budget, so the rail
//   can never decide more often than the blind-cadence baseline (AC-3) and one
//   audible event produces one anchored window (the trigger scheduler
//   coalesces re-fires).
// - NO extra GPU session. Deciding is a gemma call on frames the media node
//   already decoded and the perceive session it already paid for; this module
//   never reserves a session and never re-opens the stream to fetch pixels.
// - NO pixels, NO decide. A callback without the anchor frame is evidence only;
//   deciding blind (or re-fetching frames) is exactly what the design
//   constraint forbids.
// - Never block the media node. The observe POST returns immediately; deciding
//   runs on a serial chain so concurrent callbacks cannot double-fire the
//   cadence (LiveObserver's budget/last-fire state is not concurrent-safe).
// - Honest content clock. The media node's frame/audio timestamps are wall-clock
//   epoch seconds, while highlight clip windows are cut against the recording,
//   so everything handed downstream is rebased to the first sampled moment.
import {
  LiveObserver,
  LIVE_OBSERVE_WINDOW_S,
  LIVE_OBSERVE_MAX_FRAMES,
  LIVE_OBSERVE_LAG_BUDGET_S,
  OBSERVE_CADENCE_S,
  OBSERVE_CONTENT_FPS,
  GOAL_OUTCOMES,
  type ObserveDecidePayload,
  type PerFrameSeed,
  type PerFrameSignal,
  type SignalGateOptions,
} from "./observe-loop";
import { LiveRunShared, buildLiveObserveMetrics, seedSignalFromEvidence, type LiveObserveMetricsSnapshot } from "./analyzer";
import type { StageAOutcomeLedger } from "./stage-a-metrics";
import { audioTriggerFromCandidate, type AudioTriggerRecord } from "./audio-trigger";

/** The observation shape the media node relays (a perceive events-out step).
 *  `candidate` is optional: perceive publishes a candidate only on the frames
 *  it judged to be a trigger. */
export interface MediaRailObservation {
  seq?: number;
  /** Wall-clock epoch seconds (the media node's own frame clock). */
  timestamp?: number;
  tracks?: { trackId: string; label?: string; kind?: string; bbox?: number[] }[];
  objects?: { label: string; confidence?: number; bbox?: number[] }[];
  ocr?: string[];
  evidence?: PerFrameSignal;
  goalCrossed?: boolean;
  ballOutcome?: string;
  scoreBoardChanged?: boolean;
  candidate?: {
    eventType?: string;
    timestamp?: number;
    goalCrossed?: boolean;
    ballOutcome?: string;
    scoreBoardChanged?: boolean;
    audio?: unknown;
  };
}

export interface MediaRailObserverOptions {
  jobId: string;
  /** The caller's decide + accept wiring. Returns whether the moment became an
   *  accepted highlight (the observer records it for the cost report). */
  onDecide: (payload: ObserveDecidePayload) => Promise<boolean>;
  cadenceS?: number;
  windowS?: number;
  maxFrames?: number;
  fps?: number;
  signalGate?: boolean;
  signalGateOpts?: SignalGateOptions;
  /** Content-vs-wall lag above which a queued frame is dropped instead of
   *  decided late (ADAAAA-7676 rule, applied to the media rail). Default
   *  LIVE_OBSERVE_LAG_BUDGET_S (30 s). */
  lagBudgetS?: number;
  /** Seconds of tapped audio retained for the window-aligned ASR clip. */
  audioRetainS?: number;
  /** ADAAAA-7694: Stage-A outcome ledger fed by the audio tap, so every decided
   *  window records the verdict of the triggers whose onset it judged. */
  stageA?: StageAOutcomeLedger;
}

/** Build the per-frame seed context handed to the decide window from one
 *  relayed observation. Absent fields stay absent (no fabricated signal). */
export function seedFromObservation(ts: number, obs: MediaRailObservation): PerFrameSeed {
  const tracks = (obs.tracks ?? []).map((t) => ({ trackId: t.trackId, label: t.label ?? t.kind, bbox: t.bbox }));
  return {
    ts,
    tracks,
    objects: obs.objects,
    ocr: obs.ocr,
    // ADAAAA-7145: perceive's per-frame goal/ball signal evidence drives the
    // Tier-2 signal gate; absent evidence is recall-safe (never starves a goal).
    signal: seedSignalFromEvidence(obs.evidence),
  };
}

/** The observation-level goal attestation (scoreboard change / goal-line /
 *  goal-valued outcome) as a bias hint, or null when the frame attests nothing.
 *  Mirrors the live loop's fold so an attested goal is not downgraded for lack
 *  of an independent corroboration record (ADAAAA-7190). */
export function attestationFromObservation(
  obs: MediaRailObservation
): { goalCrossed?: boolean; ballOutcome?: string; scoreBoardChanged?: boolean } | null {
  const ev = obs.evidence;
  const att = {
    goalCrossed: obs.goalCrossed ?? ev?.goalCrossed,
    ballOutcome: obs.ballOutcome ?? ev?.ballOutcome,
    scoreBoardChanged: obs.scoreBoardChanged ?? ev?.scoreBoardChanged,
  };
  const attested =
    att.scoreBoardChanged === true ||
    att.goalCrossed === true ||
    (typeof att.ballOutcome === "string" && GOAL_OUTCOMES.has(att.ballOutcome));
  return attested ? att : null;
}

/** Per-share decide traffic the completion report reads. */
export interface MediaRailStats {
  /** Observations relayed by the media node (frames with pixels). */
  observations: number;
  /** Frames recorded into the decide window (== observations today). */
  frames: number;
  /** Audio PCM chunks fed into the retained window audio (ASR context). */
  audioChunks: number;
  /** Fired audio triggers accepted by the scheduler (one anchored window each). */
  triggers: number;
  /** Decide calls the observer actually issued. */
  decideCalls: number;
  /** Accepted highlights. */
  accepted: number;
  /** Anchored (trigger) fires vs blind-cadence fires. */
  triggerFires: number;
  cadenceFires: number;
  /** Windows dropped for exceeding the lag budget. */
  skippedStaleWindows: number;
  /** Wall seconds the rail was observed for (per-share cost reporting). */
  sessionSeconds: number;
  /** AC-1 measurement: content-time delay from a fired trigger's onset to the
   *  decide window that anchored it (ms), and its p50/p95/max. */
  anchoredLatencyMs: number[];
  anchoredLatencyP50Ms: number;
  anchoredLatencyP95Ms: number;
  anchoredLatencyMaxMs: number;
}

/**
 * Per-share decide observer for the media (RTC) rail. Feed it every relayed
 * observation (`onObservation`) and every relayed audio chunk / fired audio
 * candidate (`onAudioChunk` / `onAudioCandidate`); call `finish()` when the
 * share ends so the tail is decided once.
 */
export class MediaRailObserver {
  readonly run: LiveRunShared;
  private readonly live: LiveObserver;
  private readonly jobId: string;
  private readonly lagBudgetMs: number;
  /** Serial decide chain: LiveObserver state (budget / last-fire) is not
   *  concurrency-safe, and the media node fires one callback per frame. */
  private chain: Promise<void> = Promise.resolve();
  /** Wall-clock epoch seconds of the first sampled moment on this rail. Every
   *  timestamp handed downstream is rebased to it (0 = share start). */
  private originTs: number | null = null;
  private readonly startedAt = Date.now();
  private observations = 0;
  private frames = 0;
  private audioChunks = 0;
  private triggers = 0;
  /** Onset (content seconds) of the newest trigger queued for an anchored fire. */
  private lastQueuedTriggerOnset: number | null = null;
  /** Measured onset -> anchored decide window delays (ms, content clock). */
  private anchoredLatencies: number[] = [];
  private closed = false;
  private flushing = false;

  constructor(opts: MediaRailObserverOptions, run?: LiveRunShared) {
    this.jobId = opts.jobId;
    this.lagBudgetMs = Math.max(0, (opts.lagBudgetS ?? LIVE_OBSERVE_LAG_BUDGET_S) * 1000);
    this.run = run ?? new LiveRunShared({ audioRetainS: opts.audioRetainS });
    this.live = new LiveObserver({
      cadenceS: opts.cadenceS ?? OBSERVE_CADENCE_S,
      windowS: opts.windowS ?? LIVE_OBSERVE_WINDOW_S,
      maxFrames: opts.maxFrames ?? LIVE_OBSERVE_MAX_FRAMES,
      fps: opts.fps ?? OBSERVE_CONTENT_FPS,
      signalGate: opts.signalGate ?? false,
      signalGateOpts: opts.signalGateOpts,
      onDecide: opts.onDecide,
      stageA: opts.stageA,
    });
  }

  /** Rebase one wall-clock timestamp onto this share's content clock. */
  private contentTs(rawTs: number): number {
    if (this.originTs === null) this.originTs = rawTs;
    else if (rawTs < this.originTs && this.frames === 0 && this.audioChunks === 0) this.originTs = rawTs;
    return Math.max(0, rawTs - this.originTs);
  }

  /** The share's content-clock origin (wall-clock epoch seconds). */
  contentOrigin(): number | null {
    return this.originTs;
  }

  /**
   * One observation relayed from the media node, with the anchor JPEG it held
   * at publish time. Records the frame + seed context, folds candidate /
   * attestation hints, drains queued audio triggers (one anchored window each)
   * and schedules the cadence/anchored decide. Returns immediately — the decide
   * runs on the serial chain.
   */
  onObservation(obs: MediaRailObservation, frameB64: string | undefined): void {
    if (this.closed) return;
    // NO pixels, NO decide. The media node always has the decoded JPEG at
    // publish time; without it this observation is evidence only (deciding
    // blind or re-fetching frames is forbidden by the design constraint).
    if (!frameB64 || typeof frameB64 !== "string") return;
    const rawTs = Number(obs?.timestamp);
    if (!Number.isFinite(rawTs)) return;
    const ts = this.contentTs(rawTs);
    const seq = Number.isFinite(Number(obs?.seq)) ? Number(obs?.seq) : this.observations;
    this.observations++;
    this.frames++;
    this.run.addFrame(seq, ts, frameB64);
    // Cache the already-computed findings for the window-facts/seeds path. The
    // media node relays whatever perceive emitted, so normalize the arrays (a
    // frame with no detections is an explicit empty finding, never fabricated).
    this.run.setFindings(seq, {
      tracks: (obs.tracks ?? []) as any,
      objects: (obs.objects ?? []).filter((o) => Array.isArray(o.bbox)) as any,
      ocr: obs.ocr ?? [],
    });
    this.live.record(ts, frameB64, seedFromObservation(ts, obs));

    const att = attestationFromObservation(obs);
    if (att) this.live.addHint(obs.candidate?.eventType || "SPORTING_EVENT", ts, att);
    if (obs.candidate) {
      this.run.addCandidate({ timestamp: ts, eventType: obs.candidate.eventType ?? "SPORTING_EVENT" });
      this.live.addHint(obs.candidate.eventType ?? "SPORTING_EVENT", ts, {
        goalCrossed: obs.candidate.goalCrossed,
        ballOutcome: obs.candidate.ballOutcome,
        scoreBoardChanged: obs.candidate.scoreBoardChanged,
      });
    }
    // ADAAAA-7658: audio triggers recorded by the /audio rail become anchored
    // windows here — one analysis per trigger, coalesced inside the scheduler.
    for (const trig of this.run.takeAudioTriggers()) {
      const onset = this.contentTs(trig.onsetTs);
      const fired = this.contentTs(trig.firedAt);
      if (!this.live.recordTrigger({ ...trig, onsetTs: onset, firedAt: Math.max(onset, fired) })) continue;
      this.live.addHint(`AUDIO_${trig.kind.toUpperCase()}`, onset);
      this.triggers++;
      this.lastQueuedTriggerOnset = onset;
    }

    // ADAAAA-7676: a frame whose content time is already far behind the wall
    // clock cannot be decided "live" any more — drop it (and advance the
    // cadence clock) instead of growing an unbounded decide backlog.
    const lagMs = Math.max(0, Date.now() - rawTs * 1000);
    const stale = lagMs > this.lagBudgetMs;
    this.enqueue(async () => {
      if (stale) {
        this.live.noteStaleFrame(ts, lagMs / 1000);
        return;
      }
      const triggerFiresBefore = this.live.triggerFireCount();
      await this.live.maybeFire(ts, false, lagMs);
      // AC-1 measurement: if THAT tick anchored the queued trigger, the delay
      // from the trigger onset to the decide window is the latency budget the
      // acceptance criterion names (content clock ~= wall clock on a live rail).
      if (this.live.triggerFireCount() > triggerFiresBefore && this.lastQueuedTriggerOnset !== null) {
        const sample = this.live.lastSample();
        if (sample) this.anchoredLatencies.push(Math.max(0, Math.round((sample.centerTs - this.lastQueuedTriggerOnset) * 1000)));
        this.lastQueuedTriggerOnset = null;
      }
    });
  }

  /** One ~100 ms mono int16 PCM chunk from the media-edge audio relay. Buffered
   *  so an anchored/cadence window carries its own audio for ASR context
   *  (GEMMA_SEND_AUDIO=0: audio reaches gemma as text). */
  onAudioChunk(rawTs: number, samples: string): void {
    if (this.closed) return;
    if (!samples || !Number.isFinite(rawTs)) return;
    this.audioChunks++;
    this.run.addAudioChunk(this.contentTs(rawTs), samples);
  }

  /** A fired Stage-A audio candidate (perceive's `candidate.audio`). Queued as a
   *  trigger anchor; the next relayed observation drains it into the observer. */
  onAudioCandidate(candidate: { audio?: unknown } | undefined | null): AudioTriggerRecord | null {
    if (this.closed) return null;
    const trig = audioTriggerFromCandidate(candidate as any);
    if (!trig) return null;
    this.run.recordAudioTrigger(trig);
    return trig;
  }

  /** Decide the tail once and wait for every scheduled decide to settle.
   *  Idempotent: a second call (client /stop and the media session-close
   *  callback can race) just awaits the same chain. */
  async finish(): Promise<void> {
    if (!this.flushing && this.frames > 0) {
      this.flushing = true;
      this.enqueue(async () => {
        await this.live.flush();
      });
    }
    this.closed = true;
    await this.chain.catch(() => {});
    // Per-share evidence line: the deployment proof (AC-1/AC-3) reads this from
    // `docker logs highlights-server` alongside the job's persisted counters.
    const s = this.stats();
    // eslint-disable-next-line no-console
    console.log(
      `[media-rail:${this.jobId}] decided frames=${s.frames} audioChunks=${s.audioChunks} triggers=${s.triggers} ` +
        `decideCalls=${s.decideCalls} triggerFires=${s.triggerFires} cadenceFires=${s.cadenceFires} ` +
        `accepted=${s.accepted} triggerLatencyP50=${s.anchoredLatencyP50Ms}ms p95=${s.anchoredLatencyP95Ms}ms`
    );
  }

  private enqueue(step: () => Promise<void>): void {
    this.chain = this.chain
      .then(step)
      .catch((e: any) => console.error(`[media-rail:${this.jobId}] decide failed:`, String(e?.message || e)));
  }

  /** The job-visible observe snapshot (decideCalls / latency / anchored vs
   *  cadence fires), read at share end. */
  observeMetrics(): LiveObserveMetricsSnapshot {
    return buildLiveObserveMetrics(this.live);
  }

  stats(): MediaRailStats {
    const sorted = [...this.anchoredLatencies].sort((a, b) => a - b);
    const pct = (p: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
    return {
      observations: this.observations,
      frames: this.frames,
      audioChunks: this.audioChunks,
      triggers: this.triggers,
      decideCalls: this.live.decideCalls(),
      accepted: this.live.acceptedCount(),
      triggerFires: this.live.triggerFireCount(),
      cadenceFires: this.live.cadenceFireCount(),
      skippedStaleWindows: this.live.skippedStaleWindowCount(),
      sessionSeconds: Number(((Date.now() - this.startedAt) / 1000).toFixed(1)),
      anchoredLatencyMs: [...sorted],
      anchoredLatencyP50Ms: pct(50),
      anchoredLatencyP95Ms: pct(95),
      anchoredLatencyMaxMs: sorted.length ? sorted[sorted.length - 1] : 0,
    };
  }
}
