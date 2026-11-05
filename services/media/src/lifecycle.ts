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
// dir). It survives a process restart — the case that matters for a crash loop.
// The default tmp dir is container-local, so a recreate (a deploy) also wipes
// it; the compose service points MEDIA_STATE_DIR at a mounted volume so boots
// and their revisions survive a deploy too, which is what makes `buildRef`
// comparable across a restart (ADAAAA-7689 AC4).

import { randomUUID } from "node:crypto";
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

export type BootRecord = {
  /** boot timestamp (ms) */
  at: number;
  /** identifier of THIS process boot (ADAAAA-7689 AC4) */
  bootId: string;
  /** image revision the booted code came from (`unknown` when not injected) */
  buildRef: string;
  /**
   * sha256 over the served media source tree (every .ts under
   * services/media/src, recursively; ADAAAA-8048), recorded
   * per boot so the served revision is provable from `/health` even when the
   * recreate bypassed `docker/deploy.sh` and `buildRef` stayed `unknown`.
   */
  sourceDigest: string | null;
  /** number of served files folded into `sourceDigest` */
  sourceFiles: number;
};

export type ExitInfoIso = { at: string; code: number | null; signal: string | null; reason: string };

export type LifecycleLedger = {
  /** process starts observed on this container (1 = first boot) */
  boots: number;
  /** start timestamps of recent boots, oldest first */
  bootAt: number[];
  /** start timestamp of the previous boot (used to detect an unobserved exit) */
  lastBootAt: number | null;
  lastExit: ExitInfo | null;
  /**
   * Per-boot identity, oldest first (ADAAAA-7689 AC4). `bootAt` alone can say
   * THAT a process restarted; the build reference is what lets a reader tell a
   * deploy (the revision changed) from a crash (same revision, unobserved exit)
   * without box shell access.
   */
  bootHistory: BootRecord[];
};

/**
 * Why the current boot started. This is the attribution AC4 asks for:
 *
 *   - `first-boot`  no previous boot in the ledger (fresh container / wiped state)
 *   - `deploy`      the running revision differs from the previous boot's
 *   - `crash`       same revision and the previous process never recorded an exit
 *                   (SIGKILL / OOM — node cannot observe those)
 *   - `restart`     same revision and the previous process exited observably
 *                   (clean exit, uncaught exception, or a SIGTERM stop)
 */
export type RestartCause = "first-boot" | "deploy" | "crash" | "restart";

export type LifecycleSnapshot = {
  boots: number;
  /** identifier of the currently running boot */
  bootId: string | null;
  /** revision of the running image (`unknown` when the build did not inject one) */
  buildRef: string | null;
  /** sha256 of the served media source (ADAAAA-8048); deploy-path independent */
  sourceDigest: string | null;
  /** served files folded into `sourceDigest` */
  sourceFiles: number;
  lastStartAt: string | null;
  lastExit: ExitInfoIso | null;
  /** The boot before this one, with the revision it ran (null on a first boot). */
  previousBoot: (BootRecord & { atIso: string; exit: ExitInfoIso | null }) | null;
  /** Attribution of the current boot: deploy vs crash vs plain restart. */
  restartCause: RestartCause;
  windowS: number;
  threshold: number;
  bootsInWindow: number;
  /** true when the node restarted `threshold` or more times inside `windowS` */
  degraded: boolean;
};

const LEDGER_FILE = "highlights-media-lifecycle.json";
const MAX_BOOT_HISTORY = 200;

const emptyLedger = (): LifecycleLedger => ({
  boots: 0,
  bootAt: [],
  lastBootAt: null,
  lastExit: null,
  bootHistory: [],
});

export function ledgerPath(dir: string = process.env.MEDIA_STATE_DIR || os.tmpdir()): string {
  return path.join(dir, LEDGER_FILE);
}

/** Read the ledger; a missing/corrupt file is a first boot, never a crash. */
export function loadLedger(dir?: string): LifecycleLedger {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(dir), "utf8"));
    if (!raw || typeof raw.boots !== "number" || !Array.isArray(raw.bootAt)) return emptyLedger();
    const bootAt = raw.bootAt.filter((t: unknown) => typeof t === "number");
    // A ledger written by a pre-7689 build has no bootHistory: keep the boot
    // count/window semantics and leave the per-boot identity empty rather than
    // inventing a revision that was never recorded.
    const bootHistory: BootRecord[] = Array.isArray(raw.bootHistory)
      ? raw.bootHistory
          .filter((b: any) => b && typeof b.at === "number")
          .map((b: any) => ({
            at: b.at,
            bootId: typeof b.bootId === "string" ? b.bootId : "",
            buildRef: typeof b.buildRef === "string" ? b.buildRef : "unknown",
            // A boot recorded before ADAAAA-8048 has no digest: null (not a
            // guessed value), same rule as the pre-7689 buildRef fallback.
            sourceDigest: typeof b.sourceDigest === "string" ? b.sourceDigest : null,
            sourceFiles: typeof b.sourceFiles === "number" ? b.sourceFiles : 0,
          }))
      : [];
    return {
      boots: raw.boots,
      bootAt,
      lastBootAt: typeof raw.lastBootAt === "number" ? raw.lastBootAt : null,
      lastExit: raw.lastExit ?? null,
      bootHistory,
    };
  } catch {
    return emptyLedger();
  }
}

export type BootOptions = {
  /** boot timestamp (ms); defaults to now */
  now?: number;
  /** explicit boot id; generated when omitted */
  bootId?: string;
  /** image revision this process booted from (`unknown` when not injected) */
  buildRef?: string;
  /** sha256 of the served media source (ADAAAA-8048) */
  sourceDigest?: string | null;
  /** served files folded into `sourceDigest` */
  sourceFiles?: number;
};

const asBootOptions = (v: number | BootOptions | undefined): BootOptions =>
  typeof v === "number" ? { now: v } : v ?? {};

/**
 * Record this process start. If the previous boot never wrote an exit, the
 * process died in a way node cannot observe (SIGKILL / OOM) — record that
 * explicitly so `/health` shows the gap instead of implying a clean recovery.
 */
export function recordBoot(ledger: LifecycleLedger, when?: number | BootOptions): LifecycleLedger {
  const opts = asBootOptions(when);
  const now = opts.now ?? Date.now();
  const previous = ledger.lastBootAt;
  const exitAt = ledger.lastExit?.at ?? 0;
  if (previous !== null && exitAt < previous) {
    ledger.lastExit = { at: previous, code: null, signal: null, reason: "unobserved-exit" };
  }
  ledger.boots += 1;
  ledger.bootAt.push(now);
  if (ledger.bootAt.length > MAX_BOOT_HISTORY) ledger.bootAt = ledger.bootAt.slice(-MAX_BOOT_HISTORY);
  ledger.lastBootAt = now;
  // ADAAAA-7689 AC4: keep a per-boot identity so a reader can attribute the
  // current boot to a deploy or a crash from `/health` alone.
  ledger.bootHistory.push({
    at: now,
    bootId: opts.bootId ?? randomUUID(),
    buildRef: opts.buildRef ?? "unknown",
    sourceDigest: opts.sourceDigest ?? null,
    sourceFiles: opts.sourceFiles ?? 0,
  });
  if (ledger.bootHistory.length > MAX_BOOT_HISTORY) {
    ledger.bootHistory = ledger.bootHistory.slice(-MAX_BOOT_HISTORY);
  }
  return ledger;
}

/** Record an exit this process can see (clean exit, uncaught exception, signal). */
export function recordExit(ledger: LifecycleLedger, exit: Omit<ExitInfo, "at"> & { at?: number }): LifecycleLedger {
  const bootAt = ledger.lastBootAt ?? 0;
  // An exit already recorded for THIS boot wins. The SIGTERM/SIGINT handler runs
  // first and knows the signal; node's `exit` event fires after it (process.exit)
  // with signal:null, and must not clobber the richer record.
  if (ledger.lastExit && ledger.lastExit.at >= bootAt) return ledger;
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
  const lastExit: ExitInfoIso | null =
    ledger.lastExit === null
      ? null
      : {
          at: new Date(ledger.lastExit.at).toISOString(),
          code: ledger.lastExit.code,
          signal: ledger.lastExit.signal,
          reason: ledger.lastExit.reason,
        };
  const current = ledger.bootHistory.length ? ledger.bootHistory[ledger.bootHistory.length - 1] : null;
  const previous =
    ledger.bootHistory.length > 1 ? ledger.bootHistory[ledger.bootHistory.length - 2] : null;
  // ADAAAA-7689 AC4 — attribute this boot from the ledger alone. A revision
  // change is a deploy; the same revision with an exit node never saw is a
  // crash; the same revision with an observed exit is an ordinary restart.
  const restartCause: RestartCause = !previous
    ? "first-boot"
    : previous.buildRef !== (current?.buildRef ?? "unknown")
    ? "deploy"
    : lastExit?.reason === "unobserved-exit"
    ? "crash"
    : "restart";
  return {
    boots: ledger.boots,
    bootId: current?.bootId ?? null,
    buildRef: current?.buildRef ?? null,
    sourceDigest: current?.sourceDigest ?? null,
    sourceFiles: current?.sourceFiles ?? 0,
    lastStartAt: ledger.lastBootAt === null ? null : new Date(ledger.lastBootAt).toISOString(),
    lastExit,
    previousBoot: previous
      ? { ...previous, atIso: new Date(previous.at).toISOString(), exit: lastExit }
      : null,
    restartCause,
    windowS,
    threshold,
    bootsInWindow,
    degraded: bootsInWindow >= threshold,
  };
}
