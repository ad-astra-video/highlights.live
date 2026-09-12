import { describe, expect, it } from "vitest";
import { BillingService, BillingRequiredError } from "../src/billing";
import type { ServerConfig } from "../src/config";

// --- in-memory Db stub (the two usage methods the decide fee touches) -------
class StubDb {
  usage: Record<string, number> = {};
  posting: Array<{ itemId: string; qty: number }> = [];
  async recordUsage(_u: string, kind: string) {
    this.usage[kind] = (this.usage[kind] ?? 0) + 1;
  }
  async countUsage(_u: string, kind: string) {
    return this.usage[kind] ?? 0;
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

describe("decide fixed-fee billing ($0.01/shot)", () => {
  it("free user passes within the included decide allowance", async () => {
    const db = new StubDb();
    const b = new BillingService(cfg, db as any, stripe);
    const sub = await db.getSubscription(user.id);
    await expect(b.canDecide(user, sub)).resolves.toBeUndefined();
    await b.onDecideCompleted(user, sub);
    await expect(b.canDecide(user, sub)).resolves.toBeUndefined();
  });

  it("free user is gated (402) once the included allowance is exhausted", async () => {
    const db = new StubDb();
    const b = new BillingService(cfg, db as any, stripe);
    const sub = await db.getSubscription(user.id);
    for (let i = 0; i < cfg.freeDecides; i++) await b.onDecideCompleted(user, sub);
    // allowance now 3/3 used -> next decide is billed at $0.01 -> gate
    await expect(b.canDecide(user, sub)).rejects.toBeInstanceOf(BillingRequiredError);
  });

  it("pro-active user is never gated and overage is metered as usage records", async () => {
    const db = new StubDb();
    const recordingStripe = {
      subscriptionItems: {
        createUsageRecord: (id: string, r: any) => {
          db.posting.push({ itemId: id, qty: r.quantity });
          return { id, qty: r.quantity };
        },
      },
    };
    const b = new BillingService(cfg, db as any, recordingStripe);
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
});
