import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Webapp build retention for the SPA static handler (ADAAAA-7917).
 *
 * Why: every deploy rebuilds `webapp/dist` inside the server image, so a
 * container recreate leaves only the NEW build's content-hashed assets. A tab
 * that loaded `index.html` before a deploy then asks for `/assets/index-<old>.js`
 * and gets ... the SPA fallback document (200 `text/html`), which fails the
 * module load and renders a dead page until the user reloads.
 *
 * Fix shape, repo-only (no deploy-time step, no extra mount):
 *   - at boot, snapshot the current `dist` into `${DATA_DIR}/webapp-assets/<buildKey>/`
 *     (DATA_DIR is the bind-mounted `./data` volume, so snapshots survive a
 *     container recreate);
 *   - keep the N newest snapshots (`WEBAPP_ASSET_RETENTION`, default 5);
 *   - the SPA handler serves an `assets/` request from the newest snapshot that
 *     still has it, and answers a missing `.js`/`.mjs`/`.css`-style path with a
 *     real 404 instead of the fallback document. A failed module load is then
 *     observable in devtools/curl instead of a silent blank page.
 */

/** Default snapshot count kept across deploys. */
export const WEBAPP_ASSET_RETENTION_DEFAULT = 5;

/**
 * Extensions that mark a request as a static asset rather than a client-side
 * route. A miss on one of these must never answer `index.html` (that is exactly
 * the failure AC2 of ADAAAA-7917 names): `.js`/`.mjs`/`.css` break the module or
 * stylesheet load, and the other types would parse as HTML garbage. Client
 * routes are extensionless, so history fallback is untouched.
 */
const STATIC_ASSET_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".map",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
]);

/** True when the URL path looks like a built static asset (never the SPA document). */
export function isStaticAssetPath(urlPath: string): boolean {
  let decoded = urlPath;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    /* keep the raw path */
  }
  const clean = (decoded.split("?")[0] ?? "").split("#")[0] ?? "";
  const ext = path.posix.extname(clean).toLowerCase();
  return STATIC_ASSET_EXTENSIONS.has(ext);
}

/** The manifest written next to each snapshot: what was archived and when. */
export interface WebappBuildManifest {
  buildKey: string;
  archivedAt: string;
  files: number;
}

export interface WebappAssetArchiveReport {
  distDir: string;
  archiveDir: string;
  buildKey: string | null;
  copiedFiles: number;
  retainedBuilds: string[];
  prunedBuilds: string[];
  skippedReason?: string;
}

function snapshotDirs(archiveDir: string): string[] {
  if (!existsSync(archiveDir)) return [];
  return readdirSync(archiveDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Snapshot dirs sorted newest first (directory mtime, refreshed on re-archive). */
function snapshotDirsNewestFirst(archiveDir: string): string[] {
  return snapshotDirs(archiveDir)
    .map((name) => {
      try {
        return { name, mtime: statSync(path.join(archiveDir, name)).mtimeMs };
      } catch {
        return { name, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
    .map((e) => e.name);
}

function countFiles(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n += 1;
  }
  return n;
}

/**
 * Archive the current build into `archiveDir` and prune to `retain` snapshots.
 * Synchronous and bounded (the build is a few hundred KB): it runs once at boot
 * before the listener starts, so the newest snapshot is in place before any
 * deploy-fresh request can arrive. Never throws for a missing dist — SPA
 * serving is optional (API-only mode).
 */
export function archiveWebappBuild(
  distDir: string,
  archiveDir: string,
  retain: number = WEBAPP_ASSET_RETENTION_DEFAULT
): WebappAssetArchiveReport {
  const report: WebappAssetArchiveReport = {
    distDir,
    archiveDir,
    buildKey: null,
    copiedFiles: 0,
    retainedBuilds: [],
    prunedBuilds: [],
  };
  const indexPath = path.join(distDir, "index.html");
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    report.skippedReason = "no-webapp-dist";
    return report;
  }
  if (!Number.isFinite(retain) || retain <= 0) {
    report.skippedReason = "retention-disabled";
    return report;
  }
  const buildKey = createHash("sha1").update(readFileSync(indexPath)).digest("hex").slice(0, 12);
  report.buildKey = buildKey;
  // A directory whose name is not a build key (a hand-made fixture, a stray
  // file) is never a snapshot target.
  if (!/^[0-9a-f]{12}$/.test(buildKey)) return report;

  const target = path.join(archiveDir, buildKey);
  const alreadyArchived = existsSync(target);
  if (!alreadyArchived) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(distDir)) {
      cpSync(path.join(distDir, entry), path.join(target, entry), { recursive: true });
    }
    const manifest: WebappBuildManifest = {
      buildKey,
      archivedAt: new Date().toISOString(),
      files: countFiles(target),
    };
    writeFileSync(path.join(target, "build.json"), JSON.stringify(manifest, null, 2) + "\n");
    report.copiedFiles = manifest.files;
  } else {
    report.copiedFiles = 0;
  }

  // Refresh recency even when the build was already archived (a re-deploy of the
  // same content hash is the newest deploy, so it must not be pruned first).
  const now = new Date();
  try {
    utimesSync(target, now, now);
  } catch {
    /* best effort */
  }

  const ordered = snapshotDirsNewestFirst(archiveDir);
  report.retainedBuilds = ordered.slice(0, Math.max(1, Math.floor(retain)));
  for (const stale of ordered.slice(Math.max(1, Math.floor(retain)))) {
    try {
      rmSync(path.join(archiveDir, stale), { recursive: true, force: true });
      report.prunedBuilds.push(stale);
    } catch {
      /* keep the snapshot if the prune fails; retention is best-effort */
    }
  }
  return report;
}

/**
 * Resolve a request path against the retained snapshots, newest first.
 *
 * Only `assets/` requests are looked up: that is where Vite puts every
 * content-hashed module/stylesheet a stale tab can ask for. Root files
 * (`index.html`, `bolt.svg`, …) keep their names across builds and are read from
 * the live dist, so they never need the archive. `..` segments are rejected so a
 * crafted path cannot escape a snapshot directory.
 */
export function resolveRetainedAsset(archiveDir: string, relPath: string): string | null {
  if (!archiveDir || !existsSync(archiveDir)) return null;
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel.startsWith("assets/")) return null;
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === "..")) return null;
  for (const build of snapshotDirsNewestFirst(archiveDir)) {
    const candidate = path.join(archiveDir, build, ...parts);
    try {
      if (lstatSync(candidate).isFile()) return candidate;
    } catch {
      /* not in this snapshot */
    }
  }
  return null;
}
