// Audio-noise trigger windows (ADAAAA-7658, Option A approved on ADAAAA-7592).
//
// The Stage-A audio gate (`services/perceive/app/audio_gate.py`) fires a
// *candidate* when stream energy changes (burst / sustained swell). Until this
// module the live decide loop ignored those points: `LiveObserver` (and the
// legacy live baseline) stepped decide on a blind fixed cadence, and an audio
// candidate only rode along as provenance.
//
// This module turns a fired trigger into a scheduled analysis window:
//
//   audio candidate (kind, onset ts, firedAt, latency, peak/baseline, threshold)
//     -> TriggerWindowScheduler  (one analysis per trigger, coalesced, bounded)
//     -> LiveObserver anchored fire (window assembled at the trigger moment)
//
// Cost invariant (AC3): the scheduler is ADMISSIBLE-ONLY. It never asks for an
// analysis the blind cadence would not also have issued — an anchored fire
// consumes the same per-cadence budget the observer already has, and the next
// cadence tick is pushed out by the fire. So decide invocations per stream
// minute are unchanged or lower; 0 added steady-state GPU sessions.
//
// Latency (AC2): a trigger is analyzable as soon as the observation window is
// wide enough to cover the onset (`leadS`). Anchored fires bypass the remaining
// cadence wait when the budget token is available, which is what keeps
// level-change -> gemma request inside 1.5 s p95 in steady state.
import type { AudioSignal } from "@highlights/events";

/** A normalized audio trigger record — the shape documented in
 *  `docs/audio-trigger-contract.md` and carried by `AudioSignal` on a
 *  `CandidateEvent` (live + VOD read the same shape). */
export interface AudioTriggerRecord {
  kind: "burst" | "swell";
  /** Onset timestamp (seconds) of the energy change — the anchor. */
  onsetTs: number;
  /** Timestamp the gate actually fired (>= onsetTs). */
  firedAt: number;
  /** firedAt - onsetTs, inside the live 1-5 s budget. */
  onsetLatencyS: number;
  /** Peak RMS energy in the trigger window (0..1). */
  peakEnergy: number;
  /** Baseline RMS energy at fire time (0..1). */
  baselineEnergy: number;
  /** Identity of the threshold that fired, e.g. `stageA/burst/1.3x`. */
  thresholdId: string;
}

/** Default lead: frames covering the onset must exist before the window is
 *  assembled, so an anchored fire waits ~1 s after onset (p50 onset->fire on
 *  real soccer audio is ~1 s, p95 <= 2.9 s, ADAAAA-4970). */
export const AUDIO_TRIGGER_LEAD_S = 1.0;
/** Two triggers whose onsets are closer than this are ONE audible event (the
 *  gate's own cooldown is 2 s) — one analysis, not a storm. */
export const AUDIO_TRIGGER_COALESCE_S = 2.5;
/** A trigger older than this (relative to the frame clock) can no longer be
 *  anchored to a retained frame — drop it instead of analyzing a stale window. */
export const AUDIO_TRIGGER_MAX_STALE_S = 8.0;

/**
 * Normalize an `AudioSignal` (perceive candidate evidence) into a trigger
 * record. Returns null for missing/invalid evidence so a malformed candidate
 * can never schedule an analysis (never throws).
 */
export function audioTriggerFromSignal(sig: AudioSignal | undefined | null): AudioTriggerRecord | null {
  if (!sig || typeof sig !== "object") return null;
  const onsetTs = Number(sig.ts);
  const firedAt = Number(sig.firedAt);
  const latency = Number(sig.onsetLatencyS);
  if (!Number.isFinite(onsetTs) || !Number.isFinite(firedAt) || !Number.isFinite(latency)) return null;
  if (latency < 0 || latency > 5) return null;
  const thresholdId =
    typeof (sig as AudioSignal & { thresholdId?: string }).thresholdId === "string" &&
    (sig as AudioSignal & { thresholdId?: string }).thresholdId
      ? String((sig as AudioSignal & { thresholdId?: string }).thresholdId)
      : `stageA/${sig.kind}`;
  return {
    kind: sig.kind,
    onsetTs,
    firedAt,
    onsetLatencyS: latency,
    peakEnergy: clamp01(Number(sig.peakEnergy)),
    baselineEnergy: clamp01(Number(sig.baselineEnergy)),
    thresholdId,
  };
}

/** Convenience: pull a trigger off a perceive candidate (`candidate.audio`). */
export function audioTriggerFromCandidate(cand: { audio?: AudioSignal } | undefined | null): AudioTriggerRecord | null {
  return audioTriggerFromSignal(cand?.audio);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export interface TriggerSchedulerStats {
  /** Triggers accepted and queued (after coalescing). */
  accepted: number;
  /** Triggers folded into a neighbouring trigger (one audible event). */
  coalesced: number;
  /** Structurally invalid records (dropped, never scheduled). */
  invalid: number;
  /** Pending triggers already covered by a fired window. */
  covered: number;
  /** Pending triggers too old to anchor to a retained frame. */
  expired: number;
  /** Triggers handed to the observer for an anchored fire. */
  fired: number;
}

/**
 * Dedup/coalesce/expiry for fired audio triggers. Pure bookkeeping — it does
 * not itself call decide; the LiveObserver asks {@link due} each frame.
 */
export class TriggerWindowScheduler {
  private readonly leadS: number;
  private readonly coalesceS: number;
  private readonly maxStaleS: number;
  private pending: AudioTriggerRecord[] = [];
  private lastAcceptedOnset: number | null = null;
  private readonly counters: TriggerSchedulerStats = {
    accepted: 0,
    coalesced: 0,
    invalid: 0,
    covered: 0,
    expired: 0,
    fired: 0,
  };

  constructor(opts: { leadS?: number; coalesceS?: number; maxStaleS?: number } = {}) {
    this.leadS = opts.leadS ?? AUDIO_TRIGGER_LEAD_S;
    this.coalesceS = opts.coalesceS ?? AUDIO_TRIGGER_COALESCE_S;
    this.maxStaleS = opts.maxStaleS ?? AUDIO_TRIGGER_MAX_STALE_S;
  }

  /**
   * Queue a trigger for one anchored analysis. Returns true when it was
   * queued, false when it was invalid or coalesced into a neighbour (the
   * "one scheduled analysis, never a per-frame storm" rule).
   */
  record(t: AudioTriggerRecord | null | undefined): boolean {
    if (!t) {
      this.counters.invalid++;
      return false;
    }
    if (!Number.isFinite(t.onsetTs) || !Number.isFinite(t.firedAt) || t.onsetLatencyS < 0 || t.onsetLatencyS > 5) {
      this.counters.invalid++;
      return false;
    }
    if (this.lastAcceptedOnset !== null && Math.abs(t.onsetTs - this.lastAcceptedOnset) < this.coalesceS) {
      // Same audible event (or a re-fire inside the gate's cooldown).
      this.counters.coalesced++;
      return false;
    }
    this.lastAcceptedOnset = t.onsetTs;
    this.pending.push(t);
    // Bounded: the pending list can never outgrow the max-stale horizon at the
    // gate's own fire rate.
    if (this.pending.length > 64) this.pending.splice(0, this.pending.length - 64);
    this.counters.accepted++;
    return true;
  }

  /**
   * The earliest trigger whose analysis window is due at `currentTs` (onset +
   * lead has elapsed), or null. Expired triggers are dropped on the way.
   */
  due(currentTs: number): AudioTriggerRecord | null {
    if (!Number.isFinite(currentTs)) return null;
    this.expire(currentTs);
    while (this.pending.length > 0) {
      const head = this.pending[0];
      if (head.onsetTs + this.leadS <= currentTs) {
        this.pending.shift();
        this.counters.fired++;
        return head;
      }
      break;
    }
    return null;
  }

  /** Drop pending triggers whose onset falls inside a window that has already
   *  been analyzed — a cadence fire covers them, so they must not fire again. */
  coverThrough(fromTs: number, toTs: number): number {
    if (!Number.isFinite(fromTs) || !Number.isFinite(toTs)) return 0;
    const before = this.pending.length;
    this.pending = this.pending.filter((t) => !(t.onsetTs >= fromTs && t.onsetTs <= toTs));
    const dropped = before - this.pending.length;
    this.counters.covered += dropped;
    return dropped;
  }

  private expire(currentTs: number): void {
    const cutoff = currentTs - this.maxStaleS;
    const before = this.pending.length;
    this.pending = this.pending.filter((t) => t.onsetTs >= cutoff);
    this.counters.expired += before - this.pending.length;
  }

  /** Pending triggers awaiting an anchored fire. */
  pendingCount(): number {
    return this.pending.length;
  }

  stats(): TriggerSchedulerStats {
    return { ...this.counters };
  }
}
