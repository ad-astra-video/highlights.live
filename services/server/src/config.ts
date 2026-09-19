export interface ServerConfig {
  port: number;
  /** Orchestrator public URL (offchain lab) or gateway URL. */
  orchestratorUrl: string;
  /** When set, bypass the orchestrator and call runners directly (dev). */
  perceiveUrl?: string;
  decideUrl?: string;
  /** Media server (gateway terminus + payer) base URL. When set, browser media
   * frames route browser -> media-server WS -> orchestrator video-in instead of
   * the server's /jobs/:id/ingest HTTP rail. */
  mediaServerUrl?: string;
  /** go-livepeer remote signer base URL (on-chain). Internal-only on Railway. */
  signerUrl?: string;
  /** Where VOD sources + clips live. */
  dataDir: string;
  /** In-container path prefix at which the perceive runner sees this server's
   * dataDir (shared volume). Used to hand perceive the per-JOB recorded stream
   * so its persistent session SAM-tracker opens THAT clip (tracking across the
   * whole stream), rather than a server-side path perceive can't read. */
  perceiveClipRoot: string;
  ffmpegPath: string;
  gameHintDefault: string;
  clipBeforeS: number;
  clipAfterS: number;
  /** Seconds between frames when the perceive runner's capability can't be
   * queried (orchestrator mode); with PERCEIVE_URL set the runner's measured
   * sample_interval_s is used instead. */
  sampleIntervalSec: number;
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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 3000),
    orchestratorUrl: env.ORCHESTRATOR_URL ?? "http://127.0.0.1:8935",
    perceiveUrl: env.PERCEIVE_URL,
    decideUrl: env.DECIDE_URL,
    mediaServerUrl: env.MEDIA_SERVER_URL,
    signerUrl: env.SIGNER_URL,
    dataDir: env.DATA_DIR ?? "data",
    perceiveClipRoot: env.PERCEIVE_CLIP_ROOT ?? "/data",
    ffmpegPath: env.FFMPEG_PATH ?? "ffmpeg",
    gameHintDefault: env.GAME_HINT ?? "unspecified",
    clipBeforeS: Number(env.CLIP_BEFORE_S ?? 4),
    clipAfterS: Number(env.CLIP_AFTER_S ?? 4),
    sampleIntervalSec: Number(env.SAMPLE_INTERVAL_SEC ?? 1.0),
    jwtSecret: env.JWT_SECRET ?? "dev-insecure-secret-change-me",
    resetTokenTtlSec: Number(env.RESET_TOKEN_TTL_SEC ?? 3600),
    authRateLimit: Number(env.AUTH_RATE_LIMIT ?? 30),
    authRateLimitWindowSec: Number(env.AUTH_RATE_LIMIT_WINDOW_SEC ?? 60),
    adminEmail: env.ADMIN_EMAIL ?? "admin@highlights.local",
    adminPassword: env.ADMIN_PASSWORD ?? "admin",
    webappDist: env.WEBAPP_DIST || "",
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
  };
}
