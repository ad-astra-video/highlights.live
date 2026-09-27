// Florence-2 fine-tune data path (ADAAAA-5164): server-side frame extraction
// + manifest write, gated by the shared DetectionTrainingSample contract.
//
// The webapp curates frames (pan/zoom/draw/move/delete boxes, assign a class
// from the closed 5-label soccer vocab, per-frame accept) and POSTs the
// approved train/val sample sets here. This module is the server-side gate
// that guarantees only Zod-valid rows ever reach `evals/train_manifest.jsonl`
// and `evals/val_manifest.jsonl`. No training GPU is scheduled on this leg --
// it only prepares data; submission to the training box is documented (see
// docs/fine-tune-data-path.md) and owned by Infra Monitor.
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DetectionTrainingSampleSchema,
  type DetectionTrainingSample,
} from "@highlights/events";
import { extractFrames } from "./ffmpeg";

const TRAIN_SCALE = "1280:720"; // curation scale (base detector + operator)
const TRAIN_FPS = 1;

export interface ExtractedFrameMeta {
  id: string;
  imageRef: string;
  seq: number;
  width: number;
  height: number;
  source: string;
}

/** Extract a VOD clip to curation frames under the dataset staging dir and
 * return the frame metadata the curation UI needs. A sliding time window
 * (inSec/outSec) restricts extraction to a sub-range of the clip; fps defaults
 * to ~1. `imageRef` is kept relative to data/training so the manifest pointer
 * stays valid after frames are staged to object storage by the submission
 * path. */
export async function extractFramesForDataset(opts: {
  ffmpegPath: string;
  source: string;
  outDir: string;
  fps?: number;
  inSec?: number;
  outSec?: number;
}): Promise<ExtractedFrameMeta[]> {
  const fps = opts.fps ?? TRAIN_FPS;
  const files = await extractFrames(
    opts.ffmpegPath,
    opts.source,
    opts.outDir,
    fps,
    TRAIN_SCALE,
    { inSec: opts.inSec, outSec: opts.outSec },
  );
  const relRoot = path.resolve(opts.outDir, ".."); // .../data/training/extract
  return files.map((f, i) => ({
    id: `frame-${String(i + 1).padStart(4, "0")}`,
    imageRef: path.relative(relRoot, f).split(path.sep).join("/"),
    seq: i,
    width: 1280,
    height: 720,
    source: opts.source,
  }));
}

export interface ManifestWriteResult {
  ok: boolean;
  trainPath?: string;
  valPath?: string;
  trainCount: number;
  valCount: number;
  invalidCount: number;
  errors?: string[];
}

/** Validate every train/val sample against the shared Zod schema and, if all
 * pass, write `train_manifest.jsonl` + `val_manifest.jsonl` under evalsDir.
 * Never writes a byte on invalid input -- returns 422 errors instead. */
export async function writeTrainValManifests(opts: {
  train: DetectionTrainingSample[];
  val: DetectionTrainingSample[];
  evalsDir: string;
}): Promise<ManifestWriteResult> {
  const errors: string[] = [];
  ((["train", "val"]) as const).forEach((side) => {
    opts[side].forEach((s, i) => {
      const r = DetectionTrainingSampleSchema.safeParse(s);
      if (!r.success) errors.push(`${side}[${i}]: ${r.error.message}`);
    });
  });
  if (errors.length > 0) {
    return {
      ok: false,
      trainCount: opts.train.length,
      valCount: opts.val.length,
      invalidCount: errors.length,
      errors,
    };
  }
  await fs.mkdir(opts.evalsDir, { recursive: true });
  const trainPath = path.join(opts.evalsDir, "train_manifest.jsonl");
  const valPath = path.join(opts.evalsDir, "val_manifest.jsonl");
  const dump = (side: DetectionTrainingSample[]) =>
    side.map((s) => JSON.stringify(DetectionTrainingSampleSchema.parse(s))).join("\n") + "\n";
  await fs.writeFile(trainPath, dump(opts.train), "utf8");
  await fs.writeFile(valPath, dump(opts.val), "utf8");
  return {
    ok: true,
    trainPath,
    valPath,
    trainCount: opts.train.length,
    valCount: opts.val.length,
    invalidCount: 0,
  };
}
