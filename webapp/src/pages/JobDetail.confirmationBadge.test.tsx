import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard, HighlightMomentGrid } from "./JobDetail";
import {
  highlightMomentEntries,
  type HighlightConfirmation,
  type JobDetailHighlight,
} from "../lib/jobDetail";

// ADAAAA-8530 (AC5 fixtures + AC1 order rule) — notable moments live INSIDE the
// Highlights grid, and the card's ONE badge is the CONFIRMATION state:
//
//   measured row        -> CONFIRMED
//   provisional row     -> UNCONFIRMED   (no lane derived, or lane unconfirmed)
//   row without footage -> a text row inside the SAME list, never a card
//
// The badge census must equal the lane census (AC6's DOM rule, proven here on
// SSR markup), and no card prints a play taxonomy as badge copy (AC2).
// The node env has no jsdom, so assertions are on the SSR markup.

/** react-dom/server separates adjacent text nodes with `<!-- -->` markers. */
function text(html: string): string {
  return html.replace(/<!--\s*-->/g, "");
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** Cards mounted in the grid (`data-detail-highlight` on a card root), excluding
 *  the `data-detail-highlight-grid` container marker. */
function cards(html: string): number {
  return (html.match(/data-detail-highlight(?![-\w])/g) ?? []).length;
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

const provisional = (): NonNullable<JobDetailHighlight["provisionalGoal"]> => ({
  status: "provisional",
  cues: ["asr_goal_call", "crowd_reaction"],
  declaredTs: 5,
  note: "ASR goal call in the window transcript; scoreboard read still 1-1",
});

function confirmation(lane: HighlightConfirmation["lane"]): HighlightConfirmation {
  return { lane, label: `lane ${lane}` };
}

/** The badge element's own markup, scoped so a play-type string elsewhere on the
 *  card can never be mistaken for badge copy. */
function badgeHtml(html: string): string {
  const at = html.indexOf("data-detail-confirmed-badge");
  if (at < 0) return "";
  const start = html.lastIndexOf("<", at);
  const end = html.indexOf("</span>", at);
  return html.slice(start, end < 0 ? undefined : end + 7);
}

/** Every badge's TEXT, in DOM order — the badge census. */
function badgeTexts(html: string): string[] {
  const out: string[] = [];
  const re = /<span[^>]*data-detail-confirmed-badge[^>]*>([^<]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(m[1].trim());
  return out;
}

function grid(postable: JobDetailHighlight[], notable: JobDetailHighlight[], admin = true): string {
  return text(
    renderToString(
      React.createElement(HighlightMomentGrid, {
        entries: highlightMomentEntries(postable, notable),
        captionOf: () => "",
        admin,
      })
    )
  );
}

/** Moment starts in DOM order, read off each card's `data-detail-moment-range`. */
function startOrder(html: string): number[] {
  return html
    .split("data-detail-moment-range")
    .slice(1)
    .map((chunk) => {
      const m = /T\+(\d+)s/.exec(chunk);
      return m ? Number(m[1]) : Number.NaN;
    });
}

describe("AC5 — a measured row reads CONFIRMED", () => {
  it("carries the badge with the CONFIRMED text (postable and notable alike)", () => {
    const row = hl({ confirmation: confirmation("measured") });
    for (const card of [
      text(renderToString(React.createElement(HighlightCard, { highlight: row, onDecision: () => {} }))),
      text(renderToString(React.createElement(HighlightCard, { highlight: row, notable: true }))),
    ]) {
      expect(count(card, "data-detail-confirmed-badge")).toBe(1);
      expect(count(card, 'data-detail-confirmed-badge="confirmed"')).toBe(1);
      expect(badgeTexts(card)).toEqual(["CONFIRMED"]);
    }
  });
});

describe("AC5 — a provisional row reads UNCONFIRMED", () => {
  it("reads UNCONFIRMED when the row carries no derived lane", () => {
    const card = text(
      renderToString(
        React.createElement(HighlightCard, {
          highlight: hl({ provisionalGoal: provisional() }),
          onDecision: () => {},
        })
      )
    );
    expect(count(card, "data-detail-confirmed-badge")).toBe(1);
    expect(count(card, 'data-detail-confirmed-badge="unconfirmed"')).toBe(1);
    expect(badgeTexts(card)).toEqual(["UNCONFIRMED"]);
    // The stale taxonomy copy is not badge copy any more (AC2) — it reads as
    // plain detail text and never asserts a scored goal.
    expect(badgeHtml(card)).not.toContain("GOAL");
    expect(badgeHtml(card)).not.toContain("BIG PLAY");
    expect(card).toContain("data-detail-play-type");
    expect(card).toContain("goal-shaped play");
  });

  it("reads UNCONFIRMED for an explicitly unconfirmed / disagreed lane", () => {
    for (const lane of ["unconfirmed", "dive_disagreed"] as const) {
      const card = text(
        renderToString(
          React.createElement(HighlightCard, {
            highlight: hl({ confirmation: confirmation(lane) }),
            onDecision: () => {},
          })
        )
      );
      expect(badgeTexts(card)).toEqual(["UNCONFIRMED"]);
    }
  });
});

describe("AC1/AC5 — one list, and a row without footage stays a text row inside it", () => {
  it("renders ONE grid holding postable + notable cards and the text row", () => {
    const postable = hl({ id: "p1", start: 43.471, end: 58.471, outcome: "scoring_play", eventType: "GOAL" });
    const notableCard = hl({ id: "n1", start: 5.468, end: 20.468 });
    const notableText = hl({ id: "n2", start: 70, end: 85, clipUri: "" });
    const html = grid([postable], [notableCard, notableText]);

    expect(count(html, "data-detail-highlight-grid")).toBe(1);
    // AC1: the separate notable lane no longer renders anywhere.
    expect(count(html, 'data-detail-lane="notable"')).toBe(0);
    expect(html).not.toContain("Notable — not a goal");
    // One card per moment with footage; the footage-less row is a text row in
    // the SAME container, never a card with an empty player.
    expect(cards(html)).toBe(2);
    expect(count(html, 'data-detail-notable-card="true"')).toBe(1);
    expect(count(html, 'data-detail-lane-row="notable"')).toBe(1);
    expect(html.indexOf("data-detail-highlight-grid")).toBeLessThan(html.indexOf('data-detail-lane-row="notable"'));
  });

  it("orders the cards by moment start", () => {
    const html = grid(
      [hl({ id: "p-late", start: 120, end: 135, outcome: "scoring_play" })],
      [
        hl({ id: "n-early", start: 5, end: 20 }),
        hl({ id: "n-mid", start: 60, end: 75 }),
        hl({ id: "n-text", start: 200, end: 215, clipUri: "" }),
      ]
    );
    expect(startOrder(html)).toEqual([5, 60, 120, 200]);
  });

  it("the badge census equals the lane census (two CONFIRMED, three UNCONFIRMED)", () => {
    const rows = [
      hl({ id: "c1", start: 1, end: 16, confirmation: confirmation("measured") }),
      hl({ id: "c2", start: 20, end: 35, confirmation: confirmation("dive") }),
      hl({ id: "c3", start: 40, end: 55, confirmation: confirmation("dive_disagreed") }),
      hl({ id: "c4", start: 60, end: 75, confirmation: confirmation("unconfirmed") }),
      hl({ id: "c5", start: 80, end: 95 }),
    ];
    const html = grid([], rows);
    const badges = badgeTexts(html);
    expect(badges).toHaveLength(rows.length);
    expect(badges.filter((b) => b === "CONFIRMED")).toHaveLength(2);
    expect(badges.filter((b) => b === "UNCONFIRMED")).toHaveLength(3);
    // No card prints a play taxonomy or a goal claim as badge copy.
    for (let i = 0; i < badges.length; i += 1) {
      expect(badges[i]).toMatch(/^(CONFIRMED|UNCONFIRMED)$/);
    }
    expect(html).not.toContain("GOAL (unconfirmed)");
    expect(html).not.toContain(">BIG PLAY<");
    expect(html).not.toContain(">NEAR MISS<");
  });
});
