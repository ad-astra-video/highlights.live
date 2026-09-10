export interface ServerConfig {
  port: number;
  /** Orchestrator public URL (offchain lab) or gateway URL. */
  orchestratorUrl: string;
  /** When set, bypass the orchestrator and call runners directly (dev). */
  perceiveUrl?: string;
  decideUrl?: string;
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
  /** Seeded dev admin account (email + password). Override in prod. */
  adminEmail: string;
  adminPassword: string;
  /** SQLite database file path. */
  databasePath: string;
  /** Stripe */
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  /** Stripe Price ID for the Pro subscription (fixed monthly base). */
  stripePricePro?: string;
  /** Stripe Price ID for the metered (usage-based) overage line. */
  stripePriceUsage?: string;
  /** Public base URL (for Stripe return URLs). */
  publicBaseUrl: string;
  /** Free plan included-highlights cap (0 blocks free farming). */
  freeHighlights: number;
  /** Dev-only: wireframe billing (no real Stripe). Enables /dev/billing/*. */
  billingWireframe: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 3000),
    orchestratorUrl: env.ORCHESTRATOR_URL ?? "http://127.0.0.1:8935",
    perceiveUrl: env.PERCEIVE_URL,
    decideUrl: env.DECIDE_URL,
    signerUrl: env.SIGNER_URL,
    dataDir: env.DATA_DIR ?? "data",
    perceiveClipRoot: env.PERCEIVE_CLIP_ROOT ?? "/data",
    ffmpegPath: env.FFMPEG_PATH ?? "ffmpeg",
    gameHintDefault: env.GAME_HINT ?? "unspecified",
    clipBeforeS: Number(env.CLIP_BEFORE_S ?? 4),
    clipAfterS: Number(env.CLIP_AFTER_S ?? 4),
    sampleIntervalSec: Number(env.SAMPLE_INTERVAL_SEC ?? 1.0),
    jwtSecret: env.JWT_SECRET ?? "dev-insecure-secret-change-me",
    adminEmail: env.ADMIN_EMAIL ?? "admin@highlights.local",
    adminPassword: env.ADMIN_PASSWORD ?? "admin",
    databasePath: env.DATABASE_PATH ?? "data/highlights.db",
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    stripePricePro: env.STRIPE_PRICE_PRO,
    stripePriceUsage: env.STRIPE_PRICE_USAGE,
    publicBaseUrl: env.PUBLIC_BASE_URL ?? "http://127.0.0.1:3000",
    freeHighlights: Number(env.FREE_HIGHLIGHTS ?? 3),
    billingWireframe: env.BILLING_WIREFRAME === "1" || env.BILLING_WIREFRAME === "true",
  };
}
