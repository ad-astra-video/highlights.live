// Database backup CLI (run via `npm run db:backup`).
//
// Produces a consistent, integrity-checked snapshot of the database the server
// is configured to use, into `DATABASE_BACKUP_DIR` (default data/backups).
//
//   - SQLite (dev, no DATABASE_URL): uses `VACUUM INTO` on the live DB, so the
//     snapshot is taken atomically even mid-write, then verifies with
//     `PRAGMA integrity_check`.
//   - Postgres (DATABASE_URL set): shells out to `pg_dump` (must be installed)
//     for a logical dump of the configured database.
//
// Backups are never deleted by this script; rotate them out of band (e.g. a
// daily cron that keeps the N most recent). Example cron (daily 03:00 UTC):
//   0 3 * * * cd <repo>/services/server && npm run db:backup --silent
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function backupSqlite(dbPath: string, outDir: string): Promise<string> {
  if (dbPath === ":memory:") throw new Error("refusing to back up an in-memory database (:memory:). Set DATABASE_PATH to a file.");
  mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, `highlights-${timestamp()}.db`);
  // createRequire so this works under vite-node/tsx without a static ESM import
  // of the experimental builtin.
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // VACUUM INTO produces a consistent snapshot even if the live DB is being
    // written concurrently (it runs in its own transaction).
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  // Verify the snapshot integrity before reporting success.
  const check = new DatabaseSync(dest, { readOnly: true });
  const ok = (check.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  check.close();
  if (ok !== "ok") throw new Error(`backup integrity check failed: ${ok}`);
  return dest;
}

async function backupPostgres(databaseUrl: string, outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, `highlights-${timestamp()}.sql`);
  try {
    execFileSync("pg_dump", [databaseUrl, "--no-owner", "--no-privileges", "-f", dest], { stdio: ["ignore", "inherit", "inherit"] });
  } catch (e: any) {
    throw new Error(`pg_dump failed (is it installed?): ${String(e?.message || e)}`);
  }
  return dest;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const databasePath = process.env.DATABASE_PATH ?? "data/highlights.db";
  const outDir = process.env.DATABASE_BACKUP_DIR ?? "data/backups";

  const dest = databaseUrl
    ? await backupPostgres(databaseUrl, outDir)
    : await backupSqlite(databasePath, outDir);

  // eslint-disable-next-line no-console
  console.log(`backup written: ${dest}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`backup failed: ${String(e?.message || e)}`);
  process.exit(1);
});
