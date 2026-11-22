// ADAAAA-8143: durable per-frame scoreboard text on `job_observations`.
//
// AC1 (storage): an additive nullable column written by the perceive OCR leg for
// each frame where a score line was ACTUALLY read, NULL when none was. AC4
// (cost): the migration is a bare ADD COLUMN — no default, no rewrite, no
// backfill of historic rows. AC5 (honesty): a partially-read leg leaves NULLs and
// the reader must report them as `not_captured`, never as a score of 0.
//
// AC2's equivalence replay and AC5's real-leg read need rows from a stored leg
// (spend-gated); these tests pin the MECHANISM and the honesty rule at $0 — no
// GPU, no perceive call, no clip debit.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// `node:sqlite` is experimental and not in Vite/vitest's builtin external list,
// so it must be loaded by Node at runtime (the same `require` shape db.ts uses).
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
import { SqliteDb } from "../src/db";
import { LiveFrameWriter } from "../src/live-frames";
import {
  SCORE_TEXT_MAX_LINE_CHARS,
  SCORE_TEXT_MAX_LINES,
  jobSport,
  normalizeOcrLines,
  scoreTextForObservation,
  storedScoreCensus,
  storedScoreRows,
} from "../src/observation-score";
import { parseOcrScoreLine, scoreboardDeltaFromPooledReadings } from "../src/analyzer";
import { buildTestApp, fakePipeline } from "./helpers";

const bug = (clock: string, home: number, away: number) => `${clock} RMA ${home}-${away} BAR`;

function tmpFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hl-8143-"));
  return path.join(dir, "obs.db");
}

describe("scoreTextForObservation: what a frame stores (AC1)", () => {
  it("stores NOTHING when the frame's OCR read no score line", () => {
    // No OCR at all: the pre-8143 shape for a frame with no scoreboard crop.
    expect(scoreTextForObservation(undefined)).toBeNull();
    expect(scoreTextForObservation(null)).toBeNull();
    expect(scoreTextForObservation([])).toBeNull();
    // Non-array / junk payloads never fabricate a line.
    expect(scoreTextForObservation("RMA 1-1 BAR")).toBeNull();
    expect(scoreTextForObservation([null, 7, ""])).toBeNull();
  });

  it("stores NOTHING for OCR text that contains no score line", () => {
    // A jersey/caption read is not a scoreboard.
    expect(scoreTextForObservation(["BENZEMA 9"])).toBeNull();
    // A match clock is NEVER a score (ADAAAA-8189 / 8507): 12:07 must not become 12-7.
    expect(scoreTextForObservation([bug("12:07", 0, 0).replace("RMA 0-0 BAR", "")])).toBeNull();
    expect(scoreTextForObservation(["0:00"])).toBeNull();
    expect(scoreTextForObservation(["12:07"])).toBeNull();
  });

  it("stores the lines when a score line was actually read", () => {
    const lines = [bug("00:56", 1, 1), "LALIGA"];
    expect(scoreTextForObservation(lines)).toEqual(lines);
    // The stored text re-parses to exactly the read score.
    expect(parseOcrScoreLine(scoreTextForObservation(lines)!, undefined)).toEqual([1, 1]);
  });

  it("runs the SPORT-AWARE parser on the stored lines", () => {
    // A football plate cannot reach two digits; a basketball one can. The gate
    // reads the job's persisted sport, so the stored text is exactly what the
    // attestation path will parse back to the same pair (ADAAAA-8841).
    const lines = ["RMA 10-9 BAR"];
    expect(parseOcrScoreLine(lines, "football")).toBeNull();
    expect(scoreTextForObservation(lines, "football")).toBeNull();
    const stored = scoreTextForObservation(lines, "basketball");
    expect(stored).toEqual(lines);
    expect(parseOcrScoreLine(stored!, "basketball")).toEqual([10, 9]);
  });

  it("bounds the column without changing what parses", () => {
    const many = Array.from({ length: SCORE_TEXT_MAX_LINES + 5 }, (_, i) => `line ${i}`);
    many.unshift(bug("00:56", 2, 1));
    const stored = scoreTextForObservation(many)!;
    expect(stored.length).toBe(SCORE_TEXT_MAX_LINES);
    expect(stored[0]).toBe(bug("00:56", 2, 1));
    // A pathological long line is truncated, and the gate ran on the stored form.
    const long = ["RMA 1-1 BAR " + "x".repeat(SCORE_TEXT_MAX_LINE_CHARS * 2)];
    expect(normalizeOcrLines(long)[0].length).toBe(SCORE_TEXT_MAX_LINE_CHARS);
    expect(scoreTextForObservation(long)![0].length).toBeLessThanOrEqual(SCORE_TEXT_MAX_LINE_CHARS);
  });
});

describe("storage round-trip (AC1)", () => {
  it("persists NULL for an uncaptured frame and the lines for a captured one", async () => {
    const db = new SqliteDb(":memory:");
    await db.saveObservation("job-8143", { seq: 0, timestamp: 1, tracks: [] });
    await db.saveObservation("job-8143", { seq: 1, timestamp: 2, tracks: [], scoreText: [bug("00:56", 1, 0)] });

    const rows = await db.observationsForJob("job-8143");
    expect(rows).toHaveLength(2);
    // Absent — not `[]`, not a synthesized score — for the frame that read nothing.
    expect(rows[0].scoreText).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(rows[0], "scoreText")).toBe(false);
    expect(rows[1].scoreText).toEqual([bug("00:56", 1, 0)]);

    // And the COLUMN itself is SQL NULL, so a storage query sees `not_captured`.
    const raw = db as unknown as { db: DatabaseSyncType };
    const stored = raw.db
      .prepare("SELECT seq, score_text FROM job_observations WHERE job_id = ? ORDER BY seq")
      .all("job-8143") as { seq: number; score_text: string | null }[];
    expect(stored[0].score_text).toBeNull();
    expect(JSON.parse(stored[1].score_text as string)).toEqual([bug("00:56", 1, 0)]);
    // The listObservations path (used by census/export tools) agrees.
    const listed = (await db.listObservations()).filter((r) => r.jobId === "job-8143");
    expect(listed[0].observation.scoreText).toBeUndefined();
    expect(listed[1].observation.scoreText).toEqual([bug("00:56", 1, 0)]);
    await db.close();
  });

  it("an empty array is never stored — it would read as 'captured nothing'", async () => {
    const db = new SqliteDb(":memory:");
    await db.saveObservation("job-8143", { seq: 0, timestamp: 1, tracks: [], scoreText: [] });
    const raw = db as unknown as { db: DatabaseSyncType };
    const row = raw.db.prepare("SELECT score_text FROM job_observations WHERE job_id = ?").get("job-8143") as {
      score_text: string | null;
    };
    expect(row.score_text).toBeNull();
    expect((await db.observationsForJob("job-8143"))[0].scoreText).toBeUndefined();
    await db.close();
  });

  it("a re-write without a read cannot erase an earlier captured read of the same frame", async () => {
    const db = new SqliteDb(":memory:");
    await db.saveObservation("job-8143", { seq: 3, timestamp: 3, tracks: [], scoreText: [bug("03:10", 2, 1)] });
    await db.saveObservation("job-8143", { seq: 3, timestamp: 3, tracks: [] });
    const rows = await db.observationsForJob("job-8143");
    expect(rows).toHaveLength(1);
    expect(rows[0].scoreText).toEqual([bug("03:10", 2, 1)]);
    await db.close();
  });
});

describe("migration is additive, with no rewrite of historic rows (AC4)", () => {
  it("adds a nullable column to a pre-existing DB and leaves historic rows NULL", async () => {
    const file = tmpFile();
    // Build the PRE-8143 shape by hand: the column list the served tip measured
    // (`job_id, seq, timestamp, tracks, created_at`) with one real historic row.
    const legacy = new DatabaseSync(file);
    legacy.exec(
      `CREATE TABLE job_observations (
         job_id TEXT NOT NULL,
         seq INTEGER NOT NULL,
         timestamp REAL NOT NULL,
         tracks TEXT NOT NULL,
         created_at TEXT NOT NULL,
         PRIMARY KEY (job_id, seq)
       )`
    );
    const historicTracks = JSON.stringify([{ trackId: "t1", slot: 0, bbox: [1, 2, 3, 4], kind: "person" }]);
    legacy
      .prepare("INSERT INTO job_observations (job_id, seq, timestamp, tracks, created_at) VALUES (?,?,?,?,?)")
      .run("legacy-job", 0, 12.5, historicTracks, "2026-11-01T00:00:00.000Z");
    legacy.close();

    const db = new SqliteDb(file);
    await db.migrate();

    const raw = db as unknown as { db: DatabaseSyncType };
    const cols = (raw.db.prepare("PRAGMA table_info(job_observations)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("score_text");

    // No rewrite, no backfill: the historic row is untouched and its new column is NULL.
    const rows = raw.db
      .prepare("SELECT job_id, seq, timestamp, tracks, created_at, score_text FROM job_observations")
      .all() as { job_id: string; seq: number; timestamp: number; tracks: string; created_at: string; score_text: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].job_id).toBe("legacy-job");
    expect(rows[0].seq).toBe(0);
    expect(rows[0].timestamp).toBe(12.5);
    expect(rows[0].tracks).toBe(historicTracks);
    expect(rows[0].created_at).toBe("2026-11-01T00:00:00.000Z");
    expect(rows[0].score_text).toBeNull();

    // The reader reports the historic row as not captured, never as `0-0`.
    const read = await db.observationsForJob("legacy-job");
    expect(read[0].scoreText).toBeUndefined();
    expect(storedScoreCensus(read).notCaptured).toBe(1);
    expect(storedScoreCensus(read).readings).toEqual([]);

    // The migration is tracked, and a NEW row on the same DB captures normally.
    const applied = raw.db.prepare("SELECT version FROM _schema_migrations ORDER BY version DESC LIMIT 1").get() as {
      version: number;
    };
    expect(applied.version).toBe(11);
    await db.saveObservation("legacy-job", { seq: 1, timestamp: 13, tracks: [], scoreText: [bug("00:13", 0, 1)] });
    const after = await db.observationsForJob("legacy-job");
    expect(after[1].scoreText).toEqual([bug("00:13", 0, 1)]);
    expect(after[0].scoreText).toBeUndefined();
    await db.close();
  });

  it("the DDL carries no DEFAULT and no backfill statement", () => {
    // A $0 run cannot execute Postgres here, so the "no rewrite" claim is pinned
    // to the migration/statement shape: a bare ADD COLUMN (nullable, no default)
    // plus the absence of any UPDATE of historic rows.
    const src = readFileSync(path.join(__dirname, "../src/db.ts"), "utf8");
    expect(src).toContain('await exec("ALTER TABLE job_observations ADD COLUMN score_text TEXT")');
    expect(src).not.toMatch(/ALTER TABLE job_observations ADD COLUMN score_text[^"]*DEFAULT/i);
    expect(src).not.toMatch(/ALTER TABLE job_observations ADD COLUMN score_text[^"]*NOT NULL/i);
    expect(src).not.toMatch(/UPDATE\s+job_observations\s+SET\s+score_text/i);
  });
});

describe("reader honesty: NULL is `not_captured`, never a score of 0 (AC5)", () => {
  it("counts a partially-read leg and contributes no reading for the NULL rows", () => {
    const observations = [
      { seq: 0, timestamp: 10, scoreText: [bug("00:10", 1, 0)] },
      { seq: 1, timestamp: 11 }, // NULL — the OCR read nothing on this frame
      { seq: 2, timestamp: 12, scoreText: [bug("00:12", 1, 0)] },
      { seq: 3, timestamp: 13 }, // NULL
      { seq: 4, timestamp: 14, scoreText: [bug("00:14", 1, 1)] },
    ];
    const census = storedScoreCensus(observations);
    expect(census.rows).toBe(5);
    expect(census.captured).toBe(3);
    expect(census.notCaptured).toBe(2);
    expect(census.unparseable).toBe(0);
    // Only the captured frames are readings: the NULLs are absent evidence.
    expect(census.readings.map((r) => r.ts)).toEqual([10, 12, 14]);
    // Critically: NOTHING reads as 0-0.
    expect(census.readings.some((r) => r.score[0] === 0 && r.score[1] === 0)).toBe(false);

    const rows = storedScoreRows(observations);
    expect(rows.map((r) => r.status)).toEqual([
      "captured",
      "not_captured",
      "captured",
      "not_captured",
      "captured",
    ]);
    expect(rows.filter((r) => r.status === "not_captured").every((r) => r.score === undefined)).toBe(true);
  });

  it("reports an all-NULL leg as fully not_captured instead of a scoreless 0-0 timeline", () => {
    const observations = [
      { seq: 0, timestamp: 1 },
      { seq: 1, timestamp: 2 },
    ];
    const census = storedScoreCensus(observations);
    expect(census).toMatchObject({ rows: 2, captured: 0, notCaptured: 2, unparseable: 0, readings: [] });
  });

  it("separates text that no longer parses from text that was never captured", () => {
    const census = storedScoreCensus([{ seq: 0, timestamp: 5, scoreText: ["BENZEMA 9"] }]);
    expect(census.notCaptured).toBe(0);
    expect(census.unparseable).toBe(1);
    expect(census.readings).toEqual([]);
  });

  it("feeds the pooled attestation path from stored text alone (AC2 mechanism, $0)", () => {
    // The same three-frame fix the pixel re-read would find, but read from
    // `score_text`: two PRE reads, one POST read, one single-goal step.
    const observations = [
      { seq: 0, timestamp: 15, scoreText: [bug("00:15", 1, 0)] },
      { seq: 1, timestamp: 19, scoreText: [bug("00:19", 1, 0)] },
      { seq: 2, timestamp: 21, scoreText: [bug("00:21", 1, 1)] },
      { seq: 3, timestamp: 22, scoreText: [bug("00:22", 1, 1)] },
    ];
    const census = storedScoreCensus(observations);
    // The deferred lane's shape: the judged window plus its lookahead as the
    // trial range, which is the only widening the deferred path allows.
    const delta = scoreboardDeltaFromPooledReadings({
      readings: census.readings,
      window: { lo: 14, hi: 20 },
      trailS: 4,
      deltaRange: { lo: 14, hi: 24 },
    });
    expect(delta).toBeDefined();
    expect(delta!.pre).toEqual([1, 0]);
    expect(delta!.post).toEqual([1, 1]);
    expect(delta!.deltaTs).toBe(21);
    expect(delta!.preSamples).toBe(2);
    expect(delta!.postSamples).toBe(2);
    // The same decision the pixel re-read would reach, with zero OCR calls.
    expect(census.notCaptured).toBe(0);
  });
});

describe("LiveFrameWriter threads the score text to the observation row (AC1 write path)", () => {
  it("passes scoreText when a line was read and omits it otherwise", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hl-8143-frames-"));
    const seen: { seq: number; scoreText?: string[] }[] = [];
    const writer = new LiveFrameWriter({
      dataDir: dir,
      jobId: "job-8143",
      recordObservation: (_jobId, obs) => {
        seen.push({ seq: obs.seq, ...(obs.scoreText ? { scoreText: obs.scoreText } : {}) });
      },
    });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
    writer.enqueue({ seq: 0, timestamp: 1, frameB64: jpeg, tracks: [], scoreText: [bug("00:01", 0, 1)] });
    writer.enqueue({ seq: 1, timestamp: 2, frameB64: jpeg, tracks: [] });
    await writer.drain();
    expect(seen).toHaveLength(2);
    expect(seen[0].scoreText).toEqual([bug("00:01", 0, 1)]);
    expect(seen[1].scoreText).toBeUndefined();
    expect(writer.stats().written).toBe(2);
  });
});

describe("jobSport", () => {
  it("reads the persisted sport, lowercased, and ignores junk", () => {
    expect(jobSport({ matchContext: { sport: "  Basketball " } })).toBe("basketball");
    expect(jobSport({ matchContext: { sport: 7 } })).toBeUndefined();
    expect(jobSport({})).toBeUndefined();
    expect(jobSport(undefined)).toBeUndefined();
  });
});

describe("end to end through the observe route (AC1 write path)", () => {
  it("persists score_text on the relayed frame rows and leaves NULLs for the frames that read nothing", async () => {
    const { app, db } = await buildTestApp({ LIVE_OBSERVE_LOOP: "1" }, { adapter: fakePipeline() });
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "scoretext8143@test.dev", password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    const token = reg.json().token as string;
    const auth = { authorization: `Bearer ${token}` };
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: auth,
      payload: { source: "browser", gameHint: "soccer" },
    });
    expect([200, 202]).toContain(jr.statusCode);
    const jobId = jr.json().job.id as string;

    const t0 = Date.now() / 1000;
    const jpeg = (n: number) => Buffer.from(`jpeg-frame-${n}-payload`).toString("base64");
    // Frame 0 reads a score; frame 1 reads a jersey line only; frame 2 reads nothing.
    const relays = [
      { ocr: [bug("00:00", 1, 0)] },
      { ocr: ["BENZEMA 9"] },
      {},
    ];
    for (let i = 0; i < relays.length; i++) {
      const r = await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/observe`,
        payload: { seq: i, timestamp: t0 + i, tracks: [], frameB64: jpeg(i), ...relays[i] },
      });
      expect(r.statusCode).toBe(200);
    }
    await app.inject({ method: "POST", url: `/jobs/${jobId}/stop`, headers: auth });

    // Read the SAME surface a re-attestation/grader reads: storage, not pixels.
    let observations: any[] = [];
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const got = await app.inject({ method: "GET", url: `/jobs/${jobId}/observations`, headers: auth });
      if (got.statusCode === 200) {
        observations = got.json().observations as any[];
        if (observations.length >= 3) break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(observations.map((o) => o.seq)).toEqual([0, 1, 2]);
    expect(observations[0].scoreText).toEqual([bug("00:00", 1, 0)]);
    // The jersey-only frame and the silent frame store NO text (SQL NULL).
    expect(observations[1].scoreText).toBeUndefined();
    expect(observations[2].scoreText).toBeUndefined();

    // The same rows straight out of the DB (the durability claim, not just the
    // in-memory working set that /observations serves).
    const persisted = await db.observationsForJob(jobId);
    expect(persisted.map((o) => o.seq)).toEqual([0, 1, 2]);
    expect(persisted[0].scoreText).toEqual([bug("00:00", 1, 0)]);
    expect(persisted[1].scoreText).toBeUndefined();
    expect(persisted[2].scoreText).toBeUndefined();

    const census = storedScoreCensus(observations);
    expect(census).toMatchObject({ rows: 3, captured: 1, notCaptured: 2, unparseable: 0 });
    expect(census.readings).toEqual([{ ts: observations[0].timestamp, score: [1, 0] }]);
    expect(census.readings.some((r) => r.score[0] === 0 && r.score[1] === 0)).toBe(false);
    await app.close();
  }, 30000);
});
