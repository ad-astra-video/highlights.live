// ADAAAA-7990 (delivery follow-up): an ordered, bounded observation relay for a
// media session.
//
// Why this module exists — measured on the deployed 3 fps build:
// the media node used to publish a frame and then poll `events-out/{seq}` ten
// times at 250 ms (a 2.5 s budget) and SILENTLY DISCARD the frame's observation
// when the runner had not caught up. The perceive runner steps frames on ONE
// serial loop, so at a 3 fps arrival cadence it falls behind by ~0.5 s per frame:
// the observation for seq 5 is already ~2.8 s late, the poll budget expires, and
// from that point on every frame is dropped. Job `750b6cd0` (300 s, 851 decoded
// frames at 2.84 fps) delivered TWO observations; job `8cb6e0a5` logged 4 obs for
// a 40 s stream (0.10 obs/s against the funded 3 fps cadence).
//
// The media server keeps its decoder at the funded cadence; what was broken is
// the RELAY. This class:
//
//   - follows published seqs IN ORDER (the same way the runner's own media loop
//     consumes video-in), on one serial loop per session, instead of running one
//     poll race per frame;
//   - gives each frame the control plane's own lag budget (`LIVE_OBSERVE_LAG_BUDGET_S`,
//     default 30 s) to produce its observation, so a slow runner DELAYS delivery
//     instead of cancelling it;
//   - holds only a FEW frames in flight (`DEFAULT_OBSERVE_MAX_IN_FLIGHT`) and
//     REFUSES new frames beyond that (counted, never published). This is pacing,
//     not just backpressure: go-livepeer's live edge serves a segment only while
//     it is still buffered and the runner's trickle subscriber does not skip, so
//     a publisher that outruns the runner leaves it stalled on an aged-out seq
//     forever (measured session `376fae8f`: 858 decoded frames, 58 published into
//     a stalled subscriber because the window was sized from the lag budget);
//   - bounds every read, so one hanging `events-out` GET cannot stall the queue;
//   - reports `delivered` / `expired` / `refused` / `maxLagMs` so box evidence
//     attributes the delivered rate instead of it reading as "zero observations".
//
// Invariants:
//   - nothing is dropped without a counter (no silent loss — the ADAAAA-7990 bug);
//   - the queue is bounded by the in-flight cap, so a stalled runner cannot grow
//     media-node memory (each entry holds one decoded JPEG);
//   - delivery order is publish order, so the rail's seq/clock rebasing stays
//     monotonic.

/** One published frame awaiting its observation. `jpeg` is the anchor pixels the
 *  control plane attaches to the decide window, so it must travel with the
 *  observation (it is released as soon as the entry is delivered or expires). */
export interface ObservationFrame {
  seq: number;
  /** Wall-clock epoch seconds the media node decoded this frame. */
  ts: number;
  jpeg: Uint8Array;
  /** The WS socket the frame arrived on (relay fan-out target). */
  socket?: any;
  /** Decode wall time, reported on the `[rtc] obs` line. */
  decodeLatencyMs?: number;
}

export interface ObservationRelayOptions {
  /** Read the observation the runner published for `seq` (null when not yet). */
  read: (seq: number) => Promise<any | null>;
  /** Deliver one observation with the frame it belongs to. */
  emit: (obs: any, frame: ObservationFrame) => void;
  /** How long (ms) a published frame may take to produce its observation before
   *  it is abandoned. Mirrors the control plane's `LIVE_OBSERVE_LAG_BUDGET_S`. */
  deadlineMs?: number;
  /** Poll cadence on the relay's serial loop. */
  pollIntervalMs?: number;
  /** Max frames published-but-not-yet-delivered before the OLDEST are abandoned.
   *  Bounds the relay's memory; it is NOT a publish gate (see
   *  {@link DEFAULT_OBSERVE_MAX_QUEUED}). */
  maxInFlight?: number;
  /** Alias of `maxInFlight` with the honest name (a queue cap). */
  maxQueued?: number;
  /** Sampling cadence, reported only (no longer sizes the in-flight window). */
  sampleFps?: number;
  /** Bound on ONE `events-out` read. A read that hangs (go-livepeer's trickle
   *  GET can block indefinitely on a seq it will never serve) must not stall the
   *  serial loop — it is treated as "not yet". */
  readTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface ObservationRelayStats {
  /** Frames published to video-in (and handed to this relay). */
  published: number;
  /** Observations relayed to the WS peers + the control-plane callback. */
  delivered: number;
  /** Frames whose observation never arrived inside the deadline. */
  expired: number;
  /** Frames the runner never produced at all because it fast-forwarded past them
   *  (go-livepeer's live edge skips a gap); abandoned as soon as the NEXT frame's
   *  observation proves the runner moved on, not after the full deadline. */
  skipped: number;
  /** Frames NOT published because the in-flight window was full. */
  refused: number;
  /** Frames published, not yet delivered. */
  inFlight: number;
  /** Worst publish -> delivery lag seen (ms). */
  maxLagMs: number;
}

/** Default delivery deadline: the control plane's live lag budget (30 s). */
export const DEFAULT_OBSERVE_DEADLINE_MS = 30_000;
/** Default poll cadence: 100 ms. Serial, so this is one GET per tick, not one
 *  GET race per in-flight frame (10 concurrent pollers at 4 Hz each). */
export const DEFAULT_OBSERVE_POLL_MS = 100;
/**
 * Default bound on frames published-but-not-yet-delivered: a QUEUE cap, NOT a
 * publish gate.
 *
 * Publishing must stay DENSE. go-livepeer's video-in trickle is a STRICTLY
 * ordered stream: a frame the node does not publish leaves a permanent hole, and
 * the runner's serial subscriber re-requests that seq forever instead of skipping
 * it. Measured on session `0251b715` (300 s VP8 share, `ee41080`, 858 decoded
 * frames): the paced publisher never posted video-in idx 4/5, the broker read
 * `next=4`, the runner answered `GET segment idx=4 exists?=false` for the rest of
 * the share, and the whole run delivered **3** observations. An earlier 45-frame
 * gate on session `376fae8f` posted 58 frames and then stalled the same way.
 *
 * So the backlog is bounded here instead: past this many queued frames the OLDEST
 * undelivered ones are abandoned (`expired`, rate-limit logged with
 * `obs-dropped`), while every decoded frame still goes to the runner.
 */
export const DEFAULT_OBSERVE_MAX_QUEUED = 45;
/** @deprecated Use {@link DEFAULT_OBSERVE_MAX_QUEUED}: this is a queue cap now,
 *  not a publish gate (see the constant's note for the measured reason). */
export const DEFAULT_OBSERVE_MAX_IN_FLIGHT = DEFAULT_OBSERVE_MAX_QUEUED;
/** Bound on a single `events-out` read. A GET that has not answered in 2 s is
 *  treated as "no observation yet"; the deadline still governs abandonment. */
export const DEFAULT_OBSERVE_READ_TIMEOUT_MS = 2_000;

const noop = () => {};

export class ObservationRelay {
  private readonly deadlineMs: number;
  private readonly pollMs: number;
  private readonly maxQueued: number;
  private readonly readTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  /** FIFO of published-but-undelivered frames (publish order). */
  private queue: Array<{ frame: ObservationFrame; publishedAt: number }> = [];
  /** The entry the delivery loop is currently reading (never evicted by the cap
   *  while in flight; the loop counts its own expiry). */
  private headInFlight: { frame: ObservationFrame; publishedAt: number } | null = null;
  /** Slots reserved for frames whose publish is still in progress. */
  private reserved = 0;
  private running = false;
  private closed = false;
  private counters = { published: 0, delivered: 0, expired: 0, skipped: 0, refused: 0, maxLagMs: 0 };
  /** Rate-limited logging for repeated expiries/skips (first + every 10th). */
  private expiryLogs = 0;
  private skipLogs = 0;

  constructor(private readonly opts: ObservationRelayOptions) {
    this.deadlineMs = Math.max(1_000, opts.deadlineMs ?? DEFAULT_OBSERVE_DEADLINE_MS);
    this.pollMs = Math.max(10, opts.pollIntervalMs ?? DEFAULT_OBSERVE_POLL_MS);
    // A QUEUE cap (see DEFAULT_OBSERVE_MAX_QUEUED): publishing stays dense, and
    // only frames whose observation never arrived are abandoned.
    this.maxQueued = Math.max(
      2,
      opts.maxQueued ?? opts.maxInFlight ?? DEFAULT_OBSERVE_MAX_QUEUED,
    );
    this.readTimeoutMs = Math.max(100, opts.readTimeoutMs ?? DEFAULT_OBSERVE_READ_TIMEOUT_MS);
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? noop;
  }

  /**
   * Admit a frame for publishing. ALWAYS true (except after close).
   *
   * This used to gate publishing on the in-flight window, which paced the node to
   * the runner — and left HOLES in video-in that a strictly-ordered trickle
   * stream can never fill, so the runner's serial subscriber blocked on the hole
   * for the rest of the session (session `0251b715`: video-in idx 4/5 never
   * posted, broker `next=4`, runner `exists?=false` forever, 3 observations in
   * 300 s). The queue is bounded in {@link commit} instead, where abandoning a
   * frame cannot change which seqs the runner sees.
   */
  reserve(): boolean {
    return !this.closed;
  }

  /** Release a reservation whose publish failed (nothing to observe). */
  abort(): void {
    if (this.reserved > 0) this.reserved--;
  }

  /** Hand over a frame whose publish succeeded; it enters the delivery queue. */
  commit(frame: ObservationFrame): void {
    if (this.reserved > 0) this.reserved--;
    if (this.closed) return;
    this.counters.published++;
    this.queue.push({ frame, publishedAt: this.now() });
    // Bound the queue by abandoning the OLDEST undelivered frames — never by
    // skipping a publish (that is what wedges the runner). The head currently
    // being read is kept: the loop finishes it and counts it itself.
    while (this.queue.length > this.maxQueued) {
      const at = this.queue.findIndex((e) => e !== this.headInFlight);
      if (at < 0) break;
      const gone = this.queue.splice(at, 1)[0];
      this.counters.expired++;
      this.expiryLogs++;
      if (this.expiryLogs === 1 || this.expiryLogs % 10 === 0) {
        this.log(
          `[rtc] obs-dropped seq=${gone.frame.seq} queued=${this.queue.length} ` +
            `expired=${this.counters.expired} (backlog cap ${this.maxQueued})`,
        );
      }
    }
    this.kick();
  }

  stats(): ObservationRelayStats {
    return {
      published: this.counters.published,
      delivered: this.counters.delivered,
      expired: this.counters.expired,
      skipped: this.counters.skipped,
      refused: this.counters.refused,
      inFlight: this.queue.length,
      maxLagMs: this.counters.maxLagMs,
    };
  }

  /** True when nothing is queued or being delivered. */
  get idle(): boolean {
    return this.queue.length === 0 && !this.running;
  }

  /** One-line summary for the session's close log — the AC1 evidence line. */
  summary(): string {
    const s = this.stats();
    return (
      `published=${s.published} delivered=${s.delivered} expired=${s.expired} ` +
      `skipped=${s.skipped} refused=${s.refused} inFlight=${s.inFlight} maxLagMs=${s.maxLagMs}`
    );
  }

  /** Deliver everything currently queued, bounded by `timeoutMs` (tests + a
   *  teardown that wants the tail observations relayed before the slot closes). */
  async flush(timeoutMs = 5_000): Promise<void> {
    const until = this.now() + Math.max(0, timeoutMs);
    while (this.queue.length && !this.closed && this.now() < until) {
      if (!this.running) this.kick();
      await this.sleep(Math.min(this.pollMs, 50));
    }
  }

  /** Stop delivering. Frames still queued are abandoned (counted as expired
   *  only when their deadline truly elapsed — a teardown close is not a loss). */
  close(): void {
    this.closed = true;
  }

  private kick(): void {
    if (this.running || this.closed) return;
    this.running = true;
    void this.loop().catch((e) => {
      this.log(`[media] observe-relay loop err: ${String((e as any)?.message || e)}`);
    });
  }

  /**
   * One read, bounded. `read` may never settle (a trickle GET on a seq the live
   * edge will not serve); a hang here used to stall the whole queue for the rest
   * of the session (session `376fae8f`: `[rtc] obs-expired seq=13 waitedMs=295789`,
   * `delivered=12`). A timeout reads as "no observation yet".
   */
  private async readBounded(seq: number): Promise<any | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.opts.read(seq).catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.readTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The delivery loop: strictly publish order, one GET per tick. */
  private async loop(): Promise<void> {
    try {
      while (!this.closed && this.queue.length > 0) {
        const head = this.queue[0];
        this.headInFlight = head;
        const deadline = head.publishedAt + this.deadlineMs;
        let obs: any = null;
        let skipped = false;
        while (!this.closed) {
          // The backlog cap may have abandoned the head while we were waiting (it
          // never evicts the in-flight head, but a teardown/re-kick can leave a
          // stale reference): stop working on an entry that is no longer queued.
          if (!this.queue.includes(head)) break;
          obs = await this.readBounded(head.frame.seq);
          if (obs) break;
          // Fast-forward detection: the runner consumes video-in in seq order, but
          // go-livepeer's live edge SKIPS a gap rather than replaying it, so the
          // frame after the head can already carry an observation while the head
          // never will. Waiting the full deadline on such a hole would cost 30 s
          // per gap (and stall every frame behind it), so abandon the head as soon
          // as a LATER published frame proves the runner moved past it.
          const next = this.queue[1];
          if (next && next.frame.seq > head.frame.seq) {
            const ahead = await this.readBounded(next.frame.seq);
            if (ahead) {
              skipped = true;
              break;
            }
          }
          if (this.now() >= deadline) break;
          await this.sleep(this.pollMs);
        }
        this.headInFlight = null;
        const at = this.queue.indexOf(head);
        if (at < 0) continue; // abandoned by the backlog cap (counted there)
        this.queue.splice(at, 1);
        if (obs) {
          const lagMs = Math.max(0, this.now() - head.publishedAt);
          if (lagMs > this.counters.maxLagMs) this.counters.maxLagMs = lagMs;
          this.counters.delivered++;
          try {
            this.opts.emit(obs, head.frame);
          } catch (e: any) {
            this.log(`[media] observe-relay emit err seq=${head.frame.seq}: ${String(e?.message || e).slice(0, 120)}`);
          }
          continue;
        }
        if (skipped) {
          // The runner fast-forwarded past this seq: no observation will ever exist.
          this.counters.skipped++;
          this.skipLogs++;
          if (this.skipLogs === 1 || this.skipLogs % 10 === 0) {
            this.log(`[rtc] obs-skipped seq=${head.frame.seq} skipped=${this.counters.skipped} (runner fast-forwarded)`);
          }
          continue;
        }
        // Never drop silently: every abandoned frame is counted and (rate
        // limited) logged, so a rail that reads "no observations" is always
        // attributable to a runner that outran the deadline.
        this.counters.expired++;
        this.expiryLogs++;
        if (this.expiryLogs === 1 || this.expiryLogs % 10 === 0) {
          this.log(
            `[rtc] obs-expired seq=${head.frame.seq} waitedMs=${this.now() - head.publishedAt} ` +
              `expired=${this.counters.expired}`,
          );
        }
      }
    } finally {
      this.running = false;
      if (!this.closed && this.queue.length > 0) this.kick();
    }
  }
}
