// Curated-manifest feed for the fine-tune trigger (ADAAAA-5323, Increment B).
//
// Increment A (the annotation loop) publishes schema-valid
// `train_manifest.jsonl` / `val_manifest.jsonl` under a server-visible
// directory. This module lets the fine-tune page launch a run straight from
// that curated data (the default path) while the manual JSON-paste trigger
// stays as the operator fallback. The train route loads the curated manifests
// here instead of requiring the client to paste them.
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ServerConfig } from "./config";

export interface CuratedManifestSet {
  present: boolean;
  trainPath?: string;
  valPath?: string;
  trainCount?: number;
  valCount?: number;
  updatedAt?: string;
}

export function curatedTrainPath(cfg: ServerConfig): string {
  return path.join(cfg.curatedManifestDir, "train_manifest.jsonl");
}
export function curatedValPath(cfg: ServerConfig): string {
  return path.join(cfg.curatedManifestDir, "val_manifest.jsonl");
}

/** Line count of a newline-delimited JSON file without keeping it in memory
 * beyond the read (manifests are bounded; an odd number of BOM/newline tokens
 * is tolerated by filtering blank lines). */
function countJsonlLines(file: string): number {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return 0;
    const text = readFileSync(file, "utf8").trim();
    if (!text) return 0;
    return text.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** List whether curated train/val manifests are available (+ counts + freshness)
 * so the UI can offer the one-click curated trigger and show what it will use. */
export function inspectCuratedManifests(cfg: ServerConfig): CuratedManifestSet {
  const trainPath = curatedTrainPath(cfg);
  const valPath = curatedValPath(cfg);
  const trainCount = countJsonlLines(trainPath);
  const valCount = countJsonlLines(valPath);
  const trainStat = existsSync(trainPath) && statSync(trainPath).isFile() ? statSync(trainPath) : null;
  return {
    present: (trainStat?.isFile() ?? false) && trainCount > 0,
    trainPath: trainStat?.isFile() ? trainPath : undefined,
    valPath: existsSync(valPath) && statSync(valPath).isFile() ? valPath : undefined,
    trainCount: trainCount > 0 ? trainCount : undefined,
    valCount: valCount > 0 ? valCount : undefined,
    updatedAt: trainStat?.mtime ? trainStat.mtime.toISOString() : undefined,
  };
}

/** Read the curated train (+ optional val) manifests as JSONL strings for
 * submission. Throws when no curated manifest is present so the route can 422. */
export async function loadCuratedManifest(cfg: ServerConfig): Promise<{ manifest: string; val?: string }> {
  const trainPath = curatedTrainPath(cfg);
  const valPath = curatedValPath(cfg);
  if (!existsSync(trainPath) || !statSync(trainPath).isFile()) {
    throw new Error("no curated train manifest published yet");
  }
  const manifest = await readFile(trainPath, "utf8");
  if (!manifest.trim()) throw new Error("curated train manifest is empty");
  const val = existsSync(valPath) && statSync(valPath).isFile() ? await readFile(valPath, "utf8") : undefined;
  return { manifest, val };
}
