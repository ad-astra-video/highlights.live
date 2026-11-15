// ADAAAA-9101 / ADAAAA-9102 ruling: the deploy config is env-first AND
// fail-closed.
//
// The repository is public, so the compose files cannot carry a real public
// origin, a LAN address or an operator home path. Moving the values to env is
// only half the change: a `:-` fallback would recreate the stack with an EMPTY
// public origin (or a tracked host) when the key is missing, which is worse than
// a hard stop. Every moved value therefore uses `${VAR:?<what is missing>}`, so
// `docker compose config` aborts with a readable message instead of silently
// shipping a broken or published endpoint.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");
const gpuOverlay = readFileSync(repoFile("docker/docker-compose.gpu.yml"), "utf8");
const envExample = readFileSync(repoFile(".env.example"), "utf8");

/** Values that used to be real endpoints / host paths in tracked compose. */
const MOVED = [
  "PUBLIC_BASE_URL",
  "MEDIA_PUBLIC_BASE_URL",
  "HF_CACHE_DIR",
  "RUNS_DIR",
  "DECIDE_WORKER_HOST",
];

describe("deploy config is env-first and fail-closed (ADAAAA-9101)", () => {
  it("requires every moved value instead of defaulting it", () => {
    for (const source of [compose, gpuOverlay]) {
      for (const key of MOVED) {
        // No `:-` default (empty or literal) may survive for a moved value.
        expect(source, `${key} must not have a tracked fallback`).not.toMatch(
          new RegExp(`\\$\\{${key}:-`),
        );
      }
    }
    // The four values the stack cannot run without abort the recreate by name.
    for (const [source, key] of [
      [compose, "PUBLIC_BASE_URL"],
      [compose, "MEDIA_PUBLIC_BASE_URL"],
      [compose, "HF_CACHE_DIR"],
      [compose, "RUNS_DIR"],
      [compose, "DECIDE_WORKER_HOST"],
      [gpuOverlay, "HF_CACHE_DIR"],
      [gpuOverlay, "RUNS_DIR"],
    ] as const) {
      expect(source, `${key} must be fail-closed`).toMatch(
        new RegExp(`\\$\\{${key}:\\?[^}]*${key}`),
      );
    }
  });

  it("keeps the fail-closed message actionable (it names the key and docker/.env)", () => {
    const matches = compose.match(/\$\{[A-Z_]+:\?[^}]*\}/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
    for (const match of matches) {
      expect(match).toMatch(/is required/);
      expect(match).toMatch(/docker\/\.env/);
    }
  });

  it("hands the router its worker address fail-closed and renders it from env", () => {
    // Compose: required substitution; the entrypoint also refuses to boot.
    expect(compose).toMatch(/DECIDE_WORKER_HOST=\$\{DECIDE_WORKER_HOST:\?[^}]*\}/);
    expect(compose).toContain("command: [\"/bin/sh\", \"/opt/decide-router-entrypoint.sh\"]");
  });

  it(".env.example is a template that satisfies the required keys", () => {
    // Documented as a template with placeholder values, one line per key.
    for (const key of MOVED) {
      expect(envExample, `.env.example must document ${key}`).toMatch(new RegExp(`^${key}=.+$`, "m"));
    }
    // A placeholder must be a documentation host, never an empty value: `:?`
    // treats empty as missing, so an empty template would fail a fresh copy.
    expect(envExample).toMatch(/^DECIDE_WORKER_HOST=(?!$).+$/m);
    expect(envExample).toMatch(/^PUBLIC_BASE_URL=https:\/\/app\.example\.com$/m);
    expect(envExample).toMatch(/^MEDIA_PUBLIC_BASE_URL=https:\/\/media\.example\.com$/m);
  });
});
