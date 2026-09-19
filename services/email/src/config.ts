// The email-sender container holds the mailbox SMTP credentials for sending as
// onboarding@highlights.live. Everything secret comes from env (bound as
// Paperclip secrets / Docker secrets in prod) — never from this file, and never
// committed. In local/dev (no SMTP_HOST set) the service runs in "log" mode
// where sends are logged and recorded as sent, so the queue + API can be
// exercised without real SMTP credentials.

export interface EmailSenderConfig {
  port: number;
  /** Postgres connection string (prod). When set, uses Postgres; else the
   * SQLite dev DB at databasePath (shared with the API server). */
  databaseUrl?: string;
  databasePath: string;
  databaseBackupDir: string;

  /** Queue API auth: requests to POST /emails must carry
   * `Authorization: Bearer *** The API server is configured with the
   * same token. When unset (dev only), the API is unauthenticated. */
  queueToken?: string;

  /** Source allow-list (security hard gate, ADAAAA-2475): comma-separated
   * IPs / CIDRs (e.g. "10.0.0.0/8,127.0.0.1"). When non-empty, the enqueue
   * and status APIs reject (403) any request whose source address is not in
   * the list — applied in addition to the bearer token. Empty = no source
   * restriction (local dev). Credentials and endpoints stay secret-auth by
   * default; this narrows callers to known services/subnets. */
  allowlistIps: string[];

  // --- SMTP transport ---
  smtpHost?: string;
  smtpPort: number;
  /** STARTTLS when true (port 587); implicit TLS when smtpSecure is set on 465. */
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPass?: string;
  /** requireTLS: don't send unless the connection is encrypted. */
  smtpRequireTls: boolean;

  /** From / Reply-To addresses for every send. Defaults to the onboarding
   * alias on the support@highlights.live mailbox. */
  fromEmail: string;
  replyToEmail: string;
  fromName: string;

  /** Worker polling: process up to `batchSize` sends every `pollIntervalMs`. */
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  /** Base for exponential backoff between retries: delay = base * 2^(attempt-1). */
  retryBaseMs: number;
}

export function loadEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailSenderConfig {
  return {
    port: Number(env.EMAIL_PORT ?? 3001),
    databaseUrl: env.DATABASE_URL,
    databasePath: env.DATABASE_PATH ?? "data/highlights.db",
    databaseBackupDir: env.DATABASE_BACKUP_DIR ?? "data/backups",
    queueToken: env.EMAIL_QUEUE_TOKEN || env.MAILER_TOKEN || undefined,
    allowlistIps: (env.EMAIL_ALLOW_IPS || "").split(",").map((s) => s.trim()).filter(Boolean),
    smtpHost: env.SMTP_HOST,
    smtpPort: Number(env.SMTP_PORT ?? (env.SMTP_SECURE === "1" ? 465 : 587)),
    smtpSecure: env.SMTP_SECURE === "1" || env.SMTP_SECURE === "true",
    smtpUser: env.SMTP_USER,
    smtpPass: env.SMTP_PASS,
    smtpRequireTls: env.SMTP_REQUIRE_TLS === "1" || env.SMTP_REQUIRE_TLS === "true",
    fromEmail: env.EMAIL_FROM ?? "onboarding@highlights.live",
    replyToEmail: env.EMAIL_REPLY_TO ?? "onboarding@highlights.live",
    fromName: env.EMAIL_FROM_NAME ?? "Highlights",
    pollIntervalMs: Number(env.EMAIL_POLL_INTERVAL_MS ?? 5000),
    batchSize: Number(env.EMAIL_BATCH_SIZE ?? 10),
    maxAttempts: Number(env.EMAIL_MAX_ATTEMPTS ?? 3),
    retryBaseMs: Number(env.EMAIL_RETRY_BASE_MS ?? 30_000),
  };
}
