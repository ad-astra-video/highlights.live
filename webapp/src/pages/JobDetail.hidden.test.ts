import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard } from "./JobDetail";
import {
  applyReviewToRawRows,
  rejectedStripRows,
  type JobDetailHighlight,
} from "../lib/jobDetail";

// ADAAAA-7915 (increment 3): increment 2's action row shipped slot 3 as
// "Undo reject" for a rejected card, but no surface could ever RENDER a rejected
// card: `GET /jobs/:id/detail` returns the postable projection, and
// `buildPostableHighlights` drops every `status === "rejected"` row, so the
// page's rejected branch was dead. QA measured the consequence on ADAAAA-7911:
// click Reject -> review 200 -> `[data-detail-restore]` = 0 forever.
//
// The fix keeps the public contract intact and reads the RAW audit rows that
// `GET /jobs/:id` already returns owner-or-admin scoped. These tests pin the
// four states a reviewer has to see: reject -> strip, undo -> back in feed,
// reload-durable strip, and Accept absent in both roles.

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/h1.mp4",
    start: 60,
    end: 80,
    eventType: "GOAL",
    score: 92,
    reason: "outcome=goal on a scoring window",
    outcome: "goal",
    status: "accepted",
    createdAt: "2026-11-04T00:00:00Z",
    ...over,
  };
}

function card(over: Partial<JobDetailHighlight> = {}, admin = false): string {
  return renderToString(
    React.createElement(HighlightCard, { highlight: hl(over), onDecision: () => {}, admin })
  );
}

describe("hidden clip strip (ADAAAA-7915)", () => {
  it("reject moves the clip out of the accepted feed and into the strip", () => {
    // The postable projection the detail route returns never carries the row, so
    // the accepted feed loses it on the next render — the strip is what keeps it
    // reachable. Local state moves on the click, before the re-read.
    const acceptedFeedAfter = [] as JobDetailHighlight[];
    const rawAfterReject = applyReviewToRawRows([], hl(), "rejected");
    const strip = rejectedStripRows(rawAfterReject, acceptedFeedAfter);
    expect(strip.map((h) => h.id)).toEqual(["h1"]);
    // Slot 3 on that row resolves to the restore control, not a second Reject.
    const html = card({ status: strip[0].status });
    expect(html).toContain("data-detail-restore");
    expect(html).toContain('aria-label="Undo reject"');
  });

  it("undo puts the clip back in the accepted feed and empties the strip", () => {
    const raw = [hl({ status: "rejected" })];
    const before = rejectedStripRows(raw, []);
    expect(before).toHaveLength(1);

    // Undo -> 200 accepted: the row flips, the feed holds it again, the strip
    // drops it (a restored clip must never render twice).
    const rawAfter = applyReviewToRawRows(raw, before[0], "accepted");
    const feedAfter = [hl({ status: "accepted" })];
    expect(rawAfter.find((h) => h.id === "h1")?.status).toBe("accepted");
    expect(rejectedStripRows(rawAfter, feedAfter)).toEqual([]);
    const html = card({ status: "accepted" });
    expect(html).toContain("data-detail-reject");
    expect(html).not.toContain("data-detail-restore");
  });

  it("is reload-durable: a fresh raw read still lists the rejected clip", () => {
    // A reload drops every React state; the initial loader re-reads GET
    // /jobs/:id, whose `highlights` are the raw audit rows. The same filter over
    // that fresh read must produce the strip with no local state at all.
    const freshRawRead = [hl({ status: "rejected" }), hl({ id: "h2", status: "accepted" })];
    const freshDetailFeed = [hl({ id: "h2", status: "accepted" })];
    const strip = rejectedStripRows(freshRawRead, freshDetailFeed);
    expect(strip.map((h) => h.id)).toEqual(["h1"]);
    expect(strip[0].status).toBe("rejected");
  });

  it("never double-renders a clip that is already in the accepted feed", () => {
    const row = hl({ status: "rejected" });
    // A stale raw read against a feed that still holds the clip (the optimistic
    // accept path) must not render it twice.
    expect(rejectedStripRows([row], [hl({ status: "accepted" })])).toEqual([]);
  });
});

describe("rejected card presentation (ADAAAA-7915, AC4/AC5/AC6)", () => {
  it("role=user gets Undo reject and no Accept control", () => {
    const html = card({ status: "rejected" }, false);
    expect(html).toContain("data-detail-restore");
    expect(html).toContain('aria-label="Undo reject"');
    expect(html).toContain(">Undo reject<");
    expect(html).not.toContain("data-detail-accept");
    expect(html).not.toContain("data-detail-reject=");
    expect(html).not.toContain("data-detail-approve");
  });

  it("role=user leaks no operator internals", () => {
    const html = card({ status: "rejected" }, false);
    for (const forbidden of [
      "Pipeline detail",
      "data-detail-pipeline",
      "outcome=",
      ">92<", // the decide score
      ">rejected<",
      ">accepted<",
    ]) {
      expect(html, `role=user must not render ${forbidden}`).not.toContain(forbidden);
    }
    // Plain recovery copy names the control on the card instead of a status.
    expect(html).toContain("Undo reject restores this clip within its recover window.");
  });

  it("role=admin keeps the operator view and also gets the restore slot", () => {
    const html = card({ status: "rejected" }, true);
    expect(html).toContain("data-detail-restore");
    expect(html).toContain("data-detail-pipeline");
    expect(html).toContain("Pipeline detail");
    expect(html).not.toContain("data-detail-accept");
  });

  it("Accept is absent on an accepted card too (the restore path is the only one)", () => {
    for (const admin of [true, false]) {
      const html = card({ status: "accepted" }, admin);
      expect(html).not.toContain("data-detail-accept");
      expect(html).toContain("data-detail-reject=");
    }
  });
});
