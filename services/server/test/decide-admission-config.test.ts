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
  it("the server ships DECIDE_CONCURRENCY=8 (the pair's 4+4 decide slots)", () => {
    const server = serviceBlock("server");
    expect(server).toContain("DECIDE_CONCURRENCY=${DECIDE_CONCURRENCY:-8}");
    // …and it is not shadowed by a second definition in the same service.
    expect(server.match(/DECIDE_CONCURRENCY=/g)?.length).toBe(1);
  });

  it("the decide runner advertises the ROUTED set: 6 slots, derived from the pool", () => {
    // ADAAAA-8281: the pool's primary upstreams are the three 5090 decide
    // workers at `--max-num-seqs 2` each; the x99 pair is `backup` only, so the
    // capacity the router actually balances across is 3 x 2 = 6. The funded bar
    // stays DECIDE_CONCURRENCY=8 — the whole point of the capacity-aware ceiling
    // is that `effective = min(funded, advertised) = 6` comes from the routed
    // set, not from the server hardcoding a list.
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

  it("an 8-wide admission gives two streams 4 each instead of the serial pass", () => {
    // The ADAAAA-7771 shared budget: floor(admission / activeStreams), capped by
    // the per-stream depth (LIVE_OBSERVE_IN_FLIGHT, shipped 4).
    const gate = new LiveDecideAdmission({ enabled: false });
    gate.registerLiveJob("job-a");
    expect(gate.depthFor("job-a", 4, 8)).toBe(4); // lone stream: unchanged
    gate.registerLiveJob("job-b");
    expect(gate.depthFor("job-a", 4, 8)).toBe(4); // 8 / 2 = 4 each = 8 concurrent
    expect(gate.depthFor("job-b", 4, 8)).toBe(4);
    // With the OLD 2-wide client gate the same two streams degraded to serial,
    // which is the regression this pins.
    expect(gate.depthFor("job-a", 4, 2)).toBe(1);
    expect(gate.depthFor("job-b", 4, 2)).toBe(1);
    gate.releaseLiveJob("job-a");
    gate.releaseLiveJob("job-b");
  });
});
