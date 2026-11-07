// ADAAAA-8287: the decide row must state WHICH lane confirmed it, and the
// window inspector must show the stored attestation behind that lane. Two lanes
// accept a VOD highlight and only the Stage-2 dive leaves a confirm panel, so a
// lane-1 (measured attestation) accept used to be indistinguishable from an
// unconfirmed one. SSR asserts the static contract (collapsed row label + the
// populated inspector).
import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { AnalysisWindow } from "./JobDetail";
import { WindowAnalysisPanel } from "../components/WindowAnalysis";
import type { DecideNote, FrameSection, WindowAnalysis, WindowConfirmation } from "../lib/jobDetail";

function frame(seq: number, timestamp: number) {
  return { seq, timestamp, uri: `/jobs/j1/frames/${seq}`, tracks: [] };
}
function note(over: Partial<DecideNote> & { status: DecideNote["status"] }): DecideNote {
  return { seq: 0, timestamp: 0, eventType: "GOAL", score: 90, isHighlight: true, ...over };
}
function section(decideNotes: DecideNote[]): FrameSection {
  return { index: 0, startS: 0, endS: 3, frames: [frame(0, 0.2)], decideNotes };
}
const renderWindow = (s: FrameSection, defaultOpen = false) =>
  renderToString(
    React.createElement(AnalysisWindow, {
      section: s,
      token: null,
      jobId: "j1",
      selectMode: false,
      selectedSeqs: new Set<number>(),
      onFrameClick: () => {},
      defaultOpen,
    })
  );

const measured: WindowConfirmation = {
  lane: "measured",
  label: "Confirmed by measured score: 0-0 → 0-1 at 04:47",
  measurement: "score",
  detail: "0-0 → 0-1 at 04:47",
  flags: { scoreboardChanged: true, ballCrossedLineBetweenPosts: null, ballInNet: null, crowdErupted: true },
  flagsSource: "stage1_verdict",
};

const dive: WindowConfirmation = {
  lane: "dive",
  label: "Confirmed by deep dive (Stage-2)",
  measurement: "dive",
  flags: { scoreboardChanged: true, ballCrossedLineBetweenPosts: true, ballInNet: true, crowdErupted: true },
  flagsSource: "dive_evidence",
  dive: { goalConfirmed: "confirmed_goal", confidence: 1, stage1Disagreed: false, outcome: "scoring_play", corroborated: true },
};

const disagreed: WindowConfirmation = {
  lane: "dive_disagreed",
  label: "dive did not corroborate",
  measurement: "none",
  dive: { goalConfirmed: "not_goal", confidence: 0.8, stage1Disagreed: false, outcome: "near_miss", corroborated: false },
};

const analysis: WindowAnalysis = {
  prompt: "You are a sports highlight judge",
  dataItems: [],
  frames: [],
  images: [],
  response: { isHighlight: true, score: 85, outcome: "scoring_play", evidenceAttested: [] },
};

describe("decide row lane label (ADAAAA-8287 AC1)", () => {
  it("states the lane in the row body with the inspector COLLAPSED", () => {
    // section expanded, decide-note banner still collapsed: the row sentence is
    // visible WITHOUT opening the inspector.
    const html = renderWindow(section([note({ timestamp: 120, status: "accepted", confirmation: measured })]), true);
    expect(html).not.toContain("data-window-analysis");
    expect(html).toContain('data-confirm-lane="measured"');
    expect(html).toContain("Confirmed by measured score: 0-0 → 0-1 at 04:47");
    expect(html).toContain('data-confirm-lane-measurement="score"');
  });

  it("distinguishes lane 1 from lane 2 on the row itself", () => {
    const lane2 = renderWindow(section([note({ timestamp: 117, status: "accepted", confirmation: dive })]), true);
    expect(lane2).toContain('data-confirm-lane="dive"');
    expect(lane2).toContain("Confirmed by deep dive (Stage-2)");
    // the lane-1 sentence never appears on a dive-confirmed row
    expect(lane2).not.toContain("Confirmed by measured");
  });

  it("a demotion reads 'dive did not corroborate' and never a lane-1 label (AC2)", () => {
    const html = renderWindow(
      section([note({ timestamp: 200, status: "rejected", outcome: "near_miss", isHighlight: false, confirmation: disagreed })]),
      true
    );
    expect(html).toContain('data-confirm-lane="dive_disagreed"');
    expect(html).toContain("dive did not corroborate");
    expect(html).not.toContain("Confirmed by measured");
    expect(html).not.toContain("Confirmed by deep dive");
  });
});

describe("window inspector attestation (ADAAAA-8287 AC3)", () => {
  it("renders the four stored flags + the dive verdict for a lane-2 row", () => {
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis, confirm: undefined, confirmation: dive, jobId: "j1", triggerTs: 117 })
    );
    expect(html).toContain('data-confirmation-block="dive"');
    for (const flag of ["ballCrossedLineBetweenPosts", "ballInNet", "scoreboardChanged", "crowdErupted"]) {
      expect(html).toContain(`data-attestation-flag="${flag}"`);
    }
    expect(html).toContain('data-attestation-flag="ballInNet" data-attestation-value="seen"');
    expect(html).toContain('data-dive-verdict="corroborated"');
    expect(html).toContain("confirmed goal");
  });

  it("a lane-1 row shows 'unverifiable' for a null criterion and states no dive ran", () => {
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis, confirm: undefined, confirmation: measured, jobId: "j1", triggerTs: 120 })
    );
    expect(html).toContain('data-attestation-flag="ballInNet" data-attestation-value="unverifiable"');
    expect(html).toContain('data-dive-verdict="none"');
    expect(html).toContain("no deep dive ran (measured attestation)");
  });

  it("still states the lane when the window capture is legacy (no analysis)", () => {
    const html = renderToString(React.createElement(WindowAnalysisPanel, { confirmation: dive, jobId: "j1" }));
    expect(html).toContain('data-window-analysis="not-captured"');
    expect(html).toContain('data-confirmation-block="dive"');
  });
});

describe("confirm panel stays dive-only (ADAAAA-8287 AC4)", () => {
  const confirm = {
    request: { prompt: "confirm", dataItems: [], frames: [], keyframes: [], trajectories: [], audioLevels: [] },
    decision: { goalConfirmed: "confirmed_goal" as const, confidence: 1, stage1Disagreed: false, outcome: "scoring_play" as const },
  };
  it("a lane-1 row has no confirm panel even with the inspector open", () => {
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis, confirm: undefined, confirmation: measured, jobId: "j1", triggerTs: 120 })
    );
    expect(html).toContain("data-window-analysis");
    expect(html).toContain('data-confirmation-block="measured"');
    expect(html).not.toContain("data-confirm-panel");
  });

  it("a stored dive record still renders its panel", () => {
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis, confirm, confirmation: dive, jobId: "j1", triggerTs: 117 })
    );
    expect(html).toContain("data-confirm-panel");
  });
});
