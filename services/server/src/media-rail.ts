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
  percentile,
  type ObserveDecidePayload,
  type PerFrameSeed,
  type PerFrameSignal,
  type SignalGateOptions,
  type TriggerFamilyLatency,
} from "./observe-loop";
import { LiveRunShared, buildLiveObserveMetrics, seedSignalFromEvidence, type LiveObserveMetricsSnapshot } from "./analyzer";
import type { StageAOutcomeLedger } from "./stage-a-metrics";
import { liveDecideAdmission } from "./live-decide-admission";
import {
  audioTriggerFromCandidate,
  isStageBTrigger,
  triggerFamily,
  type AudioTriggerRecord,
  type TriggerSchedulerStats,
} from "./audio-trigger";

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
  /** ADAAAA-7799 (lever C): decide-rate cap for this rail — drop every Nth
   *  decide opportunity on a fixed stride (N >= 2). Undefined = off. */
  decideSkipEvery?: number;
  /** Content-vs-wall lag above which a queued frame is dropped instead of
   *  decided late (ADAAAA-7676 rule, applied to the media rail). Default
   *  LIVE_OBSERVE_LAG_BUDGET_S (30 s). */
  lagBudgetS?: number;
  /** Seconds of tapped audio retained for the window-aligned ASR clip. */
  audioRetainS?: number;
  /** ADAAAA-7694: Stage-A outcome ledger fed by the audio tap, so every decided
   *  window records the verdict of the triggers whose onset it judged. */
  stageA?: StageAOutcomeLedger;
  /** ADAAAA-7734: called ONCE per ACCEPTED relayed frame, in order, with the
   *  frame's dense global seq + content timestamp. The caller persists the JPEG
   *  and its observation row from here (queued I/O — this callback must stay
   *  cheap: it runs on the media node's observe path). */
  onFrame?: (frame: {
    seq: number;
    timestamp: number;
    frameB64: string;
    observation: MediaRailObservation;
  }) => void;
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

/** The smallest plausible epoch-second content clock (1970-01-12). Anything
 *  below this is not a wall-clock timestamp and must never set the rail's
 *  content origin. */
export const MIN_EPOCH_SECONDS = 1_000_000;

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
  /** ADAAAA-7723 AC-1: accepted triggers in the Stage-A (roar/swell) family. */
  stageATriggers: number;
  /** ADAAAA-7723 AC-1: accepted triggers in the Stage-B (whistle) family. */
  stageBTriggers: number;
  /** ADAAAA-7723 AC-1: the trigger ledger. `accepted === fired + covered +
   *  expired + pending` is the invariant; a share where `triggers (accepted)`
   *  outnumbers these buckets dropped a trigger silently. */
  triggerWindows: TriggerSchedulerStats;
  /** ADAAAA-7723 AC-1: whether {@link triggerWindows} balances. */
  triggersReconciled: boolean;
  /** ADAAAA-7723 AC-2: onset -> judging-window latency PER family, split into
   *  anchored windows (`samples`/`p50Ms`), covered triggers (`covered*`) and the
   *  pooled `judged*` total. */
  triggerLatencyByFamily: TriggerFamilyLatency[];
  /** Decide calls the observer actually issued. */
  decideCalls: number;
  /** Accepted highlights. */
  accepted: number;
  /** Anchored (trigger) fires vs blind-cadence fires. */
  triggerFires: number;
  cadenceFires: number;
  /** Windows dropped for exceeding the lag budget. */
  skippedStaleWindows: number;
  /** Observations ignored because their timestamp was not an epoch-second
   *  content clock (a client that does not stamp its frames). Evidence-only:
   *  deciding on a frame whose clock we cannot trust would date every window
   *  against 1970 (ADAAAA-7699). */
  clockRejected: number;
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
  /** ADAAAA-7734: per-frame persistence hook (see options). */
  private readonly onFrame?: MediaRailObserverOptions["onFrame"];
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
  /** ADAAAA-7723: accepted triggers per family (a whistle and a roar in the
   *  same celebration are separate evidence, so the counts are separate too). */
  private stageATriggers = 0;
  private stageBTriggers = 0;
  /** Observations dropped for carrying a non-epoch timestamp clock. */
  private clockRejected = 0;
  private closed = false;
  private flushing = false;

  constructor(opts: MediaRailObserverOptions, run?: LiveRunShared) {
    this.jobId = opts.jobId;
    this.onFrame = opts.onFrame;
    this.lagBudgetMs = Math.max(0, (opts.lagBudgetS ?? LIVE_OBSERVE_LAG_BUDGET_S) * 1000);
    this.run = run ?? new LiveRunShared({ audioRetainS: opts.audioRetainS });
    this.live = new LiveObserver({
      cadenceS: opts.cadenceS ?? OBSERVE_CADENCE_S,
      windowS: opts.windowS ?? LIVE_OBSERVE_WINDOW_S,
      maxFrames: opts.maxFrames ?? LIVE_OBSERVE_MAX_FRAMES,
      fps: opts.fps ?? OBSERVE_CONTENT_FPS,
      signalGate: opts.signalGate ?? false,
      signalGateOpts: opts.signalGateOpts,
      decideSkipEvery: opts.decideSkipEvery,
      onDecide: opts.onDecide,
      stageA: opts.stageA,
      // ADAAAA-7722: give the media rail the Stage-B (whistle) ledger too, so a
      // whistle-anchored decide on this rail is judged in its OWN family ledger
      // and `stageAMetrics` stays whistle-free here as well.
      stageB: this.run.stageBOutcomes,
      // ADAAAA-7758: the browser rail shares the SAME process-wide live decide
      // slot as the rtmp/file-sim rail, so a screen share can never interleave
      // decides with another live job and stretch both past the budget.
      canDecide: () => liveDecideAdmission.admit(this.jobId),
    });
  }

  /** Rebase one wall-clock timestamp onto this share's content clock. */
  private contentTs(rawTs: number): number {
    if (this.originTs === null) this.originTs = rawTs;
    else if (rawTs < this.originTs && this.frames === 0 && this.audioChunks === 0) this.originTs = rawTs;
    return Math.max(0, rawTs - this.originTs);
  }

  /** Count and (once) surface a relayed observation whose timestamp is not an
   *  epoch-second clock, so a mis-stamping media node is diagnosable from the
   *  server log instead of reading as "0 decides for no reason". */
  private rejectClock(rawTs: number): void {
    if (this.clockRejected++ === 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[media-rail:${this.jobId}] observation timestamp ${rawTs} is not an epoch-second content clock; ` +
          `frame is evidence-only (the media node must stamp the frame it decoded)`
      );
    }
  }

  /** The share's content-clock origin (wall-clock epoch seconds). */
  contentOrigin(): number | null {
    return this.originTs;
  }

  /** ADAAAA-7734: frames ACCEPTED onto this rail (the number the job reports as
   *  `framesAnalyzed`, and the count the writer must persist). */
  frameCount(): number {
    return this.frames;
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
    // The rail's content clock is wall-clock epoch seconds and every window,
    // clip boundary and lag measurement is dated off the FIRST timestamp seen.
    // A relayed observation with 0/absent timestamps would pin that origin at
    // 1970, so the lag gate then reads every frame as decades stale, drops all
    // of them and only the finish()-tail decide ever fires. Reject an
    // implausible clock (evidence-only, the same rule as a missing frame)
    // rather than silently poisoning the whole share.
    if (rawTs < MIN_EPOCH_SECONDS) {
      this.rejectClock(rawTs);
      return;
    }
    const ts = this.contentTs(rawTs);
    // ADAAAA-7734: the rail allocates a DENSE global position for every accepted
    // frame (0,1,2,...) instead of trusting the media node's own seq. The frame
    // file name, the observation row and the decide note's `analysis.frames[]`
    // ref all key on this position, so `GET /jobs/<id>/frames/<seq>` can never
    // render frame M for tile N when the relay skips a seq (a dropped POST, a
    // mid-share media-node restart, or a rejected clock).
    const seq = this.frames;
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
    // `seq` rides the recorded frame so the decide window can name the frame
    // files it actually saw (the analysis refs persisted on the decide note).
    this.live.record(ts, frameB64, seedFromObservation(ts, obs), seq);
    // ADAAAA-7734: hand the accepted frame to the caller's persistence hook.
    // Cheap by contract (queued disk I/O) — the observe POST is already answered.
    this.onFrame?.({ seq, timestamp: ts, frameB64, observation: obs });

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
      // ADAAAA-7723: the onset->window latency is measured by the OBSERVER, in
      // the window that actually anchored the trigger (per family). The rail no
      // longer guesses it from "the newest drained onset vs the next fire",
      // which mis-paired whenever a batch of triggers arrived at one frame.
      if (isStageBTrigger(trig.thresholdId)) this.stageBTriggers++;
      else this.stageATriggers++;
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
      await this.live.maybeFire(ts, false, lagMs);
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
    // ADAAAA-7758: the share is over — give the live decide slot back (the tail
    // decide above already ran while the share still held it).
    liveDecideAdmission.release(this.jobId);
    // Per-share evidence line: the deployment proof (AC-1/AC-2/AC-3) reads this
    // from `docker logs highlights-server` alongside the job's persisted
    // counters. ADAAAA-7723 adds the trigger LEDGER and the per-family latency,
    // so "triggers=N but only one decide was anchored" is no longer a silent
    // discrepancy: the buckets must sum to `triggers`.
    const s = this.stats();
    const tw = s.triggerWindows;
    // eslint-disable-next-line no-console
    console.log(
      `[media-rail:${this.jobId}] decided frames=${s.frames} audioChunks=${s.audioChunks} triggers=${s.triggers} ` +
        `stageA=${s.stageATriggers} stageB=${s.stageBTriggers} ` +
        `decideCalls=${s.decideCalls} triggerFires=${s.triggerFires} cadenceFires=${s.cadenceFires} ` +
        `accepted=${s.accepted} clockRejected=${s.clockRejected} ` +
        `triggerWindows accepted=${tw.accepted} coalesced=${tw.coalesced} covered=${tw.covered} ` +
        `expired=${tw.expired ?? 0} fired=${tw.fired} pending=${tw.pending ?? 0} invalid=${tw.invalid} ` +
        `reconciled=${s.triggersReconciled} ` +
        `triggerLatency p50=${s.anchoredLatencyP50Ms}ms p95=${s.anchoredLatencyP95Ms}ms ` +
        s.triggerLatencyByFamily
          .map(
            (f) =>
              `${f.family}(anchored n=${f.samples} p50=${f.p50Ms}ms p95=${f.p95Ms}ms, ` +
              `covered n=${f.coveredSamples} p50=${f.coveredP50Ms}ms p95=${f.coveredP95Ms}ms, ` +
              `judged n=${f.judgedSamples} p50=${f.judgedP50Ms}ms p95=${f.judgedP95Ms}ms)`
          )
          .join(" ")
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
    const sorted = [...this.live.anchoredLatencySamples()].sort((a, b) => a - b);
    const tw = this.live.triggerStats();
    const recon = this.live.triggerReconciliation();
    return {
      observations: this.observations,
      frames: this.frames,
      audioChunks: this.audioChunks,
      triggers: this.triggers,
      stageATriggers: this.stageATriggers,
      stageBTriggers: this.stageBTriggers,
      triggerWindows: tw,
      triggersReconciled: recon.ok,
      triggerLatencyByFamily: this.live.anchoredLatencyByFamilyStats(),
      decideCalls: this.live.decideCalls(),
      accepted: this.live.acceptedCount(),
      triggerFires: this.live.triggerFireCount(),
      cadenceFires: this.live.cadenceFireCount(),
      skippedStaleWindows: this.live.skippedStaleWindowCount(),
      clockRejected: this.clockRejected,
      sessionSeconds: Number(((Date.now() - this.startedAt) / 1000).toFixed(1)),
      anchoredLatencyMs: [...sorted],
      anchoredLatencyP50Ms: percentile(sorted, 50),
      anchoredLatencyP95Ms: percentile(sorted, 95),
      anchoredLatencyMaxMs: sorted.length ? sorted[sorted.length - 1] : 0,
    };
  }
}
