import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard } from "./JobDetail";
import type { JobDetailAlternative, JobDetailHighlight } from "../lib/jobDetail";

// ADAAAA-8304: the goal card's video AREA is ONE horizontal clip rail — the
// highlight's own clip first, then one slide per delivered celebration/replay
// clip — with a count badge when there are 2+. The vertical
// `data-detail-alternatives` stack is gone: the metadata block carries no
// player at all.
//
// This package has no jsdom (deliberate convention), so these tests grade the
// rendered markup via react-dom/server; the pointer/keyboard behaviour is
// pinned on the pure helpers in lib/clipRail.test.ts and re-verified in a live
// DOM by QA.

function text(html: string): string {
  return html.replace(/<!--\s*-->/g, "");
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

function alt(over: Partial<JobDetailAlternative> = {}): JobDetailAlternative {
  return {
    id: "alt-1",
    jobId: "j1",
    highlightId: "h1",
    relation: "alternative_of",
    eventType: "celebration",
    windowAnchorTs: 22,
    start: 20,
    end: 30,
    clipUri: "/clips/j1-61.mp4",
    createdAt: "2026-11-04T20:21:00Z",
    ...over,
  };
}

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/j1-55.mp4",
    start: 5,
    end: 20,
    eventType: "GOAL",
    score: 92,
    reason: "Goal scored from open play.",
    status: "accepted",
    createdAt: "2026-11-04T20:21:00Z",
    ...over,
  };
}

const TWO_ALTS = [
  alt({ id: "alt-1", start: 20, end: 30, clipUri: "/clips/j1-61.mp4" }),
  alt({ id: "alt-2", start: 32, end: 41, clipUri: "/clips/j1-62.mp4" }),
];

function card(row: JobDetailHighlight, admin = true): string {
  return text(renderToString(React.createElement(HighlightCard, { highlight: row, admin })));
}

/** The card's metadata block starts at the moment range — nothing after that
 *  point may carry a player (AC1: exactly one video area). */
function metadataPart(html: string): string {
  return html.slice(html.indexOf("data-detail-moment-range"));
}

describe("AC1 — one video area: 3 slides in the rail (primary, alt-1, alt-2), no player in the metadata", () => {
  const html = card(hl({ alternatives: TWO_ALTS }));

  it("renders the rail with data-clip-count=3 and no vertical alternatives stack", () => {
    // NB: `data-detail-clip-rail` is a prefix of `data-detail-clip-rail-wrap`,
    // so count the full attribute form (the documented marker-count trap).
    expect(count(html, 'data-detail-clip-rail="true"')).toBe(1);
    expect(count(html, 'data-clip-count="3"')).toBe(1);
    expect(count(html, "data-detail-alternatives")).toBe(0);
    expect(count(html, "data-detail-alternatives-heading")).toBe(0);
    expect(html).not.toContain("Also from this goal");
  });

  it("orders the slides primary first, then the payload's alternatives", () => {
    expect(count(html, "data-detail-clip-slide")).toBe(3);
    const parts = html.split("data-detail-clip-slide");
    // parts[0] is the rail opening tag; one part per slide follows.
    expect(parts).toHaveLength(4);
    expect(parts[1]).toContain('data-clip-index="0"');
    expect(parts[1]).toContain("Highlight");
    expect(parts[1]).toContain("T+5s – T+20s");
    expect(parts[2]).toContain('data-clip-index="1"');
    expect(parts[2]).toContain("Celebration");
    expect(parts[2]).toContain("T+20s – T+30s");
    expect(parts[3]).toContain('data-clip-index="2"');
    expect(parts[3]).toContain("Celebration");
    expect(parts[3]).toContain("T+32s – T+41s");
  });

  it("alternative slides keep data-detail-alternative for continuity; the primary does not", () => {
    const parts = html.split("data-detail-clip-slide");
    expect(parts[1]).not.toContain("data-detail-alternative");
    expect(count(parts[2], "data-detail-alternative")).toBe(1);
    expect(count(parts[3], "data-detail-alternative")).toBe(1);
  });

  it("places every player inside the rail — the metadata block has no video/placeholder", () => {
    const meta = metadataPart(html);
    expect(meta).not.toContain("clip loading");
    expect(meta).not.toContain("<video");
    // Lazy mount (AC6): 3 slides, 3 pre-mount placeholders, and the metadata
    // block holds none of them.
    expect(count(html, "clip loading")).toBe(3);
    const rail = html.slice(html.indexOf("data-detail-clip-rail"));
    expect(count(rail, "clip loading")).toBe(3);
  });
});

describe("AC2 — clip-count badge: absent for 1 clip, the rendered count above that", () => {
  it("exactly 1 clip renders NO badge element", () => {
    const html = card(hl());
    expect(count(html, "data-detail-clip-count-badge")).toBe(0);
    expect(count(html, "data-detail-clip-slide")).toBe(1);
  });

  it("2 clips render a badge whose text names 2", () => {
    const html = card(hl({ alternatives: [TWO_ALTS[0]] }));
    expect(count(html, "data-detail-clip-count-badge")).toBe(1);
    expect(html).toContain("2 clips");
  });

  it("3 clips render a badge whose text names 3", () => {
    const html = card(hl({ alternatives: TWO_ALTS }));
    expect(count(html, "data-detail-clip-count-badge")).toBe(1);
    expect(html).toContain("3 clips");
    expect(html).not.toContain("2 clips");
  });

  it("the badge sits INSIDE the video area, before the metadata block (above the player, clear of the identity line)", () => {
    const html = card(hl({ alternatives: TWO_ALTS }));
    const badge = html.indexOf("data-detail-clip-count-badge");
    const rail = html.indexOf('data-detail-clip-rail="true"');
    const meta = html.indexOf("data-detail-moment-range");
    expect(badge).toBeGreaterThan(rail);
    expect(badge).toBeLessThan(meta);
    // The badge is an absolutely-positioned overlay in the same wrapper that
    // holds the rail, anchored top-right with a positive z-index: it never sits
    // under the player, and the identity line is below the aspect box.
    expect(html.slice(badge - 400, badge)).toContain("absolute");
    expect(html.slice(badge - 400, badge)).toContain("top-2");
    expect(html.slice(badge - 400, badge)).toContain("z-10");
    // The wrapper the badge overlays carries the rail AND the identity lines.
    const wrapStart = html.indexOf("data-detail-clip-rail-wrap");
    expect(wrapStart).toBeLessThan(badge);
    expect(html.indexOf("data-detail-clip-identity")).toBeLessThan(badge);
  });

  it("a delivered-but-failed alternative still renders its slide and still counts (AC7 failure state)", () => {
    const html = card(hl({ alternatives: [alt({ id: "alt-bad", clipError: "clip cut failed" })] }));
    const parts = html.split("data-detail-clip-slide");
    expect(parts).toHaveLength(3); // rail opening + 2 slides
    expect(count(html, "Clip unavailable")).toBe(1);
    expect(html).toContain("clip cut failed");
    expect(html).toContain("2 clips");
  });
});

describe("AC5 — navigation inputs exist only for 2+ slides", () => {
  it("1 clip: no prev/next buttons and the rail is not a tab stop", () => {
    const html = card(hl());
    expect(count(html, "data-detail-clip-prev")).toBe(0);
    expect(count(html, "data-detail-clip-next")).toBe(0);
    expect(count(html, 'tabindex="-1"')).toBe(1);
  });

  it("3 clips: prev/next buttons with accessible names, and the rail is keyboard-focusable", () => {
    const html = card(hl({ alternatives: TWO_ALTS }));
    expect(count(html, "data-detail-clip-prev")).toBe(1);
    expect(count(html, "data-detail-clip-next")).toBe(1);
    expect(count(html, 'aria-label="Previous clip"')).toBe(1);
    expect(count(html, 'aria-label="Next clip"')).toBe(1);
    // Focusable rail (Tab reaches it) → arrow keys can advance the slide.
    expect(count(html, 'tabindex="0"')).toBe(1);
    expect(html).toContain("Clip rail, 3 clips");
  });
});

describe("AC6 — lazy mount preserved (offscreen card mounts no <video>)", () => {
  it("a 3-clip card renders placeholders only — zero <video> elements before the viewport", () => {
    const html = card(hl({ alternatives: TWO_ALTS }));
    expect(count(html, "<video")).toBe(0);
    expect(count(html, 'preload="metadata"')).toBe(0);
    expect(count(html, "clip loading")).toBe(3);
  });
});

describe("AC7 — customer copy: no pipeline tokens on any slide, and Celebration is spelled out", () => {
  it("a non-admin 3-clip render carries no score, event type, outcome code or reason on the slides", () => {
    const html = card(hl({ alternatives: TWO_ALTS }), false);
    const rail = html.slice(
      html.indexOf('data-detail-clip-rail="true"'),
      html.indexOf("data-detail-moment-range")
    );
    expect(rail).toContain("Highlight");
    expect(count(rail, "Celebration")).toBe(2);
    expect(rail).not.toContain("GOAL");
    expect(rail).not.toContain("celebration");
    expect(rail).not.toContain("scoring_play");
    expect(rail).not.toContain("big_play");
    expect(rail).not.toContain("near_miss");
    expect(rail).not.toContain(">92<");
    // The card as a whole carries no operator disclosure for a customer.
    expect(html).not.toContain("data-detail-pipeline");
  });

  it("an admin render still exposes the pipeline internals (role parity preserved)", () => {
    const html = card(hl({ alternatives: TWO_ALTS }), true);
    expect(html).toContain("data-detail-pipeline");
    expect(html).toContain("GOAL");
    expect(html).toContain(">92<");
  });
});
