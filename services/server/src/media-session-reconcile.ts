// Boot-time reconcile for `media_sessions` liveness (ADAAAA-7764).
//
// The durable row is written `status: "active"` at provision and used to be
// cleared on only SOME job-end paths, so the box accumulated rows reading
// `active` while their owning job was already terminal (measured 2026-11-02:
// 13 rows on failed jobs). ADAAAA-7764 hooks the job's terminal transition
// (`Store.patchJob` -> `closeMediaSession`) so no NEW row can go stale; this
// module repairs the rows written BEFORE that hook existed.
//
// It is deliberately:
//   - BOUNDED: at most `maxRows` active rows are inspected per boot.
//   - LOGGED: the caller logs the summary + the settled job ids.
//   - NON-DESTRUCTIVE: rows are settled to `closed`, never deleted, so the
//     `media_sessions.node_id` -> `job.costUsd` attribution join keeps its data.
//   - IDEMPOTENT / safe to re-run: a closed row is skipped, a missing row is a
//     no-op, and running it twice settles nothing the second time.
//
// "Live" is a joint property of the row and its job: a row counts only while
// the job that owns it is still in flight. A row whose job is terminal (or whose
// job row is gone entirely) cannot be a live share.
import type { MediaSession } from "./db";
import { Store } from "./store";
import type { Job } from "@highlights/events";

/** Upper bound on active rows inspected in one boot reconcile. The table holds
 * one row per job (browser shares + live-ingest attribution), so this is a
 * sanity bound on a pathological table, not a working set. */
export const MEDIA_SESSION_RECONCILE_MAX_ROWS = 2000;

export interface MediaSessionReconcileStore {
  listMediaSessions(): Promise<MediaSession[]>;
  closeMediaSession(jobId: string): Promise<boolean>;
}

export interface MediaSessionReconcileResult {
  /** Active rows inspected (bounded by `maxRows`). */
  scanned: number;
  /** Rows settled `active` -> `closed`. */
  closed: number;
  /** Active rows left alone because their job is genuinely in flight. */
  live: number;
  /** Job ids whose row was settled, for the boot log / operator evidence. */
  closedJobIds: string[];
}

/** True when the row's owning job is gone or already terminal — i.e. the row is
 * a stale liveness signal. */
export function isStaleMediaSession(
  row: Pick<MediaSession, "status">,
  job: Pick<Job, "status"> | undefined
): boolean {
  if (row.status !== "active") return false;
  if (!job) return true;
  return Store.isTerminalStatus(job.status);
}

export async function reconcileStaleMediaSessions(opts: {
  db: MediaSessionReconcileStore;
  /** In-memory job lookup (the Store after `load()` at boot). */
  getJob: (jobId: string) => Pick<Job, "status"> | undefined;
  maxRows?: number;
}): Promise<MediaSessionReconcileResult> {
  const maxRows = Math.max(0, opts.maxRows ?? MEDIA_SESSION_RECONCILE_MAX_ROWS);
  let rows: MediaSession[] = [];
  try {
    rows = await opts.db.listMediaSessions();
  } catch {
    // No table / unreachable DB: nothing to reconcile; never block boot.
    return { scanned: 0, closed: 0, live: 0, closedJobIds: [] };
  }
  const active = rows.filter((r) => r.status === "active").slice(0, maxRows);
  const result: MediaSessionReconcileResult = { scanned: active.length, closed: 0, live: 0, closedJobIds: [] };
  for (const row of active) {
    if (!isStaleMediaSession(row, opts.getJob(row.jobId))) {
      result.live++;
      continue;
    }
    try {
      if (await opts.db.closeMediaSession(row.jobId)) {
        result.closed++;
        result.closedJobIds.push(row.jobId);
      }
    } catch {
      /* per-row bookkeeping failure: keep reconciling the rest */
    }
  }
  return result;
}
