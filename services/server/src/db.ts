// Durable persistence behind one async `Db` interface:
//   - SqliteDb  (dev): Node's built-in `node:sqlite`, no native build step.
//   - PgDb      (prod): PostgreSQL via node-postgres (`pg`), selected when
//                      `DATABASE_URL` is set.
// Holds users, entitlements/subscriptions, usage, media sessions, AND the
// pipeline's jobs + highlight records. The Store (store.ts) is a durable
// write-through facade over this Db, so stateful data survives restarts.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { Job, HighlightRecord } from "@highlights/events";

// `node:sqlite` is experimental and not in Vite/vitest's builtin external
// list, so load it via createRequire at runtime instead of a static ESM import
// (which vite-node rewrites to a bare broken id).
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { Pool } from "pg";
import type { Pool as PoolType } from "pg";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: "admin" | "user";
  createdAt: string;
  stripeCustomerId: string | null;
  /** ISO expiry of the current password-reset token (optional — only populated
   * by the reset-token lookup; normal user fetches leave it unset). */
  resetTokenExpires?: string | null;
  /** ISO timestamp when the account passed the invite/beta-gate (activated).
   * `null`/unset means the waitlisted email was never invited or the invite
   * code never redeemed — such accounts may not reach the product. Admins are
   * always activated (seeded) and are exempt from the gate. */
  betaActivatedAt?: string | null;
}

/** A waitlist signup (public capture). Flipped to `invited` by the cohort
 * owner to grant account activation for that email (invite path "b"). */
export interface WaitlistEntry {
  id: string;
  email: string;
  status: "waitlisted" | "invited";
  invitedAt: string | null;
  createdAt: string;
}

/** A single-use invite code issued by the cohort owner (invite path "a").
 * Stored as a SHA-256 hash; the plaintext code is shown to the owner once at
 * issuance and handed out of band. */
export interface InviteCode {
  id: string;
  codeHash: string;
  /** Optional email the code is bound to; a bound code only activates that email. */
  email: string | null;
  createdBy: string;
  createdAt: string;
  usedBy: string | null;
  usedAt: string | null;
  revokedAt: string | null;
}

/** A transactional email send in the outbound queue (the email-sender
 * service). Lifecycle: `queued -> sending -> sent | failed`, with retry on
 * failure until `attempts >= maxAttempts`, then permanenly `failed`. Stored
 * here in the shared DB so both the API server (enqueue) and the email-sender
 * container (worker) operate on the same durable queue. */
export interface EmailSend {
  id: string;
  toEmail: string;
  subject: string;
  body: string;
  status: "queued" | "sending" | "sent" | "failed";
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  /** ISO timestamp for the earliest retry allowed (set on failure with retries
   * remaining); null means retry immediately (queued) or never (failed). */
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export interface Subscription {
  userId: string;
  tier: "free" | "pro";
  status: "active" | "past_due" | "canceled" | "trialing";
  stripeSubscriptionId: string | null;
  stripeSubItemId: string | null; // usage-based overage item on the sub
  currentPeriodEnd: string | null;
  updatedAt: string;
}

/** Public-beta telemetry snapshot backing the /admin/analytics endpoint
 * (ADAAAA-25): signups, clips generated, and paying-user conversion vs goal.
 * Derived live from the DB on each call. */
export interface AnalyticsSnapshot {
  usersTotal: number;
  usersActivated: number;
  waitlistTotal: number;
  waitlistInvited: number;
  clipsTotal: number;
  clipsUsed: number;
  usageEvents: number;
  subscriptions: { tier: string; status: string; count: number }[];
}

/** A live media-server session tracked by the control plane. Persisted so that
 * if a media node dies the server can detect the gap and re-route the browser
 * to a freshly-provisioned session on a healthy node (seamless reconnect).
 * `wsUrl` is the full LB-routable ingest URL the browser streams over;
 * `mediaOrigin` is the base used to health-check that node when deciding
 * whether to reuse vs re-provision.
 */
export interface MediaSession {
  jobId: string;
  sessionId: string;
  streamId: string;
  wsUrl: string;
  mediaOrigin: string;
  status: "active" | "closed";
  createdAt: string;
  updatedAt: string;
}

/** Async persistence contract shared by the SQLite (dev) and Postgres (prod) backends. */
export interface Db {
  close(): Promise<void>;
  createUser(u: Omit<User, "createdAt"> & { createdAt?: string }): Promise<User>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserById(id: string): Promise<User | undefined>;
  /** Look up a user by SHA-256 hash of their password-reset token (timing-safe
   * retrieval is handled by the caller hashing the token before hitting this). */
  getUserByResetToken(tokenHash: string): Promise<User | undefined>;
  /** Persist the (hashed) password-reset token + expiry for a user. */
  setResetToken(userId: string, tokenHash: string, expiresAt: string): Promise<void>;
  /** Clear the reset token (after a successful reset, or a refresh). */
  clearResetToken(userId: string): Promise<void>;
  /** Replace a user's password hash (used by password reset). */
  updatePassword(userId: string, passwordHash: string): Promise<void>;
  /** Mark a user's account as having passed the invite/beta-gate (activated). */
  activateUser(userId: string): Promise<void>;
  setStripeCustomer(userId: string, customerId: string): Promise<void>;
  getSubscription(userId: string): Promise<Subscription>;
  setSubscription(userId: string, s: Partial<Subscription>): Promise<Subscription>;
  countUsage(userId: string, eventType?: string): Promise<number>;
  recordUsage(userId: string, eventType?: string, extra?: string): Promise<void>;
  resetUsage(userId: string, eventType?: string): Promise<void>;
  getMediaSession(jobId: string): Promise<MediaSession | undefined>;
  setMediaSession(ms: MediaSession): Promise<void>;
  clearMediaSession(jobId: string): Promise<void>;
  /** Persist a job record (full JSON upsert by id). */
  saveJob(job: Job): Promise<void>;
  getJob(id: string): Promise<Job | undefined>;
  listJobs(): Promise<Job[]>;
  /** Persist a highlight record (full JSON upsert by id). */
  saveHighlight(h: HighlightRecord): Promise<void>;
  getHighlight(id: string): Promise<HighlightRecord | undefined>;
  listHighlights(): Promise<HighlightRecord[]>;
  /** Public waitlist: add an email, deduped by the normalized email (UNIQUE
   * constraint). Returns whether this call actually created a new entry vs the
   * email already being present (idempotent re-submission). */
  addWaitlistEmail(email: string): Promise<{ registered: boolean }>;
  /** All waitlist entries, oldest first (inspection + signup-rate counter). */
  listWaitlistEmails(): Promise<{ email: string; createdAt: string }[]>;
  /** Total waitlist sign-ups. */
  waitlistCount(): Promise<number>;
  /** Get a waitlist entry by normalized email, or undefined. */
  getWaitlist(email: string): Promise<WaitlistEntry | undefined>;
  /** Flip a waitlist email to `invited` (cohort owner granted activation).
   * Creates the entry if the email never signed up. Returns the entry. */
  setWaitlistInvited(email: string): Promise<WaitlistEntry>;
  /** All waitlist entries incl. status, newest first (admin gate inspection). */
  listWaitlist(): Promise<WaitlistEntry[]>;
  /** Public-beta telemetry snapshot (signups, clips, usage, subscriptions). */
  analytics(): Promise<AnalyticsSnapshot>;
  /** Get an invite code record by SHA-256 hash of the code. */
  getInviteByHash(codeHash: string): Promise<InviteCode | undefined>;
  /** Persist a new invite code (unused, unrevolved). */
  createInviteCode(ic: Omit<InviteCode, "usedBy" | "usedAt" | "revokedAt">): Promise<InviteCode>;
  /** Atomically claim a single-use invite code for `usedBy`. Returns the
   * claimed code, or undefined if already used, revoked, or unknown. The
   * UPDATE-with-guard makes the single-use claim race-free across requests. */
  claimInvite(codeHash: string, usedBy: string): Promise<InviteCode | undefined>;
  /** Revoke a (possibly unclaimed) invite code; a revoked code can never claim. */
  revokeInvite(codeHash: string): Promise<void>;
  listInvites(): Promise<InviteCode[]>;
  // --- transactional email queue (email-sender service) ---
  /** Persist a queued send. Returns the stored row (status `queued`). */
  enqueueEmailSend(e: {
    id: string;
    toEmail: string;
    subject: string;
    body: string;
    createdAt: string;
    maxAttempts: number;
  }): Promise<EmailSend>;
  getEmailSend(id: string): Promise<EmailSend | undefined>;
  /** Atomically claim up to `limit` sends eligible for delivery right now:
   * status `queued`, or `failed` with `attempts < maxAttempts` and the retry
   * window (`nextAttemptAt`) reached. Marks them `sending` and returns them. */
  claimEmailSends(limit: number, now: string): Promise<EmailSend[]>;
  markEmailSent(id: string, sentAt: string): Promise<void>;
  /** Record a delivery failure: bump `attempts`, store `lastError`; pass a
   * future `nextAttemptAt` to keep the send retryable, or null to mark it
   * permanently `failed`. */
  markEmailFailed(id: string, attempts: number, lastError: string, nextAttemptAt: string | null): Promise<void>;
  // --- entitlements (per-user per-calendar-month quota ledger) ---
  /** Clips used by a user in a period key (e.g. "2026-09"). */
  getQuota(userId: string, period: string): Promise<number>;
  /** Atomically increment a user's clip count for a period (idempotent per
   * successful generation — callers invoke once per clip generated). Returns
   * the new count. */
  incrementQuota(userId: string, period: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Development backend: SQLite (node:sqlite), empty `DATABASE_URL`.
// ---------------------------------------------------------------------------
export class SqliteDb implements Db {
  private db: DatabaseSyncType;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // Idempotent baseline (CREATE TABLE IF NOT EXISTS). Tracked, versioned
    // column changes run via migrate() (also called from openDb).
    this.db.exec(SCHEMA_SQLITE);
  }

  /** Apply pending versioned migrations, recording each in `_schema_migrations`. */
  async migrate(): Promise<void> {
    await runMigrations(
      async (sql) => {
        this.db.exec(sql);
      },
      async (table, col) => (this.db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[]).some((c) => c.name === col),
      async (version) => (this.db.prepare("SELECT version FROM _schema_migrations WHERE version = ?").get(version) ? true : false),
      async (version, name) => {
        this.db.prepare("INSERT INTO _schema_migrations (version, name, applied_at) VALUES (?,?,?)").run(version, name, new Date().toISOString());
      }
    );
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async createUser(u: Omit<User, "createdAt"> & { createdAt?: string }): Promise<User> {
    const createdAt = u.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO users (id,email,password_hash,role,created_at,stripe_customer_id,beta_activated_at) VALUES (?,?,?,?,?,?,?)"
      )
      .run(u.id, u.email, u.passwordHash, u.role, createdAt, u.stripeCustomerId ?? null, u.betaActivatedAt ?? null);
    return { ...u, role: u.role, createdAt, stripeCustomerId: u.stripeCustomerId ?? null, betaActivatedAt: u.betaActivatedAt ?? null };
  }

  async activateUser(userId: string): Promise<void> {
    this.db.prepare("UPDATE users SET beta_activated_at = ? WHERE id = ?").run(new Date().toISOString(), userId);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const r = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    return r ? rowToUser(r) : undefined;
  }

  async getUserById(id: string): Promise<User | undefined> {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return r ? rowToUser(r) : undefined;
  }

  async getUserByResetToken(tokenHash: string): Promise<User | undefined> {
    const r = this.db.prepare("SELECT * FROM users WHERE reset_token_hash = ?").get(tokenHash);
    return r ? rowToUser(r) : undefined;
  }

  async setResetToken(userId: string, tokenHash: string, expiresAt: string): Promise<void> {
    this.db.prepare("UPDATE users SET reset_token_hash = ?, reset_token_expires = ? WHERE id = ?").run(tokenHash, expiresAt, userId);
  }

  async clearResetToken(userId: string): Promise<void> {
    this.db.prepare("UPDATE users SET reset_token_hash = NULL, reset_token_expires = NULL WHERE id = ?").run(userId);
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
  }

  async setStripeCustomer(userId: string, customerId: string): Promise<void> {
    this.db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customerId, userId);
  }

  async getSubscription(userId: string): Promise<Subscription> {
    const r = this.db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
    if (r) return rowToSub(r);
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO subscriptions (user_id,tier,status,updated_at) VALUES (?,?,?,?)")
      .run(userId, "free", "active", now);
    return { userId, tier: "free", status: "active", stripeSubscriptionId: null, stripeSubItemId: null, currentPeriodEnd: null, updatedAt: now };
  }

  async setSubscription(userId: string, s: Partial<Subscription>): Promise<Subscription> {
    const cur = await this.getSubscription(userId);
    const next: Subscription = { ...cur, ...s, updatedAt: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO subscriptions (user_id,tier,status,stripe_subscription_id,stripe_sub_item_id,current_period_end,updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET tier=excluded.tier, status=excluded.status,
           stripe_subscription_id=excluded.stripe_subscription_id, stripe_sub_item_id=excluded.stripe_sub_item_id,
           current_period_end=excluded.current_period_end, updated_at=excluded.updated_at`
      )
      .run(next.userId, next.tier, next.status, next.stripeSubscriptionId ?? null, next.stripeSubItemId ?? null, next.currentPeriodEnd ?? null, next.updatedAt);
    return next;
  }

  async countUsage(userId: string, eventType = "highlight"): Promise<number> {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ? AND event_type = ?").get(userId, eventType) as { n: number };
    return r.n;
  }

  async recordUsage(userId: string, eventType = "highlight", extra?: string): Promise<void> {
    this.db.prepare("INSERT INTO usage_events (user_id,event_type,recorded_at,extra) VALUES (?,?,?,?)").run(userId, eventType, new Date().toISOString(), extra ?? null);
  }

  async resetUsage(userId: string, eventType = "highlight"): Promise<void> {
    this.db.prepare("DELETE FROM usage_events WHERE user_id = ? AND event_type = ?").run(userId, eventType);
  }

  async getMediaSession(jobId: string): Promise<MediaSession | undefined> {
    const r = this.db.prepare("SELECT * FROM media_sessions WHERE job_id = ?").get(jobId);
    return r ? rowToMediaSession(r) : undefined;
  }

  async setMediaSession(ms: MediaSession): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO media_sessions (job_id,session_id,stream_id,ws_url,media_origin,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(job_id) DO UPDATE SET session_id=excluded.session_id, stream_id=excluded.stream_id,
           ws_url=excluded.ws_url, media_origin=excluded.media_origin, status=excluded.status,
           created_at=excluded.created_at, updated_at=excluded.updated_at`
      )
      .run(ms.jobId, ms.sessionId, ms.streamId, ms.wsUrl, ms.mediaOrigin, ms.status, ms.createdAt, ms.updatedAt);
  }

  async clearMediaSession(jobId: string): Promise<void> {
    this.db.prepare("DELETE FROM media_sessions WHERE job_id = ?").run(jobId);
  }

  async saveJob(job: Job): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO jobs (id, record, owner_id, status, created_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET record=excluded.record, owner_id=excluded.owner_id,
           status=excluded.status, created_at=excluded.created_at`
      )
      .run(job.id, JSON.stringify(job), job.ownerId ?? null, job.status, job.createdAt);
  }

  async getJob(id: string): Promise<Job | undefined> {
    const r = this.db.prepare("SELECT record FROM jobs WHERE id = ?").get(id);
    return r ? (JSON.parse((r as any).record) as Job) : undefined;
  }

  async listJobs(): Promise<Job[]> {
    const rows = this.db.prepare("SELECT record FROM jobs").all() as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as Job);
  }

  async saveHighlight(h: HighlightRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO highlights (id, job_id, record, owner_id, status, created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET job_id=excluded.job_id, record=excluded.record,
           owner_id=excluded.owner_id, status=excluded.status, created_at=excluded.created_at`
      )
      .run(h.id, h.jobId, JSON.stringify(h), h.ownerId ?? null, h.status, h.createdAt);
  }

  async getHighlight(id: string): Promise<HighlightRecord | undefined> {
    const r = this.db.prepare("SELECT record FROM highlights WHERE id = ?").get(id);
    return r ? (JSON.parse((r as any).record) as HighlightRecord) : undefined;
  }

  async listHighlights(): Promise<HighlightRecord[]> {
    const rows = this.db.prepare("SELECT record FROM highlights").all() as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as HighlightRecord);
  }

  async addWaitlistEmail(email: string): Promise<{ registered: boolean }> {
    const r = this.db
      .prepare("INSERT INTO waitlist (id,email,created_at) VALUES (?,?,?) ON CONFLICT(email) DO NOTHING")
      .run(randomUUID(), email, new Date().toISOString());
    return { registered: (r as any).changes > 0 };
  }

  async listWaitlistEmails(): Promise<{ email: string; createdAt: string }[]> {
    const rows = this.db.prepare("SELECT email, created_at AS createdAt FROM waitlist ORDER BY created_at ASC").all() as any[];
    return rows.map((r) => ({ email: r.email, createdAt: r.createdAt }));
  }

  async waitlistCount(): Promise<number> {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM waitlist").get() as { n: number };
    return r.n;
  }

  async getWaitlist(email: string): Promise<WaitlistEntry | undefined> {
    const r = this.db.prepare("SELECT * FROM waitlist WHERE email = ?").get(email);
    return r ? rowToWaitlist(r) : undefined;
  }

  async setWaitlistInvited(email: string): Promise<WaitlistEntry> {
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT * FROM waitlist WHERE email = ?").get(email) as any;
    if (existing) {
      this.db.prepare("UPDATE waitlist SET status = 'invited', invited_at = ? WHERE email = ?").run(now, email);
    } else {
      this.db
        .prepare("INSERT INTO waitlist (id,email,status,invited_at,created_at) VALUES (?,?,?,?,?)")
        .run(randomUUID(), email, "invited", now, now);
    }
    return (await this.getWaitlist(email))!;
  }

  async listWaitlist(): Promise<WaitlistEntry[]> {
    const rows = this.db.prepare("SELECT * FROM waitlist ORDER BY created_at DESC").all() as any[];
    return rows.map(rowToWaitlist);
  }

  async getInviteByHash(codeHash: string): Promise<InviteCode | undefined> {
    const r = this.db.prepare("SELECT * FROM invite_codes WHERE code_hash = ?").get(codeHash);
    return r ? rowToInvite(r) : undefined;
  }

  async analytics(): Promise<AnalyticsSnapshot> {
    const n = (sql: string) =>
      Number((this.db.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0);
    const usersTotal = n("SELECT COUNT(*) AS n FROM users");
    const usersActivated = n("SELECT COUNT(*) AS n FROM users WHERE beta_activated_at IS NOT NULL");
    const waitlistTotal = n("SELECT COUNT(*) AS n FROM waitlist");
    const waitlistInvited = n("SELECT COUNT(*) AS n FROM waitlist WHERE status = 'invited'");
    const clipsTotal = n("SELECT COUNT(*) AS n FROM highlights");
    const clipsUsed = n("SELECT COUNT(*) AS n FROM usage_events WHERE event_type = 'highlight'");
    const usageEvents = n("SELECT COUNT(*) AS n FROM usage_events");
    const rows = this.db
      .prepare("SELECT tier, status, COUNT(*) AS count FROM subscriptions GROUP BY tier, status")
      .all() as { tier: string; status: string; count: number }[];
    return {
      usersTotal,
      usersActivated,
      waitlistTotal,
      waitlistInvited,
      clipsTotal,
      clipsUsed,
      usageEvents,
      subscriptions: rows.map((r) => ({ tier: String(r.tier), status: String(r.status), count: Number(r.count) })),
    };
  }

  async createInviteCode(ic: Omit<InviteCode, "usedBy" | "usedAt" | "revokedAt">): Promise<InviteCode> {
    const row: InviteCode = { ...ic, usedBy: null, usedAt: null, revokedAt: null };
    this.db
      .prepare("INSERT INTO invite_codes (id,code_hash,email,created_by,created_at) VALUES (?,?,?,?,?)")
      .run(ic.id, ic.codeHash, ic.email ?? null, ic.createdBy, ic.createdAt);
    return row;
  }

  async claimInvite(codeHash: string, usedBy: string): Promise<InviteCode | undefined> {
    // Atomic single-use claim: only a not-yet-used, not-revoked code is claimed.
    const now = new Date().toISOString();
    const res = this.db
      .prepare("UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL")
      .run(usedBy, now, codeHash);
    if ((res as any).changes === 0) return undefined;
    return this.getInviteByHash(codeHash);
  }

  async revokeInvite(codeHash: string): Promise<void> {
    // Only an unused code can be revoked; a used one is already spent.
    this.db.prepare("UPDATE invite_codes SET revoked_at = ? WHERE code_hash = ? AND used_at IS NULL").run(new Date().toISOString(), codeHash);
  }

  async listInvites(): Promise<InviteCode[]> {
    const rows = this.db.prepare("SELECT * FROM invite_codes ORDER BY created_at DESC").all() as any[];
    return rows.map(rowToInvite);
  }

  async enqueueEmailSend(e: { id: string; toEmail: string; subject: string; body: string; createdAt: string; maxAttempts: number }): Promise<EmailSend> {
    this.db
      .prepare(
        "INSERT INTO email_sends (id,to_email,subject,body,status,attempts,max_attempts,created_at,updated_at) VALUES (?,?,?,?,'queued',0,?,?,?)"
      )
      .run(e.id, e.toEmail, e.subject, e.body, e.maxAttempts, e.createdAt, e.createdAt);
    return (await this.getEmailSend(e.id))!;
  }

  async getEmailSend(id: string): Promise<EmailSend | undefined> {
    const r = this.db.prepare("SELECT * FROM email_sends WHERE id = ?").get(id);
    return r ? rowToEmailSend(r) : undefined;
  }

  async claimEmailSends(limit: number, now: string): Promise<EmailSend[]> {
    // Eligible: queued, or failed with retries remaining and the retry window
    // reached. Atomically flips them to 'sending' (single UPDATE...RETURNING so
    // two workers can never claim the same row).
    const rows = this.db
      .prepare(
        `UPDATE email_sends SET status='sending', updated_at=?
         WHERE id IN (
           SELECT id FROM email_sends
           WHERE status='queued'
              OR (status='failed' AND attempts < max_attempts AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
           ORDER BY created_at ASC LIMIT ?
         ) RETURNING *`
      )
      .all(now, now, limit) as any[];
    return rows.map(rowToEmailSend);
  }

  async markEmailSent(id: string, sentAt: string): Promise<void> {
    this.db.prepare("UPDATE email_sends SET status='sent', sent_at=?, updated_at=? WHERE id=?").run(sentAt, sentAt, id);
  }

  async markEmailFailed(id: string, attempts: number, lastError: string, nextAttemptAt: string | null): Promise<void> {
    this.db
      .prepare("UPDATE email_sends SET attempts=?, last_error=?, next_attempt_at=?, status='failed', updated_at=? WHERE id=?")
      .run(attempts, lastError, nextAttemptAt, new Date().toISOString(), id);
  }

  async getQuota(userId: string, period: string): Promise<number> {
    const r = this.db.prepare("SELECT clips_used FROM quota_ledger WHERE user_id = ? AND period = ?").get(userId, period) as { clips_used: number } | undefined;
    return r?.clips_used ?? 0;
  }

  async incrementQuota(userId: string, period: string): Promise<number> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO quota_ledger (user_id,period,clips_used,updated_at) VALUES (?,?,1,?)
         ON CONFLICT(user_id,period) DO UPDATE SET clips_used = quota_ledger.clips_used + 1, updated_at = excluded.updated_at`
      )
      .run(userId, period, now);
    return (await this.getQuota(userId, period));
  }
}

// ---------------------------------------------------------------------------
// Production backend: PostgreSQL (node-postgres), `DATABASE_URL` set.
// ---------------------------------------------------------------------------
export class PgDb implements Db {
  private pool: PoolType;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA_PG);
    await runMigrations(
      async (sql) => {
        await this.pool.query(sql);
      },
      async (table, col) => {
        const r = await this.pool.query(
          `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
          [table, col]
        );
        return (r.rowCount ?? 0) > 0;
      },
      async (version) => {
        const r = await this.pool.query("SELECT 1 FROM _schema_migrations WHERE version = $1", [version]);
        return (r.rowCount ?? 0) > 0;
      },
      async (version, name) => {
        await this.pool.query("INSERT INTO _schema_migrations (version, name, applied_at) VALUES ($1,$2,$3)", [version, name, new Date().toISOString()]);
      }
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createUser(u: Omit<User, "createdAt"> & { createdAt?: string }): Promise<User> {
    const createdAt = u.createdAt ?? new Date().toISOString();
    await this.pool.query(
      "INSERT INTO users (id,email,password_hash,role,created_at,stripe_customer_id,beta_activated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [u.id, u.email, u.passwordHash, u.role, createdAt, u.stripeCustomerId ?? null, u.betaActivatedAt ?? null]
    );
    return { ...u, role: u.role, createdAt, stripeCustomerId: u.stripeCustomerId ?? null, betaActivatedAt: u.betaActivatedAt ?? null };
  }

  async activateUser(userId: string): Promise<void> {
    await this.pool.query("UPDATE users SET beta_activated_at = $2 WHERE id = $1", [userId, new Date().toISOString()]);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const r = await this.pool.query("SELECT * FROM users WHERE email = $1", [email]);
    return r.rows[0] ? rowToUser(r.rows[0]) : undefined;
  }

  async getUserById(id: string): Promise<User | undefined> {
    const r = await this.pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return r.rows[0] ? rowToUser(r.rows[0]) : undefined;
  }

  async getUserByResetToken(tokenHash: string): Promise<User | undefined> {
    const r = await this.pool.query("SELECT * FROM users WHERE reset_token_hash = $1", [tokenHash]);
    return r.rows[0] ? rowToUser(r.rows[0]) : undefined;
  }

  async setResetToken(userId: string, tokenHash: string, expiresAt: string): Promise<void> {
    await this.pool.query("UPDATE users SET reset_token_hash = $2, reset_token_expires = $3 WHERE id = $1", [userId, tokenHash, expiresAt]);
  }

  async clearResetToken(userId: string): Promise<void> {
    await this.pool.query("UPDATE users SET reset_token_hash = NULL, reset_token_expires = NULL WHERE id = $1", [userId]);
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await this.pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [userId, passwordHash]);
  }

  async setStripeCustomer(userId: string, customerId: string): Promise<void> {
    await this.pool.query("UPDATE users SET stripe_customer_id = $2 WHERE id = $1", [userId, customerId]);
  }

  async getSubscription(userId: string): Promise<Subscription> {
    const r = await this.pool.query("SELECT * FROM subscriptions WHERE user_id = $1", [userId]);
    if (r.rows[0]) return rowToSub(r.rows[0]);
    const now = new Date().toISOString();
    await this.pool.query(
      "INSERT INTO subscriptions (user_id,tier,status,updated_at) VALUES ($1,$2,$3,$4)",
      [userId, "free", "active", now]
    );
    return { userId, tier: "free", status: "active", stripeSubscriptionId: null, stripeSubItemId: null, currentPeriodEnd: null, updatedAt: now };
  }

  async setSubscription(userId: string, s: Partial<Subscription>): Promise<Subscription> {
    const cur = await this.getSubscription(userId);
    const next: Subscription = { ...cur, ...s, updatedAt: new Date().toISOString() };
    await this.pool.query(
      `INSERT INTO subscriptions (user_id,tier,status,stripe_subscription_id,stripe_sub_item_id,current_period_end,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(user_id) DO UPDATE SET tier=EXCLUDED.tier, status=EXCLUDED.status,
         stripe_subscription_id=EXCLUDED.stripe_subscription_id, stripe_sub_item_id=EXCLUDED.stripe_sub_item_id,
         current_period_end=EXCLUDED.current_period_end, updated_at=EXCLUDED.updated_at`,
      [next.userId, next.tier, next.status, next.stripeSubscriptionId ?? null, next.stripeSubItemId ?? null, next.currentPeriodEnd ?? null, next.updatedAt]
    );
    return next;
  }

  async countUsage(userId: string, eventType = "highlight"): Promise<number> {
    const r = await this.pool.query(
      "SELECT COUNT(*)::int AS n FROM usage_events WHERE user_id = $1 AND event_type = $2",
      [userId, eventType]
    );
    return r.rows[0]?.n ?? 0;
  }

  async recordUsage(userId: string, eventType = "highlight", extra?: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO usage_events (user_id,event_type,recorded_at,extra) VALUES ($1,$2,$3,$4)",
      [userId, eventType, new Date().toISOString(), extra ?? null]
    );
  }

  async resetUsage(userId: string, eventType = "highlight"): Promise<void> {
    await this.pool.query("DELETE FROM usage_events WHERE user_id = $1 AND event_type = $2", [userId, eventType]);
  }

  async getMediaSession(jobId: string): Promise<MediaSession | undefined> {
    const r = await this.pool.query("SELECT * FROM media_sessions WHERE job_id = $1", [jobId]);
    return r.rows[0] ? rowToMediaSession(r.rows[0]) : undefined;
  }

  async setMediaSession(ms: MediaSession): Promise<void> {
    await this.pool.query(
      `INSERT INTO media_sessions (job_id,session_id,stream_id,ws_url,media_origin,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(job_id) DO UPDATE SET session_id=EXCLUDED.session_id, stream_id=EXCLUDED.stream_id,
         ws_url=EXCLUDED.ws_url, media_origin=EXCLUDED.media_origin, status=EXCLUDED.status,
         created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at`,
      [ms.jobId, ms.sessionId, ms.streamId, ms.wsUrl, ms.mediaOrigin, ms.status, ms.createdAt, ms.updatedAt]
    );
  }

  async clearMediaSession(jobId: string): Promise<void> {
    await this.pool.query("DELETE FROM media_sessions WHERE job_id = $1", [jobId]);
  }

  async saveJob(job: Job): Promise<void> {
    await this.pool.query(
      `INSERT INTO jobs (id, record, owner_id, status, created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT(id) DO UPDATE SET record=EXCLUDED.record, owner_id=EXCLUDED.owner_id,
         status=EXCLUDED.status, created_at=EXCLUDED.created_at`,
      [job.id, JSON.stringify(job), job.ownerId ?? null, job.status, job.createdAt]
    );
  }

  async getJob(id: string): Promise<Job | undefined> {
    const r = await this.pool.query("SELECT record FROM jobs WHERE id = $1", [id]);
    return r.rows[0] ? (JSON.parse(r.rows[0].record) as Job) : undefined;
  }

  async listJobs(): Promise<Job[]> {
    const r = await this.pool.query("SELECT record FROM jobs");
    return r.rows.map((row) => JSON.parse(row.record) as Job);
  }

  async saveHighlight(h: HighlightRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO highlights (id, job_id, record, owner_id, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT(id) DO UPDATE SET job_id=EXCLUDED.job_id, record=EXCLUDED.record,
         owner_id=EXCLUDED.owner_id, status=EXCLUDED.status, created_at=EXCLUDED.created_at`,
      [h.id, h.jobId, JSON.stringify(h), h.ownerId ?? null, h.status, h.createdAt]
    );
  }

  async getHighlight(id: string): Promise<HighlightRecord | undefined> {
    const r = await this.pool.query("SELECT record FROM highlights WHERE id = $1", [id]);
    return r.rows[0] ? (JSON.parse(r.rows[0].record) as HighlightRecord) : undefined;
  }

  async listHighlights(): Promise<HighlightRecord[]> {
    const r = await this.pool.query("SELECT record FROM highlights");
    return r.rows.map((row) => JSON.parse(row.record) as HighlightRecord);
  }

  async addWaitlistEmail(email: string): Promise<{ registered: boolean }> {
    const r = await this.pool.query(
      "INSERT INTO waitlist (id,email,created_at) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING",
      [randomUUID(), email, new Date().toISOString()]
    );
    return { registered: (r.rowCount ?? 0) > 0 };
  }

  async listWaitlistEmails(): Promise<{ email: string; createdAt: string }[]> {
    const r = await this.pool.query("SELECT email, created_at AS \"createdAt\" FROM waitlist ORDER BY created_at ASC");
    return r.rows.map((row: any) => ({ email: row.email, createdAt: row.createdAt }));
  }

  async waitlistCount(): Promise<number> {
    const r = await this.pool.query("SELECT COUNT(*)::int AS n FROM waitlist");
    return r.rows[0]?.n ?? 0;
  }

  async getWaitlist(email: string): Promise<WaitlistEntry | undefined> {
    const r = await this.pool.query("SELECT * FROM waitlist WHERE email = $1", [email]);
    return r.rows[0] ? rowToWaitlist(r.rows[0]) : undefined;
  }

  async setWaitlistInvited(email: string): Promise<WaitlistEntry> {
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO waitlist (id,email,status,invited_at,created_at) VALUES ($1,$2,'invited',$3,$3)
       ON CONFLICT (email) DO UPDATE SET status = 'invited', invited_at = EXCLUDED.invited_at`,
      [randomUUID(), email, now]
    );
    return (await this.getWaitlist(email))!;
  }

  async listWaitlist(): Promise<WaitlistEntry[]> {
    const r = await this.pool.query("SELECT * FROM waitlist ORDER BY created_at DESC");
    return r.rows.map(rowToWaitlist);
  }

  async getInviteByHash(codeHash: string): Promise<InviteCode | undefined> {
    const r = await this.pool.query("SELECT * FROM invite_codes WHERE code_hash = $1", [codeHash]);
    return r.rows[0] ? rowToInvite(r.rows[0]) : undefined;
  }

  async analytics(): Promise<AnalyticsSnapshot> {
    const n = async (sql: string) =>
      Number((await this.pool.query(sql)).rows[0]?.n ?? 0);
    const [usersTotal, usersActivated, waitlistTotal, waitlistInvited, clipsTotal, clipsUsed, usageEvents] =
      await Promise.all([
        n("SELECT COUNT(*)::int AS n FROM users"),
        n("SELECT COUNT(*)::int AS n FROM users WHERE beta_activated_at IS NOT NULL"),
        n("SELECT COUNT(*)::int AS n FROM waitlist"),
        n("SELECT COUNT(*)::int AS n FROM waitlist WHERE status = 'invited'"),
        n("SELECT COUNT(*)::int AS n FROM highlights"),
        n("SELECT COUNT(*)::int AS n FROM usage_events WHERE event_type = 'highlight'"),
        n("SELECT COUNT(*)::int AS n FROM usage_events"),
      ]);
    const r = await this.pool.query(
      "SELECT tier, status, COUNT(*)::int AS count FROM subscriptions GROUP BY tier, status"
    );
    return {
      usersTotal,
      usersActivated,
      waitlistTotal,
      waitlistInvited,
      clipsTotal,
      clipsUsed,
      usageEvents,
      subscriptions: r.rows.map((row: any) => ({
        tier: String(row.tier),
        status: String(row.status),
        count: Number(row.count),
      })),
    };
  }

  async createInviteCode(ic: Omit<InviteCode, "usedBy" | "usedAt" | "revokedAt">): Promise<InviteCode> {
    await this.pool.query(
      "INSERT INTO invite_codes (id,code_hash,email,created_by,created_at) VALUES ($1,$2,$3,$4,$5)",
      [ic.id, ic.codeHash, ic.email ?? null, ic.createdBy, ic.createdAt]
    );
    return { ...ic, usedBy: null, usedAt: null, revokedAt: null };
  }

  async claimInvite(codeHash: string, usedBy: string): Promise<InviteCode | undefined> {
    const r = await this.pool.query(
      `UPDATE invite_codes SET used_by = $2, used_at = $3
       WHERE code_hash = $1 AND used_at IS NULL AND revoked_at IS NULL
       RETURNING *`,
      [codeHash, usedBy, new Date().toISOString()]
    );
    return r.rows[0] ? rowToInvite(r.rows[0]) : undefined;
  }

  async revokeInvite(codeHash: string): Promise<void> {
    await this.pool.query(
      "UPDATE invite_codes SET revoked_at = $2 WHERE code_hash = $1 AND used_at IS NULL",
      [codeHash, new Date().toISOString()]
    );
  }

  async listInvites(): Promise<InviteCode[]> {
    const r = await this.pool.query("SELECT * FROM invite_codes ORDER BY created_at DESC");
    return r.rows.map(rowToInvite);
  }

  async enqueueEmailSend(e: { id: string; toEmail: string; subject: string; body: string; createdAt: string; maxAttempts: number }): Promise<EmailSend> {
    const r = await this.pool.query(
      `INSERT INTO email_sends (id,to_email,subject,body,status,attempts,max_attempts,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'queued',0,$5,$6,$6) RETURNING *`,
      [e.id, e.toEmail, e.subject, e.body, e.maxAttempts, e.createdAt]
    );
    return rowToEmailSend(r.rows[0]);
  }

  async getEmailSend(id: string): Promise<EmailSend | undefined> {
    const r = await this.pool.query("SELECT * FROM email_sends WHERE id = $1", [id]);
    return r.rows[0] ? rowToEmailSend(r.rows[0]) : undefined;
  }

  async claimEmailSends(limit: number, now: string): Promise<EmailSend[]> {
    const r = await this.pool.query(
      `UPDATE email_sends SET status='sending', updated_at=$1
       WHERE id IN (
         SELECT id FROM email_sends
         WHERE status='queued'
            OR (status='failed' AND attempts < max_attempts AND next_attempt_at IS NOT NULL AND next_attempt_at <= $1)
         ORDER BY created_at ASC
         LIMIT $2
       ) RETURNING *`,
      [now, limit]
    );
    return r.rows.map(rowToEmailSend);
  }

  async markEmailSent(id: string, sentAt: string): Promise<void> {
    await this.pool.query("UPDATE email_sends SET status='sent', sent_at=$2, updated_at=$2 WHERE id=$1", [id, sentAt]);
  }

  async markEmailFailed(id: string, attempts: number, lastError: string, nextAttemptAt: string | null): Promise<void> {
    await this.pool.query(
      "UPDATE email_sends SET attempts=$2, last_error=$3, next_attempt_at=$4, status='failed', updated_at=$5 WHERE id=$1",
      [id, attempts, lastError, nextAttemptAt, new Date().toISOString()]
    );
  }

  async getQuota(userId: string, period: string): Promise<number> {
    const r = await this.pool.query("SELECT clips_used FROM quota_ledger WHERE user_id = $1 AND period = $2", [userId, period]);
    return r.rows[0]?.clips_used ?? 0;
  }

  async incrementQuota(userId: string, period: string): Promise<number> {
    await this.pool.query(
      `INSERT INTO quota_ledger (user_id,period,clips_used,updated_at) VALUES ($1,$2,1,$3)
       ON CONFLICT (user_id,period) DO UPDATE SET clips_used = quota_ledger.clips_used + 1, updated_at = EXCLUDED.updated_at`,
      [userId, period, new Date().toISOString()]
    );
    return this.getQuota(userId, period);
  }
}

const SCHEMA_SQLITE = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL,
    stripe_customer_id TEXT,
    reset_token_hash TEXT,
    reset_token_expires TEXT,
    beta_activated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id TEXT PRIMARY KEY,
    tier TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active',
    stripe_subscription_id TEXT,
    stripe_sub_item_id TEXT,
    current_period_end TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    extra TEXT
  );
  CREATE TABLE IF NOT EXISTS invite_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT UNIQUE NOT NULL,
    email TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_by TEXT,
    used_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS quota_ledger (
    user_id TEXT NOT NULL,
    period TEXT NOT NULL,
    clips_used INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, period)
  );
  CREATE TABLE IF NOT EXISTS media_sessions (
    job_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    ws_url TEXT NOT NULL,
    media_origin TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    record TEXT NOT NULL,
    owner_id TEXT,
    status TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    record TEXT NOT NULL,
    owner_id TEXT,
    status TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS waitlist (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'waitlisted',
    invited_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_sends (
    id TEXT PRIMARY KEY,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    last_error TEXT,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE TABLE IF NOT EXISTS _schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

const SCHEMA_PG = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL,
    stripe_customer_id TEXT,
    reset_token_hash TEXT,
    reset_token_expires TEXT,
    beta_activated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id TEXT PRIMARY KEY,
    tier TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active',
    stripe_subscription_id TEXT,
    stripe_sub_item_id TEXT,
    current_period_end TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_events (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    extra TEXT
  );
  CREATE TABLE IF NOT EXISTS invite_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT UNIQUE NOT NULL,
    email TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_by TEXT,
    used_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS quota_ledger (
    user_id TEXT NOT NULL,
    period TEXT NOT NULL,
    clips_used INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, period)
  );
  CREATE TABLE IF NOT EXISTS media_sessions (
    job_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    ws_url TEXT NOT NULL,
    media_origin TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    record TEXT NOT NULL,
    owner_id TEXT,
    status TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    record TEXT NOT NULL,
    owner_id TEXT,
    status TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS waitlist (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'waitlisted',
    invited_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS email_sends (
    id TEXT PRIMARY KEY,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    last_error TEXT,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT
  );
  CREATE TABLE IF NOT EXISTS _schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

/** Select a backend: Postgres when DATABASE_URL is set, else SQLite (dev). */
export async function openDb(cfg: { databasePath: string; databaseUrl?: string }): Promise<Db> {
  if (cfg.databaseUrl) {
    const db = new PgDb(cfg.databaseUrl);
    await db.init();
    return db;
  }
  const db = new SqliteDb(cfg.databasePath);
  await db.migrate();
  return db;
}

// ---------------------------------------------------------------------------
// Versioned migrations
//
// The baseline (SCHEMA_SQLITE / SCHEMA_PG, CREATE TABLE IF NOT EXISTS) is
// idempotent and applied on every boot. Anything that CHANGES existing rows
// or adds columns must be a tracked migration below: applied at most once,
// in version order, and recorded in `_schema_migrations`. New schema changes
// get a new entry here instead of a one-off ALTER — this is what makes a
// restart with an older on-disk DB safe.
// ---------------------------------------------------------------------------

/** Execute one SQL statement (backend-agnostic). */
type Exec = (sql: string) => Promise<void>;
/** Return true if a table already has a named column. */
type HasColumn = (table: string, column: string) => Promise<boolean>;
/** Return true if a migration version has already been applied. */
type Applied = (version: number) => Promise<boolean>;
/** Record that a migration version has been applied. */
type MarkApplied = (version: number, name: string) => Promise<void>;

interface Migration {
  version: number;
  name: string;
  up(exec: Exec, hasColumn: HasColumn): Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "add-reset-token-columns",
    up: async (exec, hasColumn) => {
      // Pre-existing DBs created before the password-reset feature; the
      // baseline CREATE already includes these for fresh DBs.
      if (!(await hasColumn("users", "reset_token_hash"))) await exec("ALTER TABLE users ADD COLUMN reset_token_hash TEXT");
      if (!(await hasColumn("users", "reset_token_expires"))) await exec("ALTER TABLE users ADD COLUMN reset_token_expires TEXT");
    },
  },
  {
    version: 2,
    name: "entitlement-and-beta-gate",
    up: async (exec, hasColumn) => {
      // Invite/beta-gate + per-user quota ledger (ADAAAA-41). The baseline
      // CREATE TABLE IF NOT EXISTS covers fresh DBs; these ALTERs bring
      // pre-existing on-disk DBs up to the same shape (idempotent per column).
      // users.beta_activated_at marks the account as having passed the gate.
      if (!(await hasColumn("users", "beta_activated_at"))) await exec("ALTER TABLE users ADD COLUMN beta_activated_at TEXT");
      // waitlist.status drives invite-path "b": 'waitlisted' → 'invited'.
      if (!(await hasColumn("waitlist", "status"))) await exec("ALTER TABLE waitlist ADD COLUMN status TEXT NOT NULL DEFAULT 'waitlisted'");
      if (!(await hasColumn("waitlist", "invited_at"))) await exec("ALTER TABLE waitlist ADD COLUMN invited_at TEXT");
    },
  },
];

async function runMigrations(exec: Exec, hasColumn: HasColumn, applied: Applied, markApplied: MarkApplied): Promise<void> {
  for (const m of MIGRATIONS) {
    if (await applied(m.version)) continue;
    await m.up(exec, hasColumn);
    await markApplied(m.version, m.name);
  }
}

/** Quote an identifier for the PRAGMA table_info helper (defensive; table
 * names come from our own constant, not user input). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function rowToUser(r: any): User {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    role: r.role,
    createdAt: r.created_at,
    stripeCustomerId: r.stripe_customer_id ?? null,
    resetTokenExpires: r.reset_token_expires ?? null,
    betaActivatedAt: r.beta_activated_at ?? null,
  };
}

function rowToWaitlist(r: any): WaitlistEntry {
  return {
    id: r.id,
    email: r.email,
    status: r.status === "invited" ? "invited" : "waitlisted",
    invitedAt: r.invited_at ?? null,
    createdAt: r.created_at,
  };
}

function rowToInvite(r: any): InviteCode {
  return {
    id: r.id,
    codeHash: r.code_hash,
    email: r.email ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    usedBy: r.used_by ?? null,
    usedAt: r.used_at ?? null,
    revokedAt: r.revoked_at ?? null,
  };
}

function rowToEmailSend(r: any): EmailSend {
  return {
    id: r.id,
    toEmail: r.to_email,
    subject: r.subject,
    body: r.body,
    status: r.status,
    attempts: Number(r.attempts ?? 0),
    maxAttempts: Number(r.max_attempts ?? 3),
    lastError: r.last_error ?? null,
    nextAttemptAt: r.next_attempt_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sentAt: r.sent_at ?? null,
  };
}

function rowToSub(r: any): Subscription {
  return {
    userId: r.user_id,
    tier: r.tier,
    status: r.status,
    stripeSubscriptionId: r.stripe_subscription_id ?? null,
    stripeSubItemId: r.stripe_sub_item_id ?? null,
    currentPeriodEnd: r.current_period_end ?? null,
    updatedAt: r.updated_at,
  };
}

function rowToMediaSession(r: any): MediaSession {
  return {
    jobId: r.job_id,
    sessionId: r.session_id,
    streamId: r.stream_id,
    wsUrl: r.ws_url,
    mediaOrigin: r.media_origin,
    status: r.status === "closed" ? "closed" : "active",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
