// Billing: subscriptions (Stripe) + pay-as-you-go (Stripe metered usage).
//
// Model
// - "free" (Starter): FREE_HIGHLIGHTS one-time clips included; further clips
//   return 402 "upgrade required" (blocks free-$5 farming).
// - "pro" (Stripe subscription, price STRIPE_PRICE_PRO, fixed monthly): includes
//   PRO_INCLUDED_HIGHLIGHTS per period; overage and every usage beyond is billed
//   pay-as-you-go via a Stripe usage record on the subscription's usage item.
//   A $0-base usage price attached as a second subscription item meters overage.
//
// The server holds NO card/key beyond the Stripe secret; customers are created
// on demand and billed through Stripe Checkout + the Customer portal.
import type { SqlDb, Subscription, User } from "./db";
import type { ServerConfig } from "./config";

export interface Plan {
  id: string;
  name: string;
  description: string;
  currency: string;
  amount: number; // per month in cents (0 for free)
  includedHighlights: number; // per period (free: lifetime)
}

export const PLANS: Plan[] = [
  { id: "free", name: "Starter", description: "Try it out", currency: "usd", amount: 0, includedHighlights: 3 },
  { id: "pro", name: "Pro", description: "Unlimited highlights, pay as you go", currency: "usd", amount: 900, includedHighlights: 25 },
];

export class BillingService {
  /** injected stripe-like API (real `stripe` client in prod, stub in tests). */
  constructor(
    private cfg: ServerConfig,
    private db: SqlDb,
    private stripe: any
  ) {}

  get enabled(): boolean {
    return Boolean(this.cfg.stripeSecretKey && this.cfg.stripePricePro);
  }

  plans(): Plan[] {
    return PLANS;
  }

  async ensureCustomer(user: User): Promise<string> {
    if (user.stripeCustomerId) return user.stripeCustomerId;
    const c = await this.stripe.customers.create({ email: user.email, metadata: { userId: user.id } });
    this.db.setStripeCustomer(user.id, c.id);
    return c.id;
  }

  /** Create a Stripe Checkout session for the Pro subscription. */
  async createCheckout(user: User, returnPath: string): Promise<{ url: string }> {
    // Dev wireframe: no Stripe on the wire; the caller completes the "payment"
    // by hitting a simulated webhook/activate endpoint. Returns a local URL.
    if (this.cfg.billingWireframe && !this.enabled) {
      return { url: `${this.cfg.publicBaseUrl}/billing?wireframe=checkout=success` };
    }
    if (!this.enabled) throw new Error("billing not configured");
    const customer = await this.ensureCustomer(user);
    const line_items: any[] = [{ price: this.cfg.stripePricePro, quantity: 1 }];
    // Optional metered (usage-based) price -> billed PAYG for overage.
    if (this.cfg.stripePriceUsage) line_items.push({ price: this.cfg.stripePriceUsage });
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items,
      success_url: `${this.cfg.publicBaseUrl}${returnPath || "/"}?checkout=success`,
      cancel_url: `${this.cfg.publicBaseUrl}${returnPath || "/billing"}`,
      metadata: { userId: user.id },
      subscription_data: { metadata: { userId: user.id } },
    });
    return { url: session.url };
  }

  /** Open the Stripe Customer portal for managing the subscription. */
  async portal(user: User, returnPath: string): Promise<{ url: string }> {
    if (this.cfg.billingWireframe && !this.enabled) {
      return { url: `${this.cfg.publicBaseUrl}/billing?wireframe=portal` };
    }
    if (!this.enabled) throw new Error("billing not configured");
    const customer = await this.ensureCustomer(user);
    const s = await this.stripe.billingPortal.sessions.create({
      customer,
      return_url: `${this.cfg.publicBaseUrl}${returnPath || "/billing"}`,
    });
    return { url: s.url };
  }

  /**
   * Gate: may this user create a highlight now?
   * Throws a BillingRequiredError (-> HTTP 402 with upgrade intent) when not.
   */
  canCreateHighlight(user: User, sub: Subscription): void {
    if (sub.tier === "pro" && sub.status === "active") return;
    // free (or past_due/canceled pro) -> count toward the free cap
    const used = this.db.countUsage(user.id, "highlight");
    if (used < this.cfg.freeHighlights) return;
    throw new BillingRequiredError("free highlight allowance used; subscribe to Pro or add funds");
  }

  /**
   * Meter ONE highlight. Increments the DB counter always; for Pro overage
   * beyond the included quota, posts a Stripe usage record so PAYG is billed.
   */
  async onHighlightCreated(user: User, sub: Subscription): Promise<void> {
    this.db.recordUsage(user.id, "highlight");
    if (sub.tier === "pro" && sub.status === "active" && this.enabled) {
      const used = this.db.countUsage(user.id, "highlight");
      const included = PLANS.find((p) => p.id === "pro")?.includedHighlights ?? 0;
      if (used > included && sub.stripeSubItemId) {
        await this.postUsageRecord(sub.stripeSubItemId, used - included);
      }
    }
  }

  private async postUsageRecord(subItemId: string, quantity: number): Promise<void> {
    if (quantity <= 0) return;
    await this.stripe.subscriptionItems.createUsageRecord(subItemId, {
      quantity,
      action: "increment",
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * Stripe webhook dispatch. `rawBody` must be the unmodified request body and
   * `sig` the `stripe-signature` header; returns false when the signature
   * cannot be verified (caller should 400).
   */
  async handleWebhook(rawBody: string | Buffer, sig: string): Promise<{ handled: string }> {
    if (!this.enabled || !this.cfg.stripeWebhookSecret) throw new Error("webhook not configured");
    const event = (this.stripe.webhooks || this.stripe).constructEvent(rawBody, sig, this.cfg.stripeWebhookSecret);
    switch (event.type) {
      case "checkout.session.completed": {
        const meta = event.data.object.metadata || {};
        this.activateFromSubscription(meta.userId, event.data.object.subscription);
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const meta = event.data.object.metadata || {};
        this.activateFromSubscription(meta.userId, event.data.object.id);
        break;
      }
      case "customer.subscription.deleted": {
        const meta = event.data.object.metadata || {};
        if (meta.userId) this.db.setSubscription(meta.userId, { tier: "free", status: "canceled" });
        break;
      }
      default:
        break;
    }
    return { handled: event.type };
  }

  /** Fetch the subscription from Stripe and persist tier/status + overage item. */
  private async activateFromSubscription(userId: string | undefined, stripeSubId: string | null | undefined): Promise<void> {
    if (!userId || !stripeSubId) return;
    const sub = await this.stripe.subscriptions.retrieve(stripeSubId);
    const item = sub.items?.data?.find((it: any) => it.price?.recurring?.usage_type === "metered" || it.price?.active) as
      | { id: string }
      | undefined;
    const status = sub.status === "active" || sub.status === "trialing" ? sub.status : "past_due";
    this.db.setSubscription(userId, {
      tier: "pro",
      status,
      stripeSubscriptionId: stripeSubId,
      stripeSubItemId: item?.id ?? null,
      currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    });
  }
}

export class BillingRequiredError extends Error {
  readonly statusCode = 402;
  constructor(message: string) {
    super(message);
    this.name = "BillingRequiredError";
  }
}
