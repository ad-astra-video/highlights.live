import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, DEFAULT_JWT_SECRET, INSECURE_JWT_SECRETS } from "../src/config";
import { DEFAULT_ADMIN_PASSWORD, INSECURE_ADMIN_PASSWORDS, resolveAdminPassword } from "../src/config";
import {
  deriveExportTokenSecret,
  mintExportToken,
  verifyExportToken,
  EXPORT_TOKEN_VERSION,
} from "../src/export-token";
import { buildTestApp } from "./helpers";
import type { TestApp } from "./helpers";

// ADAAAA-7901: the deployed box signed sessions (and, via ADAAAA-7896, export
// tokens) with the compose default `JWT_SECRET=dev-secret`. Anyone with the repo
// could mint an admin session offline and `GET /feed` published the admin user
// id. These tests pin the fix:
//
//  S1  production boot refuses unset / documented-default JWT_SECRET (fail loud)
//  S2  the export secret is dedicated (EXPORT_TOKEN_SECRET or HKDF), never the
//      session secret, and cannot equal it
//  S3  an export token minted the old way (raw jwtSecret, no domain tag) is
//      refused at the /clips route and leaves no export stamp
//  S4  an export token is not a session (Bearer -> 401) and a session is not an
//      export token (x= -> 403)
//  S5  the public /feed no longer publishes ownerId / exportedBy
//
// Pure API/config level: no perceive/analyzer/decide/Livepeer path is touched.

const STRONG_SECRET = "b7d1f4e9a2c3b5d7e9f1a3c5b7d9e1f3a5c7b9d1e3f5a7c9b1d3e5f7a9c1b3d5";
/** A production-valid admin password (ADAAAA-7904 made it required in prod). */
const STRONG_ADMIN_PW = "rotated-box-admin-pw-1";

function b64(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** The pre-ADAAAA-7901 minting scheme: HMAC(jwtSecret, base64url({h,u})). */
function legacyToken(secret: string, h: string, u: string): string {
  const body = b64(JSON.stringify({ h, u }));
  return `${body}.${b64(createHmac("sha256", secret).update(body).digest())}`;
}

/** A hand-rolled "clip-export"-tagged token signed with the session secret —
 * the shape the ticket's acceptance criteria names. It must still be refused:
 * the server's dedicated export secret never produced it. */
function handRolledClipExportToken(secret: string, h: string, u: string): string {
  const body = b64(JSON.stringify({ v: "clip-export", h, u }));
  return `${body}.${b64(createHmac("sha256", `clip-export:${secret}`).update(body).digest())}`;
}

describe("ADAAAA-7901 S1: production boot refuses an insecure session secret", () => {
  it("throws when JWT_SECRET is unset in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/JWT_SECRET is required/);
  });

  it("throws when JWT_SECRET is empty/blank in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production", JWT_SECRET: "   " })).toThrow(
      /JWT_SECRET is required/
    );
  });

  it.each(INSECURE_JWT_SECRETS)("throws when JWT_SECRET is the documented default %s", (secret) => {
    expect(() => loadConfig({ NODE_ENV: "production", JWT_SECRET: secret })).toThrow(
      /documented insecure default/
    );
  });

  it("boots in production with a real secret and keeps dev/test on the fallback", () => {
    const prod = loadConfig({ NODE_ENV: "production", JWT_SECRET: STRONG_SECRET, ADMIN_PASSWORD: STRONG_ADMIN_PW });
    expect(prod.jwtSecret).toBe(STRONG_SECRET);
    // Dev (NODE_ENV unset -> development) keeps the local `pnpm dev` behaviour.
    const dev = loadConfig({});
    expect(dev.jwtSecret).toBe(DEFAULT_JWT_SECRET);
    expect(dev.nodeEnv).toBe("development");
  });
});

describe("ADAAAA-7904 S6: production boot refuses the published admin password", () => {
  it("throws when ADMIN_PASSWORD is unset in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production", JWT_SECRET: STRONG_SECRET })).toThrow(
      /ADMIN_PASSWORD is required/
    );
  });

  it("throws when ADMIN_PASSWORD is empty/blank in production", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", JWT_SECRET: STRONG_SECRET, ADMIN_PASSWORD: "   " })
    ).toThrow(/ADMIN_PASSWORD is required/);
  });

  it.each(INSECURE_ADMIN_PASSWORDS)("throws when ADMIN_PASSWORD is the documented default %s", (pw) => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", JWT_SECRET: STRONG_SECRET, ADMIN_PASSWORD: pw })
    ).toThrow(/documented default/);
  });

  it("boots in production with a real admin password and keeps dev on the fallback", () => {
    const prod = loadConfig({
      NODE_ENV: "production",
      JWT_SECRET: STRONG_SECRET,
      ADMIN_PASSWORD: STRONG_ADMIN_PW,
    });
    expect(prod.adminPassword).toBe(STRONG_ADMIN_PW);
    // Dev (NODE_ENV unset -> development) keeps `pnpm dev` booting unconfigured.
    const dev = loadConfig({});
    expect(dev.adminPassword).toBe(DEFAULT_ADMIN_PASSWORD);
    expect(DEFAULT_ADMIN_PASSWORD).toBe("admin");
    expect(resolveAdminPassword(undefined, "development")).toBe("admin");
    expect(resolveAdminPassword("", "test")).toBe("admin");
  });
});

describe("ADAAAA-7901 S2: the export secret is dedicated, never the session secret", () => {
  it("derives a distinct export secret from the session secret (HKDF-SHA256)", () => {
    const derived = deriveExportTokenSecret(STRONG_SECRET);
    expect(derived).toHaveLength(64); // 32 bytes hex
    expect(derived).not.toBe(STRONG_SECRET);
    expect(deriveExportTokenSecret(STRONG_SECRET)).toBe(derived); // deterministic
    expect(deriveExportTokenSecret("other")).not.toBe(derived);
  });

  it("uses the derivation when EXPORT_TOKEN_SECRET is unset", () => {
    const cfg = loadConfig({ NODE_ENV: "production", JWT_SECRET: STRONG_SECRET, ADMIN_PASSWORD: STRONG_ADMIN_PW });
    expect(cfg.exportTokenSecret).toBe(deriveExportTokenSecret(STRONG_SECRET));
    expect(cfg.exportTokenSecret).not.toBe(cfg.jwtSecret);
  });

  it("honours an explicit EXPORT_TOKEN_SECRET", () => {
    const cfg = loadConfig({
      NODE_ENV: "production",
      JWT_SECRET: STRONG_SECRET,
      ADMIN_PASSWORD: STRONG_ADMIN_PW,
      EXPORT_TOKEN_SECRET: "f".repeat(40),
    });
    expect(cfg.exportTokenSecret).toBe("f".repeat(40));
  });

  it("refuses EXPORT_TOKEN_SECRET equal to JWT_SECRET (any environment)", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", JWT_SECRET: STRONG_SECRET, ADMIN_PASSWORD: STRONG_ADMIN_PW, EXPORT_TOKEN_SECRET: STRONG_SECRET })
    ).toThrow(/must differ from JWT_SECRET/);
    expect(() => loadConfig({ JWT_SECRET: "test-secret", EXPORT_TOKEN_SECRET: "test-secret" })).toThrow(
      /must differ from JWT_SECRET/
    );
  });

  it("refuses a too-short explicit export secret in production", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", JWT_SECRET: STRONG_SECRET, ADMIN_PASSWORD: STRONG_ADMIN_PW, EXPORT_TOKEN_SECRET: "short" })
    ).toThrow(/too short/);
  });
});

describe("ADAAAA-7901 S3/S4: export tokens are not sessions and vice versa", () => {
  it("refuses a legacy token signed with the raw session secret", () => {
    const exportSecret = deriveExportTokenSecret(STRONG_SECRET);
    const legacy = legacyToken(STRONG_SECRET, "h1", "u1");
    expect(verifyExportToken(exportSecret, legacy)).toBeNull();
  });

  it("refuses a hand-rolled clip-export-tagged token signed outside the server secret", () => {
    const exportSecret = deriveExportTokenSecret(STRONG_SECRET);
    expect(verifyExportToken(exportSecret, handRolledClipExportToken(STRONG_SECRET, "h1", "u1"))).toBeNull();
  });

  it("refuses a correctly-keyed body that is missing the domain tag", () => {
    const exportSecret = deriveExportTokenSecret(STRONG_SECRET);
    // Signed with the RIGHT export secret but no `v` field: this is the shape
    // the previous revision minted, so a token from before the fix stays dead.
    const body = b64(JSON.stringify({ h: "h1", u: "u1" }));
    const forged = `${body}.${b64(createHmac("sha256", exportSecret).update(body).digest())}`;
    expect(verifyExportToken(exportSecret, forged)).toBeNull();
  });

  it("accepts only tokens the dedicated export secret produced", () => {
    const exportSecret = deriveExportTokenSecret(STRONG_SECRET);
    const token = mintExportToken(exportSecret, "h1", "u1");
    expect(verifyExportToken(exportSecret, token)).toEqual({ v: EXPORT_TOKEN_VERSION, h: "h1", u: "u1" });
    expect(verifyExportToken(STRONG_SECRET, token)).toBeNull();
    expect(verifyExportToken(deriveExportTokenSecret("other"), token)).toBeNull();
  });
});

async function register(app: any, email: string, pw = "password123"): Promise<{ token: string; id: string }> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  const token = r.json().token as string;
  const me = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
  expect(me.statusCode).toBe(200);
  return { token, id: me.json().user.id };
}

async function seedClip(
  t: TestApp,
  opts: { id: string; jobId: string; ownerId: string; bytes: Buffer }
): Promise<{ id: string; clipUri: string }> {
  const filename = `${opts.id}.mp4`;
  const dir = path.join(t.cfg.dataDir, "clips");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, filename), opts.bytes);
  const clipUri = `/clips/${filename}`;
  await t.store.addHighlight({
    id: opts.id,
    ownerId: opts.ownerId,
    jobId: opts.jobId,
    clipUri,
    start: 10,
    end: 30,
    eventType: "GOAL",
    outcome: "scoring_play",
    score: 90,
    status: "accepted",
    createdAt: new Date().toISOString(),
  });
  return { id: opts.id, clipUri };
}

const BYTES = Buffer.from("clip-bytes-for-export-token-refusal");

describe("ADAAAA-7901 S3 (route): a forged export token marks nothing", () => {
  it("403s a legacy jwtSecret-signed token and a hand-rolled clip-export token, leaving no stamp", async () => {
    const t = await buildTestApp();
    const user = await register(t.app, "sec3@test.dev");
    const job = await t.store.createJob({ ownerId: user.id, source: "file" });
    const clip = await seedClip(t, { id: "h-sec3", jobId: job.id, ownerId: user.id, bytes: BYTES });

    // Both forged shapes are minted from the SESSION secret, which the server
    // no longer uses for export tokens.
    const forgeries = [
      legacyToken(t.cfg.jwtSecret, clip.id, user.id),
      handRolledClipExportToken(t.cfg.jwtSecret, clip.id, user.id),
    ];
    for (const forged of forgeries) {
      const res = await t.app.inject({ method: "GET", url: `${clip.clipUri}?x=${encodeURIComponent(forged)}` });
      expect(res.statusCode).toBe(403);
      expect(t.store.getHighlight(clip.id)?.exportedAt).toBeUndefined();
    }

    // The token the SERVER mints (export secret) still works, so the reject
    // lock ADAAAA-7896 shipped keeps functioning.
    const good = mintExportToken(t.cfg.exportTokenSecret, clip.id, user.id);
    const ok = await t.app.inject({ method: "GET", url: `${clip.clipUri}?x=${encodeURIComponent(good)}` });
    expect(ok.statusCode).toBe(200);
    expect(t.store.getHighlight(clip.id)?.exportedAt).toBeTruthy();
    expect(t.store.getHighlight(clip.id)?.exportedBy).toBe(user.id);
    await t.app.close();
  });

  it("403s a token minted for clip A when used on clip B's file", async () => {
    const t = await buildTestApp();
    const user = await register(t.app, "sec3b@test.dev");
    const job = await t.store.createJob({ ownerId: user.id, source: "file" });
    const a = await seedClip(t, { id: "h-a", jobId: job.id, ownerId: user.id, bytes: BYTES });
    const b = await seedClip(t, { id: "h-b", jobId: job.id, ownerId: user.id, bytes: BYTES });
    const tokenForA = mintExportToken(t.cfg.exportTokenSecret, a.id, user.id);
    const res = await t.app.inject({ method: "GET", url: `${b.clipUri}?x=${encodeURIComponent(tokenForA)}` });
    expect(res.statusCode).toBe(403);
    expect(t.store.getHighlight(b.id)?.exportedAt).toBeUndefined();
    await t.app.close();
  });
});

describe("ADAAAA-7901 S4: an export token is never a session", () => {
  it("401s /auth/me for a Bearer export token minted for the user", async () => {
    const t = await buildTestApp();
    const user = await register(t.app, "sec4@test.dev");
    const token = mintExportToken(t.cfg.exportTokenSecret, "h-sec4", user.id);
    const me = await t.app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(401);

    // A session JWT is not an export token either (used as `x=` -> 403).
    const clip = await seedClip(t, {
      id: "h-sec4",
      jobId: (await t.store.createJob({ ownerId: user.id, source: "file" })).id,
      ownerId: user.id,
      bytes: BYTES,
    });
    const asExport = await t.app.inject({
      method: "GET",
      url: `${clip.clipUri}?x=${encodeURIComponent(user.token)}`,
    });
    expect(asExport.statusCode).toBe(403);
    expect(t.store.getHighlight(clip.id)?.exportedAt).toBeUndefined();
    await t.app.close();
  });

  it("401s a session JWT signed with the documented dev-secret when the server uses a real one", async () => {
    // Production secret on the server; a dev-secret JWT (what the box used to
    // accept as an admin session) must not verify.
    const t = await buildTestApp({ JWT_SECRET: STRONG_SECRET, NODE_ENV: "production" });
    const jwt = await import("jsonwebtoken");
    const forged = jwt.default.sign(
      { sub: "u-admin", email: "admin@highlights.local", role: "admin" },
      "dev-secret",
      { expiresIn: "7d" }
    );
    const me = await t.app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${forged}` } });
    expect(me.statusCode).toBe(401);
    await t.app.close();
  });
});

describe("ADAAAA-7901 S5: the public /feed publishes clips, not account identities", () => {
  it("omits ownerId and exportedBy, while the owner-scoped /highlights keeps ownerId", async () => {
    const t = await buildTestApp();
    const user = await register(t.app, "sec5@test.dev");
    const job = await t.store.createJob({ ownerId: user.id, source: "file" });
    const clip = await seedClip(t, { id: "h-sec5", jobId: job.id, ownerId: user.id, bytes: BYTES });
    await t.store.markHighlightExported(clip.id, "download", user.id);

    const feed = await t.app.inject({ method: "GET", url: "/feed" });
    expect(feed.statusCode).toBe(200);
    const row = feed.json().highlights.find((h: any) => h.id === clip.id);
    expect(row).toBeTruthy();
    expect(row.ownerId).toBeUndefined();
    expect(row.exportedBy).toBeUndefined();
    // The clip is still fully addressable: id + playback URI + score.
    expect(row.clipUri).toBe(clip.clipUri);
    expect(row.score).toBe(90);

    const mine = await t.app.inject({
      method: "GET",
      url: "/highlights",
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(mine.statusCode).toBe(200);
    const own = mine.json().highlights.find((h: any) => h.id === clip.id);
    expect(own.ownerId).toBe(user.id);
    await t.app.close();
  });
});
