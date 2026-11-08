// ADAAAA-7758: live decide ADMISSION CONTROL — price the second concurrent live
// stream instead of letting it silently starve the first.
//
// Measured on the deployed box (master `bde4ea7`, ADAAAA-7757 decision record):
// one gemma 12B decide costs ~8-13 s wall for ~3 s of content, and the box has
// FOUR decide slots (vLLM `--max-num-seqs 4` on one saturated 16 GB card). That
// is 0.38 decide/s = 1.14x realtime against one stream's 0.33 decide/s, which is
// exactly the structural 25-30 s lag at ONE live job.
//
// A second concurrent live stream offers ~7.0 erlangs against the same 4 slots:
// there is no steady state. Both streams fall behind, the 30 s budget drops
// almost every window (QA measured 145 of ~170 skipped at two streams) and both
// chips still breach 30 s. So concurrency is UNPRICED: every extra live stream
// silently destroys the detection coverage of every stream, including the one
// that was already running.
//
// This module prices it. At most ONE live job holds the live decide slot at a
// time; the holder is the live job that asked first. A later job's decide is
// REFUSED — never queued into an unbounded backlog, never decided late, never
// recorded as a decide-latency sample — and the refusal is counted on the run as
// an admission skip. The holder therefore keeps its SOLO decide latency (~9 s),
// so its 30 s budget stays enforceable, and a second stream can no longer
// degrade it.
//
// Opt-in, DEFAULT OFF (`LIVE_DECIDE_ADMISSION=1` to enable). Refusal makes the
// extra stream WAIT, and the CEO's ADAAAA-7757 decision requires explicit
// customer wording for a queued stream ("live analysis is busy; your stream
// starts at ~HH:MM") before that behaviour ships. Until that wording is
// approved the shipped default keeps today's behaviour, and the mechanism can be
// measured on the box by flipping the flag.
//
// Invariants:
// - One live decide in flight across ALL live rails (rtmp/file-sim AND the
//   browser/media rail share this one process-level slot).
// - The same job re-admitting is always allowed (a job's own chain/loop is
//   already serial; this gate only arbitrates BETWEEN jobs).
// - A holder that stops admitting for `holderIdleTtlMs` forfeits the slot, so a
//   crashed/stopped job can never wedge every other live job.

/** Default holder idle horizon before another live job may take the slot. */
export const LIVE_DECIDE_ADMISSION_TTL_MS = 120_000;

export interface LiveDecideAdmissionSnapshot {
  /** Whether admission control is enforced at all. */
  enabled: boolean;
  /** Live job currently holding the decide slot (null when free). */
  holderJobId: string | null;
  /** Decides admitted since the process started. */
  admissions: number;
  /** Decides refused because another live job held the slot. */
  refusals: number;
  /** Refusals charged to each job id (a queued stream's wait is visible). */
  refusalsByJob: Record<string, number>;
}

export class LiveDecideAdmission {
  private enabledState: boolean;
  private readonly holderIdleTtlMs: number;
  private holderJobId: string | null = null;
  private holderLastAdmitMs = 0;
  private admissions = 0;
  private refusals = 0;
  private readonly refusalsByJob = new Map<string, number>();

  constructor(opts: { enabled?: boolean; holderIdleTtlMs?: number } = {}) {
    this.enabledState = opts.enabled ?? false;
    this.holderIdleTtlMs = Math.max(1_000, opts.holderIdleTtlMs ?? LIVE_DECIDE_ADMISSION_TTL_MS);
  }

  /** The operator switch (`LIVE_DECIDE_ADMISSION`). Disabling it releases the
   *  slot so a re-enable starts from a clean state. */
  configure(enabled: boolean): void {
    this.enabledState = !!enabled;
    if (!this.enabledState) this.holderJobId = null;
  }

  get enabled(): boolean {
    return this.enabledState;
  }

  /**
   * Ask for the live decide slot. `true` = this job may decide now.
   *
   * Disabled: always true (shipped behaviour, no arbitration).
   * Enabled: the first live job to ask holds the slot; the holder is always
   * re-admitted; another job is refused until the holder releases (or goes idle
   * past the TTL, so a dead holder cannot wedge the box).
   */
  admit(jobId: string, nowMs: number = Date.now()): boolean {
    if (!this.enabledState) return true;
    if (this.holderJobId === null) {
      this.holderJobId = jobId;
      this.holderLastAdmitMs = nowMs;
      this.admissions++;
      return true;
    }
    if (this.holderJobId === jobId) {
      this.holderLastAdmitMs = nowMs;
      this.admissions++;
      return true;
    }
    if (nowMs - this.holderLastAdmitMs > this.holderIdleTtlMs) {
      // The holder stopped deciding (stopped/crashed job, or a rail that never
      // released): hand the slot to the job that is actually asking.
      this.holderJobId = jobId;
      this.holderLastAdmitMs = nowMs;
      this.admissions++;
      return true;
    }
    this.refusals++;
    this.refusalsByJob.set(jobId, (this.refusalsByJob.get(jobId) ?? 0) + 1);
    return false;
  }

  /** Give the slot back when a live run ends (idempotent, safe on any path). */
  release(jobId: string): void {
    if (this.holderJobId === jobId) {
      this.holderJobId = null;
      this.holderLastAdmitMs = 0;
    }
  }

  // --- ADAAAA-7771: in-flight decide SHARING -------------------------------
  //
  // The observe pass may keep K decide windows in flight per stream, but the
  // orchestrated decide client admits only `decideAdmission` decide app-calls at
  // once (measured: DECIDE_CONCURRENCY unset => 2, while the box has 8 decide
  // slots). Depth above that admission does not add throughput — it only queues,
  // and a queued window lands later, which is exactly the viewer-visible lag this
  // pipeline is measured on. Measured at depth 4: 1 stream 11.6 s/decide and 31.3 s
  // lag (fine), 2 streams 24.8-26.6 s/decide and 50.8-52.0 s lag (a regression
  // against the serial 32.6-34.5 s). So the depth is a SHARED budget: each live
  // stream gets `floor(admission / activeLiveStreams)`, at least 1 (serial).

  /** Live jobs currently running an observe pass. */
  private readonly activeLiveJobs = new Set<string>();

  /** Mark a live pass as active so the decide depth can be shared across them.
   *  Idempotent; always paired with {@link releaseLiveJob}. */
  registerLiveJob(jobId: string): void {
    this.activeLiveJobs.add(jobId);
  }

  /** Drop a live pass from the sharing set (idempotent). */
  releaseLiveJob(jobId: string): void {
    this.activeLiveJobs.delete(jobId);
  }

  /** Live observe passes currently running in this process. */
  activeLiveJobCount(): number {
    return this.activeLiveJobs.size;
  }

  /**
   * ADAAAA-7771 -> ADAAAA-8437 (AC5): in-flight decide depth for ONE stream.
   *
   * `admission` is how many decide app-calls the box admits at once — the
   * DISCOVERED `effective` capacity when the caller wires the snapshot getter,
   * else the funded `DECIDE_CONCURRENCY` fallback. The depth is
   * `min(maxPerStream, floor(admission / activeStreams))`, never below 1: a lone
   * stream keeps its configured depth whenever the advertised capacity covers it
   * (shipped 6 > LIVE_OBSERVE_IN_FLIGHT 4, byte-identical), and two streams split
   * the advertised capacity instead of being pinned at the funded number.
   */
  depthFor(jobId: string, maxPerStream: number, admission: number): number {
    const cap = Math.max(1, Math.floor(maxPerStream));
    const admit = Math.max(1, Math.floor(admission));
    // `jobId` is normally registered, so the set size IS the number of streams
    // sharing the admission.
    const active = Math.max(1, this.activeLiveJobs.size);
    // ADAAAA-8437 (AC5): the depth follows the capacity the fleet advertises for
    // EVERY stream shape — `min(configured max, floor(effective / streams))`. A
    // lone stream is byte-identical whenever the advertised capacity covers its
    // configured depth (the shipped 6 > 4), and a 2-stream box on the shipped
    // 6-wide advertisement gets 3 each (exactly the advertisement) instead of the
    // funded 8 split into 4 each, which oversubscribed the routed set.
    const share = Math.max(1, Math.floor(admit / active));
    return Math.max(1, Math.min(cap, share));
  }

  snapshot(): LiveDecideAdmissionSnapshot {
    return {
      enabled: this.enabledState,
      holderJobId: this.holderJobId,
      admissions: this.admissions,
      refusals: this.refusals,
      refusalsByJob: Object.fromEntries(this.refusalsByJob),
    };
  }

  /** Test hook: clear holder + counters without touching the operator switch. */
  reset(): void {
    this.holderJobId = null;
    this.holderLastAdmitMs = 0;
    this.admissions = 0;
    this.refusals = 0;
    this.refusalsByJob.clear();
  }
}

/** Process-wide slot shared by every live rail (RTMP/file-sim + media rail). */
export const liveDecideAdmission = new LiveDecideAdmission();
