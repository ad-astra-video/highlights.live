// ADAAAA-8835 (Inc 1): the board-visible half of the per-job score-bug pin.
//
// AC6 says the job page and the job API both expose `scoreboardSurface` with a
// TRUTHFUL `source`. The API half is proven on the server (`scoreboard-surface`
// unit + job route); this file proves the page half on rendered markup, and that
// a pin can never be presented as `discovery` (the defect that made the parent
// report [ADAAAA-8833](/ADAAAA/issues/ADAAAA-8833) undiagnosable).
//
// Pure functions + a static render, node env (same convention as
// `AnalyzePositionChip.test.tsx`).
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import { ScoreboardSurfaceReadout } from "./ScoreboardSurfaceReadout";
import {
  describeScoreboardSurface,
  describeSurfaceIdentity,
  formatScoreboardRoi,
  parseScoreboardRoiInput,
  scoreboardSourceLabel,
  type ScoreboardSurface,
} from "../lib/scoreboardSurface";

const PIN: ScoreboardSurface = {
  roi: [0, 0, 0.55, 0.18],
  source: "explicit",
  seqFirstSeen: 41,
  verified: true,
};

function render(surface?: ScoreboardSurface): string {
  return renderToStaticMarkup(<ScoreboardSurfaceReadout surface={surface} />);
}

describe("ScoreboardSurfaceReadout (AC6 — the job page)", () => {
  it("labels an operator pin `pinned` and never `auto-detected`", () => {
    const html = render(PIN);
    expect(html).toContain("data-scoreboard-surface-source=\"explicit\"");
    expect(html).toContain("0,0,0.55,0.18");
    expect(html).toContain("pinned");
    expect(html).toContain("first seen at frame 41");
    expect(html).toContain("score read");
    expect(html).not.toContain("auto-detected");
  });

  it("labels a discovered box `auto-detected` and a prior `default prior`", () => {
    const html = render({ ...PIN, source: "discovery", seqFirstSeen: 3, verified: false });
    expect(html).toContain("data-scoreboard-surface-source=\"discovery\"");
    expect(html).toContain("auto-detected");
    expect(html).toContain("score not read yet");
    expect(
      render({ ...PIN, source: "default_top_band" })
    ).toContain("default prior");
  });

  it("says a declared-but-unobserved pin is declared, not observed", () => {
    const html = render({ ...PIN, seqFirstSeen: -1, verified: false });
    expect(html).toContain("declared");
    expect(html).not.toContain("first seen at frame");
  });

  it("renders `not recorded` (no pin implied) when the record has no block", () => {
    const html = render(undefined);
    expect(html).toContain("data-scoreboard-surface-source=\"none\"");
    expect(html).toContain("not recorded");
  });
});

describe("describeScoreboardSurface / formatScoreboardRoi", () => {
  it("is one honest line with the box, provenance, seq and read state", () => {
    expect(describeScoreboardSurface(PIN)).toBe(
      "0,0,0.55,0.18 · pinned · first seen at frame 41 · score read"
    );
  });

  it("never names a source for a block that does not exist", () => {
    expect(describeScoreboardSurface(undefined)).toBe("not recorded");
    expect(scoreboardSourceLabel(undefined)).toBe("not recorded");
  });

  it("formats a box to at most 4 decimals", () => {
    expect(formatScoreboardRoi([0, 0.123456, 1, 0.5])).toBe("0,0.1235,1,0.5");
    expect(formatScoreboardRoi(undefined)).toBe("");
  });
});

describe("parseScoreboardRoiInput (the typed box on the job form)", () => {
  it("treats a blank box as no pin (today's auto-detect)", () => {
    expect(parseScoreboardRoiInput("")).toEqual({ ok: true, roi: undefined });
    expect(parseScoreboardRoiInput("   ")).toEqual({ ok: true, roi: undefined });
  });

  it("accepts comma, space and semicolon separated normalized boxes", () => {
    const want = { ok: true, roi: [0, 0, 0.55, 0.18] };
    expect(parseScoreboardRoiInput("0,0,0.55,0.18")).toEqual(want);
    expect(parseScoreboardRoiInput(" 0 0 0.55 0.18 ")).toEqual(want);
    expect(parseScoreboardRoiInput("0;0;0.55;0.18")).toEqual(want);
  });

  it("rejects a malformed box before it is sent for a server 422", () => {
    for (const bad of ["0,0,0.5", "0,0,0.5,0.2,1", "0,0,x,0.2", "0,0,0.5,2", "-0.1,0,0.5,0.2", "0.6,0,0.5,0.2", "0,0.3,0.5,0.2"]) {
      const r = parseScoreboardRoiInput(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    }
  });
});

// ADAAAA-8844 (Inc 2): the board must see the identity verdict AND the named
// demotion, so a window that was not accepted says why without a replay.
describe("ScoreboardSurfaceReadout (ADAAAA-8844 identity)", () => {
  it("renders the measured identity verdict, and the demotion reason when one exists", () => {
    const contradicted: ScoreboardSurface = {
      ...PIN,
      identity: { verdict: "contradicted", kitDistance: 0.42, threshold: 0.35 },
      demotion: "score change on a contradicted score surface: ignored",
    };
    const html = render(contradicted);
    expect(html).toContain("surface: different match (kits Δ=0.42 &gt; 0.35)");
    expect(html).toContain("data-scoreboard-surface-demotion");
    expect(html).toContain("contradicted score surface");
    // It never reads as this match's surface.
    expect(html).not.toContain("surface: this match");
  });

  it("says `this match` for a consistent surface and adds no demotion chip", () => {
    const html = render({ ...PIN, identity: { verdict: "consistent", kitDistance: 0.04, threshold: 0.35 } });
    expect(html).toContain("surface: this match");
    expect(html).not.toContain("data-scoreboard-surface-demotion");
  });

  it("calls an unreadable surface unreadable, not contradicted (absence is not contradiction)", () => {
    const html = render({ ...PIN, identity: { verdict: "absent" } });
    expect(html).toContain("surface: unreadable surface");
    expect(html).not.toContain("different match");
    expect(html).not.toContain("data-scoreboard-surface-demotion");
  });

  it("leaves a surface with no identity reading unchanged", () => {
    expect(render(PIN)).not.toContain("surface:");
    expect(describeSurfaceIdentity(undefined)).toBe("");
  });
});
