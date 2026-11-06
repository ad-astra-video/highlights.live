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
    // ADAAAA-7910 removed the Accept slot: `accepted` is the server default, so
    // the ONE verdict slot is Reject here (postable rows keep it).
    expect(html).toContain("data-detail-reject");
    expect(html).toContain("Reject");
    expect(html).not.toContain("data-detail-accept");
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
    // ADAAAA-8032: the card passes `waitingSinceMs` from the row's createdAt, so
    // the wait state NAMES its progress ("cutting clip… Ns") instead of the bare
    // "clip processing…". The intent this test pins — never a silent blank
    // player — is unchanged; a legacy row with no createdAt still gets the bare
    // placeholder (asserted on the component directly below).
    expect(html).toMatch(/(cutting clip…|still cutting…) \d+s/);
    const legacy = renderToString(React.createElement(VideoClip, { src: "", lazy: false }));
    expect(legacy).toContain("clip processing");
  });

  it("keeps the verdict slot stateful: Reject on accepted, Undo reject on rejected (ADAAAA-7910)", () => {
    const accepted = renderToString(
      React.createElement(HighlightCard, { highlight: hl({ status: "accepted" }), onDecision: () => {} })
    );
    expect(accepted).toContain("data-detail-reject");
    expect(accepted).not.toContain("data-detail-restore");

    const rejected = renderToString(
      React.createElement(HighlightCard, { highlight: hl({ status: "rejected" }), onDecision: () => {} })
    );
    // A rejected clip gets the restore path, not a disabled Reject.
    expect(rejected).toContain("data-detail-restore");
    expect(rejected).toContain("Undo reject");
    expect(rejected).not.toContain("data-detail-accept");
    expect(rejected).not.toMatch(/data-detail-restore[^>]*disabled|disabled[^>]*data-detail-restore/);
  });

  it("shows a per-control loading state while a review request is in-flight (ADAAAA-6953)", () => {
    // pendingStatus="accepted" on a pending card -> the Approve slot shows a
    // spinner and is disabled so a user sees the review is in progress and
    // cannot double-submit.
    const html = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ status: "pending" }),
        onDecision: () => {},
        pendingStatus: "accepted",
      })
    );
    expect(html).toContain("data-detail-approve");
    expect(html).toContain("animate-spin");
    expect(html).toMatch(/data-detail-approve[^>]*disabled|disabled[^>]*data-detail-approve/);
  });

  it("renders the rejected presentation / recover hint for a rejected highlight (ADAAAA-6953)", () => {
    // A rejected clip leaves the accepted feed: the card carries an explicit
    // rejected notice and a data-detail-rejected marker so the Rejected section
    // is identifiable, while the undo-reject path stays reachable for recovery.
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl({ status: "rejected" }), onDecision: () => {} })
    );
    expect(html).toContain("data-detail-rejected");
    // The card names the recover path in customer-safe prose; the bare heading
    // word "Rejected" was replaced by that hint (ADAAAA-7881/7915), so assert
    // the hint itself instead of the old label.
    expect(html).toContain("Undo reject restores this clip within its recover window.");
    // Recovery lives in slot 3 now; Accept itself is gone (ADAAAA-7910).
    expect(html).toContain("data-detail-restore");
    expect(html).not.toContain("data-detail-accept");
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
