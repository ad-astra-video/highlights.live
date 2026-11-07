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
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const conf = readFileSync(repoFile("docker/decide-router.conf"), "utf8");
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");

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
    // each = 6. Since the dynamic-registration follow-up there is no
    // runners.json to keep in step: the registrar DERIVES the number from this
    // same pool (`RUNNER_CAPACITY=auto`), so a pool edit cannot drift from the
    // advertised ceiling. Pinning the arithmetic here fails the suite if the
    // parser ever counts a `backup` line (the x99 pair is failover only).
    const block = upstreamBlock("decide_pool");
    const primaries = block
      .split("\n")
      .filter((l) => /^\s*server\s+\S+:\d+/.test(l) && !/\bbackup\b/.test(l));
    expect(primaries.length).toBe(3);
    expect(registrarCapacity()).toBe(primaries.length * 2);
  });

  it("keeps the router-local liveness endpoint that never proxies", () => {
    expect(conf).toMatch(/location\s+=\s+\/nginx-health/);
  });
});

// ADAAAA-8088: the decide runner's health probe must hit the router-local
// endpoint, not the proxied `/health`. go-livepeer (v0.9.2,
// `ai/runner/live_runner.go`) probes every STATIC runner on a 5 s ticker with a
// 3 s timeout and, on a SINGLE failed probe, sets `Status = "unavailable"` and
// releases every session on that runner. `health_url` is relative to
// `runner_url` (staticRunnerHealthURL joins them), so with `runner_url =
// http://decide-router:8081` a `/health` probe is proxied into the decide pool
// and pays any upstream connect/inference stall. `/nginx-health` answers inside
// nginx (`return 200`), so a worker stall can no longer fail the probe.
//
// ADAAAA-8281 follow-up: the registration is no longer a JSON file — the
// `registrar-decide` sidecar heartbeats the runner's own description. These
// tests run the sidecar's parser (`--print-payload` / `--print-capacity`, no
// network) so the config asserted here is byte-for-byte what the box sends to
// `POST /runners/heartbeat`, and they require python3 (present on the dev box
// and on the deploy host; see docker/live-runner-registrar.py).
const registrar = repoFile("docker/live-runner-registrar.py");

function registrarEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

/** Resolve the decide registration exactly as the compose sidecar does. */
function decideRegistrarPayload(): Record<string, any> {
  const out = execFileSync(
    "python3",
    [registrar, "--print-payload"],
    {
      encoding: "utf8",
      env: registrarEnv({
        RUNNER_ID: "highlights-decide",
        RUNNER_APP: "highlights-live/decide",
        RUNNER_URL: "http://decide-router:8081",
        RUNNER_HEALTH_URL: "/nginx-health",
        RUNNER_MODE: "single-shot",
        RUNNER_PROXY: "1",
        RUNNER_CAPACITY: "auto",
        RUNNER_AUTO_CONF: repoFile("docker/decide-router.conf"),
        RUNNER_AUTO_SEQS: "2",
        RUNNER_METADATA: '{"model": "m", "engine": "vllm", "quantization": "q", "maxConcurrency": 8}',
        RUNNER_PRICE: "0.01",
        RUNNER_PRICE_UNIT: "fixed",
      }),
    },
  );
  return JSON.parse(out);
}

function registrarCapacity(): number {
  const out = execFileSync("python3", [registrar, "--print-capacity"], {
    encoding: "utf8",
    env: registrarEnv({
      RUNNER_CAPACITY: "auto",
      RUNNER_AUTO_CONF: repoFile("docker/decide-router.conf"),
      RUNNER_AUTO_SEQS: "2",
    }),
  });
  return Number(out.trim());
}

describe("decide runner health probe (ADAAAA-8088)", () => {
  it("decide registration probes the router-local /nginx-health", () => {
    const payload = decideRegistrarPayload();
    expect(payload.runner_id).toBe("highlights-decide");
    expect(payload.app).toBe("highlights-live/decide");
    expect(payload.runner_url).toBe("http://decide-router:8081");
    // A heartbeat carries no health_url (the registry only probes STATIC runners);
    // the registrar uses RUNNER_HEALTH_URL locally to decide whether to heartbeat.
    expect("health_url" in payload).toBe(false);
    expect(payload.mode).toBe("single-shot");
    expect(payload.capacity).toBe(6);
    // The sidecar env carries the health path the registrar probes:
    // RUNNER_HEALTH_URL=/nginx-health in docker/docker-compose.yml.
    expect(compose).toMatch(/RUNNER_HEALTH_URL=\/nginx-health/);
  });

  it("the health endpoint answers inside nginx and never proxies", () => {
    const start = conf.indexOf("location = /nginx-health");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = conf.indexOf("\n    }", start);
    const block = conf.slice(start, end);
    expect(block).toMatch(/return\s+200/);
    expect(block).not.toMatch(/proxy_pass/);
  });
});
