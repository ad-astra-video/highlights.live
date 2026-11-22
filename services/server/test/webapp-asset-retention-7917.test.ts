import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  WEBAPP_ASSET_RETENTION_DEFAULT,
  archiveWebappBuild,
  isStaticAssetPath,
  resolveRetainedAsset,
} from "../src/webapp-asset-retention";
import { buildTestApp } from "./helpers";

const roots: string[] = [];

function tempRoot(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `hl-7917-${tag}-`));
  roots.push(dir);
  return dir;
}

/** Write a Vite-shaped build: index.html + content-hashed module and stylesheet. */
function writeBuild(dist: string, hash: string): void {
  mkdirSync(path.join(dist, "assets"), { recursive: true });
  writeFileSync(
    path.join(dist, "index.html"),
    `<!doctype html><html><body><div id="root"></div>` +
      `<script type="module" src="/assets/index-${hash}.js"></script>` +
      `<link rel="stylesheet" href="/assets/index-${hash}.css"></body></html>`
  );
  writeFileSync(path.join(dist, "assets", `index-${hash}.js`), `console.log(${JSON.stringify(hash)});\n`);
  writeFileSync(path.join(dist, "assets", `index-${hash}.css`), `/* ${hash} */body{color:#111}\n`);
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("ADAAAA-7917 config knob", () => {
  it("reads WEBAPP_ASSET_RETENTION (default 5) and derives the archive dir from DATA_DIR", async () => {
    const { testCfg } = await import("./helpers");
    const dflt = testCfg();
    expect(dflt.webappAssetRetention).toBe(5);
    expect(dflt.webappAssetArchiveDir).toBe(path.join(dflt.dataDir, "webapp-assets"));
    expect(testCfg({ WEBAPP_ASSET_RETENTION: "3" }).webappAssetRetention).toBe(3);
    expect(testCfg({ WEBAPP_ASSET_RETENTION: "0" }).webappAssetRetention).toBe(0);
    expect(testCfg({ WEBAPP_ASSET_RETENTION: "nonsense" }).webappAssetRetention).toBe(5);
    expect(testCfg({ WEBAPP_ASSET_ARCHIVE_DIR: "/var/lib/hl-assets" }).webappAssetArchiveDir).toBe(
      "/var/lib/hl-assets"
    );
  });
});

describe("ADAAAA-7917 static asset classification", () => {
  it("treats module/stylesheet/image/font/sourcemap paths as assets, not SPA routes", () => {
    expect(isStaticAssetPath("/assets/index-CNBH-rmM.js")).toBe(true);
    expect(isStaticAssetPath("/assets/chunk.mjs")).toBe(true);
    expect(isStaticAssetPath("/assets/index-abc.css")).toBe(true);
    expect(isStaticAssetPath("/assets/x.js?v=2")).toBe(true);
    expect(isStaticAssetPath("/assets/index-ABC.JS")).toBe(true);
    expect(isStaticAssetPath("/bolt.woff2")).toBe(true);
    expect(isStaticAssetPath("/assets/x.js.map")).toBe(true);
    // Client-side routes (extensionless) and the document itself still fall back.
    expect(isStaticAssetPath("/privacy")).toBe(false);
    expect(isStaticAssetPath("/")).toBe(false);
    expect(isStaticAssetPath("/auth/reset")).toBe(false);
    expect(isStaticAssetPath("/index.html")).toBe(false);
  });
});

describe("ADAAAA-7917 build snapshots", () => {
  it("archives a build once, and re-archiving the same build does not duplicate it", () => {
    const dist = tempRoot("dist");
    const archive = tempRoot("archive");
    writeBuild(dist, "AAAA1111");

    const first = archiveWebappBuild(dist, archive, 5);
    expect(first.buildKey).toMatch(/^[0-9a-f]{12}$/);
    expect(first.copiedFiles).toBeGreaterThan(0);
    expect(existsSync(path.join(archive, first.buildKey!, "assets", "index-AAAA1111.js"))).toBe(true);
    expect(existsSync(path.join(archive, first.buildKey!, "build.json"))).toBe(true);

    const second = archiveWebappBuild(dist, archive, 5);
    expect(second.buildKey).toBe(first.buildKey);
    expect(second.copiedFiles).toBe(0);
    expect(readdirSync(archive)).toHaveLength(1);
  });

  it("keeps the N newest builds and prunes the older ones (default window is 5)", () => {
    const archive = tempRoot("prune");
    expect(WEBAPP_ASSET_RETENTION_DEFAULT).toBe(5);
    for (let i = 0; i < 7; i++) {
      const dist = tempRoot(`b${i}`);
      writeBuild(dist, `BBBB000${i}`);
      archiveWebappBuild(dist, archive, WEBAPP_ASSET_RETENTION_DEFAULT);
    }
    expect(readdirSync(archive)).toHaveLength(5);
    // The two oldest builds are gone; the newest five resolve.
    expect(resolveRetainedAsset(archive, "assets/index-BBBB0000.js")).toBeNull();
    expect(resolveRetainedAsset(archive, "assets/index-BBBB0001.js")).toBeNull();
    for (let i = 2; i < 7; i++) {
      const hit = resolveRetainedAsset(archive, `assets/index-BBBB000${i}.js`);
      expect(hit).toBeTruthy();
      expect(hit!.endsWith(`assets/index-BBBB000${i}.js`)).toBe(true);
    }
  });

  it("skips archiving when retention is disabled", () => {
    const dist = tempRoot("dist-off");
    const archive = tempRoot("archive-off");
    writeBuild(dist, "CCCC1234");
    const report = archiveWebappBuild(dist, archive, 0);
    expect(report.skippedReason).toBe("retention-disabled");
    expect(existsSync(archive) ? readdirSync(archive) : []).toHaveLength(0);
  });

  it("refuses traversal out of a snapshot and only looks inside assets/", () => {
    const dist = tempRoot("dist-trav");
    const archive = tempRoot("archive-trav");
    writeBuild(dist, "DDDD9999");
    archiveWebappBuild(dist, archive, 5);
    expect(resolveRetainedAsset(archive, "assets/../../etc/passwd")).toBeNull();
    expect(resolveRetainedAsset(archive, "index.html")).toBeNull();
    expect(resolveRetainedAsset(archive, "assets/../build.json")).toBeNull();
  });
});

describe("ADAAAA-7917 SPA serve path over HTTP", () => {
  it("serves an older build's assets after a deploy and 404s (never text/html) for an unretained asset", async () => {
    const dist = tempRoot("serve-dist");
    const archive = tempRoot("serve-archive");
    writeBuild(dist, "OLDHASH1");

    const { app } = await buildTestApp({
      WEBAPP_DIST: dist,
      WEBAPP_ASSET_ARCHIVE_DIR: archive,
      WEBAPP_ASSET_RETENTION: "5",
    });

    // This boot archived the OLD build.
    expect(readdirSync(archive)).toHaveLength(1);

    // Current build serves from the live dist.
    const current = await app.inject({ method: "GET", url: "/assets/index-OLDHASH1.js" });
    expect(current.statusCode).toBe(200);
    expect(current.headers["content-type"]).toContain("text/javascript");
    expect(current.body).toContain("OLDHASH1");

    // Simulate a deploy: the image now carries ONLY the new build.
    rmSync(path.join(dist, "assets"), { recursive: true, force: true });
    writeBuild(dist, "NEWHASH2");

    // A stale tab asks for the previous build's module -> real JS, not HTML.
    const stale = await app.inject({ method: "GET", url: "/assets/index-OLDHASH1.js" });
    expect(stale.statusCode).toBe(200);
    expect(stale.headers["content-type"]).toContain("text/javascript");
    expect(stale.body).toContain("OLDHASH1");
    expect(stale.body).not.toContain("<div id=\"root\">");

    // Same for the stylesheet.
    const staleCss = await app.inject({ method: "GET", url: "/assets/index-OLDHASH1.css" });
    expect(staleCss.statusCode).toBe(200);
    expect(staleCss.headers["content-type"]).toContain("text/css");

    // AC2: an asset path that is NOT retained never answers the SPA document.
    const gone = await app.inject({ method: "GET", url: "/assets/index-GONE000.js" });
    expect(gone.statusCode).toBe(404);
    expect(gone.headers["content-type"] ?? "").not.toContain("text/html");
    expect(gone.json()).toMatchObject({ error: "asset not found" });

    // The new build serves normally, and SPA history fallback is unchanged.
    const fresh = await app.inject({ method: "GET", url: "/assets/index-NEWHASH2.js" });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.headers["content-type"]).toContain("text/javascript");
    expect(fresh.body).toContain("NEWHASH2");

    const deep = await app.inject({ method: "GET", url: "/privacy" });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers["content-type"]).toContain("text/html");
    expect(deep.body).toContain("NEWHASH2");

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("NEWHASH2");
  });

  it("keeps the old 200-fallback behaviour only for extensionless client routes", async () => {
    const dist = tempRoot("fallback-dist");
    const archive = tempRoot("fallback-archive");
    writeBuild(dist, "FALLBACK");
    const { app } = await buildTestApp({
      WEBAPP_DIST: dist,
      WEBAPP_ASSET_ARCHIVE_DIR: archive,
      WEBAPP_ASSET_RETENTION: "5",
    });
    const deep = await app.inject({ method: "GET", url: "/some/spa/route" });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers["content-type"]).toContain("text/html");
    // ...but a missing stylesheet does not.
    const css = await app.inject({ method: "GET", url: "/some/spa/style.css" });
    expect(css.statusCode).toBe(404);
  });
});
