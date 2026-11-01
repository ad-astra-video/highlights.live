// Media process lifecycle ledger (ADAAAA-7656).
//
// `restart: unless-stopped` on the media service is what keeps the live rail
// alive when the process exits, but it also turns a PERSISTENT fault into a
// restart loop that looks "up" from the outside: the container is running most
// of the time and `/health` answers 200 between attempts. This ledger exists so
// `/health` can tell an operator (and the hourly box-health routine)
// "recovered once" from "flapping every 30 s".
//
// Where the numbers come from:
//   - `boots` / `bootAt` are written on EVERY process start, so a policy restart
//     always increments them.
//   - `lastExit` is written by the exit + signal handlers in `index.ts`:
//     a clean exit or an uncaught exception carries its code, `SIGTERM`/`SIGINT`
//     (docker stop) is recorded as a signalled exit.
//   - SIGKILL and the kernel OOM killer run NO handler at all. The next boot
//     sees that the previous boot never recorded an exit and records
//     `reason: "unobserved-exit"` with a null code instead of inventing one.
//
// Persistence is a small JSON file under `MEDIA_STATE_DIR` (default: the OS tmp
// dir). It survives a process restart — the case that matters for a crash loop —
// and resets on a container recreate, which is a deploy and should reset it.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ExitInfo = {
  /** wall clock of the recorded exit */
  at: number;
  /** exit code when the process observed its own exit; null when it never did */
  code: number | null;
  /** terminating signal, when the exit came from one that a handler can see */
  signal: string | null;
  reason: "exit" | "signal" | "unobserved-exit";
};

export type LifecycleLedger = {
  /** process starts observed on this container (1 = first boot) */
  boots: number;
  /** start timestamps of recent boots, oldest first */
  bootAt: number[];
  /** start timestamp of the previous boot (used to detect an unobserved exit) */
  lastBootAt: number | null;
  lastExit: ExitInfo | null;
};

export type LifecycleSnapshot = {
  boots: number;
  lastStartAt: string | null;
  lastExit: { at: string; code: number | null; signal: string | null; reason: string } | null;
  windowS: number;
  threshold: number;
  bootsInWindow: number;
  /** true when the node restarted `threshold` or more times inside `windowS` */
  degraded: boolean;
};

const LEDGER_FILE = "highlights-media-lifecycle.json";
const MAX_BOOT_HISTORY = 200;

const emptyLedger = (): LifecycleLedger => ({ boots: 0, bootAt: [], lastBootAt: null, lastExit: null });

export function ledgerPath(dir: string = process.env.MEDIA_STATE_DIR || os.tmpdir()): string {
  return path.join(dir, LEDGER_FILE);
}

/** Read the ledger; a missing/corrupt file is a first boot, never a crash. */
export function loadLedger(dir?: string): LifecycleLedger {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(dir), "utf8"));
    if (!raw || typeof raw.boots !== "number" || !Array.isArray(raw.bootAt)) return emptyLedger();
    return {
      boots: raw.boots,
      bootAt: raw.bootAt.filter((t: unknown) => typeof t === "number"),
      lastBootAt: typeof raw.lastBootAt === "number" ? raw.lastBootAt : null,
      lastExit: raw.lastExit ?? null,
    };
  } catch {
    return emptyLedger();
  }
}

/**
 * Record this process start. If the previous boot never wrote an exit, the
 * process died in a way node cannot observe (SIGKILL / OOM) — record that
 * explicitly so `/health` shows the gap instead of implying a clean recovery.
 */
export function recordBoot(ledger: LifecycleLedger, now: number = Date.now()): LifecycleLedger {
  const previous = ledger.lastBootAt;
  const exitAt = ledger.lastExit?.at ?? 0;
  if (previous !== null && exitAt < previous) {
    ledger.lastExit = { at: previous, code: null, signal: null, reason: "unobserved-exit" };
  }
  ledger.boots += 1;
  ledger.bootAt.push(now);
  if (ledger.bootAt.length > MAX_BOOT_HISTORY) ledger.bootAt = ledger.bootAt.slice(-MAX_BOOT_HISTORY);
  ledger.lastBootAt = now;
  return ledger;
}

/** Record an exit this process can see (clean exit, uncaught exception, signal). */
export function recordExit(ledger: LifecycleLedger, exit: Omit<ExitInfo, "at"> & { at?: number }): LifecycleLedger {
  ledger.lastExit = { at: exit.at ?? Date.now(), code: exit.code ?? null, signal: exit.signal ?? null, reason: exit.reason };
  return ledger;
}

/** Persist atomically (tmp + rename) so a kill mid-write cannot corrupt it. */
export function saveLedger(ledger: LifecycleLedger, dir?: string): void {
  try {
    const target = ledgerPath(dir);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger));
    renameSync(tmp, target);
  } catch {
    // The ledger is diagnostics: never let a read-only FS or a full tmp break
    // the media process's actual job.
  }
}

/**
 * Flapping view of the ledger: how many boots landed inside the window, and
 * whether that crosses the threshold that should turn `/health` from green to
 * degraded. `boots` itself never resets, so a single recovery still reads as
 * one restart forever; only `bootsInWindow` decides the verdict.
 */
export function snapshot(
  ledger: LifecycleLedger,
  opts: { now?: number; windowS?: number; threshold?: number } = {},
): LifecycleSnapshot {
  const now = opts.now ?? Date.now();
  const windowS = opts.windowS ?? 600;
  const threshold = opts.threshold ?? 3;
  const from = now - windowS * 1000;
  const bootsInWindow = ledger.bootAt.filter((t) => t >= from && t <= now).length;
  return {
    boots: ledger.boots,
    lastStartAt: ledger.lastBootAt === null ? null : new Date(ledger.lastBootAt).toISOString(),
    lastExit:
      ledger.lastExit === null
        ? null
        : {
            at: new Date(ledger.lastExit.at).toISOString(),
            code: ledger.lastExit.code,
            signal: ledger.lastExit.signal,
            reason: ledger.lastExit.reason,
          },
    windowS,
    threshold,
    bootsInWindow,
    degraded: bootsInWindow >= threshold,
  };
}
