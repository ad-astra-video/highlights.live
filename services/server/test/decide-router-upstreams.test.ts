// ADAAAA-8083: the decide router must RE-RESOLVE its upstreams while nginx runs.
//
// `docker/decide-router.conf` fronts the decide workers behind one origin. Since
// ADAAAA-8281 the three 5090 workers on ai-server-5090x3-1 are the PRIMARY
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
// This suite pins the config surface so a future edit cannot drop `resolve`
// (or the `zone` it requires) silently.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const conf = readFileSync(repoFile("docker/decide-router.conf"), "utf8");

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

  it("balances across the three 5090 decide workers as the PRIMARY set", () => {
    // ADAAAA-8281 (L1): the 5090 trio is the primary term — it measured decide
    // p50 2.02 s vs ~3.7 s blended on the x99 pair at the same cell (04:32Z leg,
    // ADAAAA-8258/8259) and is the cheaper/faster GPU term.
    const block = upstreamBlock("decide_pool");
    const servers = block.split("\n").filter((l) => /^\s*server\s+\S+:\d+/.test(l));
    const primary = servers.filter((l) => !/\bbackup\b/.test(l));
    expect(primary.length).toBe(3);
    expect(primary.map((l) => l.trim().split(/\s+/)[1]).sort()).toEqual([
      "192.168.1.151:8091",
      "192.168.1.151:8092",
      "192.168.1.151:8093",
    ]);
    for (const line of primary) {
      // Literal host:port, never `resolve`: the 5090 workers are `docker run`
      // containers on ai-server-5090x3-1 with PUBLISHED ports, which Docker's
      // embedded DNS cannot resolve, and a literal IP cannot go stale.
      expect(line, `5090 primary must not use resolve: ${line.trim()}`).not.toMatch(/\bresolve\b/);
      expect(line).toMatch(/max_fails=\d+/);
    }
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

  it("declares the routed set: capacity == primaries x 2 seq per 5090 worker", () => {
    // ADAAAA-8281 AC2: admission reads the runner registration's capacity, and
    // that number is the routed set — 3 primary workers at `--max-num-seqs 2`
    // each = 6. Pinning the arithmetic here means a pool edit and a capacity
    // edit cannot drift apart silently (funded DECIDE_CONCURRENCY stays 8).
    const block = upstreamBlock("decide_pool");
    const primaries = block
      .split("\n")
      .filter((l) => /^\s*server\s+\S+:\d+/.test(l) && !/\bbackup\b/.test(l));
    for (const rel of ["docker/runners.json", "docker/runners.template.json"]) {
      const runner = readRunners(rel).runners.find((r) => r.label === "highlights-decide") as
        | { capacity: number }
        | undefined;
      expect(runner, `${rel}: highlights-decide runner missing`).toBeTruthy();
      expect(runner!.capacity).toBe(primaries.length * 2);
    }
  });

  it("keeps the router-local liveness endpoint that never proxies", () => {
    expect(conf).toMatch(/location\s+=\s+\/nginx-health/);
  });
});

// ADAAAA-8088: the decide runner's health probe must hit the router-local
// endpoint, not the proxied `/health`. go-livepeer (v0.9.2,
// `ai/runner/live_runner.go`) probes every static runner on a 5 s ticker with a
// 3 s timeout and, on a SINGLE failed probe, sets `Status = "unavailable"` and
// releases every session on that runner. `health_url` is relative to
// `runner_url` (staticRunnerHealthURL joins them), so with `runner_url =
// http://decide-router:8081` a `/health` probe is proxied into the decide pool
// and pays any upstream connect/inference stall. `/nginx-health` answers inside
// nginx (`return 200`), so a worker stall can no longer fail the probe. This
// suite pins both the config value and the non-proxying endpoint.
const readRunners = (rel: string) =>
  JSON.parse(readFileSync(repoFile(rel), "utf8")) as {
    runners: Array<{ label: string; runner_url: string; health_url: string }>;
  };

function decideRunner(rel: string) {
  const runner = readRunners(rel).runners.find((r) => r.label === "highlights-decide");
  expect(runner, `${rel}: highlights-decide runner missing`).toBeTruthy();
  return runner!;
}

describe("decide runner health probe (ADAAAA-8088)", () => {
  for (const rel of ["docker/runners.json", "docker/runners.template.json"]) {
    it(`${rel}: decide health_url is the router-local /nginx-health`, () => {
      const runner = decideRunner(rel);
      expect(runner.runner_url).toBe("http://decide-router:8081");
      expect(runner.health_url).toBe("/nginx-health");
    });
  }

  it("the health endpoint answers inside nginx and never proxies", () => {
    const start = conf.indexOf("location = /nginx-health");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = conf.indexOf("\n    }", start);
    const block = conf.slice(start, end);
    expect(block).toMatch(/return\s+200/);
    expect(block).not.toMatch(/proxy_pass/);
  });
});
