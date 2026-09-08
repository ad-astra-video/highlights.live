import type { ServerConfig } from "../src/config";
import { loadConfig } from "../src/config";
import { SqlDb } from "../src/db";
import { AuthService } from "../src/auth";
import { BillingService } from "../src/billing";
import { Store } from "../src/store";
import { buildApp } from "../src/api";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

let n = 0;
/** Build a ServerConfig from env-style overrides (partial env var set). */
export function testCfg(env: Record<string, string> = {}): ServerConfig {
  return loadConfig({
    PORT: "0",
    DATA_DIR: mkdtempSync(path.join(tmpdir(), `hl-data-${n++}-`)),
    DATABASE_PATH: ":memory:",
    ORCHESTRATOR_URL: "http://x",
    JWT_SECRET: "test-secret",
    ADMIN_EMAIL: "admin@test.local",
    ADMIN_PASSWORD: "adminpass",
    FREE_HIGHLIGHTS: "100",
    ...env,
  });
}

/** Minimal in-memory Stripe stub recording calls made by BillingService. */
export function stripeStub(calls: any[] = []) {
  return {
    customers: {
      create: async (o: any) => {
        calls.push(["customers.create", o]);
        return { id: `cus_${o.email?.replace(/[^a-z0-9]/gi, "")}` };
      },
    },
    checkout: {
      sessions: {
        create: async (o: any) => {
          calls.push(["checkout.create", o]);
          return { url: "https://checkout.stripe.test/sess_123" };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (o: any) => {
          calls.push(["portal.create", o]);
          return { url: "https://portal.stripe.test/xyz" };
        },
      },
    },
    subscriptionItems: {
      createUsageRecord: async (id: string, o: any) => {
        calls.push(["usage.create", Object.assign({ subscriptionItem: id }, o)]);
        return { id: `usage_${id}_${Math.random().toString(36).slice(2)}` };
      },
    },
    subscriptions: {
      retrieve: async (id: string) => {
        calls.push(["subs.retrieve", id]);
        return {
          id,
          status: "active",
          current_period_end: 4102444800,
          items: { data: [{ id: "si_usage", price: { recurring: { usage_type: "metered" }, active: true } }] },
        };
      },
    },
    webhooks: { constructEvent: () => ({ type: "ignored", data: {} }) },
  };
}

export interface TestApp {
  app: FastifyInstance;
  cfg: ServerConfig;
  db: SqlDb;
  auth: AuthService;
  billing: BillingService;
  stripeCalls: any[];
}

export async function buildTestApp(over: Record<string, string> = {}): Promise<TestApp> {
  const cfg = testCfg(over);
  const db = new SqlDb(cfg.databasePath);
  const auth = new AuthService(db, cfg);
  auth.bootstrapAdmin();
  const stripeCalls: any[] = [];
  const billing = new BillingService(cfg, db, stripeStub(stripeCalls));
  const store = new Store();
  const adapter = fakePipeline();
  const app = buildApp({ cfg, store, adapter, db, auth, billing });
  await app.ready();
  return { app, cfg, db, auth, billing, stripeCalls };
}

export function fakePipeline(): any {
  let n = 0;
  return {
    reserveCount: 0,
    stopCount: 0,
    async reservePerceive() {
      (this as any).reserveCount++;
      return { sessionId: "sess-it", appUrl: "", controlUrl: "" };
    },
    async analyze() {
      n++;
      if (n === 1) {
        return {
          observation: { tracks: [{ trackId: "a", slot: 0, bbox: [0.1, 0.1, 0.5, 0.5], kind: "player", lostFrames: 0 }], seq: 0, timestamp: 0 },
          candidate: { eventType: "KILL", timestamp: 0 },
        };
      }
      return { observation: { tracks: [{ trackId: "a", slot: 0, bbox: [0.1, 0.1, 0.5, 0.5], kind: "player", lostFrames: 0 }], seq: 0, timestamp: 0 } };
    },
    async decide() {
      return { isHighlight: true, score: 86, eventType: "KILL", reason: "test" };
    },
    async stopPerceive() {
      (this as any).stopCount++;
    },
  };
}
