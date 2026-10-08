import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDb, type Db } from "../src/db";
import { Store } from "../src/store";
import { persistLiveHighlight } from "../src/api";
import { buildTestApp } from "./helpers";
import {
  normalizeChannel,
  recordJobFunnel,
  recordGenerateFunnel,
  recordSubscribeFunnel,
  recordSignupFunnel,
} from "../src/funnel";

describe("funnel channel normalization", () => {
  it("maps common acquisition aliases to stable channel keys", () => {
    expect(normalizeChannel("Facebook")).toBe("meta");
    expect(normalizeChannel("instagram")).toBe("meta");
    expect(normalizeChannel("google")).toBe("google");
    expect(normalizeChannel("tiktok")).toBe("tiktok");
    expect(normalizeChannel("  ")).toBeNull();
    expect(normalizeChannel(undefined)).toBeNull();
    // Unknown sources are kept verbatim (lowercased) for the CAC rollup.
    expect(normalizeChannel("my-custom-channel")).toBe("my-custom-channel");
  });
});

describe("conversion funnel lifecycle (db-level)", () => {
  let db: Db;
  beforeEach(() => {
    db = new SqliteDb(":memory:");
  });

  async function mkUser(channel: string | null) {
    return db.createUser({
      id: `u-${Math.random().toString(36).slice(2)}`,
      email: `${Math.random().toString(36).slice(2)}@test.local`,
      passwordHash: "x",
      role: "user",
      stripeCustomerId: null,
      betaActivatedAt: new Date().toISOString(),
      channel,
    });
  }

  it("records signup -> activate -> generate -> subscribe (once per user, dimensioned by channel)", async () => {
    const u = await mkUser("meta");
    await recordSignupFunnel(db, u.id);
    await recordJobFunnel(db, u.id, 0, null, 7); // first job -> activate
    await recordGenerateFunnel(db, u.id);
    await recordSubscribeFunnel(db, u.id);

    // Idempotency: repeating a stage must not double-count.
    await recordSignupFunnel(db, u.id);
    await recordGenerateFunnel(db, u.id);

    const report = await db.funnelReport();
    expect(report.stages.signup).toBe(1);
    expect(report.stages.activate).toBe(1);
    expect(report.stages.generate).toBe(1);
    expect(report.stages.subscribe).toBe(1);
    expect(report.stages.retain).toBe(0);
    expect(report.perChannel["meta"]).toMatchObject({ signup: 1, activate: 1, generate: 1, subscribe: 1 });
  });

  it("records retain only when a later job is created >= retainDays after the first job", async () => {
    const u = await mkUser("google");
    await recordJobFunnel(db, u.id, 0, null, 7); // first job -> activate
    // A second job only 1 day later is NOT a retained return.
    await recordJobFunnel(db, u.id, 1, new Date(Date.now() - 1 * 86_400_000).toISOString(), 7);
    let report = await db.funnelReport();
    expect(report.stages.retain).toBe(0);

    // A second job 8 days after the first job IS a retained return.
    await recordJobFunnel(db, u.id, 1, new Date(Date.now() - 8 * 86_400_000).toISOString(), 7);
    report = await db.funnelReport();
    expect(report.stages.retain).toBe(1);
  });

  it("computes CAC per channel = spend / paying subscribers", async () => {
    const u1 = await mkUser("meta");
    const u2 = await mkUser("google");
    await recordSignupFunnel(db, u1.id);
    await recordSubscribeFunnel(db, u1.id);
    await recordSignupFunnel(db, u2.id);
    await recordSubscribeFunnel(db, u2.id);
    await recordSubscribeFunnel(db, u2.id); // idempotent

    await db.recordChannelSpend("meta", 60, "Meta campaign");
    await db.recordChannelSpend("google", 120, "Google Search");

    const report = await db.funnelReport();
    const byChannel = Object.fromEntries(report.cac.map((c) => [c.channel, c]));
    expect(byChannel["meta"]).toMatchObject({ spendUsd: 60, subscribers: 1, cacUsd: 60 });
    expect(byChannel["google"]).toMatchObject({ spendUsd: 120, subscribers: 1, cacUsd: 120 });
  });

  it("reports CAC null when a channel has spend but no subscribers yet", async () => {
    await db.recordChannelSpend("meta", 75);
    const report = await db.funnelReport();
    const meta = report.cac.find((c) => c.channel === "meta");
    expect(meta).toMatchObject({ spendUsd: 75, subscribers: 0, cacUsd: null });
  });

  it("persistLiveHighlight records the generate funnel event", async () => {
    const u = await mkUser("referral");
    const store = new Store(db);
    const cfg = { autoPublishHighlights: true } as any;
    const deps = { store, cfg, billing: { onHighlightCreated: async () => {} }, entitlements: { onClipGenerated: async () => {} }, db } as any;
    await persistLiveHighlight(deps, u as any, {} as any, {
      id: "h1",
      jobId: "j1",
      clipUri: "/clips/x.mp4",
      start: 1,
      end: 2,
      score: 90,
      status: "pending",
      createdAt: new Date().toISOString(),
    } as any);
    const report = await db.funnelReport();
    expect(report.stages.generate).toBe(1);
    expect(report.perChannel["referral"].generate).toBe(1);
  });
});

describe("funnel + CAC admin readout (api-level)", () => {
  it("captures channel at signup, records funnel stages, and serves /admin/funnel + /admin/spend", async () => {
    const app = await buildTestApp({ BILLING_WIREFRAME: "1" });

    // Authorize admin-only routes with the seeded dev admin.
    const adminLogin = await app.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "admin@test.local", password: "adminpass" },
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminHeaders = { authorization: `Bearer ${adminLogin.json().token}` };

    // Signup with UTM attribution.
    const reg = await app.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "meta@example.com", password: "password123", utmSource: "facebook", utmCampaign: "launch" },
    });
    expect(reg.statusCode).toBe(200);
    const token = reg.json().token;
    const auth = { authorization: `Bearer ${token}` };

    // The signup should be attributed to the normalized "meta" channel.
    const funnelAfterSignup = await app.app.inject({ method: "GET", url: "/admin/funnel", headers: adminHeaders });
    expect(funnelAfterSignup.statusCode).toBe(200);
    expect(funnelAfterSignup.json().stages.signup).toBe(1);
    expect(funnelAfterSignup.json().perChannel["meta"]).toMatchObject({ signup: 1 });

    // Subscribe via the wireframe activate route -> funnel subscribe stage.
    const act = await app.app.inject({ method: "POST", url: "/dev/billing/activate", headers: auth, payload: { plan: "pro" } });
    expect(act.statusCode).toBe(200);
    const funnelAfterSub = await app.app.inject({ method: "GET", url: "/admin/funnel", headers: adminHeaders });
    expect(funnelAfterSub.json().stages.subscribe).toBe(1);
    expect(funnelAfterSub.json().perChannel["meta"]).toMatchObject({ subscribe: 1 });

    // Record spend and read CAC.
    const spend = await app.app.inject({
      method: "POST",
      url: "/admin/spend",
      headers: adminHeaders,
      payload: { channel: "meta", spendUsd: 50 },
    });
    expect(spend.statusCode).toBe(200);
    const funnel = await app.app.inject({ method: "GET", url: "/admin/funnel", headers: adminHeaders });
    const meta = funnel.json().cac.find((c: any) => c.channel === "meta");
    expect(meta).toMatchObject({ spendUsd: 50, subscribers: 1, cacUsd: 50 });

    await app.app.close();
  });
});
