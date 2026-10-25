import path from "node:path";
import type { GoalLineCalibration } from "./analyzer";
import { parsePerceiveCalibration, type PerceiveCalibrationMap } from "./perceive-calibration";

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
  decideUrl?: string;
  /** ADAAAA-6911: server-side knob for the livepeer-session decide-runner gate
   * (`DECIDE_CONCURRENCY`). Left unset -> the client keeps its default (decide
   * runner capacity 2); set to 1 to reproduce the capacity-1 serial baseline
   * for the AC1 on-box measurement. */
  decideConcurrency?: number;
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
  /** Hard cap (bytes) for a single browser VOD upload. Default 2 GB
   * (`VOD_MAX_UPLOAD_BYTES`, default `2147483648`). The server rejects any
   * multipart upload larger than this with 413 before any compute is queued;
   * the webapp mirrors it as a client-side pre-check. Keep at 2 GB — raising
   * it increases billed Livepeer GPU time per job (see ADAAAA-2983). */
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
  /** Max VOD jobs a worker drains concurrently (ADAAAA-6873). Each running job
   * holds one perceive session, so this gates GPU concurrency. `VOD_WORKER_CONCURRENCY`. */
  vodWorkerConcurrency: number;
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
   * VOD pass runs the decide `/confirm` deep-frame-dive for un-attested
   * goal-type candidates and adopts the reconciled verdict. Wired from
   * `DECIDE_CONFIRM_ENABLED` (default "0"). VOD-first: only the VOD pass reads
   * this flag (the live pass never sets `confirmEnabled`), so rollout is safe. */
  decideConfirmEnabled: boolean;
  /** ADAAAA-7162: extra seconds (each side) the Stage-2 confirmation frame
   * window is expanded beyond the Stage-1 pre/post window. `DECIDE_CONFIRM_EXTRA_WINDOW_S`
   * (default 4). */
  decideConfirmExtraWindowS: number;
  /** Free plan included decide calls before gating (dev-friendly). */
  freeDecides: number;
  /** Dev-only: wireframe billing (no real Stripe). Enables /dev/billing/*. */
  billingWireframe: boolean;
  /** Per-user per-calendar-month clip quota during the beta (the entitlement
   * ledger's hard-stop; no billing during beta). Default 10 clips/month. */
  betaClipQuota: number;
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

function parseGoalLineCalibrations(raw: string | undefined): Record<string, GoalLineCalibration> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, GoalLineCalibration>) : undefined;
  } catch {
    return undefined;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 3000),
    nodeEnv: env.NODE_ENV ?? "development",
    orchestratorUrl: env.ORCHESTRATOR_URL ?? "http://127.0.0.1:8935",
    perceiveUrl: env.PERCEIVE_URL,
    decideUrl: env.DECIDE_URL,
    decideConcurrency: env.DECIDE_CONCURRENCY ? Number(env.DECIDE_CONCURRENCY) : undefined,
    trainUrl: env.TRAIN_URL,
    mediaServerUrl: env.MEDIA_SERVER_URL,
    mediaPublicBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
    signerUrl: env.SIGNER_URL,
    signerAuthToken: env.SIGNER_AUTH_TOKEN,
    payerAddress: env.PAYER_ADDRESS,
    dataDir: env.DATA_DIR ?? "data",
    perceiveClipRoot: env.PERCEIVE_CLIP_ROOT ?? "/data",
    // VOD_MAX_UPLOAD_BYTES is parsed and compared STRICTLY in bytes (Number(), no
    // unit coercion — a value like "2048" means 2048 bytes, never 2 GB). The cap,
    // the multipart fileSize margin, the upload byte counter and the client pre-check
    // all compare in bytes; only human-facing messages render units (api.formatBytes).
    // See the vodMaxUploadBytes prop comment for the default (2147483648 = 2 GB).
    vodMaxUploadBytes: Number(env.VOD_MAX_UPLOAD_BYTES ?? 2147483648),
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
    vodWorkerConcurrency: Number(env.VOD_WORKER_CONCURRENCY ?? 1),
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
    // ADAAAA-7007/7011: wire the VOD decide-observer into the detail-first VOD
    // job path. Opt in with OBSERVE_LOOP=1 (default off; the candidate-gated VOD
    // baseline stays the behavior until the observer pass is validated).
    observeLoop: env.OBSERVE_LOOP === "1",
    observeSignalGate: env.OBSERVE_SIGNAL_GATE === "1",
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
    jwtSecret: env.JWT_SECRET ?? "dev-insecure-secret-change-me",
    resetTokenTtlSec: Number(env.RESET_TOKEN_TTL_SEC ?? 3600),
    authRateLimit: Number(env.AUTH_RATE_LIMIT ?? 30),
    authRateLimitWindowSec: Number(env.AUTH_RATE_LIMIT_WINDOW_SEC ?? 60),
    adminEmail: env.ADMIN_EMAIL ?? "admin@highlights.local",
    adminPassword: env.ADMIN_PASSWORD ?? "admin",
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
    // Default OFF (VOD-first rollout); the VOD pass reads it. Only when "1" do
    // the VOD candidates go through the decide /confirm deep frame dive.
    decideConfirmEnabled: env.DECIDE_CONFIRM_ENABLED === "1",
    decideConfirmExtraWindowS: Number(env.DECIDE_CONFIRM_EXTRA_WINDOW_S ?? 4),
    freeDecides: Number(env.FREE_DECIDES ?? 5),
    billingWireframe: env.BILLING_WIREFRAME === "1" || env.BILLING_WIREFRAME === "true",
    betaClipQuota: Number(env.BETA_CLIP_QUOTA ?? 10),
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
