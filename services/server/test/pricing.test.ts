import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config";
import { buildTestApp } from "./helpers";

// Gate X blocker F3 (ADAAAA-2507): canonical beta numbers must agree across
// every surface. Free beta = 10 clips/month; PRO = $9/month for 100 clips/month
// (GA-gated, not activatable during beta). These tests lock the numbers so a
// future edit cannot silently desync /billing/plans, quota enforcement, or the
// plan default from the landing copy.
describe("canonical beta pricing + quota numbers (Gate X F3)", () => {
  it("/billing/plans reports Free=10/mo and PRO=$9 / 100 clips", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/billing/plans" });
    expect(res.statusCode).toBe(200);
    const plans = res.json().plans as { id: string; amount: number; includedHighlights: number }[];
    const free = plans.find((p) => p.id === "free");
    const pro = plans.find((p) => p.id === "pro");
    expect(free).toBeTruthy();
    expect(pro).toBeTruthy();
    expect(free!.amount).toBe(0);
    expect(free!.includedHighlights).toBe(10); // free beta = 10 clips/month
    expect(pro!.amount).toBe(900); // $9/month (cents)
    expect(pro!.includedHighlights).toBe(100); // PRO = 100 clips/month at GA
    await app.close();
  });

  it("default config: freeHighlights=10 and betaClipQuota=10 (matches landing)", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.freeHighlights).toBe(10);
    expect(cfg.betaClipQuota).toBe(10);
    // ADAAAA-8028: the enforced Pro ceiling defaults to the GA included number.
    expect(cfg.proClipQuota).toBe(100);
  });

  it("a raised PRO_CLIP_QUOTA lifts enforcement only — /billing/plans still advertises 100", async () => {
    const { app } = await buildTestApp({ PRO_CLIP_QUOTA: "10000", BETA_CLIP_QUOTA: "1000" });
    const res = await app.inject({ method: "GET", url: "/billing/plans" });
    const plans = res.json().plans as { id: string; includedHighlights: number }[];
    expect(plans.find((p) => p.id === "pro")!.includedHighlights).toBe(100);
    expect(plans.find((p) => p.id === "free")!.includedHighlights).toBe(10);
    await app.close();
  });

  it("/billing/status surfaces the 10/month quota enforcement limit by default", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/billing/status" });
    // unauthenticated -> still reachable? if not, fall back to a registered user
    if (res.statusCode === 200) {
      expect(res.json().clipQuotaLimit).toBe(10);
    } else {
      // /billing/status requires auth; obtain a token to assert quota enforcement.
      const reg = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "q@t.dev", password: "password123" } });
      const token = reg.json().token as string;
      const authed = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } });
      expect(authed.json().clipQuotaLimit).toBe(10);
      expect(authed.json().clipQuotaRemaining).toBe(10);
    }
    await app.close();
  });
});
