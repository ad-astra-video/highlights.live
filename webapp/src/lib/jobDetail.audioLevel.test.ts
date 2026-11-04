// ADAAAA-7932 — the `audio_level` analysis data item is rendered as a graph,
// with the raw text the decide LLM was handed kept as a view option. These are
// the parser contracts that make the graph data-driven: the decide layer sends
// the item as a compact text line (Stage-1) or as a rounded number array
// (Stage-2 confirm), and anything else must degrade to raw text, never throw.
import { describe, it, expect } from "vitest";
import { parseAudioLevelCurve } from "./jobDetail";

describe("parseAudioLevelCurve (ADAAAA-7932)", () => {
  it("parses the Stage-1 prompt line and keeps the declared peak/mean", () => {
    const curve = parseAudioLevelCurve(
      "audio energy level curve (6 samples, peak=0.90, mean=0.46): [0.10,0.55,0.90,0.30,0.22,0.68]"
    );
    expect(curve).not.toBeNull();
    expect(curve!.values).toEqual([0.1, 0.55, 0.9, 0.3, 0.22, 0.68]);
    expect(curve!.peak).toBe(0.9);
    expect(curve!.mean).toBe(0.46);
    expect(curve!.declared).toBe(true);
  });

  it("does not read the header's sample count / peak / mean digits as samples", () => {
    const curve = parseAudioLevelCurve(
      "audio energy level curve (32 samples, peak=0.82, mean=0.33): [0.12,0.14]"
    );
    expect(curve!.values).toEqual([0.12, 0.14]);
  });

  it("parses the Stage-2 confirm number array and computes peak/mean itself", () => {
    const curve = parseAudioLevelCurve([0.1, 0.5, 0.9]);
    expect(curve!.values).toEqual([0.1, 0.5, 0.9]);
    expect(curve!.peak).toBe(0.9);
    expect(curve!.mean).toBeCloseTo(0.5, 6);
    expect(curve!.declared).toBe(false);
  });

  it("tolerates non-numeric entries in an array payload", () => {
    const curve = parseAudioLevelCurve([0.2, null, "x", 0.6]);
    expect(curve!.values).toEqual([0.2, 0.6]);
  });

  it("accepts a structured {values:[…]} payload", () => {
    const curve = parseAudioLevelCurve({ values: [0.2, 0.4, 0.6], peak: 0.6, mean: 0.4 });
    expect(curve!.values).toEqual([0.2, 0.4, 0.6]);
    expect(curve!.declared).toBe(true);
  });

  it("returns null (raw-text fallback) for values with no usable series", () => {
    expect(parseAudioLevelCurve("n/a")).toBeNull();
    expect(parseAudioLevelCurve("audio energy level curve (1 sample): [0.5]")).toBeNull();
    expect(parseAudioLevelCurve(null)).toBeNull();
    expect(parseAudioLevelCurve(undefined)).toBeNull();
    expect(parseAudioLevelCurve(0.42)).toBeNull();
    expect(parseAudioLevelCurve({})).toBeNull();
  });
});
