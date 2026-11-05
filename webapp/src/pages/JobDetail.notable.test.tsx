import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard, SecondaryHighlightLane } from "./JobDetail";
import type { JobDetailHighlight } from "../lib/jobDetail";

// ADAAAA-8135: the notable lane used to be text rows ONLY — so a play the
// scoring lane demoted ("Highlight detected" -> notable -> no clip) gave the user
// no way to watch it, even when the record carried a `clipUri`. Measured on job
// 95e454a3-00eb-4de9-be58-ab3e7634add6: the notable row 84ac3dc7 carries
// `/clips/95e454a3-…-55.mp4` and rendered as a bare text line.
//
// These tests pin the surface half of the fix: a notable row with footage renders
// the SAME playable card the postable feed uses (`data-detail-lane-clip`), a row
// with a `clipError` names "Clip unavailable", and the merged lane stays
// text-only. The node env has no jsdom, so the assertions are on the SSR markup.

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

function lane(highlights: JobDetailHighlight[], admin = true) {
  return text(renderToString(
    React.createElement(SecondaryHighlightLane, {
      lane: "notable",
      title: "Notable — not a goal",
      note: "Non-scoring plays (near miss / big play). They stay off the postable goal list.",
      tone: "yellow",
      highlights,
      admin,
    })
  ));
}

function count(html: string, marker: string): number {
  let n = 0;
  let at = html.indexOf(marker);
  while (at !== -1) {
    n += 1;
    at = html.indexOf(marker, at + marker.length);
  }
  return n;
}

/** Rows in the notable lane that render NO clip card, i.e. text-only rows. */
function textOnlyRows(html: string): number {
  return count(html, 'data-detail-lane-row="notable"') - count(html, 'data-detail-lane-clip="notable"');
}

describe("the notable lane plays the footage it carries (ADAAAA-8135)", () => {
  it("renders a playable clip card for a notable row that carries a clipUri", () => {
    const html = lane([hl()]);
    expect(count(html, 'data-detail-lane-clip="notable"')).toBe(1);
    // The player is mounted on the row (its wait state until the video is near
    // the viewport — the same `VideoClip` the postable cards use).
    expect(html).toContain("clip loading");
    expect(html).not.toContain("Clip unavailable");
    // The row still states the moment it covers.
    expect(html).toContain("T+5s");
    expect(html).toContain("T+20s");
  });

  it("AC1: the 95e454a3 fixture renders 1 playable notable card and 0 text-only rows carrying a clip", () => {
    const page = text(renderToString(
      React.createElement(
        "div",
        null,
        React.createElement(HighlightCard, { highlight: postableGoal(), onDecision: () => {} }),
        React.createElement(SecondaryHighlightLane, {
          lane: "notable",
          title: "Notable — not a goal",
          note: "Non-scoring plays (near miss / big play). They stay off the postable goal list.",
          tone: "yellow",
          highlights: [hl()],
        })
      )
    ));
    expect(count(page, 'data-detail-lane-clip="notable"')).toBe(1);
    expect(count(page, 'data-detail-lane-row="notable"')).toBe(1);
    expect(textOnlyRows(page)).toBe(0);
    // The postable goal keeps its own card (one `data-detail-highlight`), so the
    // notable card is a second, DISTINCT surface and not a re-presentation.
    expect(count(page, "data-detail-highlight")).toBe(1);
  });

  it("names 'Clip unavailable' with the stored reason when the row carries a clipError", () => {
    const html = lane([
      hl({ clipUri: "", clipError: "empty recording — the stream carried no frames" }),
    ]);
    expect(count(html, 'data-detail-lane-clip="notable"')).toBe(1);
    expect(html).toContain("Clip unavailable");
    expect(html).toContain("empty recording — the stream carried no frames");
    expect(textOnlyRows(html)).toBe(0);
  });

  it("keeps a text row only when the record has neither a clip nor a clip error", () => {
    const html = lane([hl({ clipUri: "", clipError: undefined })]);
    expect(count(html, 'data-detail-lane-clip="notable"')).toBe(0);
    expect(textOnlyRows(html)).toBe(1);
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
    expect(count(html, 'data-detail-lane-clip="merged"')).toBe(0);
    expect(html).toContain("merged into abcdef12");
  });

  it("the customer (non-admin) notable card plays the clip and keeps every internal off the row", () => {
    const html = lane([hl()], false);
    expect(count(html, 'data-detail-lane-clip="notable"')).toBe(1);
    expect(html).toContain("clip loading");
    for (const internal of ["score 85", "BIG_PLAY", "outcome big_play", "player falls to the ground"]) {
      expect(html).not.toContain(internal);
    }
  });

  it("the operator notable card keeps its internals beside the player", () => {
    const html = lane([hl()]);
    expect(html).toContain("score 85");
    expect(html).toContain("BIG_PLAY");
    expect(html).toContain("outcome big_play");
  });
});
