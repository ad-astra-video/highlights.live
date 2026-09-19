import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers";
import { AuthService } from "../src/auth";

describe("auth", () => {
  it("registers, rejects duplicates + short passwords, logs in with a token", async () => {
    const { app, db } = await buildTestApp();
    const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "u@x.dev", password: "password123" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().token).toBeTruthy();

    const dup = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "u@x.dev", password: "password123" } });
    expect(dup.statusCode).toBe(400);

    const short = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "s@x.dev", password: "short" } });
    expect(short.statusCode).toBe(400);

    const bad = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "u@x.dev", password: "wrong" } });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "u@x.dev", password: "password123" } });
    expect(ok.statusCode).toBe(200);
    expect((await db.getUserByEmail("u@x.dev"))!.role).toBe("user");
    await app.close();
  });

  it("seeds and admin logs in", async () => {
    const { app, cfg } = await buildTestApp();
    const admin = await app.inject({ method: "POST", url: "/auth/login", payload: { email: cfg.adminEmail, password: cfg.adminPassword } });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().user.role).toBe("admin");
    await app.close();
  });

  it("password reset: forgot -> email with reset link -> new password logs in, old fails", async () => {
    const { app, mailer } = await buildTestApp();
    await app.inject({ method: "POST", url: "/auth/register", payload: { email: "u@x.dev", password: "password123" } });

    // Unknown email -> ok:true, no email sent (no account enumeration).
    const unknown = await app.inject({ method: "POST", url: "/auth/forgot", payload: { email: "nobody@x.dev" } });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({ ok: true });
    expect(mailer.sent.length).toBe(0);

    // Known email -> ok:true (token never returned inline). The reset link is
    // delivered through the mailer (the email-sender container).
    const forgot = await app.inject({ method: "POST", url: "/auth/forgot", payload: { email: "u@x.dev" } });
    expect(forgot.statusCode).toBe(200);
    expect(forgot.json()).toEqual({ ok: true });
    expect(mailer.sent.length).toBe(1);
    const resetEmail = mailer.sent[0];
    expect(resetEmail.to).toBe("u@x.dev");
    expect(resetEmail.subject).toMatch(/reset/i);
    const token = /token=([0-9a-f]+)/i.exec(resetEmail.body)?.[1];
    expect(token).toBeTruthy();

    // Redeem with a too-short password is rejected.
    const short = await app.inject({ method: "POST", url: "/auth/reset", payload: { token, password: "short" } });
    expect(short.statusCode).toBe(400);

    const reset = await app.inject({ method: "POST", url: "/auth/reset", payload: { token, password: "brand-new-pass" } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ ok: true });

    // Old password no longer works; new one does.
    const old = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "u@x.dev", password: "password123" } });
    expect(old.statusCode).toBe(401);
    const fresh = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "u@x.dev", password: "brand-new-pass" } });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().token).toBeTruthy();

    // Token is single-use: replaying it now fails.
    const replay = await app.inject({ method: "POST", url: "/auth/reset", payload: { token, password: "another-pass" } });
    expect(replay.statusCode).toBe(400);
    const bogus = await app.inject({ method: "POST", url: "/auth/reset", payload: { token: "0000", password: "another-pass" } });
    expect(bogus.statusCode).toBe(400);
    await app.close();
  });

  it("password reset rejects an expired token", async () => {
    const { app, db } = await buildTestApp();
    await app.inject({ method: "POST", url: "/auth/register", payload: { email: "u@x.dev", password: "password123" } });
    const user = (await db.getUserByEmail("u@x.dev"))!;
    const token = "expired-token";
    // Set a token that is already past its expiry.
    await db.setResetToken(user.id, AuthService.hashResetToken(token), new Date(Date.now() - 1000).toISOString());
    const r = await app.inject({ method: "POST", url: "/auth/reset", payload: { token, password: "brand-new-pass" } });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it("rate limits the auth endpoints per IP", async () => {
    const { app } = await buildTestApp({ AUTH_RATE_LIMIT: "3" });
    // Three hits allowed (bad credentials still count against the budget).
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "u@x.dev", password: "wrong" } });
      expect(r.statusCode).toBe(401);
    }
    // Fourth hit from the same IP is throttled.
    const throttled = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "u@x.dev", password: "wrong" } });
    expect(throttled.statusCode).toBe(429);
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    // Forgot shares the same per-IP budget.
    const forgotThrottled = await app.inject({ method: "POST", url: "/auth/forgot", payload: { email: "u@x.dev" } });
    expect(forgotThrottled.statusCode).toBe(429);
    await app.close();
  });
});
