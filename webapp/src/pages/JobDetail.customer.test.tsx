import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import {
  AnalysisWindow,
  CustomerAnalysisSection,
  CustomerAnalysisWindow,
  HighlightCard,
  SecondaryHighlightLane,
} from "./JobDetail";
import type { DecideNote, FrameSection, JobDetailFrame, JobDetailHighlight } from "../lib/jobDetail";

// ADAAAA-7737 / AC-A + AC-B: the customer job-detail page (/app/jobs/:id with
// `role=user`) still rendered pipeline internals after ADAAAA-7727 — decide
// labels ("Decide @ T+0.0s"), per-frame track counts (45 `[data-detail-frame]`
// nodes with "T+0.0s·3 trk"), and the rejection banner ("SPORTING_EVENT · 0 ·
// rejected — outcome=not_highlight …") — while the admin session saw the gated
// tiles. These tests pin the render boundary on the offending surfaces: the
// SAME payload, rendered for a customer, carries none of the forbidden tokens,
// and rendered for an admin still carries all of them.
//
// The fixture is the QA-reported shape (jobs fe79931e / 18d5914e): a not-
// highlight window with a SPORTING_EVENT score-0 rejection, a NEAR_MISS window,
// and frames carrying track counts.

const FORBIDDEN = [
  "decide",
  "Decide @",
  "trk",
  "data-detail-frame",
  "SPORTING_EVENT",
  "NEAR_MISS",
  "near_miss",
  "not_highlight",
  "outcome=",
  // ADAAAA-7893: the owner-facing rejected clip note ("Undo reject restores…")
  // the public feed…") is intentionally customer-visible, so the guard targets
  // the pipeline banner shapes instead of the bare words. ADAAAA-7737's intent
  // — no raw status enum in a decide banner — is preserved.
  "· rejected",
  "· accepted",
  "rejected — outcome=",
  "accuracy",
  "lostFrames",
  "slot",
  "seq",
  "$",
  "costUsd",
  "perceiveSession",
  "stageAMetrics",
];

function frame(seq: number, timestamp: number): JobDetailFrame {
  return {
    seq,
    timestamp,
    uri: `/jobs/j1/frames/${seq}`,
    tracks: [
      { trackId: "t1", slot: 1, kind: "player", label: "player", bbox: [0.1, 0.1, 0.2, 0.3], lostFrames: 0 },
      { trackId: "t2", slot: 2, kind: "ball", label: "soccer ball", bbox: [0.4, 0.4, 0.05, 0.05], lostFrames: 0 },
      { trackId: "t3", slot: 3, kind: "player", label: "player", bbox: [0.6, 0.2, 0.2, 0.3], lostFrames: 0 },
    ],
  };
}

function rejectedNote(over: Partial<DecideNote> = {}): DecideNote {
  return {
    seq: 0,
    timestamp: 0,
    eventType: "SPORTING_EVENT",
    score: 0,
    outcome: "not_highlight",
    isHighlight: false,
    status: "rejected",
    reason: "outcome=not_highlight is not a scoring highlight",
    ...over,
  };
}

function nearMissNote(over: Partial<DecideNote> = {}): DecideNote {
  return {
    seq: 45,
    timestamp: 14.7,
    eventType: "NEAR_MISS",
    score: 45,
    outcome: "near_miss",
    nearMiss: true,
    isHighlight: true,
    status: "rejected",
    reason: "near_miss below the scoring threshold",
    ...over,
  };
}

function section(index: number, decideNotes: DecideNote[]): FrameSection {
  return {
    index,
    startS: index * 3,
    endS: (index + 1) * 3,
    frames: [frame(index * 3, index * 3 + 0.2), frame(index * 3 + 1, index * 3 + 1.2)],
    decideNotes,
  };
}

const SECTIONS: FrameSection[] = [
  section(0, [rejectedNote()]),
  section(1, [nearMissNote()]),
  section(2, []),
];

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/h1.mp4",
    start: 3,
    end: 12,
    eventType: "SPORTING_EVENT",
    score: 88,
    outcome: "scoring_play",
    reason: "outcome=scoring_play accepted at score 88",
    status: "accepted",
    createdAt: "2026-11-01T00:00:00Z",
    trigger: { kind: "audio_burst", timestamp: 4.2, eventType: "SPORTING_EVENT" },
    ...over,
  };
}

/** Count occurrences of every forbidden token (case-insensitive) in a blob. */
function forbiddenHits(blob: string): Record<string, number> {
  const lower = blob.toLowerCase();
  const hits: Record<string, number> = {};
  for (const token of FORBIDDEN) {
    const needle = token.toLowerCase();
    let count = 0;
    let at = lower.indexOf(needle);
    while (at !== -1) {
      count += 1;
      at = lower.indexOf(needle, at + needle.length);
    }
    if (count > 0) hits[token] = count;
  }
  return hits;
}

describe("customer job detail carries no pipeline internals (ADAAAA-7737 AC-A/AC-B)", () => {
  const customerHtml = renderToString(
    React.createElement(CustomerAnalysisSection, { sections: SECTIONS })
  );

  it("the customer analysis section renders time ranges + plain status only", () => {
    expect(customerHtml).toContain("Analysis");
    expect(customerHtml).toContain("T+0s – T+3s");
    expect(customerHtml).toContain("T+3s – T+6s");
    // Window status is plain copy; the near-miss window is a "highlight" for the
    // customer and the rejected not-highlight window reads as checked.
    expect(customerHtml).toContain("Highlight detected");
    expect(customerHtml).toContain("Checked — no highlight");
    // No filmstrip, no decide banners, no filter chips.
    expect(customerHtml).not.toContain("data-detail-frame");
    expect(customerHtml).not.toContain("data-decide-note");
    expect(customerHtml).not.toContain("data-analysis-filter-chip");
    expect(customerHtml).not.toContain("data-analysis-summary");
  });

  it("the customer surfaces contain zero forbidden tokens (text + markup)", () => {
    const cards = renderToString(
      React.createElement(
        "div",
        null,
        React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {}, admin: false }),
        React.createElement(HighlightCard, { highlight: hl({ status: "rejected" }), onDecision: () => {}, admin: false }),
        React.createElement(SecondaryHighlightLane, {
          lane: "notable",
          title: "Notable — not a goal",
          note: "Non-scoring plays (near miss / big play). They stay off the postable goal list.",
          highlights: [hl({ eventType: "NEAR_MISS", outcome: "near_miss", score: 45 })],
          admin: false,
        })
      )
    );
    const lane = renderToString(
      React.createElement(SecondaryHighlightLane, {
        lane: "merged",
        title: "Merged into a highlight",
        note: "Overlapping clips folded into the moment above so the same footage is not posted twice.",
        highlights: [hl({ duplicateOf: "abcdef123456" })],
        admin: false,
      })
    );
    expect(forbiddenHits(customerHtml)).toEqual({});
    expect(forbiddenHits(cards)).toEqual({});
    expect(forbiddenHits(lane)).toEqual({});
    // ...and none of the individual customer surfaces hides the customer value.
    expect(cards).toContain("data-detail-highlight");
    expect(cards).toContain("clip loading");
    expect(customerHtml).toContain("Checked — no highlight");
  });

  it("a customer frame/window render never exposes the filmstrip or decide body", () => {
    const html = renderToString(
      React.createElement(AnalysisWindow, {
        section: SECTIONS[0],
        token: null,
        jobId: "j1",
        selectMode: false,
        selectedSeqs: new Set<number>(),
        onFrameClick: () => {},
        defaultOpen: true,
        admin: false,
      })
    );
    expect(forbiddenHits(html)).toEqual({});
    expect(html).not.toContain("[data-detail-frame]");
    expect(html).not.toContain("tracks");
  });

  it("the SAME payload rendered for an admin keeps every internal (no capability lost)", () => {
    const adminHtml = renderToString(
      React.createElement(
        "div",
        null,
        React.createElement(AnalysisWindow, {
          section: SECTIONS[0],
          token: null,
          jobId: "j1",
          selectMode: false,
          selectedSeqs: new Set<number>(),
          onFrameClick: () => {},
          defaultOpen: true,
          admin: true,
        }),
        React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {}, admin: true })
      )
    );
    // decide attribution + taxonomy + score + outcome code
    expect(adminHtml).toContain("Decide @");
    expect(adminHtml).toContain("SPORTING_EVENT");
    expect(adminHtml).toContain("outcome=not_highlight");
    expect(adminHtml).toContain("not_highlight");
    // per-frame track counts in the filmstrip
    expect(adminHtml).toContain("data-detail-frame");
    expect(adminHtml).toContain("trk");
    // score + trigger attribution on the card
    expect(adminHtml).toContain("88");
    expect(adminHtml).toContain("Trigger:");
    expect(adminHtml).toContain("audio burst");

    // Positive control: the fixture DOES trip the scanner under admin, so the
    // customer assertions above are meaningful rather than vacuous.
    const hits = forbiddenHits(adminHtml);
    for (const token of ["decide", "trk", "SPORTING_EVENT", "not_highlight", "outcome="]) {
      expect(hits[token], `admin html should surface ${token}`).toBeGreaterThan(0);
    }
  });
});
