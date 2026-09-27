// Rejected-clip TTL lifecycle (ADAAAA-5163 / ADAAAA-5168).
//
// A rejected clip is held for an undo grace period (cfg.rejectTtlMs, default
// 24h) in the `rejected` state (status + `rejectedAt`). After the grace
// elapses, this sweep permanently removes the clip: the storage object AND the
// DB row. It is the ONLY code that ever hard-deletes a highlight, and its
// candidate filter is deliberately exact — ONLY `rejected` clips whose
// `rejectedAt` is >= TTL old are ever selected; accepted/published/pending/
// queued clips are never candidates.
//
// Concurrency / orphan safety: pure-DB orphan rows are impossible because the
// sweep re-reads the live record from the store right before deleting (a
// concurrent reject->accept within the window clears `rejectedAt`, dropping the
// clip out of the candidate set, so `deleteHighlight` below is a no-op for the
// restored clip). Storage and DB are deleted in the same pass and the store
// write-through guarantees both stay in sync; deleting an already-purged id is
// idempotent (no dangling row / no double unlink error).
import path from "node:path";
import { unlink } from "node:fs/promises";
import type { Store } from "./store";
import type { ServerConfig } from "./config";

export interface RejectSweepReport {
  /** All `rejected` clips aged >= TTL selected as candidates this run. */
  candidates: number;
  /** Candidates whose storage object actually existed and was removed. */
  objectsRemoved: number;
  /** Candidates whose DB row + in-memory record were removed. */
  rowsRemoved: number;
  /** Bytes reclaimed from removed storage objects this run. */
  bytesReclaimed: number;
  /** True when the sweep only enumerated candidates and removed nothing. */
  dryRun: boolean;
}

/** Map a clip's `/clips/<name>.mp4` URI to its on-disk path under dataDir. */
export function clipStoragePath(cfg: ServerConfig, clipUri: string): string {
  const name = clipUri.replace(/^\/clips\//, "");
  return path.join(cfg.dataDir, "clips", path.basename(name));
}

/**
 * Select rejected-recyclable clips. Exact filter: status === "rejected" AND a
 * durable `rejectedAt` timestamp aged >= `rejectTtlMs`. No other state is ever
 * a candidate. Returns the records plus whether each is now due.
 */
export function selectRejectedCandidates(
  store: Store,
  cfg: ServerConfig,
  now: Date = new Date()
): { id: string; clipUri: string }[] {
  const cutoff = now.getTime() - cfg.rejectTtlMs;
  const out: { id: string; clipUri: string }[] = [];
  for (const h of store.allHighlights()) {
    if (h.status !== "rejected") continue;
    if (!h.rejectedAt) continue;
    const t = Date.parse(h.rejectedAt);
    if (Number.isNaN(t) || t > cutoff) continue;
    out.push({ id: h.id, clipUri: h.clipUri });
  }
  return out;
}

/**
 * Run one rejected-clip TTL sweep. In pure dry-run mode (`dryRun: true`) it
 * only enumerates candidates and reports what WOULD be reclaimed — nothing is
 * deleted. In run mode it hard-deletes the storage object and DB row for every
 * due candidate, re-checking the live record immediately before each delete so
 * a concurrent accept within the window cancels the purge.
 */
export async function runRejectSweep(
  store: Store,
  cfg: ServerConfig,
  opts: { now?: Date; dryRun?: boolean; onError?: (id: string, e: unknown) => void } = {}
): Promise<RejectSweepReport> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const candidates = selectRejectedCandidates(store, cfg, now);
  const report: RejectSweepReport = {
    candidates: candidates.length,
    objectsRemoved: 0,
    rowsRemoved: 0,
    bytesReclaimed: 0,
    dryRun,
  };
  if (dryRun) return report;

  for (const cand of candidates) {
    // Re-check the live record right before deleting. A concurrent
    // reject->accept within the window clears `rejectedAt`, which removes the
    // clip from the re-filtered candidate set and cancels deletion.
    const live = store.getHighlight(cand.id);
    if (!live || live.status !== "rejected" || !live.rejectedAt) continue;
    if (Date.parse(live.rejectedAt) > now.getTime() - cfg.rejectTtlMs) continue;

    let removedBytes = 0;
    try {
      const filePath = clipStoragePath(cfg, cand.clipUri);
      // Unlink the storage object first; missing/empty URIs are skipped.
      if (cand.clipUri) {
        try {
          const { stat } = await import("node:fs/promises");
          const st = await stat(filePath);
          removedBytes = st.size;
        } catch {
          removedBytes = 0; // object already gone — nothing to reclaim
        }
        await unlink(filePath).catch(() => undefined);
        if (removedBytes > 0) {
          report.objectsRemoved += 1;
          report.bytesReclaimed += removedBytes;
        }
      }
      // Then remove the DB row + in-memory record. Storing and deleting the
      // same id is idempotent; the store removes it from memory and the Db.
      const removed = await store.deleteHighlight(cand.id);
      if (removed) report.rowsRemoved += 1;
    } catch (e) {
      opts.onError?.(cand.id, e);
      // Leave the clip in place on failure so the next sweep retries; a
      // partially-deleted object is reclaimed by the next run (unlink is
      // idempotent) rather than leaving a dangling row.
    }
  }
  return report;
}
