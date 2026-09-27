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
