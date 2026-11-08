import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard, SecondaryHighlightLane } from "./JobDetail";
import { clipRailOptionLabel, clipRailSlides } from "../lib/clipRail";
import type { JobDetailHighlight } from "../lib/jobDetail";

// ADAAAA-8422 (N1) + ADAAAA-8443 (N1b) — the notable moment card: ONE card per
// MOMENT (anchor-gap cluster), the cluster's other windows on the card's clip rail.
//
// Measured shape being fixed: 5 non-scoring windows on a job with 0 accepted
// goals shipped as 5 cards where the board expects 2 moments with 2 and 3 clip
// options (job b55c5781-7976-4777-905c-847a06f3d3a8). N1 grouped by strict
// overlap (4 moments on that geometry, QA FAIL); N1b groups by anchor gap (40 s)
// and raises the notable rail to 1 + up to 3 options. This file pins the WEBAPP
// half — the same rail contract the postable card ships, read-only in P1
// (pick/serve is the P2 follow-on), and the honesty rule: a notable card never
// labels its clip a Highlight.
//
// The node env has no jsdom: assertions are on the SSR markup.

/** react-dom/server separates adjacent text nodes with `<!-- -->` markers. */
function text(html: string): string {
  return html.replace(/<!--\s*-->/g, "");
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** The measured second moment of job b55c5781 as the server delivers it: owner
 * b7fb1898 (685.135-700.135) plus its two sibling windows 128ab571
 * (697.930-712.930, a real overlap) and 69118d51 (725.182-740.182, 12.252 s
 * after the chain ends). */
function moment(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "b7fb1898",
    jobId: "b55c5781-7976-4777-905c-847a06f3d3a8",
    clipUri: "/clips/b55c5781-b7fb1898.mp4",
    start: 685.135,
    end: 700.135,
    eventType: "BIG_PLAY",
    score: 60,
    outcome: "big_play",
    reason: "A player drives into the box and the keeper gathers the ball.",
    status: "accepted",
    createdAt: "2026-11-08T14:20:09Z",
    postTitle: "BIG PLAY · 11:25",
    siblingCount: 3,
    siblingClips: [
      {
        id: "128ab571",
        start: 697.93,
        end: 712.93,
        clipUri: "/clips/b55c5781-128ab571.mp4",
        eventType: "BIG_PLAY",
        exportUri: "/clips/b55c5781-128ab571.mp4?x=tok-128",
      },
      {
        id: "69118d51",
        start: 725.182,
        end: 740.182,
        clipUri: "/clips/b55c5781-69118d51.mp4",
        eventType: "NEAR_MISS",
        exportUri: "/clips/b55c5781-69118d51.mp4?x=tok-691",
      },
    ],
    ...over,
  };
}

/** The measured FIRST moment: owner 02e9bf4e with its one sibling 5f8d9d07 (the
 * two windows are 35.988 s apart at the anchor and never overlap — the pair that
 * strict overlap split into two cards). */
function firstMoment(): JobDetailHighlight {
  return {
    id: "02e9bf4e",
    jobId: "b55c5781-7976-4777-905c-847a06f3d3a8",
    clipUri: "/clips/b55c5781-02e9bf4e.mp4",
    start: 255.4,
    end: 270.4,
    eventType: "BIG_PLAY",
    score: 60,
    outcome: "big_play",
    reason: "A player drives into the box and the keeper gathers the ball.",
    status: "accepted",
    createdAt: "2026-11-08T14:20:09Z",
    postTitle: "BIG PLAY · 4:15",
    siblingCount: 2,
    siblingClips: [
      {
        id: "5f8d9d07",
        start: 306.388,
        end: 321.388,
        clipUri: "/clips/b55c5781-5f8d9d07.mp4",
        eventType: "BIG_PLAY",
        exportUri: "/clips/b55c5781-5f8d9d07.mp4?x=tok-5f8",
      },
    ],
  };
}

/** The widest moment the 14-row job produces (5 windows): the server caps the
 * rail at 3 siblings, so the card renders 4 slides while `siblingCount` still
 * says 5 — a grader can see the suppression. */
function wideMoment(): JobDetailHighlight {
  const siblings = ["s1", "s2", "s3"].map((id, i) => ({
    id,
    start: 1606.599 + i * 8,
    end: 1621.599 + i * 8,
    clipUri: `/clips/b55c5781-${id}.mp4`,
    eventType: "BIG_PLAY",
    exportUri: `/clips/b55c5781-${id}.mp4?x=tok-${id}`,
  }));
  return { ...moment({ id: "wide", start: 1606.599, end: 1621.599 }), siblingCount: 5, siblingClips: siblings };
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

describe("N1-AC1/AC2, N1b-AC1 — the rail carries the moment's sibling clips", () => {
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
    expect(html).toContain("/clips/b55c5781-128ab571.mp4");
    expect(html).toContain("/clips/b55c5781-69118d51.mp4");
    // The badge reports the same count the rail does.
    expect(html).toContain("3 clips");
    // Prev/next exist because there is more than one clip.
    expect(html).toContain("data-detail-clip-prev");
    expect(html).toContain("data-detail-clip-next");
  });

  it("the 5-window moment renders 4 slides / 3 options (N1b rail cap)", () => {
    const html = card(wideMoment());
    expect(html).toContain('data-clip-count="4"');
    expect(html).toContain('data-clip-options="3"');
    expect(count(html, "data-detail-sibling-clip")).toBe(3);
    expect(html).toContain("4 clips");
    // The rail never renders the suppressed 5th window (the server dropped it
    // from `siblingClips` and counted it in `optionsSuppressed`).
    expect(count(html, "data-detail-sibling-clip")).toBe(3);
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
    expect(html).toContain('href="/clips/b55c5781-128ab571.mp4?x=tok-128"');
    expect(html).toContain('href="/clips/b55c5781-69118d51.mp4?x=tok-691"');
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
    // DECISION (QA re-grade AC5): `data-detail-clip-rail="true"` is the CONTAINER
    // marker and stays on every card — a one-clip card still has a rail element.
    // "Is this a multi-clip rail?" is `data-clip-options` + `role=group`, which a
    // passive rail must not carry: no group role, not focusable, no aria-label.
    expect(html).toContain('data-detail-clip-rail="true"');
    expect(html).not.toMatch(/data-detail-clip-rail="true"[^>]*role="group"/);
    expect(html).not.toMatch(/data-detail-clip-rail="true"[^>]*tabindex="0"/);
    expect(html).toContain('tabindex="-1"');
    expect(html).not.toMatch(/data-detail-clip-rail="true"[^>]*aria-label/);
  });

  it("the lane renders ONE card per moment: 2 measured moments, rails of 2 and 3", () => {
    const html = lane([firstMoment(), moment()]);
    expect(count(html, 'data-detail-notable-card="true"')).toBe(2);
    expect(count(html, "data-detail-notable-card-grid")).toBe(1);
    // N1b-AC1 rendered membership: card 1 owns 02e9bf4e with 5f8d9d07 as its one
    // option; card 2 owns b7fb1898 with 128ab571 and 69118d51 as its options.
    expect(count(html, 'data-clip-count="2"')).toBe(1);
    expect(count(html, 'data-clip-count="3"')).toBe(1);
    expect(count(html, 'data-clip-options="1"')).toBe(1);
    expect(count(html, 'data-clip-options="2"')).toBe(1);
    expect(count(html, "data-detail-sibling-clip")).toBe(3);
    const rails = html.split('data-detail-clip-rail="true"').slice(1);
    expect(rails[0]).toContain("/clips/b55c5781-5f8d9d07.mp4");
    expect(rails[0]).not.toContain("/clips/b55c5781-128ab571.mp4");
    expect(rails[1]).toContain("/clips/b55c5781-128ab571.mp4");
    expect(rails[1]).toContain("/clips/b55c5781-69118d51.mp4");
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
    expect(html).toContain("Same moment · T+698s – T+713s");
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
      "/clips/b55c5781-b7fb1898.mp4",
      "/clips/b55c5781-128ab571.mp4",
      "/clips/b55c5781-69118d51.mp4",
    ]);
    // A sibling is never pickable (no alternativeId) but keeps its own id/export.
    expect(slides[1].alternativeId).toBeUndefined();
    expect(slides[1].siblingClipId).toBe("128ab571");
    expect(slides[1].exportUri).toBe("/clips/b55c5781-128ab571.mp4?x=tok-128");
    expect(clipRailOptionLabel(slides[1])).toBe("Same moment · T+698s – T+713s");
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
