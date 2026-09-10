// Durable persistence for accounts/billing.
//
// Two backends behind one async `Db` interface:
//   - SqliteDb  (dev): Node's built-in `node:sqlite`, no native build step.
//   - PgDb      (prod): PostgreSQL via node-postgres (`pg`), selected when
//                      `DATABASE_URL` is set.
// The in-memory Store keeps jobs + highlight records for the pipeline;
// accounts/billing data live here.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

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

/** Async persistence contract shared by the SQLite (dev) and Postgres (prod) backends. */
export interface Db {
  close(): Promise<void>;
  createUser(u: Omit<User, "createdAt"> & { createdAt?: string }): Promise<User>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserById(id: string): Promise<User | undefined>;
  setStripeCustomer(userId: string, customerId: string): Promise<void>;
  getSubscription(userId: string): Promise<Subscription>;
  setSubscription(userId: string, s: Partial<Subscription>): Promise<Subscription>;
  countUsage(userId: string, eventType?: string): Promise<number>;
  recordUsage(userId: string, eventType?: string, extra?: string): Promise<void>;
  resetUsage(userId: string, eventType?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Development backend: SQLite (node:sqlite), empty `DATABASE_URL`.
// ---------------------------------------------------------------------------
export class SqliteDb implements Db {
  private db: DatabaseSyncType;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA_SQLITE);
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
}

const SCHEMA_SQLITE = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL,
    stripe_customer_id TEXT
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
`;

const SCHEMA_PG = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL,
    stripe_customer_id TEXT
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
`;

/** Select a backend: Postgres when DATABASE_URL is set, else SQLite (dev). */
export async function openDb(cfg: { databasePath: string; databaseUrl?: string }): Promise<Db> {
  if (cfg.databaseUrl) {
    const db = new PgDb(cfg.databaseUrl);
    await db.init();
    return db;
  }
  return new SqliteDb(cfg.databasePath);
}

function rowToUser(r: any): User {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    role: r.role,
    createdAt: r.created_at,
    stripeCustomerId: r.stripe_customer_id ?? null,
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
