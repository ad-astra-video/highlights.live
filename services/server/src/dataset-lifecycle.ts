// Dataset retention lifecycle (ADAAAA-5391 C4, ADAAAA-5398).
//
// A persisted fine-tune dataset (DatasetRecord) is retained + retrievable while
// the account is an ACTIVE NON-STARTER subscriber. When a paid plan is
// deactivated (downgrade/cancel), the account's datasets are scheduled for
// purge after a 30-day grace window: `purgingAt = deactivation + 30d`. The
// retention purge sweep (scheduled below, like the rejected-clip TTL sweep)
// then permanently removes the DB row + stored objects once `purgingAt`
// elapses, and appends a row to the dataset_purge_log so QA can observe the
// deletion ran (the run/purge log). Nothing is manual.
//
// Retrieval denial itself is independent of data GC: the access gate here
// denies retrieval the moment the account leaves the active-non-starter plan
// (immediately at deactivation), regardless of the 30-day grace window.
import path from "node:path";
import { rm } from "node:fs/promises";
import type { Store } from "./store";
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
  store: Store,
  ownerId: string,
  now: Date = new Date()
): Promise<number> {
  const purgingAt = new Date(now.getTime() + PURGE_GRACE_MS).toISOString();
  const owned = store.allDatasets(ownerId);
  for (const d of owned) {
    await store.scheduleDatasetPurge(d.id, purgingAt);
  }
  return owned.length;
}

/** Datasets whose purge window has elapsed: `purgingAt` is non-null AND <= now.
 * No other state is ever a candidate (an active-non-starter dataset with a null
 * purgingAt is never purged). */
export function selectPurgeCandidates(
  store: Store,
  now: Date = new Date()
): DatasetRecord[] {
  const t = now.getTime();
  return store
    .allDatasets()
    .filter((d) => d.purgingAt != null && !Number.isNaN(Date.parse(d.purgingAt)) && Date.parse(d.purgingAt) <= t);
}

/** Absolute on-disk storage paths owned by a dataset (removed on purge). The
 * extracted frame bucket under `dataDir/training/extract/<bucket>` and the
 * per-dataset manifests directory under `dataDir/training/datasets/<id>`. */
export function datasetStoragePaths(cfg: ServerConfig, d: DatasetRecord): string[] {
  const out: string[] = [];
  if (d.bucket) out.push(path.join(cfg.dataDir, "training", "extract", path.basename(d.bucket)));
  out.push(path.join(cfg.dataDir, "training", "datasets", d.id));
  return out;
}

/** Run one 30-day retention purge sweep. `dryRun` only enumerates candidates
 * and reports (deletes nothing). Run mode removes the storage objects + DB row
 * for every due candidate and appends one dataset_purge_log entry per purge so
 * QA can observe the deletion (the run/purge log). */
export async function runDatasetPurgeSweep(
  store: Store,
  db: Db,
  cfg: ServerConfig,
  opts: { now?: Date; dryRun?: boolean; onError?: (id: string, e: unknown) => void } = {}
): Promise<DatasetPurgeReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const candidates = selectPurgeCandidates(store, now);
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
    const live = store.getDataset(cand.id);
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

      const purged = await store.deleteDataset(cand.id);
      if (purged) report.datasetsPurged += 1;

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
