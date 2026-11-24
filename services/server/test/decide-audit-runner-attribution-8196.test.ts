// ADAAAA-8196 (1/2): the decide's SERVING pool identity lands on the durable
// `decide_audit` row, additively, for every descriptor shape the worker emits.
//
// AC coverage in this file:
//   AC-B1 the worker's own `timings.runnerRoute/runnerHost` (stamped at record
//         build time in services/decide, so the on-disk decide-audit.jsonl line
//         carries them too) reach the row VERBATIM.
//   AC-B2 a descriptor that only echoed the two fields at the TOP level still
//         lands them on `timings` (the additive safety net for an older/leaner
//         worker), without disturbing any other timing.
//   AC-B3 a pre-change descriptor (no attribution at all) is byte-identical:
//         `timings` stays exactly what the worker sent (including null).
//   AC-B4 `DECIDE_ROUTES`/`DECIDE_POOL_LABEL` parse into the client's configured
//         route list; an unset/blank env keeps routing unchanged.
import { describe, it, expect } from "vitest";
import { decideAuditRecordFromDescriptor, withRunnerAttribution } from "../src/decide-audit";
import { parseDecideRoutes } from "../src/config";

describe("ADAAAA-8196 AC-B1: the worker's stamped identity reaches the row", () => {
  it("keeps the timings the decide worker stamped (row shape as served)", () => {
    const desc = {
      sessionId: "job-8196",
      jobId: "job-8196",
      groupKey: "g12",
      createdAt: 1764000000.25,
      timings: {
        elapsedMs: 9243.195,
        vllmMs: 9242.098,
        runnerRoute: "highlights-decide-5090-gpu1",
        runnerHost: "decide-5090-gpu1/decide-pool-8183",
      },
      verdicts: { isHighlight: false },
    };
    const rec = decideAuditRecordFromDescriptor(desc);
    expect(rec).not.toBeNull();
    expect(rec!.timings).toMatchObject({
      elapsedMs: 9243.195,
      vllmMs: 9242.098,
      runnerRoute: "highlights-decide-5090-gpu1",
      runnerHost: "decide-5090-gpu1/decide-pool-8183",
    });
  });

  it("prefers the worker's own value over a differing top-level echo", () => {
    const desc = {
      sessionId: "job-8196",
      groupKey: "g1",
      runnerRoute: "highlights-decide",
      runnerHost: "host-bare",
      timings: { runnerRoute: "highlights-decide-5090-gpu2", runnerHost: "gpu2/pool" },
    };
    const timings = decideAuditRecordFromDescriptor(desc)!.timings!;
    expect(timings.runnerRoute).toBe("highlights-decide-5090-gpu2");
    expect(timings.runnerHost).toBe("gpu2/pool");
  });
});

describe("ADAAAA-8196 AC-B2: a top-level-only echo is merged into timings", () => {
  it("adds both fields beside the existing timings", () => {
    const desc = {
      sessionId: "job-8196",
      groupKey: "g2",
      runnerRoute: " highlights-decide-5090-gpu3 ",
      runnerHost: "decide-5090-gpu3/decide-pool-8183",
      timings: { elapsedMs: 10, auditWriteMs: 0.5 },
    };
    const timings = decideAuditRecordFromDescriptor(desc)!.timings;
    expect(timings).toEqual({
      elapsedMs: 10,
      auditWriteMs: 0.5,
      runnerRoute: "highlights-decide-5090-gpu3",
      runnerHost: "decide-5090-gpu3/decide-pool-8183",
    });
  });

  it("creates a timings object when the descriptor had none", () => {
    const desc = { sessionId: "job-8196", groupKey: "g3", runnerRoute: "r1", runnerHost: "h1/p" };
    expect(decideAuditRecordFromDescriptor(desc)!.timings).toEqual({ runnerRoute: "r1", runnerHost: "h1/p" });
  });
});

describe("ADAAAA-8196 AC-B3: a pre-change descriptor is unchanged", () => {
  it("leaves timings exactly as sent when no attribution is present", () => {
    const timings = { elapsedMs: 1, vllmMs: 2 };
    expect(withRunnerAttribution(timings, undefined, undefined)).toBe(timings);
    const desc = { sessionId: "job-old", groupKey: "g0", timings };
    expect(decideAuditRecordFromDescriptor(desc)!.timings).toBe(timings);
  });

  it("keeps a null timings null (never fabricates a measure)", () => {
    const desc = { sessionId: "job-old", groupKey: "g0", timings: null };
    expect(decideAuditRecordFromDescriptor(desc)!.timings).toBeNull();
  });

  it("ignores blank/non-string attribution values", () => {
    expect(withRunnerAttribution(null, "   ", 42 as unknown)).toBeNull();
    expect(withRunnerAttribution({ a: 1 }, "", null)).toEqual({ a: 1 });
  });
});

describe("ADAAAA-8196 AC-B4: DECIDE_ROUTES parsing", () => {
  it("parses route[:tier][@weight] entries in order", () => {
    expect(
      parseDecideRoutes("highlights-decide-5090-gpu1:5090@2, highlights-decide-5090-gpu2:5090 ,highlights-decide-x99"),
    ).toEqual([
      { route: "highlights-decide-5090-gpu1", tier: "5090", weight: 2 },
      { route: "highlights-decide-5090-gpu2", tier: "5090" },
      { route: "highlights-decide-x99" },
    ]);
  });

  it("returns undefined for an unset/blank env (routing unchanged)", () => {
    expect(parseDecideRoutes(undefined)).toBeUndefined();
    expect(parseDecideRoutes("   ")).toBeUndefined();
    expect(parseDecideRoutes(",, ,")).toBeUndefined();
  });

  it("skips a duplicate route and drops a non-positive weight", () => {
    expect(parseDecideRoutes("decide-a:5090@0,decide-a:5090@3,decide-b@nope")).toEqual([
      { route: "decide-a", tier: "5090" },
      { route: "decide-b" },
    ]);
  });
});
