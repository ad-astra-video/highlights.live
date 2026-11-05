import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { servedSourceDir, sourceDigest } from "../src/source-digest";

// ADAAAA-8048: `/health` must be able to prove the served media revision from
// the running container alone. `buildRef` only exists when the recreate went
// through `docker/deploy.sh`; the source digest is derived from the bytes the
// container serves, so it survives an unstamped boot.
//
// The two properties that make it usable as proof:
//   1. STABLE across a rebuild (same source => same digest: no timestamps, no
//      absolute paths, no directory-listing order),
//   2. CHANGES when a served file changes.

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), "hl-source-digest-"));

const copyTree = (from: string, to: string): void => {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else copyFileSync(src, dst);
  }
};

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("media served-source digest (ADAAAA-8048)", () => {
  it("hashes the served tree as relPath \\0 content \\0 in sorted order (format pin)", () => {
    const dir = tmpDir();
    cleanup.push(dir);
    mkdirSync(path.join(dir, "nested"), { recursive: true });
    // Written out of order on purpose: the digest must not depend on the
    // platform's directory-listing order.
    writeFileSync(path.join(dir, "z-last.ts"), "export const z = 1;\n");
    writeFileSync(path.join(dir, "a-first.ts"), "export const a = 1;\n");
    writeFileSync(path.join(dir, "nested", "m.ts"), "export const m = 1;\n");
    writeFileSync(path.join(dir, "ignored.md"), "not served\n");

    const got = sourceDigest(dir);
    expect(got.files).toBe(3); // only .ts sources are served

    // Recipe documented in docs/plan/10-media-node-observability.md, computed
    // here independently of the implementation.
    const h = createHash("sha256");
    for (const rel of ["a-first.ts", "nested/m.ts", "z-last.ts"]) {
      h.update(rel, "utf8");
      h.update("\0");
      h.update(readFileSync(path.join(dir, rel)));
      h.update("\0");
    }
    expect(got.digest).toBe(`sha256:${h.digest("hex")}`);
  });

  it("is stable across a rebuild: the same bytes at another absolute path hash the same", () => {
    const first = tmpDir();
    const rebuilt = tmpDir();
    cleanup.push(first, rebuilt);
    writeFileSync(path.join(first, "server.ts"), "export const served = 1;\n");
    mkdirSync(path.join(first, "sub"), { recursive: true });
    writeFileSync(path.join(first, "sub", "relay.ts"), "export const relay = 2;\n");

    // A recreate copies the same source into a fresh image context dir.
    copyTree(first, rebuilt);

    expect(sourceDigest(rebuilt).digest).toBe(sourceDigest(first).digest);
    // and the real served tree is deterministic run to run
    expect(sourceDigest().digest).toBe(sourceDigest().digest);
  });

  it("changes when a served file changes", () => {
    const dir = tmpDir();
    cleanup.push(dir);
    writeFileSync(path.join(dir, "server.ts"), "export const served = 1;\n");
    const before = sourceDigest(dir);
    writeFileSync(path.join(dir, "server.ts"), "export const served = 2;\n");
    const after = sourceDigest(dir);
    expect(before.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(after.digest).not.toBe(before.digest);
    expect(after.files).toBe(before.files);
  });

  it("changes when a served file is added", () => {
    const dir = tmpDir();
    cleanup.push(dir);
    writeFileSync(path.join(dir, "server.ts"), "export const served = 1;\n");
    const before = sourceDigest(dir).digest;
    writeFileSync(path.join(dir, "relay.ts"), "export const relay = 1;\n");
    const added = sourceDigest(dir);
    expect(added.digest).not.toBe(before);
    expect(added.files).toBe(2);
  });

  it("reports null (never throws) when the tree cannot be read", () => {
    expect(sourceDigest(path.join(os.tmpdir(), "hl-source-digest-missing-dir"))).toEqual({
      digest: null,
      files: 0,
    });
  });

  it("digests the real media source tree", () => {
    const got = sourceDigest();
    expect(got.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The served tree is flat today; the count is the cheap sanity check a QA
    // read repeats against the container (`sourceFiles`).
    const flat = readdirSync(servedSourceDir()).filter((f) => f.endsWith(".ts"));
    expect(got.files).toBe(flat.length);
    expect(got.files).toBeGreaterThanOrEqual(10);
  });
});
