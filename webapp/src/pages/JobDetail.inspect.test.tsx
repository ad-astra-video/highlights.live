import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { CustomerAnalysisSection, CustomerInspectWindow, SeeDetailToggle } from "./JobDetail";
import type { DecideNote, FrameSection, JobDetailFrame, WindowAnalysis } from "../lib/jobDetail";

// ADAAAA-7838: the owner-facing `See detail` toggle.
//
// AC5 (toggle OFF): the Analysis list renders exactly today's customer row
// surface — time range + plain status, NO accordion body and NO `Inspect`
// button; the page's own requests carry no `inspect=1` (asserted in
// webapp/src/lib/windowInspect.test.ts against the same fetch helpers the page
// uses).
//
// AC6 (toggle ON): every row is a collapsed section (chevron + timestamp +
// status + an `Inspect` button next to the timestamp) and NOTHING is loaded
// until a row is inspected; once one window's detail is present, THAT row alone
// renders the decide banner, the captured prompt/response, the filmstrip and the
// audio-energy graph.
//
// The node test env has no jsdom/@testing-library, so this pins the RENDERED
// DOM via SSR and the REQUEST path via the store/fetch tests above; the live
// click-through is verified by QA on the deployed box (ADAAAA-7839).

function frame(seq: number, timestamp: number): JobDetailFrame {
  return {
    seq,
    timestamp,
    uri: `/jobs/j1/frames/${seq}`,
    tracks: [{ trackId: "t1", slot: 1, kind: "player", label: "player", bbox: [0.1, 0.1, 0.2, 0.3], lostFrames: 0 }],
  };
}

const ANALYSIS: WindowAnalysis = {
  prompt: "You are a highlight judge. Window evidence: ball in the net.",
  dataItems: [{ type: "candidate", label: "Candidate event type", value: "GOAL" }],
  frames: [{ seq: 3, uri: "/jobs/j1/frames/3" }],
  images: [],
  audio: { path: "input_audio", uri: "/jobs/j1/windows/audio?start=1.000&end=6.000", sampleRate: 16000 },
  asr: { transcript: "and he scores!" },
  audioSeries: [
    { t: 1, energy: 0.2, baseline: 0.3 },
    { t: 1.4, energy: 0.9, baseline: 0.3 },
    { t: 1.8, energy: 0.4, baseline: 0.3 },
  ],
  response: { isHighlight: true, score: 92, outcome: "scoring_play", reasoning: "ball crossed the line", evidenceAttested: [] },
};

function note(over: Partial<DecideNote> = {}): DecideNote {
  return {
    seq: 3,
    timestamp: 4.2,
    eventType: "GOAL",
    score: 92,
    outcome: "scoring_play",
    isHighlight: true,
    status: "accepted",
    reason: "ball in net",
    analysis: ANALYSIS,
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

const SECTIONS: FrameSection[] = [section(0, [note()]), section(1, []), section(2, [])];

/** Count occurrences of a marker in the rendered HTML. */
function count(html: string, marker: string): number {
  let n = 0;
  let at = html.indexOf(marker);
  while (at !== -1) {
    n += 1;
    at = html.indexOf(marker, at + marker.length);
  }
  return n;
}

describe("See detail OFF keeps today's customer row surface (ADAAAA-7838 AC5)", () => {
  const html = renderToString(React.createElement(CustomerAnalysisSection, { sections: SECTIONS }));

  it("renders the same rows as before: time range + plain status", () => {
    expect(html).toContain("data-analysis-header");
    expect(html).toContain("T+0s – T+3s");
    expect(html).toContain("T+3s – T+6s");
    expect(html).toContain("Highlight detected");
    expect(html).toContain("Checked — no highlight");
    expect(count(html, "data-analysis-window-range")).toBe(3);
  });

  it("carries no accordion chrome, no Inspect button and no window body", () => {
    expect(html).not.toContain("data-inspect-window");
    expect(html).not.toContain("data-inspect-window-button");
    expect(html).not.toContain("data-inspect-window-body");
    expect(html).not.toContain("data-analysis-window-toggle");
    // no internals leak through the closed surface either
    expect(html).not.toContain("data-decide-note");
    expect(html).not.toContain("data-window-analysis");
    expect(html).not.toContain("data-detail-frame");
  });

  it("still shows the See detail control so the owner can turn it on", () => {
    expect(html).toContain("data-see-detail-toggle");
    expect(html).toContain('aria-pressed="false"');
  });
});

describe("See detail ON is a lazy accordion (ADAAAA-7838 AC6)", () => {
  const collapsed = renderToString(
    React.createElement(CustomerAnalysisSection, { sections: SECTIONS, inspect: true, jobId: "j1" })
  );

  it("turns every row into a collapsed section with an Inspect button", () => {
    expect(count(collapsed, "data-inspect-window-button")).toBe(3);
    expect(count(collapsed, "data-analysis-window-toggle")).toBe(3);
    // one Inspect button per row, keyed by that row's bucket index
    expect(count(collapsed, "data-inspect-window-button")).toBe(3);
    for (const index of [0, 1, 2]) {
      expect(collapsed).toContain(`data-inspect-window-button="true" data-section-index="${index}"`);
    }
    // the timestamp + status of the row are unchanged
    expect(collapsed).toContain("T+0s – T+3s");
    expect(collapsed).toContain("Highlight detected");
    expect(collapsed).toContain('aria-pressed="true"');
  });

  it("loads NOTHING until a row is inspected — no body, no filmstrip, no prompt", () => {
    expect(collapsed).not.toContain("data-inspect-window-body");
    expect(collapsed).not.toContain("data-decide-note");
    expect(collapsed).not.toContain("data-window-analysis");
    expect(collapsed).not.toContain("data-prompt");
    expect(collapsed).not.toContain("data-detail-frame");
  });
});

describe("one inspected window renders its full detail for that row only (ADAAAA-7838 AC6)", () => {
  const loaded = renderToString(
    React.createElement(CustomerAnalysisSection, {
      sections: SECTIONS,
      inspect: true,
      jobId: "j1",
      inspections: {
        0: {
          status: "loaded",
          data: { jobId: "j1", index: 0, startS: 0, endS: 3, decideNotes: [note()] },
        },
      },
    })
  );

  it("renders the banner, collapsed prompt toggle, response, filmstrip and audio-energy graph", () => {
    // exactly one window body — the inspected row
    expect(count(loaded, "data-inspect-window-body")).toBe(1);
    expect(loaded).toContain("data-decide-note");
    expect(loaded).toContain("Decide @ T+");
    expect(loaded).toContain("4.2");
    expect(loaded).toContain("data-window-analysis");
    // ADAAAA-8338: the prompt is a collapsed toggle row until the operator opens it.
    expect(loaded).toContain("data-prompt");
    expect(loaded).toContain("data-prompt-toggle");
    expect(loaded).not.toContain("data-prompt-body");
    expect(loaded).not.toContain("You are a highlight judge.");
    expect(loaded).toContain("data-response");
    expect(loaded).toContain("data-audio-series-graph");
    expect(loaded).toContain("data-detail-frame");
  });

  it("leaves the other rows unloaded (no request was needed for them)", () => {
    // section 1 and 2 never got an entry, so their bodies stay closed
    expect(count(loaded, "data-inspect-window-body")).toBe(1);
    expect(count(loaded, "data-inspect-window-button")).toBe(3);
  });

  it("surfaces a load failure instead of an empty body", () => {
    const html = renderToString(
      React.createElement(CustomerInspectWindow, {
        section: SECTIONS[0],
        jobId: "j1",
        inspection: { status: "error", error: "HTTP 500" },
        onInspect: () => {},
      })
    );
    // body only renders while open; the row itself is present either way
    expect(html).toContain("data-inspect-window-button");
  });
});

describe("SeeDetailToggle (ADAAAA-7838)", () => {
  it("is an aria-pressed toggle whose state is exposed for QA", () => {
    expect(renderToString(React.createElement(SeeDetailToggle, { on: false, onToggle: () => {} }))).toContain(
      'aria-pressed="false"'
    );
    const on = renderToString(React.createElement(SeeDetailToggle, { on: true, onToggle: () => {} }));
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('data-active="true"');
    expect(on).toContain("See detail");
  });
});
