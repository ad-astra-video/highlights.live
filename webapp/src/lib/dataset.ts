// Dataset Curation helpers (ADAAAA-5164): bridge the curation UI's frame model
// to the shared DetectionTrainingSample contract + pipeline (perceptual-hash
// bucketing, coverage accounting, near-dup-aware 85/15 split, Zod-validated
// JSONL export). Pure and unit-testable without a browser.
import {
  type DetectionTrainingSample,
  type DetectionTrainingBox,
  type TrainingLabel,
  buildSample,
  coverageSummary,
  seedBoxesFromDetections,
  splitTrainVal,
  serializeManifestJsonl,
  validateManifest,
  parseManifestJsonl,
  perceptualHash,
} from "@highlights/events";

export interface CurationBox {
  id: string;
  label: TrainingLabel;
  bbox: [number, number, number, number];
}

export interface CurationFrame {
  id: string;
  imageRef: string;
  width: number;
  height: number;
  /** object URL or fetchable path the canvas renders (null until the frame's
   * pixels are available / loaded). */
  uri: string | null;
  /** perceptual hash of the frame's pixels, used for near-dup bucketing. */
  phash: string;
  sourceSeq: number;
  /** absolute time (seconds on the clip) of this frame. Set by the curation
   * windowing layer (ADAAAA-5512) so the carousel can place each frame on the
   * clip timeline and map time-jumps to frames. Optional for backward compat
   * with persisted / saved-dataset frames. */
  sourceTime?: number;
  accepted: boolean;
  boxes: CurationBox[];
}

export function toSample(frame: CurationFrame): DetectionTrainingSample {
  return buildSample(frame.id, frame.imageRef, frame.width, frame.height, frame.boxes);
}

export function acceptedSamples(frames: CurationFrame[]): DetectionTrainingSample[] {
  return frames.filter((f) => f.accepted).map(toSample);
}

/** A `phashOf` lookup (id -> phash) over the current frame set, for the split. */
export function phashOfFrames(frames: CurationFrame[]): (id: string) => string {
  const map = new Map(frames.map((f) => [f.id, f.phash]));
  return (id: string) => map.get(id) ?? "";
}

/** Browser-side perceptual hash from a decoded RGBA buffer (e.g. a <canvas>
 * 2d context's ImageData), so near-dup bucketing runs where the pixels are. */
export function phashFromImageData(data: Uint8ClampedArray, width: number, height: number): string {
  return perceptualHash(data, width, height);
}

/** Auto-seed boxes from a base detector's raw outputs (canonicalized to the
 * closed 5-label soccer vocab, out-of-vocab dropped). Mirrors the perceive
 * `_LABEL_ALIASES` mapping. */
export function autoSeedBoxes(raw: Array<{ label: string; bbox: [number, number, number, number] }>): DetectionTrainingBox[] {
  return seedBoxesFromDetections(raw);
}

export interface ExportedManifests {
  train: DetectionTrainingSample[];
  val: DetectionTrainingSample[];
  trainJsonl: string;
  valJsonl: string;
  valid: boolean;
  validationErrors: string[];
}

/** Export accepted frames to Zod-validated train/val JSONL manifests. */
export function exportManifests(frames: CurationFrame[]): ExportedManifests {
  const accepted = acceptedSamples(frames);
  const { train, val } = splitTrainVal(accepted, { phashOf: phashOfFrames(frames) });
  const trainJsonl = serializeManifestJsonl(train);
  const valJsonl = serializeManifestJsonl(val);
  const v = validateManifest([...train, ...val]);
  return { train, val, trainJsonl, valJsonl, valid: v.valid, validationErrors: v.errors };
}

export { coverageSummary, parseManifestJsonl };
