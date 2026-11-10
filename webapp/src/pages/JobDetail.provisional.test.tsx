import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard, HighlightMomentGrid, SecondaryHighlightLane } from "./JobDetail";
import { highlightMomentEntries, type JobDetailHighlight } from "../lib/jobDetail";

// ADAAAA-8139 (interim step): the CEO asked for a provisional GOAL surface —
// "if there is some celebration in the frames it can be surfaced as a
// provisional highlight and the confirmed highlight when the scoreboard change
// happens subsequently". These tests pin the CLIENT half of that contract: a
// demoted row that carries the server's `provisionalGoal` marker renders
// "GOAL (unconfirmed)" exactly once, it is never promoted to a GOAL, and a row
// without the marker (an attested goal, a plain celebration, a legacy row)
// renders nothing. The server half (cue derivation, fail-closed, in-place clear
// on re-attestation) is pinned in services/server/test/live-provisional-goal-8139b.test.ts.

const NOTE = "ASR goal call in the window transcript; scoreboard read still 1-1";

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/h1.mp4",
    start: 12,
    end: 27,
    eventType: "SPORTING_EVENT",
    score: 74,
    // A demoted goal keeps the big_play outcome: it stays a celebration.
    outcome: "big_play",
    reason: "demoted: no measured attestation in the window",
    status: "accepted",
    createdAt: "2026-11-06T00:00:00Z",
    ...over,
  };
}

const provisional = (): NonNullable<JobDetailHighlight["provisionalGoal"]> => ({
  status: "provisional",
  cues: ["asr_goal_call", "frame_celebration"],
  declaredTs: 12,
  note: NOTE,
});

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe("AC — the provisional marker is a label on a celebration, never a GOAL", () => {
  for (const admin of [true, false]) {
    it(`HighlightCard (admin=${admin}) renders the marker once when the row is provisional`, () => {
      const html = renderToString(
        React.createElement(HighlightCard, {
          highlight: hl({ provisionalGoal: provisional() }),
          onDecision: () => {},
          admin,
        })
      );
      // ADAAAA-8530 (D1 = A) SUPERSEDES the "GOAL (unconfirmed)" badge copy: the
      // card's one badge is the confirmation state, and the play taxonomy is
      // plain detail text. The marker itself survives as that detail text.
      expect(count(html, "data-detail-provisional-goal")).toBe(1);
      expect(count(html, "data-detail-play-type")).toBe(1);
      expect(count(html, "goal-shaped play")).toBe(1);
      expect(count(html, 'data-detail-confirmed-badge="unconfirmed"')).toBe(1);
      expect(count(html, ">UNCONFIRMED<")).toBe(1);
      expect(count(html, "GOAL (unconfirmed)")).toBe(0);
      // The row's own taxonomy is untouched: it is still a big play, and the
      // card never prints a bare GOAL for it.
      expect(count(html, ">GOAL<")).toBe(0);
    });
  }

  it("the operator card explains the cue; the customer card leaks no cue names", () => {
    const op = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ provisionalGoal: provisional() }),
        onDecision: () => {},
        admin: true,
      })
    );
    expect(count(op, NOTE)).toBe(1);
    const customer = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ provisionalGoal: provisional() }),
        onDecision: () => {},
        admin: false,
      })
    );
    expect(count(customer, NOTE)).toBe(0);
    expect(count(customer, "asr_goal_call")).toBe(0);
  });

  it("no marker on an attested goal, a plain celebration, or a legacy row", () => {
    for (const row of [
      hl({ outcome: "scoring_play", eventType: "GOAL" }),
      hl({ outcome: "big_play", provisionalGoal: undefined }),
      hl({}),
    ]) {
      const html = renderToString(
        React.createElement(HighlightCard, { highlight: row, onDecision: () => {}, admin: true })
      );
      expect(count(html, "data-detail-provisional-goal")).toBe(0);
      expect(count(html, "GOAL (unconfirmed)")).toBe(0);
    }
  });
});

describe("AC — a notable moment in the ONE Highlights list carries the marker", () => {
  // ADAAAA-8530: the separate notable lane is gone; notable moments are rows of
  // the Highlights grid (`HighlightMomentGrid`), so the demoted-goal marker is
  // read off a card in that grid.
  function grid(rows: JobDetailHighlight[], admin: boolean): string {
    return renderToString(
      React.createElement(HighlightMomentGrid, {
        entries: highlightMomentEntries([], rows),
        captionOf: () => "",
        admin,
      })
    );
  }

  it("renders the marker as plain detail text on the playable notable card", () => {
    const html = grid([hl({ provisionalGoal: provisional() })], true);
    expect(count(html, 'data-detail-notable-card="true"')).toBe(1);
    expect(count(html, "data-detail-highlight-grid")).toBe(1);
    // ONE badge, and it is the confirmation state (no lane derived here).
    expect(count(html, "data-detail-confirmed-badge")).toBe(1);
    expect(count(html, 'data-detail-confirmed-badge="unconfirmed"')).toBe(1);
    expect(count(html, "data-detail-play-type")).toBe(1);
    expect(count(html, "goal-shaped play")).toBe(1);
    expect(count(html, NOTE)).toBe(1);
    // The superseded badge strings are gone everywhere.
    expect(count(html, "GOAL (unconfirmed)")).toBe(0);
    expect(count(html, "data-detail-notable-badge")).toBe(0);
  });

  it("the customer notable row shows the label but no cue text", () => {
    const html = grid([hl({ provisionalGoal: provisional() })], false);
    expect(count(html, ">UNCONFIRMED<")).toBe(1);
    expect(count(html, "goal-shaped play")).toBe(1);
    expect(count(html, NOTE)).toBe(0);
    expect(count(html, "asr_goal_call")).toBe(0);
  });

  it("a notable row without the marker stays a plain big play", () => {
    const html = grid([hl({})], true);
    expect(count(html, "data-detail-provisional-goal")).toBe(0);
  });
});

describe("AC6 — a merged duplicate never prints the unconfirmed marker", () => {
  // ADAAAA-8199: the absorbed celebration is a duplicate of a CONFIRMED goal, so
  // its transition is resolved. Printing "GOAL (unconfirmed)" on the merged lane
  // would re-open the CEO's original symptom on the same page.
  for (const admin of [true, false]) {
    it(`merged lane (admin=${admin}) renders neither the chip nor the label`, () => {
      const html = renderToString(
        React.createElement(SecondaryHighlightLane, {
          title: "Merged into a highlight",
          note: "Overlapping clips folded into the moment above.",
          lane: "merged",
          highlights: [hl({ provisionalGoal: provisional(), duplicateOf: "goal-1" })],
          admin,
        })
      );
      expect(count(html, "data-detail-provisional-goal")).toBe(0);
      expect(count(html, "GOAL (unconfirmed)")).toBe(0);
      // The merged row itself still renders (the transition is auditable).
      expect(count(html, "data-detail-lane-row")).toBe(1);
      expect(count(html, "→")).toBe(1);
    });
  }
});

// ADAAAA-8205: the async Stage-2 dive ran AFTER the row published and did not
// confirm it. The card must SAY the deep dive did not confirm (AC-A7) and, under
// ADAAAA-8530, the confirmation badge must read UNCONFIRMED — the superseded
// "GOAL (unconfirmed)" badge copy is replaced by the confirmation state.
describe("AC-A7 — a refuted dive keeps its badge surface and says so", () => {
  const refuted = (): NonNullable<JobDetailHighlight["provisionalGoal"]> =>
    ({ ...provisional(), refuted: true }) as unknown as NonNullable<JobDetailHighlight["provisionalGoal"]>;

  for (const admin of [true, false]) {
    it(`HighlightCard (admin=${admin}) reads UNCONFIRMED and adds the refuted line`, () => {
      const html = renderToString(
        React.createElement(HighlightCard, {
          highlight: hl({ provisionalGoal: refuted() }),
          onDecision: () => {},
          admin,
        })
      );
      // The badge the CEO is watching is NOT removed — it is the confirmation
      // state now, and a refuted dive can never read CONFIRMED.
      expect(count(html, "data-detail-confirmed-badge")).toBe(1);
      expect(count(html, 'data-detail-confirmed-badge="unconfirmed"')).toBe(1);
      expect(count(html, ">CONFIRMED<")).toBe(0);
      expect(count(html, "data-detail-provisional-refuted")).toBe(1);
      expect(count(html, "Deep dive did not confirm this goal.")).toBe(1);
      // Still never a postable GOAL label.
      expect(count(html, ">GOAL<")).toBe(0);
    });
  }

  it("an unrefuted provisional row carries no refuted line", () => {
    const html = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ provisionalGoal: provisional() }),
        onDecision: () => {},
        admin: false,
      })
    );
    expect(count(html, "data-detail-provisional-refuted")).toBe(0);
  });
});
