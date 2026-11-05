// ADAAAA-8043 (contract v7 §3.1/§3.5): the ladder is a READ surface, so it must
// render a stored, write-gated row byte-for-byte — including the colour beat the
// write seam DERIVED and stored (`colour` carries the measured signal). On the
// bounded level `dece44c3` the ladder dropped 3 of the 6 delivered beats
// (`A player controls the ball in the center — noise spikes over the play.` →
// `A player controls the ball in the center.`), which AC10 grades as a dropped
// colour clause.
import { describe, it, expect } from "vitest";
import { buildSummaryLadder } from "../src/summary-ladder";

const SIGNAL = {
  signal: "audio_noise" as const,
  ratio: 28.56,
  sustained: 0.28,
  peak: 0.21,
  peakT: 72,
  frameTs: 72,
  frameSeq: 216,
};

const ladder = (log: Array<Record<string, unknown>>, fastRail = true) =>
  buildSummaryLadder({ summaryLog: log as never, highlights: [] as never, gameHint: "soccer", fastRail });

const texts = (l: ReturnType<typeof ladder>): string[] =>
  l.chapters.flatMap((c) => c.entries.map((e) => e.text));

describe("v7 — the ladder renders a stored derived beat", () => {
  it("keeps the derived beat on a quiet row (stored `colour` present)", () => {
    const l = ladder([
      {
        seq: 1,
        ts: "t",
        windowTs: 73.66,
        verdict: "not_highlight",
        colour: SIGNAL,
        text: "A player controls the ball in the center — noise spikes over the play.",
      },
    ]);
    const rendered = texts(l);
    expect(rendered.some((t) => t.includes("noise spikes over the play"))).toBe(true);
    // The chapter DIGEST is a one-sentence rollup by design (it never carries
    // every beat); the delivered caption is the entry row.
  });

  it("still drops a LEGACY model clause on a quiet row (no stored signal)", () => {
    const l = ladder([
      {
        seq: 1,
        ts: "t",
        windowTs: 73.66,
        verdict: "not_highlight",
        text: "A player controls the ball in the center — crowd erupts.",
      },
    ]);
    const rendered = texts(l);
    for (const t of rendered) expect(t).not.toMatch(/crowd erupts/i);
  });

  it("keeps the lead inside the 8-word budget (AC5 measures before the beat)", () => {
    const l = ladder([
      {
        seq: 1,
        ts: "t",
        windowTs: 319.66,
        verdict: "not_highlight",
        colour: SIGNAL,
        text: "White player falls in the penalty area — noise spikes over the play.",
      },
    ]);
    const rendered = texts(l);
    expect(rendered[0]).toContain("noise spikes over the play");
    expect((rendered[0].split(/\s+[—–]\s+/)[0] ?? "").split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(8);
  });
});
