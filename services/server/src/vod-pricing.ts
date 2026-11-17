// VOD retail price ladder — single source of truth (ADAAAA-9175).
//
// Authority: board accepted option A on card
// `7ff100a8-eded-4676-b92d-90e180ef5fb7` at 2026-11-17T12:33:08Z. Ruling of
// record: ADAAAA-9143 `ruling` document rev 2 (§0 decision record, §5 price
// leg). ADAAAA-9175 is the implementation of that ratified price; it decides
// nothing new, changes no inference and spends nothing.
//
// Price of record, USD per VIDEO-HOUR (never per clip, never per stream-hour):
//
//   standard depth (3 s observe, recall-optimal)  $12.00 / video-hour
//   max depth                                    $16.00 / video-hour
//
// RETIRED — do not quote, do not re-derive: the $3.00 standard / $4.00 max
// ladder. It was derived from a MODELLED $0.40 / $0.83 per-video-hour COGS that
// assumed ~121 decides/vh (1 decide per ~30 s at standard depth). The deployed
// observe loop fires every 3 s = ~1,200 decides/vh, a **9.9x cadence gap**, and
// that gap is the whole COGS error: measured COGS on the deployed build is flat
// at $4.06-4.69/video-hour across an 8.4x duration span. At that COGS the
// retired points are -35% to -56% gross margin (standard) and negative on the
// deepest band (max).
//
// Margin at the ratified ladder — quoted from ruling rev 2 §5, not re-derived:
//   $12.00/vh -> 58.3% GM at the $5.00/vh ceiling; 60.9-66.2% at measured COGS
//   $16.00/vh -> 68.8% GM at the ceiling;            70.7-74.6% at measured COGS
//
// Cost envelope the prices are set against. Unchanged by ADAAAA-9175: raising
// any of them needs a fresh CEO/board ruling, not a code edit.
//
//   ceiling          $5.00 / video-hour, trailing-14-day mean
//   per-job alarm    1.5x the ceiling = $7.50 / video-hour
//   VOD monthly cap  $50.00 / month  (~10 video-hours/month at the ceiling)
//
// The enforcement point already exists: `perVideoHourCostUsd` on the vod-meter
// block (services/server/src/vod-meter.ts) is the measured read this ceiling
// and alarm compare against. This module carries only the ratified numbers, so
// every price reader has one surface to import and
// services/server/test/vod-pricing.test.ts has one surface to pin.

/** Processing depth a VOD job is priced at. */
export type VodDepth = "standard" | "max";

export interface VodRetailLadder {
  /** Standard depth: the 3 s observe (recall-optimal) rail. */
  readonly standard: number;
  /** Max depth: the deep pass. */
  readonly max: number;
}

/**
 * Board-ratified VOD retail price, USD per source video-hour.
 *
 * Frozen on purpose: a ratified retail price is not an env-tunable knob. A
 * deployment that needs a different price needs a new board ruling, and a
 * reader that wants to change these numbers fails the ADAAAA-9175 guard.
 */
export const VOD_RETAIL_PRICE_USD_PER_VIDEO_HOUR: VodRetailLadder = Object.freeze({
  standard: 12.0,
  max: 16.0,
});

/** Depth ratios the ladder prices (max depth runs the deep pass). */
export const VOD_RETAIL_DEPTHS: readonly VodDepth[] = Object.freeze(["standard", "max"] as const);

/** `$5.00/video-hour`, enforced on a trailing-14-day mean. CEO authority
 * (ruling rev 2 §1 ruling A); not a board term, still not a code knob. */
export const VOD_COST_CEILING_USD_PER_VIDEO_HOUR = 5.0;

/** Per-job alarm at `1.5x` the ceiling = `$7.50/video-hour`. */
export const VOD_COST_ALARM_USD_PER_VIDEO_HOUR = 7.5;

/** Standing VOD monthly inference cap, unchanged: `$50.00/month`
 * (~10 video-hours/month at the ceiling). */
export const VOD_MONTHLY_CAP_USD = 50.0;

/** Where the ratified numbers come from, carried on the price surface so a
 * reader can cite the ruling instead of re-deriving the ladder. */
export const VOD_PRICING_RULING = Object.freeze({
  issue: "ADAAAA-9143",
  documentKey: "ruling",
  revision: 2,
  cardId: "7ff100a8-eded-4676-b92d-90e180ef5fb7",
  option: "A",
  ratifiedAt: "2026-11-17T12:33:08Z",
  implementedBy: "ADAAAA-9175",
});

/** The retired ladder, named so a guard can assert it is gone and a reader can
 * label a legacy quote rather than mistake it for the price of record. */
export const VOD_RETIRED_RETAIL_PRICE_USD_PER_VIDEO_HOUR: VodRetailLadder = Object.freeze({
  standard: 3.0,
  max: 4.0,
});

/** Measured per-video-hour COGS bands the ladder is priced against, USD. */
export const VOD_MEASURED_COGS_USD_PER_VIDEO_HOUR = Object.freeze({
  lt120s: 4.06,
  s120to200: 4.63,
  s200to400: 4.31,
  gte400s: 4.69,
});

/** Retail price for one depth. Throws on an unknown depth rather than
 * defaulting, so a new depth cannot silently inherit a stale price. */
export function vodRetailPriceUsdPerVideoHour(depth: VodDepth): number {
  const price = VOD_RETAIL_PRICE_USD_PER_VIDEO_HOUR[depth];
  if (typeof price !== "number") {
    throw new Error(`no ratified VOD retail price for depth "${String(depth)}"`);
  }
  return price;
}
