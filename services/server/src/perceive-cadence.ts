// ADAAAA-7152 Gap 1: adaptive perceive cadence for the VOD detail-first pass.
//
// The dominant E2E cost of a VOD job is the per-frame perceive pass
// (`client.analyze` -> perceive `process_frame` -> Florence detect), NOT the
// decide observer. Measured on the box: real_goal = 106.4 s and real_match =
// 39.3 s for a ~90 s / ~70 s clip. This sampler cuts that cost by sending a
// REDUCED number of frames to perceive in "cool" (no-signal) regions while
// keeping FULL-perceive treatment around any window the Tier-2 signal gate would
// escalate.
//
// RECALL-SAFETY (why the escalated goal window is never starved):
//  - The hot window is armed by the SAME Tier-2 gate predicate the decide
//    observer uses (`escalatesToTier2`), so the gate and the cadence cannot
//    disagree about what is a real goal: any frame that would fire a decide also
//    forces full-perceive on the surrounding window.
//  - Once armed, EVERY frame in [escalateTs, escalateTs + hotAfterS] is sent to
//    perceive at the content fps, so the goal-crossing / ball-carry instant the
//    decide observer confirms is never under-sampled.
//  - Skipped (cool-region) frames are recorded into the decide window with NO
//    fabricated signal (signal undefined). The gate treats an absent signal as
//    recall-safe (it escalates rather than starving), so dropping a cool frame's
//    signal can never suppress a genuine goal.
//  - A genuine goal's calibration-free ball-velocity signal is sustained across
//    the goal window (that is what already drives the gate's escalation on the
//    box), so a cool-cadence frame still escalates and arms full-perceive
//    treatment for the goal moment.
//
// The cost/recall tradeoff is exposed as knobs (`quietStride`, `hotAfterS`) so an
// operator can push the cut toward the 30 s budget once goal recall is verified
// on the box — the same pattern as OBSERVE_SIGNAL_GATE_* / ADAAAA-7147.
//
// This module is pure + deterministic (no GPU, no network) so it is
// unit-testable in isolation.
import { escalatesToTier2, type PerFrameSignal, type SignalGateOptions } from "./observe-loop";

/** Cadence tuning ({@link PerceiveCadence}). All fields optional; sane defaults. */
export interface PerceiveCadenceOptions {
  /** In a cool (no-signal) region, only every `quietStride`-th frame is sent to
   * perceive. 1 = perceive every frame (cadence effectively disabled / full
   * pass). Default 2 (a safe 2x cut on cool regions that preserves detection of
   * the sustained goal signal; raise it once goal recall is verified). */
  quietStride?: number;
  /** Seconds of FULL-perceive treatment after a frame escalates the Tier-2 gate.
   * Covers the decide observer's reference window so the confirmed goal moment is
   * never under-sampled. Default 10 (`OBSERVE_WINDOW_S`). */
  hotAfterS?: number;
}

/** A frame's perceive tier: `hot` (inside the armed full-perceive window) or
 * `cool` (no-signal region, subject to the quiet stride). */
export type PerceiveTier = "hot" | "cool";

/**
 * Pure decide-recourse state machine: whether the current frame goes to full
 * perceive. RECALL-SAFE by construction — it arms a full-perceive hot window
 * around any frame whose Tier-2 signal escalates (the same predicate the decide
 * observer uses), so the escalated goal window is never starved.
 */
export class PerceiveCadence {
  private hotUntilTs: number | null = null;
  private coolCounter = 0;
  private readonly quietStride: number;
  private readonly hotAfterS: number;

  constructor(opts: PerceiveCadenceOptions = {}) {
    this.quietStride = Math.max(1, Math.floor(opts.quietStride ?? 2));
    this.hotAfterS = Math.max(0, opts.hotAfterS ?? 0);
  }

  /** Whether the frame at `ts` should be sent to full perceive. `true` inside
   * the armed hot window; else the cool cadence (every `quietStride`-th). */
  shouldPerceive(ts: number): boolean {
    if (this.hotUntilTs !== null && ts <= this.hotUntilTs) return true;
    const pick = this.coolCounter % this.quietStride === 0;
    this.coolCounter++;
    return pick;
  }

  /** The cadence tier of the frame at `ts` (for metrics; does not advance state). */
  tier(ts: number): PerceiveTier {
    if (this.hotUntilTs !== null && ts <= this.hotUntilTs) return "hot";
    return "cool";
  }

  /** Feed a frame's Tier-2 signal back in. If it escalates the gate, arm the
   * full-perceive hot window starting at `ts` for `hotAfterS` seconds. */
  noteFrameSignal(ts: number, signal: PerFrameSignal | undefined, opts: SignalGateOptions): void {
    if (!escalatesToTier2(signal, opts)) return;
    const until = ts + this.hotAfterS;
    this.hotUntilTs = this.hotUntilTs === null ? until : Math.max(this.hotUntilTs, until);
  }

  /** Current sampling state (metrics / diagnostics). */
  state(): { hotUntilTs: number | null; coolCounter: number } {
    return { hotUntilTs: this.hotUntilTs, coolCounter: this.coolCounter };
  }
}
