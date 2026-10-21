// ADAAAA-7157 Increment C — the expandable per-window LLM inspection panel.
//
// SSR (renderToString) contract tests: the panel is READ-ONLY over the
// job-detail API payload (Incr B) and must render, for a captured window, the
// verbatim prompt, each structured data item, the media ref chips, and the full
// LLM response + reasoning; when the candidate went deeper it renders the
// "Confirm (deep dive)" sub-panel with the confirm request context and its
// ConfirmDecision; legacy windows with no capture render an explicit
// "not captured" state — never a blank.
//
// The frame-thumbnail <img> and the expand toggles are client-only (auth-fetch
// of frame bytes + click state); in SSR we assert the static contract — the
// reference chips, the prompt/items/response text, and the deep-dive body via
// ConfirmSubPanel(defaultOpen).
import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { WindowAnalysisPanel, ConfirmSubPanel } from "./WindowAnalysis";
import type { WindowAnalysis, ConfirmRecord } from "../lib/jobDetail";

const analysis: WindowAnalysis = {
  prompt: `You are a highlight analyst. Decide whether this window is a scoring play.\nFrames: 0..3`,
  dataItems: [
    { type: "frame_count", label: "Frames", value: 4 },
    { type: "score_delta", label: "Score delta", value: 2 },
    { type: "in_zone", label: "In attacking zone", value: true },
    { type: "notes", label: "Notes", value: null },
  ],
  frames: [{ seq: 0, uri: "" }, { seq: 1, uri: "" }, { seq: 2, uri: "" }],
  images: [{ seq: 10, uri: "/jobs/abc/images/10.jpg" }],
  audio: { uri: "/audio.wav", sampleRate: 16000, path: "input_audio" },
  asr: { transcript: "GOAL scored by number 9", latencyS: 1.2 },
  response: {
    isHighlight: true,
    score: 92,
    eventType: "goal",
    outcome: "scoring_play",
    reason: "Clear scoring play in the attacking zone.",
    reasoning: "The ball crossed the line; frames 0-2 show the shot.",
    verdict: "confirmed_goal",
    evidenceAttested: ["frame_0", "frame_1", "frame_2"],
    audioContext: { level: 0.9 },
    source: "gemma-4-12b",
  },
};

const confirm: ConfirmRecord = {
  request: {
    prompt: "Confirm the scoring play with the frame-level deep dive.",
    dataItems: [{ type: "frame_count", label: "Frames", value: 8 }],
    frames: [{ seq: 0, uri: "" }],
    keyframes: [{ seq: 2, uri: "" }],
    trajectories: ["t-1", "t-2"],
    opticalFlowMagnitude: 0.42,
    audioLevels: [0.1, 0.5, 0.9],
    transcript: "GOAL scored",
    stage1: { outcome: "scoring_play" },
  },
  decision: {
    goalConfirmed: "confirmed_goal",
    confidence: 0.96,
    reason: "Frame-level evidence confirms the scoring play.",
    evidence: { frames: [0, 1, 2] },
    stage1Disagreed: false,
    outcome: "scoring_play",
  },
};

describe("WindowAnalysisPanel (ADAAAA-7157)", () => {
  it("renders the verbatim prompt, each data item, and the LLM response", () => {
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis, jobId: "abc" })
    );
    expect(html).toContain("data-window-analysis");
    // Verbatim prompt (monospace pre)
    expect(html).toContain("data-prompt");
    expect(html).toContain("You are a highlight analyst");
    expect(html).toContain("Decide whether this window is a scoring play.");
    expect(html).toContain("Frames: 0..3");
    // Each data item rendered
    expect(html).toContain("data-analysis-dataitems");
    expect(html).toContain("data-data-item");
    expect(html).toContain("frame_count");
    expect(html).toContain("Score delta");
    expect(html).toContain("In attacking zone");
    expect(html).toContain("yes");
    expect(html).toContain("—"); // null value degrades to "—"
    // Media refs: frames + images labels and the canonical delivery URIs
    expect(html).toContain("data-refs=\"Frames\"");
    expect(html).toContain("/jobs/abc/frames/0");
    expect(html).toContain("data-refs=\"Images\"");
    expect(html).toContain("/jobs/abc/images/10.jpg");
    // Audio / ASR block
    expect(html).toContain("data-audio-asr");
    expect(html).toContain("GOAL scored by number 9");
    // Full LLM response: score / outcome / reason + reasoning + verdict + evidence
    expect(html).toContain("data-response");
    expect(html).toContain("data-response-score");
    expect(html).toContain("92");
    expect(html).toContain("data-response-reason");
    expect(html).toContain("data-response-reasoning");
    expect(html).toContain("The ball crossed the line");
    expect(html).toContain("data-response-verdict");
    expect(html).toContain("confirmed_goal");
    expect(html).toContain("data-response-evidence");
    expect(html).toContain("frame_0");
    expect(html).toContain("data-response-audio-context");
  });

  it("renders an explicit 'not captured' state when no analysis was captured (legacy)", () => {
    const html = renderToString(React.createElement(WindowAnalysisPanel, { jobId: "abc" }));
    expect(html).toContain('data-window-analysis="not-captured"');
    expect(html).toContain("Analysis not captured for this window");
    expect(html).not.toContain("data-prompt");
  });

  it("renders the Confirm (deep dive) sub-panel when a confirm record exists", () => {
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis, confirm, jobId: "abc" })
    );
    expect(html).toContain("data-confirm-panel");
    expect(html).toContain("Confirm (deep dive)");
    expect(html).toContain("confirmed goal"); // goalConfirmed chip on the toggle
  });

  it("renders the confirm request context + ConfirmDecision in the deep-dive body", () => {
    const html = renderToString(
      React.createElement(ConfirmSubPanel, { confirm, defaultOpen: true })
    );
    // Request context
    expect(html).toContain("data-confirm-prompt");
    expect(html).toContain("Confirm the scoring play with the frame-level deep dive.");
    expect(html).toContain("data-refs=\"Keyframes\"");
    expect(html).toContain("Trajectories");
    expect(html).toContain("Optical flow mag.");
    expect(html).toContain("0.42");
    expect(html).toContain("Audio levels");
    // ConfirmDecision
    expect(html).toContain("data-confirm-decision");
    expect(html).toContain("Goal confirmed");
    expect(html).toContain("confirmed goal");
    expect(html).toContain("Confidence");
    expect(html).toContain("96%");
    expect(html).toContain("Stage-1 disagreed");
    expect(html).toContain("Reconciled outcome");
    expect(html).toContain("scoring_play");
    expect(html).toContain("data-confirm-reason");
    expect(html).toContain("Frame-level evidence confirms the scoring play.");
  });
});
