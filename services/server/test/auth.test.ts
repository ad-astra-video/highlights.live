import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers";

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
    expect(db.getUserByEmail("u@x.dev")!.role).toBe("user");
    await app.close();
  });

  it("seeds and admin logs in", async () => {
    const { app, cfg } = await buildTestApp();
    const admin = await app.inject({ method: "POST", url: "/auth/login", payload: { email: cfg.adminEmail, password: cfg.adminPassword } });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().user.role).toBe("admin");
    await app.close();
  });
});
