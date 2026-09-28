import path from "node:path";

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
  /** When set, bypass the orchestrator and call the train runner directly (dev).
   * No train container ships with the local stack today, so this stays unset
   * and direct train calls fail with a clear error until a TRAIN_URL is wired. */
  trainUrl?: string;
  /** Media server (gateway terminus + payer) base URL. When set, browser media
   * frames route browser -> media-server WS -> orchestrator video-in instead of
   * the server's /jobs/:id/ingest HTTP rail. */
  mediaServerUrl?: string;
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
  ffmpegPath: string;
  gameHintDefault: string;
  /** Target window (seconds) around the flagged event for a delivered highlight
   * clip. cutClip trims `[event - clipBeforeS, event + clipAfterS]`, so the
   * total delivered clip is `clipBeforeS + clipAfterS` seconds centered on the
   * event. ADAAAA-5059: defaults were 4/4 (an 8s window that read as the whole
   * segment); reduced to 2/2 (4s, "the moment") — short enough to read as the
   * flagged moment while keeping pre-roll context and post-roll reaction.
   * Tunable per-deployment via CLIP_BEFORE_S / CLIP_AFTER_S; recommended window
   * is ~1.5-2s each side of the event. */
  clipBeforeS: number;
  clipAfterS: number;
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
   * Deeper than the live 1 fps share; default 2. `VOD_DETAIL_FPS`. */
  vodDetailFps: number;
  /** Hard ceiling on LIVE source sampling (frames/second) when the perceive
   * runner reports it can sustain more than `sampleIntervalSec`. ADAAAA-5342:
   * live sampling is driven from the runner's measured capability (mirroring
   * VOD) and this bounds it toward the "3 live / 8 VOD" charter — default 10,
   * above the VOD ceiling because live holds the runner open for a stream and
   * samples its own cadence. `LIVE_SAMPLE_MAX_FPS` = 10. */
  liveSampleMaxFps: number;
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
  /** Detail-first VOD decide temporal window length (spec knob
   * `decideWindowN`, default 24 > live 16). Frames forwarded to decide()'s
   * `frames[]` so Gemma reasons across a longer SEQUENCE per trigger.
   * `VOD_DECIDE_WINDOW_N`. */
  vodDecideWindowN: number;
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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 3000),
    nodeEnv: env.NODE_ENV ?? "development",
    orchestratorUrl: env.ORCHESTRATOR_URL ?? "http://127.0.0.1:8935",
    perceiveUrl: env.PERCEIVE_URL,
    decideUrl: env.DECIDE_URL,
    trainUrl: env.TRAIN_URL,
    mediaServerUrl: env.MEDIA_SERVER_URL,
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
    ffmpegPath: env.FFMPEG_PATH ?? "ffmpeg",
    gameHintDefault: env.GAME_HINT ?? "unspecified",
    // ADAAAA-5059: trim the delivered highlight to a defined window around the
    // flagged event (~2s pre-roll + ~2s post-roll = 4s total) instead of the
    // previous 8s window that read as the whole segment. Tunable via env.
    clipBeforeS: Number(env.CLIP_BEFORE_S ?? 2),
    clipAfterS: Number(env.CLIP_AFTER_S ?? 2),
    sampleIntervalSec: Number(env.SAMPLE_INTERVAL_SEC ?? 1.0),
    // ADAAAA-5059: VOD default sampling moved up to 5 fps (from the previous
    // 1 fps fallback); still bounded above by VOD_SAMPLE_MAX_FPS (8) and
    // overridable per job. Keep the live path's sampleIntervalSec untouched.
    vodSampleFpsDefault: Number(env.VOD_SAMPLE_FPS_DEFAULT ?? 5),
    vodSampleMaxFps: Number(env.VOD_SAMPLE_MAX_FPS ?? 8),
    vodDetailFps: Number(env.VOD_DETAIL_FPS ?? 2),
    vodFrameScale: env.VOD_FRAME_SCALE ?? "640:360",
    vodDecideWindowN: Number(env.VOD_DECIDE_WINDOW_N ?? 24),
    // ADAAAA-5342: live sampling driven from the runner's measured capability
    // (mirroring the VOD mechanism): a live-specific ceiling (10) plus a 10%
    // headroom so capable GPUs accelerate toward the chartered cadence while
    // the runner never sits at its sustained max; CPU (which reports interval
    // >= 1.0) stays at ~1 fps via the base-cadence floor. Tunable without a
    // redeploy via LIVE_SAMPLE_MAX_FPS / LIVE_SAMPLE_HEADROOM.
    liveSampleMaxFps: Number(env.LIVE_SAMPLE_MAX_FPS ?? 10),
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
    freeDecides: Number(env.FREE_DECIDES ?? 5),
    billingWireframe: env.BILLING_WIREFRAME === "1" || env.BILLING_WIREFRAME === "true",
    betaClipQuota: Number(env.BETA_CLIP_QUOTA ?? 10),
    betaGate: env.BETA_GATE === "1" || env.BETA_GATE === "true" || !env.BETA_GATE,
    autoPublishHighlights: env.AUTO_PUBLISH_HIGHLIGHTS === "0" || env.AUTO_PUBLISH_HIGHLIGHTS === "false" ? false : true,
    rejectTtlMs: Number(env.REJECTED_CLIP_TTL_MS ?? 24 * 60 * 60 * 1000),
    rejectSweepIntervalMs: Number(env.REJECTED_CLIP_SWEEP_INTERVAL_MS ?? 60 * 60 * 1000),
    datasetPurgeSweepIntervalMs: Number(env.DATASET_PURGE_SWEEP_INTERVAL_MS ?? 60 * 60 * 1000),
  };
}
