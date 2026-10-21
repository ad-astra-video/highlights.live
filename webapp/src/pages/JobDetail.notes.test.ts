// ADAAAA-7135 (Tier-1): the observe-loop running action notes surface in the
// per-job detail panel. The two-tier core's continuous decide observer
// accumulates the job's runningSummary narrative ("watch + notes") — distinct
// from `job.candidates`, which now holds only confirmed highlights. These
// render-agnostic SSR tests assert the surface only renders when the job
// actually produced notes (never an empty/blank panel), and that it is labeled
// as the running action notes (Tier-1) rather than re-surfacing raw candidates.
import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { RunningActionNotes } from "./JobDetail";

describe("Tier-1 running action notes surface (ADAAAA-7135)", () => {
  it("renders the running action narrative when the job produced one", () => {
    const html = renderToString(
      React.createElement(RunningActionNotes, {
        summary: "T+0s: kickoff. T+12s: ball into midfield, no scoring play yet.",
      })
    );
    expect(html).toContain("data-detail-running-summary");
    expect(html).toContain("Running action notes");
    expect(html).toContain("T+0s: kickoff");
  });

  it("renders nothing (not a blank panel) when the job has no running notes", () => {
    const html = renderToString(React.createElement(RunningActionNotes, {}));
    // The marker is absent so no empty surface shows for a job with no produced
    // narrative (legacy / no observe cadence) — never a blank panel.
    expect(html).not.toContain("data-detail-running-summary");
    expect(html.trim()).toBe("");
  });
});
