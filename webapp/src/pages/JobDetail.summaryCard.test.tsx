import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard, SummaryBody } from "./JobDetail";
import type { JobDetailHighlight } from "../lib/jobDetail";
import {
  SUMMARY_LINES_LIVE,
  SUMMARY_LINES_VOD,
  postTitleOf,
  summaryClampClass,
  summaryLineBudget,
  summaryOf,
} from "../lib/highlightPost";

// ADAAAA-8669 (caption depth contract §3): the card's BODY copy. The contract
// adds a THIRD copy lane (`summary`) without reverting either ratified shape:
// `postTitle` stays the headline + "Suggested caption" copy target (ADAAAA-8318)
// and the announcer `caption` stays the collapsed "What happened" detail.
//
// These tests pin the parts the card owns:
//   - summary present  -> body copy under the headline, clamped, expandable;
//   - summary absent   -> byte-identical card, no placeholder (contract AC3);
//   - VOD depth band   -> the wider 4-line clamp;
//   - long-copy hygiene-> escaped HTML, no internal tokens, wrap/selectable text
//                         (the clamp is visual only: the text stays in the DOM).
//
// The suite runs in the node environment (no DOM), so the clamp/expand state is
// asserted through the render path plus the pure clamp helpers; the measured
// `scrollHeight > clientHeight` pass is browser-only and fails open (the
// affordance renders until the browser proves the copy fits).

const LIVE_SUMMARY =
  "With 2:38 left in the second half, Marta picked the ball up on the edge of the box and curled it inside the far post to make it 2-1. The goal ended a spell of pressure that started after the interval.";

const VOD_SUMMARY =
  "The visitors had spent ten minutes pinned back before the opener. A short corner was worked back to the taker, whose cross was met at the near post and turned in. The home side never recovered the shape they started with, and the second goal followed from the same channel. It finished the tie as a contest.";

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/h1.mp4",
    start: 120,
    end: 135,
    eventType: "GOAL",
    score: 92,
    status: "accepted",
    caption: "Announcer line from the broadcast, unchanged by the summary lane.",
    createdAt: "2026-11-11T00:00:00Z",
    ...over,
  };
}

function card(over: Partial<JobDetailHighlight> = {}, props: { fastRail?: boolean } = {}): string {
  return renderToString(
    React.createElement(HighlightCard, { highlight: hl(over), onDecision: () => {}, ...props })
  );
}

/** The single `[data-detail-summary]` block's own markup (marker attribute spy). */
function summaryBlock(html: string): string {
  const at = html.indexOf("data-detail-summary");
  expect(at, "the body-copy block must render").toBeGreaterThan(-1);
  const open = html.lastIndexOf("<", at);
  const close = html.indexOf("</div>", at);
  return html.slice(open, close + "</div>".length);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("summaryOf (ADAAAA-8669 read seam)", () => {
  it("returns '' for an absent, null, blank or non-string value — absence renders nothing", () => {
    expect(summaryOf({})).toBe("");
    expect(summaryOf({ summary: undefined })).toBe("");
    expect(summaryOf({ summary: "" })).toBe("");
    expect(summaryOf({ summary: "   \n  " })).toBe("");
    expect(summaryOf({ summary: null as unknown as string })).toBe("");
  });

  it("passes a clean served sentence through byte-identical (no re-casing, no added period)", () => {
    const served = "USA took the lead with a header from the near post.";
    // A leading all-caps entity is legitimate copy: the narrow guard must not
    // rewrite it the way the full stripInternalTokens pass would.
    expect(summaryOf({ summary: served })).toBe(served);
    expect(summaryOf({ summary: LIVE_SUMMARY })).toBe(LIVE_SUMMARY);
  });

  it("strips the unambiguous internal markers, including the live-scoring-lane tail", () => {
    const dirty =
      "[near_miss] T+69s the striker turned inside the box | live scoring lane: outcome=near_miss";
    const out = summaryOf({ summary: dirty });
    for (const marker of ["[near_miss]", "T+69s", "live scoring lane", "outcome="]) {
      expect(out, `${marker} must not reach the card`).not.toContain(marker);
    }
    expect(out).toContain("the striker turned inside the box");
  });
});

describe("summary line budget (ADAAAA-8669 size guard, ADAAAA-8302)", () => {
  it("clamps a live card at 3 lines and a VOD card at 4", () => {
    expect(summaryLineBudget(true)).toBe(SUMMARY_LINES_LIVE);
    expect(summaryLineBudget(false)).toBe(SUMMARY_LINES_VOD);
    expect(SUMMARY_LINES_LIVE).toBe(3);
    expect(SUMMARY_LINES_VOD).toBe(4);
  });

  it("uses the matching Tailwind clamp utility per lane and drops it when expanded", () => {
    expect(summaryClampClass(SUMMARY_LINES_LIVE, false)).toBe("line-clamp-3");
    expect(summaryClampClass(SUMMARY_LINES_VOD, false)).toBe("line-clamp-4");
    expect(summaryClampClass(SUMMARY_LINES_LIVE, true)).toBe("");
    expect(summaryClampClass(SUMMARY_LINES_VOD, true)).toBe("");
  });
});

describe("HighlightCard body copy (ADAAAA-8669)", () => {
  it("renders the summary once, under the headline and above the collapsed announcer detail", () => {
    const html = card({ summary: LIVE_SUMMARY }, { fastRail: true });
    expect(count(html, "data-detail-summary=")).toBe(1);
    expect(count(html, "data-detail-summary-body")).toBe(1);
    const block = summaryBlock(html);
    expect(block).toContain("data-detail-summary");
    expect(block).toContain("Marta picked the ball up");
    // Order: copy target (headline) -> body copy -> "What happened" detail.
    const copy = html.indexOf("data-detail-copy-target");
    const body = html.indexOf("data-detail-summary=");
    const announcer = html.indexOf("data-detail-announcer");
    expect(copy).toBeGreaterThan(-1);
    expect(body).toBeGreaterThan(copy);
    expect(announcer).toBeGreaterThan(body);
    expect(html).toContain("What happened");
  });

  it("keeps the ratified split: the copy target is still postTitle, never the summary", () => {
    const html = card({ summary: LIVE_SUMMARY }, { fastRail: true });
    const copyTarget = postTitleOf(hl());
    // A textarea renders its value as CHILDREN (not a `value` attribute).
    const open = html.indexOf("<textarea");
    const field = html.slice(open, html.indexOf("</textarea>", open));
    expect(field).toContain("data-detail-copy-target");
    expect(html).toContain(`>${copyTarget}</textarea>`);
    // The editor's value is the headline, not the body copy.
    expect(field).not.toContain("Marta picked the ball up");
    // The announcer detail stays a closed <details>, and the summary is NOT in it.
    const announcerAt = html.indexOf("data-detail-announcer");
    const announcerOpen = html.lastIndexOf("<details", announcerAt);
    expect(html.slice(announcerOpen, announcerAt)).not.toMatch(/\sopen(=|\s|>)/);
    const announcerBlock = html.slice(announcerAt, html.indexOf("</details>", announcerAt));
    expect(announcerBlock).not.toContain("Marta picked the ball up");
  });

  it("renders the live clamp (3 lines) with an expand affordance", () => {
    const html = card({ summary: LIVE_SUMMARY }, { fastRail: true });
    const block = summaryBlock(html);
    expect(block).toContain("line-clamp-3");
    expect(block).toContain("data-detail-summary-toggle");
    expect(block).toContain('aria-expanded="false"');
    expect(block).toContain(">More<");
    // Visual truncation only: the full sentence stays in the DOM (selectable).
    expect(block).toContain("ended a spell of pressure");
  });

  it("widens the clamp to 4 lines on the VOD lane (the 3-5 sentence band)", () => {
    const vod = card({ summary: VOD_SUMMARY }, { fastRail: false });
    const live = card({ summary: VOD_SUMMARY }, { fastRail: true });
    expect(summaryBlock(vod)).toContain("line-clamp-4");
    expect(summaryBlock(vod)).not.toContain("line-clamp-3");
    expect(summaryBlock(live)).toContain("line-clamp-3");
    expect(summaryBlock(vod)).toContain("It finished the tie as a contest.");
  });

  it("renders an expanded body copy without the clamp and with a collapse affordance", () => {
    const html = renderToString(React.createElement(SummaryBody, { text: LIVE_SUMMARY, lines: 3, initialExpanded: true }));
    expect(html).toContain("data-detail-summary-expanded");
    expect(html).not.toContain("line-clamp-3");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(">Less<");
    expect(html).toContain(LIVE_SUMMARY);
  });

  it("renders exactly today's card when summary is absent — no block, no placeholder", () => {
    const absent = card({}, { fastRail: true });
    const noKey = card({ summary: undefined }, { fastRail: true });
    const blank = card({ summary: "   " }, { fastRail: true });
    // Byte-identical: an absent/blank field changes nothing at all.
    expect(noKey).toBe(absent);
    expect(blank).toBe(absent);
    expect(absent).not.toContain("data-detail-summary");
    for (const placeholder of ["generating", "Generating", "summary pending", "Summary"]) {
      expect(absent, `no ${placeholder} placeholder may render`).not.toContain(placeholder);
    }
  });

  it("drops a summary that only repeats the headline instead of printing it twice", () => {
    const headline = postTitleOf(hl());
    const html = card({ summary: headline }, { fastRail: true });
    expect(html).not.toContain("data-detail-summary");
    expect(count(html, headline.replace(/&/g, "&amp;"))).toBeLessThan(2);
  });

  it("wraps long names and keeps the copy as plain, selectable text", () => {
    const longName = "Bartholomew-Fitzwilliam-Okonkwo";
    const html = card({ summary: `${longName} cleared it off the line.` }, { fastRail: true });
    const block = summaryBlock(html);
    expect(block).toContain("break-words");
    expect(block).toContain("whitespace-pre-wrap");
    // A <p> text node: selectable/copyable and free of a mid-word cut.
    expect(block).toContain("<p");
    expect(block).toContain(longName);
  });

  it("escapes markup in a served summary instead of rendering raw HTML", () => {
    const html = card({ summary: 'A <b>header</b> from <script>alert(1)</script> made it 1-0.' }, { fastRail: true });
    const block = summaryBlock(html);
    expect(block).toContain("&lt;b&gt;");
    expect(block).not.toContain("<b>header</b>");
    expect(block).not.toContain("<script>");
    expect(block).toContain("&lt;script&gt;");
  });
});
