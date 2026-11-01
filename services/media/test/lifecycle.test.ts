import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ledgerPath, loadLedger, recordBoot, recordExit, saveLedger, snapshot } from "../src/lifecycle";

// ADAAAA-7656: `restart: unless-stopped` on highlights-media recovers a crash
// without the hourly health tick. That only stays honest if the node publishes
// enough state for an operator to tell "recovered once" from "flapping". These
// tests pin the ledger semantics: boots always accumulate, an exit node could
// not observe (SIGKILL / OOM) is recorded as such rather than guessed, and the
// degraded verdict is window-based.

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), "hl-lifecycle-"));

describe("media lifecycle ledger (ADAAAA-7656)", () => {
  it("treats a missing ledger as a first boot instead of throwing", () => {
    const dir = tmpDir();
    expect(loadLedger(dir)).toMatchObject({ boots: 0, bootAt: [], lastBootAt: null, lastExit: null, bootHistory: [] });
  });

  it("survives a corrupt ledger file", () => {
    const dir = tmpDir();
    writeFileSync(ledgerPath(dir), "{ this is not json");
    expect(loadLedger(dir).boots).toBe(0);
  });

  it("counts boots and round-trips through disk (a restart keeps the count)", () => {
    const dir = tmpDir();
    const ledger = recordBoot(loadLedger(dir), 1_000);
    saveLedger(ledger, dir);
    expect(loadLedger(dir).boots).toBe(1);

    const again = recordBoot(loadLedger(dir), 2_000);
    saveLedger(again, dir);
    expect(loadLedger(dir).boots).toBe(2);
    expect(loadLedger(dir).bootAt).toEqual([1_000, 2_000]);
  });

  it("records an unobserved exit for a boot that never wrote one (SIGKILL / OOM)", () => {
    const dir = tmpDir();
    // boot 1 records nothing on exit -> the process was killed hard
    saveLedger(recordBoot(loadLedger(dir), 1_000), dir);
    const second = recordBoot(loadLedger(dir), 5_000);
    expect(second.boots).toBe(2);
    expect(second.lastExit).toEqual({ at: 1_000, code: null, signal: null, reason: "unobserved-exit" });
  });

  it("keeps the exit code a boot DID record (clean exit / uncaught exception)", () => {
    const dir = tmpDir();
    let ledger = recordBoot(loadLedger(dir), 1_000);
    ledger = recordExit(ledger, { code: 1, signal: null, reason: "exit", at: 1_500 });
    saveLedger(ledger, dir);
    expect(loadLedger(dir).lastExit).toMatchObject({ code: 1, reason: "exit" });

    const third = recordBoot(loadLedger(dir), 9_000);
    expect(third.boots).toBe(2);
    expect(third.lastExit).toMatchObject({ code: 1, reason: "exit" });
  });

  it("records a signalled exit (docker stop -> SIGTERM) as clean", () => {
    const dir = tmpDir();
    const ledger = recordExit(recordBoot(loadLedger(dir), 1_000), { code: 0, signal: "SIGTERM", reason: "signal" });
    expect(snapshot(ledger).lastExit).toMatchObject({ code: 0, signal: "SIGTERM", reason: "signal" });
  });

  it("does not let node's exit event clobber a signalled exit from the same boot", () => {
    // SIGTERM handler records the signal, then process.exit(0) fires 'exit' with
    // signal:null — the richer record must survive.
    let ledger = recordBoot(loadLedger(tmpDir()), 1_000);
    ledger = recordExit(ledger, { code: 0, signal: "SIGTERM", reason: "signal", at: 1_500 });
    ledger = recordExit(ledger, { code: 0, signal: null, reason: "exit", at: 1_501 });
    expect(ledger.lastExit).toMatchObject({ code: 0, signal: "SIGTERM", reason: "signal" });
  });

  it("flips to degraded only when boots cluster inside the window", () => {
    const dir = tmpDir();
    let ledger = loadLedger(dir);
    for (const t of [0, 30_000, 60_000]) ledger = recordBoot(ledger, t);
    const flapping = snapshot(ledger, { now: 70_000, windowS: 600, threshold: 3 });
    expect(flapping.boots).toBe(3);
    expect(flapping.bootsInWindow).toBe(3);
    expect(flapping.degraded).toBe(true);

    // one old recovery: cumulative boots stay, the verdict goes back to healthy
    const single = snapshot(ledger, { now: 20 * 60_000, windowS: 600, threshold: 3 });
    expect(single.boots).toBe(3);
    expect(single.bootsInWindow).toBe(0);
    expect(single.degraded).toBe(false);

    // window boundary: only the boots inside it count
    const partial = snapshot(ledger, { now: 90_000, windowS: 75, threshold: 3 });
    expect(partial.bootsInWindow).toBe(2);
    expect(partial.degraded).toBe(false);
  });

  it("exposes the last restart timestamp in ISO form", () => {
    const ledger = recordBoot(loadLedger(tmpDir()), Date.parse("2026-11-01T13:53:26.964Z"));
    expect(snapshot(ledger).lastStartAt).toBe("2026-11-01T13:53:26.964Z");
    expect(snapshot(loadLedger(tmpDir())).lastStartAt).toBeNull();
  });
});

// ADAAAA-7689 AC4: from the edge, two boots inside an hour were indistinguishable
// from a deploy — `/health` carried no boot identity and no image revision, so a
// restart could not be attributed without box shell access. These tests pin the
// attribution the ledger now publishes.
describe("media boot attribution (ADAAAA-7689)", () => {
  it("records a boot id and the running build revision per boot", () => {
    const dir = tmpDir();
    const ledger = recordBoot(loadLedger(dir), { now: 1_000, bootId: "boot-1", buildRef: "abc1234" });
    saveLedger(ledger, dir);
    const snap = snapshot(loadLedger(dir));
    expect(snap).toMatchObject({ bootId: "boot-1", buildRef: "abc1234", restartCause: "first-boot" });
    // A first boot has no previous boot to compare against.
    expect(snap.previousBoot).toBeNull();
  });

  it("generates a distinct boot id when the caller does not supply one", () => {
    let ledger = recordBoot(loadLedger(tmpDir()), 1_000);
    ledger = recordBoot(ledger, 2_000);
    const ids = ledger.bootHistory.map((b) => b.bootId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0].length).toBeGreaterThan(8);
  });

  it("attributes a boot to a DEPLOY when the revision changed", () => {
    let ledger = recordBoot(loadLedger(tmpDir()), { now: 1_000, bootId: "b1", buildRef: "abc1234" });
    ledger = recordBoot(ledger, { now: 60_000, bootId: "b2", buildRef: "def5678" });
    const snap = snapshot(ledger);
    expect(snap.bootId).toBe("b2");
    expect(snap.buildRef).toBe("def5678");
    expect(snap.restartCause).toBe("deploy");
    expect(snap.previousBoot).toMatchObject({ bootId: "b1", buildRef: "abc1234" });
  });

  it("attributes a boot to a CRASH when the revision is unchanged and the exit was unobserved", () => {
    let ledger = recordBoot(loadLedger(tmpDir()), { now: 1_000, bootId: "b1", buildRef: "abc1234" });
    ledger = recordBoot(ledger, { now: 60_000, bootId: "b2", buildRef: "abc1234" });
    const snap = snapshot(ledger);
    expect(snap.restartCause).toBe("crash");
    // AC4: a restart a reader can attribute always carries a non-null reason.
    expect(snap.lastExit?.reason).toBe("unobserved-exit");
    expect(snap.previousBoot?.exit?.reason).toBe("unobserved-exit");
  });

  it("attributes a boot to a plain RESTART when the exit was observed (docker stop)", () => {
    let ledger = recordBoot(loadLedger(tmpDir()), { now: 1_000, bootId: "b1", buildRef: "abc1234" });
    ledger = recordExit(ledger, { code: 0, signal: "SIGTERM", reason: "signal", at: 2_000 });
    ledger = recordBoot(ledger, { now: 60_000, bootId: "b2", buildRef: "abc1234" });
    const snap = snapshot(ledger);
    expect(snap.restartCause).toBe("restart");
    expect(snap.lastExit).toMatchObject({ code: 0, signal: "SIGTERM", reason: "signal" });
  });

  it("reads a pre-7689 ledger (no boot history) without inventing a revision", () => {
    const dir = tmpDir();
    writeFileSync(
      ledgerPath(dir),
      JSON.stringify({ boots: 3, bootAt: [1_000, 2_000, 3_000], lastBootAt: 3_000, lastExit: null }),
    );
    const loaded = loadLedger(dir);
    expect(loaded.boots).toBe(3);
    expect(loaded.bootHistory).toEqual([]);
    const snap = snapshot(loaded);
    expect(snap.boots).toBe(3);
    expect(snap.bootId).toBeNull();
    expect(snap.buildRef).toBeNull();
    expect(snap.restartCause).toBe("first-boot");
  });
});
