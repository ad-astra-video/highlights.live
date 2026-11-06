import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard, SecondaryHighlightLane } from "./JobDetail";
import type { JobDetailHighlight } from "../lib/jobDetail";

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
      expect(count(html, "data-detail-provisional-goal")).toBe(1);
      expect(count(html, "GOAL (unconfirmed)")).toBe(1);
      // The row's own taxonomy is untouched: it is still a big play, and the
      // card never prints a bare GOAL for it.
      expect(count(html, "GOAL (unconfirmed)")).toBe(1);
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

describe("AC — the notable lane (where a demoted goal lives) carries the marker", () => {
  it("renders the marker on the playable notable row", () => {
    const html = renderToString(
      React.createElement(SecondaryHighlightLane, {
        title: "Notable",
        note: "kept out of the postable list",
        lane: "notable",
        highlights: [hl({ provisionalGoal: provisional() })],
        admin: true,
      })
    );
    // ADAAAA-8178: the notable lane now renders the real card, where the
    // provisional string is carried by the single notable badge
    // (`data-detail-notable-badge`, kind goal_unconfirmed) instead of the
    // separate `data-detail-provisional-goal` chip — exactly one badge, no
    // duplicate string in the lane.
    expect(count(html, 'data-detail-notable-card="true"')).toBe(1);
    expect(count(html, "data-detail-notable-badge")).toBe(1);
    expect(count(html, 'data-notable-kind="goal_unconfirmed"')).toBe(1);
    expect(count(html, "data-detail-provisional-goal")).toBe(0);
    expect(count(html, "GOAL (unconfirmed)")).toBe(1);
    expect(count(html, NOTE)).toBe(1);
  });

  it("the customer notable row shows the label but no cue text", () => {
    const html = renderToString(
      React.createElement(SecondaryHighlightLane, {
        title: "Notable",
        note: "kept out of the postable list",
        lane: "notable",
        highlights: [hl({ provisionalGoal: provisional() })],
        admin: false,
      })
    );
    expect(count(html, "GOAL (unconfirmed)")).toBe(1);
    expect(count(html, NOTE)).toBe(0);
    expect(count(html, "asr_goal_call")).toBe(0);
  });

  it("a notable row without the marker stays a plain big play", () => {
    const html = renderToString(
      React.createElement(SecondaryHighlightLane, {
        title: "Notable",
        note: "kept out of the postable list",
        lane: "notable",
        highlights: [hl({})],
        admin: true,
      })
    );
    expect(count(html, "data-detail-provisional-goal")).toBe(0);
  });
});
