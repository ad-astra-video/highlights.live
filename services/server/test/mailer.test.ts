import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers";

/** Mailer delivery wiring: the API server enqueues transactional emails (invite,
 * password reset) through the mailer while never leaking account existence. */

describe("mailer: invite email delivery", () => {
  it("emails a code-bound invite code (openable + usable at registration)", async () => {
    const { app, cfg, mailer } = await buildTestApp({ BETA_GATE: "1" });
    const admin = await app.inject({ method: "POST", url: "/auth/login", payload: { email: cfg.adminEmail, password: cfg.adminPassword } });
    const tok = admin.json().token as string;

    const issued = await app.inject({
      method: "POST",
      url: "/admin/invite-codes",
      headers: { authorization: `Bearer ${tok}` },
      payload: { email: "invited@example.com" },
    });
    expect(issued.statusCode).toBe(200);
    const code = issued.json().code as string;

    // An invite email was enqueued for the bound email, containing the code.
    expect(mailer.sent.length).toBe(1);
    const em = mailer.sent[0];
    expect(em.to).toBe("invited@example.com");
    expect(em.subject).toMatch(/invited/i);
    expect(em.body).toContain(code);

    // The emailed code activates the account at registration (end to end).
    const ok = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "invited@example.com", password: "password123", inviteCode: code },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it("emails an invitation when a waitlisted inbox is flipped to invited", async () => {
    const { app, cfg, mailer } = await buildTestApp({ BETA_GATE: "1" });
    const admin = await app.inject({ method: "POST", url: "/auth/login", payload: { email: cfg.adminEmail, password: cfg.adminPassword } });
    const tok = admin.json().token as string;

    await app.inject({ method: "POST", url: "/waitlist", payload: { email: "fan@example.com" } });
    const flip = await app.inject({
      method: "POST",
      url: "/admin/waitlist/fan@example.com/invite",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(flip.statusCode).toBe(200);
    expect(flip.json().status).toBe("invited");

    // An invitation email was enqueued for the flipped inbox.
    expect(mailer.sent.length).toBe(1);
    const em = mailer.sent[0];
    expect(em.to).toBe("fan@example.com");
    expect(em.subject).toMatch(/invited/i);
    expect(em.body).toContain(cfg.publicBaseUrl);
    await app.close();
  });
});

describe("mailer: anti-enumeration on password reset", () => {
  it("a mailer failure still returns {ok:true} and never reveals the token or existence", async () => {
    const { app, mailer } = await buildTestApp();
    await app.inject({ method: "POST", url: "/auth/register", payload: { email: "u@x.dev", password: "password123" } });

    // Make the mailer fail: delivery failure must not leak account existence.
    mailer.fail = true;
    const forgot = await app.inject({ method: "POST", url: "/auth/forgot", payload: { email: "u@x.dev" } });
    expect(forgot.statusCode).toBe(200);
    expect(forgot.json()).toEqual({ ok: true }); // identical to the unknown-email response

    const unknown = await app.inject({ method: "POST", url: "/auth/forgot", payload: { email: "nobody@x.dev" } });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({ ok: true });
    await app.close();
  });

  it("forgot is identical for known and unknown email (no resetToken returned)", async () => {
    const { app } = await buildTestApp();
    await app.inject({ method: "POST", url: "/auth/register", payload: { email: "u@x.dev", password: "password123" } });
    const known = await app.inject({ method: "POST", url: "/auth/forgot", payload: { email: "u@x.dev" } });
    const unknown = await app.inject({ method: "POST", url: "/auth/forgot", payload: { email: "nobody@x.dev" } });
    expect(known.statusCode).toBe(200);
    expect(known.json()).toEqual({ ok: true });
    expect(unknown.json()).toEqual(known.json());
    await app.close();
  });
});
