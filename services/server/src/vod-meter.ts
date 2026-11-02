// VOD per-job cost meter (ADAAAA-7821).
//
// The ratified price points ($3.00/video-hour standard depth, $4.00 at max
// depth) were derived from a MODEL ($0.40 / $0.83 per video-hour COGS). This
// module turns the three inputs that model assumed into measured values
// recorded on every completed VOD job, so per-video-hour cost is read from a
// job record instead of re-derived:
//
//   wallClockS       — processing wall clock of the VOD run (claim -> done)
//   decideCalls      — decide invocations actually billed for the job
//   sourceDurationS  — probed runtime of the source media
//
// `costUsd` is the same recorded meter the job already carried
// (`decideCalls * decideFee + perceiveSessionS/3600 * perceivePerHourUsd`),
// kept here so the per-video-hour figure is derivable from the block alone.
// Rounding matches the existing job fields (wall clock 0.1 s, money 4 dp).

export interface VodMeterInput {
  /** Processing wall clock in seconds (job claim -> completion). */
  wallClockS: number;
  /** Decide invocations for this job. */
  decideCalls: number;
  /** Probed source runtime in seconds; null when the probe failed. */
  sourceDurationS: number | null;
  /** Recorded spend for the job in USD. */
  costUsd: number;
  /** Effective per-decide rate the meter charged (cfg.decideFee). */
  decideFeeUsd: number;
}

export interface VodMeter {
  wallClockS: number;
  decideCalls: number;
  sourceDurationS: number | null;
  costUsd: number;
  decideFeeUsd: number;
  /** costUsd normalised to one source hour; null without a usable runtime. */
  perVideoHourCostUsd: number | null;
  /** wall clock / source duration, the RTF multiple the price model quotes
   * (e.g. 0.72 standard depth); null without a runtime. */
  rtf: number | null;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** Build the persisted per-job meter block. Pure: no clock, no I/O. */
export function buildVodMeter(input: VodMeterInput): VodMeter {
  const wallClockS = Number.isFinite(input.wallClockS) ? Math.max(0, input.wallClockS) : 0;
  const decideCalls = Number.isFinite(input.decideCalls) ? Math.max(0, Math.round(input.decideCalls)) : 0;
  const costUsd = Number.isFinite(input.costUsd) ? Math.max(0, input.costUsd) : 0;
  const decideFeeUsd = Number.isFinite(input.decideFeeUsd) ? Math.max(0, input.decideFeeUsd) : 0;
  const durS = input.sourceDurationS != null && Number.isFinite(input.sourceDurationS) && input.sourceDurationS > 0
    ? input.sourceDurationS
    : null;
  return {
    wallClockS: round(wallClockS, 1),
    decideCalls,
    sourceDurationS: durS == null ? null : round(durS, 1),
    costUsd: round(costUsd, 4),
    decideFeeUsd,
    perVideoHourCostUsd: durS == null ? null : round(costUsd / (durS / 3600), 4),
    rtf: durS == null ? null : round(wallClockS / durS, 3),
  };
}

/** Fixed-prefix completion log line, greppable in the server log. */
export function formatVodMeterLine(jobId: string, m: VodMeter): string {
  const n = (v: number | null, dp: number) => (v == null ? "n/a" : v.toFixed(dp));
  return (
    `[vod-meter] job=${jobId} wallClockS=${m.wallClockS.toFixed(1)} decideCalls=${m.decideCalls} ` +
    `sourceDurationS=${n(m.sourceDurationS, 1)} costUsd=${m.costUsd.toFixed(4)} ` +
    `perVideoHourCostUsd=${n(m.perVideoHourCostUsd, 4)} rtf=${n(m.rtf, 3)}`
  );
}
