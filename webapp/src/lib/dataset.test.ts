import { describe, it, expect } from "vitest";
import {
  exportManifests,
  autoSeedBoxes,
  coverageSummary,
  parseManifestJsonl,
  phashFromImageData,
  acceptedSamples,
  type CurationFrame,
} from "./dataset";
import { validateManifest } from "@highlights/events";

function frame(id: string, opts: Partial<CurationFrame> = {}): CurationFrame {
  return {
    id,
    imageRef: `data/training/frames/${id}.jpg`,
    width: 1280,
    height: 720,
    uri: null,
    phash: id.length === 1 ? `${id}`.repeat(16) : `${id}`.padEnd(16, "0"),
    sourceSeq: 0,
    accepted: true,
    boxes: [{ id: `${id}-b0`, label: "player", bbox: [0.1, 0.2, 0.3, 0.4] }],
    ...opts,
  };
}

describe("DatasetCuration export pipeline (ADAAAA-5164)", () => {
  it("autoSeedBoxes canonicalizes raw detector labels into the closed vocab", () => {
    const seeded = autoSeedBoxes([
      { label: "person", bbox: [0, 0, 0.2, 0.2] },
      { label: "football", bbox: [0.3, 0.3, 0.4, 0.4] },
      { label: "goalie", bbox: [0.5, 0.5, 0.6, 0.6] },
      { label: "cat", bbox: [0.7, 0.7, 0.8, 0.8] },
    ]);
    expect(seeded.map((s) => s.label)).toEqual(["player", "soccer ball", "goalkeeper"]);
  });

  it("exportManifests writes a Zod-valid train/val split (85/15)", () => {
    const frames = Array.from({ length: 120 }, (_, i) => frame(`f${i}`));
    const out = exportManifests(frames);
    expect(out.train.length + out.val.length).toBe(120);
    expect(out.valid).toBe(true);
    expect(out.validationErrors).toEqual([]);
    // every JSONL line re-parses against the shared schema
    const trainSamples = parseManifestJsonl(out.trainJsonl);
    const valSamples = parseManifestJsonl(out.valJsonl);
    expect(validateManifest([...trainSamples, ...valSamples]).valid).toBe(true);
    expect(out.train.length).toBe(trainSamples.length);
    expect(out.val.length).toBe(valSamples.length);
    const ratio = out.train.length / 120;
    expect(ratio).toBeGreaterThanOrEqual(0.8);
    expect(ratio).toBeLessThanOrEqual(0.9);
  });

  it("coverageSummary counts per label + total frames", () => {
    const frames = [
      frame("a", { boxes: [{ id: "a1", label: "player", bbox: [0, 0, 0.5, 0.5] }] }),
      frame("b", { boxes: [{ id: "b1", label: "player", bbox: [0, 0, 0.5, 0.5] }, { id: "b2", label: "soccer ball", bbox: [0.2, 0.2, 0.3, 0.3] }] }),
    ];
    const c = coverageSummary(acceptedSamples(frames));
    expect(c.byLabel.player.count).toBe(2);
    expect(c.byLabel["soccer ball"].count).toBe(1);
    expect(c.totalFrames).toBe(2);
  });

  it("phashFromImageData is deterministic for identical pixels", () => {
    const px = new Uint8ClampedArray(4 * 4 * 4).fill(200); // 4x4 solid
    const a = phashFromImageData(px, 4, 4);
    const b = phashFromImageData(new Uint8ClampedArray(4 * 4 * 4).fill(200), 4, 4);
    expect(a).toBe(b);
    expect(a.length).toBe(16); // 64-bit aHash as hex
  });
});
