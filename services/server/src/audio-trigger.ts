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
 *  gate's own cooldown is 2 s) — one analysis, not a storm. Coalescing is
 *  scoped to one trigger FAMILY (see {@link triggerFamily}): a whistle and the
 *  crowd roar of the same celebration describe different evidence and must not
 *  collapse into one analysis (the ADAAAA-6312 defect class). */
export const AUDIO_TRIGGER_COALESCE_S = 2.5;

/** Path family of a trigger, from its `thresholdId` prefix.
 *
 *  `stageA/*` is the broadband level-change gate (roar / swell);
 *  `stageB/*` is the band-limited tonal path (whistle). Two fires from
 *  different families within the coalesce window are separate evidence — a
 *  whistle marks the stoppage even when the roar lands 2 s later — so they get
 *  one analysis each. Unknown/legacy ids fall back to their whole string. */
export function triggerFamily(thresholdId: string): string {
  const i = thresholdId.indexOf("/");
  return i > 0 ? thresholdId.slice(0, i) : thresholdId;
}

/** Threshold identity of the Stage-B whistle operating point. Frozen by the
 *  ADAAAA-7705 decision — this module names it so the server can never build a
 *  whistle trigger under a different id (and so a re-tune is a visible diff). */
export const WHISTLE_THRESHOLD_ID = "stageB/whistle/2.4-3.4k/5x/0.3s";
/** Family prefix of the Stage-B (band-limited whistle) path. */
export const STAGE_B_FAMILY = "stageB";

/** Whether a trigger belongs to the Stage-B whistle family. The family — not
 *  the `kind` (`"burst"` on both paths) — is the identity at the boundary, so a
 *  whistle can never be judged into the Stage-A ledger
 *  ({@link ../stage-a-metrics.StageAOutcomeLedger}) or coalesced against a roar
 *  (ADAAAA-7707 AC3). Unknown ids are Stage-A/legacy. */
export function isStageBTrigger(thresholdId: string | undefined | null): boolean {
  return typeof thresholdId === "string" && triggerFamily(thresholdId) === STAGE_B_FAMILY;
}

/** The additive `whistle` block perceive puts on the `/audio` response
 *  (`services/perceive/app/__init__.py`), carrying the Stage-B fire plus the
 *  emit-switch state. Always present when the whistle gate fires, whether or
 *  not it emitted — so a consumer must gate on `emitted`. */
export interface WhistleFireBlock {
  kind?: string;
  ts: number;
  firedAt: number;
  onsetLatencyS: number;
  peakEnergy: number;
  baselineEnergy: number;
  thresholdId: string;
  /** Perceive-side emit switch state. `false` = measure-only reporting. */
  emitted?: boolean;
  measureOnly?: boolean;
  sessionCandidates?: number;
}

/**
 * Build the Stage-B trigger record from the perceive `whistle` block
 * (ADAAAA-7707 AC1). Returns null — never a partial record — when the block is
 * absent, malformed, or MEASURE-ONLY: a measure-only fire is reporting, not a
 * scheduling candidate, so the rollback (`WhistleConfig.emitted = False`,
 * config only) leaves this wiring inert instead of needing a code revert.
 *
 * The threshold id is the frozen Stage-B identity: a block that reports a
 * `stageA/*` id is not a whistle fire and is rejected rather than silently
 * recorded as one.
 */
export function audioTriggerFromWhistle(block: WhistleFireBlock | undefined | null): AudioTriggerRecord | null {
  if (!block || typeof block !== "object") return null;
  if (block.emitted !== true || block.measureOnly === true) return null;
  if (!isStageBTrigger(block.thresholdId)) return null;
  const onsetTs = Number(block.ts);
  const firedAt = Number(block.firedAt);
  const latency = Number(block.onsetLatencyS);
  if (!Number.isFinite(onsetTs) || !Number.isFinite(firedAt) || !Number.isFinite(latency)) return null;
  if (latency < 0 || latency > 5) return null;
  return {
    kind: block.kind === "swell" ? "swell" : "burst",
    onsetTs,
    firedAt,
    onsetLatencyS: latency,
    peakEnergy: clamp01(Number(block.peakEnergy)),
    baselineEnergy: clamp01(Number(block.baselineEnergy)),
    thresholdId: block.thresholdId,
  };
}
/** A trigger older than this (relative to the frame clock) can no longer be
 *  anchored to a retained frame — drop it instead of analyzing a stale window. */
export const AUDIO_TRIGGER_MAX_STALE_S = 8.0;

/** Largest onset -> anchored-window latency an anchored fire may report
 *  (ADAAAA-7723). The contract's budget is 1-5 s (`docs/audio-trigger-contract.md`,
 *  measured p50 ~1 s / p95 2.9 s on real soccer audio, ADAAAA-4970), so a
 *  trigger that has been pending longer than this is never fired late: it is
 *  either COVERED by the window that judged its onset or EXPIRED once its
 *  frames leave the retained window. Firing a 7 s-late window would satisfy
 *  "one window per trigger" on paper while breaking the latency budget the
 *  same contract names. */
export const AUDIO_TRIGGER_MAX_ANCHOR_LATENCY_S = 5.0;

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
  /** Triggers accepted and queued (after coalescing). This is the ledger's
   *  total: `accepted === coalesced + covered + expired + fired + pending` is
   *  the ADAAAA-7723 reconciliation invariant. */
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
  /** Accepted triggers still awaiting an anchored window. */
  pending?: number;
}

/**
 * Dedup/coalesce/expiry for fired audio triggers. Pure bookkeeping — it does
 * not itself call decide; the LiveObserver asks {@link due} each frame.
 */
export class TriggerWindowScheduler {
  private readonly leadS: number;
  private readonly coalesceS: number;
  private readonly maxStaleS: number;
  private readonly maxAnchorLatencyS: number;
  private pending: AudioTriggerRecord[] = [];
  private lastAcceptedOnset: number | null = null;
  /** Last accepted onset PER trigger family: a whistle and a roar in the same
   *  celebration are distinct evidence (ADAAAA-7682 AC4). */
  private readonly lastAcceptedOnsetByFamily = new Map<string, number>();
  private readonly counters: TriggerSchedulerStats = {
    accepted: 0,
    coalesced: 0,
    invalid: 0,
    covered: 0,
    expired: 0,
    fired: 0,
  };

  constructor(opts: { leadS?: number; coalesceS?: number; maxStaleS?: number; maxAnchorLatencyS?: number } = {}) {
    this.leadS = opts.leadS ?? AUDIO_TRIGGER_LEAD_S;
    this.coalesceS = opts.coalesceS ?? AUDIO_TRIGGER_COALESCE_S;
    this.maxStaleS = opts.maxStaleS ?? AUDIO_TRIGGER_MAX_STALE_S;
    this.maxAnchorLatencyS = opts.maxAnchorLatencyS ?? AUDIO_TRIGGER_MAX_ANCHOR_LATENCY_S;
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
    const family = triggerFamily(t.thresholdId);
    const lastForFamily = this.lastAcceptedOnsetByFamily.get(family);
    if (lastForFamily !== undefined && lastForFamily !== null
        && Math.abs(t.onsetTs - lastForFamily) < this.coalesceS) {
      // Same audible event (or a re-fire inside the gate's cooldown) — but
      // only inside ONE family. A whistle and a roar of the same celebration
      // are separate evidence and each keeps its own anchored analysis.
      this.counters.coalesced++;
      return false;
    }
    this.lastAcceptedOnsetByFamily.set(family, t.onsetTs);
    this.lastAcceptedOnset = t.onsetTs;
    this.pending.push(t);
    // Bounded: the pending list can never outgrow the max-stale horizon at the
    // gate's own fire rate.
    if (this.pending.length > 64) this.pending.splice(0, this.pending.length - 64);
    this.counters.accepted++;
    return true;
  }

  /**
   * The trigger whose analysis window is due at `currentTs` (onset + lead has
   * elapsed) and whose onset->window latency is still inside the 1-5 s budget,
   * WITHOUT consuming it, or null. Expired triggers are dropped on the way.
   *
   * ADAAAA-7699: the observer asks this BEFORE it knows whether it can afford
   * the fire (the decide budget gate). A tick that peeks a due trigger and then
   * refuses to fire must not swallow it — the previous `due()`-first ordering
   * popped the trigger (`fired++`) and returned, silently losing the anchored
   * analysis of a real audible event.
   *
   * ADAAAA-7723: the scan is over EVERY pending trigger, not just the oldest
   * queued one. The audio tap runs ahead of the (lagging) video frame clock, so
   * a trigger whose onset is still in the future used to sit at the head of the
   * FIFO and block every due trigger behind it for as long as the frame clock
   * took to catch up — those blocked triggers then expired with no anchored
   * window and no decide (measured 1 of 4 accepted triggers anchored). Returning
   * the EARLIEST due onset keeps the oldest evidence from expiring first.
   */
  peekDue(currentTs: number): AudioTriggerRecord | null {
    if (!Number.isFinite(currentTs)) return null;
    this.expire(currentTs);
    let best: AudioTriggerRecord | null = null;
    for (const t of this.pending) {
      const age = currentTs - t.onsetTs;
      // The window must already cover the onset (lead), and must still be able
      // to claim the 1-5 s contract latency.
      if (age < this.leadS - 1e-9) continue;
      if (age > this.maxAnchorLatencyS + 1e-9) continue;
      if (!best || t.onsetTs < best.onsetTs) best = t;
    }
    return best;
  }

  /** Consume one trigger: the one {@link peekDue} returned (the fire is
   *  happening), or the oldest queued record when called with no argument. */
  consume(trigger?: AudioTriggerRecord | null): AudioTriggerRecord | null {
    let head: AudioTriggerRecord | null = null;
    if (trigger) {
      const i = this.pending.indexOf(trigger);
      if (i >= 0) head = this.pending.splice(i, 1)[0] ?? null;
    } else {
      head = this.pending.shift() ?? null;
    }
    if (head) this.counters.fired++;
    return head;
  }

  /**
   * The earliest trigger whose analysis window is due at `currentTs` (onset +
   * lead has elapsed), or null. Expired triggers are dropped on the way.
   */
  due(currentTs: number): AudioTriggerRecord | null {
    const head = this.peekDue(currentTs);
    if (!head) return null;
    return this.consume(head);
  }

  /** End-of-share accounting (ADAAAA-7723): a trigger still pending when the
   *  share ends can never anchor a window (the tail fire observes the newest
   *  frame, and its frames leave the retained window with the rail). Drop them
   *  as EXPIRED so the ledger reconciles instead of leaving them silently
   *  pending. Returns how many were dropped. */
  expirePending(): number {
    const n = this.pending.length;
    this.pending = [];
    this.counters.expired += n;
    return n;
  }

  /** Drop pending triggers whose onset falls inside a window that has already
   *  been analyzed — a cadence fire covers them, so they must not fire again.
   *  `fromTs` may be `-Infinity` to drop every onset older than `toTs`
   *  (ADAAAA-7707: a dropped stale span only unanchors onsets past the retained
   *  window horizon, not the whole span it swept). */
  coverThrough(fromTs: number, toTs: number): number {
    if (Number.isNaN(fromTs) || !Number.isFinite(toTs)) return 0;
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
    return { ...this.counters, pending: this.pending.length };
  }

  /** ADAAAA-7723 reconciliation: every ACCEPTED trigger is accounted for as
   *  `fired` (anchored a decide window), `covered` (a decided window included
   *  its onset), `expired` (its frames left the retained window) or `pending`
   *  (still awaiting a tick). `invalid` records never entered the ledger and
   *  `coalesced` ones were folded into an accepted neighbour. A share where this
   *  does not balance dropped a trigger silently, which is the defect this
   *  ledger exists to make visible. */
  reconciled(): { ok: boolean; unaccounted: number } {
    const s = this.stats();
    const pending = s.pending ?? this.pending.length;
    const unaccounted = s.accepted - (s.fired + s.covered + s.expired + pending);
    return { ok: unaccounted === 0, unaccounted };
  }
}
