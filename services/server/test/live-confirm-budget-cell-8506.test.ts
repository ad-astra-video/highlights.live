// ADAAAA-8506: `LIVE_CONFIRM_MAX_DIVES_PER_300S` was parsed by `config.ts` and
// honoured by the dive pump, but the compose `server` service never passed it
// through — so the box could only change the per-300 s dive budget with an image
// rebuild, and `docker exec highlights-server printenv` had no such variable
// (measured on the arm probe for ADAAAA-8506: the shipped image read 8 dives,
// i.e. 66 + 8 = 74 calls / 300 s = $2.9304/h/stream against the CEO-locked
// $2.75/h ceiling).
//
// The budget is a COST cell, so the three numbers that define it must agree and
// no one of them may drift on its own:
//   - the compose passthrough default (what an unset `.env` actually serves),
//   - `loadConfig`'s default (what the process resolves),
//   - `LIVE_CONFIRM_MAX_DIVES_PER_300S` (what the pump's fallback admits).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config";
import { LIVE_CONFIRM_MAX_DIVES_PER_300S, LIVE_CONFIRM_BUDGET_WINDOW_S } from "../src/live-confirm-async";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");

/** The `server` service's passthrough line for the dive budget, as compose reads it. */
function composeDefault(): number | undefined {
  const m = compose.match(/^\s*-\s*LIVE_CONFIRM_MAX_DIVES_PER_300S=\$\{LIVE_CONFIRM_MAX_DIVES_PER_300S:-(\d+)\}\s*$/m);
  return m ? Number(m[1]) : undefined;
}

describe("live Stage-2 dive budget is one cost cell (ADAAAA-8506)", () => {
  it("the server service passes the knob through with the cap-derived default", () => {
    // Without this line the variable cannot reach the container at all.
    expect(composeDefault()).toBe(3);
  });

  it("the compose default, the config default and the pump fallback are the same number", () => {
    const configDefault = loadConfig({ PERCEIVE_URL: "http://p", DECIDE_URL: "http://d" }).liveConfirmMaxDivesPer300S;
    expect(configDefault).toBe(LIVE_CONFIRM_MAX_DIVES_PER_300S);
    expect(composeDefault()).toBe(LIVE_CONFIRM_MAX_DIVES_PER_300S);
  });

  it("an operator-composed cell overrides the default verbatim", () => {
    const cfg = loadConfig({
      PERCEIVE_URL: "http://p",
      DECIDE_URL: "http://d",
      LIVE_CONFIRM_MAX_DIVES_PER_300S: "3",
    });
    expect(cfg.liveConfirmMaxDivesPer300S).toBe(3);
    expect(cfg.liveConfirmMaxDivesPer300S).toBe(composeDefault());
  });

  it("the armed cell holds the CEO-locked $2.75/h ceiling at the ratified decide rate", () => {
    // Ratified Stage-1 cell: 66 charged decides / 300 s (ADAAAA-8427/8431).
    const decidesPer300s = 66;
    const decideFeeUsd = 0.0033;
    const windowsPerHour = 3600 / LIVE_CONFIRM_BUDGET_WINDOW_S;
    const hourlyUsd = (decidesPer300s + LIVE_CONFIRM_MAX_DIVES_PER_300S) * windowsPerHour * decideFeeUsd;
    expect(LIVE_CONFIRM_MAX_DIVES_PER_300S).toBe(3);
    expect(hourlyUsd).toBeLessThanOrEqual(2.75);
  });
});
