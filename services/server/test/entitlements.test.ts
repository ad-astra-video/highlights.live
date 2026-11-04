import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp, waitForJob } from "./helpers";

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
    expect(ok.statusCode).toBe(202);
    expect(ok.json().accepted).toBe(true);
    // ADAAAA-6760: the job is dispatched fire-and-forget; wait for it to finish
    // before the decision-time quota debit is asserted.
    await waitForJob(app, ok.json().job.id, token);
    expect((await db.getQuota(userId, period)).valueOf()).toBe(1);

    // A failing job never created a highlight -> it debits nothing (no double-decrement).
    const fail = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath: "/does/not/exist.mp4" },
    });
    // ADAAAA-6760: submission is accepted immediately (202) and the job is
    // dispatched in the background, where it fails; no highlight is persisted.
    expect(fail.statusCode).toBe(202);
    expect(fail.json().accepted).toBe(true);
    const failed = await waitForJob(app, fail.json().job.id, token);
    expect(failed.job.status).toBe("failed");
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

// ADAAAA-8028: the enforced ceilings are env knobs (PRO_CLIP_QUOTA /
// BETA_CLIP_QUOTA) so a bounded test window can lift them without a DB reset,
// while the GA plan copy (/billing/plans) keeps advertising 10 free / 100 pro.
describe("ADAAAA-8028 tier ceiling knobs (starter 1000 / pro 10000 test posture)", () => {
  it("free (starter) account reports the raised 1000 ceiling", async () => {
    const { app } = await buildTestApp({ BETA_CLIP_QUOTA: "1000", PRO_CLIP_QUOTA: "10000" });
    const r = await register(app, "ceil-free@test.dev", "password123");
    const token = r.json().token as string;
    const s = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } });
    expect(s.json().tier).toBe("free");
    expect(s.json().clipQuotaLimit).toBe(1000);
    expect(s.json().clipQuotaUsed).toBe(0);
    expect(s.json().clipQuotaRemaining).toBe(1000);
    await app.close();
  });

  it("active Pro account reports the raised 10000 ceiling", async () => {
    const { app } = await buildTestApp({ BETA_CLIP_QUOTA: "1000", PRO_CLIP_QUOTA: "10000", BILLING_WIREFRAME: "1" });
    const r = await register(app, "ceil-pro@test.dev", "password123");
    const token = r.json().token as string;
    const act = await app.inject({ method: "POST", url: "/dev/billing/activate", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(act.statusCode).toBe(200);
    const s = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } });
    expect(s.json().tier).toBe("pro");
    expect(s.json().clipQuotaLimit).toBe(10000);
    expect(s.json().clipQuotaRemaining).toBe(10000);
    await app.close();
  });

  // The hard-stop is `used >= limitFor(sub)`; prove both sides of the boundary
  // by driving the ledger row directly (no real clip is generated/burned).
  it("boundary per tier: used == limit -> 429 quota_exceeded (remaining 0), used == limit - 1 -> accepted", async () => {
    // Small knobs so the boundary can be reached with a handful of ledger
    // rows; the limitFor() branch under test is identical to 1000/10000.
    const FREE_LIMIT = 3;
    const PRO_LIMIT = 4;
    const { app, db } = await buildTestApp({
      BETA_CLIP_QUOTA: String(FREE_LIMIT),
      PRO_CLIP_QUOTA: String(PRO_LIMIT),
      BILLING_WIREFRAME: "1",
    });

    const submit = (token: string) =>
      app.inject({
        method: "POST",
        url: "/jobs",
        headers: { authorization: `Bearer ${token}` },
        payload: { videoPath: "/does/not/matter.mp4" }, // quota check runs before the file is touched
      });

    // --- starter (free) tier ---
    const freeReg = await register(app, "bound-free@test.dev", "password123");
    const freeToken = freeReg.json().token as string;
    const freeId = (await db.getUserByEmail("bound-free@test.dev"))!.id;
    const freeStatus = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${freeToken}` } });
    const period = freeStatus.json().clipQuotaPeriod as string;
    expect(freeStatus.json().clipQuotaLimit).toBe(FREE_LIMIT);

    for (let i = 0; i < FREE_LIMIT - 1; i++) await db.incrementQuota(freeId, period);
    expect((await submit(freeToken)).statusCode).not.toBe(429); // used == limit - 1
    const freeAtLimit = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${freeToken}` } });
    expect(freeAtLimit.json().clipQuotaRemaining).toBe(1);

    await db.incrementQuota(freeId, period); // used == limit
    const freeRejected = await submit(freeToken);
    expect(freeRejected.statusCode).toBe(429);
    expect(freeRejected.json().code).toBe("quota_exceeded");
    expect(freeRejected.json().clipQuotaRemaining).toBe(0);
    expect(freeRejected.json().clipQuotaLimit).toBe(FREE_LIMIT);

    // --- pro tier ---
    const proReg = await register(app, "bound-pro@test.dev", "password123");
    const proToken = proReg.json().token as string;
    const proId = (await db.getUserByEmail("bound-pro@test.dev"))!.id;
    const act = await app.inject({ method: "POST", url: "/dev/billing/activate", headers: { authorization: `Bearer ${proToken}` }, payload: {} });
    expect(act.statusCode).toBe(200);
    const proStatus = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${proToken}` } });
    expect(proStatus.json().clipQuotaLimit).toBe(PRO_LIMIT);

    for (let i = 0; i < PRO_LIMIT - 1; i++) await db.incrementQuota(proId, period);
    expect((await submit(proToken)).statusCode).not.toBe(429); // used == limit - 1
    const proAtLimit = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${proToken}` } });
    expect(proAtLimit.json().clipQuotaRemaining).toBe(1);

    await db.incrementQuota(proId, period); // used == limit
    const proRejected = await submit(proToken);
    expect(proRejected.statusCode).toBe(429);
    expect(proRejected.json().code).toBe("quota_exceeded");
    expect(proRejected.json().clipQuotaRemaining).toBe(0);
    expect(proRejected.json().clipQuotaLimit).toBe(PRO_LIMIT);

    await app.close();
  });
});
