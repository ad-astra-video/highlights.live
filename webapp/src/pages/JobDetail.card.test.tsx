import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard } from "./JobDetail";
import type { JobDetailHighlight } from "../lib/jobDetail";

// ADAAAA-7881: the identified highlight card is customer copy. These tests pin
// the three defects the board reported — the ASR transcript rendered twice, the
// raw pipeline status enum printed as the card's only label, and the "N merged"
// badge standing in for a real indication — plus the new hierarchy: moment
// header, suggested caption, one-line post titles, actions, and the operator's
// pipeline internals behind ONE collapsed disclosure.

const TRANSCRIPT = "so the keeper claims it and the whistle goes";

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/h1.mp4",
    start: 359.2,
    end: 374.2,
    eventType: "SPORTING_EVENT",
    score: 88,
    outcome: "scoring_play",
    reason: "outcome=scoring_play accepted at score 88",
    status: "accepted",
    createdAt: "2026-11-03T00:00:00Z",
    trigger: { kind: "audio_burst", timestamp: 366.2, eventType: "SPORTING_EVENT" },
    ...over,
  };
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

const ROLES: { role: string; admin: boolean }[] = [
  { role: "operator (admin)", admin: true },
  { role: "customer", admin: false },
  { role: "operator on the rejected lane", admin: true },
];

describe("AC1 — the transcript and the audio state render exactly once (ADAAAA-7881)", () => {
  for (const { role, admin } of ROLES) {
    it(`${role}: one transcript node, one copy of the text`, () => {
      const html = renderToString(
        React.createElement(HighlightCard, {
          highlight: hl({ asrTranscript: TRANSCRIPT }),
          onDecision: () => {},
          admin,
        })
      );
      expect(count(html, "data-detail-asr")).toBe(1);
      expect(count(html, TRANSCRIPT)).toBe(1);
      expect(count(html, "data-detail-no-audio")).toBe(0);
    });

    it(`${role}: one no-audio note and no transcript node`, () => {
      const html = renderToString(
        React.createElement(HighlightCard, {
          highlight: hl({ hasAudio: false }),
          onDecision: () => {},
          admin,
        })
      );
      expect(count(html, "data-detail-no-audio")).toBe(1);
      expect(count(html, "No audio captured")).toBe(1);
      expect(count(html, "data-detail-asr")).toBe(0);
    });
  }

  it("keeps the stored transcript verbatim behind the low-emphasis disclosure", () => {
    const quoted = 'he says "that is a goal", then T+0 jump cut — unchanged';
    const html = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ asrTranscript: quoted }),
        onDecision: () => {},
        admin: false,
      })
    );
    expect(html).toContain("Transcript");
    expect(html).toContain("data-detail-asr");
    // Verbatim: the stored value is never trimmed or re-written.
    expect(html).toContain(quoted.replace(/"/g, "&quot;"));
  });
});

describe("AC2 — no internal badge, no raw status enum (ADAAAA-7881)", () => {
  for (const { role, admin } of ROLES) {
    it(`${role}: no merged badge and no bare status text`, () => {
      const html = renderToString(
        React.createElement(HighlightCard, {
          highlight: hl({ duplicateCount: 2, mergedIds: ["a", "b"] }),
          onDecision: () => {},
          admin,
        })
      );
      expect(html).not.toContain("data-detail-duplicate-count");
      expect(html).not.toContain("data-detail-status");
      expect(html).not.toContain(">accepted<");
      expect(html).not.toContain(">rejected<");
      expect(html).not.toContain("merged");
    });
  }

  it("the customer card carries no pipeline internals at all", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {}, admin: false })
    );
    for (const token of ["SPORTING_EVENT", "outcome=", "Trigger:", "data-detail-accept", "data-detail-reject"]) {
      expect(html, `customer card must not contain ${token}`).not.toContain(token);
    }
  });

  it("the operator card keeps its internals inside ONE collapsed disclosure", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {}, admin: true })
    );
    expect(count(html, "data-detail-pipeline")).toBe(1);
    expect(html).toContain("Pipeline detail");
    // Collapsed by default: the <details> carries no `open` attribute.
    expect(html).toMatch(/<details[^>]*data-detail-pipeline[^>]*>/);
    expect(html).not.toMatch(/<details[^>]*data-detail-pipeline[^>]*\sopen/);
    // Every internal renders AFTER the disclosure opens.
    const at = html.indexOf("data-detail-pipeline");
    for (const token of ["SPORTING_EVENT", "outcome=scoring_play", "Trigger:", "data-detail-accept"]) {
      expect(html.indexOf(token), `${token} should sit inside Pipeline detail`).toBeGreaterThan(at);
    }
  });

  it("keeps the reject banner inside the disclosure for a rejected operator card", () => {
    const html = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ status: "rejected", duplicateCount: 1 }),
        onDecision: () => {},
        admin: true,
      })
    );
    expect(html).toContain("data-detail-rejected");
    expect(html.indexOf("data-detail-rejected")).toBeGreaterThan(html.indexOf("data-detail-pipeline"));
    expect(html).toContain("Rejected — the highlight leaves the accepted feed.");
  });
});

describe("card hierarchy (ADAAAA-7881)", () => {
  it("leads with the moment range + duration chip", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {}, admin: false })
    );
    expect(html).toContain("T+359s – T+374s");
    expect(html).toContain("data-detail-moment-range");
    expect(html).toContain("data-detail-duration");
    // react-dom/server separates adjacent text nodes with `<!-- -->`.
    expect(html.replace(/<!--\s*-->/g, "")).toContain(">15s<");
  });

  it("keeps the posting actions and the batch checkbox on a selectable card", () => {
    const html = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl(),
        onDecision: () => {},
        selectable: true,
        onToggleSelect: () => {},
        admin: false,
      })
    );
    expect(html).toContain("data-detail-download");
    expect(html).toContain("data-detail-copy-link");
    expect(html).toContain("data-detail-select-highlight");
    expect(html).toContain("Batch");
  });
});
