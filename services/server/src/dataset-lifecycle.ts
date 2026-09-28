// Dataset retention lifecycle (ADAAAA-5391 C4, ADAAAA-5398).
//
// A persisted fine-tune dataset (inline `Dataset` record + `purging_at` column
// in the server DB, ADAAAA-5396/5397) is retained + retrievable while the
// account is an ACTIVE NON-STARTER subscriber. When a paid plan is deactivated
// (downgrade/cancel), the account's datasets are scheduled for purge after a
// 30-day grace window: `purging_at = deactivation + 30d`. The retention purge
// sweep (scheduled in index.ts, like the rejected-clip TTL sweep) then
// permanently removes the DB row + stored frame images once `purging_at`
// elapses, and appends a row to the dataset_purge_log so QA can observe the
// deletion ran (the run/purge log). Nothing is manual.
//
// Retrieval denial itself is independent of data GC: the access gate here
// denies retrieval the moment the account leaves the active-non-starter plan
// (immediately at deactivation), regardless of the 30-day grace window.
import path from "node:path";
import { rm } from "node:fs/promises";
import type { Db, DatasetRecord, Subscription } from "./db";
import type { ServerConfig } from "./config";

/** 30-day grace window between plan deactivation and dataset purge. */
export const PURGE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/** Thrown when a dataset retrieval is not allowed (maps to HTTP 403/404 by the
 * route). The single gate every dataset read path checks. */
export class DatasetAccessError extends Error {
  readonly statusCode = 403;
  constructor(message = "dataset access requires an active non-starter plan") {
    super(message);
    this.name = "DatasetAccessError";
  }
}

/** The retrieval plan-gate (C3): datasets are only accessible while the account
 * is an ACTIVE (or trialing) non-starter ("pro") subscriber. Any deactivation —
 * free/starter, canceled, past_due — immediately denies access, independent of
 * the 30-day data GC. */
export function datasetAccessActive(sub: Subscription | null | undefined): boolean {
  return Boolean(
    sub &&
      sub.tier === "pro" &&
      (sub.status === "active" || sub.status === "trialing")
  );
}

export interface DatasetPurgeReport {
  candidates: number;
  datasetsPurged: number;
  objectsRemoved: number;
  bytesReclaimed: number;
  dryRun: boolean;
}

/** Schedule every dataset owned by `ownerId` for purge at `deactivation + 30d`.
 * Idempotent — repeated calls re-anchor the window at the same deactivation
 * date bound to this call's `now`. Returns the count of datasets scheduled. */
export async function scheduleDatasetsPurgeForOwner(
  db: Db,
  ownerId: string,
  now: Date = new Date()
): Promise<number> {
  const purgingAt = new Date(now.getTime() + PURGE_GRACE_MS).toISOString();
  const owned = await db.listDatasets(ownerId);
  for (const d of owned) {
    await db.setDatasetPurgingAt(d.id, purgingAt);
  }
  return owned.length;
}

/** Datasets whose purge window has elapsed: `purging_at` is non-null AND <= now.
 * No other state is ever a candidate (an active-non-starter dataset with a null
 * purging_at is never purged). */
export async function selectPurgeCandidates(
  db: Db,
  now: Date = new Date()
): Promise<DatasetRecord[]> {
  const t = now.getTime();
  const all = await db.listDatasets();
  return all.filter(
    (d) => d.purgingAt != null && !Number.isNaN(Date.parse(d.purgingAt)) && Date.parse(d.purgingAt) <= t
  );
}

/** Absolute on-disk storage paths owned by a dataset (removed on purge). The
 * inline `Dataset` model (ADAAAA-5396/5397) persists only its flattened
 * imageRefs; the actual frame bytes live under
 * `dataDir/training/extract/<imageRef>` (the same root the curation and zip
 * paths read from). We map each unique, traversal-safe imageRef to its
 * absolute path. */
export function datasetStoragePaths(cfg: ServerConfig, d: DatasetRecord): string[] {
  const refs = d.imageRefs ?? [];
  const root = path.resolve(path.join(cfg.dataDir, "training", "extract"));
  const out = new Map<string, string>();
  for (const ref of refs) {
    const parts = ref.split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0 || parts.some((p) => p === "..")) continue;
    const abs = path.join(root, ...parts);
    if (!abs.startsWith(root + path.sep)) continue;
    out.set(abs, abs);
  }
  return [...out.values()];
}

/** Run one 30-day retention purge sweep. `dryRun` only enumerates candidates
 * and reports (deletes nothing). Run mode removes the storage images + DB row
 * for every due candidate and appends one dataset_purge_log entry per purge so
 * QA can observe the deletion (the run/purge log). */
export async function runDatasetPurgeSweep(
  db: Db,
  cfg: ServerConfig,
  opts: { now?: Date; dryRun?: boolean; onError?: (id: string, e: unknown) => void } = {}
): Promise<DatasetPurgeReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const candidates = await selectPurgeCandidates(db, now);
  const report: DatasetPurgeReport = {
    candidates: candidates.length,
    datasetsPurged: 0,
    objectsRemoved: 0,
    bytesReclaimed: 0,
    dryRun,
  };
  if (dryRun) return report;

  for (const cand of candidates) {
    // Re-check the live record right before deleting: a concurrent restore
    // (purge cleared / plan re-activated) drops the dataset out of the durable
    // candidate set and cancels deletion.
    const live = await db.getDataset(cand.id);
    if (!live || live.purgingAt == null || Date.parse(live.purgingAt) > now.getTime()) continue;

    const removed: string[] = [];
    let bytes = 0;
    try {
      for (const p of datasetStoragePaths(cfg, live)) {
        try {
          const { stat } = await import("node:fs/promises");
          const st = await stat(p);
          bytes += st.size;
        } catch {
          bytes += 0; // object already gone — nothing to reclaim
        }
        await rm(p, { recursive: true, force: true });
        removed.push(p);
      }
      report.objectsRemoved += removed.length;
      report.bytesReclaimed += bytes;

      await db.deleteDataset(cand.id);
      report.datasetsPurged += 1;

      await db.appendDatasetPurgeLog({
        datasetId: cand.id,
        ownerId: cand.ownerId,
        reason: "plan_deactivated_30d",
        objectsRemoved: removed,
        dryRun: false,
      });
    } catch (e) {
      opts.onError?.(cand.id, e);
      // Leave the dataset in place on failure so the next sweep retries; a
      // partially-deleted object set is reclaimed by the next run (rm is
      // force/idempotent) rather than leaving a dangling row.
    }
  }
  return report;
}
