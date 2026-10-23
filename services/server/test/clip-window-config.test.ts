import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";

const tmp = mkdtempSync(path.join(tmpdir(), "hl-cw-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function register(app: any, email: string, pw: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

describe("GET /config/clip-window (ADAAAA-7247 / ACC-7)", () => {
  it("returns the env defaults (7/8) and persisted=false when never set", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/config/clip-window" });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.clipBeforeS).toBe(7);
    expect(b.clipAfterS).toBe(8);
    expect(b.clipWindowMinSec).toBe(15);
    expect(b.persisted).toBe(false);
    expect(b.deliveredWindowSec).toBe(15);
  });
});

describe("PUT /config/clip-window (ADAAAA-7247 / ACC-7)", () => {
  it("persists valid whole-second values (auth required) and returns the effective window", async () => {
    const { app } = await buildTestApp();
    const token = await register(app, "b@test.dev", "password123");
    const res = await app.inject({
      method: "PUT",
      url: "/config/clip-window",
      headers: { authorization: `Bearer ${token}` },
      payload: { clipBeforeS: 10, clipAfterS: 20 },
    });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.persisted).toBe(true);
    expect(b.clipBeforeS).toBe(10);
    expect(b.clipAfterS).toBe(20);
    expect(b.windowSec).toBe(30);
    expect(b.deliveredWindowSec).toBe(30);

    // GET now reflects the persisted value.
    const g = await app.inject({ method: "GET", url: "/config/clip-window" });
    expect(g.json().clipBeforeS).toBe(10);
    expect(g.json().clipAfterS).toBe(20);
    expect(g.json().persisted).toBe(true);
  });

  it("rejects negative / non-numeric / fractional / out-of-range values with a clear 400", async () => {
    const { app } = await buildTestApp();
    const token = await register(app, "c@test.dev", "password123");
    const cases: [Record<string, unknown>, string][] = [
      [{ clipBeforeS: -1, clipAfterS: 8 }, "0 or more seconds"],
      [{ clipBeforeS: 7, clipAfterS: "8" }, "clipAfterS must be a number"],
      [{ clipBeforeS: 7.5, clipAfterS: 8 }, "whole number"],
      [{ clipBeforeS: 99999, clipAfterS: 8 }, "capped at"],
    ];
    for (const [payload, msg] of cases) {
      const res = await app.inject({
        method: "PUT",
        url: "/config/clip-window",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      expect(res.statusCode).toBe(400);
      const b = res.json();
      expect(b.code).toBe("invalid_clip_window");
      expect(b.error).toContain(msg);
    }
  });

  it("rejects an unauthenticated PUT", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "PUT",
      url: "/config/clip-window",
      payload: { clipBeforeS: 10, clipAfterS: 20 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("persists across a server restart (file-backed DB) and wins at assembly", async () => {
    const dbPath = path.join(tmp, "restart.db");
    // First server instance persists the setting.
    const a = await buildTestApp({ DATABASE_PATH: dbPath });
    const token = await register(a.app, "d@test.dev", "password123");
    const put = await a.app.inject({
      method: "PUT",
      url: "/config/clip-window",
      headers: { authorization: `Bearer ${token}` },
      payload: { clipBeforeS: 12, clipAfterS: 13 },
    });
    expect(put.statusCode).toBe(200);

    // Fresh server instance on the SAME file db sees the persisted value.
    const b = await buildTestApp({ DATABASE_PATH: dbPath });
    const g = await b.app.inject({ method: "GET", url: "/config/clip-window" });
    expect(g.json().clipBeforeS).toBe(12);
    expect(g.json().clipAfterS).toBe(13);
    expect(g.json().persisted).toBe(true);
    // The setting also survives on the underlying Db so assembly resolves it.
    const s = await b.db.getClipWindowSettings();
    expect(s).toEqual({ clipBeforeS: 12, clipAfterS: 13 });
  });
});
