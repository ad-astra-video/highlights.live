// Fine-tune "train" trigger (ADAAAA-5262).
//
// The dashboard exposes a user-facing way to start a Florence-2 <OD> LoRA
// fine-tune on the highlights-train single-shot runner (docker/runners.json
// label `highlights-train`; services/train/fine_tune_od.py). This module owns
// the durable TrainRun lifecycle (`queued -> running -> done | failed`) and
// submits each run as one fixed-price single-shot job through the same
// orchestrator path the decide runner uses.
//
// A run is persisted immediately as `queued` (survives a restart via the
// `train_runs` table), then marked `running` before the submission and
// `done`/`failed` when the runner returns. The surfaced result carries the
// trained checkpoint path + eval delta report so the UI can show completion.
import { randomUUID } from "node:crypto";
import type { Db, TrainRun } from "./db";
import type { PipelineClient, TrainRunRequest, TrainResult } from "./analyzer";

export interface SubmitTrainInput {
  /** Training samples. Accepts an array of DetectionTrainingSample objects
   * (serialized to JSONL) or a pre-serialized newline-delimited JSON string. */
  manifest: unknown[] | string;
  /** Optional held-out val samples (same shape). */
  val?: unknown[] | string;
  epochs?: number;
  batchSize?: number;
  lr?: number;
  baseModel?: string;
}

export interface TrainService {
  submit(ownerId: string | null, input: SubmitTrainInput): Promise<TrainRun>;
  get(id: string): Promise<TrainRun | undefined>;
  list(ownerId?: string | null): Promise<TrainRun[]>;
}

/** Serialize samples (array of objects) to a JSONL string. */
export function toJsonl(v: unknown[] | string): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) throw new TrainValidationError("manifest must be an array of samples");
  const lines = v.map((s) => {
    if (typeof s !== "object" || s === null || Array.isArray(s))
      throw new TrainValidationError("each training sample must be a JSON object");
    return JSON.stringify(s);
  });
  if (lines.length === 0) throw new TrainValidationError("manifest must contain at least one sample");
  return lines.join("\n");
}

export class TrainValidationError extends Error {}

export function createTrainService(db: Db, adapter: PipelineClient): TrainService {
  async function submit(ownerId: string | null, input: SubmitTrainInput): Promise<TrainRun> {
    let manifest: string;
    let val: string | undefined;
    try {
      manifest = toJsonl(input.manifest);
      if (input.val !== undefined) val = toJsonl(input.val);
    } catch (e) {
      if (e instanceof TrainValidationError) throw e;
      throw e;
    }

    const now = new Date().toISOString();
    const run: TrainRun = {
      id: randomUUID(),
      ownerId,
      status: "queued",
      manifest,
      val,
      epochs: input.epochs,
      batchSize: input.batchSize,
      lr: input.lr,
      baseModel: input.baseModel,
      createdAt: now,
      updatedAt: now,
    };
    await db.saveTrainRun(run);

    // Mark running, then submit the single-shot job. The adapter blocks until
    // the runner returns the checkpoint + eval report. On failure we record the
    // error and surface status `failed` (never a silent hang inside the route).
    const started = { ...run, status: "running" as const, updatedAt: new Date().toISOString() };
    await db.saveTrainRun(started);

    const request: TrainRunRequest = {
      manifest,
      val,
      epochs: input.epochs,
      batchSize: input.batchSize,
      lr: input.lr,
      baseModel: input.baseModel,
    };
    try {
      const result: TrainResult = await adapter.train(request);
      const done: TrainRun = { ...started, status: "done", result, updatedAt: new Date().toISOString() };
      await db.saveTrainRun(done);
      return done;
    } catch (err) {
      const failed: TrainRun = {
        ...started,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        updatedAt: new Date().toISOString(),
      };
      await db.saveTrainRun(failed);
      return failed;
    }
  }

  return {
    submit,
    get: (id) => db.getTrainRun(id),
    list: (ownerId) => (ownerId ? db.listTrainRuns(ownerId) : db.listTrainRuns()),
  };
}
