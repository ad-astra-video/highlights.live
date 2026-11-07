import path from "node:path";
import type { GoalLineCalibration } from "./analyzer";
import { parsePerceiveCalibration, type PerceiveCalibrationMap } from "./perceive-calibration";
import { resolveExportTokenSecret } from "./export-token";
import { LIVE_OBSERVE_LAG_BUDGET_S, resolveDecideImageBudget } from "./observe-loop";

export interface ServerConfig {
  port: number;
  /** "production" | "development" | "test" (alias of NODE_ENV). Used as the
   * server-side env gate that keeps dev-only surfaces (e.g. the /dev/billing
   * wireframe simulator) unreachable in prod even if their env flag is
   * accidentally set. */
  nodeEnv: string;
  /** Orchestrator public URL (offchain lab) or gateway URL. */
  orchestratorUrl: string;
  /** When set, bypass the orchestrator and call runners directly (dev). */
  perceiveUrl?: string;
  /** ADAAAA-7642: base URL of the perceive RUNNER (`perceive:8080`) used ONLY to
   * drop a session from the runner's own registry on stop. Distinct from
   * `perceiveUrl`, which switches the whole pipeline to the direct/no-orchestrator
   * adapter — setting that one would bypass Livepeer payment, so the runner
   * close needs its own knob. Unset = skip the extra close (orchestrator mode's
   * previous behaviour). */
  perceiveRunnerUrl?: string;
  decideUrl?: string;
  /** ADAAAA-7855: cheap CPU ASR base URL (POST {asrUrl}/transcribe) used by the
   * match-context resolver's ONE bounded commentary probe per VOD job. It is the
   * same service the decide path already uses (`ASR_URL`, `http://asr:8082` on
   * the hl network). Unset => the ASR source is `not_captured` and the resolver
   * runs on scorebug OCR + metadata only (never a fabricated team). */
  asrUrl?: string;
  /** ADAAAA-7855: enable the once-per-VOD-job match-context resolver.
   * `MATCH_CONTEXT=0` is the config-only rollback: no transcript probe, no
   * perceive resolve call, no `matchContext` write (pre-feature behaviour). */
  matchContext: boolean;
  /** Commentary probe length in seconds (MATCH_CONTEXT_ASR_SECONDS, default 90).
   * Bounded on purpose: the probe is flat per job, never proportional to
   * runtime. */
  matchContextAsrSeconds: number;
  /** Hard cap on the decoded prefix bytes (MATCH_CONTEXT_ASR_MAX_BYTES). */
  matchContextAsrMaxBytes: number;
  /** ADAAAA-6911 + ADAAAA-8254: the FUNDED decide ceiling (`DECIDE_CONCURRENCY`)
   * — the value that WINS. Left unset -> the client keeps its default (decide
   * runner capacity 2). ADAAAA-7773: docker-compose ships
   * `DECIDE_CONCURRENCY=${DECIDE_CONCURRENCY:-8}` because the box has 8 real
   * decide slots (4 per gemma card behind decide-router).
   *
   * ADAAAA-8254: the livepeer-session gate admits
   * `min(decideConcurrency, discovered decide capacity)` clamped to [1,
   * decideConcurrency], refreshed at job start and at most every
   * `DECIDE_CAPACITY_REFRESH_S`. Discovered capacity can only LOWER admission —
   * the 8/2/2 advertisement must never raise it past the funded 8 (CEO ruling
   * ADAAAA-7803). Set to 1 to reproduce the capacity-1 serial baseline. */
  decideConcurrency?: number;
  /** ADAAAA-8254: minimum seconds between signer capacity probes
   * (`DECIDE_CAPACITY_REFRESH_S`, default 60). A probe also runs at every decide
   * job start. */
  decideCapacityRefreshS?: number;
  /** ADAAAA-8254: hard per-decide queue-wait budget in ms
   * (`DECIDE_QUEUE_MAX_WAIT_MS`, default 60 000) before the decide is dropped
   * with a typed DecideCapacityError. */
  decideQueueMaxWaitMs?: number;
  /** ADAAAA-8254: discovery toggle (`DECIDE_CAPACITY_DISCOVERY`). Default on;
   * `0`/`false`/`off`/`no` disables the capacity probe entirely, which is the
   * byte-identical pre-8254 static gate. With no signer configured the probe is
   * never attached regardless. */
  decideCapacityDiscovery?: boolean;
  /** When set, bypass the orchestrator and call the train runner directly (dev).
   * No train container ships with the local stack today, so this stays unset
   * and direct train calls fail with a clear error until a TRAIN_URL is wired. */
  trainUrl?: string;
  /** Media server (gateway terminus + payer) base URL. When set, browser media
   * frames route browser -> media-server WS -> orchestrator video-in instead of
   * the server's /jobs/:id/ingest HTTP rail. */
  mediaServerUrl?: string;
  /** Public media origin (scheme + host, e.g. `https://highlights-media.dpn.gg`)
   * the BROWSER reaches for WebRTC screen-share signaling. The docker-internal
   * `mediaServerUrl` (`media:4070`) is what the control plane uses to provision
   * and health-check a media node, but a browser cannot resolve that service
   * name, so this public LB origin (`MEDIA_PUBLIC_BASE_URL`) is handed to the
   * webapp as the browser-facing `mediaOrigin`. Unset -> fall back to
   * `mediaServerUrl` (local/dev, no LB). ADAAAA-7286. */
  mediaPublicBaseUrl?: string;
  /** Bearer token the media node requires on `GET /node` (per-session lease
   * detail). Must equal the media service's `MEDIA_HEALTH_TOKEN`. Unset => the
   * control plane only proxies the public counts-only `/health`, and the console
   * shows capacity/load without per-session rows. ADAAAA-6869 Phase 4. */
  mediaHealthToken?: string;
  /** go-livepeer remote signer base URL (on-chain). Internal-only on Railway. */
  signerUrl?: string;
  /** Shared bearer token the remote signer requires (sealed SIGNER_AUTH_TOKEN).
   * Sent as `Authorization: Bearer <token>` on every signer signing call; the
   * signer rejects unauthenticated requests, so without it the server can't
   * obtain a valid Livepeer-Payment ticket and go-livepeer returns
   * `402 invalid live runner payment signer address` (ADAAAA-3250). */
  signerAuthToken?: string;
  /** Payer EVM address (the remote signer's account) advertised on the
   * orchestrator reserve. On-chain only; live AND VOD submissions pass it so
   * the orchestrator's payment validation sees a valid signer address. */
  payerAddress?: string;
  /** Where VOD sources + clips live. */
  dataDir: string;
  /** In-container path prefix at which the perceive runner sees this server's
   * dataDir (shared volume). Used to hand perceive the per-JOB recorded stream
   * so its persistent session SAM-tracker opens THAT clip (tracking across the
   * whole stream), rather than a server-side path perceive can't read. */
  perceiveClipRoot: string;
  /** Hard cap (bytes) for a single browser VOD upload. Default 4 GB
   * (`VOD_MAX_UPLOAD_BYTES`, default `4294967296`). The server rejects any
   * multipart upload larger than this with 413 before any compute is queued;
   * the webapp mirrors it as a client-side pre-check. Raised from 2 GB to 4 GB
   * by explicit CEO request (ADAAAA-7835), superseding the "keep at 2 GB" note
   * from ADAAAA-2983. Raising it increases the billed Livepeer GPU time a
   * single job can consume (cost scales with video duration), so price the
   * ceiling before raising it again. */
  vodMaxUploadBytes: number;
  /** Chunk size (bytes) for the resumable VOD upload rail. The deployed app is
   * reached through a Cloudflare proxy/tunnel whose free plan caps each proxied
   * request body at ~100 MB (ADAAAA-5704), so a single >100 MB upload is
   * rejected by Cloudflare's own 413 before the origin. The webapp slices large
   * files into `vodChunkBytes` parts, each well under the edge cap (64 MiB
   * leaves headroom for multipart/header overhead), and posts them through
   * /jobs/upload/:uploadId/chunk; the server reassembles into the same staged
   * file the single-shot rail produces. 0 disables chunking. */
  vodChunkBytes: number;
  ffmpegPath: string;
  gameHintDefault: string;
  /** Target window (seconds) around the flagged event for a delivered highlight
   * clip. cutClip trims `[event - clipBeforeS, event + clipAfterS]`, so the
   * total delivered clip is `clipBeforeS + clipAfterS` seconds centered on the
   * event. ADAAAA-5059: defaults were 4/4 (an 8s window that read as the whole
   * segment); reduced to 2/2 (4s, "the moment") — short enough to read as the
   * flagged moment while keeping pre-roll context and post-roll reaction.
   * Tunable per-deployment via CLIP_BEFORE_S / CLIP_AFTER_S. ADAAAA-7232:
   * defaults raised to 7/8 (a 15 s window) so the delivered clip is >=15 s and
   * the localized highlight lands mid-clip. */
  clipBeforeS: number;
  clipAfterS: number;
  /** Hard floor (seconds) on the delivered highlight clip length (ADAAAA-7232).
   * Guarantees Acc-1 (>=15 s) even if CLIP_BEFORE_S/CLIP_AFTER_S are tuned
   * shorter via env: `clipWindow` pads the AFTER side so the window is always
   * at least `clipWindowMinSec` long. */
  clipWindowMinSec: number;
  /** Seconds between frames when the perceive runner's capability can't be
   * queried (orchestrator mode); with PERCEIVE_URL set the runner's measured
   * sample_interval_s is used instead. */
  sampleIntervalSec: number;
  /** Default VOD source sampling rate (frames/second). ADAAAA-5059: raised to
   * 5 (from the previous 1 fps fallback) so a brief high-value moment (a soccer
   * goal) is sampled densely enough to fire a candidate; still bounded above by
   * `vodSampleMaxFps` (8) and overridable per job. */
  vodSampleFpsDefault: number;
  /** Hard ceiling on VOD source sampling (frames/second) when the perceive
   * runner reports it can sustain more than `sampleIntervalSec`. ADAAAA-3726:
   * VOD sampling was previously hard-capped at 1 fps regardless of device,
   * which starved the tracker and decide of enough frames to catch a brief
   * moment (a soccer goal) and fire a candidate. The perceive CPU capability
   * already reports `sample_interval_s >= 1.0`, so CPU stays at 1 fps by
   * itself; this ceiling only bounds GPU sampling toward the chartered
   * "3 live / 8 VOD" cadence. Default `VOD_SAMPLE_MAX_FPS` = 8. */
  vodSampleMaxFps: number;
  /** Detail-first VOD sampling fps (ADAAAA-4954, spec §1 knob `sampleFps`).
   * Deeper than the live 1 fps share; default 3 (raised from 2 by ADAAAA-7179 so
   * the decide read samples the goal-crossing window densely). `VOD_DETAIL_FPS`. */
  vodDetailFps: number;
  /** Hard ceiling on LIVE source sampling (frames/second) when the perceive
   * runner reports it can sustain more than `sampleIntervalSec`. ADAAAA-5342:
   * live sampling is driven from the runner's measured capability (mirroring
   * VOD) and this bounds it toward the "3 live / 8 VOD" charter — default 10,
   * above the VOD ceiling because live holds the runner open for a stream and
   * samples its own cadence. `LIVE_SAMPLE_MAX_FPS` = 10. */
  liveSampleMaxFps: number;
  /** ADAAAA-6796 (Stage 1): LIVE primary-pass frame-sampling BASELINE for the
   * decide read (frames/second) that every live job samples at least. The live
   * rail previously floored at the `sampleIntervalSec` cadence (~1 fps), so the
   * cached frame window the decide assembler samples was coarse and the
   * crossing/conversion instant could fall between frames (near-miss-as-goal
   * leaks). This raises the live baseline to 3 fps for ALL live jobs — the
   * decide read now sees ~3 fps (the assembler caps at `analysisFps`), so the
   * goal-vs-near-miss call is materially better on the first pass. Configurable
   * per deployment (tunable ceiling); `LIVE_SAMPLE_BASE_FPS` = 3. */
  liveSampleBaseFps: number;
  /** Headroom (0..1) applied to the runner's measured LIVE max fps so the
   * runner never sits at its sustained ceiling (frame-queue latency backs up
   * inside the 1-5s budget). ADAAAA-5342: live samples at
   * `min(liveSampleMaxFps, max(base, runnerMaxFps * liveSampleHeadroom))` —
   * the base cadence floor keeps a ~1 fps CPU runner from regressing. Default
   * 0.9 (10% headroom). `LIVE_SAMPLE_HEADROOM` = 0.9. */
  liveSampleHeadroom: number;
  /** Detail-first VOD frame scale for OD + decide image (spec knob
   * `frameScale`, default 640:360 — higher-res than live 320:180).
   * `VOD_FRAME_SCALE`. */
  vodFrameScale: string;
  /** ADAAAA-7847: frame scale for the ONE-SHOT jersey-identify anchor frame a
   * `track-player` / `track-player-by-number` request samples at REQUEST time.
   * Jersey OCR needs the number large and sharp, and neither rail scale is
   * enough (measured: jersey `11` reads at 1280x720 on 14/311 census frames,
   * 13/14 of those at 960x540, and 0/311 at the 640:360 VOD rail scale and
   * 0/311 at the 320:180 live rail scale). This scale does NOT touch the
   * streaming rail, the observation cadence, or the per-frame detection path —
   * the anchor is decoded once per request. Clamped to the source resolution so
   * it never upscales. `PLAYER_ANCHOR_FRAME_SCALE`. */
  playerAnchorFrameScale: string;
  /** ADAAAA-7847: how many high-resolution anchor frames one jersey request
   * samples (default 8) from the `playerAnchorSpanS` window ending at request
   * time. A single frame lands on a legible jersey only ~4.5% of the time on
   * the measured clip (14/311 frames, in four sub-second windows), so the
   * request samples a short newest-first burst and stops at the first
   * identification. Bounded by `ANCHOR_FRAME_MAX` (12).
   * `PLAYER_ANCHOR_FRAMES`. */
  playerAnchorFrames: number;
  /** ADAAAA-7847: length (seconds) of the anchor window ending at request time
   * that the burst is sampled across. Default 1 s at the default 8 frames = 8
   * samples/s, dense enough to land inside the measured 0.2-0.5 s legible
   * windows while staying within ~a second of the operator's moment (so the
   * seeded bbox is not stale). Bounded by `ANCHOR_SPAN_MIN_S`/`_MAX_S`.
   * `PLAYER_ANCHOR_SPAN_S`. */
  playerAnchorSpanS: number;
  /** Max VOD jobs a worker drains concurrently (ADAAAA-6873). Each running job
   * holds one perceive session, so this gates GPU concurrency. `VOD_WORKER_CONCURRENCY`. */
  vodWorkerConcurrency: number;
  /** ADAAAA-7906 (VOD resume): auto-retry budget for classified-transient
   * failures — the number of RETRIES (default 2, so up to 3 claims). A job that
   * exhausts it lands terminal `failed` with the classified reason.
   * `VOD_RESUME_MAX_ATTEMPTS`. */
  vodResumeMaxAttempts: number;
  /** ADAAAA-7906: retry backoff BASE in ms (default 30 s, exponential on the
   * retry number, capped at 10 min). `VOD_RESUME_BACKOFF_MS`. */
  vodResumeBackoffMs: number;
  /** ADAAAA-8061: bounded grace window (ms) POST /jobs/:id/stop gives a live
   * pass to unwind AND settle its own accounting before the stop path releases
   * the perceive runner and settles the record itself. Without the drain the
   * stop killed the decide runner under the pass, so the job ended `failed`
   * with no `costUsd`/`decideCalls`. `JOB_STOP_DRAIN_MS` (default 10000). */
  jobStopDrainMs: number;
  /** ADAAAA-7906: persist the resume checkpoint every N decided windows
   * (default 10 ≈ 30 s of content at the 3 s observe cadence).
   * `VOD_RESUME_CHECKPOINT_WINDOWS`. */
  vodResumeCheckpointWindows: number;
  /** Detail-first VOD decide temporal window length (spec knob
   * `decideWindowN`, default 24 > live 16). Frames forwarded to decide()'s
   * `frames[]` so Gemma reasons across a longer SEQUENCE per trigger.
   * `VOD_DECIDE_WINDOW_N`. */
  vodDecideWindowN: number;
  /** ADAAAA-7399: how many seconds of the tapped VOD audio timeline to retain
   * so the decide can slice window-aligned audio around each video-window
   * center (the VOD tap decodes the whole file faster than the GPU video pass).
   * `VOD_AUDIO_RETAIN_S`; default 1800 (30 min — covers typical highlight
   * sources; a longer VOD only gets window-aligned audio for windows within the
   * retained span). */
  vodAudioRetainS: number;
  /** I7 / ADAAAA-6361: higher-FPS re-sample around a trigger (VOD detail-first).
   * Frames within +/- `vodResampleWindowS` of a candidate are re-extracted at
   * `vodResampleFps` so the ball-goal-crossing instant is in the decide window.
   * `VOD_RESAMPLE_FPS` (default 8) / `VOD_RESAMPLE_WINDOW_S` (default 3). */
  vodResampleFps: number;
  vodResampleWindowS: number;
  /** Increment F / ADAAAA-6465 (plan §4.9): analysis FPS cap for the frame
   * sequence the LLM watches per trigger. Live default 5; the VOD pass uses the
   * higher-cap `vodAnalysisFps` (detail-first; speed secondary). `ANALYSIS_FPS`
   * / `VOD_ANALYSIS_FPS`. */
  analysisFps: number;
  vodAnalysisFps: number;
  /** Hard cap on the number of frames that reach the LLM in ONE analysis call
   * (never exceeded). Live default 30 (≈25 + 3 keyframes); VOD higher. `MAX_
   * FRAMES_PER_ANALYSIS` / `VOD_MAX_FRAMES_PER_ANALYSIS`. */
  maxFramesPerAnalysis: number;
  vodMaxFramesPerAnalysis: number;
  /** Pre/post window (seconds) around the trigger the assembler samples.
   * Default 2 s pre / 3 s post; VOD may lengthen (detail-first). `ANALYSIS_PRE_
   * WINDOW_S` / `ANALYSIS_POST_WINDOW_S` / `VOD_ANALYSIS_PRE_WINDOW_S` /
   * `VOD_ANALYSIS_POST_WINDOW_S`. */
  analysisPreWindowS: number;
  analysisPostWindowS: number;
  vodAnalysisPreWindowS: number;
  vodAnalysisPostWindowS: number;
  /** ADAAAA-6314 Path 2: forward the surrounding audio clip for LIVE trigger
   * candidates so the gemma decide prompt gets ASR'd audio context. Default off
   * so the deployed live baseline sends no new payload until an operator enables
   * it. `LIVE_AUDIO_CONTEXT`. */
  audioContext: boolean;
  /** ADAAAA-7011: enable the LIVE decide-observer architecture. When on, decide
   * is driven on the ~3 s cadence regardless of whether perceive emitted a
   * candidate, using the rolling-PAST LiveObserver (~10 s window, <=30-frame
   * cap). Default off so the deployed candidate-gated live baseline is unchanged
   * until the observer pass is validated. `LIVE_OBSERVE_LOOP`. */
  liveObserveLoop: boolean;
  /** ADAAAA-8139: enable the bounded persisted-frame re-read of a demoted LIVE
   * goal window (score-bug OCR only, <= 8 OCR calls per leg, no decide call and
   * no Livepeer debit). On by default; `LIVE_FRAME_REREAD=0` disables it, which
   * leaves the ADAAAA-8134 pooled re-read as the only path (byte-identical). */
  liveFrameReread: boolean;
  /** ADAAAA-7676: wall-clock lag budget (seconds) for the LIVE observe pass.
   * Once a frame's content time is further behind wall time than this, the pass
   * DROPS the stale frames/windows (counted as `observeMetrics
   * .skippedStaleWindows`) instead of deciding them late; before firing, one
   * measured decide E2E is reserved so the RESULT lands inside the budget.
   * Default 30 (the cadence + decide-E2E budget); `<= 0` disables the drop.
   * `LIVE_OBSERVE_LAG_BUDGET_S`. */
  liveObserveLagBudgetS: number;
  /** ADAAAA-7771: how many LIVE observe decide windows may be in flight per
   * stream. 1 = the serial pass (one decide at a time, capped at
   * `cadence / decideWall` coverage); 2-4 pipelines the decide work so the 3 s
   * cadence is held. Acceptance still runs in content order. Default 4.
   * `LIVE_OBSERVE_IN_FLIGHT`. */
  liveObserveInFlight: number;
  /** ADAAAA-7799 (lever C addendum): LIVE-only decide hop in content seconds
   *  (`LIVE_OBSERVE_CADENCE_S`). Unset keeps the CEO-locked 3 s cadence; 5
   *  produces the 5 s-hop row (~60 decides / 300 s) without touching the window
   *  span, the audio trigger or VOD. */
  liveObserveCadenceS?: number;
  /** ADAAAA-8065 (rev 7): LIVE-only decide WINDOW SPAN in content seconds
   *  (`LIVE_OBSERVE_WINDOW_S`). The live window is a rolling PAST window
   *  `[now - span, now]`; unset keeps today's 10 s span (`OBSERVE_WINDOW_S`,
   *  the value every leg before rev 7 ran). Setting it is a MEASURED change:
   *  rev 7's cell is 7 s of frames every 5 s (R18) and the span is stamped on
   *  every decide payload as `spanSec`, so a leg proves the value instead of
   *  reading `printenv`. VOD keeps its own `observeWindowS` and is untouched. */
  liveObserveWindowS?: number;
  /** ADAAAA-7777 (lever B, trim 1): hard cap on the frames ONE live decide
   * window carries. The live window is `OBSERVE_WINDOW_S` (10 s) resolved on an
   * `OBSERVE_CONTENT_FPS` (2) grid, so the natural window is <= 20 frames and the
   * historic cap was the shared 30. Measured on the box (ADAAAA-7777): a decide
   * call's wall time is dominated by the verdict DECODE (~8 s fixed for the
   * ~1.3 KB JSON reply) with a smaller per-frame multimodal prefill term, so the
   * live rail caps at a narrower budget than VOD. ADAAAA-8074: the default is
   * now {@link LIVE_DECIDE_IMAGE_BUDGET} (4 — the ruled AC-3 cell), clamped to
   * the {@link LIVE_DECIDE_IMAGE_CEILING} (30) hard ceiling. Both live rails
   * (analyzer live pass + media/RTC rail) read THIS value into the window's
   * selection step, and every decide payload records it on its audit row.
   * `LIVE_OBSERVE_MAX_FRAMES`. */
  liveObserveMaxFrames: number;
  /** ADAAAA-7777 (lever B, trim 2): forward the window AUDIO CLIP (`opts
   * .audioB64`) on the LIVE decide payload. `audioContext` still computes the
   * audio-ENERGY LEVEL curve — that is the shared noise-change detection
   * contract and must stay wired — but the raw clip (and the ASR transcript the
   * decide service derives from it) is what this flag stops riding the payload.
   * Default true (pre-trim behaviour); `LIVE_DECIDE_AUDIO_CLIP=0` drops the clip
   * while keeping the level curve. */
  liveDecideAudioClip: boolean;
  /** ADAAAA-8081: route the LIVE window's ASR through the server's fire-time
   * side lane so the transcription overlaps the decide already in flight instead
   * of serialising ahead of gemma inside the call. Default ON;
   * `LIVE_DECIDE_ASR_PREFETCH=0` restores the exact pre-8081 request (no `asr`
   * key => the decide service transcribes inline, which is also the automatic
   * fallback whenever a prefetch fails or times out). */
  liveDecideAsrPrefetch: boolean;
  /** ADAAAA-8081: `LIVE_DECIDE_ASR_PREFETCH_TIMEOUT_MS`, default 6 000. A hung
   * ASR must degrade to inline ASR, never stall the live pass. */
  liveDecideAsrPrefetchTimeoutMs: number;
  /** ADAAAA-7777 (lever B, trim 3): run the Stage-2 `/confirm` dive on the LIVE
   * pass. `DECIDE_CONFIRM_ENABLED` stays the master gate; this is the live-rail
   * opt-out, so VOD keeps its confirmation pass when the live rail skips it.
   * Default true; `LIVE_DECIDE_CONFIRM=0` skips the dive on live only. */
  liveDecideConfirm: boolean;
  /** ADAAAA-8205: run the Stage-2 confirm dive OFF the live accept path
   * (`LIVE_CONFIRM_ASYNC`, default on). The provisional row publishes exactly
   * as the `LIVE_DECIDE_CONFIRM=0` baseline, the dive runs post-window over the
   * row's persisted artifacts, and its verdict moves the SAME row. `0` restores
   * the inline awaited dive (the pre-8205 posture); `LIVE_DECIDE_CONFIRM` stays
   * the master opt-in, so an off master gate is still a strict no-op. */
  liveConfirmAsync: boolean;
  /** ADAAAA-8205: dives allowed per 300 s of stream (`LIVE_CONFIRM_MAX_DIVES_PER_300S`,
   * default 8 — the parent envelope's <= $0.318/h/stream dive term). */
  liveConfirmMaxDivesPer300S: number;
  /** ADAAAA-7781: ask the decide service for the COMPACT verdict contract on the
   * LIVE pass (short prose fields, no evidenceAttested list, 400-token cap).
   * Live decide throughput is decode-bound at ~150 output tok/s for the box's
   * gemma pair, so decisions/s = tokens/s / tokens-per-call: the full contract
   * costs ~420 tokens (0.36 decides/s, 55+ skipped windows per stream at 2
   * streams) while the compact one costs ~150. VOD keeps the full contract.
   * Default false (an unset env is byte-identical); `LIVE_DECIDE_COMPACT=1`
   * enables it. */
  liveDecideCompact: boolean;
  /** ADAAAA-8064 (AC-C4 A/B lever): which set the live `perceiveTimeline` is
   * sourced from. Default `observations` (the window's full pre-image-cap
   * observation set, the shipped construction). `LIVE_PERCEIVE_TIMELINE_SOURCE=seeds`
   * reproduces the pre-8064 construction (timeline = the shipped images) so the
   * AC-C4 ON/OFF latency pairing can be measured on ONE build with alternating
   * order. Instrumentation only — leave it unset in production. */
  livePerceiveTimelineSource: "observations" | "seeds";
  /** ADAAAA-8108 (AC-E3): the runtime arm of the live decide ENRICHMENT (the
   * per-window `perceiveTimeline` text block).
   *
   * `on` (the shipped posture, and the value an unset env resolves to) sends the
   * timeline on every live window. `off` sends NONE of it — span, cadence, image
   * budget, in-flight depth and `KEEP_RATIO` are untouched, so the delta against
   * `on` is the enrichment cost alone. `alternate` allocates the arm per DECIDED
   * window in content order, OFF first (`off`, `on`, `off`, …), so one leg yields
   * a same-cell ON/OFF pair that is not read through the warm image prefix: an
   * ON-first leg measures the first window against a cold engine and inflates
   * the ON arm by ~0.6 s.
   *
   * Instrumentation only — a measurement lever, never a posture. The resolved
   * arm is stamped on every decide_audit row (`perceiveTimeline.enrichmentArm`)
   * so a leg is graded off the payload instead of `printenv`.
   * `LIVE_DECIDE_ENRICH=off|alternate`. */
  liveDecideEnrich: "on" | "off" | "alternate";
  /** ADAAAA-7774: frame-consumption rate (content fps) of the LIVE observe pass.
   * The live ingest delivers ~5 fps (rtmp/file-sim decode) while the decide
   * window only ever carries `OBSERVE_CONTENT_FPS` (2) frames per content second
   * (`assembleLiveWindow` thinning), so perceiving every ingested frame spent
   * ~0.36 s of blocking `client.analyze` on 3 of every 5 frames whose output the
   * window assembler then discarded — and the surplus made the loop ~1.8x slower
   * than realtime, so the lag budget dropped frames/windows (56-86 of ~100
   * windows per 300 s at every decide depth). The pass now CONSUMES frames at
   * this rate (content-time stride) and runs the adaptive perceive cadence on
   * the consumed set, so ~`2` frames per content second are perceived, recorded
   * and decide-seeded, `perceiveCalls < framesAnalyzed` in cool regions, and a
   * perceive skipped frame is recorded with an EMPTY seed (no fabricated
   * signal — recall-safe, exactly like the VOD cadence path). Default 2
   * (`OBSERVE_CONTENT_FPS`); `LIVE_OBSERVE_CONTENT_FPS`. `<= 0` disables the
   * stride (perceive every ingested frame = the pre-7774 behaviour). */
  liveObserveContentFps?: number;
  /** ADAAAA-7774: fraction of wall clock the LIVE observe pass may spend in
   * blocking `client.analyze` (perceive shares the GPU with the decide workers).
   * The frames it cannot afford are consumed with an EMPTY seed, so the decide
   * window keeps ~2 fps of frames and the cadence keeps firing. Default 0.6;
   * `LIVE_PERCEIVE_UTILIZATION`. */
  livePerceiveUtilization?: number;
  /** ADAAAA-7758: live decide ADMISSION control. When on, at most ONE live job
   * holds the box's live decide slot; a second concurrent live job's decide is
   * skipped (counted as `observeMetrics.admissionSkippedWindows`) instead of
   * interleaving a second decide that stretches BOTH streams past the 30 s
   * budget and drops ~85% of every stream's windows. Refusal makes the extra
   * stream wait, which needs CEO-approved customer wording (ADAAAA-7757), so the
   * shipped default is OFF. `LIVE_DECIDE_ADMISSION=1`. */
  liveDecideAdmission: boolean;
  /** ADAAAA-7799 (lever C): the decide-rate CAP. Spend is a pure function of
   * decided windows ($/h/stream = `decideCalls * 12 * DECIDE_FEE`), so at the
   * measured $0.0033 per decide the funded $2.75 ceiling is ~69 decides per
   * 300 s per stream. This keeps only a FRACTION of the decide opportunities
   * instead of deciding every cadence tick: at 2 streams with the levers-B trims
   * the pass sees ~108 opportunities per 300 s per stream (104 cadence windows
   * plus trigger-anchored windows), so 5 of every 8 kept (0.625) is ~67 decides
   * = $2.67/h. The dropped windows are counted as
   * `observeMetrics.throttleSkippedWindows`. It does NOT change the cadence, the
   * window span or the audio noise-change trigger. Unset/1 = off
   * (byte-identical). `LIVE_DECIDE_KEEP_RATIO`. */
  liveDecideKeepRatio?: number;
  /** ADAAAA-7007/7011: enable the VOD decide-observer architecture on the
   * detail-first pass (observeLoop + decideWindowN both set in analyzeJob).
   * When on, decide is driven on the ~3 s cadence with a ~10 s overlapping
   * window (<=30 frames) regardless of perceive candidates. Default off so the
   * deployed candidate-gated VOD baseline is unchanged until the observer pass
   * is validated. `OBSERVE_LOOP`. */
  observeLoop: boolean;
  /** ADAAAA-7145: enable the Tier-2 signal gate on the decide-observer so a
   * billable decide call only fires on a window with a real highlight signal
   * (ball-in-net / goal-crossed / scoreboard change / confident motion+audio),
   * cutting per-job decide volume + latency. Recall-safe: an uncalibrated /
   * unsignaled window always escalates, so a genuine goal is never starved.
   * Default off (existing high-recall cadence unchanged) until box QA confirms
   * goal recall after the perceive goal-line/homography channels are enabled.
   * `OBSERVE_SIGNAL_GATE`. */
  observeSignalGate: boolean;
  /** ADAAAA-7878: issue every observe decide OFF the frame-consume loop (both
   * rails) so ingest keeps feeding perceive while gemma judges a window. VOD
   * queues the window payload and decides at `observeDecideInFlight` depth while
   * the frame loop keeps calling `client.analyze`; the live depth-1 fallback also
   * issues-and-does-not-await. Acceptance stays in content order. Default ON
   * (`OBSERVE_DECIDE_OFFLOOP` unset/1); `0` reproduces the pre-7878 serial pass
   * byte-for-byte, so a measured regression can be reverted without a code
   * revert. */
  observeDecideOffLoop: boolean;
  /** ADAAAA-7878: VOD off-loop decide depth (default 1). Raising it changes the
   * decide CONCURRENCY — ADAAAA-7773/7771 territory; ship only with a measured
   * pair. `OBSERVE_DECIDE_IN_FLIGHT`. */
  observeDecideInFlight: number;
  /** ADAAAA-7878: hard bound on the VOD off-loop pending-window queue (default
   * 512). A full queue drops the window and counts it; ingest is never blocked
   * by it. `OBSERVE_DECIDE_QUEUE_MAX`. */
  observeDecideQueueMax: number;
  /** ADAAAA-7147: image-space `speedMps` at/above which a frame is a
   * "meaningful ball" escalation signal for the Tier-2 gate on an
   * uncalibrated box (no goal-line/homography/scoreboard channel).
   * `OBSERVE_SIGNAL_GATE_BALL_MIN_SPEED` (default 0.08). */
  observeSignalGateBallMinSpeedMps?: number;
  /** ADAAAA-7147: enable quiet-uncalibrated suppression so the Tier-2 gate
   * drops a no-signal window even when no goal channel judged it (this is what
   * actually cuts decide volume on the current box). Default off (recall-safe
   * escalate) until goal recall is verified. `OBSERVE_SIGNAL_GATE_SUPPRESS_QUIET`. */
  observeSignalGateSuppressQuiet: boolean;
  /** ADAAAA-7152 Gap 1: adaptive perceive cadence for the VOD detail-first pass.
   * When on, the per-frame perceive pass runs at a REDUCED cadence in cool
   * (no-signal) regions and FULL cadence around any window the Tier-2 signal gate
   * escalates (the escalated goal window is never starved), cutting VOD E2E cost.
   * Tri-state: `PERCEIVE_CADENCE=1` forces on, `=0` forces off, unset auto-enables
   * when `OBSERVE_LOOP` + `OBSERVE_SIGNAL_GATE` are both on (the gap-1 target). */
  perceiveCadence?: boolean;
  /** ADAAAA-7152 Gap 1: cool-region perceive stride (perceive every N-th frame
   * where no signal escalated; 1 = full pass). `PERCEIVE_QUIET_STRIDE` (2). */
  perceiveQuietStride?: number;
  /** ADAAAA-7152 Gap 1: seconds of FULL-perceive treatment after a frame
   * escalates the Tier-2 gate. `PERCEIVE_HOT_AFTER_S` (default observe window). */
  perceiveHotAfterS?: number;
  /** ADAAAA-7152 (Gap 2): per-camera pitch calibration the server forwards to a
   * perceive session via the `configure` control so perceive emits a REAL
   * `goalCrossed`/`ballOutcome` attestation (a `scoring_play` accept) instead of
   * an uncalibrated box judging no goal channel. Wired from
   * `PERCEIVE_CALIBRATION_JSON` (a JSON map keyed by camera id with a reserved
   * `default` entry). Absent => the server sends NO `configure` calibration, the
   * perceive session stays uncalibrated (no goal channel) and the gate keeps the
   * recall-safe baseline. Never fabricated: only explicit config reaches the
   * session. See `perceive-calibration.ts`. */
  perceiveCalibration?: PerceiveCalibrationMap;
  /** Auth + billing */
  jwtSecret: string;
  /** ADAAAA-7901: the secret that signs export tokens. NEVER equals
   * `jwtSecret`: an export token is a public, per-clip credential embedded in a
   * URL, so signing it with the session secret let anyone holding the same
   * literal forge a signed-in session. Comes from `EXPORT_TOKEN_SECRET` when
   * set, else HKDF-SHA256(`jwtSecret`, "clip-export") — see
   * `export-token.ts#deriveExportTokenSecret`. */
  exportTokenSecret: string;
  /** Max password-reset token lifetime (seconds) before it expires. */
  resetTokenTtlSec: number;
  /** Max auth-endpoint requests (login/register/forgot/reset) per IP per
   * `authRateLimitWindowSec` — simple in-process anti-abuse for the beta. */
  authRateLimit: number;
  authRateLimitWindowSec: number;
  /** Seeded dev admin account (email + password). Override in prod. */
  adminEmail: string;
  adminPassword: string;
  /** Built SPA directory to serve over HTTP (static + history fallback). When
   * set, the server serves the webapp's `dist/` at `/` so the landing page is
   * reachable over HTTPS. Falls back to the repo-local `webapp/dist` when the
   * directory exists; empty disables SPA serving (API-only). */
  webappDist?: string;
  /** Root directory (server-visible) where completed fine-tune artifacts are
   * staged for user download (ADAAAA-5323). The train runner emits a LoRA
   * adapter file per run; in direct/shared-mount deployments the server reads
   * the artifact from here so it can serve the run-scoped download endpoint
   * with hash verification. Default `${dataDir}/train-artifacts`. */
  trainArtifactRoot: string;
  /** Directory where the curated train/val manifests (fine-tune Increment A)
   * are published as `train_manifest.jsonl` / `val_manifest.jsonl`. The
   * fine-tune page uses them as the one-click trigger source (manual JSON
   * paste stays as the operator fallback). Default `${dataDir}/curated`. */
  curatedManifestDir: string;
  /** SQLite database file path (dev; used when `databaseUrl` is unset). */
  databasePath: string;
  /** Postgres connection string (prod). When set, the server uses Postgres
   * instead of SQLite; SQLite stays the local/dev default. */
  databaseUrl?: string;
  /** Decide-audit retention cap (ADAAAA-7028 Inc 2): keep at most this many
   * newest decide_audit rows on the write path. 0 disables the trim (unbounded
   * — should only be used in a controlled/dev context). */
  decideAuditRetention: number;
  /** Where `npm run db:backup` writes DB snapshots (default `data/backups`). */
  databaseBackupDir: string;
  /** Email-sender container base URL (e.g. http://email:3001). When unset,
   * transactional emails (invites, password reset) are skipped (logged), not
   * sent — used for local dev without an SMTP backend. */
  emailSenderUrl?: string;
  /** Bearer token shared with the email-sender's queue API (secrets-managed). */
  mailerToken?: string;
  /** Stripe */
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  /** Stripe Price ID for the Pro subscription (fixed monthly base). */
  stripePricePro?: string;
  /** Stripe Price ID for the metered (usage-based) overage line. */
  stripePriceUsage?: string;
  /** Public base URL (for Stripe return URLs). */
  publicBaseUrl: string;
  /** Free plan included-highlights cap (beta: 10 clips/month, matching the
   * entitlement ledger's BETA_CLIP_QUOTA default; 0 blocks free farming). */
  freeHighlights: number;
  /** Fixed fee per decide call (single shot, USD). Default $0.01. */
  decideFee: number;
  /** Stage-2 goal/near-miss confirmation pass (ADAAAA-6797). When true, the
   * pass runs the decide `/confirm` deep-frame-dive for un-attested goal-type
   * candidates and adopts the reconciled verdict. Wired from
   * `DECIDE_CONFIRM_ENABLED` (default "0"). ADAAAA-7663: BOTH the VOD and the
   * live pass read this flag (the live pass used to omit the wiring, so live
   * could never emit a `gNNN:confirm` decide-audit row); off => strict no-op. */
  decideConfirmEnabled: boolean;
  /** ADAAAA-7162: extra seconds (each side) the Stage-2 confirmation frame
   * window is expanded beyond the Stage-1 pre/post window. `DECIDE_CONFIRM_EXTRA_WINDOW_S`
   * (default 4). */
  decideConfirmExtraWindowS: number;
  /** ADAAAA-7663: LIVE-only exactly-once horizon (seconds) for the Stage-2
   * confirm dive. The live observer's rolling window center slides with the
   * cadence, so one goal is re-read by every window that still contains it; a
   * goal confirmed within this window of a new goal-shaped read reuses that
   * outcome instead of diving again. Default 12 s = the 10 s observe window plus
   * one cadence tick of slack — deliberately SMALLER than the 30 s goal burst
   * window, so a nearby but distinct goal (or a post-goal celebration read) is
   * never refuted by an earlier window's dive.
   * `DECIDE_CONFIRM_LIVE_REUSE_WINDOW_S` (default 12). Unused by the VOD pass,
   * which keys on the goal's content time. */
  decideConfirmLiveReuseWindowS: number;
  /** Free plan included decide calls before gating (dev-friendly). */
  freeDecides: number;
  /** Dev-only: wireframe billing (no real Stripe). Enables /dev/billing/*. */
  billingWireframe: boolean;
  /** Per-user per-calendar-month clip quota during the beta (the entitlement
   * ledger's hard-stop; no billing during beta). Default 10 clips/month. */
  betaClipQuota: number;
  /** Per-user per-calendar-month clip quota for an ACTIVE/TRIALING Pro
   * subscriber (ADAAAA-8028). Default 100, mirroring the GA `PLANS` pro
   * `includedHighlights` (`src/billing.ts`) so the advertised plan and the
   * enforced hard-stop stay in lockstep. `PRO_CLIP_QUOTA` raises/lowers the
   * enforced ceiling without touching what /pricing advertises — used to lift
   * the ceiling for a bounded test window. */
  proClipQuota: number;
  /** Invite/beta-gate: when true, registration + login require the account to
   * have been activated (a claimed invite code or an invited waitlist email).
   * Default ON in prod. Tests/off turn it off for the un-gated loop. */
  betaGate: boolean;
  /** Days after a user's first job before a later job counts them as a
   * returning (retained) user in the conversion funnel (ADAAAA-6368).
   * Default 7; `FUNNEL_RETAIN_DAYS`. */
  funnelRetainDays: number;
  /** Closed-beta auto-publish: when true (default), a clip that a user's job
   * successfully generates is published straight to the public /feed (status
   * "accepted") without an admin review step. This is what makes the beta
   * cohort's clips show up in /feed the moment a job finishes (gate X "K clips
   * usable"). During the closed beta every user is invite-gated and quota-capped
   * (betaClipQuota), so the blast radius is bounded. Set AUTO_PUBLISH_HIGHLIGHTS=0
   * once real admin review is wanted. */
  autoPublishHighlights: boolean;
  /** Soft-delete undo grace period for rejected clips (ms). A rejected clip is
   * held for this long before the TTL sweep hard-deletes its DB row + storage
   * object; reject -> accept within this window restores it (rejectedAt is
   * cleared, so it is never a purge candidate). Config value, NOT hard-coded
   * (ADAAAA-5163). Default 24h. */
  rejectTtlMs: number;
  /** How often the rejected-clip TTL sweep runs (ms). Must be <= rejectTtlMs so
   * a rejected clip is removed no more than ~1 sweep interval after its grace
   * elapses. Default: run hourly, well within the <=24h reject->removal bound. */
  rejectSweepIntervalMs: number;
  /** How often the 30-day dataset retention purge sweep runs (ms). Must be <=
   * the 30-day grace (PURGE_GRACE_MS) so a deactivated dataset is removed no
   * more than ~1 sweep interval after its purge window elapses. Default: run
   * hourly (ADAAAA-5398 C4). */
  datasetPurgeSweepIntervalMs: number;
  /**
   * Increment D (ADAAAA-6467): the stream-start what-to-track warm-up window
   * (seconds) — exactly ONE planner call must deliver a valid TrackingPlan
   * within it before the per-frame loop begins steady-state tracking. The
   * worker never blocks on the planner; a slow plan just applies late (the
   * per-frame loop runs the canned/safe-default interim). `WARMUP_SECONDS`
   * (default 3).
   */
  warmupSeconds: number;
  /**
   * Increment D (ADAAAA-6467): the out-of-band re-check cadence (seconds) —
   * a scheduler samples a few frames OFF the per-frame path and re-plans,
   * swapping the active TrackingPlan within (~) this interval on a mid-session
   * type change. `RECHECK_INTERVAL_SECONDS` (default 10).
   */
  recheckIntervalSeconds: number;
  /** Per-camera/per-clip goal-line calibration (ADAAAA-6489 / ADAAAA-7159 Gap 2):
   * a map keyed by job/clip id -> `{homography, goalLine}` — a REAL image->field
   * pitch homography + goal-line plane spec for that clip's camera. The
   * detail-first/VOD server path resolves this per job and delivers it to the
   * perceive session so the goal-line crossing signal (goalCrossed/ballOutcome)
   * is real, never a single static env value. A clip with no entry has no
   * calibration -> perceive emits no ballOutcome and the metric reports
   * not_captured (never fabricated). `GOAL_LINE_CALIBRATIONS` (JSON object keyed
   * by clip/job id). */
  goalLineCalibrations?: Record<string, GoalLineCalibration>;
  /**
   * ADAAAA-6577: base delay (ms) of the bounded exponential backoff slept
   * between a perceive session-lost (HTTP 404 "runner not found") re-reserve
   * and the next retry of the same frame in the analyzeJob pass. A flapping
   * perceive runner 404s every /analyze; backing off (500ms -> 1s -> 2s -> …,
   * capped) keeps the re-reserve cadence near ~1/sec and lets the pass ride
   * through a brief runner recovery instead of hammering the orchestrator.
   * `VOD_SESSION_RETRY_BACKOFF_MS` (default 500).
   */
  vodSessionRetryBackoffMs: number;
  /** ADAAAA-6577: upper bound (ms) of that exponential backoff. The delay never
   * exceeds this, so a long-lived flap still re-reserves at most every
   * `maxReReserves` times per frame at the capped cadence and then aborts.
   * `VOD_SESSION_RETRY_BACKOFF_MAX_MS` (default 8000). */
  vodSessionRetryBackoffMaxMs: number;
  /** ADAAAA-6694: total bounded window (ms) the VOD background-analyze path
   * keeps retrying the INITIAL perceive reserve on `503 no capacity available
   * for runner`. The shared reserve helper already retries 4x (~4s); a longer
   * ride-out here lets a VOD submitted while the capacity-1 perceive slot is
   * held by another job stay `active`/queued and eventually process instead of
   * failing instantly. `VOD_RESERVE_RETRY_TOTAL_MS` (default 120000 = 2 min). */
  vodReserveRetryTotalMs: number;
}

/**
 * ADAAAA-7808: a positive finite env number, or `undefined` meaning "unset".
 *
 * docker-compose maps the optional live knobs as `${X:-}`, so a var that is
 * absent from `docker/.env` still reaches the container as an EMPTY string and
 * `Number("")` is 0 — a value that silently changes behaviour instead of
 * keeping the default. Measured on the shipped rail: an empty
 * `LIVE_OBSERVE_CADENCE_S` collapsed the decide cadence to zero and fired on
 * every consumed frame (601 opportunities / 110 decides per 300 s instead of
 * 101 / 68, ~6x the funded rate). Treat empty/zero/NaN/negative as unset.
 */
function positiveNumberOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * ADAAAA-8102: the same empty-means-unset guard for a knob whose `<= 0` value is
 * a DOCUMENTED disable rather than a nonsense rate.
 *
 * `LIVE_OBSERVE_CONTENT_FPS` is that knob: 0 (or negative) is the documented
 * opt-out of the ingest -> consumption stride ("perceive/consume every frame"),
 * so it must survive parsing. What must NOT survive is compose's `${X:-}` empty
 * string: `Number("")` is 0, so an unset knob would silently read as "stride
 * disabled" instead of "the default 2 fps", and a zero-rate stride starves every
 * decide window. Unset, empty and unparseable all mean "unset" — only a real
 * number (including the documented 0) is returned.
 */
function finiteNumberOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse a boolean env flag. Unset / unrecognized -> `fallback`; the common
 * off-spellings ("0", "false", "off", "no", case-insensitive) -> false. Used by
 * the ADAAAA-8254 discovery toggle so `DECIDE_CAPACITY_DISCOVERY=0` disables the
 * capacity probe while leaving the rest of the admission path intact.
 */
export function parseBooleanFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(v)) return false;
  if (["1", "true", "on", "yes"].includes(v)) return true;
  return fallback;
}

function parseGoalLineCalibrations(raw: string | undefined): Record<string, GoalLineCalibration> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, GoalLineCalibration>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ADAAAA-7901: every secret this repo has ever shipped as a default. A
 * deployment that boots with one of these signs sessions (and service
 * credentials) with a literal that is in the public repo, so an admin session
 * can be minted offline from `git clone`, and `GET /feed` even hands out the
 * admin user id.
 *
 * `dev-secret` is the `docker/docker-compose.yml` default the deployed box ran
 * on; `dev-insecure-secret-change-me` is the `config.ts` code default.
 */
export const INSECURE_JWT_SECRETS: readonly string[] = [
  "dev-insecure-secret-change-me",
  "dev-secret",
  "changeme",
  "secret",
];

/** The code-level fallback for local dev/tests (`NODE_ENV` not production). */
export const DEFAULT_JWT_SECRET = INSECURE_JWT_SECRETS[0];

/**
 * Resolve the session secret and enforce the production gate (ADAAAA-7901).
 *
 * In production (`NODE_ENV=production`, which `docker/Dockerfile.server`
 * always sets) an unset `JWT_SECRET` — or any documented default — is a hard
 * boot failure: throw before the listener starts so the process exits non-zero
 * and the orchestrator shows a crash loop instead of silently signing with a
 * public literal. Dev/test keep the old fallback so `pnpm dev` and the suite
 * work unconfigured.
 */
export function resolveJwtSecret(raw: string | undefined, nodeEnv: string): string {
  const value = (raw ?? "").trim();
  const production = nodeEnv === "production";
  if (production) {
    if (!value) {
      throw new Error(
        "JWT_SECRET is required when NODE_ENV=production: refusing to boot with the insecure development default (ADAAAA-7901). Set a real random secret, e.g. `openssl rand -hex 32`, in the deployment env (docker/.env for the compose stack)."
      );
    }
    if (INSECURE_JWT_SECRETS.includes(value)) {
      throw new Error(
        `JWT_SECRET is set to a documented insecure default ("${value}") while NODE_ENV=production: refusing to boot, because a session signed with that literal is forgeable by anyone with the repo (ADAAAA-7901). Set a real random secret, e.g. \`openssl rand -hex 32\`.`
      );
    }
  }
  return value || DEFAULT_JWT_SECRET;
}

/** The code-level fallback for the seeded admin password (dev/test only). It is
 * a literal in the public repo, so a production boot that would seed it refuses
 * to start (ADAAAA-7904). */
export const DEFAULT_ADMIN_PASSWORD = "admin";

/**
 * Every admin password this repo has shipped as a documented default
 * (ADAAAA-7904). `docs/INTEGRATIONS.md` published `admin` as the dev admin
 * login, and `docker/docker-compose.yml` shipped it as the compose literal, so
 * the deployed box handed out an admin session to anyone who could read the
 * repo. Keep this list in step with the docs.
 */
export const INSECURE_ADMIN_PASSWORDS: readonly string[] = ["admin"];

/**
 * Resolve the seeded admin password and enforce the production gate
 * (ADAAAA-7904) — same shape as `resolveJwtSecret`.
 *
 * In production (`NODE_ENV=production`, which `docker/Dockerfile.server` always
 * sets) an unset `ADMIN_PASSWORD` — or the documented default — is a hard boot
 * failure: throw before the listener starts so a deployment that forgot the
 * `docker/.env` entry fails closed instead of quietly re-seeding the published
 * credential. Dev/test keep the `admin` fallback so `pnpm dev` and the suite
 * boot unconfigured.
 */
export function resolveAdminPassword(raw: string | undefined, nodeEnv: string): string {
  const value = (raw ?? "").trim();
  if (nodeEnv === "production") {
    if (!value) {
      throw new Error(
        "ADMIN_PASSWORD is required when NODE_ENV=production: refusing to boot and seed the published development admin password (ADAAAA-7904). Set a random password, e.g. `openssl rand -base64 32`, in the deployment env (docker/.env for the compose stack)."
      );
    }
    if (INSECURE_ADMIN_PASSWORDS.includes(value)) {
      throw new Error(
        `ADMIN_PASSWORD is set to a documented default ("${value}") while NODE_ENV=production: refusing to boot, because that literal is published in the repo and anyone can sign in as admin with it (ADAAAA-7904). Set a random password, e.g. \`openssl rand -base64 32\`.`
      );
    }
  }
  return value || DEFAULT_ADMIN_PASSWORD;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  // ADAAAA-7901: both secrets are resolved before the object literal so a
  // production boot with an insecure/missing JWT_SECRET throws here — the
  // process exits non-zero at startup instead of signing with `dev-secret`.
  const jwtSecret = resolveJwtSecret(env.JWT_SECRET, nodeEnv);
  // ADAAAA-7904: same gate for the seeded admin credential — production throws
  // on unset/default instead of seeding `admin` from the repo.
  const adminPassword = resolveAdminPassword(env.ADMIN_PASSWORD, nodeEnv);
  const exportTokenSecret = resolveExportTokenSecret(env.EXPORT_TOKEN_SECRET, jwtSecret, {
    requireStrong: nodeEnv === "production",
  });
  return {
    port: Number(env.PORT ?? 3000),
    nodeEnv,
    orchestratorUrl: env.ORCHESTRATOR_URL ?? "http://127.0.0.1:8935",
    perceiveUrl: env.PERCEIVE_URL,
    perceiveRunnerUrl: env.PERCEIVE_RUNNER_URL,
    decideUrl: env.DECIDE_URL,
    asrUrl: env.ASR_URL,
    matchContext: String(env.MATCH_CONTEXT ?? "1").trim().toLowerCase() !== "0" &&
      !["false", "off"].includes(String(env.MATCH_CONTEXT ?? "1").trim().toLowerCase()),
    matchContextAsrSeconds: Number(env.MATCH_CONTEXT_ASR_SECONDS ?? 90),
    matchContextAsrMaxBytes: Number(env.MATCH_CONTEXT_ASR_MAX_BYTES ?? 8 * 1024 * 1024),
    decideConcurrency: env.DECIDE_CONCURRENCY ? Number(env.DECIDE_CONCURRENCY) : undefined,
    // ADAAAA-8254: the capacity-aware decide ceiling + ordered 503 queue knobs.
    // Unset keeps the client defaults (60 s refresh, 60 s queue budget, probe
    // on when a signer exists), so an unset environment behaves exactly like
    // the pre-8254 static gate plus the shared-pause queue.
    decideCapacityRefreshS: env.DECIDE_CAPACITY_REFRESH_S
      ? Number(env.DECIDE_CAPACITY_REFRESH_S)
      : undefined,
    decideQueueMaxWaitMs: env.DECIDE_QUEUE_MAX_WAIT_MS ? Number(env.DECIDE_QUEUE_MAX_WAIT_MS) : undefined,
    decideCapacityDiscovery: parseBooleanFlag(env.DECIDE_CAPACITY_DISCOVERY, true),
    trainUrl: env.TRAIN_URL,
    mediaServerUrl: env.MEDIA_SERVER_URL,
    mediaPublicBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
    mediaHealthToken: env.MEDIA_HEALTH_TOKEN,
    signerUrl: env.SIGNER_URL,
    signerAuthToken: env.SIGNER_AUTH_TOKEN,
    payerAddress: env.PAYER_ADDRESS,
    dataDir: env.DATA_DIR ?? "data",
    perceiveClipRoot: env.PERCEIVE_CLIP_ROOT ?? "/data",
    // VOD_MAX_UPLOAD_BYTES is parsed and compared STRICTLY in bytes (Number(), no
    // unit coercion — a value like "2048" means 2048 bytes, never 2 GB). The cap,
    // the multipart fileSize margin, the upload byte counter and the client pre-check
    // all compare in bytes; only human-facing messages render units (api.formatBytes).
    // See the vodMaxUploadBytes prop comment for the default (4294967296 = 4 GB).
    vodMaxUploadBytes: Number(env.VOD_MAX_UPLOAD_BYTES ?? 4294967296),
    vodChunkBytes: Number(env.VOD_CHUNK_BYTES ?? 64 * 1024 * 1024),
    ffmpegPath: env.FFMPEG_PATH ?? "ffmpeg",
    gameHintDefault: env.GAME_HINT ?? "unspecified",
    // ADAAAA-7232: delivered highlight clip is a >=15 s window so the localized
    // highlight lands mid-clip. 7s pre-roll + 8s post-roll = 15s. Tunable via
    // env, but `clipWindow` enforces `clipWindowMinSec` (15) as a hard floor.
    clipBeforeS: Number(env.CLIP_BEFORE_S ?? 7),
    clipAfterS: Number(env.CLIP_AFTER_S ?? 8),
    clipWindowMinSec: Number(env.CLIP_WINDOW_MIN_SEC ?? 15),
    sampleIntervalSec: Number(env.SAMPLE_INTERVAL_SEC ?? 1.0),
    // ADAAAA-5059: VOD default sampling moved up to 5 fps (from the previous
    // 1 fps fallback); still bounded above by VOD_SAMPLE_MAX_FPS (8) and
    // overridable per job. Keep the live path's sampleIntervalSec untouched.
    vodSampleFpsDefault: Number(env.VOD_SAMPLE_FPS_DEFAULT ?? 5),
    vodSampleMaxFps: Number(env.VOD_SAMPLE_MAX_FPS ?? 8),
    vodDetailFps: Number(env.VOD_DETAIL_FPS ?? 3),
    vodFrameScale: env.VOD_FRAME_SCALE ?? "640:360",
    // ADAAAA-7847: the jersey-identify anchor frame is sampled at REQUEST time
    // and is deliberately NOT the rail scale. Jersey OCR needs the number large
    // and sharp: measured on clip `397294f3` (native 1280x720) the number is
    // legible on 14/311 frames at 1280x720, 13/14 of those also at 960:540, and
    // 0/311 at 640:360 (VOD rail) or 320:180 (live rail). Default 1280:720 (the
    // source resolution of a broadcast 720p stream); clamped to the actual
    // source size, so it never upscales a smaller stream. One decode per
    // request — the streaming rail, cadence, and per-frame path are untouched.
    playerAnchorFrameScale: env.PLAYER_ANCHOR_FRAME_SCALE ?? "1280:720",
    playerAnchorFrames: Number(env.PLAYER_ANCHOR_FRAMES ?? 8),
    playerAnchorSpanS: Number(env.PLAYER_ANCHOR_SPAN_S ?? 1),
    vodWorkerConcurrency: Number(env.VOD_WORKER_CONCURRENCY ?? 1),
    // ADAAAA-7906 (VOD resume): auto-retry budget + backoff + checkpoint cadence.
    vodResumeMaxAttempts: Number(env.VOD_RESUME_MAX_ATTEMPTS ?? 2),
    vodResumeBackoffMs: Number(env.VOD_RESUME_BACKOFF_MS ?? 30_000),
    // ADAAAA-8061: bounded drain window for a stop on a live/file-sim pass.
    jobStopDrainMs: Math.max(0, Number(env.JOB_STOP_DRAIN_MS ?? 10_000)),
    vodResumeCheckpointWindows: Math.max(1, Number(env.VOD_RESUME_CHECKPOINT_WINDOWS ?? 10)),
    vodDecideWindowN: Number(env.VOD_DECIDE_WINDOW_N ?? 24),
    vodAudioRetainS: Number(env.VOD_AUDIO_RETAIN_S ?? 1800),
    // I7 / ADAAAA-6361: higher-FPS re-sample around a trigger (VOD detail-first).
    // Frames within +/- vodResampleWindowS of a candidate are re-extracted at
    // vodResampleFps so the ball-goal-crossing instant is in the decide window.
    vodResampleFps: Number(env.VOD_RESAMPLE_FPS ?? 8),
    vodResampleWindowS: Number(env.VOD_RESAMPLE_WINDOW_S ?? 3),
    // Increment F / ADAAAA-6465 (plan §4.9): analysis FPS cap + hard per-call
    // frame cap + pre/post window. Live default 5 fps / 30 frames / 2s pre+3s
    // post; VOD detail-first gets a higher cap / longer window (speed secondary).
    analysisFps: Number(env.ANALYSIS_FPS ?? 5),
    vodAnalysisFps: Number(env.VOD_ANALYSIS_FPS ?? 5),
    maxFramesPerAnalysis: Number(env.MAX_FRAMES_PER_ANALYSIS ?? 30),
    vodMaxFramesPerAnalysis: Number(env.VOD_MAX_FRAMES_PER_ANALYSIS ?? 40),
    analysisPreWindowS: Number(env.ANALYSIS_PRE_WINDOW_S ?? 2),
    analysisPostWindowS: Number(env.ANALYSIS_POST_WINDOW_S ?? 3),
    vodAnalysisPreWindowS: Number(env.VOD_ANALYSIS_PRE_WINDOW_S ?? 3),
    vodAnalysisPostWindowS: Number(env.VOD_ANALYSIS_POST_WINDOW_S ?? 5),
    // I4 / ADAAAA-6361: live-path decide() carries the surrounding audio clip so
    // Gemma gets auditory context, matching VOD. Opt out with LIVE_AUDIO_CONTEXT=0.
    audioContext: env.LIVE_AUDIO_CONTEXT !== "0",
    // ADAAAA-7011: wire the LIVE decide-observer into the live job path. Opt in
    // with LIVE_OBSERVE_LOOP=1 (default off; the candidate-gated live baseline
    // stays the behavior until the observer pass is validated).
    liveObserveLoop: env.LIVE_OBSERVE_LOOP === "1",
    // ADAAAA-8139: bounded persisted-frame re-read for a demoted goal window.
    // On by default (it is the only lever that recovers a goal the sampled read
    // rate missed); `LIVE_FRAME_REREAD=0` restores the 8134 pooled-only path.
    liveFrameReread: env.LIVE_FRAME_REREAD !== "0",
    // ADAAAA-7676: bound the live observe lag against the wall clock. Once the
    // content clock falls further behind wall time than this budget, stale
    // frames/windows are dropped (counted on the job) instead of decided late.
    liveObserveLagBudgetS: Number(env.LIVE_OBSERVE_LAG_BUDGET_S ?? LIVE_OBSERVE_LAG_BUDGET_S),
    // ADAAAA-7771: pipeline the live decide pass. K windows in flight per stream
    // (1 = serial). Default 4: at the measured ~5 s decide wall per card and
    // ~0.8 decides/s per card at 4 concurrent, depth 4 holds the 3 s cadence for
    // 1-2 streams on the 8 in-flight slots the decide pair serves. The lag
    // budget stays the outer backpressure, so a depth that breaches it
    // self-corrects instead of queueing unbounded. `LIVE_OBSERVE_IN_FLIGHT=1`
    // restores the old serial behaviour exactly.
    liveObserveInFlight: Number(env.LIVE_OBSERVE_IN_FLIGHT ?? 4),
    // ADAAAA-7799 (lever C addendum): live-only decide hop. Unset keeps the 3 s
    // cadence (byte-identical), so this cannot move the shipped rail by itself.
    // ADAAAA-7808: compose passes an EMPTY string for the unset case, so parse
    // through the "empty means unset" guard — `Number("")` is 0, which pinned the
    // cadence to zero and fired on every consumed frame.
    liveObserveCadenceS: positiveNumberOrUndefined(env.LIVE_OBSERVE_CADENCE_S),
    // ADAAAA-8065 (rev 7): LIVE-only decide window span. Unset keeps the 10 s
    // trailing window every prior leg measured, so merging this change cannot
    // move a running box. ADAAAA-7808's empty-means-unset guard applies for the
    // same reason: compose passes `${LIVE_OBSERVE_WINDOW_S:-}`, and `Number("")`
    // is 0 — a zero-second window would fire an empty decide every cadence.
    liveObserveWindowS: positiveNumberOrUndefined(env.LIVE_OBSERVE_WINDOW_S),
    // ADAAAA-7777 (lever B, trim 1): the live window's frame budget.
    // ADAAAA-8074: THE single decide image budget. Default 4 (the ruled AC-3
    // cell); a value is clamped to [1, 30], and an unparseable/empty env falls
    // back to 4 rather than 30 (an empty string used to parse as 0 = off).
    liveObserveMaxFrames: resolveDecideImageBudget(env.LIVE_OBSERVE_MAX_FRAMES),
    // ADAAAA-7777 (lever B, trim 2): the window audio CLIP on the live decide
    // payload. The audio-energy level curve (noise-change trigger contract) is
    // still computed from `audioContext`; only the raw clip is gated here.
    liveDecideAudioClip: env.LIVE_DECIDE_AUDIO_CLIP !== "0",
    // ADAAAA-8081: the live ASR side lane (see asr-prefetch.ts). Default ON —
    // the transcription leaves the decide call and the decide slot; `=0` is the
    // config-only rollback to the pre-8081 inline-ASR request.
    liveDecideAsrPrefetch: env.LIVE_DECIDE_ASR_PREFETCH !== "0",
    liveDecideAsrPrefetchTimeoutMs: positiveNumberOrUndefined(env.LIVE_DECIDE_ASR_PREFETCH_TIMEOUT_MS) ?? 6000,
    // ADAAAA-7777 (lever B, trim 3): the Stage-2 /confirm dive on the live rail.
    // `DECIDE_CONFIRM_ENABLED` remains the master gate.
    liveDecideConfirm: env.LIVE_DECIDE_CONFIRM !== "0",
    // ADAAAA-8205: the async lane is ON by default (the live accept path must not
    // pay the dive); `LIVE_CONFIRM_ASYNC=0` restores the inline awaited dive and
    // is a strict no-op when the master gate is off.
    liveConfirmAsync: env.LIVE_CONFIRM_ASYNC !== "0",
    // ADAAAA-8205: the parent envelope's per-stream dive budget.
    liveConfirmMaxDivesPer300S: positiveNumberOrUndefined(env.LIVE_CONFIRM_MAX_DIVES_PER_300S) ?? 8,
    // ADAAAA-7781: the COMPACT live verdict contract (decode-bound throughput —
    // see AnalyzerConfig.liveDecideCompact). Opt-in: unset keeps the full
    // contract byte-identical for both rails.
    liveDecideCompact: env.LIVE_DECIDE_COMPACT === "1",
    // ADAAAA-8064 (AC-C4): the timeline source. Default observations (shipped
    // construction); `=seeds` reproduces the pre-fix construction for the paired
    // latency measurement. Anything else is the default — an A/B lever never
    // becomes a posture by typo.
    livePerceiveTimelineSource: env.LIVE_PERCEIVE_TIMELINE_SOURCE === "seeds" ? "seeds" : "observations",
    // ADAAAA-8108 (AC-E3): the live decide ENRICHMENT arm (see
    // AnalyzerConfig.liveDecideEnrich). Default `on` = the shipped posture, so an
    // unset env is byte-identical; `off` / `alternate` are the measurement arms
    // and anything else normalises back to `on` (a lever never becomes a posture
    // by typo).
    liveDecideEnrich:
      env.LIVE_DECIDE_ENRICH === "off"
        ? "off"
        : env.LIVE_DECIDE_ENRICH === "alternate"
          ? "alternate"
          : "on",
    // ADAAAA-7758: one live decide slot per box (opt-in). Off by default: the
    // queued-stream wording is a CEO decision (ADAAAA-7757), so the shipped
    // behaviour only changes once the flag is enabled on the deployment.
    liveDecideAdmission: env.LIVE_DECIDE_ADMISSION === "1",
    // ADAAAA-7799 (lever C): decide-rate cap. Only parsed when set, so an unset
    // env keeps the unbounded pass; an empty/garbage value normalises to off in
    // LiveObserver (anything outside 0 < r < 1).
    liveDecideKeepRatio: env.LIVE_DECIDE_KEEP_RATIO !== undefined ? Number(env.LIVE_DECIDE_KEEP_RATIO) : undefined,
    // ADAAAA-7007/7011: wire the VOD decide-observer into the detail-first VOD
    // job path. Opt in with OBSERVE_LOOP=1 (default off; the candidate-gated VOD
    // baseline stays the behavior until the observer pass is validated).
    observeLoop: env.OBSERVE_LOOP === "1",
    observeSignalGate: env.OBSERVE_SIGNAL_GATE === "1",
    // ADAAAA-7878: issue observe decides OFF the frame-consume loop. Default ON
    // (the whole point of the change); an explicit `0`/`false`/`off` reproduces
    // today's serial in-loop decide so a measured regression can be reverted
    // without a code revert.
    observeDecideOffLoop: !["0", "false", "off"].includes(String(env.OBSERVE_DECIDE_OFFLOOP ?? "1").trim().toLowerCase()),
    // ADAAAA-7878: VOD off-loop decide depth (default 1 = the pre-fix decide
    // rate/concurrency; the ingest loop is what gets unblocked).
    observeDecideInFlight: Math.max(1, Math.floor(positiveNumberOrUndefined(env.OBSERVE_DECIDE_IN_FLIGHT) ?? 1)),
    // ADAAAA-7878: bounded pending-window queue for the off-loop VOD pass.
    observeDecideQueueMax: Math.max(1, Math.floor(positiveNumberOrUndefined(env.OBSERVE_DECIDE_QUEUE_MAX) ?? 512)),
    // ADAAAA-7147: when the Tier-2 signal gate is on, use the calibration-free
    // ball-velocity signal as the escalation discriminator on an uncalibrated
    // box (no goal-line/homography/scoreboard channel) so the gate actually
    // suppresses quiet non-goal windows and cuts decide volume. A frame is a
    // "meaningful ball" at/above this image-space `speedMps` threshold
    // (`OBSERVE_SIGNAL_GATE_BALL_MIN_SPEED`, default 0.08). `suppressQuiet`
    // enables the quiet-uncalibrated suppression (default off; recall-safe
    // escalate stays the default until box QA confirms goal recall under it).
    observeSignalGateBallMinSpeedMps: env.OBSERVE_SIGNAL_GATE_BALL_MIN_SPEED !== undefined ? Number(env.OBSERVE_SIGNAL_GATE_BALL_MIN_SPEED) : undefined,
    observeSignalGateSuppressQuiet: env.OBSERVE_SIGNAL_GATE_SUPPRESS_QUIET === "1",
    // ADAAAA-7152 Gap 1: adaptive perceive cadence for the VOD detail-first pass.
    // Tri-state: PERCEIVE_CADENCE=1 forces on (=0 forces off); unset auto-enables
    // exactly when OBSERVE_LOOP + OBSERVE_SIGNAL_GATE are both on (the gated VOD
    // detail-first pass the gap targets). The cool-region stride and the
    // full-perceive hot window after an escalation are separately tunable.
    // ADAAAA-7774 frame-consumption rate (content fps); ADAAAA-8102 routes it
    // through the empty-means-unset guard so compose's `${X:-}` cannot read as
    // "stride disabled" (`Number("")` is 0) while an explicit 0 still keeps its
    // documented opt-out meaning.
    liveObserveContentFps: finiteNumberOrUndefined(env.LIVE_OBSERVE_CONTENT_FPS),
    livePerceiveUtilization: env.LIVE_PERCEIVE_UTILIZATION !== undefined ? Number(env.LIVE_PERCEIVE_UTILIZATION) : undefined,
    perceiveCadence: env.PERCEIVE_CADENCE === "1" ? true : env.PERCEIVE_CADENCE === "0" ? false : undefined,
    perceiveQuietStride: env.PERCEIVE_QUIET_STRIDE !== undefined ? Number(env.PERCEIVE_QUIET_STRIDE) : undefined,
    perceiveHotAfterS: env.PERCEIVE_HOT_AFTER_S !== undefined ? Number(env.PERCEIVE_HOT_AFTER_S) : undefined,
    // ADAAAA-7152 (Gap 2): per-camera pitch calibration (homography + goalLine)
    // the server forwards to a perceive session via the `configure` control.
    // Sourced ONLY from explicit config (`PERCEIVE_CALIBRATION_JSON`, a JSON map
    // keyed by camera id with a reserved `default` entry). Unset / malformed =>
    // `undefined` => the server sends no calibration => perceive stays
    // uncalibrated (recall-safe, unchanged). Never fabricated.
    perceiveCalibration: parsePerceiveCalibration(env.PERCEIVE_CALIBRATION_JSON),
    // ADAAAA-5342: live sampling driven from the runner's measured capability
    // (mirroring the VOD mechanism): a live-specific ceiling (10) plus a 10%
    // headroom so capable GPUs accelerate toward the chartered cadence while
    // the runner never sits at its sustained max; CPU (which reports interval
    // >= 1.0) stays at ~1 fps via the base-cadence floor. Tunable without a
    // redeploy via LIVE_SAMPLE_MAX_FPS / LIVE_SAMPLE_HEADROOM.
    liveSampleMaxFps: Number(env.LIVE_SAMPLE_MAX_FPS ?? 10),
    // ADAAAA-6796 (Stage 1): LIVE primary-pass decide-read sampling baseline.
    // Raised to 3 fps (from the ~1 fps sampleIntervalSec floor) so the decide
    // read sees the crossing/conversion instant for every live job. Tunable per
    // deployment via LIVE_SAMPLE_BASE_FPS.
    liveSampleBaseFps: Number(env.LIVE_SAMPLE_BASE_FPS ?? 3),
    liveSampleHeadroom: Number(env.LIVE_SAMPLE_HEADROOM ?? 0.9),
    // ADAAAA-7901: the session secret is validated in production (unset or a
    // documented default throws at boot) and the export secret is derived from
    // it (or taken from EXPORT_TOKEN_SECRET), so an export token can never be
    // promoted to a session.
    jwtSecret,
    exportTokenSecret,
    resetTokenTtlSec: Number(env.RESET_TOKEN_TTL_SEC ?? 3600),
    authRateLimit: Number(env.AUTH_RATE_LIMIT ?? 30),
    authRateLimitWindowSec: Number(env.AUTH_RATE_LIMIT_WINDOW_SEC ?? 60),
    adminEmail: env.ADMIN_EMAIL ?? "admin@highlights.local",
    // ADAAAA-7904: resolved above — production refuses the published default.
    adminPassword,
    webappDist: env.WEBAPP_DIST || "",
    trainArtifactRoot: env.TRAIN_ARTIFACT_ROOT || path.join(env.DATA_DIR ?? "data", "train-artifacts"),
    // Increment A (the annotation loop) publishes curated train/val manifests
    // to <dataDir>/../evals via /training/manifests — this is the default feed
    // dir the fine-tune curated trigger reads from.
    curatedManifestDir: env.CURATED_MANIFEST_DIR || path.join(env.DATA_DIR ?? "data", "..", "evals"),
    databasePath: env.DATABASE_PATH ?? "data/highlights.db",
    databaseUrl: env.DATABASE_URL,
    decideAuditRetention: Number(env.DECIDE_AUDIT_RETENTION ?? 2000),
    databaseBackupDir: env.DATABASE_BACKUP_DIR ?? "data/backups",
    emailSenderUrl: env.EMAIL_SENDER_URL,
    mailerToken: env.MAILER_TOKEN || env.EMAIL_QUEUE_TOKEN,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    stripePricePro: env.STRIPE_PRICE_PRO,
    stripePriceUsage: env.STRIPE_PRICE_USAGE,
    publicBaseUrl: env.PUBLIC_BASE_URL ?? "http://127.0.0.1:3000",
    freeHighlights: Number(env.FREE_HIGHLIGHTS ?? 10),
    decideFee: Number(env.DECIDE_FEE ?? 0.01),
    // Stage-2 goal/near-miss confirmation pass config flag (ADAAAA-6797).
    // Default OFF; ADAAAA-7663 makes it gate BOTH the VOD and the live pass, so
    // a flag-off deploy keeps the Stage-1 path byte-identical on both.
    decideConfirmEnabled: env.DECIDE_CONFIRM_ENABLED === "1",
    decideConfirmExtraWindowS: Number(env.DECIDE_CONFIRM_EXTRA_WINDOW_S ?? 4),
    // ADAAAA-7663: live exactly-once confirm horizon (see ServerConfig).
    decideConfirmLiveReuseWindowS: Number(env.DECIDE_CONFIRM_LIVE_REUSE_WINDOW_S ?? 12),
    freeDecides: Number(env.FREE_DECIDES ?? 5),
    billingWireframe: env.BILLING_WIREFRAME === "1" || env.BILLING_WIREFRAME === "true",
    betaClipQuota: Number(env.BETA_CLIP_QUOTA ?? 10),
    proClipQuota: Number(env.PRO_CLIP_QUOTA ?? 100),
    betaGate: env.BETA_GATE === "1" || env.BETA_GATE === "true" || !env.BETA_GATE,
    funnelRetainDays: Number(env.FUNNEL_RETAIN_DAYS ?? 7),
    autoPublishHighlights: env.AUTO_PUBLISH_HIGHLIGHTS === "0" || env.AUTO_PUBLISH_HIGHLIGHTS === "false" ? false : true,
    rejectTtlMs: Number(env.REJECTED_CLIP_TTL_MS ?? 24 * 60 * 60 * 1000),
    rejectSweepIntervalMs: Number(env.REJECTED_CLIP_SWEEP_INTERVAL_MS ?? 60 * 60 * 1000),
    datasetPurgeSweepIntervalMs: Number(env.DATASET_PURGE_SWEEP_INTERVAL_MS ?? 60 * 60 * 1000),
    // Increment D (ADAAAA-6467): stream-start warm-up window + out-of-band
    // re-check cadence for the what-to-track planner. See the ServerConfig
    // field docs for the default rationale (3 s warm-up, 10 s recheck).
    warmupSeconds: Number(env.WARMUP_SECONDS ?? 3),
    recheckIntervalSeconds: Number(env.RECHECK_INTERVAL_SECONDS ?? 10),
    // ADAAAA-6489 / ADAAAA-7159 Gap 2: per-camera/per-clip goal-line calibration
    // (none by default; a clip with no entry is reported not_captured, never
    // fabricated). Keyed by job/clip id in the JSON env.
    goalLineCalibrations: parseGoalLineCalibrations(env.GOAL_LINE_CALIBRATIONS),
    // ADAAAA-6577: bounded exponential backoff between perceive session-lost
    // re-reserve/retry attempts (shared analyzeJob loop; see the ServerConfig
    // field docs for the recovery rationale).
    vodSessionRetryBackoffMs: Number(env.VOD_SESSION_RETRY_BACKOFF_MS ?? 500),
    vodSessionRetryBackoffMaxMs: Number(env.VOD_SESSION_RETRY_BACKOFF_MAX_MS ?? 8000),
    vodReserveRetryTotalMs: Number(env.VOD_RESERVE_RETRY_TOTAL_MS ?? 120000),
  };
}

/**
 * ADAAAA-7232: deliverable highlight clip window around `eventTs`, guaranteed
 * to be at least `minSec` long.
 *
 * The nominal window is `[eventTs - beforeS, eventTs + afterS]`. When the
 * nominal before+after sum falls short of the hard floor `minSec` (Acc-1:
 * >=15 s), the AFTER side is padded so the window always meets the minimum —
 * extra context/reaction after the flagged moment rather than trimming pre-roll
 * (which would risk dropping the raised-action lead-in). A negative/clamped
 * `beforeS` is floored at 0.
 */
export function clipWindow(
  eventTs: number,
  beforeS: number,
  afterS: number,
  minSec = 15
): { start: number; end: number } {
  const b = Math.max(0, beforeS);
  let a = Math.max(0, afterS);
  const min = Math.max(0, minSec);
  if (b + a < min) a += min - (b + a);
  let start = Math.max(0, eventTs - b);
  let end = eventTs + a;
  // Clamping `start` to 0 (very early event near stream start) shortens the
  // window; extend the END so the delivered clip still meets the floor.
  if (end - start < min) end = start + min;
  return { start, end };
}

// ---------------------------------------------------------------------------
// ADAAAA-7247 (ACC-7): per-company clip-window setting validation.
//
// The webui can set whole-second `clipBeforeS` / `clipAfterS` (defaults 7/8).
// The server validates them here (single source of truth, shared by the PUT
// endpoint and any caller that persists a value). The >=15 s delivery floor is
// NOT enforced here — it is guaranteed at assembly by `clipWindow` (which pads
// the after side to `minSec`), so NO persisted setting can ever produce a
// delivered clip <15 s (ACC-1). What this rejects is the invalid territory the
// webui must surface with a clear message: non-numeric, non-integer, negative,
// or out-of-range (per-side) values.
// ---------------------------------------------------------------------------
/** Hard per-side ceiling for a clip-window value (10 min) — bounds a bad UI. */
export const CLIP_WINDOW_MAX_SIDE_S = 600;

export interface ClipWindowValidation {
  ok: boolean;
  minSec: number;
  /** Validated whole-second values (present only when ok). */
  clipBeforeS?: number;
  clipAfterS?: number;
  /** Nominal pre+post window in seconds (before+after; clipWindow may pad it). */
  windowSec?: number;
  /** Clear, human-readable rejection reason (present only when !ok). */
  error?: string;
}

/**
 * Validate a webui-submitted clip-window pair. Returns `{ ok, ... }` on
 * success (the whole-second values to persist + the nominal window) or
 * `{ ok:false, error }` with a message the webui can surface verbatim. The
 * >=15 s floor is enforced downstream by `clipWindow`, not here.
 */
export function validateClipWindow(
  beforeS: unknown,
  afterS: unknown,
  minSec: number = 15
): ClipWindowValidation {
  const problems: string[] = [];
  const isWholeSec = (v: unknown, name: string): v is number => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      problems.push(`${name} must be a number of whole seconds`);
      return false;
    }
    if (!Number.isInteger(v)) {
      problems.push(`${name} must be a whole number of seconds`);
      return false;
    }
    return true;
  };
  const beforeOk = isWholeSec(beforeS, "clipBeforeS");
  const afterOk = isWholeSec(afterS, "clipAfterS");
  if (!beforeOk || !afterOk) return { ok: false, minSec, error: problems.join("; ") };
  const before = beforeS as number;
  const after = afterS as number;
  if (before < 0 || after < 0) {
    return {
      ok: false,
      minSec,
      error: `clipBeforeS and clipAfterS must each be 0 or more seconds (got ${before} / ${after})`,
    };
  }
  if (before > CLIP_WINDOW_MAX_SIDE_S || after > CLIP_WINDOW_MAX_SIDE_S) {
    return {
      ok: false,
      minSec,
      error: `clipBeforeS / clipAfterS are capped at ${CLIP_WINDOW_MAX_SIDE_S}s each (10 min)`,
    };
  }
  return { ok: true, minSec, clipBeforeS: before, clipAfterS: after, windowSec: before + after };
}
