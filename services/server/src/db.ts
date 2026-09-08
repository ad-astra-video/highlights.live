// Durable SQLite persistence via Node's built-in `node:sqlite` (no native build
// step). Accounts/billing data live here; the in-memory Store keeps jobs +
// highlight records for the pipeline. Swap databasePath for the file on the
// Railway volume (or Postgres later) — the SQL is unchanged.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// `node:sqlite` is experimental and not in Vite/vitest's builtin external
// list, so load it via createRequire at runtime instead of a static ESM import
// (which vite-node rewrites to a bare broken id).
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
// Type-only import (erased at runtime) so we can annotate the field without a
// runtime ESM dependency that vite-node would try to resolve.
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

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

export class SqlDb {
  private db: DatabaseSyncType;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
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
    `);
  }

  close() {
    this.db.close();
  }

  // --- users ---
  createUser(u: Omit<User, "createdAt"> & { createdAt?: string }): User {
    const createdAt = u.createdAt ?? new Date().toISOString();
    this.db
      .prepare("INSERT INTO users (id,email,password_hash,role,created_at,stripe_customer_id) VALUES (?,?,?,?,?,?)")
      .run(u.id, u.email, u.passwordHash, u.role, createdAt, u.stripeCustomerId ?? null);
    return { ...u, role: u.role, createdAt, stripeCustomerId: u.stripeCustomerId ?? null };
  }

  getUserByEmail(email: string): User | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    return r ? rowToUser(r) : undefined;
  }

  getUserById(id: string): User | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    return r ? rowToUser(r) : undefined;
  }

  setStripeCustomer(userId: string, customerId: string): void {
    this.db.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(customerId, userId);
  }

  // --- subscriptions ---
  getSubscription(userId: string): Subscription {
    const r = this.db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
    if (r) return rowToSub(r);
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO subscriptions (user_id,tier,status,updated_at) VALUES (?,?,?,?)")
      .run(userId, "free", "active", now);
    return { userId, tier: "free", status: "active", stripeSubscriptionId: null, stripeSubItemId: null, currentPeriodEnd: null, updatedAt: now };
  }

  setSubscription(userId: string, s: Partial<Subscription>): Subscription {
    const cur = this.getSubscription(userId);
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

  // --- usage ---
  countUsage(userId: string, eventType = "highlight"): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ? AND event_type = ?").get(userId, eventType) as { n: number };
    return r.n;
  }

  /** Counts usage in the last `period` of a given user's subscription period. */
  recordUsage(userId: string, eventType = "highlight", extra?: string): void {
    this.db.prepare("INSERT INTO usage_events (user_id,event_type,recorded_at,extra) VALUES (?,?,?,?)").run(userId, eventType, new Date().toISOString(), extra ?? null);
  }

  resetUsage(userId: string, eventType = "highlight"): void {
    this.db.prepare("DELETE FROM usage_events WHERE user_id = ? AND event_type = ?").run(userId, eventType);
  }
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
