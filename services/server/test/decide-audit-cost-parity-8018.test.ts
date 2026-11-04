// ADAAAA-8018: the live decide cost ledger — one billed decide must have one row.
//
// The ADAAAA-8011 re-grade on `0f7ef58` (job `14e0af6e-6e25-48ca-911c-12d6400461eb`)
// billed 48 decides (`observeMetrics.decideCalls 48`, `costUsd 0.159`) while
// `decide_audit` held 47 rows for the job: 47 x $0.0033 = $0.1551, -2.5% against a
// 1% agreement bar. The DB read that identified the loss:
//
//   TOTAL 47, CONFIRM_ROWS 0, PRIMARY_ROWS 47, all prompt version 2
//   18 rows stamped `stageA/burst/1.3x/0.3s`, 1 stamped
//   `stageB/whistle/2.4-3.4k/5x/0.3s` (g59), 28 unstamped (cadence)
//   observeMetrics: decideCalls 48, cadenceFires 28, triggerFires 20,
//                   whistleDecides 1, whistleWindows[0].centerTs 177 (= g59)
//
// 28 cadence rows for 28 cadence fires, but 19 trigger-stamped rows for 20
// trigger-anchored decides: the whistle-anchored decide landed in the same 3 s
// frame group (g59 = floor(177/3)) as the stageA-anchored decide that had already
// written that group, and the row identity is (job, group) — so the second billed
// call OVERWROTE the first instead of appending. The whistle decide is audited;
// the decide it displaced is the unaudited one. The issue's guess was inverted in
// direction, not in class.
//
// The fix gives each billed CALL its own labelled row inside the group
// (`g59`, `g59:call2`, ...) and leaves the group's canonical row identity alone.
// These tests fail on the pre-fix build (2 billed calls -> 1 row) and pass after.
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db";
import { attachTriggerFamilyToAudit } from "../src/analyzer";
import { decideAuditGroupSlot, recordDecideAudit } from "../src/decide-audit";

const JOB = "14e0af6e-6e25-48ca-911c-12d6400461eb";
/** `cfg.decideFee` — the per-decide price the meter bills at. */
const FEE = 0.0033;
const STAGE_A = "stageA/burst/1.3x/0.3s";
const WHISTLE = "stageB/whistle/2.4-3.4k/5x/0.3s";

/** The 47 frame groups `decide_audit` actually holds for that job (read from the
 * box: `select group_key ... where job_id='14e0af6e-…' order by created_at`). */
const GROUPS = [
  "g0", "g1", "g3", "g4", "g6", "g7", "g9", "g10", "g12", "g13", "g15", "g16",
  "g18", "g19", "g21", "g22", "g24", "g25", "g27", "g28", "g30", "g31", "g33",
  "g34", "g36", "g37", "g39", "g40", "g42", "g43", "g45", "g46", "g48", "g49",
  "g51", "g53", "g54", "g56", "g57", "g59", "g60", "g62", "g63", "g65", "g66",
  "g68", "g69",
];

/** 19 groups were anchored on a Stage-A trigger fire (18 rows survive + g59,
 * whose row the whistle decide displaced). The rest are cadence fires. */
const STAGE_A_GROUPS = new Set([
  "g3", "g4", "g6", "g7", "g9", "g12", "g16", "g18", "g21", "g25", "g28", "g30",
  "g37", "g40", "g48", "g49", "g59", "g62", "g66",
]);
/** The whistle-anchored decide's own window: content ts 177 -> group `g59`. */
const WHISTLE_GROUP = "g59";

/** One decide-service `_audit` descriptor, shaped like gemma.py's
 * `_audit_descriptor` output (epoch-seconds `createdAt`, per-call timings). */
function descriptor(groupKey: string, callIndex: number, promptTail = "") {
  return {
    version: 1,
    systemPromptVersion: "2",
    mode: "single",
    sessionId: JOB,
    jobId: JOB,
    groupKey,
    frameCount: 8,
    candidateCount: 1,
    promptText: `system\nuser prompt for ${groupKey} ${promptTail}`.trimEnd(),
    mediaHashes: [{ type: "image", sha256: "a".repeat(64), mime: "image/jpeg" }],
    params: { temperature: 0, max_tokens: 1200 },
    rawReply: '{"isHighlight":false}',
    verdicts: { isHighlight: false },
    timings: { elapsedMs: 3500 + callIndex },
    fallback: false,
    replayable: true,
    createdAt: 1770000000 + callIndex * 3,
  };
}

/** Ingest the job's 48 billed decides in the order the observer fired them: the
 * 47 first-of-group calls (cadence + Stage-A anchored), then the whistle-anchored
 * decide that shares `g59` with the Stage-A decide already recorded there. */
async function ingestJob(db: SqliteDb): Promise<{ prompts: string[] }> {
  const prompts: string[] = [];
  let callIndex = 0;
  for (const groupKey of GROUPS) {
    const call = descriptor(groupKey, callIndex, STAGE_A_GROUPS.has(groupKey) ? "burst" : "");
    prompts.push(call.promptText);
    await recordDecideAudit(
      db,
      attachTriggerFamilyToAudit(call, STAGE_A_GROUPS.has(groupKey) ? { thresholdId: STAGE_A } : null),
      0
    );
    callIndex++;
  }
  const whistle = descriptor(WHISTLE_GROUP, callIndex, "whistle");
  prompts.push(whistle.promptText);
  await recordDecideAudit(db, attachTriggerFamilyToAudit(whistle, { thresholdId: WHISTLE }), 0);
  return { prompts };
}

describe("ADAAAA-8018 decide cost ledger: one billed decide == one decide_audit row", () => {
  it("records every billed call of a multi-billed frame group as its own labelled row", async () => {
    const db = new SqliteDb(":memory:");
    await ingestJob(db);
    const rows = await db.decideAuditsForJob(JOB);

    // 48 billed decides (28 cadence + 20 trigger fires) -> 48 rows. Pre-fix this
    // read 47: the whistle call upserted over the Stage-A row in g59.
    expect(rows).toHaveLength(48);

    // The group's canonical row is untouched semantics: it is the FIRST call.
    const canonical = await db.decideAuditForGroup(JOB, WHISTLE_GROUP);
    expect(canonical?.groupKey).toBe(WHISTLE_GROUP);
    expect((canonical?.params as any)?.triggerFamily).toBe("stageA");
    expect((canonical?.params as any)?.triggerThresholdId).toBe(STAGE_A);
    expect((canonical?.params as any)?.auditOrdinal).toBeUndefined();

    // The extra billed call is its own row, explicitly labelled (both in the id /
    // group slot and in params) and still names its own trigger family.
    const whistleRow = rows.find((r) => r.groupKey === `${WHISTLE_GROUP}:call2`);
    expect(whistleRow).toBeDefined();
    expect(whistleRow!.id).toBe(`${JOB}::${WHISTLE_GROUP}:call2`);
    expect((whistleRow!.params as any)?.triggerFamily).toBe("stageB");
    expect((whistleRow!.params as any)?.triggerThresholdId).toBe(WHISTLE);
    expect((whistleRow!.params as any)?.auditOrdinal).toBe(2);
    expect((whistleRow!.params as any)?.auditBaseGroupKey).toBe(WHISTLE_GROUP);
    expect(whistleRow!.promptText).toContain("whistle");

    // No other group is duplicated (only the measured collision).
    const perGroup = new Map<string, number>();
    for (const r of rows) {
      const base = String(r.groupKey).replace(/:call\d+$/, "");
      perGroup.set(base, (perGroup.get(base) ?? 0) + 1);
    }
    expect([...perGroup.values()].filter((n) => n > 1)).toEqual([2]);
    expect(perGroup.size).toBe(47);

    await db.close();
  });

  it("costUsd agrees with the audit-row count within the 1% bar, whistle counted", async () => {
    const db = new SqliteDb(":memory:");
    await ingestJob(db);
    const rows = await db.decideAuditsForJob(JOB);
    // The meter bills `decideFee * decideCalls`; the ledger is `rows * fee`.
    const decideCalls = 48;
    const meteredCostUsd = Number((FEE * decideCalls).toFixed(4)); // 0.1584
    const auditedCostUsd = rows.length * FEE;
    expect(Math.abs(auditedCostUsd - meteredCostUsd) / meteredCostUsd).toBeLessThanOrEqual(0.01);

    // AC2: the whistle decide is COUNTED as audited — its row carries the Stage-B
    // family, so `whistleDecides` has a replayable prompt/verdict row.
    const whistleRows = rows.filter((r) => (r.params as any)?.triggerFamily === "stageB");
    expect(whistleRows).toHaveLength(1);
    expect(whistleRows[0].promptText).toContain("whistle");
    expect(whistleRows[0].replayable).toBe(true);

    await db.close();
  });

  it("stores the decide service's own prompt text byte-for-byte (no prompt change)", async () => {
    const db = new SqliteDb(":memory:");
    const { prompts } = await ingestJob(db);
    const rows = await db.decideAuditsForJob(JOB);
    const stored = rows.map((r) => r.promptText).sort();
    expect(stored).toEqual([...prompts].sort());
    // Token parity is a prompt-text identity, not a length approximation: the
    // ingest path must not rewrite, trim or re-render what the decide modelled.
    expect(stored.join("")).toHaveLength(prompts.join("").length);

    await db.close();
  });

  it("labels a third billed call of the same group instead of overwriting", async () => {
    const db = new SqliteDb(":memory:");
    await recordDecideAudit(db, descriptor("g7", 0), 0);
    await recordDecideAudit(db, descriptor("g7", 1), 0);
    await recordDecideAudit(db, descriptor("g7", 2), 0);
    const rows = await db.decideAuditsForJob(JOB);
    expect(rows.map((r) => r.groupKey).sort()).toEqual(["g7", "g7:call2", "g7:call3"]);
    expect(rows.filter((r) => (r.params as any)?.auditOrdinal === 2)).toHaveLength(1);
    expect(rows.filter((r) => (r.params as any)?.auditOrdinal === 3)).toHaveLength(1);
    await db.close();
  });

  it("keeps the extra rows inside the webapp's group-key grammar (in-video time renders)", () => {
    // webapp/src/lib/decideAudit.ts `decideGroupKeySeconds` decodes
    // `^g(\d+)(?::([a-z0-9_-]+))?$`; a `:callN` slot must stay decodable.
    const grammar = /^g(\d+)(?::([a-z0-9_-]+))?$/i;
    expect(decideAuditGroupSlot("g59", 1)).toBe("g59");
    expect(decideAuditGroupSlot("g59", 2)).toBe("g59:call2");
    expect(grammar.exec(decideAuditGroupSlot("g59", 2))?.[1]).toBe("59");
  });

  it("still bounds storage with the retention cap across extra rows", async () => {
    const db = new SqliteDb(":memory:");
    // Retention 2 keeps the two newest rows: the canonical g7 row and its extra.
    await recordDecideAudit(db, descriptor("g7", 0), 2);
    await recordDecideAudit(db, descriptor("g7", 1), 2);
    expect((await db.listDecideAudits()).map((r) => r.groupKey).sort()).toEqual(["g7", "g7:call2"]);
    await recordDecideAudit(db, descriptor("g8", 2), 2);
    const rows = await db.listDecideAudits();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.groupKey).sort()).toEqual(["g7:call2", "g8"]);
    await db.close();
  });
});
