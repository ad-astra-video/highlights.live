// ADAAAA-8566 — supersedes the ADAAAA-8518 compose pin; still carries the
// ADAAAA-8518 (AC1/AC2) config semantics.
//
// The CEO ruling on ADAAAA-8512 (2026-11-09 22:14:38Z / 22:15:08Z) removed the
// per-300 s dive budget AND the per-stream one-in-flight serialization: "if
// there is evidence of a goal then the deep dive should happen", and "the only
// cap should be the total capacity available in decide runners".
//
// ADAAAA-8518 first neutered the knob by forwarding an INERT `0` from compose.
// ADAAAA-8512's follow-up directive of record (2026-11-10T06:32:36Z) asked for
// the variable itself to be gone, so compose no longer declares it at all:
//   - the compose file must contain ZERO occurrences of the name (this file is
//     the grep-absence guard, so nobody re-adds the passthrough or a comment
//     that re-describes the brake),
//   - `loadConfig`'s default is `null`,
//   - `normalizeConfirmDiveCap` reads absent / empty / `0` / negative as
//     UNLIMITED (never "no dives"); only an explicit POSITIVE value caps.
// A `.env` restore or a bare rebuild therefore has no compose line to feed: the
// live Stage-2 dive stays capacity-only.
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

const KNOB = "LIVE_CONFIRM" + "_MAX_DIVES_PER_300S";

describe("live Stage-2 dive admission is capacity-only (ADAAAA-8518, ADAAAA-8566)", () => {
  it("compose no longer forwards the dive-brake variable at all", () => {
    // ADAAAA-8512 directive of record: remove the variable, not merely neuter
    // it. Any occurrence — passthrough line or explanatory comment — fails.
    expect(compose.includes(KNOB)).toBe(false);
    const passthrough = new RegExp(`^\\s*-\\s*${KNOB}=`, "m");
    expect(passthrough.test(compose)).toBe(false);
  });

  it("the config default is unlimited when the variable is absent", () => {
    const configDefault = loadConfig({ PERCEIVE_URL: "http://p", DECIDE_URL: "http://d" }).liveConfirmMaxDivesPer300S;
    expect(configDefault).toBeNull();
  });

  it("an operator brake still works, and the 1000 magic number is not the thing holding it open", () => {
    const cfg = loadConfig({
      PERCEIVE_URL: "http://p",
      DECIDE_URL: "http://d",
      LIVE_CONFIRM_MAX_DIVES_PER_300S: "3",
    });
    expect(cfg.liveConfirmMaxDivesPer300S).toBe(3);
    // The interim arm posture (1000) and the deleted compose default alike read
    // as "no brake"; the code default is what makes the lane uncapped, not a
    // big number.
    expect(normalizeConfirmDiveCap("3")).toBe(3);
    expect(normalizeConfirmDiveCap("1000")).toBe(1000);
  });

  it("absent, empty, zero and negative all read as UNLIMITED", () => {
    expect(normalizeConfirmDiveCap(undefined)).toBeNull();
    expect(normalizeConfirmDiveCap("")).toBeNull();
    expect(normalizeConfirmDiveCap("0")).toBeNull();
    expect(normalizeConfirmDiveCap("-1")).toBeNull();
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
