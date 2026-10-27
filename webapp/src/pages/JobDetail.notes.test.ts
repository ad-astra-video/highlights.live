// ADAAAA-7466: the collapsible "Video Summary" surface for the append-only
// per-pass summary time log (`job.summaryLog`), replacing the removed running
// action notes. These render-agnostic SSR tests assert the section is titled
// exactly "Video Summary", is collapsed by default (header visible, body
// hidden until expanded), renders the time-log entries in order with their
// timestamp (`windowTs ?? ts`) + text when expanded, never drops the oldest
// entry, and degrades to a graceful "No summary yet" state for a legacy/
// predate job with no log.
import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { VideoSummary } from "./JobDetail";
import { summaryEntryTimestamp } from "../lib/jobDetail";

describe("Video Summary surface (ADAAAA-7466)", () => {
  it("renders a section titled exactly 'Video Summary', collapsed by default", () => {
    const html = renderToString(
      React.createElement(VideoSummary, {
        entries: [
          { seq: 1, ts: "2026-10-26T10:00:00Z", windowTs: 12, text: "Kickoff." },
          { seq: 2, ts: "2026-10-26T10:00:15Z", windowTs: 30, text: "Ball into midfield." },
        ],
      })
    );
    // Header + marker present
    expect(html).toContain("data-detail-video-summary");
    expect(html).toContain("Video Summary");
    // Collapsed by default: the header is visible but the body is hidden.
    expect(html).toContain("data-detail-video-summary-toggle");
    expect(html).not.toContain("data-detail-video-summary-body");
    expect(html).not.toContain("data-detail-video-summary-log");
    // Count badge reflects the growing log.
    expect(html).toContain("data-detail-video-summary-count");
  });

  it("renders the time-log entries in order with timestamp + text when expanded", () => {
    const html = renderToString(
      React.createElement(VideoSummary, {
        entries: [
          { seq: 1, ts: "2026-10-26T10:00:00Z", windowTs: 12, text: "Kickoff." },
          { seq: 2, ts: "2026-10-26T10:00:15Z", windowTs: 30, text: "Ball into midfield." },
          { seq: 3, ts: "2026-10-26T10:00:30Z", text: "2026-10-26T10:00:30Z" },
        ],
        defaultOpen: true,
      })
    );
    expect(html).toContain("data-detail-video-summary-body");
    expect(html).toContain("data-detail-video-summary-log");
    // Timestamps use windowTs when present (T+12s / T+30s), ts otherwise.
    expect(html).toContain("T+12s");
    expect(html).toContain("T+30s");
    expect(html).toContain("Kickoff.");
    expect(html).toContain("Ball into midfield.");
    // Chronological order: seq 1 precedes seq 2 precedes seq 3.
    const i1 = html.indexOf("Kickoff.");
    const i2 = html.indexOf("Ball into midfield.");
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
  });

  it("never drops the oldest entry — the full log renders, including the oldest", () => {
    const entries = [
      { seq: 1, ts: "2026-10-26T10:00:00Z", windowTs: 0, text: "First (oldest) entry." },
      { seq: 2, ts: "2026-10-26T10:00:15Z", windowTs: 30, text: "Later entry." },
      { seq: 3, ts: "2026-10-26T10:00:30Z", windowTs: 60, text: "Most recent entry." },
    ];
    const expanded = renderToString(React.createElement(VideoSummary, { entries, defaultOpen: true }));
    // Oldest + newest both present, in order.
    const iOldest = expanded.indexOf("First (oldest) entry.");
    const iNewest = expanded.indexOf("Most recent entry.");
    expect(iOldest).toBeGreaterThan(-1);
    expect(iNewest).toBeGreaterThan(iOldest);
    // One entry element per log row.
    const count = (expanded.match(/data-detail-video-summary-entry/g) || []).length;
    expect(count).toBe(entries.length);
  });

  it("shows a graceful 'No summary yet' empty state (not an error) when the log is absent", () => {
    const html = renderToString(React.createElement(VideoSummary, { entries: undefined, defaultOpen: true }));
    expect(html).toContain("data-detail-video-summary-empty");
    expect(html).toContain("No summary yet");
    // No error surface.
    expect(html).not.toContain("data-detail-video-summary-log");
  });

  it("keeps the section header present even when collapsed with no log yet", () => {
    const html = renderToString(React.createElement(VideoSummary, {}));
    expect(html).toContain("data-detail-video-summary");
    expect(html).toContain("Video Summary");
    // Collapsed and empty: no count badge, no body.
    expect(html).not.toContain("data-detail-video-summary-count");
    expect(html).not.toContain("data-detail-video-summary-body");
  });
});

describe("summaryEntryTimestamp (ADAAAA-7466)", () => {
  it("prefers windowTs (as T+Ns) when known", () => {
    expect(summaryEntryTimestamp({ seq: 1, ts: "2026-10-26T10:00:00Z", windowTs: 12, text: "x" })).toBe("T+12s");
  });
  it("falls back to the wall-clock ts when windowTs is absent", () => {
    expect(summaryEntryTimestamp({ seq: 1, ts: "2026-10-26T10:00:00Z", text: "x" })).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});
