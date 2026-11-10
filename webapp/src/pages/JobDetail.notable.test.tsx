import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard, HighlightMomentGrid, SecondaryHighlightLane } from "./JobDetail";
import { highlightMomentEntries, type JobDetailHighlight } from "../lib/jobDetail";

// ADAAAA-8530 (AC1) — ONE Highlights list. Notable moments render INSIDE the
// Highlights grid, ordered by moment start, with the same `HighlightCard` and clip
// rail they already carry; the separate "Notable — not a goal" lane is REMOVED
// (`data-detail-lane="notable"` no longer renders). A notable row with neither
// `clipUri` nor `clipError` stays a text row INSIDE that same list. The merged-clip
// lane is untouched: it is a dedupe ledger, not a moment list.
//
// This supersedes ADAAAA-8135's compact row and ADAAAA-8178's notable lane. The
// fixture is the job those tickets were filed about (95e454a3), so the parity
// assertion is measured on the same row. The node env has no jsdom, so assertions
// are on the SSR markup.

/** react-dom/server separates adjacent text nodes with `<!-- -->` markers;
 * strip them so assertions read the text a user actually sees. */
function text(html: string): string {
  return html.replace(/<!--\s*-->/g, "");
}

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "84ac3dc7-5e66-4122-8323-5a8c54ee00dc",
    jobId: "95e454a3-00eb-4de9-be58-ab3e7634add6",
    clipUri: "/clips/95e454a3-00eb-4de9-be58-ab3e7634add6-55.mp4",
    start: 5.468,
    end: 20.468,
    eventType: "BIG_PLAY",
    score: 85,
    outcome: "big_play",
    reason: "A player falls to the ground in celebration.",
    status: "accepted",
    createdAt: "2026-11-04T20:21:00Z",
    ...over,
  };
}

/** The postable GOAL on the same job (the "1 postable" half of the fixture). */
function postableGoal(): JobDetailHighlight {
  return hl({
    id: "7d1f5b90-0d3c-4a51-9b3e-2c9e6a3a1c11",
    clipUri: "/clips/95e454a3-00eb-4de9-be58-ab3e7634add6-60.mp4",
    start: 43.471,
    end: 58.471,
    eventType: "GOAL",
    outcome: "scoring_play",
    reason: "The scoreboard updates as the ball enters the net.",
  });
}

/** The ONE Highlights grid: postable rows + notable moments, ordered by start. */
function grid(postable: JobDetailHighlight[], notable: JobDetailHighlight[], admin = true) {
  return text(renderToString(
    React.createElement(HighlightMomentGrid, {
      entries: highlightMomentEntries(postable, notable),
      captionOf: () => "",
      admin,
    })
  ));
}

function count(html: string, marker: string): number {
  return html.split(marker).length - 1;
}

/** Card roots (`data-detail-highlight` on a card), excluding the grid container. */
function cards(html: string): number {
  return (html.match(/data-detail-highlight(?![-\w])/g) ?? []).length;
}

/** Notable moment cards inside the grid. */
function notableCards(html: string): number {
  return count(html, 'data-detail-notable-card="true"');
}

/** Rows in the list that stayed compact text rows (no footage, no clip error). */
function textOnlyRows(html: string): number {
  return count(html, 'data-detail-lane-row="notable"');
}

describe("notable moments are rows of the ONE Highlights grid (ADAAAA-8530 supersedes 8135/8178)", () => {
  it("renders the real highlight card for a notable moment that carries a clipUri", () => {
    const html = grid([], [hl()]);
    expect(notableCards(html)).toBe(1);
    expect(cards(html)).toBe(1);
    // The grid is the container; the removed lane is nowhere.
    expect(count(html, "data-detail-highlight-grid")).toBe(1);
    expect(count(html, 'data-detail-lane="notable"')).toBe(0);
    expect(html).not.toContain("Notable — not a goal");
    // The player is mounted on the card (its wait state until the video is near
    // the viewport — the same `VideoClip` the postable cards use).
    expect(html).toContain("clip loading");
    expect(html).not.toContain("Clip unavailable");
    // The card states the moment it covers, exactly like a postable card.
    expect(html).toContain("data-detail-moment-range");
    expect(html).toContain("T+5s");
    expect(html).toContain("T+20s");
    // ...and it carries the ONE confirmation badge + the posting surface.
    expect(count(html, "data-detail-confirmed-badge")).toBe(1);
    expect(html).toContain(">UNCONFIRMED<");
    expect(html).toContain("data-detail-caption");
    expect(html).toContain("data-detail-download");
    expect(html).toContain("data-detail-copy-link");
  });

  it("AC1: postable moments and three notable moments render as four cards in ONE list", () => {
    const page = grid(
      [postableGoal()],
      [
        hl({ id: "n1", start: 5, end: 20 }),
        hl({ id: "n2", start: 70, end: 85, outcome: "near_miss", eventType: "NEAR_MISS" }),
        hl({ id: "n3", start: 120, end: 135, clipUri: "/clips/95e454a3-…-121.mp4" }),
      ]
    );
    expect(notableCards(page)).toBe(3);
    // One postable card + three notable cards; every notable one is a real card.
    expect(cards(page)).toBe(4);
    expect(textOnlyRows(page)).toBe(0);
    // AC1: exactly one Highlights grid and no separate notable lane.
    expect(count(page, "data-detail-highlight-grid")).toBe(1);
    expect(count(page, 'data-detail-lane="notable"')).toBe(0);
    // One badge per card (AC2), and the order is by moment start (AC1).
    expect(count(page, "data-detail-confirmed-badge")).toBe(4);
    const starts = page
      .split("data-detail-moment-range")
      .slice(1)
      .map((chunk) => Number(/T\+(\d+)s/.exec(chunk)?.[1] ?? NaN));
    expect(starts).toEqual([5, 43, 70, 120]);
  });

  it("names 'Clip unavailable' with the stored reason when the row carries a clipError", () => {
    const html = grid([], [
      hl({ clipUri: "", clipError: "empty recording — the stream carried no frames" }),
    ]);
    expect(notableCards(html)).toBe(1);
    expect(html).toContain("Clip unavailable");
    expect(html).toContain("empty recording — the stream carried no frames");
    expect(textOnlyRows(html)).toBe(0);
  });

  it("keeps a text row INSIDE the list only when the record has neither a clip nor a clip error", () => {
    const html = grid([postableGoal()], [hl({ clipUri: "", clipError: undefined })]);
    expect(notableCards(html)).toBe(0);
    expect(cards(html)).toBe(1);
    expect(textOnlyRows(html)).toBe(1);
    // The text row sits inside the grid container, after the postable card.
    expect(html.indexOf("data-detail-highlight-grid")).toBeLessThan(
      html.indexOf('data-detail-lane-row="notable"')
    );
    expect(html).toContain("T+5s");
  });

  it("leaves the merged lane text-only (its footage lives in the kept moment)", () => {
    const html = text(renderToString(
      React.createElement(SecondaryHighlightLane, {
        lane: "merged",
        title: "Merged into a highlight",
        note: "Overlapping clips folded into the moment above so the same footage is not posted twice.",
        highlights: [hl({ duplicateOf: "abcdef123456" })],
      })
    ));
    expect(cards(html)).toBe(0);
    expect(count(html, "data-detail-notable-card")).toBe(0);
    expect(count(html, 'data-detail-lane-row="merged"')).toBe(1);
    expect(html).toContain("merged into abcdef12");
  });

  it("the customer (non-admin) notable card plays the clip, shows the badge and no internals", () => {
    const html = grid([], [hl()], false);
    expect(notableCards(html)).toBe(1);
    expect(html).toContain("clip loading");
    expect(count(html, "data-detail-confirmed-badge")).toBe(1);
    expect(html).toContain(">UNCONFIRMED<");
    // Pipeline internals only: the caption editor + title chips are the posting
    // surface and stay identical to the postable card (PO decision 3), so the
    // reason may seed a caption there — it never appears as a pipeline field.
    for (const internal of ["score 85", "BIG_PLAY", "outcome big_play", "data-detail-pipeline"]) {
      expect(html).not.toContain(internal);
    }
    // ADAAAA-7737's markup guard: the machine kind marker IS an outcome code, and
    // the lane marker is operator-only, so a customer session gets neither.
    expect(html).not.toContain("data-notable-kind");
    expect(html).not.toContain("data-confirm-lane");
  });

  it("the operator notable card keeps its internals in the collapsed Pipeline detail", () => {
    const html = grid([], [hl()]);
    expect(html).toContain("data-detail-pipeline");
    expect(html).toContain("BIG_PLAY");
    expect(html).toContain(">85<");
    expect(html).toContain("player falls to the ground");
    // The lane value is an operator read-out, so a grader can census it.
    expect(html).toContain('data-confirm-lane="absent"');
  });

  it("the postable card keeps the shipped Highlight label (no regression)", () => {
    const html = text(
      renderToString(
        React.createElement(HighlightCard, {
          highlight: postableGoal(),
          onDecision: () => {},
        })
      )
    );
    expect(html).toContain(">Highlight<");
    expect(html).not.toContain("data-detail-clip-rail-notable");
    expect(count(html, "data-detail-confirmed-badge")).toBe(1);
  });
});
