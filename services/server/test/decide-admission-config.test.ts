// ADAAAA-7773: the decide ADMISSION has to match the box, or the ADAAAA-7771
// in-flight depth silently turns into a queue.
//
// Measured on the deployed box (`b366de0`): the compose default for
// DECIDE_CONCURRENCY was unset, so `LivepeerClient` admitted 2 decide app-calls
// while the observer kept 4 windows in flight per stream. The extra two windows
// only queued, so every decided window landed later (2 streams: 24.8-26.6 s
// decide E2E, lag p50 50.8-52.0 s versus the 32.6-34.5 s serial baseline), and
// the lag budget then dropped the queue (74-75 skipped windows). Both admission
// layers were narrower than the box: the client gate (2) and the decide runner
// registration (`capacity: 4` fronting two gemma cards at 4 slots each = 8).
//
// This suite pins the two config surfaces plus the budget arithmetic that joins
// them, so a revert of either knob fails here instead of in a box measurement.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LiveDecideAdmission } from "../src/live-decide-admission";
import { loadConfig } from "../src/config";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");
// ADAAAA-8281 follow-up: the registration is dynamic now (`POST
// /runners/heartbeat` from docker/live-runner-registrar.py); there is no
// runners.json. Resolve the decide registration by running the sidecar's own
// payload builder, so these assertions describe exactly what the box sends.
const registrar = repoFile("docker/live-runner-registrar.py");

function decideRegistration(): Record<string, any> {
  const out = execFileSync("python3", [registrar, "--print-payload"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUNNER_ID: "highlights-decide",
      RUNNER_APP: "highlights-live/decide",
      RUNNER_URL: "http://decide-router:8081",
      RUNNER_HEALTH_URL: "/nginx-health",
      RUNNER_MODE: "single-shot",
      RUNNER_PROXY: "1",
      RUNNER_CAPACITY: "auto",
      RUNNER_AUTO_CONF: repoFile("docker/decide-router.conf"),
      RUNNER_AUTO_SEQS: "2",
      RUNNER_METADATA:
        '{"model": "cyankiwi/gemma-4-12B-it-qat-AWQ-INT4", "engine": "vllm", "quantization": "compressed-tensors INT4", "maxConcurrency": 8}',
      RUNNER_PRICE: "0.01",
      RUNNER_PRICE_UNIT: "fixed",
    },
  });
  return JSON.parse(out);
}

/** The `environment:` block of one compose service, as text. */
function serviceBlock(name: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  // A service block ends at the next `  <name>:` line (two-space indent = service
  // key). Volume/ports/… keys are four+ spaces deep.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-zA-Z0-9_.-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}


describe("decide admission config (ADAAAA-7773)", () => {
  it("the server ships DECIDE_CONCURRENCY=8 (funded/reporting) and DECIDE_MAX_ADMISSION=32 (safety cap)", () => {
    const server = serviceBlock("server");
    // ADAAAA-8437: DECIDE_CONCURRENCY is the funded value the snapshot reports
    // and the dark-discovery fallback — NOT an admission ceiling any more.
    expect(server).toContain("DECIDE_CONCURRENCY=${DECIDE_CONCURRENCY:-8}");
    // …and it is not shadowed by a second definition in the same service.
    expect(server.match(/DECIDE_CONCURRENCY=/g)?.length).toBe(1);
    // The safety cap ships beside it, exactly once, defaulting to 32.
    expect(server).toContain("DECIDE_MAX_ADMISSION=${DECIDE_MAX_ADMISSION:-32}");
    expect(server.match(/DECIDE_MAX_ADMISSION=/g)?.length).toBe(1);
  });

  it("the stale '8 real decide slots (4 per gemma card)' justification is gone", () => {
    // ADAAAA-8437: the routed set is the three 5090 workers at 2 seqs each
    // (3 x 2 = 6) and the x99 pair is `backup`; the comment must not claim the
    // pre-ADAAAA-8281 4+4 topology, nor that 8 is the admission ceiling.
    const server = serviceBlock("server");
    expect(server).not.toContain("--max-num-seqs 4 on");
    expect(server).not.toContain("admission is 8");
    expect(server).toContain("NO LONGER the admission\n      # ceiling");
  });

  it("the decide runner advertises the ROUTED set: 6 slots, derived from the pool", () => {
    // ADAAAA-8281: the pool's primary upstreams are the three 5090 decide
    // workers at `--max-num-seqs 2` each; the x99 pair is `backup` only, so the
    // capacity the router actually balances across is 3 x 2 = 6. ADAAAA-8437:
    // that 6 IS the admission (`effective`), and the funded DECIDE_CONCURRENCY=8
    // is only the reporting value / dark-discovery fallback — which is why the
    // next capacity change is a worker-seqs re-create, not this knob.
    //
    // The number is NOT written in a config file any more: the sidecar derives
    // it from the pool (`RUNNER_CAPACITY=auto`), which is why this test runs the
    // registrar rather than reading JSON. If someone hardcodes 6 again the
    // pool-parser assertion in decide-router-upstreams.test.ts is what catches
    // the drift; here we pin that the shipped sidecar still derives, and that
    // the engine metadata keeps its own maxConcurrency (8), which is NOT the
    // admission ceiling.
    const registration = decideRegistration();
    expect(registration.capacity).toBe(6);
    expect(registration.mode).toBe("single-shot");
    expect(registration.runner_id).toBe("highlights-decide");
    const md = JSON.parse(registration.metadata);
    expect(md.maxConcurrency).toBe(8);
    // The sidecar env must keep the derivation, not a literal capacity.
    expect(serviceBlock("registrar-decide")).toContain("RUNNER_CAPACITY=auto");
    expect(serviceBlock("registrar-decide")).toContain("RUNNER_AUTO_SEQS=${DECIDE_WORKER_SEQS:-2}");
  });

  it("config.ts reads the env and keeps the client's own default when unset", () => {
    expect(loadConfig({ DECIDE_CONCURRENCY: "8" } as NodeJS.ProcessEnv).decideConcurrency).toBe(8);
    // Unset must stay undefined so the client keeps its own gate (2) on a dev box.
    expect(loadConfig({} as NodeJS.ProcessEnv).decideConcurrency).toBeUndefined();
  });

  it("the signer advertises a capacity change in ~1 min, not go-livepeer's 25 min default", () => {
    // ADAAAA-8292: `advertised` is read from the signer's /discover-orchestrators
    // answer, and go-livepeer caches that answer for `-liveAICapReportInterval`
    // (default 25 MINUTES). A dynamically registered runner changes capacity on
    // ONE heartbeat, so the default cache would hide a pool re-route + registrar
    // recreate for up to 25 min — the admitted ceiling would keep saying 6 while
    // the registry says 4. Pin the bounded interval and that the entrypoint
    // forwards it only when the binary knows the flag (an unknown flag makes
    // livepeer print usage and exit, i.e. a crash-looping signer).
    const signer = serviceBlock("signer");
    expect(signer).toContain("LIVE_AI_CAP_REPORT_INTERVAL=${LIVE_AI_CAP_REPORT_INTERVAL:-60s}");
    const entrypoint = readFileSync(repoFile("services/signer/docker-entrypoint.sh"), "utf8");
    expect(entrypoint).toMatch(
      /-help 2>&1 \| grep -q -- "-liveAICapReportInterval".*[\s\S]*-liveAICapReportInterval "\$LIVE_AI_CAP_REPORT_INTERVAL"/,
    );
  });

  it("an advertised 6 gives two streams 3 each; a 12-wide advertisement fills the configured 4 (AC5)", () => {
    // ADAAAA-8437 (AC5): depth = min(LIVE_OBSERVE_IN_FLIGHT, floor(effective /
    // active streams)). The advertised capacity is what sizes the pass now.
    const gate = new LiveDecideAdmission({ enabled: false });
    gate.registerLiveJob("job-a");
    expect(gate.depthFor("job-a", 4, 6)).toBe(4); // lone stream: byte-identical
    gate.registerLiveJob("job-b");
    expect(gate.depthFor("job-a", 4, 6)).toBe(3); // 6 / 2 = 3 each
    expect(gate.depthFor("job-b", 4, 6)).toBe(3);
    expect(gate.depthFor("job-a", 4, 12)).toBe(4); // 12 / 2 = 6, capped at 4
    gate.registerLiveJob("job-c");
    expect(gate.depthFor("job-a", 4, 12)).toBe(4); // 12 / 3 = 4 each
    gate.registerLiveJob("job-d");
    expect(gate.depthFor("job-a", 4, 12)).toBe(3); // 12 / 4 = 3 each
    // The OLD 2-wide funded gate is still the serial fallback for two streams.
    expect(gate.depthFor("job-a", 4, 2)).toBe(1);
    expect(gate.depthFor("job-b", 4, 2)).toBe(1);
    gate.releaseLiveJob("job-a");
    gate.releaseLiveJob("job-b");
    gate.releaseLiveJob("job-c");
    gate.releaseLiveJob("job-d");
  });
});
