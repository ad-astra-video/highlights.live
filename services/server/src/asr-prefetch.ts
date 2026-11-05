// ADAAAA-8081: ASR off the live decide critical path.
//
// The live decide call used to do its own ASR inline: `services/decide` POSTed
// the window's audio clip to the ASR service and only then started the gemma
// call. On the 4-image cell a 1-image tail window measured 9 125 / 8 816 ms
// against a 2.4-3.3 s gemma cost, because a 4.3-5.5 s ASR call sat in front of
// it (ADAAAA-8074 legs A/B).
//
// This module moves that work into a SIDE LANE owned by the server:
//
//   1. The live observer starts the transcription the moment the window's audio
//      slice is known (fire time), so it overlaps the decide that is already in
//      flight — the ADAAAA-8081 shape "(a) produce window N's audio clip and ASR
//      concurrently with window N-1's decide".
//   2. The transcript then rides the decide payload (`asrPrefetched` /
//      `asrTranscript` / `asrLatencyS`) and the decide service consumes it
//      instead of transcribing again, so the decide SLOT (the bounded in-flight
//      budget) is held by gemma only, not by gemma + ASR.
//   3. Every failure path returns `ran: false`: the decide service then falls
//      back to its own inline ASR, which keeps the `asrRan` / `asrLatencyS`
//      coverage invariant (ADAAAA-8056 AC-E2) exactly as it is today.
//
// The cache is content-addressed on the clip bytes and single-flighted: a
// re-decide of the SAME window (the on-demand-recall second call, a confirm
// re-read) reuses one transcription instead of paying for it twice, which the
// legs showed happening (`g99` and `g99:call2` both ASR'd the same window).

import { createHash } from "node:crypto";

/** One ASR prefetch outcome. `ran` is the ONLY field the decide service keys
 *  off: false (transport error / timeout / disabled) means "transcribe it
 *  yourself, exactly as before". */
export interface AsrPrefetchResult {
  transcript: string;
  /** Wall-clock seconds the ASR call took (reported as `asrLatencyS`). */
  latencyS: number;
  /** True when ASR actually executed for this clip, even if the transcript is
   *  empty (a silent window is still a transcribed window: `audioPath` must
   *  stay `asr_text`, not fall back to `none`). */
  ran: boolean;
  error?: string;
}

export interface AsrPrefetcherOptions {
  /** ASR base URL (`ASR_URL`); absent => `start()` returns null and the decide
   *  service keeps doing its own ASR (byte-identical to the pre-8081 path). */
  asrUrl?: string;
  /** Per-call timeout. A hung ASR must degrade to inline ASR, never stall the
   *  live pass (the decide slot frees on the same tick either way). */
  timeoutMs?: number;
  /** Bounded parallelism: whisper is CPU-bound, so an unbounded lane would
   *  recreate the contention tail this ticket exists to remove. */
  maxConcurrent?: number;
  /** Result cache bound (LRU). */
  maxCache?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_CACHE = 64;

/**
 * Single-flight, content-addressed ASR prefetcher.
 *
 * `start(clip)` never throws and never rejects: a caller can `await` its result
 * unconditionally and still get `{ran:false}` when the lane is unavailable.
 */
export class AsrPrefetcher {
  private readonly asrUrl?: string;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly maxCache: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, AsrPrefetchResult>();
  private readonly inFlight = new Map<string, Promise<AsrPrefetchResult>>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  /** Prefetch requests started / ASR calls actually made / cache hits — quoted
   *  in the report so "ASR left the slot" is measurable, not asserted. */
  readonly stats = { started: 0, calls: 0, hits: 0, failures: 0 };

  constructor(opts: AsrPrefetcherOptions = {}) {
    this.asrUrl = opts.asrUrl?.trim() || undefined;
    this.timeoutMs = Math.max(250, Math.floor(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
    this.maxCache = Math.max(1, Math.floor(opts.maxCache ?? DEFAULT_MAX_CACHE));
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** True when the lane can run at all (an ASR endpoint is configured). */
  get enabled(): boolean {
    return !!this.asrUrl;
  }

  /**
   * Start (or reuse) transcription for one window clip.
   *
   * Returns `null` when the lane is disabled or the clip is empty — the decide
   * service's own inline path then runs unchanged.
   */
  start(clipB64: string): Promise<AsrPrefetchResult> | null {
    if (!this.asrUrl || !clipB64) return null;
    const key = createHash("sha256").update(clipB64).digest("hex");
    const cached = this.cache.get(key);
    if (cached) {
      // LRU touch
      this.cache.delete(key);
      this.cache.set(key, cached);
      this.stats.hits++;
      return Promise.resolve(cached);
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    this.stats.started++;
    const p = this.run(key, clipB64).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async run(key: string, clipB64: string): Promise<AsrPrefetchResult> {
    await this.acquire();
    try {
      const result = await this.transcribe(clipB64);
      this.stats.calls++;
      if (result.ran) {
        this.cache.set(key, result);
        while (this.cache.size > this.maxCache) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cache.delete(oldest);
        }
      } else {
        this.stats.failures++;
      }
      return result;
    } finally {
      this.release();
    }
  }

  private async transcribe(clipB64: string): Promise<AsrPrefetchResult> {
    const url = `${this.asrUrl!.replace(/\/$/, "")}/transcribe`;
    const started = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: clipB64, sample_rate: 16000, task: "transcribe" }),
        signal: ctl.signal,
      });
      const latencyS = Number(((Date.now() - started) / 1000).toFixed(4));
      if (!res.ok) {
        return { transcript: "", latencyS, ran: false, error: `HTTP ${res.status}` };
      }
      const body = (await res.json().catch(() => null)) as { text?: string; asrError?: string } | null;
      // The ASR service answers 200 for any payload problem (silent / short /
      // undecodable clip) — that IS a transcribed window with an empty text, so
      // `ran` stays true and the coverage block reports `asr_text`.
      return {
        transcript: String(body?.text ?? "").trim(),
        latencyS,
        ran: true,
        ...(body?.asrError ? { error: String(body.asrError) } : {}),
      };
    } catch (e: any) {
      const latencyS = Number(((Date.now() - started) / 1000).toFixed(4));
      return { transcript: "", latencyS, ran: false, error: String(e?.message || e).slice(0, 120) };
    } finally {
      clearTimeout(timer);
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running = Math.max(0, this.running - 1);
  }
}
