// Media served-source digest (ADAAAA-8048).
//
// `/health` already publishes the image revision as `restarts.buildRef`, but that
// stamp only exists when the recreate went through `docker/deploy.sh` — the only
// path that exports `BUILD_REF=$(git rev-parse --short HEAD)`. A bare
// `docker compose up -d` falls back to the Dockerfile's `ARG BUILD_REF=unknown`
// default, and then the served-revision proof a QA run needs (ADAAAA-8007) is
// impossible without box shell access; QA had to substitute a hand-computed md5
// of two files.
//
// This digest is derived from the bytes the container ACTUALLY serves: sha256
// over every `services/media/src/**/*.ts`, folded in sorted relative-path order
// as `relPath \0 content \0`. It is therefore a property of the source, not of
// the deploy path:
//
//   - a rebuild from unchanged source reproduces the same digest (no timestamp,
//     no absolute path, no directory-listing order in the hash),
//   - editing any served file changes it.
//
// The tree is located from this module's own directory, not the process cwd, so
// the digest is identical whether the service runs from `/app` in the image or
// from a worktree locally.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SourceDigest = {
  /** `sha256:<hex>` over the served tree; null when it could not be read */
  digest: string | null;
  /** how many `.ts` files were folded into the digest */
  files: number;
};

/** Only TypeScript sources are served; the image runs them through tsx. */
const SOURCE_EXT = ".ts";

/** Absolute path of the served source tree (the directory holding this module). */
export function servedSourceDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Every served `.ts` file under `dir`, as `{ rel, file }` (rel is posix-style). */
function collect(dir: string, rel = ""): { rel: string; file: string }[] {
  const out: { rel: string; file: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collect(abs, relPath));
    } else if (entry.isFile() && entry.name.endsWith(SOURCE_EXT)) {
      out.push({ rel: relPath, file: abs });
    }
  }
  return out;
}

/**
 * sha256 of the served media source. Deterministic for a given set of file
 * contents: files are ordered by their relative path (string compare, so the
 * order is independent of the platform's directory listing), and each
 * contributes its relative path plus its bytes, NUL-terminated so no two
 * different file splits can produce the same byte stream.
 *
 * Diagnostics only — a read failure returns `{ digest: null, files: 0 }` rather
 * than throwing into the boot path.
 */
export function sourceDigest(dir: string = servedSourceDir()): SourceDigest {
  try {
    const files = collect(dir).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    if (!files.length) return { digest: null, files: 0 };
    const hash = createHash("sha256");
    for (const f of files) {
      hash.update(f.rel, "utf8");
      hash.update("\0");
      hash.update(readFileSync(f.file));
      hash.update("\0");
    }
    return { digest: `sha256:${hash.digest("hex")}`, files: files.length };
  } catch {
    return { digest: null, files: 0 };
  }
}
