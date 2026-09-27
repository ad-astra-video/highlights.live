// Run-scoped fine-tune artifact delivery (ADAAAA-5323).
//
// The highlights-train runner emits a LoRA adapter per completed run. This
// module is the server-side bridge that turns that artifact into a
// run-scoped, integrity-checked download: it resolves the staged file under
// `trainArtifactRoot`, computes / verifies its SHA-256, and hands the route a
// read stream. The UI gets a real download URL (`/train/:id/artifact`) with a
// checksum header instead of a bare server path string.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ServerConfig } from "./config";
import type { TrainArtifact, TrainRun } from "./db";

/** The on-disk file we serve for a run's artifact. The artifact's `filename`
 * is basename-only on purpose (never a user/runner-supplied absolute path), so
 * a run can never reach outside `trainArtifactRoot`. */
export function stagingPath(cfg: ServerConfig, artifact: Pick<TrainArtifact, "filename">): string {
  return path.join(cfg.trainArtifactRoot, path.basename(artifact.filename || "artifact.bin"));
}

/** Derive artifact metadata for a finished run. Picks the LoRA adapter file
 * (runner `artifact.filename`, else basename of `adapter`/`checkpoint`) and
 * resolves it to the staging path. When the file is already present on the
 * server (shared/staged mount), computes + pins its real size + SHA-256 so the
 * integrity check later compares against a concrete digest. */
export async function resolveArtifact(cfg: ServerConfig, result: Record<string, any>): Promise<TrainArtifact | undefined> {
  const raw = (result?.artifact ?? {}) as TrainArtifact;
  const checkpoint = typeof result?.checkpoint === "string" ? result.checkpoint : "";
  const adapter = typeof result?.adapter === "string" ? result.adapter : "";

  // Prefer the runner's own filename; fall back to the checkpoint/adapter base.
  const filename = raw.filename || [adapter, checkpoint].map((p) => path.basename(p || "")).find(Boolean) || "";
  if (!filename) return undefined;

  const artifact: TrainArtifact = {
    filename,
    contentType: raw.contentType || "application/octet-stream",
    size: raw.size,
    sha256: raw.sha256,
    downloadPath: undefined, // set by the caller that knows the run id
  };

  // Pin the real size + hash of the staged file when we can see it.
  const file = stagingPath(cfg, artifact);
  if (existsSync(file) && statSync(file).isFile()) {
    const info = await hashFile(file);
    artifact.size = info.size;
    artifact.sha256 = sha256Hex(info.sha256);
  }
  return artifact;
}

/** Compute (sha256, size) of a file in one pass. */
export function hashFile(file: string): Promise<{ sha256: Buffer; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let size = 0;
    const s = createReadStream(file);
    s.on("data", (chunk) => {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    });
    s.on("error", reject);
    s.on("end", () => resolve({ sha256: hash.digest(), size }));
  });
}

function sha256Hex(b: Buffer): string {
  return b.toString("hex");
}

export interface ArtifactDownload {
  filePath: string;
  stream: NodeJS.ReadableStream;
  filename: string;
  sha256: string;
  size: number;
}

/** Prepare a run artifact for download: locate the staged file, re-hash it,
 * and verify it against the run's recorded digest (integrity check). Throws
 * with a clear message when the artifact is missing/stale or the hash does not
 * match the file we are about to serve — a mismatched file is served as an
 * error, never streamed silently. */
export async function prepareArtifactDownload(
  cfg: ServerConfig,
  run: TrainRun
): Promise<ArtifactDownload> {
  const artifact = run.result?.artifact;
  if (!artifact) throw new Error("no artifact for this run");
  const filePath = stagingPath(cfg, artifact);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error("artifact not staged for download");
  }
  const info = await hashFile(filePath);
  const actual = sha256Hex(info.sha256);
  if (artifact.sha256 && actual !== artifact.sha256) {
    throw new Error("artifact integrity check failed (hash mismatch)");
  }
  return {
    filePath,
    stream: createReadStream(filePath),
    filename: artifact.filename,
    sha256: actual,
    size: info.size,
  };
}

/** Guard: only resolve a run's artifact if it is staged for a `done` run. */
export function assertArtifactStaged(run: TrainRun): TrainArtifact {
  if (run.status !== "done" || !run.result?.artifact) {
    throw new Error("artifact not ready for this run");
  }
  return run.result.artifact;
}
