import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeTrainValManifests } from "../src/dataset";
import { buildExtractArgs } from "../src/ffmpeg";
import { DetectionTrainingSampleSchema, type DetectionTrainingSample } from "@highlights/events";

function sample(id: string, label: string): DetectionTrainingSample {
  return DetectionTrainingSampleSchema.parse({
    id,
    imageRef: `data/training/extract/b1/frame_${id}.jpg`,
    width: 1280,
    height: 720,
    objects: [{ label, bbox: [0.1, 0.2, 0.3, 0.4] }],
  });
}

describe("writeTrainValManifests (ADAAAA-5164 server gate)", () => {
  it("writes Zod-valid train_manifest.jsonl + val_manifest.jsonl on valid input", async () => {
    const evalsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hl-evals-"));
    const res = await writeTrainValManifests({
      train: [sample("a", "player"), sample("b", "soccer ball")],
      val: [sample("c", "goal")],
      evalsDir,
    });
    expect(res.ok).toBe(true);
    expect(res.invalidCount).toBe(0);
    expect(res.trainCount).toBe(2);
    expect(res.valCount).toBe(1);
    const train = await fs.readFile(res.trainPath!, "utf8");
    const val = await fs.readFile(res.valPath!, "utf8");
    // every line re-parses against the shared Zod schema
    const check = (text: string, n: number) => {
      const lines = text.trim().split("\n");
      expect(lines).toHaveLength(n);
      for (const l of lines) expect(DetectionTrainingSampleSchema.safeParse(JSON.parse(l)).success).toBe(true);
    };
    check(train, 2);
    check(val, 1);
    await fs.rm(evalsDir, { recursive: true, force: true });
  });

  it("rejects invalid samples and writes nothing", async () => {
    const evalsDir = await fs.mkdtemp(path.join(os.tmpdir(), "hl-evals-"));
    const bad = {
      id: "bad",
      imageRef: "r",
      width: 1,
      height: 1,
      objects: [{ label: "cat", bbox: [0, 0, 1, 1] }], // out-of-vocab label
    } as unknown as DetectionTrainingSample;
    const res = await writeTrainValManifests({ train: [bad], val: [], evalsDir });
    expect(res.ok).toBe(false);
    expect(res.invalidCount).toBe(1);
    expect(res.errors![0]).toContain("train[0]");
    await expect(fs.readFile(path.join(evalsDir, "train_manifest.jsonl"), "utf8")).rejects.toThrow();
    await fs.rm(evalsDir, { recursive: true, force: true });
  });
});

describe("buildExtractArgs sliding window (ADAAAA-5322 v2)", () => {
  it("omits -ss/-to when no window is given (whole clip, default fps/scale)", () => {
    const args = buildExtractArgs({ source: "s.mp4", outDir: "/o" });
    expect(args).toContain("-i");
    expect(args).not.toContain("-ss");
    expect(args).not.toContain("-to");
    expect(args).toContain("-vf");
    expect(args[args.indexOf("-vf") + 1]).toBe("fps=1,scale=320:180");
  });

  it("positions -ss before -i and -t (duration) after -i for a bounded in/out window", () => {
    // ADAAAA-5512: with an in-point, bound the decode with `-t (outSec -
    // inSec)` so a time-jump window is exact. `-to outSec` after `-ss` input
    // seeking is measured from the stream start, not the seek point, and would
    // over-run the window.
    const args = buildExtractArgs({ source: "s.mp4", outDir: "/o", window: { inSec: 12.5, outSec: 40 } });
    const iIdx = args.indexOf("-i");
    const ssIdx = args.indexOf("-ss");
    const tIdx = args.indexOf("-t");
    expect(args[ssIdx + 1]).toBe("12.5");
    expect(args[tIdx + 1]).toBe("27.5"); // 40 - 12.5
    expect(ssIdx).toBeLessThan(iIdx); // fast-seek before input
    expect(tIdx).toBeGreaterThan(iIdx); // duration bound after input
    expect(args).not.toContain("-to");
  });

  it("uses -to (from stream start) when only an out handle is set (no in-point)", () => {
    const args = buildExtractArgs({ source: "s.mp4", outDir: "/o", window: { outSec: 40 } });
    const toIdx = args.indexOf("-to");
    expect(args[toIdx + 1]).toBe("40");
    expect(args).not.toContain("-t");
  });

  it("honours a custom frame rate inside the window", () => {
    const args = buildExtractArgs({ source: "s.mp4", outDir: "/o", fps: 2, window: { inSec: 5, outSec: 10 } });
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toBe("fps=2,scale=320:180");
  });

  it("emits -ss alone (no -to) when only an in handle is set", () => {
    const args = buildExtractArgs({ source: "s.mp4", outDir: "/o", window: { inSec: 5 } });
    expect(args).toContain("-ss");
    expect(args).not.toContain("-to");
  });
});
