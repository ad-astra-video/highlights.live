import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { SqliteDb } from "../src/db";
import { Store } from "../src/store";

// ADAAAA-8366 (Inc 3): the score-bug / clock presence-gap signal reads the OCR
// the decide pass ALREADY produced for each anchor frame, at FINALIZE. That only
// works if the per-frame `ocr` lines survive the observation write path
// (perceive -> AnalyzeEvent.observation.ocr -> `job_observations.ocr` ->
// `observationsForJob`), which is the seam this file pins. Before the change the
// OCR was dropped after each decide call, so the detector saw nothing.

const BUG = ["POR 1 : 1 ESP 43:40"];

// `node:sqlite` is not in vite-node's builtin list (same reason `src/db.ts`
// loads it through createRequire): a bare ESM import rewrites to a broken id.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function tempDb(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "hl-ocr-8366-"));
  return { dir, file: path.join(dir, "highlights.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("score-bug OCR survives the observation write path (ADAAAA-8366)", () => {
  it("round-trips the per-frame OCR lines through memory and the DB", async () => {
    const { file, cleanup } = tempDb();
    try {
      const db = new SqliteDb(file);
      await db.migrate();
      const store = new Store(db);
      await store.load();
      const job = await store.createJob({ source: "file", sourceUrl: "/tmp/v.mp4" });

      await store.recordObservation(job.id, { seq: 0, timestamp: 152, tracks: [], ocr: BUG });
      // A frame that printed nothing stores no OCR, exactly as perceive reported.
      await store.recordObservation(job.id, { seq: 1, timestamp: 152.333, tracks: [] });

      const mem = store.observationsForJob(job.id);
      expect(mem[0].ocr).toEqual(BUG);
      expect(mem[1].ocr).toBeUndefined();

      const rows = await db.observationsForJob(job.id);
      expect(rows).toHaveLength(2);
      expect(rows[0].ocr).toEqual(BUG);
      expect(rows[1].ocr).toBeUndefined();
      // The tracks column is untouched by the additive OCR column.
      expect(rows[0].tracks).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("brings a pre-migration (OCR-less) observation table up to shape and keeps its rows", async () => {
    const { file, cleanup } = tempDb();
    try {
      // The on-disk shape before migration 11: no `ocr` column at all.
      const legacy = new DatabaseSync(file);
      legacy.exec(`
        CREATE TABLE job_observations (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          timestamp REAL NOT NULL,
          tracks TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (job_id, seq)
        );
      `);
      legacy
        .prepare("INSERT INTO job_observations (job_id, seq, timestamp, tracks, created_at) VALUES (?,?,?,?,?)")
        .run("legacy-job", 0, 10, "[]", "2026-11-07T00:00:00.000Z");
      legacy.close();

      const db = new SqliteDb(file);
      await db.migrate();
      const columns = (db as any).db.prepare("PRAGMA table_info(job_observations)").all() as { name: string }[];
      expect(columns.some((c) => c.name === "ocr")).toBe(true);

      // The legacy row still reads back (absent OCR = absent evidence, not a throw)
      // and a new row written after the migration carries its OCR.
      const rows = await db.observationsForJob("legacy-job");
      expect(rows).toHaveLength(1);
      expect(rows[0].ocr).toBeUndefined();
      await db.saveObservation("legacy-job", { seq: 1, timestamp: 11, tracks: [], ocr: BUG });
      const after = await db.observationsForJob("legacy-job");
      expect(after[1].ocr).toEqual(BUG);
    } finally {
      cleanup();
    }
  });

  it("treats a corrupt OCR cell as absent evidence instead of throwing", async () => {
    const { file, cleanup } = tempDb();
    try {
      const db = new SqliteDb(file);
      await db.migrate();
      await db.saveObservation("j", { seq: 0, timestamp: 1, tracks: [], ocr: BUG });
      // A truncated/garbled JSON cell must never take the finalize path down.
      (db as any).db.prepare("UPDATE job_observations SET ocr = ? WHERE job_id = ? AND seq = ?").run("{not json", "j", 0);
      const rows = await db.observationsForJob("j");
      expect(rows).toHaveLength(1);
      expect(rows[0].ocr).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
