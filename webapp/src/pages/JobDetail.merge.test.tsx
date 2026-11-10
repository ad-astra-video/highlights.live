import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard, HighlightMomentGrid, SecondaryHighlightLane } from "./JobDetail";
import { highlightMomentEntries, type JobDetailHighlight } from "../lib/jobDetail";

/** react-dom/server separates adjacent text nodes with `<!-- -->` markers;
 * strip them so assertions read the text a user actually sees. */
function text(html: string): string {
  return html.replace(/<!--\s*-->/g, "");
}

// ADAAAA-7621: the server precision gate + overlap dedupe shipped in
// `services/server/src/highlight-postable.ts` (GET /jobs/:id/detail), but the
// webapp never rendered the result: a merged moment showed no duplicate count
// anywhere in the gallery, and the `duplicateHighlights` / `notableHighlights`
// lanes the response carries were dropped on the floor. These tests pin the
// user-visible half so the dedupe cannot silently become invisible again.

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/h1.mp4",
    start: 359,
    end: 374,
    eventType: "GOAL",
    score: 95,
    status: "accepted",
    createdAt: "2026-08-05T00:00:00Z",
    ...over,
  };
}

describe("the card no longer states a merged count (ADAAAA-7881)", () => {
  it("renders no merged badge on a moment that absorbed overlapping clips", () => {
    const html = text(renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ duplicateCount: 2, mergedIds: ["a", "b"] }),
        onDecision: () => {},
      })
    ));
    // ADAAAA-7881: the count moved to the Analysis window list's connector.
    expect(html).not.toContain("data-detail-duplicate-count");
    expect(html).not.toContain("2 merged");
    expect(html).not.toContain("merged");
  });

  it("renders no merged badge on a single-clip moment", () => {
    const html = text(renderToString(
      React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {} })
    ));
    expect(html).not.toContain("data-detail-duplicate-count");
    expect(html).not.toContain("merged");
  });

  it("renders no merged badge when duplicateCount is 0", () => {
    const html = text(renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ duplicateCount: 0 }),
        onDecision: () => {},
      })
    ));
    expect(html).not.toContain("data-detail-duplicate-count");
  });
});

describe("dedupe/precision lanes are rendered (ADAAAA-7621)", () => {
  it("lists merged-away clips with the moment they were folded into", () => {
    const html = text(renderToString(
      React.createElement(SecondaryHighlightLane, {
        lane: "merged",
        title: "Merged into a highlight",
        note: "…",
        highlights: [
          hl({ id: "dup1", start: 372, end: 387, score: 71, duplicateOf: "abcdef123456" }),
        ],
      })
    ));
    expect(html).toContain('data-detail-lane="merged"');
    expect(html).toContain("merged into abcdef12");
    expect(html).toContain("T+372s");
    expect(html).toContain("score 71");
  });

  it("lists notable non-scoring clips inside the Highlights grid, as the real card with the confirmation badge", () => {
    // ADAAAA-8530 supersedes ADAAAA-8178's separate notable lane: the moment is a
    // row of the ONE Highlights grid, with ONE badge that states confirmation.
    const html = text(renderToString(
      React.createElement(HighlightMomentGrid, {
        entries: highlightMomentEntries([], [
          hl({
            id: "nm1",
            eventType: "GOAL",
            outcome: "near_miss",
            start: 148,
            end: 163,
            score: 60,
            reason: "ball does not enter the net",
          }),
        ]),
        captionOf: () => "",
      })
    ));
    expect(html).toContain("data-detail-highlight-grid");
    expect(html).not.toContain('data-detail-lane="notable"');
    expect(html).toContain("data-detail-highlight");
    expect(html).toContain("data-detail-notable-card");
    expect(html).toContain("data-detail-confirmed-badge");
    // No derived lane on this fixture row -> UNCONFIRMED, and the taxonomy moved
    // off the badge (AC2).
    expect(html).toContain(">UNCONFIRMED<");
    expect(html).toContain(">near miss<");
    expect(html).not.toContain("data-detail-notable-badge");
    // The operator card still explains the row (score / event type / reason live
    // in its collapsed Pipeline detail), so the lane loses no diagnostic value.
    expect(html).toContain("data-detail-pipeline");
    expect(html).toContain(">60<");
    expect(html).toContain("ball does not enter the net");
    // A notable row is non-postable, so its card has no verdict slot at all.
    expect(html).not.toContain("data-detail-reject");
    expect(html).not.toContain("data-detail-approve");
    expect(html).not.toContain("data-detail-restore");
  });

  it("renders nothing for an empty lane (pre-gate payloads stay unchanged)", () => {
    const empty = renderToString(
      React.createElement(SecondaryHighlightLane, {
        lane: "merged",
        title: "Merged into a highlight",
        note: "…",
        highlights: [],
      })
    );
    expect(empty).toBe("");
  });
});
