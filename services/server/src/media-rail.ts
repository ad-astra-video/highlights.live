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
  type StagedObserveDecide,
  type TriggerFamilyLatency,
} from "./observe-loop";
import { decideStageRecorder } from "./decide-stage-timings";
import {
  LiveRunShared,
  buildLiveObserveMetrics,
  withDecideAdmissionMetrics,
  seedSignalFromEvidence,
  scoreboardDeltaLegible,
  type DecideCapacityLatch,
  type LiveObserveMetricsSnapshot,
  type ScoreboardDeltaEvidence,
} from "./analyzer";
import type { StageAOutcomeLedger } from "./stage-a-metrics";
import type { LiveConsumeEvidence } from "./live-progress";
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
  /** ADAAAA-8395 (LFR-1 AC-5): the perceive runner's bounded ROI second pass for
   *  this frame — fires (>=1 inferred cropped tile), the tile inferences behind
   *  them, and the gate the runner resolved. Additive: absent on a runner that
   *  does not report the pass, so an old relay is byte-identical. */
  roiPasses?: number;
  roiTiles?: number;
  roiEnabled?: boolean;
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
   *  accepted highlight (the observer records it for the cost report). Required
   *  on the serial path; with {@link onDecideStaged} the two-phase fork owns both
   *  halves instead (ADAAAA-7987). */
  onDecide?: (payload: ObserveDecidePayload) => Promise<boolean>;
  cadenceS?: number;
  windowS?: number;
  maxFrames?: number;
  /** ADAAAA-8513 (AC3): the configured confirm-dive cap this rail's run uses,
   *  so its published `diveBudget.cap` matches the pump's admission. */
  liveConfirmMaxDivesPer300S?: number;
  /** The rail's INGEST/sample clock (the cadence the media node samples at and
   *  the clock this rail persists + cuts clips on). ADAAAA-8102: this is NOT the
   *  analysis rate any more — use {@link contentFps} for that. */
  fps?: number;
  /** ADAAAA-8102: the CONTENT consume rate this rail ANALYSES at, in frames per
   *  content second, wired from `LIVE_OBSERVE_CONTENT_FPS`.
   *
   *  Before this the only rate the rail knew was the ingest clock, so it consumed
   *  (recorded + decide-seeded + persisted) every relayed frame: a measured
   *  funded share analysed 833 frames / 300 s (2.78 fps) while
   *  `LIVE_OBSERVE_CONTENT_FPS=4` was boot-verified, and every one of those
   *  frames is blocking GPU work on a rail that cannot decide faster than the
   *  cadence. The rail now consumes on the CONTENT clock — one frame per
   *  `1/contentFps` content seconds, the same Bresenham credit the analyzer live
   *  pass uses (ADAAAA-7774/7795) — while `fps`/`sampleFps` stays the ingest
   *  clock that still governs persistence and the clip cut.
   *
   *  Undefined (the shipped default) or `<= 0` keeps the pre-8102 behaviour
   *  exactly: every relayed frame is consumed, no stride block is published, so
   *  merging this change moves nothing on a running box. */
  contentFps?: number;
  signalGate?: boolean;
  signalGateOpts?: SignalGateOptions;
  /** ADAAAA-7799 (lever C): decide-rate cap for this rail — keep only a
   *  fraction (0 < r < 1) of the decide opportunities. Undefined = off.
   *  ADAAAA-8431: the fraction is resolved into charged decides per 300 s of
   *  SERVED clock, so this knob binds the RATE, not a share of this rail's
   *  opportunity count. */
  decideKeepRatio?: number;
  /** ADAAAA-8431: the SERVED clock the decide-rate budget accrues on (epoch ms).
   *  Defaults to `Date.now`; tests inject a simulated clock. */
  wallClock?: () => number;
  /** ADAAAA-8108 (AC-E3): the enrichment arm for this rail — `on` (default) sends
   *  the per-window `perceiveTimeline`, `off` omits it, `alternate` alternates per
   *  DECIDED window in content order starting OFF. Undefined = the shipped `on`,
   *  so an unset knob leaves the rail byte-identical. */
  enrichment?: "on" | "off" | "alternate";
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
  /** ADAAAA-7987: how many decide windows may be IN FLIGHT at once on this
   *  rail — wired from `LIVE_OBSERVE_IN_FLIGHT` (default 4 on the box, 1 =
   *  serial). Before this the media rail constructed its `LiveObserver` with
   *  only `onDecide`, so every browser/RTMP share decided strictly one window at
   *  a time (`observeMetrics.maxDecideInFlight = 0`) while 4 decide slots sat
   *  idle: a ~4 s decide against a ~3.9 s cadence can never cover the cadence,
   *  so the delivery lag sat at a constant 15-17 s. */
  maxInFlight?: number;
  /** ADAAAA-7987: the box's decide admission width (`DECIDE_CONCURRENCY`). The
   *  depth above is a SHARED budget: each live stream gets
   *  `floor(admission / activeLiveStreams)`, clamped to `maxInFlight`, so two
   *  concurrent shares split the slots instead of oversubscribing them.
   *  ADAAAA-8437: pass a GETTER to follow the DISCOVERED effective capacity
   *  (the fleet advertises 6 on the routed 5090 set) instead of the static
   *  funded number, so the depth grows with the fleet mid-run. */
  decideAdmission?: number | (() => number);
  /** ADAAAA-8504: the admission snapshot this share STARTED under, latched once
   *  by the caller (which primes the probe and stamps `at`). The rail folds it
   *  into `observeMetrics.decideCapacity` at share end, so the capacity condition
   *  is gradeable from the stored record instead of the `[decide-capacity]` log
   *  line. Absent (an older caller / a rail built in a test) leaves the record
   *  byte-identical — an unrecorded posture stays absent, never 0. */
  decideCapacityLatch?: () => DecideCapacityLatch | undefined;
  /** ADAAAA-7987: the two-phase decide fork (`decide()` may run K-wide,
   *  `accept()` always in CONTENT order), so the media rail pipelines exactly
   *  like the analyzer live-observe path (ADAAAA-7771/7878). */
  onDecideStaged?: (payload: ObserveDecidePayload) => StagedObserveDecide;
  /** ADAAAA-7987: `OBSERVE_DECIDE_OFFLOOP=0` keeps the serial in-chain decide at
   *  depth 1 — byte-identical to the pre-7987 media rail. Default ON. */
  observeDecideOffLoop?: boolean;
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
): {
  goalCrossed?: boolean;
  ballOutcome?: string;
  scoreBoardChanged?: boolean;
  scoreBoardDelta?: ScoreboardDeltaEvidence;
} | null {
  const ev = obs.evidence;
  // ADAAAA-7844: carry the measured, legible scoreboard delta (wire name
  // `scoreboardDelta` on the observation) so the window attestation can be
  // credited and labelled on a real measurement rather than a bare flag.
  const measuredDelta = (obs as any).scoreboardDelta ?? (ev as any)?.scoreboardDelta;
  const att = {
    goalCrossed: obs.goalCrossed ?? ev?.goalCrossed,
    ballOutcome: obs.ballOutcome ?? ev?.ballOutcome,
    scoreBoardChanged: obs.scoreBoardChanged ?? ev?.scoreBoardChanged,
    scoreBoardDelta: scoreboardDeltaLegible(measuredDelta) ? measuredDelta : undefined,
  };
  const attested =
    att.scoreBoardChanged === true ||
    att.goalCrossed === true ||
    (typeof att.ballOutcome === "string" && GOAL_OUTCOMES.has(att.ballOutcome));
  return attested ? att : null;
}

/** ADAAAA-8102: upper bound on the media rail's content-credit accumulator. The
 *  relay hands out one frame per message, so a credit above a few frames can
 *  never be spent on frames that are not there; this is a sanity bound, not a
 *  rate. (The analyzer pass keeps its own `LIVE_STRIDE_CREDIT_CAP` = 2, which is
 *  calibrated for its dense ingest — see `takeContentCredit` for the 51.6 s of
 *  content time that cap discarded on the first media-rail leg.) */
export const LIVE_MEDIA_STRIDE_CREDIT_MAX = 30;

/** The smallest plausible epoch-second content clock (1970-01-12). Anything
 *  below this is not a wall-clock timestamp and must never set the rail's
 *  content origin. */
export const MIN_EPOCH_SECONDS = 1_000_000;

/** ADAAAA-8419: how many skipped content timestamps the rail keeps in memory so
 *  the window audit can name the frames the consume stride refused. Bounded ring
 *  (the newest wins): a strided frame never had a stored JPEG and the evidence is
 *  display-only audit context, so nothing is persisted and no DB column is added. */
export const SKIPPED_FRAME_TS_RING_CAP = 240;

/** Per-share decide traffic the completion report reads. */
export interface MediaRailStats {
  /** Observations relayed by the media node (frames with pixels). */
  observations: number;
  /** ADAAAA-8069: published-frame clocks the media node reported — every frame
   *  it put on the video-in rail, with or without a perceive observation. This
   *  is the window's observation-set source on the RTC arm. */
  frameTicks: number;
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
  /** ADAAAA-8069: published-frame ticks the media node reported (the rail's
   *  own decode clock, with or without an observation/image). */
  private frameTicks = 0;
  /** ADAAAA-8102: the CONTENT consume rate (frames per content second) this rail
   *  analyses at. 0 = no stride (every relayed frame is consumed), which is the
   *  shipped behaviour until `LIVE_OBSERVE_CONTENT_FPS` is configured. */
  private readonly contentFps: number;
  /** ADAAAA-8102: Bresenham stride credit in frames — accrued at `contentFps` per
   *  content second, one consumed frame debits 1.0. Same accumulator the analyzer
   *  live pass uses (ADAAAA-7774/7795), so both rails converge on the SAME rate:
   *  a hard floor on frame spacing cannot (2.78 fps ingest + a 1 s floor reads as
   *  0.93 fps, outside AC-8101-2's 280-320 / 300 s). */
  private strideCredit = 1;
  private strideCreditTs: number | null = null;
  /** ADAAAA-8102 (leg `b8fb4aa4`): the content-clock bucket the observation set
   *  last took a record from. The stride above recovers banked credit in a
   *  burst after a relay gap, so a 7 s span could take 10 records (measured:
   *  3 gap-free spans read 10 on the funded 1 fps leg, AC-8101-5 wants 7-9).
   *  The CONSUMED/analysed frames are unchanged — only the window's timed
   *  observation set is bucketed, at most one record per `1/contentFps`. */
  private lastObsBucket: number | null = null;
  /** ADAAAA-8102: stride evidence — frames the ingest offered vs frames the
   *  content clock skipped. Published as `observeMetrics.perceive`. */
  private framesSeen = 0;
  private framesStrided = 0;
  /** ADAAAA-8419: content ts of the frames the stride refused, newest-in ring
   *  (cap `SKIPPED_FRAME_TS_RING_CAP`). Display evidence for the window audit
   *  only — no image bytes, no `seq`, nothing persisted. */
  private skippedTs: number[] = [];
  /** ADAAAA-8395 (LFR-1 AC-5): the perceive runner's bounded ROI-pass fires,
   *  summed over the frames this rail CONSUMED (a strided/evidence-only relay is
   *  not in the analysed set, so `roiPasses <= framesAnalyzed` holds by
   *  construction). `roiSeen` flips once an observation reports the field, so a
   *  media node/perceive pair that predates the instrument leaves the perceive
   *  block byte-identical instead of publishing an invented zero. */
  private roiPasses = 0;
  private roiTiles = 0;
  private roiSeen = false;
  private roiEnabled = false;
  /** ADAAAA-8121: the CONSUME CLOCK in content seconds. `lastConsumedTs` is the
   *  newest frame this rail ANALYSED (the position the live indicator names on a
   *  stored record) and `lastSeenTs` the newest frame the relay DELIVERED,
   *  strided frames included (the live edge the delay is measured against).
   *  Both are content timestamps — never frame counts — so the derived delay is
   *  the same at 1 fps and at 2 fps. 0 = nothing observed yet. */
  private lastConsumedTs = 0;
  private lastSeenTs = 0;
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
  /** ADAAAA-7987: whether this rail runs the pipelined (staged) decide fork. */
  private readonly pipelined: boolean;
  /** ADAAAA-8504: the admission snapshot this share latched at its start. */
  private readonly decideCapacityLatch?: () => DecideCapacityLatch | undefined;

  constructor(opts: MediaRailObserverOptions, run?: LiveRunShared) {
    this.jobId = opts.jobId;
    this.onFrame = opts.onFrame;
    this.decideCapacityLatch = opts.decideCapacityLatch;
    this.lagBudgetMs = Math.max(0, (opts.lagBudgetS ?? LIVE_OBSERVE_LAG_BUDGET_S) * 1000);
    // ADAAAA-8102: the CONTENT consume rate, separate from the ingest clock
    // (`opts.fps` = `sampleFps`, still the persistence/clip-cut clock). A
    // configured value feeds BOTH the consume stride below and the window's
    // image grid, so the rail analyses ~`contentFps` frames per content second.
    // Undefined/`<= 0` leaves the rail exactly as shipped: no stride, and the
    // window grid keeps the caller's ingest `fps`.
    const configuredContentFps = Number(opts.contentFps);
    this.contentFps =
      opts.contentFps !== undefined && Number.isFinite(configuredContentFps) && configuredContentFps > 0
        ? configuredContentFps
        : 0;
    // ADAAAA-8005 (gate 3): the run carries the per-row trigger -> delivered
    // collector, so the rail's persisted rows report the AC's number and the
    // media-rail job record carries it under `observeMetrics.deliveredLatency`.
    this.run = run ?? new LiveRunShared({
      audioRetainS: opts.audioRetainS,
      jobId: opts.jobId,
      liveConfirmMaxDivesPer300S: opts.liveConfirmMaxDivesPer300S,
    });
    // ADAAAA-7987: pipeline the decide pass exactly like the analyzer
    // live-observe path (ADAAAA-7771 depth + ADAAAA-7878 off-loop issue). The
    // media rail used to hand `LiveObserver` only `onDecide`, so the serial path
    // ran one decide at a time (`maxDecideInFlight = 0`) and the cadence could
    // never be held once a decide cost more than a cadence period. Depth is the
    // SHARED budget (`floor(admission / activeLiveStreams)`), so a second share
    // halves it instead of oversubscribing the decide gate.
    const inFlight = Math.max(1, Math.floor(opts.maxInFlight ?? 1));
    // ADAAAA-8437: the depth budget follows the DISCOVERED effective capacity
    // when the caller passes a getter, so a probe landing mid-run widens the
    // pass immediately.
    const admission = () =>
      Math.max(
        1,
        Math.floor(
          (typeof opts.decideAdmission === "function" ? opts.decideAdmission() : opts.decideAdmission) ?? 2,
        ),
      );
    const staged =
      opts.onDecideStaged && ((opts.observeDecideOffLoop ?? true) || inFlight > 1) ? opts.onDecideStaged : null;
    this.pipelined = !!staged;
    // Only a pipelined rail takes part in the cross-stream depth sharing (a
    // serial rail holds no extra slot, so counting it would starve the others).
    if (staged && inFlight > 1) liveDecideAdmission.registerLiveJob(this.jobId);
    this.live = new LiveObserver({
      cadenceS: opts.cadenceS ?? OBSERVE_CADENCE_S,
      windowS: opts.windowS ?? LIVE_OBSERVE_WINDOW_S,
      maxFrames: opts.maxFrames ?? LIVE_OBSERVE_MAX_FRAMES,
      // ADAAAA-8102: the window's image grid resolves onto the CONTENT consume
      // rate when one is configured, so a 7 s window carries ~7 grid points (and
      // ~7 timeline records) instead of ~21 ingest-clock points thinned into 4
      // images. Unset keeps the caller's ingest `fps` — byte-identical to the
      // shipped rail — and `<= 0` (documented stride opt-out) keeps it too.
      fps: this.contentFps > 0 ? this.contentFps : opts.fps ?? OBSERVE_CONTENT_FPS,
      // ADAAAA-8102 (leg `b8fb4aa4`): with a content rate the window's timed
      // observation set resolves onto that grid, so a post-gap credit burst
      // cannot stack two records inside one content tick (10 records/7 s span).
      ...(this.contentFps > 0 ? { observationFps: this.contentFps } : {}),
      signalGate: opts.signalGate ?? false,
      signalGateOpts: opts.signalGateOpts,
      decideKeepRatio: opts.decideKeepRatio,
      ...(opts.wallClock ? { wallClock: opts.wallClock } : {}),
      // ADAAAA-8108 (AC-E3): the enrichment arm, so the OFF arm is reachable on
      // the media rail the 7 s / 5 s cell is graded on. Undefined = shipped `on`.
      enrichment: opts.enrichment,
      onDecide: opts.onDecide,
      ...(staged
        ? {
            maxInFlight: inFlight,
            ...(inFlight > 1
              ? { depthBudget: () => liveDecideAdmission.depthFor(this.jobId, inFlight, admission()) }
              : {}),
            onDecideStaged: staged,
          }
        : {}),
      stageA: opts.stageA,
      // ADAAAA-7722: give the media rail the Stage-B (whistle) ledger too, so a
      // whistle-anchored decide on this rail is judged in its OWN family ledger
      // and `stageAMetrics` stays whistle-free here as well.
      stageB: this.run.stageBOutcomes,
      // ADAAAA-8005 (gate 3): per-row trigger -> delivered metric (see
      // `LiveDeliveryTracker`). Fed by the accept drain, completed by the
      // server's persist path.
      delivery: this.run.delivery,
      // ADAAAA-7758: the browser rail shares the SAME process-wide live decide
      // slot as the rtmp/file-sim rail, so a screen share can never interleave
      // decides with another live job and stretch both past the budget.
      canDecide: () => liveDecideAdmission.admit(this.jobId),
    });
  }

  /** ADAAAA-7987: give back the shared depth registration WITHOUT spending a
   *  tail decide — for a share that ended as a failure (its media session is
   *  gone, so there is nothing left to decide on). A leaked registration would
   *  shrink every later live stream's depth (`floor(admission / activeJobs)`). */
  release(): void {
    if (this.closed) return;
    this.closed = true;
    liveDecideAdmission.releaseLiveJob(this.jobId);
  }

  /** ADAAAA-7987: whether this rail runs the pipelined (staged) decide fork —
   *  the wiring the box's `observeMetrics.maxDecideInFlight` reads (a serial
   *  rail can never show depth > 0). */
  isPipelined(): boolean {
    return this.pipelined;
  }

  /** ADAAAA-7987: the in-flight decide depth this rail may use right now (the
   *  shared decide budget clamped to `maxInFlight`; 1 = serial). */
  currentDepthBudget(): number {
    return this.live.currentDepthBudget();
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
   * ADAAAA-8250: the consume/stride evidence this rail has accumulated SO FAR —
   * the same block {@link observeMetrics} publishes into the job record at share
   * end, readable MID-SHARE so the customer's analyse-position chip can name the
   * stride count while the share is still in flight (the stored record carries
   * no `perceive` block until completion, and the chip hides itself afterwards).
   *
   * Reads the counters already kept for the terminal snapshot — no new meter, no
   * inference call. `null` when no content rate is configured (`contentFps` unset
   * = no stride ran), which keeps the shipped record byte-identical and lets the
   * chip degrade to "no stride data" honestly. Counts are counts; the only
   * timestamps are the rail's own content clocks, so a strided frame can never be
   * read back as a position (AC-3 of ADAAAA-8121 stays true).
   */
  liveConsumeEvidence(): LiveConsumeEvidence | null {
    if (this.contentFps <= 0) return null;
    return {
      framesSeen: this.framesSeen,
      framesAnalyzed: this.frames,
      framesStrided: this.framesStrided,
      analysisFps: this.contentFps,
      // ADAAAA-8419: the frames the consume gate refused, as content ts — the
      // window audit renders one greyed tile per entry inside its window. A copy
      // so the caller can never mutate the rail's ring.
      skippedTimestamps: [...this.skippedTs].sort((a, b) => a - b),
      analysedThroughTs: Number(this.lastConsumedTs.toFixed(3)),
      tapThroughTs: Number(this.lastSeenTs.toFixed(3)),
    };
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
    // NO pixels, NO decide. The media node always has the decoded JPEG at
    // publish time; without it this observation is evidence only (deciding
    // blind or re-fetching frames is forbidden by the design constraint).
    //
    // ADAAAA-8069: evidence-only still means it IS an observation inside the
    // window span, so it joins the window's observation set (the perceive
    // timeline) while staying out of the image set — no decide frame, no
    // cadence/anchor change, no budget token.
    if (!frameB64 || typeof frameB64 !== "string") {
      const ts = this.contentTs(rawTs);
      // ADAAAA-8121: an evidence-only frame still reached the TAP, so it moves
      // the live edge's content clock (it is never the analysed position).
      if (ts > this.lastSeenTs) this.lastSeenTs = ts;
      // Evidence-only: the observation's findings still belong on the timeline.
      this.live.recordObservation(ts, seedFromObservation(ts, obs));
      return;
    }
    const ts = this.contentTs(rawTs);
    // ADAAAA-8121: every relayed frame moves the tap clock before the stride can
    // refuse it — the strided frames ARE content the live edge already holds.
    if (ts > this.lastSeenTs) this.lastSeenTs = ts;
    // ADAAAA-8102: consume at the CONTENT rate, not the ingest rate. The media
    // node relays every frame it sampled (~2.8 fps on the funded share); the rail
    // used to record, seed and persist all of them — 833 frames / 300 s on job
    // `8024a341` — which is blocking GPU work the decide cadence can never use
    // and the "cannot keep up with realtime" the board saw. A frame the content
    // clock refuses is skipped entirely (not recorded, not seeded, not persisted,
    // matching the analyzer live pass's stride), so the CONSUMED count converges
    // on `contentFps` at any ingest rate. The ingest clock still governs the
    // clip cut (`noteBrowserContentTs` on the tick path) and the cadence.
    this.framesSeen++;
    if (this.contentFps > 0 && !this.takeContentCredit(ts)) {
      this.framesStrided++;
      // ADAAAA-8419: keep the refused frame's content ts (bounded, newest wins)
      // so the window audit can list it as a greyed `skipped` tile.
      this.skippedTs.push(ts);
      const overflow = this.skippedTs.length - SKIPPED_FRAME_TS_RING_CAP;
      if (overflow > 0) this.skippedTs.splice(0, overflow);
      return;
    }
    // ADAAAA-7734: the rail allocates a DENSE global position for every accepted
    // frame (0,1,2,...) instead of trusting the media node's own seq. The frame
    // file name, the observation row and the decide note's `analysis.frames[]`
    // ref all key on this position, so `GET /jobs/<id>/frames/<seq>` can never
    // render frame M for tile N when the relay skips a seq (a dropped POST, a
    // mid-share media-node restart, or a rejected clock).
    const seq = this.frames;
    this.observations++;
    this.frames++;
    // ADAAAA-8395 (LFR-1 AC-5): fold this CONSUMED frame's ROI-pass fires into
    // the rail counters. Only consumed frames count, so `roiPasses <=
    // framesAnalyzed` holds on the stored record; a relay that does not report
    // the field leaves `roiSeen` alone (old media node -> absent, never zero).
    if (typeof obs.roiPasses === "number" && Number.isFinite(obs.roiPasses)) {
      this.roiSeen = true;
      this.roiPasses += Math.max(0, Math.floor(obs.roiPasses));
      this.roiTiles += Math.max(0, Math.floor(Number(obs.roiTiles) || 0));
      if (obs.roiEnabled === true) this.roiEnabled = true;
    }
    // ADAAAA-8121: this frame was CONSUMED (analysed) — the content position the
    // live indicator names. Strided frames never reach here.
    if (ts > this.lastConsumedTs) this.lastConsumedTs = ts;
    this.run.addFrame(seq, ts, frameB64);
    // Cache the already-computed findings for the window-facts/seeds path. The
    // media node relays whatever perceive emitted, so normalize the arrays (a
    // frame with no detections is an explicit empty finding, never fabricated).
    this.run.setFindings(seq, {
      tracks: (obs.tracks ?? []) as any,
      objects: (obs.objects ?? []).filter((o) => Array.isArray(o.bbox)) as any,
      ocr: obs.ocr ?? [],
    });
    // ADAAAA-8102: at a content consume rate the window's observation set IS the
    // consume set — one timeline record per content second. A consumed frame
    // therefore joins the observation set here, so the 1 fps cell reads ~7
    // records per 7 s span (AC-8101-5). Without this the set was the published
    // tick clock alone (~2/s) and read 20 records/span on funded leg 977294d7.
    // Bucketed on the content clock: after a relay gap the stride spends banked
    // credit in a burst, and one record per consumed frame put 10 records in a
    // 7 s span (leg b8fb4aa4); the burst still analyses, it just cannot stack
    // records inside `1/contentFps`.
    if (this.contentFps > 0) {
      const obsBucket = Math.floor(ts * this.contentFps);
      if (obsBucket !== this.lastObsBucket) {
        this.lastObsBucket = obsBucket;
        this.live.recordObservation(ts);
      }
    }
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
        scoreBoardDelta: att?.scoreBoardDelta,
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

  /**
   * ADAAAA-8431: anchor the decide-rate credit clock at the SERVED window's open
   * (the media session handshake). A browser share's session opens ~30 s before
   * the publisher's first frame, so this head banks one decide's worth of credit
   * per ~4.5 served seconds and is spent once content arrives — that is what
   * holds the charged rate at 66 per SERVED 300 s (the §1 denominator) instead of
   * 66 per content 300 s. Idempotent: a reconnecting share must not re-anchor.
   */
  noteServedClockStart(nowMs: number = Date.now()): void {
    this.live.startDecideRateClock(nowMs);
  }

  /**
   * ADAAAA-8069: one PUBLISHED frame clock from the media node — a frame it put
   * on the video-in rail whether or not the perceive runner ever observed it.
   *
   * This is the RTC arm's observation-set source. The runner fast-forwards (a
   * measured share published 848 frames but produced ~93 observations), so
   * sourcing the window's observation set from delivered observations put the
   * perceive timeline back onto the image set. A tick carries only a clock: it
   * never becomes a decide frame (no pixels, no decide), never fires the
   * cadence, and never spends a budget token.
   */
  onFrameTick(rawTs: number): void {
    if (this.closed) return;
    if (!Number.isFinite(rawTs)) return;
    if (rawTs < MIN_EPOCH_SECONDS) {
      this.rejectClock(rawTs);
      return;
    }
    this.frameTicks++;
    // ADAAAA-8102: a content-rate rail takes its timeline from the frames it
    // CONSUMED, so the published clock only advances the clip clock (the
    // `/media/frames` route calls `noteBrowserContentTs`). Adding it here too
    // stacks ~2 ticks/s on top of ~1 consumed frame/s — the 20 records/span
    // measured on funded leg 977294d7. Unset (the shipped default) keeps the
    // ADAAAA-8069 behaviour exactly: the tick IS the observation set.
    if (this.contentFps > 0) return;
    this.live.recordObservation(this.contentTs(rawTs));
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
    // ADAAAA-7987: ...and drop out of the cross-stream depth sharing, so this
    // finished share cannot keep shrinking another live stream's depth.
    liveDecideAdmission.releaseLiveJob(this.jobId);
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
        // ADAAAA-7987: the pipelining proof on the per-share evidence line —
        // `maxInFlight=1` would mean this share still decided serially.
        `maxDecideInFlight=${this.live.maxInFlightDepth()} depthBudget=${this.live.currentDepthBudget()} ` +
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

  /**
   * ADAAAA-8102: the content-clock consume gate (Bresenham credit, the analyzer
   * live pass's accumulator from ADAAAA-7774/7795). Credit accrues at
   * `contentFps` per content second and one consumed frame debits 1.0, so the
   * consumed count converges on the configured rate at ANY ingest rate — the
   * first frame of the share is always consumed (nothing to bank yet) and a
   * refused frame is skipped entirely.
   */
  private takeContentCredit(ts: number): boolean {
    if (this.strideCreditTs === null) {
      this.strideCreditTs = ts;
      this.strideCredit = 1;
    } else {
      const dt = ts - this.strideCreditTs;
      if (dt > 0) {
        // ADAAAA-8102: NOT clamped to the analyzer pass's `LIVE_STRIDE_CREDIT_CAP`
        // (2). That cap assumes a DENSE ingest, where a lag spike must not let a
        // burst of ingested frames be consumed at once. This rail receives at most
        // ONE frame per relay message, so an accrued credit can never consume more
        // frames than actually arrived — and clamping it silently DROPS content
        // time. Measured on leg `95622028` (300 s at 1 fps): the relay delivered
        // 27 bursts with gaps up to 4.94 s, the 2-frame cap discarded 51.6 s of
        // credit, and the rail consumed 243 frames instead of ~295 (AC-8101-2's
        // band is 280-320). Bounded far above any real burst instead.
        this.strideCredit = Math.min(LIVE_MEDIA_STRIDE_CREDIT_MAX, this.strideCredit + dt * this.contentFps);
        this.strideCreditTs = ts;
      }
    }
    if (this.strideCredit < 1 - 1e-9) return false;
    this.strideCredit -= 1;
    return true;
  }

  /** The job-visible observe snapshot (decideCalls / latency / anchored vs
   *  cadence fires), read at share end. */
  observeMetrics(): LiveObserveMetricsSnapshot {
    // ADAAAA-8205: the async confirm lane's meter rides the run, exactly like the
    // analyzer pass's snapshot, so a media-rail share's `costUsd` is derivable
    // from its record (decideFee * (decideCalls + confirmCalls) + perceive).
    //
    // ADAAAA-8504: the capacity snapshot this share started under is folded here
    // too. Before this, a browser/RTMP share (which decides through the SHARED
    // server gate) never published `decideCapacity` at all — the analyzer live
    // pass did — so the pre-registered capacity condition had to be graded off a
    // rotating `[decide-capacity]` log line. Only the capacity is folded: this
    // rail owns no per-job admission COUNTERS (the gate's baseline belongs to
    // whichever pass called `beginDecideJob`), and inventing zeros for them would
    // read as "measured" rather than "not recorded".
    const metrics = withDecideAdmissionMetrics(
      buildLiveObserveMetrics(
        this.live,
        undefined,
        {
          calls: this.run.confirmDiveCalls(),
          dives: this.run.confirmDiveCount(),
          dropped: this.run.confirmDiveDropped(),
          // ADAAAA-8513 (AC3/AC4): the same per-cause + admission block the
          // analyzer pass publishes, so a media-rail share's row carries it too.
          byReason: this.run.confirmDroppedByReason(),
          budget: this.run.confirmDiveBudget(),
        },
        // ADAAAA-8344: the adapter's per-job decide-stage summary, read at share
        // end like the decide counters. Absent when no decide was instrumented.
        decideStageRecorder.summary(this.jobId)
      ),
      undefined,
      this.decideCapacityLatch?.()
    );
    // ADAAAA-8102: prove the consume rate from the JOB RECORD, not from
    // `printenv`. Before this the media rail published no `perceive` block at all
    // (it was documented as "absent when the pass ran no stride — e.g. the
    // media-rail share"), so a funded leg could not tell a rail consuming at the
    // ingest rate from one consuming at the configured content rate. Published
    // only when a stride actually ran, so the unset default stays byte-identical
    // to the shipped record. `perceiveCalls` = `framesSeen` because perceive for
    // this rail runs in the MEDIA NODE (one call per relayed frame) — stated
    // explicitly by `perceiveSource`.
    // ADAAAA-8395 (LFR-1 AC-5): a stride-less rail still publishes no perceive
    // block (the shipped record is unchanged) UNLESS the perceive runner reported
    // the ROI pass — that counter must stay gradeable on a rail with no content
    // stride, and `analysisFps: 0` states plainly that no stride ran.
    if (this.contentFps <= 0 && !this.roiSeen) return metrics;
    return {
      ...metrics,
      perceive: {
        framesSeen: this.framesSeen,
        framesAnalyzed: this.frames,
        framesStrided: this.framesStrided,
        perceiveCalls: this.framesSeen,
        perceiveSkipped: 0,
        perceiveHotCalls: 0,
        analysisFps: this.contentFps,
        perceiveSource: "media_node",
        // ADAAAA-8121: the consume clock on the CONTENT axis, so a stored record
        // still says where the analysis got to and how far the tap ran ahead of
        // it — the two numbers the live indicator reads, both content ts.
        analysedThroughTs: Number(this.lastConsumedTs.toFixed(3)),
        tapThroughTs: Number(this.lastSeenTs.toFixed(3)),
        // ADAAAA-8395 (LFR-1 AC-5): the bounded ROI second pass, summed over the
        // frames this rail CONSUMED (roiPasses <= framesAnalyzed). Additive: the
        // four keys appear only once the relay reports the pass, so a rail fed by
        // a pre-instrument media node publishes the exact block it does today.
        ...(this.roiSeen
          ? {
              roiPasses: this.roiPasses,
              roiTiles: this.roiTiles,
              roiEnabled: this.roiEnabled,
              roiPassesPerAnalysedFrame:
                this.frames > 0 ? Number((this.roiPasses / this.frames).toFixed(4)) : 0,
            }
          : {}),
      },
    };
  }

  stats(): MediaRailStats {
    const sorted = [...this.live.anchoredLatencySamples()].sort((a, b) => a - b);
    const tw = this.live.triggerStats();
    const recon = this.live.triggerReconciliation();
    return {
      observations: this.observations,
      frameTicks: this.frameTicks,
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
