import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";
import { BillingRequiredError } from "../src/billing";

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

describe("temporary operator quota lift (ADAAAA-3577)", () => {
  it("with the lift active (BETA_QUOTA_LIFT), a user may exceed the canonical cap toward K=100; the canonical number shown to users stays unchanged", async () => {
    const { app, db, cfg } = await buildTestApp({ BETA_CLIP_QUOTA: "10", BETA_QUOTA_LIFT: "1000", FREE_HIGHLIGHTS: "100" });
    const r = await register(app, "lift@test.dev", "password123");
    expect(r.statusCode).toBe(200);
    const userId = (await db.getUserByEmail("lift@test.dev"))!.id;
    const period = "2026-09";

    // Simulate 12 clips already generated this month (> canonical 10).
    for (let i = 0; i < 12; i++) await db.incrementQuota(userId, period);

    // /billing/status: effective limit lifted, canonical stays 10, lift surfaced.
    const s = (await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${r.json().token}` } })).json();
    expect(s.clipQuotaLimit).toBe(1000);
    expect(s.clipQuotaLimitCanonical).toBe(10);
    expect(s.quotaLiftActive).toBe(true);
    expect(s.clipQuotaUsed).toBe(12);
    expect(s.clipQuotaRemaining).toBe(988);

    // A submission that would have been a premature 429 under the canonical cap
    // must NOT be quota-blocked while the lift is active (it proceeds past the
    // gate to pipeline processing: an ffmpeg failure is expected, not 429).
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${r.json().token}` },
      payload: { videoPath: "/does/not/matter.mp4" },
    });
    expect(res.statusCode).not.toBe(429);
    expect(cfg.betaClipQuota).toBe(10); // canonical config untouched
    await app.close();
  });

  it("the lift is time-boxed: after BETA_QUOTA_LIFT_UNTIL passes, enforcement reverts to the canonical cap", async () => {
    const { app, db } = await buildTestApp({
      BETA_CLIP_QUOTA: "10",
      BETA_QUOTA_LIFT: "1000",
      BETA_QUOTA_LIFT_UNTIL: "2020-01-01T00:00:00Z", // long expired
    });
    const r = await register(app, "expired@test.dev", "password123");
    expect(r.statusCode).toBe(200);
    const userId = (await db.getUserByEmail("expired@test.dev"))!.id;
    const period = "2026-09";

    const s0 = (await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${r.json().token}` } })).json();
    expect(s0.quotaLiftActive).toBe(false);
    expect(s0.clipQuotaLimit).toBe(10);

    // Fill the canonical 10-clip month -> the 11th submission 429s (lift expired).
    for (let i = 0; i < 10; i++) await db.incrementQuota(userId, period);
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${r.json().token}` },
      payload: { videoPath: "/does/not/matter.mp4" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().clipQuotaLimit).toBe(10);
    await app.close();
  });

  it("the lift is reversible: with BETA_QUOTA_LIFT unset, enforcement is the canonical cap", async () => {
    const { app, db } = await buildTestApp({ BETA_CLIP_QUOTA: "10" }); // no lift
    const r = await register(app, "revert@test.dev", "password123");
    const userId = (await db.getUserByEmail("revert@test.dev"))!.id;
    const period = "2026-09";
    const s = (await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${r.json().token}` } })).json();
    expect(s.quotaLiftActive).toBe(false);
    expect(s.clipQuotaLimit).toBe(10);
    expect(s.clipQuotaLimitCanonical).toBe(10);
    for (let i = 0; i < 10; i++) await db.incrementQuota(userId, period);
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${r.json().token}` },
      payload: { videoPath: "/does/not/matter.mp4" },
    });
    expect(res.statusCode).toBe(429);
    await app.close();
  });

  it("the lift also raises the free-tier generation fee gate so a free user isn't 402-blocked before K=100, without changing PLANS", async () => {
    const { app, db, billing } = await buildTestApp({ FREE_HIGHLIGHTS: "3", BETA_QUOTA_LIFT: "1000" });
    const r = await register(app, "freecap@test.dev", "password123");
    const user = (await db.getUserByEmail("freecap@test.dev"))!;
    // 3 used = canonical free cap reached.
    for (let i = 0; i < 3; i++) await db.recordUsage(user.id, "highlight");
    // Lift active -> the next generation does NOT 402.
    await expect(billing.canCreateHighlight(user, { tier: "free", status: "active" } as any)).resolves.toBeUndefined();
    await app.close();
  });

  it("without the lift, the free-tier gate still 402s past the canonical cap", async () => {
    const { app, db, billing } = await buildTestApp({ FREE_HIGHLIGHTS: "3" });
    const r = await register(app, "freeoff@test.dev", "password123");
    const user = (await db.getUserByEmail("freeoff@test.dev"))!;
    for (let i = 0; i < 3; i++) await db.recordUsage(user.id, "highlight");
    await expect(billing.canCreateHighlight(user, { tier: "free", status: "active" } as any)).rejects.toBeInstanceOf(BillingRequiredError);
    await app.close();
  });
});
