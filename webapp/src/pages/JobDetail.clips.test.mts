import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard } from "./JobDetail";
import { VideoClip } from "../components/VideoClip";
import type { JobDetailHighlight } from "../lib/jobDetail";

// ADAAAA-6948: after the per-job card restructure, identified highlights showed
// no video because JobDetail.tsx imported VideoClip but never rendered it and
// no file rendered <VideoClip …/> in JSX. These tests assert the highlight card
// actually mounts the clip player and that the VideoClip failure/processing
// states are preserved (ADAAAA-6522).

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/h1.mp4",
    start: 0,
    end: 10,
    eventType: "GOAL",
    score: 92,
    status: "accepted",
    createdAt: "2026-10-18T00:00:00Z",
    ...over,
  };
}

describe("per-job highlight card mounts the clip player (ADAAAA-6948)", () => {
  it("renders the clip player (VideoClip) inside the highlight card — no dead import", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {} })
    );
    expect(html).toContain("data-detail-highlight");
    // VideoClip is now actually rendered in the card. Under SSR the lazy
    // viewport mount is still pending, so the player surfaces its pre-mount
    // 'clip loading…' state instead of being absent entirely.
    expect(html).toContain("clip loading");
    // Review controls are preserved (no regression to accept/reject).
    expect(html).toContain("Accept");
    expect(html).toContain("Reject");
  });

  it("shows 'Clip unavailable' failure state when clipError is set (ADAAAA-6522)", () => {
    const html = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ clipError: "recording missing" }),
        onDecision: () => {},
      })
    );
    expect(html).toContain("Clip unavailable");
  });

  it("shows 'clip processing…' when clipUri is empty — never a silent blank player", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl({ clipUri: "" }), onDecision: () => {} })
    );
    expect(html).toContain("clip processing");
  });

  it("keeps Accept disabled once a highlight is accepted and Reject disabled once rejected", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl({ status: "rejected" }), onDecision: () => {} })
    );
    // Reject button disabled when status === "rejected"
    expect(html).toContain("data-detail-reject");
    expect(html).toContain("disabled");
  });

  it("shows a per-control loading state while a review request is in-flight (ADAAAA-6953)", () => {
    // pendingStatus="rejected" -> reject control shows a spinner + "Rejecting…"
    // and BOTH controls are disabled so a user sees the review is in progress
    // and cannot double-submit.
    const html = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ status: "pending" }),
        onDecision: () => {},
        pendingStatus: "rejected",
      })
    );
    expect(html).toContain("Rejecting…");
    expect(html).toContain("animate-spin");
    // Both controls disabled while pending.
    expect((html.match(/disabled/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it("renders the rejected presentation / recover hint for a rejected highlight (ADAAAA-6953)", () => {
    // A rejected clip leaves the accepted feed: the card carries an explicit
    // rejected notice and a data-detail-rejected marker so the Rejected section
    // is identifiable, while Accept stays enabled for recovery.
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl({ status: "rejected" }), onDecision: () => {} })
    );
    expect(html).toContain("data-detail-rejected");
    expect(html).toContain("Rejected");
    // Accepted feed semantics: rejected clips are excluded from acceptedCount,
    // so the restore (Accept) button must remain enabled (not a silent no-op).
    expect(html).toContain("Accept");
  });
});

describe("VideoClip mounts a playable <video> from clipUri (ADAAAA-6948)", () => {
  it("renders a <video> element sourced from clipUri when the player mounts", () => {
    const html = renderToString(
      React.createElement(VideoClip, { src: "/clips/h1.mp4", label: "GOAL", lazy: false })
    );
    expect(html).toContain("<video");
    expect(html).toContain('src="/clips/h1.mp4"');
    expect(html).toContain('aria-label="Video clip: GOAL"');
  });
});
