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

/**
 * A live media-server session tracked by the control plane. Persisted so that
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
      .prepare("INSERT INTO users (id,email,password_hash,role,created_at,stripe_customer_id) VALUES (?,?,?,?,?,?)")
      .run(u.id, u.email, u.passwordHash, u.role, createdAt, u.stripeCustomerId ?? null);
    return { ...u, role: u.role, createdAt, stripeCustomerId: u.stripeCustomerId ?? null };
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
      "INSERT INTO users (id,email,password_hash,role,created_at,stripe_customer_id) VALUES ($1,$2,$3,$4,$5,$6)",
      [u.id, u.email, u.passwordHash, u.role, createdAt, u.stripeCustomerId ?? null]
    );
    return { ...u, role: u.role, createdAt, stripeCustomerId: u.stripeCustomerId ?? null };
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
    reset_token_expires TEXT
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
    reset_token_expires TEXT
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
