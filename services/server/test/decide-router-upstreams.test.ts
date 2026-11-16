// ADAAAA-8083: the decide router must RE-RESOLVE its upstreams while nginx runs.
//
// `docker/decide-router.conf` fronts the decide workers behind one origin. Since
// ADAAAA-8281 the three 5090 workers on the decide-pool host (name in the box's
// untracked docker/.env, never tracked here) are the PRIMARY
// upstreams and the x99 pair (`decide`, `decide-b`) is `backup`-only failover.
// nginx resolves an upstream `server <name>`
// ONCE, at startup, unless the line carries `resolve`. A decide worker is
// recreated by every deploy of that image, which gives it a NEW bridge IP, so a
// pool without `resolve` keeps dialling the dead address forever: the connect
// waits out ARP and returns `connect() failed (113: Host is unreachable)` after
// ~3 s, the peer is re-enabled after `fail_timeout` (10 s), and the cycle
// repeats — a 3 s stall every 10 s.
//
// That stall is what stranded the decide leg on the box: go-livepeer's
// static-runner health probe has a 3 s timeout, so it intermittently marked the
// decide runner `unavailable` and, in the same pass, released every in-flight
// decide session. The server's decide call then came back `404 runner not found /
// session not found`, and a VOD job died at 68-100 % with `decide runner
// unavailable after 5 attempts` (six of six file jobs on 2026-11-05).
//
// Measured on the box after the fix: 0 `health changed` lines and 0
// `runner not found` 404s in the 12 min following the router restart, versus
// 1878 flap lines / 4332 404s before it.
//
// ADAAAA-8553 S1: this router is now a MANUAL/DEBUG path and the `DECIDE_URL`
// fallback. Decide is registered per CONTAINER (one registrar per worker, ids
// `highlights-decide-5090-1..3` / `-x99` / `-x99-b`), so the registry — not this
// pool — owns readiness, capacity and failover. The assertions here still pin
// the router config because it remains in compose and must not silently rot;
// the per-container registrar payloads and health/unregister behaviour are
// pinned in `live-runner-registrar.test.ts`.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const conf = readFileSync(repoFile("docker/decide-router.conf"), "utf8");
const entrypoint = repoFile("docker/decide-router-entrypoint.sh");
const entrypointText = readFileSync(entrypoint, "utf8");

/** Any private IPv4 literal, in any form (ADAAAA-9101: none may be tracked). */
const PRIVATE_IPV4 = /\b(?:192\.168|10|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/;

/** The body of one `upstream <name> { ... }` block. */
function upstreamBlock(name: string): string {
  const start = conf.indexOf(`upstream ${name} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = conf.indexOf("\n  }", start);
  expect(end).toBeGreaterThan(start);
  return conf.slice(start, end);
}

describe("decide router upstreams (ADAAAA-8083)", () => {
  it("declares Docker's embedded DNS so names can be re-resolved at runtime", () => {
    expect(conf).toMatch(/resolver\s+127\.0\.0\.11\b/);
    // A stale IP must not be dialled for long after a worker is recreated.
    expect(conf).toMatch(/resolver\s+127\.0\.0\.11[^\n]*valid=\d+s/);
  });

  it("gives decide_pool the shared zone `resolve` requires", () => {
    const block = upstreamBlock("decide_pool");
    expect(block).toMatch(/zone\s+decide_pool\s+\d+k/);
  });

  it("takes the three 5090 worker upstreams from env, never from the tracked conf", () => {
    // ADAAAA-8281 (L1): the 5090 trio is the PRIMARY term — it measured decide
    // p50 2.02 s vs ~3.7 s blended on the x99 pair at the same cell (04:32Z leg,
    // ADAAAA-8258/8259) and is the cheaper/faster GPU term.
    //
    // ADAAAA-9101: the repository is public, so the conf cannot name the worker
    // host. The PRIMARY set is rendered at container start by
    // docker/decide-router-entrypoint.sh from DECIDE_WORKER_HOST (+
    // DECIDE_WORKER_PORTS) into the file this block includes.
    const block = upstreamBlock("decide_pool");
    expect(block).toMatch(/include\s+\/tmp\/decide-workers\.conf;/);
    expect(conf).not.toMatch(PRIVATE_IPV4);
    // The x99 fallbacks stay compose service names, which resolve on the network.
  });

  it("renders one literal upstream per DECIDE_WORKER_PORT without logging the address", () => {
    const bin = mkdtempSync(join(tmpdir(), "decide-router-bin-"));
    const nginx = join(bin, "nginx");
    writeFileSync(nginx, "#!/bin/sh\nexit 0\n");
    chmodSync(nginx, 0o755);
    const run = spawnSync("sh", [entrypoint], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        DECIDE_WORKER_HOST: "worker.example",
        DECIDE_WORKER_PORTS: "8091,8092",
      },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).not.toContain("worker.example");
    expect(readFileSync("/tmp/decide-workers.conf", "utf8").trimEnd().split("\n")).toEqual([
      "    server worker.example:8091 max_fails=2 fail_timeout=10s;",
      "    server worker.example:8092 max_fails=2 fail_timeout=10s;",
    ]);
  });

  it("validates the rendered config with `nginx -t` before it serves", () => {
    // ADAAAA-9102 ruling: the entrypoint must FAIL CLOSED. Rendering an empty or
    // broken upstream set and starting anyway would silently drop every decide
    // worker, so the config is validated first and a failure aborts the boot.
    const order = ["nginx -t", "exec nginx"];
    const positions = order.map((needle) => entrypointText.indexOf(needle));
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    expect(positions[1]).toBeGreaterThan(positions[0]);
    expect(entrypointText).toMatch(/refusing to start/);
  });

  it("exits non-zero when `nginx -t` rejects the rendered config", () => {
    const bin = mkdtempSync(join(tmpdir(), "decide-router-bin-"));
    const nginx = join(bin, "nginx");
    // `-t` fails, the serving invocation would succeed: only the check saves us.
    writeFileSync(nginx, '#!/bin/sh\n[ "$1" = "-t" ] && exit 1\nexit 0\n');
    chmodSync(nginx, 0o755);
    const run = spawnSync("sh", [entrypoint], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        DECIDE_WORKER_HOST: "worker.example",
        DECIDE_WORKER_PORTS: "8091,8092,8093",
      },
      encoding: "utf8",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("refusing to start");
  });

  it("is an explicit boot error when DECIDE_WORKER_HOST is unset", () => {
    const run = spawnSync("sh", [entrypoint], {
      env: { ...process.env, DECIDE_WORKER_HOST: "" },
      encoding: "utf8",
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("DECIDE_WORKER_HOST is unset");
  });

  it("keeps the x99 pair as `backup`, re-resolved, so failover survives", () => {
    // `backup` takes the x99 pair out of the balancing set while ANY 5090 primary
    // is healthy; nginx moves traffic to it only when every primary is marked
    // down by max_fails inside fail_timeout. Losing all three 5090s therefore
    // degrades to the pre-8281 x99 behaviour instead of failing decides.
    const block = upstreamBlock("decide_pool");
    const backups = block.split("\n").filter((l) => /^\s*server\s+/.test(l) && /\bbackup\b/.test(l));
    expect(backups.length).toBe(2);
    for (const line of backups) {
      expect(line).toMatch(/server\s+(decide|decide-b):8081/);
      expect(line, `x99 backup must keep resolve: ${line.trim()}`).toMatch(/\bresolve\b/);
    }
  });

  it("keeps the router-local liveness endpoint that never proxies", () => {
    expect(conf).toMatch(/location\s+=\s+\/nginx-health/);
  });
});
