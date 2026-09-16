import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";

describe("public waitlist (beta landing capture)", () => {
  it("stores an email, dedupes by normalized email, and lists for admin", async () => {
    const { app, cfg } = await buildTestApp();

    // First submit registers a new entry.
    const first = await app.inject({ method: "POST", url: "/waitlist", payload: { email: "  Fan@Example.COM " } });
    expect(first.statusCode).toBe(200);
    const j1 = first.json();
    expect(j1.ok).toBe(true);
    expect(j1.registered).toBe(true);
    expect(j1.message).toContain("You're on the list");

    // Same email (case + whitespace normalized) is a dedupe, still confirms.
    const second = await app.inject({ method: "POST", url: "/waitlist", payload: { email: "fan@example.com" } });
    expect(second.statusCode).toBe(200);
    expect(second.json().registered).toBe(false);

    // A different email registers a second entry.
    const third = await app.inject({ method: "POST", url: "/waitlist", payload: { email: "other@example.com" } });
    expect(third.json().registered).toBe(true);

    // Invalid emails are rejected.
    const bad = await app.inject({ method: "POST", url: "/waitlist", payload: { email: "not-an-email" } });
    expect(bad.statusCode).toBe(400);

    // Admin can inspect the list + count (signup-rate counter source).
    const anon = await app.inject({ method: "GET", url: "/waitlist" });
    expect(anon.statusCode).toBe(401);

    const admin = await app.inject({ method: "POST", url: "/auth/login", payload: { email: cfg.adminEmail, password: cfg.adminPassword } });
    const adminTok = admin.json().token as string;
    const list = await app.inject({ method: "GET", url: "/waitlist", headers: { authorization: `Bearer ${adminTok}` } });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.count).toBe(2);
    const emails = body.emails.map((e: any) => e.email);
    expect(emails).toContain("fan@example.com");
    expect(emails).toContain("other@example.com");
  });

  it("never exposes product data over the waitlist surface and returns JSON 404 for unknown /api routes", async () => {
    const { app } = await buildTestApp();
    // Unknown API path -> JSON 404 (not the SPA).
    const unknown = await app.inject({ method: "GET", url: "/api/nope" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers["content-type"] || "").toContain("application/json");
  });
});

describe("SPA static serving (landing over HTTPS)", () => {
  const dist = mkdtempSync(path.join(tmpdir(), "hl-dist-"));
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  it("serves the built webapp at / and falls back to index.html for SPA routes", async () => {
    writeFileSync(path.join(dist, "index.html"), "<!doctype html><html><head></head><body>LANDING</body></html>");
    writeFileSync(path.join(dist, "bolt.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");

    const { app } = await buildTestApp({ WEBAPP_DIST: dist });

    // Landing route serves the SPA html.
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.body).toContain("LANDING");

    // A client-side route deep link (no real file) falls back to index.html.
    const deep = await app.inject({ method: "GET", url: "/privacy" });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain("LANDING");

    // A static asset is served with its own type.
    const asset = await app.inject({ method: "GET", url: "/bolt.svg" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("image/svg+xml");

    // Path traversal is rejected.
    const trav = await app.inject({ method: "GET", url: "/..%2f..%2fetc%2fpasswd" });
    expect([200, 403].includes(trav.statusCode)).toBe(true);
    expect(trav.body).not.toContain("root:");
  });
});
