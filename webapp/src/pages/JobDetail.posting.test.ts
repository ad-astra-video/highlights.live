import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard } from "./JobDetail";
import type { JobDetailHighlight } from "../lib/jobDetail";
import { clipFileName, clipUrl } from "../lib/highlightPost";

// ADAAAA-7622: the highlight card used to offer no posting path at all. These
// tests pin the three actions that now exist — Download, Copy link and an
// editable caption — plus the batch-selection checkbox the page wires to its
// multi-select export. Behaviour that needs a DOM/clipboard (the actual save
// and copy) is verified separately on the deployed page; here we assert the
// controls render with the public, token-free URL.

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/h1.mp4",
    start: 60,
    end: 80,
    eventType: "GOAL",
    score: 92,
    status: "accepted",
    createdAt: "2026-10-18T00:00:00Z",
    ...over,
  };
}

describe("highlight posting actions (ADAAAA-7622)", () => {
  it("renders a Download action carrying the clip URL and a filename", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {} })
    );
    expect(html).toContain("data-detail-download");
    expect(html).toContain(`href="${clipUrl("/clips/h1.mp4")}"`);
    expect(html).toContain(`download="${clipFileName(hl())}"`);
    // The public clip path — no auth token in the copied/downloaded link.
    expect(html).not.toContain("token=");
  });

  it("renders a Copy link action", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {} })
    );
    expect(html).toContain("data-detail-copy-link");
    expect(html).toContain("Copy link");
    expect(html).toContain('data-copy-state="idle"');
  });

  it("renders the editable caption seeded with the event type and timestamp", () => {
    const html = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ localizedTs: 69 }),
        onDecision: () => {},
        caption: "GOAL · T+69s — Argentina scores",
        onCaptionChange: () => {},
      })
    );
    expect(html).toContain("data-detail-caption");
    expect(html).toContain("Caption");
    expect(html).toContain("GOAL · T+69s — Argentina scores");
  });

  it("offers the batch checkbox only on selectable (postable) cards", () => {
    const plain = renderToString(
      React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {} })
    );
    expect(plain).not.toContain("data-detail-select-highlight");

    const selectable = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl(),
        onDecision: () => {},
        selectable: true,
        onToggleSelect: () => {},
      })
    );
    expect(selectable).toContain("data-detail-select-highlight");
    expect(selectable).toContain("Batch");
  });

  it("reflects the selected state in the batch checkbox", () => {
    const html = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl(),
        onDecision: () => {},
        selectable: true,
        selected: true,
        onToggleSelect: () => {},
      })
    );
    expect(html).toMatch(/data-detail-select-highlight[^>]*checked/);
  });

  it("disables Download/Copy when the highlight produced no clip", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl({ clipUri: "" }), onDecision: () => {} })
    );
    expect(html).not.toContain("<a");
    expect(html).toMatch(/data-detail-download[^>]*disabled|disabled[^>]*data-detail-download/);
    expect(html).toMatch(/data-detail-copy-link[^>]*disabled|disabled[^>]*data-detail-copy-link/);
  });
});
