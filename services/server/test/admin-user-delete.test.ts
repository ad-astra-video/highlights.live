// Admin user-delete route (ADAAAA-7968). Proves the destructive admin surface
// end to end against the shared db-backed app:
//   1. `DELETE /admin/users/:id` is admin-only (`adminReq`): 401 anonymous, 403
//      for a role=user token.
//   2. A delete cascades the account's entitlement rows (`subscriptions` +
//      `quota_ledger`) but RETAINS job/usage evidence rows (graded level
//      artifacts and funnel counters are evidence, never silently dropped).
//   3. The deletion appends one `admin_audit` row naming actor, target and
//      action, readable through `GET /admin/audit`.
//   4. Idempotency contract: an unknown id — including a second delete of the
//      same id — answers `404 {deleted:false}` and writes nothing.
//   5. An admin account is refused (409) without `?force=1`; force deletes it.
import { describe, it, expect } from "vitest";
import { buildTestApp, type TestApp } from "./helpers";

const PERIOD = "2026-11";

async function register(app: any, email: string, pw = "password123"): Promise<{ token: string; user: any }> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  const body = r.json();
  return { token: body.token as string, user: body.user };
}

async function adminToken(t: TestApp): Promise<string> {
  const r = await t.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: t.cfg.adminEmail, password: t.cfg.adminPassword },
  });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

/** Seed the entitlement rows a real QA account accumulates: a comped Pro
 * subscription row + a quota-ledger row for the month. */
async function seedEntitlements(t: TestApp, userId: string): Promise<void> {
  await t.db.setSubscription(userId, { tier: "pro", status: "active" });
  await t.db.incrementQuota(userId, PERIOD);
  await t.db.incrementQuota(userId, PERIOD);
}

describe("DELETE /admin/users/:id (admin user lifecycle, ADAAAA-7968)", () => {
  it("is admin-only and answers 401 anonymous / 403 for a plain user", async () => {
    const t = await buildTestApp();
    const victim = await register(t.app, "qa-auth-guard@test.dev");

    const anon = await t.app.inject({ method: "DELETE", url: `/admin/users/${victim.user.id}` });
    expect(anon.statusCode).toBe(401);

    const asUser = await t.app.inject({
      method: "DELETE",
      url: `/admin/users/${victim.user.id}`,
      headers: { authorization: `Bearer ${victim.token}` },
    });
    expect(asUser.statusCode).toBe(403);
    // The rejected calls must not have deleted anything.
    expect(await t.db.getUserById(victim.user.id)).toBeTruthy();
  });

  it("cascades entitlement rows, retains evidence rows, and audits actor/target", async () => {
    const t = await buildTestApp();
    const admin = await adminToken(t);
    const victim = await register(t.app, "qa-sweep-1793900000@test.dev");
    await seedEntitlements(t, victim.user.id);
    expect(await t.db.getQuota(victim.user.id, PERIOD)).toBe(2);

    // Evidence rows that must survive the account deletion.
    const job = await t.store.createJob({ ownerId: victim.user.id, source: "file" });
    await t.db.recordUsage(victim.user.id, "clip");

    const del = await t.app.inject({
      method: "DELETE",
      url: `/admin/users/${victim.user.id}`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(del.statusCode).toBe(200);
    const body = del.json();
    expect(body.deleted).toBe(true);
    expect(body.user).toMatchObject({ id: victim.user.id, email: "qa-sweep-1793900000@test.dev", role: "user" });
    expect(body.cascaded).toEqual({ subscriptions: 1, quotaLedger: 1 });
    expect(typeof body.auditId).toBe("string");

    // Account + entitlement rows gone.
    expect(await t.db.getUserById(victim.user.id)).toBeUndefined();
    expect(await t.db.getUserByEmail("qa-sweep-1793900000@test.dev")).toBeUndefined();
    expect(await t.db.getQuota(victim.user.id, PERIOD)).toBe(0);

    // Evidence rows retained: the graded level job still reads, and the usage
    // counter stays historical.
    const retainedJob = await t.db.getJob(job.id);
    expect(retainedJob?.ownerId).toBe(victim.user.id);
    expect(await t.db.countUsage(victim.user.id, "clip")).toBeGreaterThan(0);

    // One audit row, naming the admin actor and the deleted account.
    const audit = await t.app.inject({
      method: "GET",
      url: "/admin/audit?limit=10",
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(audit.statusCode).toBe(200);
    const entry = audit.json().entries.find((e: any) => e.id === body.auditId);
    expect(entry).toBeTruthy();
    expect(entry).toMatchObject({
      action: "user.delete",
      targetId: victim.user.id,
      targetEmail: "qa-sweep-1793900000@test.dev",
      actorEmail: t.cfg.adminEmail,
    });
    expect(entry.detail).toMatchObject({ role: "user", forced: false });
  });

  it("is idempotent: a repeat delete is 404 deleted:false with no extra audit row", async () => {
    const t = await buildTestApp();
    const admin = await adminToken(t);
    const victim = await register(t.app, "qa-repeat-1793900001@test.dev");

    const first = await t.app.inject({
      method: "DELETE",
      url: `/admin/users/${victim.user.id}`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(first.statusCode).toBe(200);
    const auditsAfterFirst = (await t.db.listAdminAudit(100)).filter((e) => e.targetId === victim.user.id);
    expect(auditsAfterFirst).toHaveLength(1);

    const repeat = await t.app.inject({
      method: "DELETE",
      url: `/admin/users/${victim.user.id}`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(repeat.statusCode).toBe(404);
    expect(repeat.json()).toMatchObject({ deleted: false });
    expect((await t.db.listAdminAudit(100)).filter((e) => e.targetId === victim.user.id)).toHaveLength(1);

    const unknown = await t.app.inject({
      method: "DELETE",
      url: "/admin/users/does-not-exist",
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ deleted: false });
  });

  it("refuses an admin account without ?force=1 and deletes it with force", async () => {
    const t = await buildTestApp();
    const admin = await adminToken(t);
    const other = await t.db.createUser({
      id: "qa-admin-1793900002",
      email: "qa-admin-1793900002@test.dev",
      passwordHash: "x",
      role: "admin",
      stripeCustomerId: null,
    });

    const refused = await t.app.inject({
      method: "DELETE",
      url: `/admin/users/${other.id}`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(refused.statusCode).toBe(409);
    expect(await t.db.getUserById(other.id)).toBeTruthy();

    const forced = await t.app.inject({
      method: "DELETE",
      url: `/admin/users/${other.id}?force=1`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toMatchObject({ deleted: true, cascaded: { subscriptions: 0, quotaLedger: 0 } });
    expect(await t.db.getUserById(other.id)).toBeUndefined();

    // The seeded admin is still intact (the guardrail account).
    expect(await t.db.getUserByEmail(t.cfg.adminEmail)).toBeTruthy();
  });
});
