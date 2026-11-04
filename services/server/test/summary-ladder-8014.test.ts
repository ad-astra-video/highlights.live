// ADAAAA-8014 (§2): the served ladder may not render a mangled line. The five
// rows below are the exact stored rows the ADAAAA-8010 re-grade found on build
// `eba8e7c` (jobs 3d8a5a82 / 973fae84, `summaryLadder.chapters[].entries[]`), so
// the acceptance is asserted on the payload the review failed on.
import { describe, it, expect } from "vitest";
import { captionLead, groundSummaryText, servedShapeViolations } from "@highlights/events";
import { buildSummaryLadder } from "../src/summary-ladder";

type Row = { seq: number; windowTs: number; text: string; text_raw?: string; verdict?: string };

/** The five served rows the re-grade failed on (stored `text` = the old gate). */
const LEGACY: Row[] = [
  // `A player and a player are.` — ends on the copula, the predicate was removed
  {
    seq: 1,
    windowTs: 297,
    verdict: "not_highlight",
    text: "A player and a player are.",
    text_raw: "A player in blue and a player in white are in the center of the field.",
  },
  // `The side.` — 2-word prefix cut, the whole predicate dropped
  {
    seq: 2,
    windowTs: 402,
    verdict: "big_play",
    text: "The side. 9 shoots on the right",
    text_raw: "Real Madrid's No. 9 scores — crowd erupts",
  },
  // `A player takes in midfield` — transitive verb with its object removed
  {
    seq: 3,
    windowTs: 348,
    verdict: "not_highlight",
    text: "A player takes in midfield",
    text_raw: "A player takes a shot from the penalty area that misses the goal.",
  },
  // `Players compete for the ball in the center.` — prefix cut
  {
    seq: 4,
    windowTs: 189,
    verdict: "not_highlight",
    text: "Players compete for the ball in the center.",
    text_raw: "Players compete for the ball in the center of the pitch.",
  },
  // `The broadcast shows a replay.` — prefix cut
  {
    seq: 5,
    windowTs: 489,
    verdict: "not_highlight",
    text: "The broadcast shows a replay.",
    text_raw: "The broadcast shows a replay of Saez's goal.",
  },
  // neighbours that already rendered cleanly: they must stay byte-identical
  { seq: 6, windowTs: 0, verdict: "not_highlight", text: "Player in purple dribbles in the center circle" },
  { seq: 7, windowTs: 3, verdict: "not_highlight", text: "Player controls the ball in the box." },
  { seq: 8, windowTs: 21, verdict: "not_highlight", text: "Player in white is tackled in center circle" },
];

const MANGLED = [
  "A player and a player are.",
  "The side.",
  "A player takes in midfield",
  "Players compete for the ball in the center.",
  "The broadcast shows a replay.",
];

/** The same five rows as the FIXED write seam stores them (fresh job). */
const FRESH: Row[] = LEGACY.map((row) =>
  row.text_raw
    ? {
        ...row,
        text:
          groundSummaryText(row.text_raw, {
            verdict: row.verdict,
            place: null,
            promptText: "",
            corroborated: false,
          } as any) || row.text,
      }
    : row
);

function render(log: Row[], extra: Partial<Parameters<typeof buildSummaryLadder>[0]> = {}) {
  return buildSummaryLadder({ summaryLog: log as any, highlights: [], gameHint: "Kids soccer", fastRail: true, ...extra });
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function rowsOf(ladder: ReturnType<typeof render>) {
  return ladder.chapters.flatMap((c) => c.entries);
}

function assertServedContract(ladder: ReturnType<typeof render>, stored: Row[]) {
  for (const row of rowsOf(ladder)) {
    const source = stored.find((r) => r.seq === row.seq)!;
    const sources = [captionLead(source.text), captionLead(source.text_raw ?? "")].filter(Boolean);
    expect(servedShapeViolations(row.text, sources)).toEqual([]);
    if (source.verdict === "not_highlight") expect(words(row.text)).toBeLessThanOrEqual(8);
  }
  for (const chapter of ladder.chapters) {
    const lead = chapter.summary.replace(/\s+\d+ accepted goals? \(\d+ corroborated\)\.$/, "");
    if (lead) expect(servedShapeViolations(lead, [])).toEqual([]);
  }
  for (const line of ladder.matchSummary.text.split("\n").filter((l) => l.startsWith("- "))) {
    const body = line.replace(/^- [^:]+: /, "");
    expect(servedShapeViolations(body, [])).toEqual([]);
  }
}

describe("a fresh job's served rows never stop mid-phrase (ADAAAA-8014 §2)", () => {
  const ladder = render(FRESH);

  it("renders none of the five re-grade shapes", () => {
    const rows = rowsOf(ladder);
    for (const row of rows) expect(MANGLED).not.toContain(row.text);
    expect(rows.some((r) => /\bare\.$/.test(r.text))).toBe(false);
    expect(rows.some((r) => /\btakes in midfield$/.test(r.text))).toBe(false);
    expect(rows.some((r) => /in the center\.$/.test(r.text))).toBe(false);
  });

  it("keeps every row (AC3: no row lost for a shape reason)", () => {
    expect(rowsOf(ladder).map((r) => r.seq)).toEqual(FRESH.map((r) => r.seq));
  });

  it("passes the served post-condition on every row, digest and bullet", () => {
    assertServedContract(ladder, FRESH);
  });

  it("gives the transitive verb its object back", () => {
    const row = rowsOf(ladder).find((r) => r.seq === 3)!;
    expect(row.text).toContain("shot");
    expect(row.text).not.toMatch(/takes$/);
  });

  it("leaves rows that were already whole byte-identical", () => {
    const texts = rowsOf(ladder).map((r) => r.text);
    expect(texts).toContain("Player in purple dribbles in the center circle");
    expect(texts).toContain("Player controls the ball in the box.");
    expect(texts).toContain("Player in white is tackled in center circle");
  });

  it("is deterministic across reads", () => {
    expect(render(FRESH).chapters).toEqual(render(FRESH).chapters);
  });
});

describe("a legacy job's stored rows are repaired or dropped, never rendered mangled", () => {
  const ladder = render(LEGACY);
  const rows = rowsOf(ladder);

  it("never renders a mangled shape", () => {
    for (const row of rows) expect(MANGLED).not.toContain(row.text);
    expect(rows.some((r) => /\btakes in midfield$/.test(r.text))).toBe(false);
  });

  it("repairs the rows the stored raw sentence can honestly supply", () => {
    const bySeq = new Map(rows.map((r) => [r.seq, r.text] as const));
    expect(bySeq.get(1)).toBe("A player and a player are in center.");
    expect(bySeq.get(4)).toBe("Players compete for the ball in center.");
  });

  it("drops only the row with no honest form left (named, not silently mangled)", () => {
    // seq 3's stored gated line lost its object and its raw line asserts a goal on
    // a quiet window, so no extractive <= 8-word clause exists; the row is dropped
    // instead of shipping `A player takes in midfield`.
    const dropped = LEGACY.map((r) => r.seq).filter((seq) => !rows.some((r) => r.seq === seq));
    expect(dropped).toEqual([3]);
  });

  it("keeps the contract on every rendered row", () => {
    assertServedContract(ladder, LEGACY);
  });
});

describe("a repair never re-renders a line another row already serves (AC1/AC2)", () => {
  it("collapses the pair to one row when the repaired sentence equals the previous beat", () => {
    const ladder = render([
      {
        seq: 1,
        windowTs: 177,
        verdict: "not_highlight",
        text: "The keeper makes a save in the box.",
        text_raw: "The keeper makes a save in the penalty area.",
      },
      {
        seq: 2,
        windowTs: 180,
        verdict: "not_highlight",
        text: "The keeper makes a save.",
        text_raw: "The keeper makes a save in the goal area.",
      },
    ]);
    const rows = rowsOf(ladder);
    expect(rows).toHaveLength(1);
    expect(new Set(rows.map((r) => r.text)).size).toBe(rows.length);
    expect(rows[0].text).toBe("The keeper makes a save in the box.");
  });
});

describe("the VOD rail keeps its stored items (AC8)", () => {
  it("returns a whole stored line unchanged on `source=file`", () => {
    const log: Row[] = [
      { seq: 1, windowTs: 0, text: "Player in blue dribbles in the center circle" },
      { seq: 2, windowTs: 3, text: "The striker shoots wide of the far post" },
    ];
    const ladder = render(log, { fastRail: false });
    expect(rowsOf(ladder).map((e) => e.text)).toEqual(log.map((r) => r.text));
  });
});
