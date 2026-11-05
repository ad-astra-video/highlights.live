// ADAAAA-8059 (Inc 12) — the three vectors end-to-end, on the ladder and on the
// write seam, plus the PO's primary acceptance: REPLAY the 32 stored `summaryLog`
// rows of job 28214400-df08-4f45-a182-367f818bcfa5 (level `deploy-master 32872f2`,
// the tip QA v9 measured) through `buildSummaryLadder` and require 32 entries, every
// one byte-identical to its stored `text`, 0 dropped.
//
// QA v9 measured 31 entries / 28 identical / 3 rewritten / 1 dropped on that store:
// seq 14 + seq 18 (score suppressed at read), seq 30 (`text_raw`'s `— ball goes wide`
// restored), seq 22 (dropped). All four are pinned here by seq.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { suppressScoreClaims } from "@highlights/events";
import { Store } from "../src/store";
import { appendSummaryEntry } from "../src/summary-log";
import { buildSummaryLadder } from "../src/summary-ladder";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "summary-log-28214400.json"), "utf8")
) as {
  job: string;
  level: string;
  summaryLog: Array<{ seq: number; windowTs?: number; text: string; text_raw?: string; verdict?: string }>;
  highlights: Array<Record<string, unknown>>;
};

const servedRows = (log: typeof fixture.summaryLog) => {
  const ladder = buildSummaryLadder({
    summaryLog: log as never,
    highlights: fixture.highlights as never,
    gameHint: "",
    fastRail: true,
  });
  return ladder.chapters.flatMap((c) => c.entries.map((e) => ({ seq: e.seq as number, text: e.text })));
};

describe("replay: job 28214400 (32 stored rows, deploy-master 32872f2)", () => {
  const stored = fixture.summaryLog;
  const rows = servedRows(stored);
  const storedBySeq = new Map(stored.map((e) => [e.seq, e.text.trim()] as const));
  const servedBySeq = new Map(rows.map((r) => [r.seq, r.text] as const));

  it("emits 32 entries — 0 dropped", () => {
    expect(stored).toHaveLength(32);
    expect(rows).toHaveLength(32);
    expect(rows.map((r) => r.seq)).toEqual(stored.map((e) => e.seq));
  });

  it("serves every row byte-identically to its stored text", () => {
    const diffs = stored
      .map((e) => ({ seq: e.seq, stored: e.text.trim(), served: servedBySeq.get(e.seq) }))
      .filter((d) => d.served !== d.stored);
    expect(diffs).toEqual([]);
    for (const e of stored) expect(servedBySeq.get(e.seq), `seq ${e.seq}`).toBe(e.text.trim());
  });

  it("never serves a scoreline the store does not carry (seq 14 / 18)", () => {
    // These two rows are legacy stores: written BEFORE the score gate moved to the
    // write seam, so their stored `text` still carries the claim. The read path is a
    // pure read, so it serves them verbatim — and the seam now stores the suppressed
    // string, which is what the next level proves below.
    expect(servedBySeq.get(14)).toBe("Manuel Ordonez shoots to put Real Madrid up 2-1 in midfield.");
    expect(servedBySeq.get(18)).toBe("David Saez shoots to level the game 2-2 in midfield.");
  });

  it("does not restore text_raw's `— ball goes wide` (seq 30)", () => {
    const row = servedBySeq.get(30)!;
    expect(row).toBe("A player attempts a header from the box.");
    expect(row).not.toContain("ball goes wide");
  });

  it("keeps seq 22 (dropped on the graded build)", () => {
    expect(servedBySeq.get(22)).toBe("A player kicks the ball into the center.");
  });

  it("is deterministic across reads", () => {
    expect(servedRows(stored)).toEqual(rows);
  });
});

describe("lever 3 — the write seam stores the score-suppressed string", () => {
  const PROMPT =
    "Match context: RMA 1-1 BAR | scorebug OCR: RMA 2-1 BAR | No. 7 | ASR: (empty)";

  it("stores `2-1` suppressed and keeps the claim in text_raw (audit only)", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "Manuel Ordonez scores to put Real Madrid up 2-1 in midfield.", {
      windowTs: 109,
      grounding: { verdict: "scoring_play", promptText: PROMPT, corroborated: false, place: "in midfield" },
    });
    const entry = s.getJob(job.id)!.summaryLog![0];
    expect(entry.text).not.toMatch(/\b\d{1,2}\s*-\s*\d{1,2}\b/);
    expect(entry.text).toBe(suppressScoreClaims(entry.text));
    // The model's own line survives as the audit field, never as the served string.
    expect(entry.text_raw ?? "").toContain("2-1");
  });

  it("a replayed stored row is byte-identical (stored == served)", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "David Saez scores to level the game 2-2 in midfield.", {
      windowTs: 141,
      grounding: { verdict: "scoring_play", promptText: PROMPT, corroborated: false, place: "in midfield" },
    });
    const log = s.getJob(job.id)!.summaryLog!;
    const ladder = buildSummaryLadder({ summaryLog: log as never, highlights: [], gameHint: "", fastRail: true });
    const rows = ladder.chapters.flatMap((c) => c.entries);
    expect(rows.map((r) => r.text)).toEqual(log.map((e) => e.text));
  });
});
