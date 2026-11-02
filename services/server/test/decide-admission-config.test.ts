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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LiveDecideAdmission } from "../src/live-decide-admission";
import { loadConfig } from "../src/config";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");
const runners = JSON.parse(readFileSync(repoFile("docker/runners.json"), "utf8"));
const runnersTemplate = JSON.parse(readFileSync(repoFile("docker/runners.template.json"), "utf8"));

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

function decideRunner(doc: { runners: Array<Record<string, any>> }) {
  const r = doc.runners.find((x) => x.label === "highlights-decide");
  expect(r, "highlights-decide runner registration").toBeTruthy();
  return r!;
}

describe("decide admission config (ADAAAA-7773)", () => {
  it("the server ships DECIDE_CONCURRENCY=8 (the pair's 4+4 decide slots)", () => {
    const server = serviceBlock("server");
    expect(server).toContain("DECIDE_CONCURRENCY=${DECIDE_CONCURRENCY:-8}");
    // …and it is not shadowed by a second definition in the same service.
    expect(server.match(/DECIDE_CONCURRENCY=/g)?.length).toBe(1);
  });

  it("the decide runner advertises the same 8 slots (committed + template)", () => {
    for (const doc of [runners, runnersTemplate]) {
      const r = decideRunner(doc);
      expect(r.capacity).toBe(8);
      // metadata is a JSON-encoded string on the registration.
      const md = typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata;
      expect(md.maxConcurrency).toBe(8);
    }
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
