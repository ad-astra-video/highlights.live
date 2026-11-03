import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import {
  AnalysisWindow,
  AnalysisWindowList,
  CustomerAnalysisWindow,
  CustomerAnalysisSection,
  CustomerInspectWindow,
} from "./JobDetail";
import { mergedGroupsByWindow, mergedMomentGroups, type FrameSection, type JobDetailHighlight } from "../lib/jobDetail";

// ADAAAA-7881 / AC5: the card's removed "N merged" badge is replaced by a
// connector in the Analysis window list. The fixture is the QA job d61e52f6,
// whose dedupe folds 3 moments out of 7 overlapping clips:
//
//   66eabac3 (359.2–374.2) absorbed 2 clips: 1bf34f24 (341.8–356.8), 6eebfb87 (351.8–366.8)
//   a6976d26 (579.4–594.4) absorbed 1 clip:  e7bdda17 (565.8–580.8)
//   63205b13 (755.0–770.0) absorbed 1 clip:  d6fd609b (765.1–780.1)
//
// Derivation is client-side and pure: the payload the job-detail page already
// holds (`highlights` + `duplicateHighlights` + `sections`) is enough.

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "moment",
    jobId: "d61e52f6-7569-4757-bffc-f56d03e10b6a",
    clipUri: "/clips/x.mp4",
    start: 0,
    end: 15,
    eventType: "GOAL",
    score: 90,
    status: "accepted",
    outcome: "scoring_play",
    createdAt: "2026-10-31T14:19:58.474Z",
    ...over,
  };
}

const MOMENTS: JobDetailHighlight[] = [
  hl({ id: "66eabac3-aaaa", start: 359.2, end: 374.2, duplicateCount: 2, mergedIds: ["1bf34f24-bbbb", "6eebfb87-cccc"] }),
  hl({ id: "a6976d26-dddd", start: 579.4, end: 594.4, duplicateCount: 1, mergedIds: ["e7bdda17-eeee"] }),
  hl({ id: "63205b13-ffff", start: 755, end: 770, duplicateCount: 1, mergedIds: ["d6fd609b-9999"] }),
];

const FOLDED: JobDetailHighlight[] = [
  hl({ id: "1bf34f24-bbbb", start: 341.8, end: 356.8, duplicateOf: "66eabac3-aaaa" }),
  hl({ id: "6eebfb87-cccc", start: 351.8, end: 366.8, duplicateOf: "66eabac3-aaaa" }),
  hl({ id: "e7bdda17-eeee", start: 565.8, end: 580.8, duplicateOf: "a6976d26-dddd" }),
  hl({ id: "d6fd609b-9999", start: 765.1, end: 780.1, duplicateOf: "63205b13-ffff" }),
];

/** 3 s Analysis buckets from `from` to `to` (exclusive), reindexed from `startIndex`. */
function buckets(from: number, to: number, startIndex: number): FrameSection[] {
  const out: FrameSection[] = [];
  let index = startIndex;
  for (let startS = from; startS < to; startS += 3) {
    out.push({ index, startS, endS: startS + 3, frames: [], decideNotes: [] });
    index += 1;
  }
  return out;
}

const SECTIONS: FrameSection[] = [
  ...buckets(342, 375, 0), // 0..10  → moment 66eabac3 (341.8–374.2)
  ...buckets(566, 595, 11), // 11..20 → moment a6976d26 (565.8–594.4)
  ...buckets(753, 780, 21), // 21..29 → moment 63205b13 (755–780.1)
  ...buckets(900, 903, 30), // 30     → unrelated window, no moment
];
const DECOY_INDEX = 30;

describe("mergedMomentGroups — client-side derivation (ADAAAA-7881)", () => {
  const groups = mergedMomentGroups(MOMENTS, FOLDED, SECTIONS);

  it("yields one group per merged moment, with the right clip count", () => {
    expect(groups.map((g) => g.momentId)).toEqual(["66eabac3-aaaa", "a6976d26-dddd", "63205b13-ffff"]);
    expect(groups.map((g) => g.clipCount)).toEqual([3, 2, 2]);
    expect(groups.map((g) => g.label)).toEqual([
      "One moment · 3 clips",
      "One moment · 2 clips",
      "One moment · 2 clips",
    ]);
  });

  it("maps every window that carries the moment's footage, and no others", () => {
    const [first] = groups;
    // Union of 341.8–374.2 → every 3 s bucket from 342 to 374.
    expect(first.memberIndexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(groups[1].memberIndexes).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(groups[2].memberIndexes).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29]);
    for (const group of groups) expect(group.memberIndexes).not.toContain(DECOY_INDEX);
  });

  it("names the span accessibly", () => {
    expect(groups[0].ariaLabel).toBe("Windows T+342s–T+374s are one highlight");
    expect(groups[1].ariaLabel).toBe("Windows T+566s–T+594s are one highlight");
    expect(groups[2].ariaLabel).toBe("Windows T+755s–T+780s are one highlight");
  });

  it("indexes the members back to their group", () => {
    const byWindow = mergedGroupsByWindow(groups);
    expect(byWindow.size).toBe(30);
    expect(byWindow.get(5)?.momentId).toBe("66eabac3-aaaa");
    expect(byWindow.get(DECOY_INDEX)).toBeUndefined();
  });

  it("legacy payloads without duplicateHighlights yield no groups", () => {
    expect(mergedMomentGroups(MOMENTS.map((m) => ({ ...m, duplicateCount: undefined })), [], SECTIONS)).toEqual([]);
    expect(mergedMomentGroups(MOMENTS, undefined, SECTIONS)).toEqual([]);
  });
});

describe("AC5 — the Analysis list draws one connector per merged moment (ADAAAA-7881)", () => {
  const groups = mergedMomentGroups(MOMENTS, FOLDED, SECTIONS);
  const count = (html: string, needle: string) => html.split(needle).length - 1;

  /** Each of the three row variants rendered through the shared grouped list. */
  const variants: { name: string; render: (s: FrameSection) => React.ReactNode }[] = [
    { name: "CustomerAnalysisWindow", render: (s) => React.createElement(CustomerAnalysisWindow, { section: s }) },
    {
      name: "CustomerInspectWindow",
      render: (s) =>
        React.createElement(CustomerInspectWindow, {
          section: s,
          jobId: "d61e52f6",
          inspection: undefined,
          onInspect: () => {},
        }),
    },
    {
      name: "admin AnalysisWindow",
      render: (s) =>
        React.createElement(AnalysisWindow, {
          section: s,
          token: null,
          jobId: "d61e52f6",
          selectMode: false,
          selectedSeqs: new Set<number>(),
          onFrameClick: () => {},
          admin: true,
        }),
    },
  ];

  for (const variant of variants) {
    it(`${variant.name}: 3 groups, 30 member rows, later windows untouched`, () => {
      const html = renderToString(
        React.createElement(AnalysisWindowList, {
          sections: SECTIONS,
          groups,
          renderWindow: variant.render,
        })
      );
      expect(count(html, "data-merged-moment-group=")).toBe(3);
      expect(count(html, "data-merged-moment-window=")).toBe(30);
      expect(count(html, "data-analysis-window=")).toBe(SECTIONS.length);
      // Group labels + accessible names.
      expect(html).toContain("One moment · 3 clips");
      expect(count(html, "One moment · 2 clips")).toBe(2);
      expect(html).toContain("Windows T+342s–T+374s are one highlight");
      // The decoy window sits outside every rail.
      const decoy = html.slice(html.indexOf('data-section-index="30"'));
      expect(decoy).not.toContain("data-merged-moment-window=");
    });

    it(`${variant.name}: a job without duplicates renders exactly as before`, () => {
      const html = renderToString(
        React.createElement(AnalysisWindowList, {
          sections: SECTIONS,
          groups: [],
          renderWindow: variant.render,
        })
      );
      expect(count(html, "data-merged-moment-group=")).toBe(0);
      expect(count(html, "data-merged-moment-window=")).toBe(0);
      expect(count(html, "data-analysis-window=")).toBe(SECTIONS.length);
    });
  }

  it("the customer Analysis section renders the same groups (page path)", () => {
    const html = renderToString(
      React.createElement(CustomerAnalysisSection, {
        sections: SECTIONS,
        mergedGroups: groups,
      })
    );
    expect(count(html, "data-merged-moment-group=")).toBe(3);
    expect(count(html, "data-merged-moment-window=")).toBe(30);
  });

  it("a non-adjacent member keeps the rail without swallowing the rows between", () => {
    // Drop the middle windows of the first moment from the list (filtered view):
    // the survivors still carry the rail and no unrelated row is wrapped.
    const sparse = [SECTIONS[0], SECTIONS[1], SECTIONS[30]];
    const html = renderToString(
      React.createElement(AnalysisWindowList, {
        sections: sparse,
        groups,
        renderWindow: (s) => React.createElement(CustomerAnalysisWindow, { section: s }),
      })
    );
    expect(count(html, "data-merged-moment-group=")).toBe(1);
    expect(count(html, "data-merged-moment-window=")).toBe(2);
    const decoy = html.slice(html.indexOf('data-section-index="30"'));
    expect(decoy).not.toContain("data-merged-moment-window=");
  });
});
