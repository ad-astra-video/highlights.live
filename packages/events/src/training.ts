// Dataset Curation pipeline for Florence-2 fine-tuning (ADAAAA-5164, data path).
//
// Pure, dependency-free helpers shared by the webapp Dataset Curation page and
// the server manifest-write path. Everything here is unit-testable without a
// browser or ffmpeg: frame metadata -> perceptual-hash bucketing -> detection
// auto-seed -> coverage accounting -> near-dup-aware 85/15 train/val split ->
// Zod-validated JSONL manifests.
import {
  DetectionTrainingSampleSchema,
  DetectionTrainingSample,
  DetectionTrainingBox,
  TrainingLabel,
  SOCCER_TRAINING_LABELS,
} from "./index";

// --- class-coverage targets (accepted plan ADAAAA-5159 §2) ----------------
export const COVERAGE_TARGETS: Record<TrainingLabel, { min: number; max: number }> = {
  player: { min: 4000, max: 6000 },
  "soccer ball": { min: 1500, max: 2500 },
  goalkeeper: { min: 300, max: 500 },
  goal: { min: 200, max: 400 },
  referee: { min: 200, max: 300 },
};
export const TOTAL_FRAMES_TARGET = { min: 3000, max: 6000 } as const;
export const TRAIN_VAL_RATIO = 0.85; // 85/15 at frame level

export function coverageTargetsFor(label: TrainingLabel): { min: number; max: number } {
  return COVERAGE_TARGETS[label];
}

// --- label canonicalization (mirrors florence.py _LABEL_ALIASES) ----------
// Florence-2's open-set <OD> labels rarely land on the closed soccer vocab
// verbatim ("person"/"ball"); map a raw detector label to the nearest
// in-vocabulary label, else null (out of scope). Mirrors
// services/perceive/app/florence.py `_LABEL_ALIASES` for the soccer group.
const LABEL_ALIASES: Record<string, TrainingLabel> = {
  ball: "soccer ball",
  football: "soccer ball",
  person: "player",
  man: "player",
  people: "player",
  men: "player",
  woman: "player",
  goalie: "goalkeeper",
  goalkeeper: "goalkeeper",
  player: "player",
  "soccer ball": "soccer ball",
  goal: "goal",
  referee: "referee",
};
// Sub-word tokens that, when the raw label CONTAINS one, resolve to a vocab label.
const LABEL_SUBTOKENS: Array<[string, TrainingLabel]> = [
  ["goalie", "goalkeeper"],
  ["goalkeeper", "goalkeeper"],
  ["referee", "referee"],
  ["ball", "soccer ball"],
  ["soccer", "soccer ball"],
  ["net", "goal"],
  ["goal", "goal"],
];

export function canonicalizeTrainingLabel(raw: string): TrainingLabel | null {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) return null;
  if (LABEL_ALIASES[trimmed]) return LABEL_ALIASES[trimmed];
  for (const [tok, label] of LABEL_SUBTOKENS) {
    if (trimmed.includes(tok)) return label;
  }
  return null;
}

// Auto-seed a curated frame's boxes from a base detector's raw outputs: map
// each raw label through canonicalization and keep only in-vocabulary boxes.
// A raw detection whose label maps to null is dropped.
export function seedBoxesFromDetections(raw: Array<{ label: string; bbox: [number, number, number, number]; confidence?: number }>): DetectionTrainingBox[] {
  const seeded: DetectionTrainingBox[] = [];
  for (const r of raw) {
    const label = canonicalizeTrainingLabel(r.label);
    if (!label) continue;
    seeded.push({ label, bbox: r.bbox });
  }
  return seeded;
}

// --- perceptual hash (average hash, 8x8) -----------------------------------
// 64-bit aHash over an RGBA pixel buffer: downscale each 8x8 cell to its mean
// luma, then one bit per cell = (luma > global mean). Cheap, deterministic, and
// near-duplicate frames (same camera, tiny motion / compression delta) produce
// hashes within a small Hamming distance.
export function perceptualHash(pixels: ArrayLike<number>, width: number, height: number): string {
  const N = 8;
  const cells: number[] = [];
  const blockW = width / N;
  const blockH = height / N;
  for (let cy = 0; cy < N; cy++) {
    for (let cx = 0; cx < N; cx++) {
      let sum = 0;
      let count = 0;
      const y0 = Math.floor(cy * blockH);
      const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * blockH));
      const x0 = Math.floor(cx * blockW);
      const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * blockW));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          // luma (Rec. 601) of RGBA
          sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
          count++;
        }
      }
      cells.push(count ? sum / count : 0);
    }
  }
  const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
  let bits = "";
  for (const v of cells) bits += v >= mean ? "1" : "0";
  // pack groups of 4 bits into hex for compactness
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

export function phashHammingDistance(a: string, b: string): number {
  let dist = 0;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    if (ca === cb) continue;
    let x = ca ^ cb;
    while (x) {
      dist += x & 1;
      x >>>= 1;
    }
  }
  return dist;
}

export interface PhashableFrame {
  id: string;
  phash: string;
}

// Greedy near-duplicate bucketing: a frame joins the first bucket whose anchor
// is within `threshold` Hamming bits; otherwise it seeds a new bucket. Buckets
// keep near-duplicate frames on the same side of a train/val split.
export function bucketNearDuplicates(frames: PhashableFrame[], threshold = 6): PhashableFrame[][] {
  const buckets: PhashableFrame[][] = [];
  for (const f of frames) {
    let placed = false;
    for (const b of buckets) {
      if (phashHammingDistance(b[0].phash, f.phash) <= threshold) {
        b.push(f);
        placed = true;
        break;
      }
    }
    if (!placed) buckets.push([f]);
  }
  return buckets;
}

// --- coverage accounting ----------------------------------------------------
export interface CoverageSummary {
  byLabel: Record<TrainingLabel, { count: number; min: number; max: number; withinRange: boolean }>;
  totalFrames: number;
  totalWithinRange: boolean;
}

export function coverageSummary(samples: Pick<DetectionTrainingSample, "objects">[]): CoverageSummary {
  const counts: Record<string, number> = {};
  for (const s of samples) {
    for (const o of s.objects) counts[o.label] = (counts[o.label] ?? 0) + 1;
  }
  const byLabel = {} as CoverageSummary["byLabel"];
  for (const label of SOCCER_TRAINING_LABELS) {
    const t = COVERAGE_TARGETS[label];
    const count = counts[label] ?? 0;
    byLabel[label] = { count, ...t, withinRange: count >= t.min && count <= t.max };
  }
  return {
    byLabel,
    totalFrames: samples.length,
    totalWithinRange: samples.length >= TOTAL_FRAMES_TARGET.min && samples.length <= TOTAL_FRAMES_TARGET.max,
  };
}

// --- near-dup-aware train/val split -----------------------------------------
// Splits accepted samples 85/15 at frame level. Near-duplicate frames are
// bucketed first and whole buckets are assigned to one side so the same visual
// content never straddles the split (prevents train/val leakage).
export function splitTrainVal(
  accepted: DetectionTrainingSample[],
  opts?: { trainRatio?: number; phashOf?: (id: string) => string; nearDupThreshold?: number }
): { train: DetectionTrainingSample[]; val: DetectionTrainingSample[] } {
  const ratio = opts?.trainRatio ?? TRAIN_VAL_RATIO;
  const threshold = opts?.nearDupThreshold ?? 6;
  const phashOf = opts?.phashOf;
  if (accepted.length === 0) return { train: [], val: [] };

  const buckets: PhashableFrame[][] =
    phashOf
      ? bucketNearDuplicates(accepted.map((s) => ({ id: s.id, phash: phashOf(s.id) })), threshold)
      : accepted.map((s) => [{ id: s.id, phash: "" }]);

  const targetVal = Math.round(accepted.length * (1 - ratio));
  const bySize = [...buckets].sort((a, b) => b.length - a.length);
  const valIds = new Set<string>();
  let valCount = 0;

  // Pass 1 (integrity): assign whole near-dup buckets to val, largest first, so
  // the same visual content never straddles the train/val split.
  for (const b of bySize) {
    if (valCount + b.length > targetVal) continue;
    for (const f of b) valIds.add(f.id);
    valCount += b.length;
  }

  // Pass 2 (robustness): if whole-bucket selection left val empty or far short of
  // the target (degenerate input where a near-dup cluster is coarser than the
  // 15% ratio), top val up toward the target -- preferring whole buckets, then,
  // only if unavoidable, individual samples -- so the split is never empty or
  // wildly lopsided. The unavoidable-leakage case is noted in the docs.
  const minVal = Math.max(1, Math.round(accepted.length * 0.05));
  if (valCount < minVal || targetVal - valCount > Math.max(minVal, accepted.length * 0.1)) {
    for (const b of bySize) {
      if (valCount >= targetVal) break;
      const addable = b.filter((f) => !valIds.has(f.id));
      const take = addable.length + valCount <= targetVal ? addable : addable.slice(0, targetVal - valCount);
      for (const f of take) {
        valIds.add(f.id);
        valCount++;
      }
    }
  }

  const train: DetectionTrainingSample[] = [];
  const val: DetectionTrainingSample[] = [];
  for (const s of accepted) {
    (valIds.has(s.id) ? val : train).push(s);
  }
  return { train, val };
}

// --- manifest I/O (Zod-validated JSONL) ------------------------------------
export function serializeManifestJsonl(samples: DetectionTrainingSample[]): string {
  return samples.map((s) => JSON.stringify(DetectionTrainingSampleSchema.parse(s))).join("\n") + "\n";
}

// Parse + validate each JSONL line against the shared Zod schema. Throws with a
// descriptive error (including the offending line index) on the first invalid
// line, so a malformed manifest can never reach the training box.
export function parseManifestJsonl(text: string): DetectionTrainingSample[] {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new Error(`manifest line ${i + 1}: not valid JSON: ${String(e)}`);
    }
    const parsed = DetectionTrainingSampleSchema.safeParse(obj);
    if (!parsed.success) {
      throw new Error(`manifest line ${i + 1}: fails DetectionTrainingSampleSchema: ${parsed.error.message}`);
    }
    return parsed.data;
  });
}

export function validateManifest(samples: DetectionTrainingSample[]): { valid: boolean; invalidCount: number; errors: string[] } {
  const errors: string[] = [];
  samples.forEach((s, i) => {
    const r = DetectionTrainingSampleSchema.safeParse(s);
    if (!r.success) errors.push(`line ${i + 1}: ${r.error.message}`);
  });
  return { valid: errors.length === 0, invalidCount: errors.length, errors };
}

// Build a contract-valid sample from extracted-frame metadata + curated boxes.
export function buildSample(
  id: string,
  imageRef: string,
  width: number,
  height: number,
  objects: DetectionTrainingBox[]
): DetectionTrainingSample {
  return DetectionTrainingSampleSchema.parse({ id, imageRef, width, height, objects });
}
