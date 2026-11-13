// ADAAAA-8881: the pathway map (docs/highlight-pathways.md) must not drift from
// the code it maps. The check itself lives in a standalone script so it runs
// without a build (`pnpm check:pathways`); this test makes the normal
// `pnpm test` path enforce it too.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("highlight identification pathway map", () => {
  it("stays consistent with the code it cites", () => {
    let out: string;
    try {
      out = execFileSync(process.execPath, [path.join(ROOT, "scripts/check-highlight-pathways.mjs")], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      // Surface the checker's own stale list, not a bare exit code.
      throw new Error(String(err?.stderr || err?.message || err));
    }
    expect(out).toContain("ok:");
  });
});
