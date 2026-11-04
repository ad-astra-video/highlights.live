// ADAAAA-7928 (Inc 1 of ADAAAA-7925): per-stage timings for one completed VOD
// run. Pure — the caller passes the clock readings it took inside `runVodJob`;
// no clock and no I/O live here, so the contract invariants are unit-testable
// (the sibling `vod-meter.ts` precedent).
//
// The record block is ADDITIVE (`job.stageTimings`); `vodMeter` keeps its shape.
// The five top-level stages are a disjoint partition of the run:
//
//   preroll + extract + capacityWait + analyze + finalize === totalMs
//
// `prerollMs` is claim -> extract start, plus the small unattributed setup gaps
// between stages (frame count read, analyzer-config assembly, session setup).
// Folding them here keeps the partition exact instead of inventing a sixth
// stage; the residual is sub-100 ms in practice.
//
// The three nested measures are subsets, never addends:
//   clipEncodeMs  <= analyzeMs   (cumulative ffmpeg cut time, inside the loop)
//   audioGateMs   <= analyzeMs   (Stage-A loop wall clock, CONCURRENT)
//   sourceProbeMs <= finalizeMs  (probeDuration, inside finalize)
//
// `perceiveSessionMs` is session ACQUISITION -> release. ADAAAA-7928 fixes the
// F1 billing bug by starting this clock after `reservePerceiveWithBackoff`
// resolves, so a capacity-1 queue wait lands in `capacityWaitMs` only.
//
// Resumed jobs (ADAAAA-7906): the block describes the FINAL attempt. Prior
// attempts' wall clock is passed as `priorAttemptsMs` and folded into `prerollMs`
// so `totalMs` still equals the job's `vodMeter.wallClockS * 1000`.

import type { StageTimings } from "@highlights/events";

export interface VodStageTimingInput {
  /** Worker claim (start of the measured run). */
  runStartedMs: number;
  /** Immediately before frame extraction (`extractFrames` / reuse check). */
  extractStartMs: number;
  /** Immediately after frame extraction returns. */
  extractEndMs: number;
  /** Immediately before the `reservePerceiveWithBackoff` call. */
  reserveStartMs: number;
  /** Immediately after it resolves — the perceive session is acquired here. */
  reserveEndMs: number;
  /** Immediately before `analyzeJob` is invoked. */
  analyzeStartMs: number;
  /** After `analyzeJob` returned and the concurrent audio leg was drained. */
  analyzeEndMs: number;
  /** CUMULATIVE ffmpeg clip-cut time measured inside the analyze loop. */
  clipEncodeMs: number;
  /** Start of the Stage-A audio loop (concurrent with analyze). */
  audioGateStartMs: number;
  /** End of the Stage-A audio loop. */
  audioGateEndMs: number;
  /** `probeDuration` call wall clock. */
  sourceProbeMs: number;
  /** Session acquisition -> release (post-F1: excludes capacity wait). */
  perceiveSessionMs: number;
  /** When the record reached `done`. */
  finalizeEndMs: number;
  /** Wall clock of prior attempts on a resumed job (folded into preroll). */
  priorAttemptsMs?: number;
  /** Defaults to the build time; injected in tests for a stable fixture. */
  measuredAt?: string;
}

function span(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round(to - from));
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.round(value)));
}

/** Build the persisted `stageTimings` block from measured boundaries. */
export function buildStageTimings(input: VodStageTimingInput): StageTimings {
  const extractMs = span(input.extractStartMs, input.extractEndMs);
  const capacityWaitMs = span(input.reserveStartMs, input.reserveEndMs);
  const analyzeMs = span(input.analyzeStartMs, input.analyzeEndMs);
  const finalizeMs = span(input.analyzeEndMs, input.finalizeEndMs);
  // The run span as measured end-to-end, including any earlier attempts.
  const runMs = span(input.runStartedMs, input.finalizeEndMs) + Math.max(0, Math.round(input.priorAttemptsMs ?? 0));
  const measuredStages = extractMs + capacityWaitMs + analyzeMs + finalizeMs;
  const prerollMs = Math.max(0, runMs - measuredStages);
  // Invariant 1 holds by construction: the total IS the partition.
  const totalMs = prerollMs + measuredStages;

  // Nested subsets: measured against the analyze window, never additive.
  const clipEncodeMs = clamp(input.clipEncodeMs, analyzeMs);
  const audioGateStart = Math.max(input.audioGateStartMs, input.analyzeStartMs);
  const audioGateEnd = Math.min(input.audioGateEndMs, input.analyzeEndMs);
  const audioGateMs = clamp(span(audioGateStart, audioGateEnd), analyzeMs);
  const sourceProbeMs = clamp(input.sourceProbeMs, finalizeMs);
  // Acquisition -> release; a session can never outlive analyze + the wait that
  // delayed its acquisition (defensive clamp only — the measured value is used).
  const perceiveSessionMs = clamp(input.perceiveSessionMs, analyzeMs + capacityWaitMs);

  return {
    version: 1,
    prerollMs,
    extractMs,
    capacityWaitMs,
    analyzeMs,
    clipEncodeMs,
    audioGateMs,
    finalizeMs,
    sourceProbeMs,
    perceiveSessionMs,
    totalMs,
    measuredAt: input.measuredAt ?? new Date().toISOString(),
  };
}

/**
 * Invariant violations for a built block (empty = contract satisfied).
 *
 * Kept alongside the builder so the unit test and any future write-path guard
 * assert the same rules the aggregate route relies on:
 *  1. the five stages partition `totalMs` (±50 ms),
 *  2. the three subsets are contained,
 *  3. `totalMs` matches `vodMeter.wallClockS * 1000` (±100 ms) when a meter is
 *     supplied (legacy/null meters skip rule 3),
 *  4. `perceiveSessionMs <= analyzeMs + capacityWaitMs` and, post-F1, the queue
 *     wait is not inside the session clock.
 */
export function stageTimingsViolations(t: StageTimings, vodMeterWallClockS?: number | null): string[] {
  const out: string[] = [];
  const partition = t.prerollMs + t.extractMs + t.capacityWaitMs + t.analyzeMs + t.finalizeMs;
  if (Math.abs(partition - t.totalMs) > 50) {
    out.push(`partition ${partition} != totalMs ${t.totalMs} (±50ms)`);
  }
  if (t.clipEncodeMs > t.analyzeMs) out.push(`clipEncodeMs ${t.clipEncodeMs} > analyzeMs ${t.analyzeMs}`);
  if (t.audioGateMs > t.analyzeMs) out.push(`audioGateMs ${t.audioGateMs} > analyzeMs ${t.analyzeMs}`);
  if (t.sourceProbeMs > t.finalizeMs) out.push(`sourceProbeMs ${t.sourceProbeMs} > finalizeMs ${t.finalizeMs}`);
  if (typeof vodMeterWallClockS === "number" && Number.isFinite(vodMeterWallClockS)) {
    if (Math.abs(t.totalMs - vodMeterWallClockS * 1000) > 100) {
      out.push(`totalMs ${t.totalMs} != vodMeter.wallClockS*1000 ${Math.round(vodMeterWallClockS * 1000)} (±100ms)`);
    }
  }
  if (t.perceiveSessionMs > t.analyzeMs + t.capacityWaitMs) {
    out.push(`perceiveSessionMs ${t.perceiveSessionMs} > analyzeMs + capacityWaitMs ${t.analyzeMs + t.capacityWaitMs}`);
  }
  return out;
}
