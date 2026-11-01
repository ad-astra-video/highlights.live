// ADAAAA-7623 — the summary LADDER (match rollup + chapters + window narratives)
// rendered above the flat Video Summary log.
//
// SSR (renderToString) contract tests: rung 1 (one match summary), rung 2 (the
// chapter outline with kind/time/goal chips), and the graceful legacy path (no
// ladder => renders nothing, page unchanged). The expandable window narratives
// (rung 3) and the jump into the Analysis window are click state, so in SSR we
// assert the collapsed contract plus the helper contract that maps a window
// narrative onto its Analysis section.
import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { SummaryLadderView } from "./SummaryLadder";
import { chapterKindLabel, focusAnalysisWindow, ladderClock, ladderSectionIndex, type SummaryLadder } from "../lib/jobDetail";

const ladder: SummaryLadder = {
  chapters: [
    {
      index: 0,
      kind: "lull",
      title: "Kick-off ceremony",
      startS: 0,
      endS: 39,
      summary: "Young fans pose for a pre-match photo; no live play.",
      goalCount: 1,
      goals: [{ index: 1, ts: 31.3, verified: true }],
      seqFrom: 1,
      seqTo: 13,
      entries: [
        { seq: 1, windowTs: 0, text: "A group of young fans in Barcelona kits pose for a photo." },
        { seq: 11, windowTs: 31, text: "The striker finishes low into the corner." },
      ],
    },
    {
      index: 1,
      kind: "build-up",
      title: "First sustained attack",
      startS: 39,
      endS: 69,
      summary: "The blue-jerseyed attacker moves into the final third.",
      goalCount: 0,
      goals: [],
      seqFrom: 14,
      seqTo: 23,
      entries: [{ seq: 14, windowTs: 39, text: "The attacker drives at the defence." }],
    },
    {
      index: 2,
      kind: "goal-cluster",
      title: "Two quick finishes",
      startS: 69,
      endS: 120,
      summary: "Two finishes inside a minute.",
      goalCount: 2,
      goals: [
        { index: 2, ts: 69.5, verified: true },
        { index: 3, ts: 115.6, verified: false },
      ],
      seqFrom: 24,
      seqTo: 40,
      entries: [{ seq: 24, windowTs: 69, text: "A shot from the edge of the box finds the net." }],
    },
  ],
  matchSummary: {
    text: "Soccer · 2:00 · 3 chapters · 3 accepted goals (2 corroborated)\n- Lull · 0:00–0:39: pre-match photo\n- Build-up · 0:39–1:09: sustained attack\n- Goal cluster (2) · 1:09–2:00: two finishes\nGoals in order: #1 0:31, #2 1:09, #3 1:55 (never corroborated)",
    charCount: 260,
    chapterCount: 3,
    goalCount: 3,
    verifiedGoalCount: 2,
    goalTimeline: [
      { index: 1, ts: 31.3, verified: true },
      { index: 2, ts: 69.5, verified: true },
      { index: 3, ts: 115.6, verified: false },
    ],
    refusedScoreClaims: ["0-0", "0-1", "5-4"],
  },
  derivedFrom: { summaryLogEntries: 40, acceptedHighlights: 3 },
};

const render = (el: React.ReactElement) => renderToString(el).replace(/<!-- -->/g, "");

describe("summary ladder view (ADAAAA-7623)", () => {
  it("renders one match summary and the chapter outline", () => {
    const html = render(React.createElement(SummaryLadderView, { ladder }));
    expect(html).toContain("Match Summary");
    // rung 1: the rollup text, incl. the ordered goal line
    expect(html).toContain("Soccer · 2:00 · 3 chapters · 3 accepted goals (2 corroborated)");
    expect(html).toContain("Goals in order: #1 0:31, #2 1:09, #3 1:55 (never corroborated)");
    // rung 2: every chapter row + its kind label, time range and goal chip
    expect(html.match(/data-detail-ladder-chapter="true"/g)?.length).toBe(3);
    expect(html.match(/data-chapter-index=/g)?.length).toBe(3);
    for (const label of ["Lull", "Build-up", "Goal cluster"]) expect(html).toContain(label);
    expect(html).toContain("0:00–0:39");
    expect(html).toContain("1:09–2:00");
    expect(html).toContain("2 goals");
    expect(html).toContain("2 windows");
  });

  it("surfaces the fact gate: refused score strings are audited, never asserted", () => {
    const html = render(React.createElement(SummaryLadderView, { ladder }));
    expect(html).toContain("Score strings refused by the fact gate: 0-0, 0-1, 5-4");
    // the rollup itself carries no score-shaped token (the fact gate stripped them)
    const rollup = ladder.matchSummary.text;
    expect(/\d\s*[-–]\s*\d/.test(rollup.replace(/\d:\d{2}/g, ""))).toBe(false);
  });

  it("says how many goals are uncorroborated instead of asserting them", () => {
    const html = render(React.createElement(SummaryLadderView, { ladder }));
    expect(html).toContain("1 of 3 accepted goals are not corroborated by frames");
  });

  it("renders nothing for a job without a ladder (legacy page unchanged)", () => {
    expect(render(React.createElement(SummaryLadderView, { ladder: undefined }))).toBe("");
    expect(render(React.createElement(SummaryLadderView, { ladder: { ...ladder, chapters: [] } }))).toBe("");
  });

  it("drills a window narrative into its Analysis window (same 3 s bucket)", () => {
    expect(ladderSectionIndex(0)).toBe(0);
    expect(ladderSectionIndex(31)).toBe(10);
    expect(ladderSectionIndex(69.5)).toBe(23);
    expect(ladderSectionIndex(-4)).toBe(0);
  });

  it("formats ladder timestamps and chapter kinds deterministically", () => {
    expect(ladderClock(0)).toBe("0:00");
    expect(ladderClock(31.9)).toBe("0:31");
    expect(ladderClock(780)).toBe("13:00");
    expect(chapterKindLabel("goal-cluster")).toBe("Goal cluster");
    expect(chapterKindLabel("build-up")).toBe("Build-up");
    expect(chapterKindLabel("lull")).toBe("Lull");
    expect(chapterKindLabel("phase")).toBe("Phase");
  });
});

describe("detail-on-demand hop (ADAAAA-7623)", () => {
  it("scrolls the Analysis window covering the instant and flags it", () => {
    const calls: string[] = [];
    const classes = new Set<string>();
    const el = {
      scrollIntoView: (opts: ScrollIntoViewOptions) => calls.push(`scroll:${JSON.stringify(opts)}`),
      classList: {
        add: (...c: string[]) => c.forEach((x) => classes.add(x)),
        remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
      },
    };
    const root = { querySelector: (sel: string) => (sel.includes('data-section-index="23"') ? el : null) };
    const hit = focusAnalysisWindow(root as unknown as Pick<Document, "querySelector">, 23, 0);
    expect(hit).toBe(el);
    // instant, never `behavior: "smooth"` — a smooth rAF scroll is suspended in
    // a background tab and silently scrolls nowhere on a >100k px Analysis list
    expect(calls).toEqual(['scroll:{"block":"center"}']);
    expect([...classes]).toEqual(["ring-2", "ring-neon"]);
  });

  it("is a no-op when the job has no Analysis window for that instant", () => {
    const root = { querySelector: () => null };
    expect(focusAnalysisWindow(root as unknown as Pick<Document, "querySelector">, 999, 0)).toBeNull();
  });
});
