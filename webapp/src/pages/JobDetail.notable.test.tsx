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
// ADAAAA-8178 (this file's current contract): ADAAAA-8135's compact clip row is
// replaced by the REAL `HighlightCard` — the same component the postable feed
// mounts — with one notable badge and no verdict slot / batch checkbox. The
// fixture below is the same job, so the parity assertion is measured on the row
// the ticket was filed about. A row with neither `clipUri` nor `clipError` stays
// a text row, and the merged lane stays text-only. The node env has no jsdom, so
// assertions are on the SSR markup.

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

/** Cards the notable lane mounted (`data-detail-highlight` + the notable tag). */
function notableCards(html: string): number {
  return count(html, 'data-detail-notable-card="true"');
}

/** Rows in the notable lane that stayed compact text rows (no footage). */
function textOnlyRows(html: string): number {
  return count(html, 'data-detail-lane-row="notable"');
}

describe("the notable lane renders the postable card (ADAAAA-8178, supersedes 8135's compact row)", () => {
  it("renders the real highlight card for a notable row that carries a clipUri", () => {
    const html = lane([hl()]);
    expect(notableCards(html)).toBe(1);
    expect(count(html, "data-detail-highlight")).toBe(1);
    // The player is mounted on the card (its wait state until the video is near
    // the viewport — the same `VideoClip` the postable cards use).
    expect(html).toContain("clip loading");
    expect(html).not.toContain("Clip unavailable");
    // The card states the moment it covers, exactly like a postable card.
    expect(html).toContain("data-detail-moment-range");
    expect(html).toContain("T+5s");
    expect(html).toContain("T+20s");
    // ...and it carries the notable badge + the posting surface.
    expect(html).toContain('data-notable-kind="big_play"');
    expect(html).toContain("BIG PLAY");
    expect(html).toContain("data-detail-caption");
    expect(html).toContain("data-detail-download");
    expect(html).toContain("data-detail-copy-link");
  });

  it("AC1: three notable rows with footage render three cards and no compact rows", () => {
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
          highlights: [
            hl({ id: "n1", start: 5, end: 20 }),
            hl({ id: "n2", start: 70, end: 85, outcome: "near_miss", eventType: "NEAR_MISS" }),
            hl({ id: "n3", start: 120, end: 135, clipUri: "/clips/95e454a3-…-121.mp4" }),
          ],
        })
      )
    ));
    expect(notableCards(page)).toBe(3);
    // One postable card + three notable cards; every notable one is a real card.
    expect(count(page, "data-detail-highlight")).toBe(4);
    expect(textOnlyRows(page)).toBe(0);
    // The lane wrapper is still the QA target it was before.
    expect(count(page, 'data-detail-lane="notable"')).toBe(1);
    expect(count(page, "data-detail-notable-badge")).toBe(3);
    expect(count(page, "data-detail-notable-card-grid")).toBe(1);
  });

  it("names 'Clip unavailable' with the stored reason when the row carries a clipError", () => {
    const html = lane([
      hl({ clipUri: "", clipError: "empty recording — the stream carried no frames" }),
    ]);
    expect(notableCards(html)).toBe(1);
    expect(html).toContain("Clip unavailable");
    expect(html).toContain("empty recording — the stream carried no frames");
    expect(textOnlyRows(html)).toBe(0);
  });

  it("keeps a text row only when the record has neither a clip nor a clip error", () => {
    const html = lane([hl({ clipUri: "", clipError: undefined })]);
    expect(notableCards(html)).toBe(0);
    expect(count(html, "data-detail-highlight")).toBe(0);
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
    expect(count(html, "data-detail-highlight")).toBe(0);
    expect(count(html, "data-detail-notable-card")).toBe(0);
    expect(count(html, 'data-detail-lane-row="merged"')).toBe(1);
    expect(html).toContain("merged into abcdef12");
  });

  it("the customer (non-admin) notable card plays the clip, shows the badge and no internals", () => {
    const html = lane([hl()], false);
    expect(notableCards(html)).toBe(1);
    expect(html).toContain("clip loading");
    expect(html).toContain("BIG PLAY");
    // Pipeline internals only: the caption editor + title chips are the posting
    // surface and stay identical to the postable card (PO decision 3), so the
    // reason may seed a caption there — it never appears as a pipeline field.
    for (const internal of ["score 85", "BIG_PLAY", "outcome big_play", "data-detail-pipeline"]) {
      expect(html).not.toContain(internal);
    }
    // ADAAAA-7737's markup guard: the machine kind marker IS an outcome code, so
    // a customer session gets the badge TEXT only.
    expect(html).not.toContain("data-notable-kind");
  });

  it("the operator notable card keeps its internals in the collapsed Pipeline detail", () => {
    const html = lane([hl()]);
    expect(html).toContain("data-detail-pipeline");
    expect(html).toContain("BIG_PLAY");
    expect(html).toContain(">85<");
    expect(html).toContain("player falls to the ground");
  });
});
