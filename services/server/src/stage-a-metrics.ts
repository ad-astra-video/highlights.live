// Stage-A (audio noise-change gate) FP-rate + latency metric (INC-2 / ADAAAA-4325 slice 5).
//
// The acceptance cost bound is: "Noise-trigger false-positive rate (fraction of
// Stage-A candidates Gemma later rejects) <= 60%, reported as a tracked metric."
//
// For every Stage-A audio candidate routed through the decide() stage, we record
// whether Gemma accepted it (a highlight was cut) or rejected it. The false
// positive rate is `rejected / total` — the fraction of billed Gemma decide
// calls on the audio-gate path that produced no highlight. It is the cost
// metric that bounds how much GPU the gate wastes when its candidates are noise.
//
// Latency is measured independently: `onsetLatencyS` is set by the gate as
// (firedAt - onset) and is bounded <= 5s by the gate contract; here we aggregate
// the observed values (mean/max) so the live 1-5s budget is verifiable in the
// same metric snapshot.
//
// The module is a pure accumulator (no IO) so it is unit-testable in isolation.
import type { StageAMetricsSnapshot } from "@highlights/events";
import { AUDIO_TRIGGER_COALESCE_S } from "./audio-trigger";

const FP_RATE_BUDGET = 0.6; // acceptance bound: <= 60% false positives

export class StageAMetrics {
  private total = 0;
  private accepted = 0;
  private rejected = 0;
  private onsetLatencySum = 0;
  private latencyObserved = 0;
  private maxOnsetLatencyS = 0;
  // Raw onset->fire latency samples (s), kept for p50/p95 percentile reporting
  // (ADAAAA-4785 latency acceptance: event -> flagged within 1-5 s, p50/p95).
  private onsetLatencySamples: number[] = [];

  /** Record the outcome of one audio-gate candidate after Gemma decide() ran.
   * `accepted` is `decision.isHighlight` (a highlight was cut). `onsetLatencyS`
   * is the gate-reported onset->fire latency, when present. */
  recordOutcome(accepted: boolean, onsetLatencyS?: number): void {
    this.total += 1;
    if (accepted) this.accepted += 1;
    else this.rejected += 1;
    if (onsetLatencyS !== undefined && Number.isFinite(onsetLatencyS) && onsetLatencyS >= 0) {
      this.onsetLatencySum += onsetLatencyS;
      this.maxOnsetLatencyS = Math.max(this.maxOnsetLatencyS, onsetLatencyS);
      this.latencyObserved += 1;
      this.onsetLatencySamples.push(onsetLatencyS);
    }
  }

  /** p-th percentile (0..1) of the observed onset latency samples (nearest-rank).
   * 0 when no sample was observed. */
  percentileLatencyS(p: number): number {
    const n = this.onsetLatencySamples.length;
    if (n === 0) return 0;
    const sorted = [...this.onsetLatencySamples].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil(p * n));
    return sorted[Math.min(n - 1, rank - 1)];
  }

  get totalCandidates(): number {
    return this.total;
  }
  get acceptedCount(): number {
    return this.accepted;
  }
  get rejectedCount(): number {
    return this.rejected;
  }

  /** False-positive rate = rejected / total. 0 when no candidates yet (so the
   * bound is vacuously met, not spuriously blown by a divide-by-zero). */
  fpRate(): number {
    return this.total === 0 ? 0 : this.rejected / this.total;
  }

  /** Mean onset->fire latency (s) over candidates that reported it. */
  meanOnsetLatencyS(): number {
    return this.latencyObserved === 0 ? 0 : this.onsetLatencySum / this.latencyObserved;
  }
  maxOnsetLatency(): number {
    return this.maxOnsetLatencyS;
  }

  /** Serializable snapshot for the job record (Job.stageAMetrics). */
  snapshot(): StageAMetricsSnapshot {
    return {
      totalCandidates: this.total,
      accepted: this.accepted,
      rejected: this.rejected,
      fpRate: Number(this.fpRate().toFixed(4)),
      gemmaFpRate: Number(this.fpRate().toFixed(4)),
      meanOnsetLatencyS: Number(this.meanOnsetLatencyS().toFixed(3)),
      maxOnsetLatencyS: Number(this.maxOnsetLatencyS.toFixed(3)),
      p50LatencyS: Number(this.percentileLatencyS(0.5).toFixed(3)),
      p95LatencyS: Number(this.percentileLatencyS(0.95).toFixed(3)),
      fpRateWithinBudget: this.fpRate() <= FP_RATE_BUDGET,
    };
  }
}

/** One Stage-A trigger waiting for the decide window that judges its onset. */
interface PendingStageATrigger {
  onsetTs: number;
  onsetLatencyS?: number;
}

/**
 * Maps Stage-A audio triggers onto the verdict of the decide window that judges
 * them (ADAAAA-7694).
 *
 * Under the observe architecture an audio candidate no longer gets its own
 * `decide()`: the trigger is provenance and (on the live rail) a window anchor,
 * so the only honest outcome to record for it is the verdict of the decide
 * window whose evidence span CONTAINS its onset — `accepted` means that window
 * cut a highlight, `rejected` means it judged the moment and produced none.
 * This class keeps the trigger timeline and writes exactly one
 * {@link StageAMetrics.recordOutcome} row per judged trigger, carrying the
 * gate-reported `onsetLatencyS` so the p50/p95 latency budget is measured on
 * real samples instead of the all-zero snapshot.
 *
 * Rules (documented in `docs/audio-trigger-contract.md`):
 *
 * - **Coalesced re-fires are one audible event.** Two onsets closer than
 *   `AUDIO_TRIGGER_COALESCE_S` (2.5 s — the gate's own 2 s cooldown plus slack)
 *   describe ONE event, so only the first is counted. This keeps the rate a
 *   per-event rate instead of a per-chunk rate.
 * - **First covering window judges.** A trigger is judged once, by the first
 *   decide window whose span contains its onset; it is then removed so a later
 *   overlapping window cannot re-count it.
 * - **Unjudged is not rejected.** A trigger inside a window that was never
 *   decided (stale-frame drop, Tier-2 gate skip, past the stream tail) is
 *   dropped or left pending — never recorded as a fabricated reject, so the FP
 *   rate can only be inflated by real decisions.
 *
 * Pure (no IO) and bounded (never grows on a long stream), so it is
 * unit-testable in isolation.
 */
export class StageAOutcomeLedger {
  private readonly metrics: StageAMetrics;
  private readonly coalesceS: number;
  private readonly maxPending: number;
  private pending: PendingStageATrigger[] = [];
  private lastOnsetTs: number | null = null;

  constructor(metrics: StageAMetrics, opts: { coalesceS?: number; maxPending?: number } = {}) {
    this.metrics = metrics;
    this.coalesceS = opts.coalesceS ?? AUDIO_TRIGGER_COALESCE_S;
    this.maxPending = opts.maxPending ?? 64;
  }

  /**
   * Track a fired Stage-A trigger until a decide window judges it. Returns
   * false (and records nothing) for a missing/invalid onset or a coalesced
   * re-fire of the same audible event.
   */
  recordTrigger(trigger: { onsetTs: number; onsetLatencyS?: number } | null | undefined): boolean {
    if (!trigger || !Number.isFinite(trigger.onsetTs)) return false;
    if (this.lastOnsetTs !== null && Math.abs(trigger.onsetTs - this.lastOnsetTs) < this.coalesceS) {
      return false;
    }
    this.lastOnsetTs = trigger.onsetTs;
    this.pending.push({ onsetTs: trigger.onsetTs, onsetLatencyS: trigger.onsetLatencyS });
    if (this.pending.length > this.maxPending) {
      this.pending.splice(0, this.pending.length - this.maxPending);
    }
    return true;
  }

  /** Record the outcome of ONE specific trigger (the anchored one), when it is
   * still pending. Returns whether a row was written. */
  judgeTrigger(trigger: { onsetTs: number } | null | undefined, accepted: boolean): boolean {
    if (!trigger) return false;
    const i = this.pending.findIndex((t) => t.onsetTs === trigger.onsetTs);
    if (i < 0) return false;
    const [t] = this.pending.splice(i, 1);
    this.metrics.recordOutcome(accepted, t.onsetLatencyS);
    return true;
  }

  /**
   * Record the verdict of a decide window over `[loTs, hiTs]`: every pending
   * trigger whose onset falls inside the window is judged by it (and removed,
   * so overlapping windows never re-count one trigger). Returns the number of
   * rows written.
   */
  judgeWindow(loTs: number, hiTs: number, accepted: boolean): number {
    if (!Number.isFinite(loTs) || !Number.isFinite(hiTs) || hiTs < loTs) return 0;
    let judged = 0;
    const remaining: PendingStageATrigger[] = [];
    for (const t of this.pending) {
      if (t.onsetTs >= loTs && t.onsetTs <= hiTs) {
        this.metrics.recordOutcome(accepted, t.onsetLatencyS);
        judged++;
      } else {
        remaining.push(t);
      }
    }
    this.pending = remaining;
    return judged;
  }

  /**
   * Forget triggers whose onset fell inside a span that was DROPPED without a
   * decide (stale-frame drop). They were never judged, so they must not be
   * recorded — this only keeps the pending list clean/bounded.
   */
  dropThrough(loTs: number, hiTs: number): number {
    if (!Number.isFinite(loTs) || !Number.isFinite(hiTs)) return 0;
    const before = this.pending.length;
    this.pending = this.pending.filter((t) => !(t.onsetTs >= loTs && t.onsetTs <= hiTs));
    return before - this.pending.length;
  }

  /** Triggers still waiting for a decide window (never counted as rejects). */
  pendingCount(): number {
    return this.pending.length;
  }
}

/**
 * The per-job Stage-B (whistle) crowding line
 * (`[live:<job>] stageB whistle fires=N decides=M share=P% ...`), or null when
 * the live observer decided nothing — a run with no decide call has no window
 * to measure a share on, so it must not print a fabricated 0%.
 *
 * The ADAAAA-7713 envelope makes the whistle SHARE of a window's decides the
 * hard tripwire (> 25%) and the added volume the alert threshold, so this line
 * prints both numbers on every live completion: the guardrail is checkable from
 * `docker logs highlights-server` alone, without a post-hoc audit.
 */
export const WHISTLE_SHARE_TRIPWIRE = 0.25;

export function whistleEvidenceLine(
  kind: "live" | "vod",
  jobId: string,
  m:
    | { decideCalls?: number; whistleFires?: number; whistleDecides?: number; whistleShare?: number; allDecides?: number }
    | undefined
): string | null {
  if (!m) return null;
  const decideCalls = Number(m.decideCalls ?? 0);
  if (!(decideCalls > 0)) return null;
  const fires = Number(m.whistleFires ?? 0);
  const decides = Number(m.whistleDecides ?? 0);
  // ADAAAA-7722: the denominator the tripwire is computed on. `allDecides` is
  // persisted explicitly (equal to `decideCalls` by construction), so the line
  // prints both the numerator and the denominator the share was taken over.
  const allDecides = Number(m.allDecides ?? decideCalls);
  const share = m.whistleShare ?? decides / allDecides;
  return (
    `[${kind}:${jobId}] stageB whistle fires=${fires} decides=${decides} ` +
    `share=${(share * 100).toFixed(1)}% decideCalls=${decideCalls} allDecides=${allDecides} ` +
    `withinTripwire=${share <= WHISTLE_SHARE_TRIPWIRE}`
  );
}

/**
 * The per-job Stage-A evidence line (`[live:<job>] / [vod:<job>] stageA ...`),
 * or null when the gate judged nothing — a job that never had an audio
 * candidate must not print a fabricated 0% FP rate. `suffix` carries the VOD
 * cost tail so the format stays byte-identical to the pre-existing log lines.
 */
export function stageAEvidenceLine(
  kind: "live" | "vod",
  jobId: string,
  s: StageAMetricsSnapshot,
  suffix = ""
): string | null {
  if (!(s.totalCandidates > 0)) return null;
  return (
    `[${kind}:${jobId}] stageA fpRate=${s.fpRate} (${s.rejected}/${s.totalCandidates} rejected), ` +
    `latency mean/max=${s.meanOnsetLatencyS}/${s.maxOnsetLatencyS}s, withinBudget=${s.fpRateWithinBudget}${suffix}`
  );
}
