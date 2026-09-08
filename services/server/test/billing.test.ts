import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers";
import { BillingRequiredError } from "../src/billing";

const STRIPE_CFG = {
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_PRICE_PRO: "price_pro",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
};

async function register(app: any, email: string, pw = "password123") {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  return r.json().token;
}

describe("billing", () => {
  it("exposes plans and requires billing config for checkout", async () => {
    const { app } = await buildTestApp();
    const plans = await app.inject({ method: "GET", url: "/billing/plans" });
    expect(plans.json().plans.map((p: any) => p.id)).toEqual(["free", "pro"]);

    const token = await register(app, "d@x.dev");
    const checkout = await app.inject({ method: "POST", url: "/billing/checkout", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(checkout.statusCode).toBe(400); // billing disabled
    await app.close();
  });

  it("checkout + portal create a Stripe customer and return redirect URLs", async () => {
    const { app, stripeCalls } = await buildTestApp(STRIPE_CFG);
    const token = await register(app, "e@x.dev");
    const co = await app.inject({ method: "POST", url: "/billing/checkout", headers: { authorization: `Bearer ${token}` }, payload: { returnPath: "/billing" } });
    expect(co.statusCode).toBe(200);
    expect(co.json().url).toContain("checkout.stripe");
    const createArgs = stripeCalls.find((c) => c[0] === "checkout.create")![1];
    expect(createArgs.mode).toBe("subscription");
    expect(createArgs.line_items[0].price).toBe("price_pro");

    const portal = await app.inject({ method: "POST", url: "/billing/portal", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(portal.statusCode).toBe(200);
    expect(portal.json().url).toContain("portal.stripe");
    await app.close();
  });

  it("gates on free allowance and lifts with an active pro sub", async () => {
    const { app, db, billing } = await buildTestApp({ FREE_HIGHLIGHTS: "1" });
    await register(app, "g@x.dev");
    const user = db.getUserByEmail("g@x.dev")!;
    const sub = db.getSubscription(user.id);
    expect(() => billing.canCreateHighlight(user, sub)).not.toThrow();

    db.recordUsage(user.id, "highlight"); // now at cap
    expect(() => billing.canCreateHighlight(user, db.getSubscription(user.id))).toThrow(BillingRequiredError);

    db.setSubscription(user.id, { tier: "pro", status: "active", stripeSubscriptionId: "sub_1", stripeSubItemId: "si_usage" });
    expect(() => billing.canCreateHighlight(user, db.getSubscription(user.id))).not.toThrow();
    await app.close();
  });

  it("meters overage to Stripe once past Pro's included quota", async () => {
    const { db, billing, stripeCalls } = await buildTestApp(STRIPE_CFG);
    const user = db.createUser({ id: "billing-user", email: "meter@x.dev", passwordHash: "h", role: "user", stripeCustomerId: null });
    db.setSubscription(user.id, { tier: "pro", status: "active", stripeSubscriptionId: "sub_1", stripeSubItemId: "si_usage" });
    // pro includes 25; onHighlightCreated meters overage beyond that
    for (let i = 0; i < 26; i++) {
      await billing.onHighlightCreated(user, db.getSubscription(user.id));
    }
    const usage = stripeCalls.filter((c) => c[0] === "usage.create");
    expect(usage.length).toBeGreaterThan(0);
    await db.close();
  });

  it("rejects webhook when billing not configured", async () => {
    const { app } = await buildTestApp(); // no stripe keys
    const wh = await app.inject({
      method: "POST",
      url: "/stripe/webhook",
      headers: { "stripe-signature": "sig" },
      payload: { type: "checkout.session.completed", data: {} },
    });
    expect(wh.statusCode).toBe(400);
    await app.close();
  });
});
