import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";

/**
 * ADAAAA-9312: the SPA serve path must state its cache policy on every
 * response. Cloudflare caches an origin response that carries no `cache-control`
 * for its default 4 h edge TTL, so the ADAAAA-7917 asset-404 stayed invisible
 * behind the pre-fix `200 text/html` fallback entry that a previous deploy had
 * written. These assertions are the RED test for that defect: at
 * `origin/master` `15e7f751` none of the `cache-control` expectations below
 * hold (the handler sets no cache header at all).
 */

const roots: string[] = [];

function tempRoot(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `hl-9312-${tag}-`));
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
  // A root-level static file with a stable name (not content-hashed).
  writeFileSync(path.join(dist, "bolt.svg"), `<svg xmlns="http://www.w3.org/2000/svg"></svg>\n`);
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("ADAAAA-9312 SPA serve path cache policy", () => {
  it("marks the asset-404 and the API-404 no-store so no edge can pin them", async () => {
    const dist = tempRoot("dist");
    const archive = tempRoot("archive");
    writeBuild(dist, "OLDHASH1");
    const { app } = await buildTestApp({
      WEBAPP_DIST: dist,
      WEBAPP_ASSET_ARCHIVE_DIR: archive,
      WEBAPP_ASSET_RETENTION: "5",
    });

    // AC1: an asset path the image no longer ships and did not retain.
    const gone = await app.inject({ method: "GET", url: "/assets/index-GONE000.js" });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ error: "asset not found" });
    expect(gone.headers["cache-control"]).toBe("no-store");
    // Cloudflare honours CDN-Cache-Control over Cache-Control at the edge.
    expect(gone.headers["cdn-cache-control"]).toBe("no-store");

    // Same class of bug for an unmatched API route: an edge-cached 404 would
    // hide a route that a later deploy adds.
    const api404 = await app.inject({ method: "GET", url: "/api/no-such-route" });
    expect(api404.statusCode).toBe(404);
    expect(api404.headers["cache-control"]).toBe("no-store");
    expect(api404.headers["cdn-cache-control"]).toBe("no-store");
  });

  it("keeps the document revalidating and pins content-hashed assets", async () => {
    const dist = tempRoot("serve-dist");
    const archive = tempRoot("serve-archive");
    writeBuild(dist, "OLDHASH1");
    writeFileSync(path.join(dist, "assets", "logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg"></svg>\n`);
    const { app } = await buildTestApp({
      WEBAPP_DIST: dist,
      WEBAPP_ASSET_ARCHIVE_DIR: archive,
      WEBAPP_ASSET_RETENTION: "5",
    });

    // Simulate a deploy: the image now carries ONLY the new build.
    rmSync(path.join(dist, "assets"), { recursive: true, force: true });
    writeBuild(dist, "NEWHASH2");

    // The current build's hashed module: the URL pins the bytes.
    const fresh = await app.inject({ method: "GET", url: "/assets/index-NEWHASH2.js" });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    // A stale tab's module, served from the retained snapshot: same policy.
    const retained = await app.inject({ method: "GET", url: "/assets/index-OLDHASH1.js" });
    expect(retained.statusCode).toBe(200);
    expect(retained.body).toContain("OLDHASH1");
    expect(retained.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    // The document itself (root and history fallback) must revalidate, or the
    // edge keeps handing out an index.html whose asset hashes are gone.
    for (const url of ["/", "/index.html", "/privacy"]) {
      const doc = await app.inject({ method: "GET", url });
      expect(doc.statusCode).toBe(200);
      expect(doc.headers["content-type"]).toContain("text/html");
      expect(doc.headers["cache-control"]).toBe("no-cache");
    }

    // A stable-named root file is not content-addressed: revalidate, never
    // immutable.
    const rootFile = await app.inject({ method: "GET", url: "/bolt.svg" });
    expect(rootFile.statusCode).toBe(200);
    expect(rootFile.headers["cache-control"]).toBe("no-cache");

    // Same for an unhashed file that happens to live under assets/. Pinning it
    // for a year would strand a renamed logo on the edge.
    const plainAsset = await app.inject({ method: "GET", url: "/assets/logo.svg" });
    expect(plainAsset.statusCode).toBe(200);
    expect(plainAsset.headers["cache-control"]).toBe("no-cache");
  });
});
