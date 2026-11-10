// ADAAAA-8344: per-decide STAGE LATENCY instrument.
//
// A live decide pays several sequential costs before it can return a verdict:
// the unpaid 402 probe (orchestrator challenge), the remote-signer
// `generate-live-payment` call that mints the ticket, and the paid re-POST of
// the same payload. Inside the paid POST the transport further splits into
// admission-queue wait, time-to-first-byte, body transfer and reply parse. Until
// now only `decide_audit.timings.elapsedMs` (decide-internal) and
// `observeMetrics.meanE2eMs` (whole onDecide incl. accept) existed, so the
// securing leg could not be told apart from the model leg.
//
// This module is instrumentation ONLY:
//   - it never changes the payload, the verdict, the headers or the number of
//     billable calls (the probe + paid pair is exactly today's flow);
//   - the recorder is bounded (a ring of the last {@link DECIDE_STAGE_RING}
//     calls per job) and drops silently, so a long run cannot grow memory;
//   - every read is a pure aggregation over already-measured numbers.
//
// The stage model is closed by construction: the named stages plus the explicit
// `residualMs` (adapter payload build + anything not separately clocked) sum to
// the measured `totalMs` of the decide call, so a report can state the closure
// instead of hoping the parts add up.

/** One decide call's measured stage breakdown (all times in ms, wall clock). */
export interface DecideStageTimings {
  /** Job id the call belongs to (the audit identity). Absent only for a call
   * made outside a job (tests, probes). */
  jobId?: string;
  /** The call's audit group key (`g<ts>` / `g<ts>:call2`), so a stored stage
   * sample can be paired with its `decide_audit` row. */
  groupKey?: string;
  /** Serialized request body length in BYTES (the full payload re-POSTed by the
   * paid retry — the probe sends the same bytes). */
  payloadBytes: number;
  /** Time to assemble the decide payload (evidence, frames, ASR block). */
  payloadBuildMs: number;
  /** JSON.stringify of the request body at the client. */
  serializeMs: number;
  /** The unpaid first attempt: wall from send to its 402 (or 200 offchain). */
  probeMs: number;
  /** The probe's HTTP status (0 when it was skipped/threw non-HTTP, 200 offchain,
   * 402 on-chain — the deployed posture's tell). */
  probeStatus: number;
  /** True when no unpaid probe was made on this call (e.g. an offchain posture
   * that answered 200, or a path with cached payment headers). */
  probeSkipped: boolean;
  /** Remote-signer `generate-live-payment` wall (ticket mint), incl. the 480
   * refresh when one was needed. */
  signerMs: number;
  /** Signer re-mints performed on this call (480 recovery / TicketParams
   * expiry re-sign). 0 on the steady state. */
  signerRetries: number;
  /** The paid re-POST wall, from send to parsed verdict. */
  paidMs: number;
  /** Inside `paidMs`: time to the response headers (orchestrator admission +
   * runner dispatch). */
  paidTtfbMs: number;
  /** Inside `paidMs`: client admission-queue wait (the FIFO decide slot). */
  paidQueueMs: number;
  /** Inside `paidMs`: reading the response body. */
  paidBodyMs: number;
  /** Inside `paidMs`: JSON.parse of the reply. */
  paidParseMs: number;
  /** Unpaid probes made on this call (1 = the shipped unpaid-first flow; 2 when
   * a TicketParams expiry forced a fresh probe). */
  probeCount: number;
  /** Paid re-POSTs made on this call (1 + the 503/404 retries). */
  paidRetries: number;
  /** Measured wall of the WHOLE decide call (adapter entry -> verdict). */
  totalMs: number;
  /** ADAAAA-8559: the decide runner id that served this call (the orchestrator
   * route segment `/apps/<id>/app`), and its discovery tier. Absent when the
   * call never reached a runner. */
  runnerId?: string;
  runnerTier?: string;
  /** `totalMs - (payloadBuild + serialize + probe + signer + paid)`; the
   * un-attributed remainder of the call (accept-gate staging, hook overhead). */
  residualMs: number;
}

/** The stage keys a report table can rely on, in call order. */
export const DECIDE_STAGE_KEYS = [
  "payloadBuildMs",
  "serializeMs",
  "probeMs",
  "signerMs",
  "paidMs",
  "residualMs",
] as const;
export type DecideStageKey = (typeof DECIDE_STAGE_KEYS)[number];

/** Sum of the NAMED stages (everything the instrument separates). */
export function decideStageSum(t: Pick<DecideStageTimings, DecideStageKey>): number {
  return DECIDE_STAGE_KEYS.reduce((a, k) => a + Number(t[k] || 0), 0);
}

/** Shared-share helper: a stage's share of the call's measured wall time. */
export function decideStageShare(ms: number, totalMs: number): number {
  return totalMs > 0 ? ms / totalMs : 0;
}

/** Bounded ring size per job (~100 calls at a 3 s cadence = 300 s of streaming). */
export const DECIDE_STAGE_RING = 100;

/** nearest-rank percentile on an unsorted sample (p in [0,1]); 0 when empty. */
export function stagePercentile(values: number[], p: number): number {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1));
  return xs[idx];
}

/** One stage's p50 / p95 / max over a job's samples. */
export interface DecideStageStats {
  p50: number;
  p95: number;
  max: number;
  /** mean, kept because the securing share reads better as a mean than a p50. */
  mean: number;
}

/** The job-visible summary: per-stage p50/p95/max + the securing roll-up. */
export interface DecideStagesSnapshot {
  /** Samples the summary is computed over (== decide calls instrumented). */
  calls: number;
  /** Per-stage distribution, keyed by {@link DECIDE_STAGE_KEYS} + the paid
   * sub-stages (ttfb/queue/body/parse) so a report needs no extra fields. */
  stages: Record<string, DecideStageStats>;
  /** Unpaid probes per decide (1.0 on the shipped unpaid-first posture). */
  probesPerDecide: number;
  /** Share of a call's wall time spent SECURING payment: (probe + signer) /
   * total, i.e. the part that only exists because the challenge is not cached. */
  securingShare: number;
  /** Share of a call spent waiting on the PAID request (transfer + admission +
   * inference + decide-internal parse). */
  paidShare: number;
  /** p50 of the closing ratio sum(named stages)/total, per call. */
  closureP50: number;
}

/** Small bounded per-job ring; a job's samples are dropped when it ends. */
export class DecideStageRecorder {
  private byJob = new Map<string, DecideStageTimings[]>();

  record(t: DecideStageTimings): void {
    const key = t.jobId || "job";
    const ring = this.byJob.get(key) ?? [];
    ring.push(t);
    if (ring.length > DECIDE_STAGE_RING) ring.splice(0, ring.length - DECIDE_STAGE_RING);
    this.byJob.set(key, ring);
  }

  samples(jobId?: string): DecideStageTimings[] {
    return [...(this.byJob.get(jobId || "job") ?? [])];
  }

  /** Drop a job's samples (called when the job record is finalized). */
  clear(jobId?: string): void {
    this.byJob.delete(jobId || "job");
  }

  summary(jobId?: string): DecideStagesSnapshot | undefined {
    const xs = this.samples(jobId);
    if (xs.length === 0) return undefined;
    const names = [
      ...DECIDE_STAGE_KEYS,
      "totalMs",
      "paidTtfbMs",
      "paidQueueMs",
      "paidBodyMs",
      "paidParseMs",
      "payloadBytes",
    ];
    const stages: Record<string, DecideStageStats> = {};
    for (const name of names) {
      // Clamp at 0: a stage clock can round to a hair below zero when it wraps
      // work another clock already covers, and the persisted schema is min(0).
      const vals = xs.map((x) => Math.max(0, Number((x as unknown as Record<string, number>)[name] || 0)));
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      stages[name] = {
        p50: round1(stagePercentile(vals, 0.5)),
        p95: round1(stagePercentile(vals, 0.95)),
        max: round1(Math.max(...vals)),
        mean: round1(mean),
      };
    }
    const totalP50 = stages.totalMs.p50 || 0;
    const securing = (stages.probeMs.p50 || 0) + (stages.signerMs.p50 || 0);
    // Closure is computed from the SAME clamped values the snapshot persists, so
    // `closureP50` and the stored stage table can never disagree.
    const closures = xs.map((x) => {
      if (!(x.totalMs > 0)) return 1;
      const sum = DECIDE_STAGE_KEYS.reduce(
        (a, k) => a + Math.max(0, Number((x as unknown as Record<string, number>)[k] || 0)),
        0
      );
      return sum / x.totalMs;
    });
    return {
      calls: xs.length,
      stages,
      probesPerDecide: round1(xs.reduce((a, x) => a + x.probeCount, 0) / xs.length),
      securingShare: totalP50 > 0 ? round4(securing / totalP50) : 0,
      paidShare: totalP50 > 0 ? round4((stages.paidMs.p50 || 0) / totalP50) : 0,
      closureP50: round4(stagePercentile(closures, 0.5)),
    };
  }
}

function round1(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(1)) : 0;
}
function round4(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

/** Process-wide recorder: the adapter writes, the observe snapshot reads. */
export const decideStageRecorder = new DecideStageRecorder();
