// Stage-A (audio noise-change gate) metrics (INC-2 / ADAAAA-4325 slice 5).
//
// ADAAAA-4885: this module carries TWO measures with different jobs, and they
// must not be read as each other:
//
// 1. `fpRate` / `gemmaFpRate` = `rejected / totalCandidates` — the GEMMA
//    REJECT rate on fires the decide pass judged. It is a COST signal (how
//    many billed gemma calls produced no highlight). It is NOT a trigger
//    false-positive rate: on the audio-gate path the dominant "reject" is the
//    anchor-timing artifact root-caused in ADAAAA-4883 — the gate fires on the
//    crowd-roar ONSET, the anchored window's frame predates the celebration
//    and gemma correctly reads "not yet scored", while a later window accepts
//    the same event at the celebration frame. Those fields keep their value
//    and meaning; the wording in the contract now says "reject rate".
// 2. `realEventFireRate` = `realEventFires / (realEventFires +
//    spuriousNoiseFires)` — the TRIGGER-QUALITY measure. It scores the job the
//    gate actually has: firing at real events and not at spurious noise. A
//    fire is a REAL-EVENT fire when a decide window that ACCEPTED a highlight
//    covers its onset, within {@link STAGE_A_CORROBORATION_SLACK_S}; it is a
//    SPURIOUS-NOISE fire when no accepting window ever does (scored once the
//    stream has moved past {@link STAGE_A_CORROBORATION_HORIZON_S}). A fire
//    the pipeline never judged is neither — it is not counted at all, so a
//    job with nothing judged still reads `n/a` (never a fabricated 0).
//
// Latency is measured independently: `onsetLatencyS` is set by the gate as
// (firedAt - onset) and is bounded <= 5s by the gate contract; here we aggregate
// the observed values (mean/max) so the live 1-5s budget is verifiable in the
// same metric snapshot.
//
// The module is a pure accumulator (no IO) so it is unit-testable in isolation.
import type { StageAMetricsSnapshot } from "@highlights/events";
import { AUDIO_TRIGGER_COALESCE_S } from "./audio-trigger";

const FP_RATE_BUDGET = 0.6; // acceptance bound: <= 60% gemma rejects (cost gate)

/** ADAAAA-4885: how far outside an ACCEPTING decide window's evidence span a
 *  fire's onset may sit and still count as corroborated by it. The gate fires
 *  on the crowd-roar onset (p50 ~1 s after the level change) while the window
 *  that cuts the highlight judges the celebration a few seconds later, so the
 *  accepting window's own evidence span plus this slack covers the fire the
 *  anchored window rejected (the ADAAAA-4883 artifact). */
export const STAGE_A_CORROBORATION_SLACK_S = 5;
/** ADAAAA-4885: a judged fire is scored spurious-noise once the stream has
 *  moved past every window that could still corroborate it. The widest rail
 *  window is the live 10 s trailing span, and an accepting window may trail the
 *  fire by up to the slack, so 15 s after the onset no future window can cover
 *  it. Before this point the fire stays unclassified (neither real nor noise). */
export const STAGE_A_CORROBORATION_HORIZON_S = 15;

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
  // ADAAAA-4885 trigger-quality classification. Counted from the outcome
  // ledger, never from `accepted`/`rejected` (those are gemma verdicts).
  private realEvent = 0;
  private spuriousNoise = 0;

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

  /** ADAAAA-4885: fires corroborated by an accepting decide window. */
  get realEventFires(): number {
    return this.realEvent;
  }
  /** ADAAAA-4885: judged fires no accepting window ever corroborated. */
  get spuriousNoiseFires(): number {
    return this.spuriousNoise;
  }
  /** ADAAAA-4885: judged fires that have been classified (real or noise). */
  get classifiedFires(): number {
    return this.realEvent + this.spuriousNoise;
  }
  /** ADAAAA-4885 trigger-quality measure: real-event fires / classified fires.
   * 0 when nothing is classified yet (callers must not read that as a measured
   * 0 % rate — the snapshot omits the field until at least one fire lands). */
  realEventFireRate(): number {
    return this.classifiedFires === 0 ? 0 : this.realEvent / this.classifiedFires;
  }
  /** ADAAAA-4885: a fire an accepting decide window corroborated. */
  markRealEventFire(): void {
    this.realEvent += 1;
  }
  /** ADAAAA-4885: a fire no accepting decide window ever corroborated. */
  markSpuriousNoiseFire(): void {
    this.spuriousNoise += 1;
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
      // ADAAAA-4885: additive trigger-quality measure. Present only once at
      // least one judged fire is classified, so a job that judged nothing (or
      // is still inside the corroboration horizon) never reads a fabricated 0.
      ...(this.classifiedFires > 0
        ? {
            realEventFires: this.realEvent,
            spuriousNoiseFires: this.spuriousNoise,
            realEventFireRate: Number(this.realEventFireRate().toFixed(4)),
          }
        : {}),
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
 * - **Trigger quality is classified, not inferred from the verdict (ADAAAA-4885).**
 *   An accepted fire is a real-event fire. A rejected fire is NOT noise yet: it
 *   waits for a later accepting window whose evidence span (± 5 s) covers its
 *   onset — the anchor-timing artifact of ADAAAA-4883 — and is scored
 *   spurious-noise only once the corroboration horizon (15 s) passes, or at
 *   {@link finalize} when the stream ends. So `rejected` can be large while
 *   `realEventFireRate` stays high; the two measure different things.
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
  /**
   * ADAAAA-4885: onsets of JUDGED fires waiting for trigger-quality
   * classification. A fire whose covering window rejected is not a spurious
   * fire yet — the celebration frame may still be judged by a later accepting
   * window (the ADAAAA-4883 anchor artifact), so it waits until an accepting
   * window corroborates it or the corroboration horizon passes. Bounded by the
   * horizon sweep below; a stalled stream is closed by {@link finalize}.
   */
  private unclassifiedOnsets: number[] = [];

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
    this.judgeOne(t, accepted);
    return true;
  }

  /** ADAAAA-4885: record the legacy accepted/rejected outcome for a judged fire
   * and classify it. An accepted fire is corroborated by the window that
   * accepted it; a rejected one waits for a later accepting window (the
   * anchor-timing artifact) or the corroboration horizon. */
  private judgeOne(t: PendingStageATrigger, accepted: boolean): void {
    this.metrics.recordOutcome(accepted, t.onsetLatencyS);
    if (accepted) this.metrics.markRealEventFire();
    else this.unclassifiedOnsets.push(t.onsetTs);
  }

  /**
   * ADAAAA-4885: an accepting window corroborates every unclassified fire whose
   * onset its evidence span covers (± {@link STAGE_A_CORROBORATION_SLACK_S}).
   * This is what separates the anchor-timing artifact (gate fired correctly on
   * the roar; a later window cuts the celebration) from spurious noise.
   */
  private corroborate(loTs: number, hiTs: number): void {
    if (this.unclassifiedOnsets.length === 0) return;
    const lo = loTs - STAGE_A_CORROBORATION_SLACK_S;
    const hi = hiTs + STAGE_A_CORROBORATION_SLACK_S;
    const keep: number[] = [];
    for (const onset of this.unclassifiedOnsets) {
      if (onset >= lo && onset <= hi) this.metrics.markRealEventFire();
      else keep.push(onset);
    }
    this.unclassifiedOnsets = keep;
  }

  /** ADAAAA-4885: score an unclassified fire spurious-noise once no future
   * window can still corroborate it (stream has advanced past
   * {@link STAGE_A_CORROBORATION_HORIZON_S} seconds after its onset). */
  private sweepSpurious(seenThroughTs: number): void {
    if (this.unclassifiedOnsets.length === 0) return;
    const horizon = seenThroughTs - STAGE_A_CORROBORATION_HORIZON_S;
    const keep: number[] = [];
    for (const onset of this.unclassifiedOnsets) {
      if (onset <= horizon) this.metrics.markSpuriousNoiseFire();
      else keep.push(onset);
    }
    this.unclassifiedOnsets = keep;
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
        this.judgeOne(t, accepted);
        judged++;
      } else {
        remaining.push(t);
      }
    }
    this.pending = remaining;
    // ADAAAA-4885: classify AFTER judging, so a fire this window judged can be
    // corroborated by it; then close out fires the stream has moved past.
    if (accepted) this.corroborate(loTs, hiTs);
    this.sweepSpurious(hiTs);
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

  /**
   * ADAAAA-4885: close trigger-quality classification at end of stream. Every
   * judged fire still unclassified was never corroborated by an accepting
   * window — no future window can arrive — so it is scored spurious-noise.
   * Unjudged pending triggers are NOT counted (unjudged is not rejected, and a
   * job with nothing judged must still read `n/a`, never a fabricated 0).
   * Idempotent; call before persisting `stageA.snapshot()`.
   */
  finalize(): void {
    for (let i = 0; i < this.unclassifiedOnsets.length; i++) {
      this.metrics.markSpuriousNoiseFire();
    }
    this.unclassifiedOnsets = [];
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
  // ADAAAA-4885: print the trigger-quality measure beside the gemma reject rate
  // so a log reader cannot mistake `fpRate` for the gate's own false-positive
  // rate. Appended only when at least one fire is classified — a job inside the
  // corroboration horizon prints nothing fabricated.
  const classified = (s.realEventFires ?? 0) + (s.spuriousNoiseFires ?? 0);
  const quality =
    classified > 0
      ? `, realEventFireRate=${s.realEventFireRate ?? 0} (${s.realEventFires}/${classified} fires corroborated)`
      : "";
  return (
    `[${kind}:${jobId}] stageA fpRate=${s.fpRate} (${s.rejected}/${s.totalCandidates} rejected), ` +
    `latency mean/max=${s.meanOnsetLatencyS}/${s.maxOnsetLatencyS}s, withinBudget=${s.fpRateWithinBudget}${quality}${suffix}`
  );
}
