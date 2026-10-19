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
  private readonly onDecide: ((payload: ObserveDecidePayload) => Promise<boolean>) | null;
  private readonly latency: LiveObserveLatencySample[] = [];
  private accepts = 0;

  constructor(opts: {
    cadenceS?: number;
    windowS?: number;
    maxFrames?: number;
    fps?: number;
    onDecide?: (payload: ObserveDecidePayload) => Promise<boolean>;
  } = {}) {
    this.cadenceS = opts.cadenceS ?? OBSERVE_CADENCE_S;
    this.windowS = opts.windowS ?? LIVE_OBSERVE_WINDOW_S;
    this.maxFrames = opts.maxFrames ?? LIVE_OBSERVE_MAX_FRAMES;
    this.fps = opts.fps ?? OBSERVE_CONTENT_FPS;
    this.onDecide = opts.onDecide ?? null;
  }

  /** Record a frame + its perceive-derived seed context (no re-inference). */
  record(ts: number, imageB64: string, seed: PerFrameSeed): void {
    this.frames.push({ ts, imageB64 });
    this.findings.set(ts, seed);
    const cutoff = ts - Math.max(this.windowS, OBSERVE_WINDOW_S);
    while (this.frames.length && this.frames[0].ts < cutoff) this.frames.shift();
  }

  /** Fire a rolling-past decide when the cadence is due. `force` ignores the
   * cadence (used at end-of-stream to observe the tail). */
  async maybeFire(nowTs: number, force = false): Promise<boolean> {
    await this.fire(nowTs, force);
    return this.lastFireTs === nowTs;
  }

  /** Force one final observation at end-of-stream. */
  async flush(): Promise<void> {
    const last = this.frames[this.frames.length - 1];
    if (last) await this.fire(last.ts, true);
  }

  private async fire(nowTs: number, force: boolean): Promise<void> {
    if (!force && !shouldFireObserve(this.lastFireTs, nowTs, this.cadenceS)) return;
    const prevFire = this.lastFireTs;
    this.lastFireTs = nowTs;
    const win = assembleLiveWindow(this.frames, nowTs, { windowS: this.windowS, maxFrames: this.maxFrames, fps: this.fps });
    if (win.frames.length === 0) return;
    const payload = buildObservePayload(win, this.findings, []);
    const cadenceMs = prevFire === null ? 0 : (nowTs - prevFire) * 1000;
    let e2eMs = 0;
    if (this.onDecide) {
      const started = Date.now();
      const accepted = await this.onDecide(payload);
      e2eMs = Date.now() - started;
      if (accepted) this.accepts++;
      this.latency.push({ centerTs: nowTs, frameCount: payload.frames.length, e2eMs, cadenceMs });
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
}

export interface ObserveDecidePayload {
  centerTs: number;
  frames: { ts: number; imageB64: string }[];
  /** Perceive-seeded per-frame context, aligned to the window frames. */
  seeds: PerFrameSeed[];
  /** Per-window bias hints / provenance from perceive trigger signals — NOT the
   * on/off switch. When non-empty, decide treats them as evidence to weigh. */
  biasHints: { eventType: string; ts: number }[];
  capped: boolean;
  droppedCount: number;
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
  biasHints: ObserveBiasHint[] = []
): ObserveDecidePayload {
  return {
    centerTs: win.centerTs,
    frames: win.frames,
    seeds: alignSeeds(win.frames, findingsByTs),
    biasHints: [...biasHints].sort((a, b) => a.ts - b.ts),
    capped: win.capped,
    droppedCount: win.droppedCount,
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
  private lastFireTs: number | null = null;
  private readonly cadenceS: number;
  private readonly windowS: number;
  private readonly maxFrames: number;
  private readonly fps: number;
  private readonly onDecide: ((payload: ObserveDecidePayload) => Promise<boolean>) | null;
  /** Accumulated per-call decide input-size + accept report. */
  private readonly reportTicks: number[] = [];
  private accepts = 0;

  constructor(opts: {
    cadenceS?: number;
    windowS?: number;
    maxFrames?: number;
    fps?: number;
    onDecide?: (payload: ObserveDecidePayload) => Promise<boolean>;
  } = {}) {
    this.cadenceS = opts.cadenceS ?? OBSERVE_CADENCE_S;
    this.windowS = opts.windowS ?? OBSERVE_WINDOW_S;
    this.maxFrames = opts.maxFrames ?? OBSERVE_MAX_FRAMES;
    this.fps = opts.fps ?? OBSERVE_CONTENT_FPS;
    this.onDecide = opts.onDecide ?? null;
  }

  /** Record a frame + its perceive-derived seed context (no re-inference). */
  record(ts: number, imageB64: string, seed: PerFrameSeed): void {
    this.frames.push({ ts, imageB64 });
    this.findings.set(ts, seed);
    const cutoff = ts - Math.max(this.windowS, 30);
    while (this.frames.length && this.frames[0].ts < cutoff) this.frames.shift();
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
    const payload = buildObservePayload(win, this.findings, []);
    this.reportTicks.push(payload.frames.length);
    if (this.onDecide && (await this.onDecide(payload))) this.accepts++;
  }

  /** Per-call decide input size (frame count) for the cost report. */
  inputSizeSamples(): number[] {
    return [...this.reportTicks];
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
}


