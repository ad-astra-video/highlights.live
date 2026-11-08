import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard, SecondaryHighlightLane } from "./JobDetail";
import { clipRailOptionLabel, clipRailSlides } from "../lib/clipRail";
import type { JobDetailHighlight } from "../lib/jobDetail";

// ADAAAA-8422 (N1) — the notable moment card: ONE card per overlap chain, the
// cluster's other windows on the card's clip rail.
//
// Measured shape being fixed: 5 non-scoring windows on a job with 0 accepted
// goals shipped as 5 cards where the board expects 2 moments with 2 and 3 clip
// options (job b55c5781-7976-4777-905c-847a06f3d3a8). The server now groups the
// notable rows into moments; this file pins the WEBAPP half — the same rail
// contract the postable card already ships (1 + up to 2 options), read-only in
// P1 (pick/serve is the P2 follow-on), and the honesty rule: a notable card
// never labels its clip a Highlight.
//
// The node env has no jsdom: assertions are on the SSR markup.

/** react-dom/server separates adjacent text nodes with `<!-- -->` markers. */
function text(html: string): string {
  return html.replace(/<!--\s*-->/g, "");
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** A notable moment card as the server delivers it: window 60-75 plus the two
 * sibling windows of the same moment (68-83, 76-91). */
function moment(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "hl-60",
    jobId: "b55c5781-7976-4777-905c-847a06f3d3a8",
    clipUri: "/clips/b55c5781-60.mp4",
    start: 60,
    end: 75,
    eventType: "BIG_PLAY",
    score: 60,
    outcome: "big_play",
    reason: "A player drives into the box and the keeper gathers the ball.",
    status: "accepted",
    createdAt: "2026-11-08T14:20:09Z",
    postTitle: "BIG PLAY · 1:00",
    siblingCount: 3,
    siblingClips: [
      {
        id: "hl-68",
        start: 68,
        end: 83,
        clipUri: "/clips/b55c5781-68.mp4",
        eventType: "BIG_PLAY",
        exportUri: "/clips/b55c5781-68.mp4?x=tok-68",
      },
      {
        id: "hl-76",
        start: 76,
        end: 91,
        clipUri: "/clips/b55c5781-76.mp4",
        eventType: "NEAR_MISS",
        exportUri: "/clips/b55c5781-76.mp4?x=tok-76",
      },
    ],
    ...over,
  };
}

function card(row: JobDetailHighlight, admin = true): string {
  return text(
    renderToString(React.createElement(HighlightCard, { highlight: row, notable: true, admin }))
  );
}

function lane(highlights: JobDetailHighlight[], admin = true): string {
  return text(
    renderToString(
      React.createElement(SecondaryHighlightLane, {
        lane: "notable",
        title: "Notable — not a goal",
        note: "Non-scoring plays (near miss / big play). They stay off the postable goal list.",
        tone: "yellow",
        highlights,
        admin,
      })
    )
  );
}

describe("N1-AC1/AC2 — the rail carries the moment's sibling clips", () => {
  it("renders 1 + N options on the shipped rail markers", () => {
    const html = card(moment());
    // The shipped rail contract, unchanged markup:
    expect(count(html, 'data-detail-clip-rail="true"')).toBe(1);
    expect(html).toContain('data-clip-count="3"');
    // N1: the moment marker + the option count.
    expect(html).toContain("data-detail-clip-rail-notable");
    expect(html).toContain('data-clip-options="2"');
    // One slide for the moment's own clip + one per sibling, each its own stored
    // clip (no re-encode: the URIs are the rows' own).
    expect(count(html, "data-detail-clip-slide")).toBe(3);
    expect(count(html, "data-detail-sibling-clip")).toBe(2);
    expect(html).toContain("/clips/b55c5781-68.mp4");
    expect(html).toContain("/clips/b55c5781-76.mp4");
    // The badge reports the same count the rail does.
    expect(html).toContain("3 clips");
    // Prev/next exist because there is more than one clip.
    expect(html).toContain("data-detail-clip-prev");
    expect(html).toContain("data-detail-clip-next");
  });

  it("each option is read-only: a label + its OWN download, never a pick button", () => {
    const html = card(moment());
    // ADAAAA-8321's picker is NOT offered for a notable moment (P2 follow-on).
    expect(html).not.toContain("data-detail-clip-pick=");
    expect(html).not.toContain("Use this clip");
    expect(html).not.toContain("Serving — use original");
    // The read-only option line reuses the shipped pick-label marker plus its own.
    expect(count(html, "data-detail-clip-pick-label")).toBe(2);
    expect(count(html, "data-detail-clip-option-label")).toBe(2);
    // Each option downloads ITS OWN clip, through its own per-caller export URL.
    expect(count(html, "data-detail-clip-option-download")).toBe(2);
    expect(html).toContain('href="/clips/b55c5781-68.mp4?x=tok-68"');
    expect(html).toContain('href="/clips/b55c5781-76.mp4?x=tok-76"');
    // The moment's own download/copy affordances are untouched (ADAAAA-8178).
    expect(html).toContain("data-detail-download");
    expect(html).toContain("data-detail-copy-link");
  });

  it("a single-window moment renders one slide and NO options (unchanged today)", () => {
    const html = card(moment({ siblingClips: undefined, siblingCount: 1 }));
    expect(count(html, 'data-detail-clip-rail="true"')).toBe(1);
    expect(html).toContain('data-clip-count="1"');
    expect(html).not.toContain("data-clip-options");
    expect(count(html, "data-detail-sibling-clip")).toBe(0);
    expect(html).not.toContain("data-detail-clip-option-label");
    expect(html).not.toContain("data-detail-clip-prev");
    // No multi-clip badge on a lone window.
    expect(html).not.toContain("data-detail-clip-count-badge");
  });

  it("the lane renders ONE card per moment", () => {
    const html = lane([
      moment(),
      moment({ id: "hl-200", start: 200, end: 215, siblingClips: undefined, siblingCount: 1 }),
    ]);
    expect(count(html, 'data-detail-notable-card="true"')).toBe(2);
    expect(count(html, "data-detail-notable-card-grid")).toBe(1);
  });
});

describe("N1-AC4 — honesty: a notable moment is never labelled a highlight", () => {
  it("the rail identity says Moment / Clip, never Highlight", () => {
    const html = card(moment());
    // The identity line of every slide is customer copy.
    expect(count(html, "data-detail-clip-identity")).toBe(3);
    expect(html).toContain("Moment");
    expect(html).toContain("Clip");
    expect(html).not.toContain("Highlight ·");
    expect(html).not.toMatch(/>Highlight</);
    // The option line names the moment, not a score claim.
    expect(html).toContain("Same moment · T+68s – T+83s");
  });

  it("keeps the lane line and never asserts a score", () => {
    const html = lane([moment()]);
    expect(html).toContain("Notable — not a goal");
    expect(html).toContain("Non-scoring plays");
    for (const claim of ["scored", "Goal!", "GOAL", "Highlight"]) {
      expect(html).not.toContain(claim);
    }
  });

  it("the postable card keeps the shipped Highlight label (no regression)", () => {
    const html = text(
      renderToString(
        React.createElement(HighlightCard, {
          highlight: moment({ outcome: "scoring_play", eventType: "GOAL", siblingClips: undefined }),
          onDecision: () => {},
        })
      )
    );
    expect(html).toContain(">Highlight<");
    expect(html).toContain("Highlight");
    expect(html).not.toContain("data-detail-clip-rail-notable");
  });
});

describe("clipRailSlides — siblings ride the same rail, after the moment's clip", () => {
  it("orders the moment's own clip first, then its options", () => {
    const slides = clipRailSlides(moment());
    expect(slides.map((s) => s.kind)).toEqual(["highlight", "sibling", "sibling"]);
    expect(slides.map((s) => s.src)).toEqual([
      "/clips/b55c5781-60.mp4",
      "/clips/b55c5781-68.mp4",
      "/clips/b55c5781-76.mp4",
    ]);
    // A sibling is never pickable (no alternativeId) but keeps its own id/export.
    expect(slides[1].alternativeId).toBeUndefined();
    expect(slides[1].siblingClipId).toBe("hl-68");
    expect(slides[1].exportUri).toBe("/clips/b55c5781-68.mp4?x=tok-68");
    expect(clipRailOptionLabel(slides[1])).toBe("Same moment · T+68s – T+83s");
  });

  it("a delivered celebration alternative still rides the postable rail unchanged", () => {
    const slides = clipRailSlides(
      moment({
        siblingClips: undefined,
        alternatives: [
          {
            id: "alt-1",
            jobId: "b55c5781-7976-4777-905c-847a06f3d3a8",
            highlightId: "hl-60",
            relation: "alternative_of",
            eventType: "celebration",
            windowAnchorTs: 90,
            start: 90,
            end: 105,
            clipUri: "/clips/b55c5781-90.mp4",
            createdAt: "2026-11-08T14:20:09Z",
          },
        ],
      })
    );
    expect(slides.map((s) => s.kind)).toEqual(["highlight", "celebration"]);
    expect(slides[1].alternativeId).toBe("alt-1");
  });
});
