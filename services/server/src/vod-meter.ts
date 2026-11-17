// VOD per-job cost meter (ADAAAA-7821; price basis re-based by ADAAAA-9175).
//
// The price this meter is read against is the board-ratified ladder in
// `services/server/src/vod-pricing.ts`: $12.00 per video-hour at standard depth
// (the 3 s observe, recall-optimal rail) and $16.00 per video-hour at max
// depth. Its basis is MEASURED COGS on the deployed build, not a model
// (ADAAAA-9143 `ruling` document rev 2):
//
//   measured $/video-hour  <120 s 4.06 | 120-200 s 4.63 | 200-400 s 4.31 |
//                          >=400 s 4.69   (288 file jobs, 178 done; flat
//                          across an 8.4x source-duration span)
//   cost ceiling           $5.00 per video-hour, trailing-14-day mean
//   per-job alarm          1.5x the ceiling = $7.50 per video-hour
//   VOD monthly cap        $50.00/month (~10 video-hours/month at the ceiling)
//
// RETIRED (ADAAAA-9175): the $3.00 standard / $4.00 max ladder, and the
// $0.40 / $0.83 per-video-hour COGS model it was derived from. That model
// assumed ~121 decides/vh (1 decide per ~30 s); the deployed observe loop fires
// every 3 s = ~1,200 decides/vh, a 9.9x cadence gap, and that gap is the entire
// COGS error. At measured COGS the retired points are -35% to -56% gross margin
// (standard) and negative on the deepest band (max). The retired ladder is
// pinned out by `services/server/test/vod-pricing.test.ts` — do not restate it.
//
// This module turns the inputs the retired model assumed into measured values
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
