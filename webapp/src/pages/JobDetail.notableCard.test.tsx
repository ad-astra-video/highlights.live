import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard, HighlightActionRow, HighlightMomentGrid, SecondaryHighlightLane } from "./JobDetail";
import { highlightMomentEntries, type HighlightConfirmation, type JobDetailHighlight } from "../lib/jobDetail";
import { copyExportLink, exportUrl } from "../lib/highlightPost";

// ADAAAA-8530 (D1 = option A, confirmation state): ONE badge per Highlights card
// and it states CONFIRMATION, not the play taxonomy. These tests pin the badge
// contract on the card plus the action surface (AC2, and the parts of AC3/AC4/AC5
// that are specific to the badge); the one-list / text-row rules live in
// JobDetail.notable.test.tsx and the SSR fixtures in
// JobDetail.confirmationBadge.test.tsx.
//
// Superseded by this ticket: `data-detail-notable-badge` (BIG PLAY / NEAR MISS /
// GOAL (unconfirmed)) is gone. Play type is plain detail text and never badge
// copy.

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

function confirmation(lane: HighlightConfirmation["lane"]): HighlightConfirmation {
  return { lane, label: `lane ${lane}` };
}

/**
 * The badge element's OWN markup (ADAAAA-8318/8530).
 *
 * The card also carries a copy target (`data-detail-copy-target`) whose
 * deterministic label can legitimately contain the moment-type words a play
 * detail line uses (`BIG PLAY · 4:21` is ADAAAA-8302 Option 2's own example).
 * "Exactly one badge, and it is the confirmation state" is a statement about the
 * BADGE, so the counts below are scoped to the badge element.
 */
function badgeHtml(html: string): string {
  const at = html.indexOf("data-detail-confirmed-badge");
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

function grid(rows: JobDetailHighlight[], admin = true): string {
  return text(
    renderToString(
      React.createElement(HighlightMomentGrid, {
        entries: highlightMomentEntries([], rows),
        captionOf: () => "",
        admin,
      })
    )
  );
}

describe("AC2 — exactly ONE badge per card, and it states CONFIRMATION", () => {
  const cases: Array<[string, JobDetailHighlight, string, boolean]> = [
    ["a measured window", hl({ id: "p1", confirmation: confirmation("measured") }), "CONFIRMED", true],
    ["a dive-corroborated window", hl({ id: "p2", confirmation: confirmation("dive") }), "CONFIRMED", true],
    ["a disagreed dive", hl({ id: "p3", confirmation: confirmation("dive_disagreed") }), "UNCONFIRMED", false],
    ["an unconfirmed window", hl({ id: "p4", confirmation: confirmation("unconfirmed") }), "UNCONFIRMED", false],
    ["a row with no derived lane (legacy)", hl({ id: "p5" }), "UNCONFIRMED", false],
  ];

  for (const [name, row, label, confirmed] of cases) {
    it(`renders exactly one ${label} badge for ${name}`, () => {
      const html = card(row);
      expect(count(html, "data-detail-confirmed-badge")).toBe(1);
      expect(count(html, `data-detail-confirmed-badge="${confirmed ? "confirmed" : "unconfirmed"}"`)).toBe(1);
      expect(count(badgeHtml(html), label)).toBe(1);
    });
  }

  it("the badge TEXT is never a play taxonomy or a goal claim", () => {
    for (const row of [
      hl({ id: "b1", outcome: "big_play" }),
      hl({ id: "b2", outcome: "near_miss", eventType: "NEAR_MISS" }),
      hl({ id: "b3", provisionalGoal: provisional() }),
      hl({ id: "b4", provisionalGoal: provisional(), outcome: "big_play" }),
    ]) {
      const badge = badgeHtml(card(row));
      expect(badge).not.toContain("GOAL (unconfirmed)");
      expect(badge).not.toContain("BIG PLAY");
      expect(badge).not.toContain("NEAR MISS");
      expect(badge).toMatch(/>(CONFIRMED|UNCONFIRMED)</);
    }
  });

  it("play type is PLAIN detail text on the card (never the badge)", () => {
    expect(card(hl({ outcome: "big_play" }))).toContain(">big play<");
    expect(card(hl({ outcome: "near_miss", eventType: "NEAR_MISS" }))).toContain(">near miss<");
    expect(card(hl({ provisionalGoal: provisional() }))).toContain("goal-shaped play");
  });

  it("a notable row whose outcome carries no play type still carries the badge", () => {
    const html = card(hl({ outcome: "scoring_play" }));
    expect(count(html, "data-detail-confirmed-badge")).toBe(1);
    expect(badgeHtml(html)).toContain("UNCONFIRMED");
    expect(html).not.toContain("data-detail-play-type");
  });

  it("the plain (postable) card carries the SAME single badge", () => {
    const html = text(
      renderToString(
        React.createElement(HighlightCard, {
          highlight: hl({ confirmation: confirmation("measured") }),
          onDecision: () => {},
        })
      )
    );
    expect(count(html, "data-detail-confirmed-badge")).toBe(1);
    expect(badgeHtml(html)).toContain("CONFIRMED");
    expect(count(html, "data-detail-notable-card")).toBe(0);
    // The superseded notable badge marker never renders anywhere.
    expect(count(html, "data-detail-notable-badge")).toBe(0);
  });

  it("a grid of three notable moments carries one badge each, census = lane census", () => {
    const html = grid([
      hl({ id: "n1", outcome: "big_play" }),
      hl({ id: "n2", provisionalGoal: provisional() }),
      hl({ id: "n3", outcome: "near_miss", eventType: "NEAR_MISS", confirmation: confirmation("measured") }),
    ]);
    expect(count(html, "data-detail-confirmed-badge")).toBe(3);
    expect(count(html, 'data-detail-confirmed-badge="confirmed"')).toBe(1);
    expect(count(html, 'data-detail-confirmed-badge="unconfirmed"')).toBe(2);
    const badges = html.split("data-detail-confirmed-badge").slice(1);
    const texts = badges.map((chunk) => chunk.slice(0, chunk.indexOf("</span>") + 7));
    expect(texts.filter((b) => b.includes(">CONFIRMED<")).length).toBe(1);
    expect(texts.filter((b) => b.includes(">UNCONFIRMED<")).length).toBe(2);
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
    expect(count(html, "data-detail-confirmed-badge")).toBe(1);
    expect(count(html, ">UNCONFIRMED<")).toBe(1);
    // The play type is plain lower-case detail text — never an outcome code.
    expect(html).toContain(">big play<");
    // The badge ELEMENT is the confirmation state; the caption copy target
    // ("BIG PLAY · 0:05") is the posting surface, not badge copy (ADAAAA-8302).
    expect(badgeHtml(html)).not.toContain("BIG PLAY");
    for (const internal of [
      "score 85",
      "BIG_PLAY",
      "big_play",
      "outcome",
      "data-detail-pipeline",
      "data-detail-trigger",
      "data-notable-kind",
      // The lane itself is operator-only (ADAAAA-8530).
      "data-detail-confirm-lane",
    ]) {
      expect(html).not.toContain(internal);
    }
  });

  it("keeps the confirmation badge text but not the cue note or the cue names", () => {
    const html = card(hl({ provisionalGoal: provisional() }), false);
    expect(count(html, ">UNCONFIRMED<")).toBe(1);
    expect(html).toContain("goal-shaped play");
    expect(html).not.toContain("GOAL (unconfirmed)");
    expect(html).not.toContain("asr_goal_call");
    expect(html).not.toContain("crowd_reaction");
    expect(html).not.toContain(provisional().note);
    // The lane label is operator-only.
    expect(html).not.toContain("data-detail-confirm-lane");
    expect(html).not.toContain("lane unconfirmed");
  });
});
