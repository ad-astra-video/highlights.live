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
  STAGE_B_FAMILY,
  isStageBTrigger,
  triggerFamily,
  AUDIO_TRIGGER_MAX_STALE_S,
  type AudioTriggerRecord,
  type TriggerSchedulerStats,
} from "./audio-trigger";
import type { StageAOutcomeLedger } from "./stage-a-metrics";
// ADAAAA-7844: provenance type for the measured scoreboard delta carried on a
// window bias hint (defined next to the confirm/attestation types in analyzer).
import type { ScoreboardDeltaEvidence } from "./analyzer";

/** ADAAAA-7723: nearest-rank percentile over an already-sorted sample list.
 *  Shared by the observer's per-family latency stats and the media rail's
 *  per-share evidence line, so both report the same p50/p95 for the same
 *  samples (a share that reconciles must not disagree with itself). */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** ADAAAA-7723 AC-2: onset -> judging-window latency for ONE trigger family.
 *  `samples`/`p50Ms`/`p95Ms` are the ANCHORED windows (the trigger anchored its
 *  own decide); `covered*` are the triggers a decided window judged without
 *  anchoring them; `judged*` pools both. */
export interface TriggerFamilyLatency {
  family: string;
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  coveredSamples: number;
  coveredP50Ms: number;
  coveredP95Ms: number;
  judgedSamples: number;
  judgedP50Ms: number;
  judgedP95Ms: number;
}

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
  /** Ordered (oldest -> newest) frames the decide call carries. `seq` is the
   *  frame's GLOBAL position on the rail when the caller knows it (the media
   *  rail does, ADAAAA-7734), so a decided window's analysis refs can point at
   *  the exact frame file that was in it; absent on rails without a global seq. */
  frames: { ts: number; imageB64: string; seq?: number }[];
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
  frames: { ts: number; imageB64: string; seq?: number }[],
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
  const grid: { ts: number; imageB64: string; seq?: number }[] = [];
  const seenTs = new Set<number>();
  const nearest = (t: number): { ts: number; imageB64: string; seq?: number } | undefined => {
    let best: { ts: number; imageB64: string; seq?: number } | undefined;
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
  frames: { ts: number; imageB64: string; seq?: number }[],
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
  const grid: { ts: number; imageB64: string; seq?: number }[] = [];
  const seenTs = new Set<number>();
  const nearest = (t: number): { ts: number; imageB64: string; seq?: number } | undefined => {
    let best: { ts: number; imageB64: string; seq?: number } | undefined;
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
  /** ADAAAA-7722: the audio trigger this window was ANCHORED on, when the
   * decide was scheduled by a fired trigger rather than the blind cadence.
   * Carries the trigger identity (`stageB/whistle/2.4-3.4k/5x/0.3s`) and its
   * path family (`stageB`), so an anchored window is identifiable as
   * whistle-bearing AFTER the run instead of only inside the in-flight decide
   * payload. Absent on cadence windows. */
  trigger?: {
    thresholdId: string;
    family: string;
    kind: string;
    onsetTs: number;
  };
}

/** ADAAAA-7771: one decide the observer kicked off but has not applied yet.
 *
 *  A live stream's decide costs several cadence periods (~5-8 s wall for 3 s of
 *  content), so a pass that AWAITS each decide can never hold the 3 s cadence:
 *  it falls behind, the lag budget drops most windows as stale, and coverage
 *  collapses to `cadence / decideWall` no matter how much decide capacity the
 *  box has. Keeping K windows in flight fixes coverage without touching the
 *  cadence, the window, the payload or the accept gate.
 *
 *  The two phases are separate because ACCEPTANCE must stay ordered:
 *  - `decide()` is the expensive, side-effect-light half (gemma + on-demand
 *    recall + audit). It may run K-wide.
 *  - `accept()` routes the verdict through the SAME accept gate
 *    (`acceptVideoDecision`: clip cut, burst suppression, highlight record,
 *    billing) and is always called in CONTENT order, one at a time, so the
 *    serial semantics of the accept path are preserved.
 */
export interface StagedObserveDecide {
  /** Run the expensive decide work. Rejects only on a decide failure. */
  decide: () => Promise<void>;
  /** Apply the verdict. Called strictly in content order, never concurrently.
   *  Returns whether the moment was accepted. */
  accept: () => Promise<boolean>;
}

/** ADAAAA-7771: an issued-but-unapplied window in the observer's in-flight
 *  queue. Entries are appended in content order and settled from the head, so
 *  the accept gate sees windows in the order their content occurred even when
 *  a later decide finishes first. */
interface PendingObserveDecide {
  centerTs: number;
  /** Window start used by the Stage-A/B ledgers (`nowTs - windowS`). */
  lo: number;
  lagMs: number;
  cadenceMs: number;
  anchored: boolean;
  /** The audio trigger this window was anchored on (judged in its family). */
  dueTrigger?: AudioTriggerRecord | null;
  /** Frames the decide payload carried (per-call size report). */
  frameCount: number;
  /** Wall clock the decide was issued (E2E is measured from here to settle). */
  startedMs: number;
  /** True once `decide()` resolved or rejected. */
  done: boolean;
  /** Set when `decide()` rejected; the pass rethrows it at flush. */
  error?: unknown;
  /** Resolves once `decide()` finished (never rejects). */
  settled: Promise<void>;
  staged: StagedObserveDecide;
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
  private readonly frames: { ts: number; imageB64: string; seq?: number }[] = [];
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
  private readonly triggers: TriggerWindowScheduler;
  /** ADAAAA-7723: onset -> anchored window latency samples (ms), PER trigger
   *  family, so AC-2 is measurable for the Stage-A roar and the Stage-B whistle
   *  separately instead of as one pooled number. */
  private readonly anchoredLatencyByFamily = new Map<string, number[]>();
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
  /** ADAAAA-7758: windows this job may not decide because ANOTHER live job holds
   * the box's single live decide slot (admission control). Counted separately
   * from stale drops so a queued stream is never mistaken for a lagging one. */
  private admissionSkips = 0;
  /** ADAAAA-7758: content ts of the last counted admission skip, so a refusal
   *  is counted once per cadence WINDOW rather than once per retried frame
   *  (a refused tick leaves the cadence due, so every ~1/3 s frame would
   *  otherwise inflate the counter). */
  private lastAdmissionSkipTs: number | null = null;
  /** ADAAAA-7758: admission predicate (undefined = no arbitration, the shipped
   *  default). False means "no decide slot right now". */
  private readonly canDecide: ((centerTs: number) => boolean) | null;
  /** ADAAAA-7771: how many windows may have their decide work outstanding at
   *  once (1 = the serial pass). */
  private readonly maxInFlight: number;
  /** ADAAAA-7771: two-phase decide fork. Present only when depth > 1; absent
   *  keeps the serial `onDecide` path byte-identical. */
  private readonly onDecideStaged: ((payload: ObserveDecidePayload) => StagedObserveDecide) | null;
  /** ADAAAA-7771: live depth budget (shared decide admission across streams). */
  private readonly depthBudget: (() => number) | null;
  /** ADAAAA-7771: issued-but-unapplied decides, in content order. */
  private pending: PendingObserveDecide[] = [];
  /** ADAAAA-7771: decides whose `decide()` is still running. */
  private inFlight = 0;
  /** ADAAAA-7771: deepest in-flight queue observed (proves the depth was used). */
  private maxInFlightObserved = 0;
  /** ADAAAA-7771: cadence windows NOT issued because all K slots were busy.
   *  Counted once per window (like an admission skip), not once per retried
   *  frame. Distinct from a stale skip: the box had no free slot, the content
   *  was not late. */
  private backpressureSkips = 0;
  private lastBackpressureSkipTs: number | null = null;
  /** ADAAAA-7799 (lever C): decide-rate CAP. Spend is a pure function of decided
   *  windows (`decideCalls * 12 * 0.0033` $/h/stream), so the funded ceiling is
   *  held by KEEPING only a fraction of the decide opportunities instead of
   *  deciding every cadence tick. `1` = off (byte-identical); `0 < r < 1` keeps
   *  a fractional credit per opportunity and decides when the credit crosses 1,
   *  so the realized rate is `r` of the opportunities (r = 0.625 keeps 5 of every
   *  8 windows — a deterministic repeating pattern) and the drops are counted.
   *  The window span and the audio noise-change trigger are NOT touched: a
   *  trigger that comes due on a dropped window stays PENDING (never consumed)
   *  and anchors the next kept window. */
  private readonly decideKeepRatio: number;
  /** ADAAAA-7799: decide opportunities dropped by the rate cap. */
  private throttleSkips = 0;
  /** ADAAAA-7799: decide opportunities seen (kept + dropped). */
  private decideOpportunities = 0;
  /** ADAAAA-7799: content ts of the last counted opportunity. One opportunity
   *  per cadence window: a dropped window leaves a due audio trigger PENDING, and
   *  without this guard the trigger re-presents an opportunity on every
   *  intervening frame (measured on the first cut: 154 opportunities / 300 s
   *  against 97 decides, which re-inflated the rate the cap exists to bound). */
  private lastOpportunityTs: number | null = null;
  /** ADAAAA-7799: fractional decide credit; starts at 1 so the first window of a
   *  stream always decides. */
  private decideCredit = 1;
  /** ADAAAA-7771: serialized accept chain + the first decide/accept failure.
   *  A failure is rethrown by `flush()`, matching the serial pass (which threw
   *  out of the frame loop). */
  private applyChain: Promise<void> = Promise.resolve();
  private applyError: unknown = null;
  /** ADAAAA-7771: the last window ISSUED (content ts + lag), for the
   *  `[live-lag]` evidence line. Separate from `latency`, which lands in
   *  content order at settle time. */
  private lastFired: { centerTs: number; lagMs: number } | null = null;
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
    /** ADAAAA-7771: two-phase decide fork, enabling up to `maxInFlight` windows
     *  whose decide work is outstanding at once. Acceptance is still applied in
     *  CONTENT order, one at a time, so `acceptVideoDecision` keeps its serial
     *  semantics. Absent = the serial `onDecide` path. */
    onDecideStaged?: (payload: ObserveDecidePayload) => StagedObserveDecide;
    /** ADAAAA-7771: bounded in-flight decide depth (default 1 = serial). */
    maxInFlight?: number;
    /** ADAAAA-7771: LIVE depth budget evaluated per fire. Lets the caller SHARE
     *  the box's decide admission across concurrent live streams (a lone stream
     *  gets `maxInFlight`, two streams get half each, and so on) instead of
     *  oversubscribing a fixed-width admission. Clamped to `maxInFlight`. */
    depthBudget?: () => number;
    /** Minimum budget needed to fire early on a trigger (default 0.4). */
    triggerMinBudget?: number;
    /** ADAAAA-7799 (lever C): decide-rate cap. Fraction of decide opportunities
     *  that may decide (0 < r < 1), so the decided-window rate — and therefore
     *  spend — is bounded deterministically. `undefined`/1 = off, byte-identical
     *  to the unbounded pass. Wired from `LIVE_DECIDE_KEEP_RATIO`. */
    decideKeepRatio?: number;
    /** ADAAAA-7758: admission predicate evaluated before this tick spends a
     *  decide. `false` skips the tick (no decide, no latency sample, no budget
     *  token, pending triggers stay pending) and counts an admission skip — the
     *  mechanism that stops a second concurrent live job from starving the
     *  first. Absent (default) = no arbitration. */
    canDecide?: (centerTs: number) => boolean;
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
    this.canDecide = opts.canDecide ?? null;
    this.onDecideStaged = opts.onDecideStaged ?? null;
    this.maxInFlight = Math.max(1, Math.floor(opts.maxInFlight ?? 1));
    this.depthBudget = opts.depthBudget ?? null;
    this.triggerMinBudget = opts.triggerMinBudget ?? 0.4;
    // ADAAAA-7799: normalise the keep ratio. Unset/1/<=0/NaN leaves the pass
    // unbounded, so an unset env is byte-identical.
    const keepRatio = Number(opts.decideKeepRatio ?? 1);
    this.decideKeepRatio = Number.isFinite(keepRatio) && keepRatio > 0 && keepRatio < 1 ? keepRatio : 1;
    this.stageA = opts.stageA ?? null;
    this.stageB = opts.stageB ?? null;
    // ADAAAA-7723: the stale horizon is the FRAME RETENTION horizon, not the
    // bare 8 s default. A trigger whose onset is still inside the retained
    // window can be judged by that window (`coverThrough`), so expiring it
    // first would report a miss for evidence gemma actually saw. Only a trigger
    // older than the retained frames is genuinely unanchorable.
    this.triggers = new TriggerWindowScheduler({ maxStaleS: Math.max(AUDIO_TRIGGER_MAX_STALE_S, this.windowS) });
  }

  /** Record a frame + its perceive-derived seed context (no re-inference).
   *  `seq` (optional) is the frame's global rail position; the media rail passes
   *  it so a decided window can name the exact frame files it saw (ADAAAA-7734). */
  record(ts: number, imageB64: string, seed: PerFrameSeed, seq?: number): void {
    this.frames.push(Number.isFinite(seq) ? { ts, imageB64, seq: Math.floor(seq as number) } : { ts, imageB64 });
    this.findings.set(ts, seed);
    const cutoff = ts - Math.max(this.windowS, OBSERVE_WINDOW_S);
    while (this.frames.length && this.frames[0].ts < cutoff) this.frames.shift();
  }

  /** Fold a perceive candidate trigger into the window as a bias hint
   * (per-window provenance / metadata) — never the on/off switch. A trigger
   * fires a decide candidate only; the observer still runs decide on the
   * cadence regardless of whether a trigger fired (recall not limited by
   * trigger-FP gating). */
  addHint(
    eventType: string,
    ts: number,
    attest?: { goalCrossed?: boolean; ballOutcome?: string; scoreBoardChanged?: boolean; scoreBoardDelta?: ScoreboardDeltaEvidence }
  ): void {
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
    // ADAAAA-7771: settle everything outstanding BEFORE the tail fire so the
    // tail gets a free in-flight slot, and drain again afterwards so the accept
    // gate (and the reported metrics) sees every window the pass decided.
    await this.drainAll();
    const last = this.frames[this.frames.length - 1];
    if (last) await this.fire(last.ts, true, lagMs);
    await this.drainAll();
    // ADAAAA-7723: the tail fire deliberately observes the NEWEST frame and is
    // never anchored, so a trigger still pending now can never anchor a window.
    // Account for it as expired instead of leaving it silently pending.
    this.triggers.expirePending();
    // A decide/accept failure on the pipelined path is rethrown here — the
    // serial path threw out of `fire()` mid-loop, so the run still fails.
    if (this.applyError) {
      const err = this.applyError;
      this.applyError = null;
      throw err;
    }
  }

  // --- ADAAAA-7771: in-flight decide plumbing ------------------------------
  //
  // Windows are ISSUED in content order and APPLIED from the head of the queue,
  // so acceptance stays ordered even when a later decide lands first. The queue
  // is bounded by `maxInFlight`; a full queue is backpressure (the cadence stays
  // due and the next frame retries), never an unbounded backlog.

  /** Queue one staged decide and start its expensive half. */
  private issueStaged(
    payload: ObserveDecidePayload,
    entry: Omit<PendingObserveDecide, "startedMs" | "done" | "staged" | "settled">
  ): void {
    const staged = this.onDecideStaged!(payload);
    const pending: PendingObserveDecide = {
      ...entry,
      startedMs: Date.now(),
      done: false,
      settled: Promise.resolve(),
      staged,
    };
    this.pending.push(pending);
    this.inFlight++;
    if (this.inFlight > this.maxInFlightObserved) this.maxInFlightObserved = this.inFlight;
    pending.settled = staged
      .decide()
      .then(
        () => {
          pending.done = true;
        },
        (err) => {
          pending.done = true;
          pending.error = err;
        }
      )
      .finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.scheduleDrain();
      });
  }

  private scheduleDrain(): void {
    this.applyChain = this.applyChain
      .then(() => this.drainReady())
      .catch((err) => {
        if (!this.applyError) this.applyError = err;
      });
  }

  /** Apply every ready entry from the head, in content order, one at a time. */
  private async drainReady(): Promise<void> {
    while (this.pending.length && this.pending[0].done) {
      const head = this.pending[0];
      if (head.error) {
        // A failed decide aborts the pass (the serial path threw here too).
        // Later windows are NOT applied: accepting them would publish
        // highlights past a decision the pass never made.
        this.applyError = head.error;
        this.pending.shift();
        return;
      }
      this.pending.shift();
      await this.applyEntry(head);
    }
  }

  private async applyEntry(entry: PendingObserveDecide): Promise<void> {
    const e2eMs = Date.now() - entry.startedMs;
    const accepted = await entry.staged.accept();
    this.recordOutcome({ ...entry, accepted, e2eMs });
  }

  /** Await every outstanding decide and apply it in content order. */
  private async drainAll(): Promise<void> {
    for (;;) {
      await this.applyChain;
      if (this.applyError || this.pending.length === 0) break;
      // Nothing more is READY yet: wait for the head alone (content order).
      await this.pending[0].settled;
    }
    // Anything queued behind a failed head is discarded, never applied.
    if (this.applyError) this.pending = [];
  }

  /** Write one window's verdict into the accept counters, the Stage-A/B ledgers
   *  and the latency samples. Runs strictly in content order. */
  private recordOutcome(r: {
    centerTs: number;
    lo: number;
    lagMs: number;
    cadenceMs: number;
    anchored: boolean;
    dueTrigger?: AudioTriggerRecord | null;
    frameCount: number;
    accepted: boolean;
    e2eMs: number;
  }): void {
    if (r.accepted) this.accepts++;
    const dueTrigger = r.dueTrigger ?? null;
    // ADAAAA-7694: this decided window IS the judgement of every Stage-A
    // trigger whose onset it covers.
    if (this.stageA || this.stageB) {
      if (r.anchored && dueTrigger) {
        if (isStageBTrigger(dueTrigger.thresholdId)) this.stageB?.judgeTrigger(dueTrigger, r.accepted);
        else this.stageA?.judgeTrigger(dueTrigger, r.accepted);
      }
      this.stageA?.judgeWindow(r.lo, r.centerTs, r.accepted);
      this.stageB?.judgeWindow(r.lo, r.centerTs, r.accepted);
    }
    this.latency.push({
      centerTs: r.centerTs,
      frameCount: r.frameCount,
      e2eMs: r.e2eMs,
      cadenceMs: r.cadenceMs,
      lagMs: r.lagMs,
      completedLagMs: r.lagMs + r.e2eMs,
      // ADAAAA-7722: persist the anchoring trigger's identity on the window
      // record, so a whistle-anchored decide is readable by family post-run.
      ...(r.anchored && dueTrigger
        ? {
            trigger: {
              thresholdId: dueTrigger.thresholdId,
              family: triggerFamily(dueTrigger.thresholdId),
              kind: dueTrigger.kind,
              onsetTs: dueTrigger.onsetTs,
            },
          }
        : {}),
    });
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

  /** ADAAAA-7758: windows skipped because another live job held the decide
   *  slot (admission control). Never counted as a stale/lag skip. */
  admissionSkipCount(): number {
    return this.admissionSkips;
  }
  /** ADAAAA-7771: decide calls outstanding right now (0 when idle). */
  inFlightDepth(): number {
    return this.inFlight;
  }
  /** ADAAAA-7771: deepest in-flight queue observed — proves the pipelined depth
   *  was actually used on the run (1 = serial, K = pipelined). */
  maxInFlightDepth(): number {
    return this.maxInFlightObserved;
  }
  /** ADAAAA-7771: windows not issued because the in-flight queue was full. */
  backpressureSkipCount(): number {
    return this.backpressureSkips;
  }
  /** ADAAAA-7799: decide opportunities the rate cap dropped (fixed stride). */
  throttleSkipCount(): number {
    return this.throttleSkips;
  }
  /** ADAAAA-7771: the last window ISSUED (content ts + measured lag), for the
   *  `[live-lag]` evidence line. Independent of the settle ordering. */
  lastFiredWindow(): { centerTs: number; lagMs: number } | null {
    return this.lastFired ? { ...this.lastFired } : null;
  }
  /** ADAAAA-7771: windows issued but not yet applied (drained by `flush`). */
  pendingApplyCount(): number {
    return this.pending.length;
  }
  /** ADAAAA-7771: the in-flight depth this pass may use right now (the shared
   *  decide budget clamped to `maxInFlight`; 1 = serial). */
  currentDepthBudget(): number {
    return this.effectiveDepth();
  }
  private effectiveDepth(): number {
    const raw = this.depthBudget ? this.depthBudget() : this.maxInFlight;
    const d = Math.floor(Number.isFinite(raw) ? raw : 1);
    return Math.max(1, Math.min(this.maxInFlight, d));
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
    // ADAAAA-7771: bounded in-flight depth. When all K decide slots are busy
    // this tick is NOT decided and the cadence stays due, so the very next
    // frame retries as soon as a slot frees. Backpressure is bounded by K (never
    // an unbounded backlog) and the lag budget still drops content that falls
    // behind, so a depth that breaches the budget self-corrects. Counted once
    // per cadence window (not once per retried frame) and kept distinct from a
    // stale skip: the content was not late, the box had no free slot. A FORCE
    // fire (the end-of-stream tail) bypasses this — `flush()` drains first.
    if (this.onDecideStaged && !force && this.inFlight >= this.effectiveDepth()) {
      if (this.lastBackpressureSkipTs === null || nowTs - this.lastBackpressureSkipTs >= this.cadenceS - 1e-9) {
        this.backpressureSkips++;
        this.lastBackpressureSkipTs = nowTs;
      }
      return;
    }
    // ADAAAA-7723: assemble the window BEFORE consuming the trigger or spending
    // the budget token. A tick that cannot assemble a window has nothing to
    // decide, so it must leave the trigger pending for the next affordable tick
    // — the previous order consumed first and `return`ed on an empty window,
    // counting the trigger `fired` while issuing no decide at all.
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
    //
    // ADAAAA-7723: a skipped window judges NOTHING, so it must not cover the
    // pending triggers inside it — they stay pending and are anchored (or
    // covered) by a window that actually reaches gemma.
    if (this.signalGate && !force && !anchored && !windowHasSignal(payload.seeds, inWindow, this.signalGateOpts)) {
      this.gatedSkips++;
      this.lastFireTs = nowTs;
      return;
    }
    // ADAAAA-7758: admission control. When another live job holds the box's
    // single live decide slot this tick is SKIPPED — no decide call, no latency
    // sample (a refused decide must never look like a fast one and shrink the
    // lag reserve), no budget token spent, and any anchored trigger stays
    // pending for the tick that actually gets the slot. `lastFireTs` is NOT
    // advanced: nothing was decided, so the cadence stays due and the very next
    // frame can take the slot the moment it frees up.
    if (this.canDecide && !this.canDecide(nowTs)) {
      // Count ONE skip per cadence window refused, not one per retried frame:
      // `lastFireTs` stays put, so the cadence keeps being due while the slot is
      // held elsewhere and every frame would re-ask.
      if (this.lastAdmissionSkipTs === null || nowTs - this.lastAdmissionSkipTs >= this.cadenceS - 1e-9) {
        this.admissionSkips++;
        this.lastAdmissionSkipTs = nowTs;
      }
      return;
    }
    // ADAAAA-7799 (lever C): decide-rate CAP. An opportunity that would
    // otherwise decide now is DROPPED when the fractional credit has not yet
    // crossed 1: the cadence advances past the window (`lastFireTs` moves, so it
    // is not retried frame by frame), no budget token is spent, and a due audio
    // trigger is NOT consumed — it stays pending and anchors the next kept
    // window (the trigger contract and the window span are untouched; only the
    // decide slot rate is capped). The pattern is deterministic (credit accrues
    // `r` per opportunity, so at 0.625 exactly 5 of every 8 windows decide, and
    // at 2/3 two of every three), and every drop is counted. A FORCE fire (the
    // end-of-stream tail) always decides: dropping it would lose the tail window.
    if (this.decideKeepRatio < 1 && !force) {
      if (this.lastOpportunityTs !== null && nowTs - this.lastOpportunityTs < this.cadenceS - 1e-9) {
        return;
      }
      this.lastOpportunityTs = nowTs;
      this.decideOpportunities++;
      this.decideCredit += this.decideKeepRatio;
      if (this.decideCredit < 1 - 1e-9) {
        this.throttleSkips++;
        this.lastFireTs = nowTs;
        return;
      }
      this.decideCredit -= 1;
    }
    if (anchored) this.triggers.consume(dueTrigger);
    const prevFire = this.lastFireTs;
    this.lastFireTs = nowTs;
    // The interval this decide covers is not a queued window: only refusals
    // after this moment count as admission skips.
    this.lastAdmissionSkipTs = nowTs;
    this.budgetTokens -= 1;
    const cadenceMs = prevFire === null ? 0 : (nowTs - prevFire) * 1000;
    if (anchored) this.anchoredFires++;
    else this.cadenceFires++;
    // ADAAAA-7707: the whistle share numerator — windows a whistle anchored.
    if (anchored && dueTrigger && isStageBTrigger(dueTrigger.thresholdId)) this.whistleAnchoredFires++;
    // ADAAAA-7723 AC-2: measure the anchored window's onset->window latency in
    // the trigger's OWN family (a pooled number hides the whistle path).
    if (anchored && dueTrigger) {
      const family = triggerFamily(dueTrigger.thresholdId);
      const latMs = Math.max(0, Math.round((nowTs - dueTrigger.onsetTs) * 1000));
      const samples = this.anchoredLatencyByFamily.get(family);
      if (samples) samples.push(latMs);
      else this.anchoredLatencyByFamily.set(family, [latMs]);
    }
    // Triggers already inside the window just analyzed are covered by it.
    this.triggers.coverThrough(lo, nowTs);
    const lag = lagMs ?? 0;
    this.lastFired = { centerTs: nowTs, lagMs: lag };
    if (this.onDecideStaged) {
      // ADAAAA-7771: issue the decide and return immediately. The expensive
      // half runs K-wide; the verdict is applied in content order by the drain
      // chain (`accept` -> acceptVideoDecision), so the accept path keeps its
      // serial semantics while the cadence keeps up.
      //
      // ADAAAA-7878: at a depth budget of 1 (the crowded-box fallback) the pair
      // is ALSO issued and not awaited. The backpressure gate above already
      // refuses a tick while that one decide is in flight, so at most one decide
      // is outstanding — but the ingest loop keeps consuming frames instead of
      // stalling on gemma for the whole E2E (which is what the serial pass did).
      // A depth-1 inline await is exactly the stall this task removes; the
      // flag-off path keeps it by using `onDecide` instead of the staged fork.
      this.issueStaged(payload, {
        centerTs: nowTs,
        lo,
        lagMs: lag,
        cadenceMs,
        anchored,
        dueTrigger: anchored ? dueTrigger : null,
        frameCount: payload.frames.length,
      });
      return;
    }
    if (this.onDecide) {
      const started = Date.now();
      const accepted = await this.onDecide(payload);
      // ADAAAA-7694/7707: the verdict is written into the counters, the
      // Stage-A/B ledgers and the latency samples by `recordOutcome`, which the
      // pipelined path calls in content order at settle time.
      this.recordOutcome({
        centerTs: nowTs,
        lo,
        lagMs: lag,
        cadenceMs,
        anchored,
        dueTrigger: anchored ? dueTrigger : null,
        frameCount: payload.frames.length,
        accepted,
        e2eMs: Date.now() - started,
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
  /** ADAAAA-7722: the whistle-anchored window RECORDS (content ts + trigger
   *  identity), so the family is readable after the run from the persisted
   *  `observeMetrics.whistleWindows` instead of only from the in-flight decide
   *  payload. Bounded by construction: one entry per whistle-anchored decide,
   *  and a live run's decide count is cadence-bounded. */
  whistleWindows(): { centerTs: number; thresholdId: string; family: string }[] {
    return this.latency
      .filter((s) => s.trigger && s.trigger.family === STAGE_B_FAMILY)
      .map((s) => ({ centerTs: s.centerTs, thresholdId: s.trigger!.thresholdId, family: s.trigger!.family }));
  }
  /** ADAAAA-7722: decide windows NOT anchored on a whistle trigger — the
   *  crowding complement (`allDecides = whistleDecides + nonWhistleDecides`). */
  nonWhistleDecideCount(): number {
    return Math.max(0, this.latency.length - this.whistleAnchoredFires);
  }
  /** ADAAAA-7658: trigger scheduler bookkeeping (accepted / coalesced /
   *  covered / expired / fired). */
  triggerStats(): TriggerSchedulerStats {
    return this.triggers.stats();
  }
  /** ADAAAA-7723 AC-1: the reconciliation invariant — every accepted trigger is
   *  accounted for (fired / covered / expired / pending). */
  triggerReconciliation(): { ok: boolean; unaccounted: number } {
    return this.triggers.reconciled();
  }
  /** ADAAAA-7723 AC-2: onset -> judging-window latency, measured PER trigger
   *  family (Stage-A roar vs Stage-B whistle). Two ways a trigger gets judged:
   *  it ANCHORS its own window (`samples`/`p50Ms`/`p95Ms`), or a decided window
   *  COVERS its onset (`coveredSamples`/`coveredP50Ms`/`coveredP95Ms`). The
   *  `judged*` fields pool both — the pool is what "onset -> gemma saw it"
   *  means. A family with no judged trigger still appears with zero samples, so
   *  a missing path is visible instead of implied healthy by an absent row. */
  anchoredLatencyByFamilyStats(): TriggerFamilyLatency[] {
    const covered = new Map(this.triggers.coveredLatencyStats().map((c) => [c.family, c.samples] as const));
    const families = new Set([...this.anchoredLatencyByFamily.keys(), ...covered.keys()]);
    return [...families]
      .map((family) => {
        const anchoredSorted = [...(this.anchoredLatencyByFamily.get(family) ?? [])].sort((a, b) => a - b);
        const coveredSorted = [...(covered.get(family) ?? [])].sort((a, b) => a - b);
        const judgedSorted = [...anchoredSorted, ...coveredSorted].sort((a, b) => a - b);
        return {
          family,
          samples: anchoredSorted.length,
          p50Ms: percentile(anchoredSorted, 50),
          p95Ms: percentile(anchoredSorted, 95),
          maxMs: anchoredSorted.length ? anchoredSorted[anchoredSorted.length - 1] : 0,
          coveredSamples: coveredSorted.length,
          coveredP50Ms: percentile(coveredSorted, 50),
          coveredP95Ms: percentile(coveredSorted, 95),
          judgedSamples: judgedSorted.length,
          judgedP50Ms: percentile(judgedSorted, 50),
          judgedP95Ms: percentile(judgedSorted, 95),
        };
      })
      .sort((a, b) => a.family.localeCompare(b.family));
  }
  /** ADAAAA-7723 AC-2: every latency sample pooled across families — anchored
   *  samples from the observer plus covered samples from the scheduler. */
  anchoredLatencySamples(): number[] {
    return [...this.anchoredLatencyByFamily.values()].flat();
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
  /** `seq` (when present) is the frame's global rail position — the media rail
   *  stamps it so the decided window's `analysis.frames[].uri` can resolve to
   *  the exact frame file (ADAAAA-7734). */
  frames: { ts: number; imageB64: string; seq?: number }[];
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
  /** ADAAAA-7844: the measured, legible scoreboard delta behind
   * `scoreBoardChanged` (both sides parsed, >= 2 OCR samples each, time-tied).
   * Absent when perceive did not measure one — the decide pass then refuses to
   * label the corroboration "scoreboard". */
  scoreBoardDelta?: ScoreboardDeltaEvidence;
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

/** ADAAAA-7878: an issued-but-unapplied VOD window. Entries are appended in
 *  content order and applied from the head, so acceptance stays ordered even
 *  when a later decide lands first. */
interface PendingVodDecide {
  /** Content time the window was observed at (evidence line + payload centre). */
  centerTs: number;
  /** Evidence span start/end for the Stage-A/B ledgers. */
  lo: number;
  hi: number;
  /** Frames the decide payload carried (per-call size report). */
  frameCount: number;
  /** Wall clock the decide was issued (E2E is measured from here to settle). */
  startedMs: number;
  /** True once `decide()` resolved or rejected. */
  done: boolean;
  /** Set when `decide()` rejected; the pass rethrows it at flush. */
  error?: unknown;
  /** Resolves once `decide()` finished (never rejects). */
  settled: Promise<void>;
  staged: StagedObserveDecide;
}

/** ADAAAA-7878: one decided window's ingest continuity. Measured by
 *  {@link IngestGapTracker}: how many `client.analyze` calls started while the
 *  decide was in flight, and the largest gap between consecutive starts. */
export interface IngestGapSample {
  centerTs: number;
  decideE2eMs: number;
  framesConsumedDuringDecide: number;
  maxIngestGapMs: number;
  p95IngestGapMs: number;
}

/**
 * ADAAAA-7878: prove that the frame-CONSUME loop keeps running while a decide
 * is in flight.
 *
 * The loop stamps the start of every `client.analyze` call ({@link noteAnalyze});
 * when a decided window settles, {@link recordWindow} reports the analyze calls
 * that started inside the decide span and the largest gap between consecutive
 * starts. Pre-fix (decide awaited inside the loop) the span holds ZERO analyze
 * calls and its single gap equals the decide E2E, so the same `[ingest-gap]`
 * line is the before/after evidence for both runs.
 */
export class IngestGapTracker {
  private readonly starts: number[] = [];
  private readonly jobId: string;
  private readonly framePeriodMs: number;
  private readonly log: (line: string) => void;
  /** Every window measured on this pass (kept for the job record / tests). */
  readonly samples: IngestGapSample[] = [];

  constructor(opts: { jobId: string; framePeriodMs?: number; log?: (line: string) => void }) {
    this.jobId = opts.jobId;
    this.framePeriodMs = opts.framePeriodMs && opts.framePeriodMs > 0 ? opts.framePeriodMs : 0;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  /** Stamp the START of one `client.analyze` call — the ingest pulse. */
  noteAnalyze(ms = Date.now()): void {
    this.starts.push(ms);
    if (this.starts.length > 4096) this.starts.splice(0, this.starts.length - 4096);
  }

  /** Close one decided window and print its ingest-continuity evidence line. */
  recordWindow(w: { centerTs: number; startedMs: number; endedMs: number }): IngestGapSample {
    const e2eMs = Math.max(0, Math.round(w.endedMs - w.startedMs));
    let prev: number | undefined;
    const span: number[] = [];
    for (const t of this.starts) {
      // Strict at both ends: an analyze stamped at the settle millisecond resumed
      // AFTER the verdict, so counting it would overstate the overlap.
      if (t <= w.startedMs) prev = t;
      else if (t < w.endedMs) span.push(t);
    }
    const gaps: number[] = [];
    let last = prev;
    for (const t of span) {
      if (last !== undefined) gaps.push(t - last);
      last = t;
    }
    // No analyze STARTED inside the span: the loop was stalled for the whole
    // decide, which IS the pre-fix signature (one gap == the decide E2E).
    if (span.length === 0) gaps.push(w.endedMs - (prev ?? w.startedMs));
    const sorted = [...gaps].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] : 0;
    const sample: IngestGapSample = {
      centerTs: w.centerTs,
      decideE2eMs: e2eMs,
      framesConsumedDuringDecide: span.length,
      maxIngestGapMs: Math.round(sorted.length ? sorted[sorted.length - 1] : 0),
      p95IngestGapMs: Math.round(p95),
    };
    this.samples.push(sample);
    const period = this.framePeriodMs ? ` framePeriodMs=${Math.round(this.framePeriodMs)}` : "";
    this.log(
      `[ingest-gap:${this.jobId}] decide @${w.centerTs.toFixed(2)}s decideE2eMs=${sample.decideE2eMs} ` +
        `framesConsumedDuringDecide=${sample.framesConsumedDuringDecide} maxIngestGapMs=${sample.maxIngestGapMs} ` +
        `p95IngestGapMs=${sample.p95IngestGapMs}${period}`
    );
    return sample;
  }
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
  /** `seq` is the frame's global rail position when the caller knows it (the
   *  VOD rail's extracted inventory position, ADAAAA-7736); absent otherwise. */
  private readonly frames: { ts: number; imageB64: string; seq?: number }[] = [];
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
  /** ADAAAA-7722: Stage-B (whistle) ledger for the VOD rail. Whistle triggers
   *  live here, so a whistle window is judged in its OWN family ledger and the
   *  Stage-A snapshot is byte-identical to a run without it. */
  private readonly stageB: StageAOutcomeLedger | null;
  /** ADAAAA-7906 (VOD resume): window-applied hook (cursor advance). */
  private readonly onApplied: ((centerTs: number) => void) | null;
  /** ADAAAA-7878: two-phase decide fork. Present by default so the frame-consume
   *  loop ISSUES a window and returns while gemma judges it; absent keeps the
   *  serial `onDecide` path (the flag-off behaviour, byte-identical to pre-7878). */
  private readonly onDecideStaged: ((payload: ObserveDecidePayload) => StagedObserveDecide) | null;
  /** ADAAAA-7878: how many decide calls may run at once. Default 1 — the decide
   *  CONCURRENCY is deliberately unchanged (that lever is ADAAAA-7773/7771
   *  territory); what changes is only that the ingest loop no longer waits. */
  private readonly maxInFlight: number;
  /** ADAAAA-7878: hard bound on queued-but-unapplied windows. The queue grows
   *  whenever decide is slower than the cadence — normal for a batch VOD pass —
   *  so the cap makes the backlog explicitly BOUNDED, and a refused window is
   *  counted (`queueFullSkips`) instead of silently piling up. Pending payloads
   *  share their frame strings with the window buffer, so the bound costs
   *  references, not image copies. */
  private readonly maxPending: number;
  /** ADAAAA-7878: issued-but-unapplied windows, in content order. */
  private pending: PendingVodDecide[] = [];
  /** ADAAAA-7878: decides whose `decide()` is still running. */
  private inFlight = 0;
  /** ADAAAA-7878: deepest in-flight depth observed (proves the depth was used). */
  private maxInFlightSeen = 0;
  /** ADAAAA-7878: cadence windows NOT issued because the pending queue was full.
   *  Distinct from a gate skip: the content had a signal and was due, the pass had
   *  no bounded queue room for it. */
  private queueFullSkips = 0;
  /** ADAAAA-7878: serialized accept chain + the first decide/accept failure. */
  private applyChain: Promise<void> = Promise.resolve();
  private applyError: unknown = null;

  constructor(opts: {
    cadenceS?: number;
    windowS?: number;
    maxFrames?: number;
    fps?: number;
    signalGate?: boolean;
    signalGateOpts?: SignalGateOptions;
    onDecide?: (payload: ObserveDecidePayload) => Promise<boolean>;
    /** ADAAAA-7878: two-phase decide fork — the frame loop issues a window and
     *  returns while gemma judges it, and the verdict is applied in CONTENT
     *  order (`acceptVideoDecision` keeps its serial semantics). Absent = the
     *  serial `onDecide` path. */
    onDecideStaged?: (payload: ObserveDecidePayload) => StagedObserveDecide;
    /** ADAAAA-7878: concurrent decide depth (default 1 = the decide rate is
     *  unchanged; only the ingest stall is removed). */
    maxInFlight?: number;
    /** ADAAAA-7878: bounded pending-window queue (default 512). */
    maxPending?: number;
    /** ADAAAA-7694: Stage-A outcome ledger for the VOD rail. */
    stageA?: StageAOutcomeLedger;
    /** ADAAAA-7722: Stage-B (whistle) outcome ledger for the VOD rail. */
    stageB?: StageAOutcomeLedger;
    /** ADAAAA-7906 (VOD resume): content timestamp (seconds) to START the
     *  cadence clock at. A resumed pass seeds this with the persisted cursor, so
     *  the observer never fires a window whose centre is <= the cursor (the
     *  first fire lands one cadence after it). Absent = fire on the first frame. */
    startTs?: number;
    /** ADAAAA-7906 (VOD resume): fires with the centre timestamp of every window
     *  whose verdict was APPLIED, in content order. The caller advances the
     *  persisted cursor from this (never from an issued-but-unapplied window).
     *  Must not throw — the accept chain treats a throwing hook as a failure. */
    onApplied?: (centerTs: number) => void;
  } = {}) {
    this.cadenceS = opts.cadenceS ?? OBSERVE_CADENCE_S;
    this.windowS = opts.windowS ?? OBSERVE_WINDOW_S;
    this.maxFrames = opts.maxFrames ?? OBSERVE_MAX_FRAMES;
    this.fps = opts.fps ?? OBSERVE_CONTENT_FPS;
    this.signalGate = opts.signalGate ?? false;
    this.signalGateOpts = opts.signalGateOpts ?? {};
    this.onDecide = opts.onDecide ?? null;
    this.onDecideStaged = opts.onDecideStaged ?? null;
    this.maxInFlight = Math.max(1, Math.floor(opts.maxInFlight ?? 1));
    this.maxPending = Math.max(1, Math.floor(opts.maxPending ?? 512));
    this.stageA = opts.stageA ?? null;
    this.stageB = opts.stageB ?? null;
    this.onApplied = opts.onApplied ?? null;
    // ADAAAA-7906: a resumed pass seeds the cadence clock at the persisted
    // cursor, so the first decide window's centre is strictly after it.
    if (typeof opts.startTs === "number" && Number.isFinite(opts.startTs)) {
      this.lastFireTs = opts.startTs;
    }
  }

  /** Record a frame + its perceive-derived seed context (no re-inference).
   *  `seq` (optional) is the frame's global rail position — the frame file's
   *  position on disk. The VOD rail passes it (its extracted inventory IS
   *  `frame_%06d.jpg`, sorted position == seq) so a decided window can name the
   *  exact frame files it saw in the decide note (ADAAAA-7736). */
  record(ts: number, imageB64: string, seed: PerFrameSeed, seq?: number): void {
    this.frames.push(Number.isFinite(seq) ? { ts, imageB64, seq: Math.floor(seq as number) } : { ts, imageB64 });
    this.findings.set(ts, seed);
    const cutoff = ts - Math.max(this.windowS, 30);
    while (this.frames.length && this.frames[0].ts < cutoff) this.frames.shift();
  }

  /** Add a perceive candidate trigger signal as a per-window bias hint
   * (provenance / metadata — never the on/off switch). `attest` carries the
   * candidate's goal-attestation signals (goalCrossed / ballOutcome /
   * scoreBoardChanged) so the decide goal-attestation gate can attest a
   * `scoring_play` instead of rejecting it (ADAAAA-7021 adverse finding). */
  addHint(
    eventType: string,
    ts: number,
    attest?: { goalCrossed?: boolean; ballOutcome?: string; scoreBoardChanged?: boolean; scoreBoardDelta?: ScoreboardDeltaEvidence }
  ): void {
    this.biasHints.push({ eventType, ts, ...(attest ?? {}) });
    if (this.biasHints.length > 30) this.biasHints.shift();
  }

  /** Wait for outstanding decides to settle, then fire the end-of-stream tail
   *  and settle that too, before returning. */
  async flush(): Promise<void> {
    // ADAAAA-7878: settle everything outstanding BEFORE the tail fire so the tail
    // gets a free in-flight slot, then drain again afterwards so the accept gate
    // (and the reported metrics) sees every window the pass decided.
    await this.drainAll();
    await this.fire(this.frames[this.frames.length - 1]?.ts ?? 0, true);
    await this.drainAll();
    // A decide/accept failure on the pipelined path is rethrown here — the serial
    // path threw out of `fire()` mid-loop, so the run still fails the same way.
    if (this.applyError) {
      const err = this.applyError;
      this.applyError = null;
      throw err;
    }
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
    if (this.onDecideStaged) {
      if (this.pending.length >= this.maxPending) {
        // Bounded backlog: this window is NOT decided (counted, never an
        // unbounded queue) and the ingest loop is never blocked on the queue.
        // It is NOT counted as a decide call — nothing was billed.
        this.queueFullSkips++;
        return;
      }
      this.reportTicks.push(payload.frames.length);
      if (payload.capped) this.subsampledCalls++;
      this.issueStaged(payload, { centerTs: currentTs, lo, hi, frameCount: payload.frames.length });
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
    if (accepted !== undefined) {
      this.stageA?.judgeWindow(lo, hi, accepted);
      // ADAAAA-7722: whistle triggers are judged in their own ledger — never in
      // the Stage-A one (which holds only `stageA/*` onsets by construction).
      this.stageB?.judgeWindow(lo, hi, accepted);
      // ADAAAA-7906 (VOD resume): the serial path applied this window's verdict
      // inline, so its centre is a legal resume cursor.
      if (this.onApplied) {
        try {
          this.onApplied(currentTs);
        } catch {
          /* evidence only */
        }
      }
    }
  }

  // --- ADAAAA-7878: off-loop decide plumbing --------------------------------
  //
  // Windows are ISSUED in content order by the frame loop and APPLIED from the
  // head of the queue, so acceptance stays ordered even when a later decide
  // lands first. `maxInFlight` bounds the decide work (default 1: the decide
  // rate and concurrency are unchanged) and `maxPending` bounds the backlog
  // (a refusal is counted, never an unbounded queue).

  /** Queue one staged decide and start its expensive half. */
  private issueStaged(
    payload: ObserveDecidePayload,
    span: { centerTs: number; lo: number; hi: number; frameCount: number }
  ): void {
    const staged = this.onDecideStaged!(payload);
    const pending: PendingVodDecide = {
      ...span,
      startedMs: Date.now(),
      done: false,
      settled: Promise.resolve(),
      staged,
    };
    this.pending.push(pending);
    this.inFlight++;
    if (this.inFlight > this.maxInFlightSeen) this.maxInFlightSeen = this.inFlight;
    pending.settled = staged
      .decide()
      .then(
        () => {
          pending.done = true;
        },
        (err) => {
          pending.done = true;
          pending.error = err;
        }
      )
      .finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.scheduleDrain();
      });
  }

  private scheduleDrain(): void {
    this.applyChain = this.applyChain
      .then(() => this.drainReady())
      .catch((err) => {
        if (!this.applyError) this.applyError = err;
      });
  }

  /** Apply every ready entry from the head, in content order, one at a time. */
  private async drainReady(): Promise<void> {
    while (this.pending.length && this.pending[0].done) {
      const head = this.pending[0];
      if (head.error) {
        // A failed decide aborts the pass (the serial path threw here too).
        // Later windows are NOT applied: accepting them would publish highlights
        // past a decision the pass never made.
        this.applyError = head.error;
        this.pending.shift();
        return;
      }
      this.pending.shift();
      const accepted = await head.staged.accept();
      if (accepted) this.accepts++;
      // ADAAAA-7694/7722: the decided window judges every Stage-A/B trigger whose
      // onset falls in its evidence span — in CONTENT order, so the ledger is
      // identical to the serial pass.
      this.stageA?.judgeWindow(head.lo, head.hi, accepted);
      this.stageB?.judgeWindow(head.lo, head.hi, accepted);
      // ADAAAA-7906 (VOD resume): this window's verdict has been APPLIED, so its
      // centre is a legal resume cursor. A failed/aborted head never reaches
      // here (the branch above returns), so the cursor can never name a window
      // the pass did not judge.
      if (this.onApplied) {
        try {
          this.onApplied(head.centerTs);
        } catch {
          /* evidence only — a cursor write must never break the accept chain */
        }
      }
    }
  }

  /** Await every outstanding decide and apply it in content order. */
  private async drainAll(): Promise<void> {
    for (;;) {
      await this.applyChain;
      if (this.applyError || this.pending.length === 0) break;
      // Nothing more is READY yet: wait for the head alone (content order).
      await this.pending[0].settled;
    }
    // Anything queued behind a failed head is discarded, never applied.
    if (this.applyError) this.pending = [];
  }

  /** ADAAAA-7878: windows issued but not yet applied (drained by `flush`). */
  pendingApplyCount(): number {
    return this.pending.length;
  }
  /** ADAAAA-7878: decides whose `decide()` is still running. */
  decideInFlightDepth(): number {
    return this.inFlight;
  }
  /** ADAAAA-7878: deepest decide depth observed (0 = the serial path ran). */
  maxDecideInFlight(): number {
    return this.maxInFlightSeen;
  }
  /** ADAAAA-7878: windows dropped because the bounded queue was full. */
  queueFullSkipCount(): number {
    return this.queueFullSkips;
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


