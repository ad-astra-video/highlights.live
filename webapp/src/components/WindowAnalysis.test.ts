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
import { WindowAnalysisPanel, ConfirmSubPanel, AudioLevelField } from "./WindowAnalysis";
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
      React.createElement(WindowAnalysisPanel, { analysis, jobId: "abc", promptDefaultOpen: true })
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

  it("collapses the verbatim prompt by default (ADAAAA-8338)", () => {
    const html = renderToString(React.createElement(WindowAnalysisPanel, { analysis, jobId: "abc" }));
    // The wrapper + toggle row stay; the prompt body (and its text) does not.
    expect(html).toContain("data-prompt");
    expect(html).toContain("Prompt (verbatim)");
    expect(html).not.toContain("data-prompt-body");
    expect(html).toContain("data-prompt-toggle");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("You are a highlight analyst");
    // Real button, and aria-controls names the body it would reveal.
    expect(html).toMatch(/<button type="button"[^>]*data-prompt-toggle[^>]*aria-controls="[^"]+"/);
  });

  it("expands the verbatim prompt when promptDefaultOpen is true (ADAAAA-8338)", () => {
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis, jobId: "abc", promptDefaultOpen: true })
    );
    expect(html).toContain("data-prompt-body");
    expect(html).toContain("data-prompt-toggle");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("You are a highlight analyst");
    // Body id matches the toggle's aria-controls (same useId instance).
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
  });

  it("gives two panels on one page distinct prompt body ids (ADAAAA-8338)", () => {
    const html = renderToString(
      React.createElement(
        "div",
        null,
        React.createElement(WindowAnalysisPanel, { analysis, jobId: "abc" }),
        React.createElement(WindowAnalysisPanel, { analysis, jobId: "abc" })
      )
    );
    const ids = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
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

  it("renders the audio energy-vs-baseline graph with the trigger onset marked (ADAAAA-7255)", () => {
    const withSeries: WindowAnalysis = {
      ...analysis,
      audioSeries: [
        { t: 8.0, energy: 0.10, baseline: 0.10 },
        { t: 9.0, energy: 0.55, baseline: 0.11 },
        { t: 10.0, energy: 0.90, baseline: 0.12 },
        { t: 11.0, energy: 0.30, baseline: 0.13 },
      ],
    };
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis: withSeries, jobId: "abc", triggerTs: 10.0 })
    );
    expect(html).toContain("data-audio-series-graph");
    expect(html).toContain("Sound levels");
    expect(html).toContain("data-audio-series-energy");
    expect(html).toContain("data-audio-series-baseline");
    expect(html).toContain("data-audio-trigger");
    expect(html).toContain("data-audio-trigger-label");
    // React SSR inserts `<!-- -->` between static and interpolated text nodes,
    // so assert on the two halves rather than the joined string.
    expect(html).toContain("trigger @ T+");
    expect(html).toContain("10.0");
    expect(html).toContain("energy");
    expect(html).toContain("baseline");
  });

  it("does not render the graph when no audio series was captured", () => {
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis, jobId: "abc", triggerTs: 10.0 })
    );
    expect(html).not.toContain("data-audio-series-graph");
  });

  it("renders the confirm request context + ConfirmDecision in the deep-dive body", () => {
    const html = renderToString(
      React.createElement(ConfirmSubPanel, { confirm, jobId: "abc", defaultOpen: true })
    );
    // Request context
    expect(html).toContain("data-confirm-prompt");
    expect(html).toContain("Confirm the scoring play with the frame-level deep dive.");
    expect(html).toContain('data-refs="Keyframes"');
    // Finding 1 regression: deep-dive frame/keyframe refs use the real job id
    expect(html).toContain("/jobs/abc/frames/0");
    expect(html).toContain("/jobs/abc/frames/2");
    expect(html).not.toContain("/jobs//frames/");
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

  it("renders a playable <audio> element bound to audio.uri (ADAAAA-7277)", () => {
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis, jobId: "abc" })
    );
    expect(html).toContain("data-window-audio-player");
    expect(html).toContain('controls');
    expect(html).toContain('src="/audio.wav"');
    // ASR transcript still rendered alongside the player
    expect(html).toContain("GOAL scored by number 9");
  });

  it("renders the explicit 'No audio captured' badge for a silent window, not a blank box (ADAAAA-7277)", () => {
    const silent: WindowAnalysis = {
      ...analysis,
      audio: { path: "none", sampleRate: 16000 },
      asr: { transcript: "", latencyS: 0.4 },
    };
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis: silent, jobId: "abc" })
    );
    expect(html).toContain("data-window-no-audio");
    expect(html).toContain("No audio captured");
    expect(html).not.toContain("data-window-audio-player");
  });

  it("renders the audio channel metadata (but no player) when audio exists without a servable uri", () => {
    const metaOnly: WindowAnalysis = {
      ...analysis,
      audio: { path: "asr_text", sampleRate: 16000 },
    };
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis: metaOnly, jobId: "abc" })
    );
    expect(html).toContain("data-audio-asr");
    expect(html).toContain("asr_text");
    expect(html).not.toContain("data-window-audio-player");
    expect(html).not.toContain("data-window-no-audio");
  });

  it("renders the audio_level item as a sound-levels graph by default, raw behind a toggle (ADAAAA-7932)", () => {
    const withLevels: WindowAnalysis = {
      ...analysis,
      dataItems: [
        { type: "frame_count", label: "Frames", value: 4 },
        {
          type: "audio_level",
          label: "Audio-energy level curve",
          value: "audio energy level curve (6 samples, peak=0.90, mean=0.46): [0.10,0.55,0.90,0.30,0.22,0.68]",
        },
      ],
    };
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis: withLevels, jobId: "abc" })
    );
    // The field IS the graph: view=graph, plot + header present.
    expect(html).toContain("data-audio-level-field");
    expect(html).toContain('data-audio-level-view="graph"');
    expect(html).toContain("data-audio-level-graph");
    expect(html).toContain("data-audio-level-plot");
    expect(html).toContain("data-audio-series-energy");
    // Mean + peak reference lines carry their actual levels.
    expect(html).toContain("data-audio-level-mean");
    expect(html).toContain('data-audio-level-mean-value="0.46"');
    expect(html).toContain("data-audio-level-peak");
    expect(html).toContain('data-audio-level-peak-value="0.90"');
    // Y axis is window-relative [min(0, minE), maxE] (ADAAAA-7937 AC2), not a
    // fixed 0..1 axis and not a padded band.
    expect(html).toContain("data-audio-level-axis");
    expect(html).toContain(">0.00<"); // yLo = min(0, minE=0.10)
    expect(html).toContain(">0.90<"); // yHi = maxE, the window peak
    expect(html).toContain(">0.45<"); // midpoint of the drawn range
    // Graph is the default; the raw prompt text it replaced is NOT rendered.
    expect(html).toContain('data-audio-level-toggle="graph"');
    expect(html).toContain('data-audio-level-toggle="raw"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain("data-audio-level-raw");
    expect(html).not.toContain("0.10,0.55,0.90");
  });

  it("draws the mean/peak lines from the plotted series, not the prompt-declared stats (ADAAAA-7937 AC3)", () => {
    // The prompt line declares `peak=`/`mean=` over the full pre-downsample
    // evidence; the graph plots the downsampled curve. The reference lines must
    // describe what is drawn, or the peak line sits off the axis peak.
    const html = renderToString(
      React.createElement(AudioLevelField, {
        item: {
          type: "audio_level",
          label: "Audio-energy level curve",
          value: "audio energy level curve (6 samples, peak=0.90, mean=0.46): [0.10,0.55,0.60,0.30,0.22,0.68]",
        },
      })
    );
    // Drawn peak 0.68; drawn mean 2.45/6 = 0.4083 -> 0.41.
    expect(html).toContain('data-audio-level-peak-value="0.68"');
    expect(html).toContain('data-audio-level-mean-value="0.41"');
    expect(html).toContain(">0.68<"); // the axis peak IS the peak line
    expect(html).not.toContain('data-audio-level-peak-value="0.90"');
    expect(html).not.toContain('data-audio-level-mean-value="0.46"');
  });

  it("keeps the raw sent text behind the Raw toggle (ADAAAA-7932)", () => {
    const raw = "audio energy level curve (6 samples, peak=0.90, mean=0.46): [0.10,0.55,0.90,0.30,0.22,0.68]";
    const html = renderToString(
      React.createElement(AudioLevelField, {
        item: { type: "audio_level", label: "Audio-energy level curve", value: raw },
        defaultView: "raw",
      })
    );
    expect(html).toContain('data-audio-level-view="raw"');
    expect(html).toContain("data-audio-level-raw");
    expect(html).toContain(raw);
    expect(html).not.toContain("data-audio-level-graph");
  });

  it("degrades the audio_level item to the plain text row when it holds no usable series (ADAAAA-7932)", () => {
    const html = renderToString(
      React.createElement(AudioLevelField, {
        item: { type: "audio_level", label: "Audio-energy level curve", value: "n/a" },
      })
    );
    expect(html).not.toContain("data-audio-level-field");
    expect(html).toContain('data-data-item="audio_level"');
    expect(html).toContain("n/a");
  });

  it("moves the window gate series graph up to the context-item area when no audio_level item exists (ADAAAA-7932)", () => {
    const withSeries: WindowAnalysis = {
      ...analysis,
      audioSeries: [
        { t: 8.0, energy: 0.10, baseline: 0.10 },
        { t: 9.0, energy: 0.55, baseline: 0.11 },
        { t: 10.0, energy: 0.90, baseline: 0.12 },
      ],
    };
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis: withSeries, jobId: "abc", triggerTs: 10.0 })
    );
    expect(html).toContain("data-audio-level-fallback");
    const itemsAt = html.indexOf("data-analysis-dataitems");
    const graphAt = html.indexOf("data-audio-series-graph");
    const audioBlockAt = html.indexOf("data-audio-asr");
    // The graph sits with the context items, above the audio/ASR block.
    expect(graphAt).toBeGreaterThan(itemsAt);
    expect(graphAt).toBeLessThan(audioBlockAt);
  });
});

// ADAAAA-7937 — the sound-levels graph must be reachable and readable without a
// pointer: role=img with a window-relative, mean/peak-naming aria-label, a
// focusable plot whose Left/Right arrows step the white cross, and no readout
// (or cross) in the graph's resting state. The readout *text* contract and the
// arrow-stepping rules are unit-tested in webapp/src/lib/audioLevel.test.ts.
describe("audio_level graph keyboard + readout contract (ADAAAA-7937 AC4, AC7)", () => {
  const withLevels: WindowAnalysis = {
    ...analysis,
    dataItems: [
      {
        type: "audio_level",
        label: "Audio-energy level curve",
        value: "audio energy level curve (6 samples, peak=0.90, mean=0.46): [0.10,0.55,0.90,0.30,0.22,0.68]",
      },
    ],
  };

  it("is a focusable role=img whose aria-label names the window-relative axis, mean/peak and arrows", () => {
    const html = renderToString(React.createElement(WindowAnalysisPanel, { analysis: withLevels, jobId: "abc" }));
    expect(html).toContain('role="img"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("window-relative axis 0.00 to 0.90");
    expect(html).toContain("mean 0.46");
    expect(html).toContain("peak 0.90");
    expect(html).toContain("arrows step the cross line");
  });

  it("renders no cross line or readout until the pointer/keyboard activates one", () => {
    const html = renderToString(React.createElement(WindowAnalysisPanel, { analysis: withLevels, jobId: "abc" }));
    expect(html).not.toContain("data-audio-level-cross");
    expect(html).not.toContain("data-audio-level-readout");
    expect(html).not.toContain("data-audio-level-crosshair");
  });

  it("carries the 2-dp peak · mean keyline under the plot", () => {
    const html = renderToString(React.createElement(WindowAnalysisPanel, { analysis: withLevels, jobId: "abc" }));
    expect(html).toContain("data-audio-level-keyline");
    expect(html).toContain("peak");
    expect(html).toContain(">0.90<");
    expect(html).toContain("mean");
    expect(html).toContain(">0.46<");
  });
});

// ADAAAA-8187 (child of ADAAAA-8186): the decide layer returns the I1 `Verdict`
// rationale as an OBJECT on the wire (`{hypothesis, independentlyObserved,
// criteria, contradictedBy}`), while the contract keeps `verdict` opaque. The
// panel used to print `String(r.verdict)` → "verdict: [object Object]" and lose
// the whole rationale. These tests pin the formatted rendering, the legacy
// scalar wording, and the opaque-value sweep.
describe("WindowAnalysisPanel verdict rationale formatting (ADAAAA-8187)", () => {
  const rationale = {
    hypothesis: "shot from the left channel",
    independentlyObserved: "ball crossed the line between the posts",
    criteria: {
      ballCrossedLineBetweenPosts: true,
      ballInNet: true,
      scoreboardChanged: false,
      crowdErupted: null,
    },
    contradictedBy: "none",
  };
  const withRationale: WindowAnalysis = {
    ...analysis,
    response: { ...analysis.response!, verdict: rationale },
  };

  it("AC1: renders the rationale fields and criteria tri-states, never [object Object]", () => {
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis: withRationale, jobId: "abc" })
    );
    expect(html).not.toContain("[object Object]");
    // The chip stays a short, non-lossy marker; the rationale renders below it.
    expect(html).toContain("data-response-verdict");
    expect(html).toContain("verdict: rationale");
    expect(html).toContain("data-response-verdict-detail");
    // Every field of the rationale is visible.
    expect(html).toContain("Hypothesis");
    expect(html).toContain("shot from the left channel");
    expect(html).toContain("Independently observed");
    expect(html).toContain("ball crossed the line between the posts");
    expect(html).toContain("Contradicted by");
    expect(html).toContain("none");
    // The four criteria as seen / not seen / unverifiable (wire null).
    expect(html).toContain("ball crossed line between posts: seen");
    expect(html).toContain("ball in net: seen");
    expect(html).toContain("scoreboard changed: not seen");
    expect(html).toContain("crowd erupted: unverifiable");
  });

  it("AC2: a legacy scalar verdict keeps its exact wording and no detail block", () => {
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis, jobId: "abc" })
    );
    expect(html).toContain("verdict: confirmed_goal");
    expect(html).not.toContain("data-response-verdict-detail");
    expect(html).not.toContain("[object Object]");
  });

  it("AC2: a null and an absent verdict both read 'verdict: —'", () => {
    const nullVerdict: WindowAnalysis = {
      ...analysis,
      response: { ...analysis.response!, verdict: null },
    };
    const nullHtml = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis: nullVerdict, jobId: "abc" })
    );
    expect(nullHtml).toContain("verdict: —");
    expect(nullHtml).not.toContain("data-response-verdict-detail");

    const absentVerdict: WindowAnalysis = { ...analysis, response: { ...analysis.response! } };
    delete absentVerdict.response!.verdict;
    const absentHtml = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis: absentVerdict, jobId: "abc" })
    );
    expect(absentHtml).toContain("verdict: —");
    expect(absentHtml).not.toContain("data-response-verdict-detail");
  });

  it("renders '—' for every absent rationale field and for an empty object", () => {
    const sparse: WindowAnalysis = {
      ...analysis,
      response: { ...analysis.response!, verdict: {} },
    };
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis: sparse, jobId: "abc" })
    );
    expect(html).toContain("data-response-verdict-detail");
    expect(html).not.toContain("[object Object]");
  });

  it("AC3: a non-scalar data-item value renders readable text, not [object Object]", () => {
    const drifted: WindowAnalysis = {
      ...analysis,
      dataItems: [
        ...analysis.dataItems,
        { type: "drift", label: "Drifted item", value: { a: 1 } },
      ],
    };
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis: drifted, jobId: "abc" })
    );
    expect(html).toContain('data-data-item="drift"');
    expect(html).toContain("a: 1");
    expect(html).not.toContain("[object Object]");
  });

  it("AC3: a non-scalar attested-evidence entry renders readable text, not [object Object]", () => {
    const withObjectEvidence: WindowAnalysis = {
      ...analysis,
      response: {
        ...analysis.response!,
        evidenceAttested: ["frame_0", { artifact: "scorebug" }] as unknown as string[],
      },
    };
    const html = renderToString(
      React.createElement(WindowAnalysisPanel, { analysis: withObjectEvidence, jobId: "abc" })
    );
    expect(html).toContain("frame_0");
    expect(html).toContain("artifact: scorebug");
    expect(html).not.toContain("[object Object]");
  });
});
