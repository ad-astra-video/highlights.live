// ADAAAA-8040 (§2 residual, residual of ADAAAA-8013 on build `a408584`): the
// LADDER is derived at read time, so these four stored rows grade the shipped
// code directly. Each was served as a prefix cut with no sentence end:
//
//   3d8a5a82 seq 18 / windowTs 222 -> `A player shoots from the penalty area`
//   a1f30ed1 seq 7  (windowTs 102)  -> `Player in white takes a shot from the penalty area`
//   a1f30ed1 seq 34 (windowTs 459)  -> `The player in white takes a shot from the penalty area`
//   228462b5 seq 15 / windowTs 198  -> `Players move in the center`
//
// The gate must serve each as a WHOLE sentence (the claim suppressed INSIDE the
// sentence, sentence end restored) or drop the row. This suite asserts the exact
// served strings plus the mechanical AC1 sweep over the rendered ladder:
// 0 function-word tails, 0 rows without a sentence end, 0 unsanctioned prefixes.
import { describe, it, expect } from "vitest";
import { captionLead, hasTerminalPunctuation } from "@highlights/events";
import { buildSummaryLadder } from "../src/summary-ladder";

type Row = { seq: number; windowTs: number; text: string; text_raw?: string; verdict?: string };

/** The four stored rows of the graded build, verbatim (stored `text` = old gate). */
const STORED: Row[] = [
  {
    seq: 18,
    windowTs: 222,
    verdict: "not_highlight",
    text: "A player shoots from the penalty area",
    text_raw: "A player shoots from the penalty area — the ball misses the goal.",
  },
  {
    seq: 7,
    windowTs: 102,
    verdict: "big_play",
    text: "Player in white takes a shot from the penalty area",
    text_raw: "Player in white takes a shot from the penalty area — misses the target. Real Madrid scores 2-1.",
  },
  {
    seq: 34,
    windowTs: 459,
    verdict: "big_play",
    text: "The player in white takes a shot from the penalty area",
    text_raw: "The player in white takes a shot from the penalty area — goal 22:15",
  },
  {
    seq: 15,
    windowTs: 198,
    verdict: "not_highlight",
    text: "Players move in the center",
    text_raw: "Players move in the center and defensive areas.",
  },
];

const FUNCTION_WORD =
  /(?:^|\s)(?:and|or|of|in|at|on|with|from|to|for|the|a|an|are|is|was|were|be|been|has|have|had|as|but|while|when|by|into|onto|than|that|which|who|whose|its|his|her|their|over|under|near|inside|outside|around|after|before|during|through|across|not|no|then|if|so)$/i;

const normalize = (text: string) =>
  (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const servedRows = (log: Row[]) => {
  const ladder = buildSummaryLadder({ summaryLog: log as never, highlights: [], gameHint: "soccer", fastRail: true });
  return ladder.chapters.flatMap((c) => c.entries.map((e) => ({ seq: e.seq as number, text: e.text })));
};

describe("ADAAAA-8040 §2 residual — the four stored rows render whole (AC1)", () => {
  const rows = servedRows(STORED);
  const bySeq = new Map(rows.map((r) => [r.seq, r.text] as const));

  it("serves the claim-suppressed rows as whole sentences", () => {
    expect(bySeq.get(18)).toBe("A player shoots from the penalty area.");
    expect(bySeq.get(7)).toBe("Player in white takes a shot from the penalty area.");
    expect(bySeq.get(34)).toBe("The player in white takes a shot from the penalty area.");
  });

  it("re-serves the quiet row from its whole stored sentence", () => {
    expect(bySeq.get(15)).toBe("Players move in the center and defensive areas.");
  });

  it("no row ends on a function word, inside a clause, or as an unsanctioned prefix", () => {
    for (const row of rows) {
      const stored = STORED.find((s) => s.seq === row.seq) as Row;
      expect(row.text, `seq ${row.seq}`).not.toMatch(FUNCTION_WORD);
      expect(hasTerminalPunctuation(row.text), `seq ${row.seq}: ${row.text}`).toBe(true);
      const raw = (stored.text_raw ?? "").trim();
      if (!raw) continue;
      const isPrefix = normalize(raw).startsWith(`${normalize(row.text)} `);
      if (!isPrefix) continue;
      // A prefix is sanctioned only when the row IS the stored sentence's own
      // lead, closed — the claim clause was suppressed INSIDE the sentence.
      expect(normalize(captionLead(raw)), `seq ${row.seq}`).toBe(normalize(row.text));
    }
  });

  it("keeps every row: no breadcrumb before the dash and no dropped row", () => {
    expect(rows.map((r) => r.seq).sort((a, b) => a - b)).toEqual([7, 15, 18, 34]);
    for (const row of rows) expect(row.text).not.toMatch(/[—–]/);
  });

  it("is deterministic across reads", () => {
    expect(servedRows(STORED)).toEqual(servedRows(STORED));
  });
});

describe("ADAAAA-8040 — a quiet row that exceeds the budget is reduced, never cut", () => {
  it("keeps a whole coordinate phrase inside the 8-word budget", () => {
    const log: Row[] = [
      {
        seq: 1,
        windowTs: 30,
        verdict: "not_highlight",
        text: "Players move in the center",
        text_raw: "Players move in the center and defensive areas.",
      },
      {
        seq: 2,
        windowTs: 33,
        verdict: "not_highlight",
        text: "A player moves in the center",
        text_raw: "A player in the white kit moves in the center and defensive areas of the pitch.",
      },
    ];
    const rows = servedRows(log);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(hasTerminalPunctuation(row.text), row.text).toBe(true);
      expect(row.text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(8);
    }
  });
});
