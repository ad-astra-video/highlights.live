// ADAAAA-8504: the decide-capacity snapshot must be GRADEABLE FROM THE JOB
// RECORD, not from a rotating `[decide-capacity]` log line.
//
// The origin failure: on the first post-deploy natural live job
// (`c4d33a26-e78b-4c6b-9cf6-3317446f3d20`, `source: browser`)
// `record::jsonb::text like '%decideCapacity%'` was FALSE. The analyzer live pass
// folded the admission metrics, but a browser/RTMP share decides through the
// MEDIA RAIL, and the rail's `observeMetrics()` never folded them at all. The
// pre-registered leg-plan §5 condition (`effective = 12`, `probeOk true`,
// `advertised 12`) therefore had to be reported "not recorded".
//
// What these tests pin:
// 1. the record carries `advertised/funded/effective/probeOk/source/cap` PLUS
//    `decideRegistrations` (AC3: the rename of the misleading `runners`) and `at`,
//    and the keys SURVIVE `JobSchema.parse` on the way to the row (the
//    `perceiveSource` / `decideStages` stripping trap);
// 2. the snapshot latched at job START wins over a mid-job refresh;
// 3. the media rail publishes it at share end, and a rail without a latch leaves
//    the record byte-identical (absent = "not recorded", never 0);
// 4. the admin window-audit readout exposes decideRegistrations + at, and still
//    reads the legacy `runners` name from older rows;
// 5. admission MATH is untouched (`effective` is still the client's value).
import { describe, it, expect } from "vitest";
import { SqliteDb } from "../src/db";
import { Store } from "../src/store";
import { decideCapacityOnRecord, withDecideAdmissionMetrics, type DecideCapacityLatch } from "../src/analyzer";
import { MediaRailObserver } from "../src/media-rail";
import { windowAuditForJob } from "../src/window-audit";
import type { DecideCapacitySnapshot } from "@highlights/livepeer-session";

const baseObserveMetrics = {
  decideCalls: 147,
  accepted: 12,
  maxFrames: 4,
  meanE2eMs: 3900,
  maxE2eMs: 8100,
  meanCadenceMs: 3900,
  maxCadenceMs: 4200,
  triggerFires: 20,
  cadenceFires: 127,
};

/** The posture the pre-registered condition names: advertised 12, effective 12. */
const START_SNAPSHOT: DecideCapacitySnapshot = {
  advertised: 12,
  funded: 8,
  effective: 12,
  probeOk: true,
  runners: 1,
  source: "probe",
  cap: 32,
};

/** A mid-run refresh that must NOT overwrite the latched start posture. */
const LATER_SNAPSHOT: DecideCapacitySnapshot = {
  ...START_SNAPSHOT,
  advertised: 6,
  effective: 6,
};

const LATCH: DecideCapacityLatch = { capacity: START_SNAPSHOT, at: "2026-11-09T19:20:00.000Z" };

describe("ADAAAA-8504: decideCapacity is written to the job record", () => {
  it("writes the log line's numbers under decideRegistrations (not runners) + at", () => {
    const capacity = decideCapacityOnRecord(START_SNAPSHOT, LATCH.at);
    expect(capacity).toEqual({
      advertised: 12,
      funded: 8,
      effective: 12,
      probeOk: true,
      decideRegistrations: 1,
      source: "probe",
      cap: 32,
      at: LATCH.at,
    });
    // AC3: the misleading name is not emitted; AC2: the client/log line keeps it.
    expect((capacity as any).runners).toBeUndefined();
  });

  it("survives persistence onto jobs.record (the zod schema declares the new keys)", async () => {
    const db = new SqliteDb(":memory:");
    const s = new Store(db);
    const j = await s.createJob({ ownerId: "u1", source: "browser" });
    const observeMetrics = withDecideAdmissionMetrics(baseObserveMetrics, undefined, LATCH);
    await s.patchJob(j.id, { status: "done", observeMetrics });

    const stored = (await db.getJob(j.id))!;
    expect(stored.observeMetrics!.decideCapacity).toEqual({
      advertised: 12,
      funded: 8,
      effective: 12,
      probeOk: true,
      decideRegistrations: 1,
      source: "probe",
      cap: 32,
      at: LATCH.at,
    });
    // The raw record is what QA's `record->'observeMetrics'` / jsonb text read
    // returns — the exact read that came back empty on job c4d33a26.
    const raw = JSON.stringify(stored);
    expect(raw).toContain('"decideCapacity"');
    expect(raw).toContain('"advertised":12');
    expect(raw).toContain('"effective":12');
    expect(raw).toContain('"probeOk":true');
    expect(raw).toContain('"decideRegistrations":1');
    expect(raw).toContain(`"at":"${LATCH.at}"`);
    expect(raw).not.toContain('"runners"');
  });

  it("the snapshot latched at job START wins over a mid-job refresh", () => {
    // The gate has already refreshed to 6 (a fleet change mid-run); the record
    // must still describe the posture the job was ADMITTED at.
    const merged = withDecideAdmissionMetrics(
      baseObserveMetrics,
      {
        decideQueued: 0,
        decideDropped: 0,
        decide503: 0,
        decidePauses: 0,
        capacityProbeErrors: 0,
        capacity: LATER_SNAPSHOT,
      },
      LATCH
    );
    expect(merged.decideCapacity!.effective).toBe(12);
    expect(merged.decideCapacity!.advertised).toBe(12);
    expect(merged.decideCapacity!.at).toBe(LATCH.at);
    // ...while the admission COUNTERS stay the live ones.
    expect(merged.decideQueued).toBe(0);
  });

  it("no gate and no latch leaves the snapshot byte-identical (absent, never 0)", () => {
    expect(withDecideAdmissionMetrics(baseObserveMetrics)).toEqual(baseObserveMetrics);
    // ...and the admin readout answers NULL ("not recorded"), not a zero row.
    const audit = windowAuditForJob({ id: "j-absent", status: "done", source: "browser", observeMetrics: baseObserveMetrics as any });
    expect(audit.decideCapacity).toBeNull();
  });
});

describe("ADAAAA-8504: the media rail publishes the start posture", () => {
  it("folds the latched snapshot into observeMetrics at share end", async () => {
    const rail = new MediaRailObserver({
      jobId: "j-8504-rail",
      cadenceS: 3600, // only the finish tail, so nothing decides mid-test
      onDecide: async () => false,
      decideCapacityLatch: () => LATCH,
    });
    const t0 = Date.now() / 1000;
    rail.onObservation({ seq: 0, timestamp: t0, tracks: [] }, Buffer.from("f0").toString("base64"));
    await rail.finish();

    const m = rail.observeMetrics();
    expect(m.decideCapacity).toEqual({
      advertised: 12,
      funded: 8,
      effective: 12,
      probeOk: true,
      decideRegistrations: 1,
      source: "probe",
      cap: 32,
      at: LATCH.at,
    });
    // The rail owns no per-job admission COUNTERS, so it must not invent them.
    expect((m as any).decideQueued).toBeUndefined();
  });

  it("a rail built without a latch leaves the record unchanged (older caller)", async () => {
    const rail = new MediaRailObserver({
      jobId: "j-8504-nolatch",
      cadenceS: 3600,
      onDecide: async () => false,
    });
    const t0 = Date.now() / 1000;
    rail.onObservation({ seq: 0, timestamp: t0, tracks: [] }, Buffer.from("f0").toString("base64"));
    await rail.finish();
    expect(rail.observeMetrics().decideCapacity).toBeUndefined();
  });
});

describe("ADAAAA-8504: the admin readout carries the renamed field", () => {
  it("projects decideRegistrations + at from a stored row", () => {
    const audit = windowAuditForJob({
      id: "j-8504-audit",
      status: "done",
      source: "browser",
      observeMetrics: {
        ...baseObserveMetrics,
        decideCapacity: decideCapacityOnRecord(START_SNAPSHOT, LATCH.at),
      } as any,
    });
    expect(audit.decideCapacity).toMatchObject({
      advertised: 12,
      effective: 12,
      probeOk: true,
      source: "probe",
      cap: 32,
      decideRegistrations: 1,
      at: LATCH.at,
    });
    expect(audit.decideCapacity!.runners).toBeUndefined();
  });

  it("still reads the legacy `runners` name from a pre-8504 row", () => {
    const audit = windowAuditForJob({
      id: "j-8504-legacy",
      status: "done",
      source: "rtmp",
      observeMetrics: {
        ...baseObserveMetrics,
        decideCapacity: { advertised: 12, funded: 8, effective: 12, probeOk: true, runners: 1, source: "probe", cap: 32 },
      } as any,
    });
    expect(audit.decideCapacity!.runners).toBe(1);
    expect(audit.decideCapacity!.decideRegistrations).toBeUndefined();
  });
});
