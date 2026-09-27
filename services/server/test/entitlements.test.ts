import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";

const tmp = mkdtempSync(path.join(tmpdir(), "hl-ent-"));
const videoPath = path.join(tmp, "test.mp4");
beforeAll(() => {
  execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=1", "-pix_fmt", "yuv420p", videoPath]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function register(app: any, email: string, pw: string, inviteCode?: string) {
  return app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw, ...(inviteCode ? { inviteCode } : {}) } });
}
async function adminToken(app: any, cfg: any) {
  const r = await app.inject({ method: "POST", url: "/auth/login", payload: { email: cfg.adminEmail, password: cfg.adminPassword } });
  return r.json().token as string;
}

describe("paid (Pro) entitlement binding — quota widens for active Pro, free stays at 10/mo", () => {
  it("free user's clip quota defaults to 10/mo; activating Pro widens it to 100/mo; cancel returns to 10/mo", async () => {
    const { app, db } = await buildTestApp({ BETA_CLIP_QUOTA: "10", BILLING_WIREFRAME: "1" });
    const r = await register(app, "tier@test.dev", "password123");
    const token = r.json().token as string;
    const userId = (await db.getUserByEmail("tier@test.dev"))!.id;

    const free = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } });
    expect(free.json().clipQuotaLimit).toBe(10);
    expect(free.json().tier).toBe("free");

    // Simulate a paid upgrade (wireframe webhook mounts only in non-prod test env).
    const act = await app.inject({ method: "POST", url: "/dev/billing/activate", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(act.statusCode).toBe(200);
    expect(act.json().sub.tier).toBe("pro");

    const pro = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } });
    expect(pro.json().tier).toBe("pro");
    expect(pro.json().clipQuotaLimit).toBe(100); // 100 clips/mo included in Pro plan

    // Downgrade/cancel returns to the free 10/mo cap.
    const deact = await app.inject({ method: "POST", url: "/dev/billing/deactivate", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(deact.statusCode).toBe(200);
    const back = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } });
    expect(back.json().tier).toBe("free");
    expect(back.json().clipQuotaLimit).toBe(10);
    await app.close();
  });

  it("an active Pro user can exceed the free cap and submit (quota hard-stop honors the widened cap)", async () => {
    const { app, db } = await buildTestApp({ BETA_CLIP_QUOTA: "10", BILLING_WIREFRAME: "1" });
    const r = await register(app, "tiercap@test.dev", "password123");
    const token = r.json().token as string;
    const userId = (await db.getUserByEmail("tiercap@test.dev"))!.id;
    const act = await app.inject({ method: "POST", url: "/dev/billing/activate", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(act.statusCode).toBe(200);

    // Fill 15 clips this period (above the free 10 cap, below the Pro 100 cap).
    const period = (await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } })).json().clipQuotaPeriod;
    for (let i = 0; i < 15; i++) await db.incrementQuota(userId, period);

    // Submission still allowed (Pro cap is 100).
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath: "/does/not/matter.mp4" },
    });
    expect(res.statusCode).not.toBe(429);
    await app.close();
  });
});

describe("per-user monthly clip quota (entitlement ledger)", () => {
  it("rejects the submission that would exceed the month's quota (429) and surfaces remaining quota", async () => {
    const { app, db } = await buildTestApp({ BETA_CLIP_QUOTA: "2" });
    const r = await register(app, "quota@test.dev", "password123");
    expect(r.statusCode).toBe(200);
    const token = r.json().token as string;
    const userId = (await db.getUserByEmail("quota@test.dev"))!.id;

    const s0 = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } });
    const period = s0.json().clipQuotaPeriod as string;
    expect(s0.json().clipQuotaLimit).toBe(2);

    // Two successful generations fill the 2-clip month.
    await db.incrementQuota(userId, period);
    await db.incrementQuota(userId, period);

    // The 3rd submission -> rejected server-side BEFORE any job runs.
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath: "/does/not/matter.mp4" }, // never reached
    });
    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.code).toBe("quota_exceeded");
    expect(body.clipQuotaRemaining).toBe(0);
    expect(body.clipQuotaLimit).toBe(2);

    // Remaining quota is surfaced for the UI.
    const status = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } });
    const s = status.json();
    expect(s.clipQuotaUsed).toBe(2);
    expect(s.clipQuotaRemaining).toBe(0);
    expect(s.clipQuotaLimit).toBe(2);
    await app.close();
  });

  it("a clip generated successfully debits the quota exactly once; a failed run debits nothing", async () => {
    const { app, db } = await buildTestApp({ BETA_CLIP_QUOTA: "10", FREE_HIGHLIGHTS: "100" });
    const r = await register(app, "meter@test.dev", "password123");
    const token = r.json().token as string;
    const userId = (await db.getUserByEmail("meter@test.dev"))!.id;
    const s0 = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } });
    const period = s0.json().clipQuotaPeriod as string;

    // Real VOD job (fake pipeline) -> exactly one successful highlight -> 1 debit.
    const ok = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath, gameHint: "Esports" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().job.status).toBe("done");
    expect((await db.getQuota(userId, period)).valueOf()).toBe(1);

    // A failing job never created a highlight -> it debits nothing (no double-decrement).
    const fail = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath: "/does/not/exist.mp4" },
    });
    expect([400, 422, 500]).toContain(fail.statusCode);
    expect((await db.getQuota(userId, period)).valueOf()).toBe(1);
    await app.close();
  });
});

describe("invite / beta-gate (hard gate)", () => {
  const gate = { BETA_GATE: "1" };

  it("blocks register without invite (403), then allows a valid single-use code", async () => {
    const { app, cfg } = await buildTestApp(gate);
    const tok = await adminToken(app, cfg);

    const noInvite = await register(app, "gated@test.dev", "password123");
    expect(noInvite.statusCode).toBe(403);
    expect(noInvite.json().code).toBe("invite_required");

    const issued = await app.inject({ method: "POST", url: "/admin/invite-codes", headers: { authorization: `Bearer ${tok}` }, payload: {} });
    expect(issued.statusCode).toBe(200);
    const code = issued.json().code as string;
    expect(code).toHaveLength(12);

    const ok = await register(app, "gated@test.dev", "password123", code);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.role).toBe("user");

    // Single-use: the same code can no longer activate a second account.
    const re = await register(app, "second@test.dev", "password123", code);
    expect(re.statusCode).toBe(403);
    await app.close();
  });

  it("a revoked code cannot activate; a code bound to a different email cannot activate that inbox", async () => {
    const { app, cfg } = await buildTestApp(gate);
    const tok = await adminToken(app, cfg);

    const revoked = await app.inject({ method: "POST", url: "/admin/invite-codes", headers: { authorization: `Bearer ${tok}` }, payload: {} });
    const revCode = revoked.json().code;
    await app.inject({ method: "POST", url: "/admin/invite-codes/revoke", headers: { authorization: `Bearer ${tok}` }, payload: { code: revCode } });
    expect((await register(app, "revoked@test.dev", "password123", revCode)).statusCode).toBe(403);

    const bound = await app.inject({
      method: "POST",
      url: "/admin/invite-codes",
      headers: { authorization: `Bearer ${tok}` },
      payload: { email: "right@test.dev" },
    });
    const boundCode = bound.json().code;
    expect((await register(app, "wrong@test.dev", "password123", boundCode)).statusCode).toBe(403);
    expect((await register(app, "right@test.dev", "password123", boundCode)).statusCode).toBe(200);
    await app.close();
  });

  it("an owner-flipped waitlist email can register without a code; an un-invited waitlister cannot", async () => {
    const { app, cfg, db } = await buildTestApp(gate);
    const tok = await adminToken(app, cfg);

    await app.inject({ method: "POST", url: "/waitlist", payload: { email: "still-waiting@test.dev" } });
    expect((await register(app, "still-waiting@test.dev", "password123")).statusCode).toBe(403);

    const flip = await app.inject({
      method: "POST",
      url: "/admin/waitlist/still-waiting@test.dev/invite",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(flip.statusCode).toBe(200);
    expect(flip.json().status).toBe("invited");
    expect((await db.getWaitlist("still-waiting@test.dev"))!.status).toBe("invited");

    expect((await register(app, "still-waiting@test.dev", "password123")).statusCode).toBe(200);
    await app.close();
  });

  it("gate admin routes require admin (401 unauthenticated)", async () => {
    const { app } = await buildTestApp(gate);
    const anon = await app.inject({ method: "POST", url: "/admin/invite-codes" });
    expect(anon.statusCode).toBe(401);
    await app.close();
  });
});
