import { stat, rm } from "node:fs/promises";
import path from "node:path";
import type { Store } from "./store";
import type { ServerConfig } from "./config";
import type { HighlightRecord } from "@highlights/events";

/**
 * Rejected-clip storage lifecycle (ADAAAA-5168).
 *
 * The reject *action* marks a clip `rejected` + `rejectedAt` (the soft-delete
 * undo grace window — a reject->accept inside the TTL cancels pending deletion).
 * This sweep is the hard-delete half: it runs on a cadence (`<= rejectedClipTtlMs`)
 * and, for every clip that is STILL `rejected` AND aged `>= rejectedClipTtlMs`,
 * permanently removes the DB row AND the on-disk storage object.
 *
 * Safety properties:
 *  - Exact purge filter: only `rejected && age>=TTL` clips are ever candidates
 *    (see Store#rejectedExpired). Accepted/published/pending are never selected.
 *  - Concurrent-write safe: each candidate is re-checked against the live store
 *    immediately before deletion, so a reject->accept (undo) that lands between
 *    selection and purge cancels the deletion (the sweep skips and reports it).
 *  - No dangling rows: the DB row is removed FIRST (breaking /feed + /highlights
 *    references), then the storage object is deleted idempotently — so a failed
 *    object delete never leaves a live row pointing at a missing file.
 *  - Idempotent: removing an already-deleted row or object is a no-op; re-running
 *    the sweep deletes nothing twice.
 *  - Reportable: every run reports objects + bytes reclaimed (0/0 in dry-run).
 */
export interface CleanupReport {
  dryRun: boolean;
  ttlMs: number;
  /** Total highlights scanned. */
  scanned: number;
  /** Rejected clips aged >= TTL (the only possible purge targets). */
  candidates: number;
  /** Rows hard-deleted this run (0 in dry-run). */
  purged: number;
  /** Storage objects whose row was purged (0 in dry-run). */
  objectsDeleted: number;
  /** Bytes reclaimed this run (dry-run: reclaimable bytes, nothing deleted). */
  bytesReclaimed: number;
  /** Candidates re-checked and found no longer eligible (concurrent undo / already gone). */
  skipped: number;
  errors: string[];
}

export class RejectedClipCleanup {
  constructor(
    private readonly store: Store,
    private readonly cfg: Pick<
      ServerConfig,
      "dataDir" | "rejectedClipTtlMs" | "rejectedClipCleanupDryRun"
    >
  ) {}

  /**
   * Run one sweep. `dryRun` defaults to the configured value; when true the sweep
   * reports candidates + reclaimable objects/bytes and deletes nothing.
   */
  async run(now: Date = new Date(), dryRun = this.cfg.rejectedClipCleanupDryRun): Promise<CleanupReport> {
    const all = this.store.allHighlights();
    const candidates = this.store.rejectedExpired(this.cfg.rejectedClipTtlMs, now);
    const report: CleanupReport = {
      dryRun,
      ttlMs: this.cfg.rejectedClipTtlMs,
      scanned: all.length,
      candidates: candidates.length,
      purged: 0,
      objectsDeleted: 0,
      bytesReclaimed: 0,
      skipped: 0,
      errors: [],
    };

    for (const h of candidates) {
      // Concurrency guard #1: re-confirm the clip is still present and still
      // rejected (a reject->accept undo cancels pending deletion).
      const current = this.store.getHighlight(h.id);
      if (!current) continue; // already removed by a concurrent pass
      if (current.status !== "rejected") {
        report.skipped++;
        continue;
      }
      // Concurrency guard #2: still expired? Age is measured from rejectedAt
      // (the undo-window start), falling back to createdAt for pre-5168 rows.
      const age = now.getTime() - new Date(current.rejectedAt ?? current.createdAt).getTime();
      if (age < this.cfg.rejectedClipTtlMs) {
        report.skipped++;
        continue;
      }

      const size = await this.measureObject(current, report);
      if (dryRun) {
        // Report reclaimable bytes only — nothing is deleted.
        report.bytesReclaimed += size;
        continue;
      }

      // Break references first (drop the row so /feed + /highlights no longer
      // list it), then delete the object. Row-first means a failed object delete
      // can never leave a live row pointing at a missing file (no dangling ref).
      await this.store.removeHighlight(current.id);
      report.purged++;
      if (current.clipUri) {
        report.objectsDeleted++;
        await this.deleteObject(current, report);
      }
      report.bytesReclaimed += size;
    }

    return report;
  }

  private async measureObject(h: HighlightRecord, report: CleanupReport): Promise<number> {
    const full = this.objectPath(h);
    if (!full) return 0;
    try {
      return (await stat(full)).size;
    } catch {
      return 0; // already gone
    }
  }

  private async deleteObject(h: HighlightRecord, report: CleanupReport): Promise<void> {
    const full = this.objectPath(h);
    if (!full) return;
    try {
      await rm(full, { force: true });
    } catch (e) {
      // Row is already removed so there is no dangling reference; the object is
      // inert and reclaimable later. Log so the operator can clean it up.
      const msg = e instanceof Error ? e.message : String(e);
      report.errors.push(`rm ${full}: ${msg}`);
    }
  }

  /** Resolve a clip's storage object under dataDir/clips, defensively basename'd
   * so a crafty clipUri can't escape the clips dir (path traversal guard). */
  private objectPath(h: HighlightRecord): string | null {
    if (!h.clipUri) return null;
    return path.join(this.cfg.dataDir, "clips", path.basename(h.clipUri));
  }
}
