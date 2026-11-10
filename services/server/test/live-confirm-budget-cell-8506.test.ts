// ADAAAA-8518 (AC1/AC2) — supersedes the ADAAAA-8506 cost cell.
//
// The CEO ruling on ADAAAA-8512 (2026-11-09 22:14:38Z / 22:15:08Z) removed the
// per-300 s dive budget AND the per-stream one-in-flight serialization: "if
// there is evidence of a goal then the deep dive should happen", and "the only
// cap should be the total capacity available in decide runners".
//
// So `LIVE_CONFIRM_MAX_DIVES_PER_300S` is no longer a product cap. It is an
// OPTIONAL operator emergency brake whose shipped posture is INERT:
//   - the compose passthrough default (what an unset `.env` serves) is `0`,
//   - `loadConfig`'s default is `null`,
//   - `normalizeConfirmDiveCap` reads absent / empty / `0` / negative as
//     UNLIMITED (never "no dives"); only an explicit POSITIVE value caps.
// A `.env` restore or a bare rebuild must not be able to re-impose the brake,
// which is exactly what the old `:-3` compose default did.
//
// Cost is still controlled — by OBSERVATION, not by a cap: a stream's dive spend
// is published as `observeMetrics.diveAdmission.diveCostUsd` (=
// `decideFee x divesBilled`), so the per-stream-hour figure is readable from the
// job record. The Stage-1 lane's own rate stays inside the CEO-locked ceiling;
// the dives are extra calls that the capacity gate, not a counter, bounds.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config";
import { normalizeConfirmDiveCap } from "../src/live-confirm-async";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");

/** The `server` service's passthrough line for the dive brake, as compose reads it. */
function composeDefault(): string | undefined {
  const m = compose.match(/^\s*-\s*LIVE_CONFIRM_MAX_DIVES_PER_300S=\$\{LIVE_CONFIRM_MAX_DIVES_PER_300S:-([^}]*)\}\s*$/m);
  return m ? m[1] : undefined;
}

describe("live Stage-2 dive admission is capacity-only (ADAAAA-8518)", () => {
  it("the server service still forwards the knob, with an INERT default", () => {
    // Without the line the variable cannot reach the container at all; with a
    // positive default a bare rebuild/`.env` restore re-imposes the old brake.
    expect(composeDefault()).toBeDefined();
    expect(normalizeConfirmDiveCap(composeDefault())).toBeNull();
  });

  it("the compose default and the config default are both unlimited", () => {
    const configDefault = loadConfig({ PERCEIVE_URL: "http://p", DECIDE_URL: "http://d" }).liveConfirmMaxDivesPer300S;
    expect(configDefault).toBeNull();
    expect(normalizeConfirmDiveCap(composeDefault())).toBeNull();
  });

  it("an operator brake still works, and the 1000 magic number is not the thing holding it open", () => {
    const cfg = loadConfig({
      PERCEIVE_URL: "http://p",
      DECIDE_URL: "http://d",
      LIVE_CONFIRM_MAX_DIVES_PER_300S: "3",
    });
    expect(cfg.liveConfirmMaxDivesPer300S).toBe(3);
    // The interim arm posture (1000) and the deleted default alike read as "no
    // brake"; the code default is what makes the lane uncapped, not a big number.
    expect(normalizeConfirmDiveCap("1000")).toBe(1000);
    expect(normalizeConfirmDiveCap("0")).toBeNull();
    expect(normalizeConfirmDiveCap(undefined)).toBeNull();
  });

  it("Stage-1 still holds the CEO-locked $2.75/h ceiling at the ratified decide rate", () => {
    // Ratified Stage-1 cell: 66 charged decides / 300 s (ADAAAA-8427/8431).
    // Dives are NOT divided out of this ceiling any more; their spend is
    // published per stream instead (AC5 `diveAdmission.diveCostUsd`).
    const decidesPer300s = 66;
    const decideFeeUsd = 0.0033;
    const windowsPerHour = 3600 / 300;
    const stage1HourlyUsd = decidesPer300s * windowsPerHour * decideFeeUsd;
    expect(stage1HourlyUsd).toBeLessThanOrEqual(2.75);
  });
});
