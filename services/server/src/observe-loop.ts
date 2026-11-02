// ADAAAA-7007: VOD decide-observer architecture.
//
// The vision LLM (decide / gemma) becomes the PRIMARY observer of the timeline.
// Instead of deciding only when perceive fires a `candidate`, the decide service
// is invoked on a fixed cadence (~3 s of content time) with a reference window
// of frames (~10 s) assembled around the current moment. Consecutive windows
// share content (overlap) because the window is longer than the cadence.
//
// perceive is no longer the on/off gate: it is (a) a DATA SEEDER, providing
// per-frame derived context (detections / tracking / scoreboard / motion /
// geometry) folded into every decide payload, and (b) an ON-DEMAND PROVIDER,
// recalled by decide when it needs more evidence for a moment.
//
// Everything here is pure + deterministic so it is unit-testable in isolation.
// The streaming driver wires it onto a frame iterator; the pure planners prove
// the acceptance criteria (<=30-frame cap, ~3 s cadence, ~10 s window, overlap).

import {
  TriggerWindowScheduler,
  isStageBTrigger,
  type AudioTriggerRecord,
  type TriggerSchedulerStats,
} from "./audio-trigger";
import type { StageAOutcomeLedger } from "./stage-a-metrics";

/** Decide invocation cadence in content seconds. CEO-locked (ADAAAA-7000). */
export const OBSERVE_CADENCE_S = 3;

/** Reference window length in content seconds. CEO-locked (ADAAAA-7000). */
export const OBSERVE_WINDOW_S = 10;

/** Hard per-invocation frame cap. Never send more than this in one decide call. */
export const OBSERVE_MAX_FRAMES = 30;

/** Resolve the window to this many frames per content-second when the source
 * stream is denser (10 s @ 2 fps = 20 frames; the natural under-cap case). */
export const OBSERVE_CONTENT_FPS = 2;

/**
 * Uniformly subsample an ordered array down to at most `max` items, keeping
 * the first and last element. Deterministic (index-based), so the same input
 * always yields the same selection. Returns whether the cap was actually hit.
 *
 * This is the subsample path the spec requires whenever a window has more than
 * OBSERVE_MAX_FRAMES frames. An input already within the cap is returned
 * unchanged (capped=false).
 */
export function subsampleToCap<T>(ordered: T[], max: number): { items: T[]; capped: boolean } {
  if (max <= 0) return { items: [], capped: ordered.length > 0 };
  if (ordered.length <= max) return { items: ordered, capped: false };
  const n = ordered.length;
  const step = (n - 1) / (max - 1);
  const out: T[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < max; i++) {
    const idx = Math.min(n - 1, Math.round(i * step));
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(ordered[idx]);
  }
  // Defensive: guarantee the hard cap is never breached even if rounding
  // collapsed indices (e.g. n just above max).
  while (out.length > max) out.pop();
  return { items: out, capped: true };
}

/** One assembled decide window: the ordered frame set + provenance. */
export interface ObserveWindow {
  /** The content moment the window is centered on (the decide "current moment"). */
  centerTs: number;
  /** Ordered (oldest -> newest) frames the decide call carries. */
  frames: { ts: number; imageB64: string }[];
  /** True when the max-frames cap forced a subsample. */
  capped: boolean;
  /** Frames present in the source window but dropped by the cap (for the
   * per-call size report). */
  droppedCount: number;
}

/**
 * Assemble ONE decide window around `centerTs`.
 *
 * - Keeps only frames within [centerTs - windowS/2, centerTs + windowS/2].
 * - Resolves to a regular `fps` grid across the window (nearest frame per step),
 *   so a denser source stream is thinned to the reference cadence.
 * - Hard-caps to <= `maxFrames` via {@link subsampleToCap}.
 *
 * `frames` may be unordered; output is always ordered oldest -> newest. Frames
 * with no image are ignored. An empty window yields `frames: []`.
 */
export function assembleObserveWindow(
  frames: { ts: number; imageB64: string }[],
  centerTs: number,
  opts: { windowS?: number; maxFrames?: number; fps?: number } = {}
): ObserveWindow {
  const windowS = opts.windowS ?? OBSERVE_WINDOW_S;
  const maxFrames = opts.maxFrames ?? OBSERVE_MAX_FRAMES;
  const fps = opts.fps ?? OBSERVE_CONTENT_FPS;
  const lo = centerTs - windowS / 2;
  const hi = centerTs + windowS / 2;
  const inWindow = frames
    .filter((f) => f.imageB64 && f.ts >= lo && f.ts <= hi)
    .sort((a, b) => a.ts - b.ts);
  if (inWindow.length === 0) return { centerTs, frames: [], capped: false, droppedCount: 0 };

  // Resolve to the fps grid across the window (nearest frame per step).
  const step = fps > 0 ? 1 / fps : Infinity;
  const start = inWindow[0].ts;
  const end = inWindow[inWindow.length - 1].ts;
  const grid: { ts: number; imageB64: string }[] = [];
  const seenTs = new Set<number>();
  const nearest = (t: number): { ts: number; imageB64: string } | undefined => {
    let best: { ts: number; imageB64: string } | undefined;
    let bestDiff = Infinity;
    for (const f of inWindow) {
      const d = Math.abs(f.ts - t);
      if (d < bestDiff) {
        bestDiff = d;
        best = f;
      }
    }
    return best;
  };
  for (let t = start; t <= end + 1e-9; t += step) {
    const n = nearest(t);
    if (n && !seenTs.has(n.ts)) {
      seenTs.add(n.ts);
      grid.push(n);
    }
  }
  // Guarantee the first and last in-window frame are present.
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  if (!seenTs.has(first.ts)) grid.unshift(first);
  if (!seenTs.has(last.ts)) grid.push(last);

  const { items, capped } = subsampleToCap(grid, maxFrames);
  const droppedCount = grid.length - items.length;
  return { centerTs, frames: items, capped, droppedCount };
}

/**
 * Plan the full sequence of decide invocations for a VOD timeline.
 *
 * Walks `startTs .. endTs` in `cadenceS` steps. At each tick the window is
 * centered on the tick's moment and assembled via {@link assembleObserveWindow}.
 * Because `windowS > cadenceS`, consecutive windows SHARE content (overlap is
 * inherent — e.g. 10 s window at 3 s cadence overlaps by 7 s).
 *
 * Returns one entry per cadence tick whose window actually intersects the
 * timeline. Deterministic and pure, so it is directly unit-testable.
 */
export function planObserveWindows(
  frames: { ts: number; imageB64: string }[],
  opts: { startTs?: number; endTs?: number; cadenceS?: number; windowS?: number; maxFrames?: number; fps?: number } = {}
): ObserveWindow[] {
  const cadenceS = opts.cadenceS ?? OBSERVE_CADENCE_S;
  const windowS = opts.windowS ?? OBSERVE_WINDOW_S;
  const maxFrames = opts.maxFrames ?? OBSERVE_MAX_FRAMES;
  const fps = opts.fps ?? OBSERVE_CONTENT_FPS;
  if (frames.length === 0) return [];
  const sorted = [...frames].sort((a, b) => a.ts - b.ts);
  const timelineStart = opts.startTs ?? sorted[0].ts;
  const timelineEnd = opts.endTs ?? sorted[sorted.length - 1].ts;
  const out: ObserveWindow[] = [];
  for (let center = timelineStart; center <= timelineEnd + 1e-9; center += cadenceS) {
    const w = assembleObserveWindow(sorted, center, { windowS, maxFrames, fps });
    if (w.frames.length > 0) out.push(w);
  }
  return out;
}

/** Live observe constants (ADAAAA-7008). A live observer cannot decode ahead,
 * so the live window is a ROLLING PAST window anchored on `nowTs` rather than a
 * symmetric [center-window/2, center+window/2] band. Cadence is CEO-locked in
 * the spec; the ~30 s budget = cadence + gemma end-to-end latency, measured and
 * reported on the Livepeer runner. */
export const LIVE_OBSERVE_WINDOW_S = 10;
export const LIVE_OBSERVE_MAX_FRAMES = 30;

/**
 * Assemble ONE rolling PAST decide window for a live stream.
 *
 * Unlike {@link assembleObserveWindow} (a symmetric window around a center), a
 * live observer can only look at content already received, so this keeps only
 * frames in `[nowTs - windowS, nowTs]` — the trailing `windowS` seconds. It
 * resolves to a regular `fps` grid (nearest frame per step) and hard-caps to
 * `<= maxFrames` via {@link subsampleToCap}, exactly like the VOD path.
 *
 * `frames` may be unordered and may contain future timestamps (harmless — they
 * are dropped); output is always ordered oldest -> newest. An empty window
 * yields `frames: []` (no decide fires on it). `centerTs` is set to `nowTs`
 * so a consumer can tell which moment the window was observed at.
 */
export function assembleLiveWindow(
  frames: { ts: number; imageB64: string }[],
  nowTs: number,
  opts: { windowS?: number; maxFrames?: number; fps?: number } = {}
): ObserveWindow {
  const windowS = opts.windowS ?? LIVE_OBSERVE_WINDOW_S;
  const maxFrames = opts.maxFrames ?? LIVE_OBSERVE_MAX_FRAMES;
  const fps = opts.fps ?? OBSERVE_CONTENT_FPS;
  const lo = nowTs - windowS;
  const inWindow = frames
    .filter((f) => f.imageB64 && f.ts >= lo && f.ts <= nowTs + 1e-9)
    .sort((a, b) => a.ts - b.ts);
  if (inWindow.length === 0) return { centerTs: nowTs, frames: [], capped: false, droppedCount: 0 };

  // Resolve to the fps grid across [start, now] (nearest frame per step).
  const step = fps > 0 ? 1 / fps : Infinity;
  const start = inWindow[0].ts;
  const grid: { ts: number; imageB64: string }[] = [];
  const seenTs = new Set<number>();
  const nearest = (t: number): { ts: number; imageB64: string } | undefined => {
    let best: { ts: number; imageB64: string } | undefined;
    let bestDiff = Infinity;
    for (const f of inWindow) {
      const d = Math.abs(f.ts - t);
      if (d < bestDiff) {
        bestDiff = d;
        best = f;
      }
    }
    return best;
  };
  for (let t = start; t <= nowTs + 1e-9; t += step) {
    const n = nearest(t);
    if (n && !seenTs.has(n.ts)) {
      seenTs.add(n.ts);
      grid.push(n);
    }
  }
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  if (!seenTs.has(first.ts)) grid.unshift(first);
  if (!seenTs.has(last.ts)) grid.push(last);

  const { items, capped } = subsampleToCap(grid, maxFrames);
  const droppedCount = grid.length - items.length;
  return { centerTs: nowTs, frames: items, capped, droppedCount };
}

/** ADAAAA-7676: the live observe lag budget (wall-clock seconds). A live window
 * whose CONTENT time is further behind wall time than this is STALE: deciding
 * it would land the result even later, so the pass drops it (and its frames)
 * instead of deciding it late. 30 s is the cadence + decide-E2E budget the spec
 * quotes for the Livepeer runner, so a decided window inside it is still
 * "live". Override with `LIVE_OBSERVE_LAG_BUDGET_S`. */
export const LIVE_OBSERVE_LAG_BUDGET_S = 30;

/** One measured live observe iteration: cadence tick that fired a decide, plus
 * the end-to-end latency budget accounting the spec requires to be measured and
 * reported on the Livepeer runner (cadence + gemma E2E). */
export interface LiveObserveLatencySample {
  /** Content time this decide was observed at. */
  centerTs: number;
  /** Frames actually sent to decide for this invocation. */
  frameCount: number;
  /** Wall-clock ms from tick-scheduled to the decide verdict returned. */
  e2eMs: number;
  /** Content-time cadence delta from the previous fired tick (ms). */
  cadenceMs: number;
  /** ADAAAA-7676: wall-clock lag of this window's CONTENT time behind the live
   * edge when the decide was scheduled (ms). The result reaches the feed at
   * ~`lagMs + e2eMs`, i.e. `completedLagMs`. */
  lagMs?: number;
  /** ADAAAA-7676: wall-clock lag at the moment the decide verdict returned
   * (ms) — the number a live viewer experiences (`summaryLog` `windowTs` vs
   * wall `ts`). */
  completedLagMs?: number;
}

/**
 * Streaming live decide-observer (ADAAAA-7008).
 *
 * Driven from the caller's OWN per-frame loop (which already calls perceive
 * `analyze` to obtain the observation), so it never re-analyzes: `record`
 * stores a frame + its perceive-derived seed context; `maybeFire` fires a
 * rolling-PAST decision on the cadence. Unlike the VOD
 * {@link ObserveDecider}, the window is `[now - windowS, now]` (no decode
 * ahead) and the loop measures cadence + decide e2e latency against the ~30 s
 * budget for the Livepeer runner report.
 *
 * Audio noise-change and motion are folded in as `biasHints` (per-frame
 * attention hints) — they are NOT the on/off gate; decide still runs every
 * cadence tick regardless of whether perceive emitted a candidate.
 */
export class LiveObserver {
  private readonly frames: { ts: number; imageB64: string }[] = [];
  private readonly findings = new Map<number, PerFrameSeed>();
  private lastFireTs: number | null = null;
  private readonly cadenceS: number;
  private readonly windowS: number;
  private readonly maxFrames: number;
  private readonly fps: number;
  private readonly signalGate: boolean;
  private readonly signalGateOpts: SignalGateOptions;
  /** Budget threshold for an early trigger-anchored fire (ADAAAA-7658). */
  private readonly triggerMinBudget: number;
  private readonly onDecide: ((payload: ObserveDecidePayload) => Promise<boolean>) | null;
  private readonly latency: LiveObserveLatencySample[] = [];
  /** Perceive candidate triggers folded into each window as bias hints
   * (provenance metadata) — never the on/off switch. */
  private readonly biasHints: ObserveBiasHint[] = [];
  private accepts = 0;
  /** Cadence ticks suppressed by the Tier-2 signal gate (ADAAAA-7145). */
  private gatedSkips = 0;
  /** ADAAAA-7658: fired audio-noise triggers waiting for an anchored window. */
  private readonly triggers = new TriggerWindowScheduler();
  /** Decide budget (one token per `cadenceS`, capacity 1). Every fire — cadence
   *  or trigger-anchored — spends a token, so trigger windows can never add
   *  decide invocations beyond the blind-cadence baseline (AC3). An anchored
   *  fire may spend down to -0.6 (40% of a cadence early) to keep the
   *  level-change -> decide latency inside 1.5 s p95 (AC2); the balance is
   *  repaid before the next cadence tick. */
  private budgetTokens = 1;
  private lastBudgetTs: number | null = null;
  /** Decide fires scheduled by an audio trigger (anchored) vs blind cadence. */
  private anchoredFires = 0;
  private cadenceFires = 0;
  /** ADAAAA-7707: whistle-family accounting. `whistleTriggers` = Stage-B
   *  triggers the scheduler accepted (accepted, not coalesced — one audible
   *  event per count); `whistleAnchoredFires` = decide windows anchored on one.
   *  Kept apart from `anchoredFires` so the crowding share
   *  (`whistleDecides / decideCalls`) is measurable on a live window. */
  private whistleTriggers = 0;
  private whistleAnchoredFires = 0;
  /** ADAAAA-7676: frames dropped as stale (content time behind the lag budget)
   * and the cadence windows those drops swallowed. `skippedStaleWindows` is the
   * job-visible counter (AC2): windows that were NOT decided late. */
  private staleFrames = 0;
  private skippedStaleWindows = 0;
  /** ADAAAA-7676: worst (and mean) wall-clock lag observed on a dropped frame. */
  private maxLagMs = 0;
  private lagSumMs = 0;
  private lagCount = 0;
  /** ADAAAA-7694: records the Stage-A outcome (accepted/rejected + onset
   * latency) for every trigger a decided window judges. Owned by the run (the
   * audio tap feeds it), so the observer only writes the verdicts. */
  private readonly stageA: StageAOutcomeLedger | null;
  /** ADAAAA-7707: the Stage-B (whistle) verdict ledger. Whistle windows judge
   *  here, never into `stageA`, so the published Stage-A fidelity is untouched. */
  private readonly stageB: StageAOutcomeLedger | null;

  constructor(opts: {
    cadenceS?: number;
    windowS?: number;
    maxFrames?: number;
    fps?: number;
    signalGate?: boolean;
    signalGateOpts?: SignalGateOptions;
    onDecide?: (payload: ObserveDecidePayload) => Promise<boolean>;
    /** Minimum budget needed to fire early on a trigger (default 0.4). */
    triggerMinBudget?: number;
    /** ADAAAA-7694: Stage-A outcome ledger, so each decided window records the
     *  verdict of the audio triggers whose onset it judged. */
    stageA?: StageAOutcomeLedger;
    /** ADAAAA-7707: Stage-B (whistle) outcome ledger — the whistle family's own
     *  counters, so a whistle verdict never moves the Stage-A FP-rate. */
    stageB?: StageAOutcomeLedger;
  } = {}) {
    this.cadenceS = opts.cadenceS ?? OBSERVE_CADENCE_S;
    this.windowS = opts.windowS ?? LIVE_OBSERVE_WINDOW_S;
    this.maxFrames = opts.maxFrames ?? LIVE_OBSERVE_MAX_FRAMES;
    this.fps = opts.fps ?? OBSERVE_CONTENT_FPS;
    this.signalGate = opts.signalGate ?? false;
    this.signalGateOpts = opts.signalGateOpts ?? {};
    this.onDecide = opts.onDecide ?? null;
    this.triggerMinBudget = opts.triggerMinBudget ?? 0.4;
    this.stageA = opts.stageA ?? null;
    this.stageB = opts.stageB ?? null;
  }

  /** Record a frame + its perceive-derived seed context (no re-inference). */
  record(ts: number, imageB64: string, seed: PerFrameSeed): void {
    this.frames.push({ ts, imageB64 });
    this.findings.set(ts, seed);
    const cutoff = ts - Math.max(this.windowS, OBSERVE_WINDOW_S);
    while (this.frames.length && this.frames[0].ts < cutoff) this.frames.shift();
  }

  /** Fold a perceive candidate trigger into the window as a bias hint
   * (per-window provenance / metadata) — never the on/off switch. A trigger
   * fires a decide candidate only; the observer still runs decide on the
   * cadence regardless of whether a trigger fired (recall not limited by
   * trigger-FP gating). */
  addHint(eventType: string, ts: number, attest?: { goalCrossed?: boolean; ballOutcome?: string; scoreBoardChanged?: boolean }): void {
    this.biasHints.push({ eventType, ts, ...(attest ?? {}) });
    if (this.biasHints.length > 30) this.biasHints.shift();
  }

  /** Fire a rolling-past decide when the cadence is due. `force` ignores the
   * cadence (used at end-of-stream to observe the tail). `lagMs` is the measured
   * content-vs-wall lag of this window (ADAAAA-7676), recorded on the sample so
   * the job shows how fresh the decided moment was. */
  async maybeFire(nowTs: number, force = false, lagMs?: number): Promise<boolean> {
    await this.fire(nowTs, force, lagMs);
    return this.lastFireTs === nowTs;
  }

  /** Force one final observation at end-of-stream. */
  async flush(lagMs?: number): Promise<void> {
    const last = this.frames[this.frames.length - 1];
    if (last) await this.fire(last.ts, true, lagMs);
  }

  /**
   * ADAAAA-7676: DROP a stale frame instead of deciding it late.
   *
   * On a loaded box one decide costs ~8–13 s wall per ~3 s of content, so a
   * serial live loop falls further behind the capture clock every tick and the
   * backlog grows without bound: the measured symptom was a window labelled
   * `T+42s` reaching the feed at wall `+242s` (~5.7x). The caller measures each
   * frame's content-vs-wall lag and, once it exceeds the observe budget, hands
   * the frame here instead of to `record` + `maybeFire`.
   *
   * `record` is NOT called for a stale frame (its image/seed would only widen
   * the gap), but the cadence clock still advances through the dropped content
   * time — every `cadenceS` of dropped content is ONE skipped stale window, so
   * the next fired window is still ~`cadenceS` of content later (AC3's cadence
   * stays ≤ 3 s; freshness is bought by dropping work, never by deciding more
   * often). Returns the number of windows swallowed by this frame.
   */
  noteStaleFrame(ts: number, lagS: number): number {
    this.staleFrames++;
    const lagMs = Math.max(0, Math.round(lagS * 1000));
    if (lagMs > this.maxLagMs) this.maxLagMs = lagMs;
    this.lagSumMs += lagMs;
    this.lagCount++;
    this.refillBudget(ts);
    let skipped = 0;
    if (this.lastFireTs === null) {
      // No window decided yet: anchor the cadence clock here so the first real
      // fire is one cadence later, not immediately on a stale backlog.
      this.lastFireTs = ts;
      // ADAAAA-7707: only onsets already OLDER than the retained window are
      // unanchorable. A trigger whose onset is still inside a future window is
      // kept — the audio tap runs ahead of a lagging video rail, so a whistle
      // fire is recorded before the frame clock reaches its onset.
      this.triggers.coverThrough(-Infinity, ts - this.windowS);
      this.stageA?.dropThrough(ts - this.windowS, ts);
      return 0;
    }
    const elapsed = ts - this.lastFireTs;
    if (elapsed >= this.cadenceS - 1e-9) {
      skipped = Math.floor((elapsed + 1e-9) / this.cadenceS);
      this.lastFireTs = ts;
    }
    if (skipped > 0) {
      this.skippedStaleWindows += skipped;
      // Triggers whose onset is already older than the retained window can no
      // longer be anchored and are dropped. A trigger still INSIDE the window
      // horizon is kept (and bounded by the scheduler's max-stale expiry):
      // ADAAAA-7707 measured a whistle fire recorded while the frame clock was
      // ~10 s behind being swallowed here by the dropped span's cover, so the
      // one anchored analysis the fire is entitled to never happened. They were
      // never decided, so the Stage-A ledger drops them too (never a fabricated
      // reject — ADAAAA-7694).
      this.triggers.coverThrough(-Infinity, ts - this.windowS);
      this.stageA?.dropThrough(ts - this.windowS, ts);
    }
    return skipped;
  }

  /**
   * ADAAAA-7658: queue a fired audio-noise trigger for one anchored analysis.
   * The trigger's onset becomes the anchor of the decide window; the scheduler
   * coalesces re-fires of the same audible event so one trigger produces ONE
   * scheduled analysis (never a per-frame storm). Returns whether it queued.
   */
  recordTrigger(trigger: AudioTriggerRecord | null | undefined): boolean {
    const queued = this.triggers.record(trigger);
    // ADAAAA-7707: count the Stage-B fires the scheduler ACCEPTED. A coalesced
    // re-fire is the same whistle, so the volume counter stays a per-event rate.
    if (queued && isStageBTrigger(trigger?.thresholdId)) this.whistleTriggers++;
    return queued;
  }

  /** Refill the decide budget by elapsed content time (capacity 1 token). */
  private refillBudget(nowTs: number): void {
    if (this.lastBudgetTs === null) {
      this.lastBudgetTs = nowTs;
      return;
    }
    const dt = nowTs - this.lastBudgetTs;
    if (dt > 0) this.budgetTokens = Math.min(1, this.budgetTokens + dt / this.cadenceS);
    this.lastBudgetTs = Math.max(this.lastBudgetTs, nowTs);
  }

  private async fire(nowTs: number, force: boolean, lagMs?: number): Promise<void> {
    this.refillBudget(nowTs);
    const cadenceDue = shouldFireObserve(this.lastFireTs, nowTs, this.cadenceS);
    // A due trigger replaces the cadence tick at the same budget price. When
    // the cadence is already due the trigger simply wins (better anchor and
    // better latency, same cost); when it is not due the anchored fire may
    // spend half a token early (repaid before the next cadence tick).
    //
    // ADAAAA-7699: PEEK the due trigger first and consume it only once the
    // budget gate passes. The previous order consumed it (`triggers.due()`)
    // before the budget check, so an anchored tick that was refused for budget
    // dropped the trigger entirely — one fired audible event produced no decide
    // at all. The trigger now stays pending (bounded by the scheduler's
    // max-stale horizon) and anchors the next affordable tick.
    const dueTrigger = force ? null : this.triggers.peekDue(nowTs);
    const anchored = !!dueTrigger;
    if (!force) {
      // Epsilon: the budget refill is a float accumulation, so an exactly-due
      // cadence tick can land at 0.9999999 tokens and be skipped by one frame
      // (which then drifts every later tick). Compare with a tolerance.
      const EPS = 1e-9;
      if (anchored) {
        if (this.budgetTokens < this.triggerMinBudget - EPS) return;
      } else if (!cadenceDue || this.budgetTokens < 1 - EPS) {
        return;
      }
    }
    if (anchored) this.triggers.consume();
    const prevFire = this.lastFireTs;
    this.lastFireTs = nowTs;
    this.budgetTokens -= 1;
    const win = assembleLiveWindow(this.frames, nowTs, { windowS: this.windowS, maxFrames: this.maxFrames, fps: this.fps });
    if (win.frames.length === 0) return;
    const lo = nowTs - this.windowS;
    const inWindow = this.biasHints.filter((h) => h.ts >= lo && h.ts <= nowTs + 1e-9);
    // ADAAAA-7658: when this window is trigger-anchored, the trigger itself is
    // provenance for the window (the gate's threshold identity + energies).
    if (anchored && dueTrigger) {
      inWindow.push({
        eventType: `AUDIO_${dueTrigger.kind.toUpperCase()}`,
        ts: dueTrigger.onsetTs,
      });
    }
    const payload = buildObservePayload(win, this.findings, inWindow, anchored ? dueTrigger ?? undefined : undefined);
    // ADAAAA-7145: Tier-2 signal gate (recall-safe, same rule as ObserveDecider).
    // A trigger-anchored window is never gate-skipped: an audio trigger IS a
    // signal, so gating it off would defeat the trigger.
    if (this.signalGate && !force && !anchored && !windowHasSignal(payload.seeds, inWindow, this.signalGateOpts)) {
      this.gatedSkips++;
      this.lastFireTs = nowTs;
      return;
    }
    const cadenceMs = prevFire === null ? 0 : (nowTs - prevFire) * 1000;
    if (anchored) this.anchoredFires++;
    else this.cadenceFires++;
    // ADAAAA-7707: the whistle share numerator — windows a whistle anchored.
    if (anchored && dueTrigger && isStageBTrigger(dueTrigger.thresholdId)) this.whistleAnchoredFires++;
    // Triggers already inside the window just analyzed are covered by it.
    this.triggers.coverThrough(lo, nowTs);
    let e2eMs = 0;
    if (this.onDecide) {
      const started = Date.now();
      const accepted = await this.onDecide(payload);
      e2eMs = Date.now() - started;
      if (accepted) this.accepts++;
      // ADAAAA-7694: this decided window IS the judgement of every Stage-A
      // trigger whose onset it covers. Record the outcome (accepted/rejected +
      // the gate's onset latency) so the job persists a MEASURED FP-rate
      // snapshot instead of the all-zero `n/a` one. The anchored trigger is
      // judged explicitly too: if the stream lagged far enough that its onset
      // fell outside this trailing span it would otherwise stay pending.
      if (this.stageA || this.stageB) {
        // ADAAAA-7707: a trigger is judged by its FAMILY's ledger. A whistle
        // verdict must never land in `stageA` (the published Stage-A fidelity),
        // and `judgeWindow` on the stage-A ledger must not swallow a stage-B
        // trigger that a cadence window happened to cover.
        if (anchored && dueTrigger) {
          if (isStageBTrigger(dueTrigger.thresholdId)) this.stageB?.judgeTrigger(dueTrigger, accepted);
          else this.stageA?.judgeTrigger(dueTrigger, accepted);
        }
        this.stageA?.judgeWindow(lo, nowTs, accepted);
        this.stageB?.judgeWindow(lo, nowTs, accepted);
      }
      const lag = lagMs ?? 0;
      this.latency.push({
        centerTs: nowTs,
        frameCount: payload.frames.length,
        e2eMs,
        cadenceMs,
        lagMs: lag,
        completedLagMs: lag + e2eMs,
      });
    }
  }

  /** Ran the source clock ahead past the observed tail (no-op safety). */
  seek(ts: number): void {
    if (ts > (this.frames[this.frames.length - 1]?.ts ?? 0)) {
      // The caller may advance content time without a new frame; nothing to
      // record, but keep the cadence clock honest by seeding lastFireTs only
      // when a window could actually be assembled.
    }
  }

  /** Measured cadence + gemma e2e latency samples for the Livepeer report. */
  latencySamples(): LiveObserveLatencySample[] {
    return [...this.latency];
  }
  /** Max observed e2e latency in ms (0 when no sample). */
  maxE2eMs(): number {
    return this.latency.reduce((a, b) => Math.max(a, b.e2eMs), 0);
  }
  /** Mean observed e2e latency in ms (0 when no sample). */
  meanE2eMs(): number {
    if (this.latency.length === 0) return 0;
    return this.latency.reduce((a, b) => a + b.e2eMs, 0) / this.latency.length;
  }
  /** Per-call decide input size (frame count) for the cost report. */
  inputSizeSamples(): number[] {
    return this.latency.map((s) => s.frameCount);
  }
  decideCalls(): number {
    return this.latency.length;
  }
  maxFrameCount(): number {
    return this.latency.reduce((a, b) => Math.max(a, b.frameCount), 0);
  }
  acceptedCount(): number {
    return this.accepts;
  }
  /** Cadence ticks suppressed by the Tier-2 signal gate (ADAAAA-7145). */
  gatedSkipCount(): number {
    return this.gatedSkips;
  }
  /** ADAAAA-7658: decide fires scheduled by an audio trigger (anchored). */
  triggerFireCount(): number {
    return this.anchoredFires;
  }
  /** ADAAAA-7658: decide fires that came from the blind cadence. */
  cadenceFireCount(): number {
    return this.cadenceFires;
  }
  /** ADAAAA-7707: Stage-B triggers this observer scheduled (accepted, not
   *  coalesced) — the whistle emission volume. */
  whistleFireCount(): number {
    return this.whistleTriggers;
  }
  /** ADAAAA-7707: decide windows anchored on a whistle trigger — the crowding
   *  numerator (`whistleShare = whistleDecides / decideCalls`). */
  whistleDecideCount(): number {
    return this.whistleAnchoredFires;
  }
  /** ADAAAA-7658: trigger scheduler bookkeeping (accepted / coalesced /
   *  covered / expired / fired). */
  triggerStats(): TriggerSchedulerStats {
    return this.triggers.stats();
  }
  /** ADAAAA-7676: cadence windows DROPPED because their content was beyond the
   *  lag budget — the job-visible AC2 counter (`observeMetrics
   *  .skippedStaleWindows`). */
  skippedStaleWindowCount(): number {
    return this.skippedStaleWindows;
  }
  /** ADAAAA-7676: frames dropped as stale (the ingest backlog the drop drained). */
  staleFrameCount(): number {
    return this.staleFrames;
  }
  /** ADAAAA-7676: worst wall-clock content-vs-wall lag seen on a dropped frame. */
  maxObservedLagMs(): number {
    return this.maxLagMs;
  }
  /** ADAAAA-7676: mean wall-clock lag over the dropped frames. */
  meanObservedLagMs(): number {
    return this.lagCount === 0 ? 0 : this.lagSumMs / this.lagCount;
  }
  /** ADAAAA-7676: the most recent fired window's sample (lag/e2e for the
   *  `[live-lag]` evidence line). */
  lastSample(): LiveObserveLatencySample | null {
    return this.latency.length ? this.latency[this.latency.length - 1] : null;
  }
  /** ADAAAA-7676: content time of the newest RECORDED frame (the tail the
   *  end-of-stream flush observes), for its wall-lag measurement. */
  lastRecordedTs(): number | null {
    return this.frames.length ? this.frames[this.frames.length - 1].ts : null;
  }
}

/** Per-frame perceive-derived seed context carried into a decide payload
 * (detections / tracking / scoreboard / motion geometry). This is the
 * "perceive as data seeder" contract — no re-inference, just the already
 * computed findings for the frame. */
export interface PerFrameSeed {
  ts: number;
  tracks?: { trackId: string; label?: string; bbox?: number[] }[];
  objects?: { label: string; confidence?: number; bbox?: number[] }[];
  ocr?: string[];
  /** Convenience summary derived from the findings (never triggers a decide). */
  summary?: string;
  /** ADAAAA-7145: per-frame perceive-derived goal/ball/scoreboard signal
   * evidence (the additive `evidence` field perceive attaches to every
   * observation — ballVelocity / goalCrossed / ballOutcome / scoreboard). Used
   * by the Tier-2 signal gate to decide whether a window is worth a billable
   * decide call. Absent/undefined = no signal reported for the frame. */
  signal?: PerFrameSignal;
}

/** ADAAAA-7145: one frame's real-goal signal evidence, as reported by perceive.
 * Mirrors the perceive `signal_gate` vocabulary (ADAAAA-7135 tier2). All fields
 * optional — an absent field is "no signal reported", never fabricated. */
export interface PerFrameSignal {
  /** Geometry-agnostic ball-in-net attestation (ADAAAA-7044). */
  ballInNet?: boolean;
  /** Goal-line plane classifier: ball crossed the line (decide-leg I2). */
  goalCrossed?: boolean;
  /** Goal-line outcome string ("goal" | "cross" | "off_target" | ...). */
  ballOutcome?: string;
  /** Scoreboard score-delta across the candidate window (decide-leg I3). */
  scoreBoardChanged?: boolean;
  /** A confident motion burst detected on the frame. */
  motionBurst?: boolean;
  /** An audio noise-change gate firing on/near the frame. */
  audioBurst?: boolean;
  /** True when a goal-signal channel (goal-line / homography / scoreboard) was
   * configured AND produced a judgment. When false/absent, recall-safety
   * escalates (a genuine goal in an uncalibrated session is never starved). */
  goalInfra?: boolean;
  /** ADAAAA-7147: the calibration-free ball-velocity estimate perceive attaches
   * to the observation `evidence` (image-space when `homography:false`, no
   * goal-line/homography required — it is the ONE signal perceive reliably
   * emits on an uncalibrated box). `speedMps` is a per-second displacement in
   * image/normalized units when `homography:false`; `homography:true` means a
   * real field-plane m/s estimate from a pitch homography. Used by the Tier-2
   * signal gate to escalate a fast/meaningful ball even when no goal channel
   * judged the frame, so the gate stops being inert on the current box. */
  ballVelocity?: {
    vxMps?: number;
    vyMps?: number;
    speedMps?: number;
    posXm?: number;
    posYm?: number;
    homography?: boolean;
  };
  /** Perceive's ball possession assignment (calibration-free, image-space
   * loose-ball fallback when no homography). Weak/absent only; carried so the
   * decide prompt can cite possession but never a goal signal on its own. */
  ballPossession?: { possessingPlayerId?: string; distanceM?: number };
}

/** `ballOutcome` values meaning a scoring play crossed the line. Anything else
 * (off_target / blocked / no_shot / absent) is NOT a goal signal by itself. */
export const GOAL_OUTCOMES: ReadonlySet<string> = new Set(["goal", "cross", "goal_crossed", "crossed"]);

/**
 * ADAAAA-7147: per-window signal-gate tuning for the Tier-2 gate. All fields
 * optional; absent fields fall back to the recall-safe baseline (an
 * uncalibrated window escalates rather than starving a goal).
 */
export interface SignalGateOptions {
  /** Ball speed (see {@link PerFrameSignal.ballVelocity} `speedMps`) at/above
   * which a frame is a "meaningful ball" escalation signal. When unset, ball
   * velocity is never used as a discriminator (the gate ignores it, matching
   * the pre-7147 behaviour). */
  ballMinSpeedMps?: number;
  /** When true, an uncalibrated window (no goal channel judged, `goalInfra`
   * not true) that carries NO meaningful ball / goal signal / motion+audio
   * burst is SUPPRESSED instead of recall-escalated. This is the
   * calibration-free discriminator that lets the gate actually cut decide
   * volume on a box with no goal-line/homography/scoreboard channel. Keep it
   * off unless the decide observer verifies goal recall under it. */
  suppressQuietUncalibrated?: boolean;
}

/** ADAAAA-7147: a faster-than-this ball is "meaningful" when no per-job
 * threshold is supplied. Image-space (normalized frame) displacement per
 * second when `homography:false`, so a value that distinguishes a genuine
 * play (shot / driven pass / cross) from a near-static ball. Conservative so a
 * real goal's approach is not starved; the box-measurement pass tunes
 * `OBSERVE_SIGNAL_GATE_BALL_MIN_SPEED`. */
export const DEFAULT_BALL_MIN_SPEED = 0.08;

/**
 * ADAAAA-7145 (Tier-2 signal gate): whether ONE frame escalates to the Tier-2
 * confirm pass (a billable decide call). Escalates on ANY real goal signal
 * (ball-in-net / goal-crossed / goal-valued outcome / scoreboard change), OR a
 * confident motion+audio burst (recall path for a no-geometry goal), OR a
 * meaningful calibration-free ball velocity when a threshold is supplied, OR
 * recall-safety when no goal-signal channel judged the frame (unless
 * `suppressQuietUncalibrated` says to drop a quiet uncalibrated window — the
 * ADAAAA-7147 reliability fix, see the interface). Only SUPPRESSES when a
 * goal-signal channel actively reported NOT a goal (goalInfra true) and there
 * is no strong signal, or (in suppress-quiet mode) the uncalibrated window is
 * genuinely quiet. Pure + deterministic (unit-testable).
 */
export function escalatesToTier2(sig: PerFrameSignal | undefined, opts: SignalGateOptions = {}): boolean {
  if (!sig) return false;
  if (sig.ballInNet === true) return true;
  if (sig.goalCrossed === true) return true;
  if (sig.ballOutcome !== undefined && GOAL_OUTCOMES.has(sig.ballOutcome)) return true;
  if (sig.scoreBoardChanged === true) return true;
  if (sig.motionBurst === true && sig.audioBurst === true) return true;
  // Calibration-free meaningful-ball signal (ADAAAA-7147): a fast ball is a
  // real highlight signal worth a decide, even with no goal channel.
  if (opts.ballMinSpeedMps !== undefined && sig.ballVelocity?.speedMps !== undefined && sig.ballVelocity.speedMps >= opts.ballMinSpeedMps) {
    return true;
  }
  // A goal-signal channel actively judged the frame (not-a-goal) and there is
  // no strong signal -> suppress (the flood scenario the gate is built to cut).
  if (sig.goalInfra === true) return false;
  // Uncalibrated (no goal channel): recall-safe escalates by default (never
  // starve a genuine goal in an uncalibrated/disabled session).
  if (opts.suppressQuietUncalibrated === true) return false;
  return true;
}

/**
 * ADAAAA-7145: whether a decide WINDOW contains a real highlight signal, so the
 * Tier-2 confirm (decide observer) should fire. A window escalates when ANY
 * in-window frame seed carries a real goal signal, a meaningful calibration-free
 * ball velocity (per {@link SignalGateOptions.ballMinSpeedMps}), or any
 * in-window bias hint carries a goal attestation (scoreboard change /
 * goal-crossed / goal-valued outcome). Pure + deterministic.
 */
export function windowHasSignal(
  seeds: { signal?: PerFrameSignal }[],
  biasHints: ObserveBiasHint[] = [],
  opts: SignalGateOptions = {}
): boolean {
  for (const s of seeds) if (escalatesToTier2(s.signal, opts)) return true;
  for (const h of biasHints) {
    if (h.scoreBoardChanged === true || h.goalCrossed === true) return true;
    if (h.ballOutcome !== undefined && GOAL_OUTCOMES.has(h.ballOutcome)) return true;
  }
  return false;
}

export interface ObserveDecidePayload {
  centerTs: number;
  frames: { ts: number; imageB64: string }[];
  /** Perceive-seeded per-frame context, aligned to the window frames. */
  seeds: PerFrameSeed[];
  /** Per-window bias hints / provenance from perceive trigger signals — NOT the
   * on/off switch. When non-empty, decide treats them as evidence to weigh. A
   * hint may carry the candidate's goal-attestation signals (goalCrossed /
   * ballOutcome / scoreBoardChanged) so the decide goal-attestation gate can
   * attest a `scoring_play` (ADAAAA-7021 adverse-finding fix). */
  biasHints: ObserveBiasHint[];
  capped: boolean;
  droppedCount: number;
  /** ADAAAA-7658: the audio trigger this window is anchored to, when this
   *  decide was scheduled by a fired audio-noise trigger rather than the blind
   *  cadence. Absent on a cadence tick (the pre-trigger behaviour). */
  trigger?: AudioTriggerRecord;
}

/**
 * Align the perceive-seeded context (findings keyed by timestamp) to a window
 * frame set. A frame with no cached findings yields an empty seed (absent
 * evidence is explicitly no-signal, never fabricated). Used to build every
 * decide payload's `seeds` array.
 */
export function alignSeeds(
  windowFrames: { ts: number }[],
  findingsByTs: Map<number, PerFrameSeed>
): PerFrameSeed[] {
  return windowFrames.map((f) => findingsByTs.get(f.ts) ?? { ts: f.ts });
}

// ---------------------------------------------------------------------------
// Streaming driver (VOD detail-first) + on-demand perceive recall
// ---------------------------------------------------------------------------

/** A perceive trigger signal folded into a window as a bias hint (provenance /
 * metadata) — never the on/off switch. Mirrors the frozen candidate vocabulary
 * (packages/events outcome enum / eventTypeForOutcome / isAcceptedHighlight). */
export interface ObserveBiasHint {
  eventType: string;
  ts: number;
  /** Perceive candidate goal-attestation signals (I2/I3 ground-truth, ADAAAA-6359
   * / ADAAAA-6360). Folded from the perceive candidate so the decide
   * goal-attestation gate can independently attest a `scoring_play` — without
   * these the decide runner rejects every goal ("model reason alone is not
   * sufficient") and goal recall collapses to 0 (ADAAAA-7021 adverse finding).
   * Absent/undefined = provenance only, never a false attestation. */
  goalCrossed?: boolean;
  ballOutcome?: string;
  scoreBoardChanged?: boolean;
}

/**
 * Decide whether an observe tick should fire now. The tick fires when the
 * current content time has advanced at least `cadenceS` since the last decide.
 * Pure so it is unit-testable; keeps cadence independent of wall-clock jitter.
 */
export function shouldFireObserve(
  lastFireTs: number | null,
  currentTs: number,
  cadenceS: number = OBSERVE_CADENCE_S
): boolean {
  if (lastFireTs === null) return true;
  return currentTs - lastFireTs >= cadenceS - 1e-9;
}

/**
 * Build the full observe decide payload for a window: the window frames +
 * perceive-seeded per-frame context + the perceived bias hints within the
 * window. Pure + deterministic. `biasHints` are the folded candidate triggers
 * inside the window (see {@link ObserveBiasHint}); an empty list is the correct
 * "no trigger" case — decide still runs, which is the whole point of the
 * observer architecture (perceive no longer gates).
 */
export function buildObservePayload(
  win: ObserveWindow,
  findingsByTs: Map<number, PerFrameSeed>,
  biasHints: ObserveBiasHint[] = [],
  trigger?: AudioTriggerRecord
): ObserveDecidePayload {
  return {
    centerTs: win.centerTs,
    frames: win.frames,
    seeds: alignSeeds(win.frames, findingsByTs),
    biasHints: [...biasHints].sort((a, b) => a.ts - b.ts),
    capped: win.capped,
    droppedCount: win.droppedCount,
    ...(trigger ? { trigger } : {}),
  };
}

/**
 * Streaming observe driver for the VOD detail-first pass.
 *
 * Consumes a frame iterator (seq / timestamp / imageB64), maintains the rolling
 * findings cache (perceive data seeding), and fires a decide at each cadence
 * tick. At every fire it assembles the ~windowS window centered on the current
 * moment and calls `onDecide` with the full observe payload (frames + seeds +
 * bias hints). Overlap between consecutive windows is inherent (windowS >
 * cadenceS). Every payload carries at most `maxFrames` frames (subsampled when
 * the source is denser).
 *
 * `findingsFor` supplies the perceive-derived per-frame seed context; when a
 * frame has no findings yet (e.g. the /analyze round-trip is in flight) the
 * seed is an explicit empty/no-signal, never fabricated. `biasHintsFor` folds
 * the window's candidate triggers into provenance hints. `onDecide` is the
 * caller's decide + accept wiring and returns whether the moment was accepted,
 * which the loop records only for the cost/report surface.
 *
 * Runs the frame iteration for its full length and fires a final (partial)
 * tick at the end so the tail of the timeline is still observed.
 */
export async function runObserveLoop(opts: {
  frames: AsyncIterable<{ seq: number; timestamp: number; imageB64: string }>;
  findFrames: () => { ts: number; imageB64: string }[];
  findingsFor: (ts: number) => PerFrameSeed | undefined;
  biasHintsFor: (win: ObserveWindow) => ObserveBiasHint[];
  onDecide: (payload: ObserveDecidePayload) => Promise<boolean>;
  cadenceS?: number;
  windowS?: number;
  maxFrames?: number;
  fps?: number;
}): Promise<{ ticks: number; accepted: number }> {
  const {
    frames,
    findFrames,
    findingsFor,
    biasHintsFor,
    onDecide,
    cadenceS = OBSERVE_CADENCE_S,
    windowS = OBSERVE_WINDOW_S,
    maxFrames = OBSERVE_MAX_FRAMES,
    fps = OBSERVE_CONTENT_FPS,
  } = opts;
  let lastFireTs: number | null = null;
  let ticks = 0;
  let accepted = 0;
  const consume = async (currentTs: number) => {
    if (!shouldFireObserve(lastFireTs, currentTs, cadenceS)) return;
    lastFireTs = currentTs;
    const all = findFrames();
    const win = assembleObserveWindow(all, currentTs, { windowS, maxFrames, fps });
    if (win.frames.length === 0) return;
    const payload = buildObservePayload(win, collectFindings(all, findingsFor), biasHintsFor(win));
    ticks++;
    if (await onDecide(payload)) accepted++;
  };
  for await (const f of frames) {
    await consume(f.timestamp);
  }
  // Final partial tick: observe the very tail of the timeline.
  const last = findFrames();
  if (last.length > 0) await consume(last[last.length - 1].ts);
  return { ticks, accepted };
}

/** Collect the per-frame seed context for the window's frame set. */
function collectFindings(
  frames: { ts: number }[],
  findingsFor: (ts: number) => PerFrameSeed | undefined
): Map<number, PerFrameSeed> {
  const m = new Map<number, PerFrameSeed>();
  for (const f of frames) {
    const s = findingsFor(f.ts);
    if (s) m.set(f.ts, s);
  }
  return m;
}

/**
 * On-demand perceive recall path. When a decide verdict for a moment carries a
 * signal that more evidence is needed (`recall`), the server invokes perceive
 * for that moment and bundles the freshly derived context back into a second
 * decide payload. `recallPerceive` is the on-demand perceive call; it must
 * return the derived per-frame findings (or undefined/[] when nothing new). This
 * is the "decide calls perceive before finalizing" path the spec requires.
 *
 * Returns the refreshed payload when recall actually produced new evidence,
 * else the original payload unchanged (so a no-op recall can never regress a
 * decision).
 */
export function applyOnDemandRecall(
  payload: ObserveDecidePayload,
  recall: { centerTs: number; seeds: PerFrameSeed[] } | undefined
): ObserveDecidePayload {
  if (!recall || recall.seeds.length === 0) return payload;
  const byTs = new Map<number, PerFrameSeed>();
  for (const s of payload.seeds) byTs.set(s.ts, s);
  for (const s of recall.seeds) if (s.ts !== undefined) byTs.set(s.ts, s);
  return { ...payload, seeds: payload.frames.map((f) => byTs.get(f.ts) ?? { ts: f.ts }) };
}

/**
 * In-loop observe decider for the VOD detail-first pass. Unlike
 * {@link runObserveLoop} (which owns the frame iteration), this class is driven
 * from the caller's OWN per-frame loop — the caller already calls perceive
 * `client.analyze` per frame to obtain the observation, so this class reuses
 * that (never re-analyzes). `record(ts, imageB64, seed)` stores the frame + its
 * perceive-derived seed context; `maybeFire(ts)` returns the assembled observe
 * payload when a cadence tick is due (else null). The caller then runs the
 * decide + accept path and calls `noteAccepted()` for the cost report.
 *
 * This is the integration seam that keeps decide cadence-driven while letting
 * perceive remain the data seeder (seed context) and on-demand provider.
 */
export class ObserveDecider {
  private readonly frames: { ts: number; imageB64: string }[] = [];
  private readonly findings = new Map<number, PerFrameSeed>();
  private readonly biasHints: ObserveBiasHint[] = [];
  private lastFireTs: number | null = null;
  private readonly cadenceS: number;
  private readonly windowS: number;
  private readonly maxFrames: number;
  private readonly fps: number;
  private readonly signalGate: boolean;
  private readonly signalGateOpts: SignalGateOptions;
  private readonly onDecide: ((payload: ObserveDecidePayload) => Promise<boolean>) | null;
  /** Accumulated per-call decide input-size + accept report. */
  private readonly reportTicks: number[] = [];
  private accepts = 0;
  /** Calls where the max-frames cap forced a subsample (ADAAAA-7007 AC). */
  private subsampledCalls = 0;
  /** Cadence ticks suppressed by the Tier-2 signal gate (ADAAAA-7145). */
  private gatedSkips = 0;
  /** ADAAAA-7694: Stage-A outcome ledger (fed by the VOD audio tap). A decided
   *  window records the verdict for every audio trigger whose onset it covers,
   *  which is the only outcome a trigger has under the observe architecture. */
  private readonly stageA: StageAOutcomeLedger | null;

  constructor(opts: {
    cadenceS?: number;
    windowS?: number;
    maxFrames?: number;
    fps?: number;
    signalGate?: boolean;
    signalGateOpts?: SignalGateOptions;
    onDecide?: (payload: ObserveDecidePayload) => Promise<boolean>;
    /** ADAAAA-7694: Stage-A outcome ledger for the VOD rail. */
    stageA?: StageAOutcomeLedger;
  } = {}) {
    this.cadenceS = opts.cadenceS ?? OBSERVE_CADENCE_S;
    this.windowS = opts.windowS ?? OBSERVE_WINDOW_S;
    this.maxFrames = opts.maxFrames ?? OBSERVE_MAX_FRAMES;
    this.fps = opts.fps ?? OBSERVE_CONTENT_FPS;
    this.signalGate = opts.signalGate ?? false;
    this.signalGateOpts = opts.signalGateOpts ?? {};
    this.onDecide = opts.onDecide ?? null;
    this.stageA = opts.stageA ?? null;
  }

  /** Record a frame + its perceive-derived seed context (no re-inference). */
  record(ts: number, imageB64: string, seed: PerFrameSeed): void {
    this.frames.push({ ts, imageB64 });
    this.findings.set(ts, seed);
    const cutoff = ts - Math.max(this.windowS, 30);
    while (this.frames.length && this.frames[0].ts < cutoff) this.frames.shift();
  }

  /** Add a perceive candidate trigger signal as a per-window bias hint
   * (provenance / metadata — never the on/off switch). `attest` carries the
   * candidate's goal-attestation signals (goalCrossed / ballOutcome /
   * scoreBoardChanged) so the decide goal-attestation gate can attest a
   * `scoring_play` instead of rejecting it (ADAAAA-7021 adverse finding). */
  addHint(eventType: string, ts: number, attest?: { goalCrossed?: boolean; ballOutcome?: string; scoreBoardChanged?: boolean }): void {
    this.biasHints.push({ eventType, ts, ...(attest ?? {}) });
    if (this.biasHints.length > 30) this.biasHints.shift();
  }

  /** Wait for a pending decide to settle before proceeding. */
  async flush(): Promise<void> {
    await this.fire(this.frames[this.frames.length - 1]?.ts ?? 0, true);
  }

  /**
   * Assemble and fire a decide when the cadence is due. Returns true when a
   * decide actually fired. `force` ignores the cadence (used at end-of-stream).
   */
  async maybeFire(currentTs: number, force = false): Promise<boolean> {
    if (!force && !shouldFireObserve(this.lastFireTs, currentTs, this.cadenceS)) return false;
    await this.fire(currentTs, false);
    return true;
  }

  private async fire(currentTs: number, force: boolean): Promise<void> {
    if (this.lastFireTs !== null && !force && currentTs - this.lastFireTs < this.cadenceS - 1e-9) return;
    this.lastFireTs = currentTs;
    const win = assembleObserveWindow(this.frames, currentTs, { windowS: this.windowS, maxFrames: this.maxFrames, fps: this.fps });
    if (win.frames.length === 0) return;
    const lo = currentTs - this.windowS / 2;
    const hi = currentTs + this.windowS / 2;
    const inWindow = this.biasHints.filter((h) => h.ts >= lo && h.ts <= hi);
    const payload = buildObservePayload(win, this.findings, inWindow);
    // ADAAAA-7145: Tier-2 signal gate. When enabled, do NOT spend a billable
    // decide call on a window with no real highlight signal (recall-safe: an
    // unsignaled / uncalibrated window always escalates, so a genuine goal is
    // never starved). Suppressed ticks are counted so the report can show the
    // gate actually cut decide volume.
    if (this.signalGate && !force && !windowHasSignal(payload.seeds, inWindow, this.signalGateOpts)) {
      this.gatedSkips++;
      return;
    }
    this.reportTicks.push(payload.frames.length);
    if (payload.capped) this.subsampledCalls++;
    const accepted = this.onDecide ? await this.onDecide(payload) : undefined;
    if (accepted) this.accepts++;
    // ADAAAA-7694: a decided VOD window judges every Stage-A trigger whose
    // onset falls in its evidence span [lo, hi]; record that verdict so the
    // job persists a MEASURED Stage-A snapshot. A gate-skipped window never
    // reaches here, so its triggers stay pending (unjudged, never a fabricated
    // reject).
    if (accepted !== undefined) this.stageA?.judgeWindow(lo, hi, accepted);
  }

  /** Per-call decide input size (frame count) for the cost report. */
  inputSizeSamples(): number[] {
    return [...this.reportTicks];
  }
  /** Number of decide calls where the max-frames cap forced a subsample
   * (ADAAAA-7007 AC: the <=30-frame cap is exercised — >0 means it was hit). */
  subsampledCallCount(): number {
    return this.subsampledCalls;
  }
  /** Per-job decide spend: number of decide invocations (each 1 billable unit). */
  decideCalls(): number {
    return this.reportTicks.length;
  }
  maxFrameCount(): number {
    return this.reportTicks.reduce((a, b) => Math.max(a, b), 0);
  }
  acceptedCount(): number {
    return this.accepts;
  }
  /** Cadence ticks suppressed by the Tier-2 signal gate (ADAAAA-7145). */
  gatedSkipCount(): number {
    return this.gatedSkips;
  }
}


