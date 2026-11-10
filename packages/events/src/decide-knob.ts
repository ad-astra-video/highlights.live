// ADAAAA-8544: the per-stream decide cost KNOB — one pure module for the whole
// contract so the server, the window audit and the board control cannot each
// resolve their own answer.
//
// The knob replaces the deploy-time `LIVE_DECIDE_KEEP_RATIO` fraction with two
// per-job inputs and prices itself before the job starts:
//
//   cadenceSec        3 | 5            (default 5 — CEO ruling, spec rev 3 §7)
//   rateCapPer300s    63..opportunities, or null = uncapped (default null)
//
// Everything here is a pure function of its inputs: no IO, no config reads, no
// clock. That is what lets AC3 be asserted on the SHIPPED function (the same
// numbers QA grades) and AC2 be asserted as "the knob resolves nothing else".
//
// Estimate version: `est-v2` (spec rev 3 §3). A change to the bundle shape, the
// per-decide price or the rail table moves the estimate, so it must bump this
// version rather than silently edit a constant — old job rows carry the version
// they were stamped with.
import { z } from "zod";

/** The coverage floor ratified in ADAAAA-8427. A cap below it trades a spend
 *  pass for a coverage fail, which is the failure 8427 was opened to stop, so
 *  `POST /jobs` rejects it with 422 `decide_rate_below_coverage_floor`. */
export const DECIDE_RATE_FLOOR_PER_300S = 63;

/** usd per charged decide — the mean of the two measured rows (0.0033127
 *  [ADAAAA-8269] and 0.0033522 [ADAAAA-8526: 1.0459 / 312]). */
export const DECIDE_USD_PER_DECIDE = 0.0033324;

/** The estimate model version stamped beside the numbers. */
export const DECIDE_ESTIMATE_VERSION = "est-v2";

/** The cadence values the knob accepts. 5 s is the shipped default (CEO ruling
 *  2026-11-10T03:36:16Z, card `b9bb9fa4`, option `economy`); 3 s stays
 *  user-selectable. Anything else is rejected at the route. */
export const DECIDE_CADENCE_OPTIONS = [3, 5] as const;
export type DecideCadenceSec = (typeof DECIDE_CADENCE_OPTIONS)[number];
export const DECIDE_CADENCE_DEFAULT: DecideCadenceSec = 5;

/** Opportunity density at a 3 s cadence, per rail, per 300 s of CONTENT clock.
 *  `browser` is the centre of the two measured natural-stream rows (72.76
 *  [ADAAAA-8427] and 84.51 [ADAAAA-8526]); `analyzer` is the ratified
 *  RTMP/file cell ([ADAAAA-8269]). */
export const DECIDE_OPPORTUNITIES_3S_PER_300S = {
  browser: 78.2,
  analyzer: 104,
} as const;

/** The measured browser band at a 3 s cadence — the two graded rows, so the
 *  control can print a band instead of pretending a single point is exact on a
 *  rail that varies 16 % stream to stream. */
export const DECIDE_BROWSER_BAND_3S_PER_300S = { low: 72.76, high: 84.51 } as const;

/**
 * How the opportunity density GROWS when the cadence leaves 3 s.
 *
 * `browser` = 0.64: the measured 3 s interval (3.553 s, 8526 `meanCadenceMs`)
 * divided by the interval a 5 s cadence forces (5.553 s) — the cadence adds 2 s
 * to whatever the stream already offers, so it is NOT a plain 3/5.
 *
 * `analyzer` = 0.6: on the RTMP/file rail the cadence IS the limiter (104
 * decides / 300 s against a 2.885 s interval), so moving 3 s -> 5 s scales the
 * rate by 3/5 exactly.
 *
 * The browser 5 s row is the only EXTRAPOLATION in `est-v2` (spec §9): it is
 * shipped with its band printed, never as a bare point.
 */
export const DECIDE_CADENCE_GROWTH = {
  browser: { 3: 1, 5: 0.64 },
  analyzer: { 3: 1, 5: 0.6 },
} as const;

/** Which rail a job's source resolves onto: a browser/screen capture is the
 *  browser rail, every server-side ingest (RTMP / file-sim / file) is the
 *  analyzer rail. This is the difference between quoting $3.13/h and $4.16/h
 *  (spec §3: "a browser stream uncapped is $3.13/h, not $4.16/h"). */
export type DecideRail = "browser" | "analyzer";

export function decideRailForSource(source: string | undefined | null): DecideRail {
  return source === "browser" || source === "screen" ? "browser" : "analyzer";
}

/** Opportunities per 300 s of content clock at this cadence on this rail. */
export function decideOpportunitiesPer300s(rail: DecideRail, cadenceSec: number): number {
  const cadence = normaliseCadence(cadenceSec);
  return DECIDE_OPPORTUNITIES_3S_PER_300S[rail] * DECIDE_CADENCE_GROWTH[rail][cadence];
}

/** The MEASURED band for the browser rail scaled to this cadence. The analyzer
 *  rail has no measured band (it is a single ratified cell), so its band is the
 *  point. */
export function decideBandPer300s(rail: DecideRail, cadenceSec: number): [number, number] {
  const cadence = normaliseCadence(cadenceSec);
  const point = decideOpportunitiesPer300s(rail, cadence);
  if (rail !== "browser") return [point, point];
  return [
    DECIDE_BROWSER_BAND_3S_PER_300S.low * DECIDE_CADENCE_GROWTH.browser[cadence],
    DECIDE_BROWSER_BAND_3S_PER_300S.high * DECIDE_CADENCE_GROWTH.browser[cadence],
  ];
}

/**
 * `est-v2` (spec rev 3 §3):
 *
 *   usdPerHour = min(rateCapPer300s ?? N, N) × usdPerDecide × 12
 *
 * `N` is the rail/cadence opportunity density, so a cap above N is priced at N
 * (a cap can never bill more than the rail offers) and an uncapped job is priced
 * at N. The band is the same expression over the measured band edges, which is
 * what makes the printed range honest on the browser rail.
 *
 * Returned UNROUNDED; the display layer rounds to cents and prints the band
 * beside the point.
 */
export function estimateDecideUsdPerHour(input: {
  cadenceSec?: number;
  rateCapPer300s?: number | null;
  rail: DecideRail;
}): {
  usdPerHour: number;
  bandUsdPerHour: [number, number];
  opportunitiesPer300s: number;
  chargedDecidesPer300s: number;
  estimateVersion: typeof DECIDE_ESTIMATE_VERSION;
} {
  const cadenceSec = normaliseCadence(input.cadenceSec);
  const opportunitiesPer300s = decideOpportunitiesPer300s(input.rail, cadenceSec);
  const [bandLow, bandHigh] = decideBandPer300s(input.rail, cadenceSec);
  const cap = input.rateCapPer300s === null || input.rateCapPer300s === undefined
    ? null
    : Number(input.rateCapPer300s);
  const charged = cap === null ? opportunitiesPer300s : Math.min(cap, opportunitiesPer300s);
  const low = cap === null ? bandLow : Math.min(cap, bandLow);
  const high = cap === null ? bandHigh : Math.min(cap, bandHigh);
  return {
    usdPerHour: usdFor(charged),
    bandUsdPerHour: [usdFor(low), usdFor(high)],
    opportunitiesPer300s,
    chargedDecidesPer300s: charged,
    estimateVersion: DECIDE_ESTIMATE_VERSION,
  };
}

/** `decides / 300 s` -> `$/h` on the content clock (12 five-minute blocks/h). */
function usdFor(decidesPer300s: number): number {
  return decidesPer300s * DECIDE_USD_PER_DECIDE * 12;
}

function normaliseCadence(cadenceSec: number | undefined): DecideCadenceSec {
  return Number(cadenceSec) === 3 ? 3 : DECIDE_CADENCE_DEFAULT;
}

/** A submitted cadence is either absent (=> default) or exactly one of the
 *  offered values; anything else must not be silently coerced into a posture
 *  the user did not choose. */
export function isDecideCadence(cadenceSec: unknown): cadenceSec is DecideCadenceSec {
  return DECIDE_CADENCE_OPTIONS.includes(Number(cadenceSec) as DecideCadenceSec);
}

/** Why a submitted rate cap was refused. `decide_rate_below_coverage_floor` is
 *  the 422 code the route returns. */
export type DecideKnobRejection = {
  ok: false;
  code: "decide_rate_below_coverage_floor" | "decide_rate_invalid" | "decide_cadence_invalid";
  message: string;
};

export type DecideKnobAccepted = {
  ok: true;
  cadenceSec: DecideCadenceSec;
  rateCapPer300s: number | null;
};

/**
 * Validate a SUBMITTED knob (route-level). Absent inputs are legal and resolve
 * to the defaults; a present-but-invalid one is a 422 rather than a silent
 * default, because a user who asked for 62 decides / 5 min must be told the gap
 * is a coverage floor, not quietly upgraded to 63.
 */
export function validateDecideKnobInput(input: {
  cadenceSec?: unknown;
  rateCapPer300s?: unknown;
}): DecideKnobAccepted | DecideKnobRejection {
  const rawCadence = input.cadenceSec;
  if (rawCadence !== undefined && rawCadence !== null) {
    if (!isDecideCadence(rawCadence)) {
      return {
        ok: false,
        code: "decide_cadence_invalid",
        message: `cadenceSec must be one of ${DECIDE_CADENCE_OPTIONS.join(", ")} (got ${String(rawCadence)})`,
      };
    }
  }
  const cadenceSec: DecideCadenceSec =
    rawCadence === undefined || rawCadence === null ? DECIDE_CADENCE_DEFAULT : (Number(rawCadence) as DecideCadenceSec);
  const rawCap = input.rateCapPer300s;
  if (rawCap === undefined || rawCap === null) {
    return { ok: true, cadenceSec, rateCapPer300s: null };
  }
  const cap = Number(rawCap);
  if (!Number.isInteger(cap) || cap <= 0) {
    return {
      ok: false,
      code: "decide_rate_invalid",
      message: `rateCapPer300s must be a positive integer or null (got ${String(rawCap)})`,
    };
  }
  if (cap < DECIDE_RATE_FLOOR_PER_300S) {
    return {
      ok: false,
      code: "decide_rate_below_coverage_floor",
      message:
        `rateCapPer300s ${cap} is below the ${DECIDE_RATE_FLOOR_PER_300S}-decide coverage floor ` +
        `(ADAAAA-8427): a cap under it would skip windows the coverage pass requires`,
    };
  }
  return { ok: true, cadenceSec, rateCapPer300s: cap };
}

/** Which rule produced the resolved knob. `env` means the job predates the knob
 *  and the deploy-time `LIVE_DECIDE_KEEP_RATIO` is still in force — a grader
 *  must not read that record's null cap as "the user asked for uncapped". */
export type DecideKnobSource = "user" | "default" | "env";

/** The stamp written once at job start (never rewritten mid-stream). */
export interface DecideKnobStamp {
  cadenceSec: DecideCadenceSec;
  rateCapPer300s: number | null;
  resolvedSource: DecideKnobSource;
  opportunitiesPer300s: number;
  usdPerDecide: number;
  predictedUsdPerHour: number;
  predictedBandUsdPerHour: [number, number];
  estimateVersion: string;
}

/**
 * Resolve the knob ONCE, at job start, and produce the stamp.
 *
 * Resolution order:
 *   1. the user's submitted values (`resolvedSource: "user"` when either input
 *      was supplied);
 *   2. the shipped default (`default`: cadence 5, uncapped);
 *   3. `env` — a job whose observer is still driven by the deploy-time
 *      `LIVE_DECIDE_KEEP_RATIO`, which is the only posture a pre-knob build can
 *      have.
 */
export function resolveDecideKnob(input: {
  cadenceSec?: unknown;
  rateCapPer300s?: unknown;
  rail: DecideRail;
  /** Deployment-level fallback: a rate cap configured in the environment. Absent
   *  on the shipped build (the env carries the legacy ratio, not a rate). */
  envRateCapPer300s?: number | null;
  /** The legacy fraction, reported so a stamped record says which posture ran. */
  envDecideKeepRatio?: number;
  /** True when the caller knows the job predates the knob (no user input at all
   *  and the env ratio is what the observer will use). */
  legacyEnvPosture?: boolean;
}): DecideKnobStamp {
  const validated = validateDecideKnobInput(input);
  const userSupplied =
    (input.cadenceSec !== undefined && input.cadenceSec !== null) ||
    (input.rateCapPer300s !== undefined && input.rateCapPer300s !== null);
  const user = validated.ok ? validated : null;
  const cadenceSec: DecideCadenceSec = user ? user.cadenceSec : DECIDE_CADENCE_DEFAULT;
  let rateCapPer300s: number | null = user ? user.rateCapPer300s : null;
  let resolvedSource: DecideKnobSource = userSupplied && user ? "user" : "default";
  if (!userSupplied && input.legacyEnvPosture) {
    resolvedSource = "env";
    const envCap = input.envRateCapPer300s;
    if (envCap !== undefined && envCap !== null && Number.isFinite(Number(envCap))) {
      const n = Number(envCap);
      rateCapPer300s = n >= DECIDE_RATE_FLOOR_PER_300S ? Math.floor(n) : null;
    }
  }
  const estimate = estimateDecideUsdPerHour({ cadenceSec, rateCapPer300s, rail: input.rail });
  return {
    cadenceSec,
    rateCapPer300s,
    resolvedSource,
    opportunitiesPer300s: estimate.opportunitiesPer300s,
    usdPerDecide: DECIDE_USD_PER_DECIDE,
    predictedUsdPerHour: estimate.usdPerHour,
    predictedBandUsdPerHour: estimate.bandUsdPerHour,
    estimateVersion: estimate.estimateVersion,
  };
}

// --- the control copy ------------------------------------------------------
//
// Spec §1: "A setting that trades latency for cost must carry the trade in its
// label." The 5 s preset is the only latency-trading value, so the trade lives
// in that option's own label (not a tooltip): the default now spends the top of
// the 1-5 s budget to buy the cheaper posture.

export const DECIDE_CADENCE_LABEL_3S = "Live cadence — 3 s (within the 1-5 s latency budget)";
export const DECIDE_CADENCE_LABEL_5S = "Economy — up to 5 s to flag - top of the 1-5 s budget";

export function decideCadenceLabel(cadenceSec: number): string {
  return Number(cadenceSec) === 3 ? DECIDE_CADENCE_LABEL_3S : DECIDE_CADENCE_LABEL_5S;
}

/** Cents-rounded dollars, e.g. `$3.13/h`. */
export function formatUsdPerHour(usd: number): string {
  return `$${usd.toFixed(2)}/h`;
}

/**
 * The spend-cap label the control prints: the calibrated point BESIDE its
 * measured band, e.g. `approx $3.13/h (measured band $2.91-$3.38)`. Never a
 * bare point — the browser rail varies stream to stream (spec §2).
 */
export function decideEstimateLabel(input: {
  cadenceSec?: number;
  rateCapPer300s?: number | null;
  rail: DecideRail;
}): string {
  const est = estimateDecideUsdPerHour(input);
  return `approx ${formatUsdPerHour(est.usdPerHour)} (measured band ${formatUsdPerHour(
    est.bandUsdPerHour[0]
  )}-${formatUsdPerHour(est.bandUsdPerHour[1])})`;
}

// --- contract schemas ------------------------------------------------------

/** The stamp as persisted (`observeMetrics.decideKnob`) and echoed by the window
 *  audit. Additive optional on the job record: absent on every row written
 *  before ADAAAA-8544, which `resolvedSource: "env"` also covers. */
export const DecideKnobStampSchema = z.object({
  cadenceSec: z.union([z.literal(3), z.literal(5)]),
  rateCapPer300s: z.number().int().positive().nullable(),
  resolvedSource: z.enum(["user", "default", "env"]),
  opportunitiesPer300s: z.number().positive(),
  usdPerDecide: z.number().positive(),
  predictedUsdPerHour: z.number().min(0),
  predictedBandUsdPerHour: z.tuple([z.number().min(0), z.number().min(0)]),
  estimateVersion: z.string(),
});
export type DecideKnobStampValue = z.infer<typeof DecideKnobStampSchema>;

/** The submitted knob on `POST /jobs`. Absent = the shipped default. */
export const DecideKnobInputSchema = z.object({
  cadenceSec: z.union([z.literal(3), z.literal(5)]).nullish(),
  rateCapPer300s: z.number().int().positive().nullish(),
});
