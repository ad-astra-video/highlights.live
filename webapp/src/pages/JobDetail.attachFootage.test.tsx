import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard } from "./JobDetail";
import { clipRailPickerLabel, clipRailSlides } from "../lib/clipRail";
import type { JobDetailHighlight } from "../lib/jobDetail";

// ADAAAA-8407: the operator's manual "attach footage" control on the moment
// card. The card lists the job's other decided windows (server-filtered), the
// attach writes the Inc 1 contract with `kind: "manual"`, and a hand-attached
// alternative is named as manual on the rail. These are SSR assertions: the
// package's test env has no jsdom.
const JOB = "545be947-e989-4b26-a464-22b576d97373";

function goal(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "hl-goal",
    jobId: JOB,
    clipUri: "/clips/goal.mp4",
    start: 152,
    end: 167,
    score: 95,
    outcome: "scoring_play",
    status: "accepted",
    createdAt: "2026-11-07T00:00:00.000Z",
    postTitle: "GOAL · 2:39",
    ...over,
  };
}

const manualAlternative = {
  id: "hl-replay",
  jobId: JOB,
  highlightId: "hl-goal",
  relation: "alternative_of" as const,
  eventType: "replay",
  outcome: "big_play",
  replayOf: "hl-goal",
  replayEvidence: { kind: "manual", matches: 0, compared: 0, gapS: 48, attachedBy: "agent-1" },
  windowAnchorTs: 207,
  start: 200,
  end: 215,
  clipId: "hl-replay",
  clipUri: "/clips/replay.mp4",
  createdAt: "2026-11-07T00:00:00.000Z",
};

describe("ADAAAA-8407 attach footage control", () => {
  it("renders the attach toggle and a detach control for a hand-attached window", () => {
    const html = renderToString(
      <HighlightCard
        highlight={goal({ alternatives: [manualAlternative] })}
        onClipChoice={() => {}}
        onLoadAttachCandidates={async () => []}
        onAttachWindow={async () => {}}
        onDetachWindow={async () => {}}
      />
    );
    expect(html).toContain("data-detail-attach-footage");
    expect(html).toContain("Attach footage");
    expect(html).toContain('data-detail-detach="hl-replay"');
    // The rail names the provenance so an operator can tell it from an auto attach.
    expect(html).toContain("Replay @ 200 s · manual");
  });

  it("carries no attach control on a read-only render", () => {
    const html = renderToString(<HighlightCard highlight={goal()} />);
    expect(html).not.toContain("data-detail-attach-footage");
  });

  it("does not offer detach on an auto (detector) attach", () => {
    const auto = {
      ...manualAlternative,
      replayEvidence: { kind: "footage_match", matches: 6, compared: 12, gapS: 48 },
    };
    const html = renderToString(
      <HighlightCard
        highlight={goal({ alternatives: [auto] })}
        onClipChoice={() => {}}
        onLoadAttachCandidates={async () => []}
        onAttachWindow={async () => {}}
        onDetachWindow={async () => {}}
      />
    );
    expect(html).toContain("data-detail-attach-footage");
    expect(html).not.toContain("data-detail-detach=");
    expect(html).toContain("Replay @ 200 s");
    expect(html).not.toContain("· manual");
  });
});

describe("ADAAAA-8407 clip rail copy", () => {
  it("labels a manual alternative as manual", () => {
    const slides = clipRailSlides(goal({ alternatives: [manualAlternative] }));
    const slide = slides.find((s) => s.alternativeId === "hl-replay")!;
    expect(slide.manualAttach).toBe(true);
    expect(clipRailPickerLabel(slide)).toBe("Replay @ 200 s · manual");
  });
});
