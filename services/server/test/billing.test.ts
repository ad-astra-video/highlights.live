import { describe, expect, it } from "vitest";
import { BillingService, BillingRequiredError } from "../src/billing";
import { EntitlementsService } from "../src/entitlements";
import type { ServerConfig } from "../src/config";

// --- in-memory Db stub backing both billing's usage methods and the per-period
// quota ledger (clips + decides) the entitlement service reads. --------------
class StubDb {
  usage: Record<string, number> = {};
  posting: Array<{ itemId: string; qty: number }> = [];
  // per-period clip + decide ledger (key: `${userId}|${period}`)
  clips: Record<string, number> = {};
  decides: Record<string, number> = {};
  now = new Date();
  periodKey() {
    return `${this.now.getUTCFullYear()}-${String(this.now.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  async recordUsage(_u: string, kind: string) {
    this.usage[kind] = (this.usage[kind] ?? 0) + 1;
  }
  async countUsage(_u: string, kind: string) {
    return this.usage[kind] ?? 0;
  }
  async getQuota(uid: string) {
    return this.clips[`${uid}|${this.periodKey()}`] ?? 0;
  }
  async incrementQuota(uid: string) {
    const k = `${uid}|${this.periodKey()}`;
    this.clips[k] = (this.clips[k] ?? 0) + 1;
    return this.clips[k];
  }
  async getDecideQuota(uid: string) {
    return this.decides[`${uid}|${this.periodKey()}`] ?? 0;
  }
  async incrementDecideQuota(uid: string) {
    const k = `${uid}|${this.periodKey()}`;
    this.decides[k] = (this.decides[k] ?? 0) + 1;
    return this.decides[k];
  }
  async getSubscription(_u: string) {
    return { tier: "free", status: "active" } as any;
  }
}

const cfg = {
  decideFee: 0.01,
  freeDecides: 3,
  // enabled() requires these
  stripeSecretKey: "sk_test_x",
  stripePricePro: "price_x",
} as unknown as ServerConfig;

const user = { id: "u1", email: "e" } as any;
const stripe = {
  subscriptionItems: { createUsageRecord: (id: string, r: any) => ({ id, qty: r.quantity }) },
};

function makeBilling(db: StubDb, st: any) {
  return new BillingService(cfg, db as any, st, new EntitlementsService(db as any, cfg));
}
function newDecideDb() {
  const db = new StubDb();
  db.now = new Date("2026-09-15T00:00:00Z");
  return db;
}

describe("decide fixed-fee billing ($0.01/shot)", () => {
  it("free user passes within the included decide allowance", async () => {
    const db = newDecideDb();
    const b = makeBilling(db, stripe);
    const sub = await db.getSubscription(user.id);
    await expect(b.canDecide(user, sub)).resolves.toBeUndefined();
    await b.onDecideCompleted(user, sub);
    await expect(b.canDecide(user, sub)).resolves.toBeUndefined();
  });

  it("free user is gated (402) once the included allowance is exhausted", async () => {
    const db = newDecideDb();
    const b = makeBilling(db, stripe);
    const sub = await db.getSubscription(user.id);
    for (let i = 0; i < cfg.freeDecides; i++) await b.onDecideCompleted(user, sub);
    // allowance now 3/3 used -> next decide is billed at $0.01 -> gate
    await expect(b.canDecide(user, sub)).rejects.toBeInstanceOf(BillingRequiredError);
  });

  it("a free user's decide allowance resets at the start of the next period", async () => {
    const db = newDecideDb();
    const b = makeBilling(db, stripe);
    const sub = await db.getSubscription(user.id);
    for (let i = 0; i < cfg.freeDecides; i++) await b.onDecideCompleted(user, sub);
    await expect(b.canDecide(user, sub)).rejects.toBeInstanceOf(BillingRequiredError);
    // Roll into the next month -> the per-period ledger is empty again.
    db.now = new Date("2026-10-01T00:00:00Z");
    await expect(b.canDecide(user, sub)).resolves.toBeUndefined();
  });

  it("pro-active user is never gated and overage is metered as usage records", async () => {
    const db = newDecideDb();
    const recordingStripe = {
      subscriptionItems: {
        createUsageRecord: (id: string, r: any) => {
          db.posting.push({ itemId: id, qty: r.quantity });
          return { id, qty: r.quantity };
        },
      },
    };
    const b = makeBilling(db, recordingStripe);
    const proSub = { ...(await db.getSubscription(user.id)), tier: "pro", status: "active", stripeSubItemId: "si_1" } as any;
    await expect(b.canDecide(user, proSub)).resolves.toBeUndefined();
    // use beyond the free allowance -> Stripe PAYG usage record posted
    for (let i = 0; i < cfg.freeDecides + 2; i++) await b.onDecideCompleted(user, proSub);
    expect(db.usage["decide"]).toBe(cfg.freeDecides + 2);
    expect(db.posting.length).toBeGreaterThan(0);
    expect(db.posting[db.posting.length - 1].qty).toBeGreaterThan(0);
  });

  it("the fixed fee surface is 1 cent by default config", async () => {
    expect(cfg.decideFee).toBe(0.01);
  });

  it("streaming decide is NOT gated (no 402) even with a drained allowance", async () => {
    const db = newDecideDb();
    const b = makeBilling(db, stripe);
    const sub = await db.getSubscription(user.id);
    // Drain the free allowance for a NON-streaming decide -> gated as today.
    for (let i = 0; i < cfg.freeDecides; i++) await b.onDecideCompleted(user, sub);
    await expect(b.canDecide(user, sub)).rejects.toBeInstanceOf(BillingRequiredError);
    // Same user, same drained ledger, but a streaming decide passes (waived).
    await expect(b.canDecide(user, sub, { streaming: true })).resolves.toBeUndefined();
  });

  it("streaming decide does NOT decrement the free-decide allowance or post PAYG", async () => {
    const db = newDecideDb();
    const recordingStripe = {
      subscriptionItems: {
        createUsageRecord: (id: string, r: any) => {
          db.posting.push({ itemId: id, qty: r.quantity });
          return { id, qty: r.quantity };
        },
      },
    };
    const b = makeBilling(db, recordingStripe);
    // Free user: a streaming decide leaves the per-period allowance untouched.
    await b.onDecideCompleted(user, await db.getSubscription(user.id), { streaming: true });
    expect(await db.getDecideQuota(user.id)).toBe(0); // allowance NOT decremented
    // Pro overage: no Stripe usage record for the streaming decide.
    const proSub = { ...(await db.getSubscription(user.id)), tier: "pro", status: "active", stripeSubItemId: "si_1" } as any;
    await b.onDecideCompleted(user, proSub, { streaming: true });
    expect(db.posting.length).toBe(0); // no PAYG usage record
    // ...but the streaming decide still RECORDS for cost visibility.
    expect(db.usage["decide"]).toBe(2);
  });

  it("streaming waiver leaves the non-streaming path exactly unchanged", async () => {
    const db = newDecideDb();
    const recordingStripe = {
      subscriptionItems: {
        createUsageRecord: (id: string, r: any) => {
          db.posting.push({ itemId: id, qty: r.quantity });
          return { id, qty: r.quantity };
        },
      },
    };
    const b = makeBilling(db, recordingStripe);
    const proSub = { ...(await db.getSubscription(user.id)), tier: "pro", status: "active", stripeSubItemId: "si_1" } as any;
    // Non-streaming pro overage still posts PAYG (regression guard).
    for (let i = 0; i < cfg.freeDecides + 1; i++) await b.onDecideCompleted(user, proSub);
    expect(db.posting.length).toBeGreaterThan(0);
    expect(db.usage["decide"]).toBe(cfg.freeDecides + 1);
  });
});
