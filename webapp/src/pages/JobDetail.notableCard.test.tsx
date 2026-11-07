import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard, HighlightActionRow, SecondaryHighlightLane } from "./JobDetail";
import type { JobDetailHighlight } from "../lib/jobDetail";
import { copyExportLink, exportUrl } from "../lib/highlightPost";

// ADAAAA-8178: the notable-play lane must render the SAME card the postable
// highlights use, with ONE badge added (BIG PLAY / GOAL (UNCONFIRMED) / NEAR
// MISS). These tests pin the acceptance criteria that are specific to the badge
// and the action surface (AC2–AC5); the lane parity / text-row rules (AC1, AC3's
// merged-lane half) live in JobDetail.notable.test.tsx.
//
// Fixture: the notable rows the ticket is about — a demoted big play, a
// provisional goal, and a near miss — all carrying footage.

function text(html: string): string {
  return html.replace(/<!--\s*-->/g, "");
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

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/**
 * The badge element's OWN markup (ADAAAA-8318).
 *
 * The card now carries a copy target (`data-detail-copy-target`) whose
 * deterministic label can legitimately contain the moment-type words the badge
 * uses (`BIG PLAY · 4:21` is ADAAAA-8302 Option 2's own example). "Exactly one
 * badge" is a statement about the BADGE, so the label counts below are scoped to
 * the badge element instead of the whole card.
 */
function badgeHtml(html: string): string {
  const at = html.indexOf("data-detail-notable-badge");
  if (at < 0) return "";
  const start = html.lastIndexOf("<", at);
  const end = html.indexOf("</span>", at);
  return html.slice(start, end < 0 ? undefined : end + 7);
}

function card(row: JobDetailHighlight, admin = true): string {
  return text(
    renderToString(
      React.createElement(HighlightCard, { highlight: row, notable: true, admin })
    )
  );
}

describe("AC2 — exactly one notable badge per card, with the documented precedence", () => {
  const cases: Array<[string, JobDetailHighlight, string, string]> = [
    ["provisional goal", hl({ id: "p1", provisionalGoal: provisional() }), "goal_unconfirmed", "GOAL (unconfirmed)"],
    ["big play", hl({ id: "p2", outcome: "big_play" }), "big_play", "BIG PLAY"],
    ["near miss", hl({ id: "p3", outcome: "near_miss", eventType: "NEAR_MISS" }), "near_miss", "NEAR MISS"],
  ];

  for (const [name, row, kind, label] of cases) {
    it(`renders one ${label} badge (kind=${kind}) for a ${name} row`, () => {
      const html = card(row);
      expect(count(html, "data-detail-notable-badge")).toBe(1);
      expect(count(html, `data-notable-kind="${kind}"`)).toBe(1);
      expect(count(badgeHtml(html), label)).toBe(1);
    });
  }

  it("precedence: a provisional goal that is also a big_play reads GOAL (unconfirmed), never BIG PLAY", () => {
    const html = card(hl({ provisionalGoal: provisional(), outcome: "big_play" }));
    expect(count(html, "data-detail-notable-badge")).toBe(1);
    expect(count(badgeHtml(html), "GOAL (unconfirmed)")).toBe(1);
    expect(count(badgeHtml(html), "BIG PLAY")).toBe(0);
    // The generic provisional chip is folded into the notable badge: no second
    // copy of the same string on the card.
    expect(count(html, "data-detail-provisional-goal")).toBe(0);
  });

  it("no badge for a notable row whose outcome is neither (it is never mislabelled)", () => {
    const html = card(hl({ outcome: "scoring_play" }));
    expect(count(html, "data-detail-notable-badge")).toBe(0);
    expect(count(badgeHtml(html), "BIG PLAY")).toBe(0);
    expect(count(badgeHtml(html), "NEAR MISS")).toBe(0);
    expect(count(badgeHtml(html), "GOAL (unconfirmed)")).toBe(0);
  });

  it("the plain (postable) card still renders no notable badge", () => {
    const html = text(
      renderToString(React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {} }))
    );
    expect(count(html, "data-detail-notable-badge")).toBe(0);
    expect(count(html, "data-detail-notable-card")).toBe(0);
  });

  it("a lane of the three fixture rows carries exactly three badges and no duplicates", () => {
    const html = text(
      renderToString(
        React.createElement(SecondaryHighlightLane, {
          lane: "notable",
          title: "Notable — not a goal",
          note: "Non-scoring plays (near miss / big play). They stay off the postable goal list.",
          tone: "yellow",
          highlights: [
            hl({ id: "n1", outcome: "big_play" }),
            hl({ id: "n2", provisionalGoal: provisional() }),
            hl({ id: "n3", outcome: "near_miss", eventType: "NEAR_MISS" }),
          ],
        })
      )
    );
    expect(count(html, "data-detail-notable-badge")).toBe(3);
    // one badge kind each, counted inside each badge element
    const badges = html.split("data-detail-notable-badge").slice(1);
    const kinds = badges.map((chunk) => chunk.slice(0, chunk.indexOf("</span>") + 7));
    expect(kinds.filter((b) => b.includes("BIG PLAY")).length).toBe(1);
    expect(kinds.filter((b) => b.includes("GOAL (unconfirmed)")).length).toBe(1);
    expect(kinds.filter((b) => b.includes("NEAR MISS")).length).toBe(1);
  });
});

describe("AC3 — the notable card drops the verdict slot and the batch checkbox", () => {
  it("has no Reject / Approve / Undo-reject control in any row status", () => {
    for (const status of ["accepted", "rejected", "pending"]) {
      const html = card(hl({ status }));
      // The BUTTON markers are the `="true"` attributes; `data-detail-rejected`
      // (the customer-facing "Undo reject restores…" hint) is a different marker.
      expect(html).not.toContain('data-detail-reject="true"');
      expect(html).not.toContain('data-detail-restore="true"');
      expect(html).not.toContain('data-detail-approve="true"');
      expect(html).not.toContain('data-detail-accept="true"');
    }
  });

  it("keeps no batch checkbox even when a caller passes the selectable props", () => {
    const html = text(
      renderToString(
        React.createElement(HighlightCard, {
          highlight: hl(),
          notable: true,
          selectable: true,
          selected: true,
          onToggleSelect: () => {},
        })
      )
    );
    expect(html).not.toContain("data-detail-select-highlight");
    expect(html).not.toContain("data-detail-select-label");
  });

  it("the action row still offers Download + Copy Link when the verdict is hidden", () => {
    const html = text(
      renderToString(
        React.createElement(HighlightActionRow, {
          highlight: hl(),
          downloadUrl: "/clips/h1.mp4?x=tok",
          onCopy: () => {},
          showVerdict: false,
        })
      )
    );
    expect(html).toContain("data-detail-download");
    expect(html).toContain("data-detail-copy-link");
    expect(html).not.toContain("data-detail-reject");
  });
});

describe("AC4 — Download and Copy Link use the server-minted export URL for the row id", () => {
  const EXPORT = "/clips/95e454a3-00eb-4de9-be58-ab3e7634add6-55.mp4?x=server-minted-token";

  it("the download anchor href is the export URL, not the public clipUri", () => {
    const html = card(hl({ exportUri: EXPORT }));
    const anchor = /<a[^>]*>/.exec(html)?.[0] ?? "";
    expect(anchor).toContain("data-detail-download");
    const href = /href="([^"]+)"/.exec(anchor)?.[1];
    // No `window` in the node test env, so the URL is the same-origin path the
    // server minted — token included, and distinct from the playback URL.
    expect(href).toBe(EXPORT);
    expect(href).not.toBe(hl().clipUri);
  });

  it("the copy payload is the same export URL (pure helper, no DOM / network)", async () => {
    const row = hl({ exportUri: EXPORT });
    let copied = "";
    const ok = await copyExportLink(row, {
      copy: async (t) => {
        copied = t;
        return true;
      },
      mark: async () => ({}),
    });
    expect(ok).toBe(true);
    expect(copied).toBe(EXPORT);
    expect(exportUrl(row)).toBe(EXPORT);
  });

  it("falls back to the public clipUri when the projection carries no exportUri", () => {
    const row = hl();
    expect(exportUrl(row)).toBe(row.clipUri);
    const html = card(row);
    expect(html).toContain(`href="${row.clipUri}"`);
  });
});

describe("AC5 — a customer session sees the badge text only", () => {
  // NOTE on the caption: the posting surface (caption editor + title chips) is
  // IDENTICAL to the postable card by the PO decision ("caption editor and title
  // chips stay"), and that surface seeds from the summary log / the decide reason.
  // The reason therefore never appears as a pipeline FIELD (no Pipeline detail, no
  // trigger, no score, no event type, no outcome code) — the same projection the
  // customer postable card has had since ADAAAA-7737/7881. What a customer must
  // never see is the interior of the pipeline; what they post is the caption.
  it("keeps the badge and drops score / eventType / outcome / reason field / cue names", () => {
    const html = card(hl({ outcome: "big_play", provisionalGoal: undefined }), false);
    expect(count(html, "data-detail-notable-badge")).toBe(1);
    expect(html).toContain("BIG PLAY");
    for (const internal of [
      "score 85",
      "BIG_PLAY",
      "big_play",
      "outcome",
      "data-detail-pipeline",
      "data-detail-trigger",
      "data-notable-kind",
    ]) {
      expect(html).not.toContain(internal);
    }
  });

  it("keeps the provisional badge text but not the cue note or the cue names", () => {
    const html = card(hl({ provisionalGoal: provisional() }), false);
    expect(html).toContain("GOAL (unconfirmed)");
    expect(html).not.toContain("asr_goal_call");
    expect(html).not.toContain("crowd_reaction");
    expect(html).not.toContain(provisional().note);
  });
});
