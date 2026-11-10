// ADAAAA-8487 (AC-B / AC-C): the GRADER for one live leg.
//
// Why this module exists
// ----------------------
// AC-B (`deliveredLatency` p95 <= 5 s and p50 <= 3 s) and AC-C (accepted >= 9
// and delivered GOAL rows = 0) were graded by hand off a stored job record, and
// the hand grade got the leg SHAPE wrong twice on this ticket:
//
//   - a 320 s hard stop truncates the 9-row reference leg at 7 rows, and p95 on
//     n=7 is exactly the UNMEASURED case AC-B forbids;
//   - a natural leg shorter than 600 s lands ~0.0134 accepted/s * 300 s = 4
//     rows, so it also cannot be graded.
//
// A leg that is too short or too empty must read UNMEASURED, never FAIL, and
// that rule must be mechanical: a monitor run that re-derives it from prose
// re-derives it differently. So the classification is pinned ONCE here, from
// the same per-row numbers `deliveredLatencySummary` (live-delivery.ts) writes
// into the record, and percentile arithmetic is imported from that module so
// the grader cannot drift from the stored p50/p95 it grades.
//
// What it does NOT do: it does not watch a clock, stop a leg, or spend money.
// The funded-cell harness (ADAAAA-8489) owns the stop and the quiet-window
// preflight; this module only decides what a finished leg's numbers mean.

import { percentile } from "./live-delivery";

export type LiveLegMode = "natural" | "funded";

/** Where the graded duration came from. ADAAAA-8529 item 3: a live `done`
 * record carries no startedAt/endedAt/finishedAt, so a leg graded on the record
 * alone read `duration_unknown` against the 480 s floor even when the harness
 * stopped it at exactly 480 s. The source is published beside the number so a
 * reader never confuses a record clock with the harness's own leg window. */
export type DurationSource = "input" | "timestamps" | "harness_evidence" | "unknown";

/** PASS / FAIL are about the acceptance bars. UNMEASURED means the leg cannot
 * answer the bar (empty, decide-bound, too short, too few rows) — it is never a
 * FAIL, and it is never a PASS. */
export type LegVerdict = "PASS" | "FAIL" | "UNMEASURED";

/** The delivered rows as stored (`observeMetrics.deliveredLatency.rows`). */
export interface LiveLegRowLike {
  triggerTs: number;
  deliveredLatencyMs: number;
  fireLagMs: number;
  decideE2eMs: number;
  acceptWaitMs: number;
  acceptMs: number;
  persistAckMs: number;
  /** ADAAAA-8495 additive optional: the localization term, part of the stage sum. */
  localizeOffsetMs?: number;
  /** ADAAAA-8495 additive optional: the row id (the metric's dedupe key). */
  highlightId?: string;
}

/** The bars this ticket is graded against. One place, so the grader, the leg
 * evidence and the result comment quote the same numbers. */
export const LIVE_LEG_BARS = {
  /** AC-B: deliveredLatency p50 <= 3.0 s. */
  p50Ms: 3_000,
  /** AC-B: deliveredLatency p95 <= 5.0 s. */
  p95Ms: 5_000,
  /** AC-B is only gradeable at n >= 9 delivered rows. */
  minDeliveredRows: 9,
  /** AC-B above the 12B-baseline decide p50 of ~2.2 s is a decide-bound leg,
   * not a delivery-bound one: grading a delivery bar there measures the wrong
   * stage. */
  decideP50Ms: 3_000,
  /** A natural leg is first gradeable at >= 600 s (natural density measured
   * 9 accepted / 672 s = 0.0134/s; a shorter leg lands n < 9). */
  naturalFloorS: 600,
  /** Funded leg authorized shape: 480 s, hard stop 500 s (ADAAAA-8516). */
  fundedFloorS: 480,
  /** AC-C: accepted rows >= 9 on the same fixture family. */
  minAcceptedRows: 9,
  /** AC-C: delivered GOAL rows = 0. */
  maxDeliveredGoalRows: 0,
  /** AC-C secondary read when the fixture differs: the baseline ratio
   * (9 accepted / 147 candidates) from `c4d33a26`. Not a lowered bar. */
  baselineAcceptedRatio: 9 / 147,
} as const;

export interface LiveLegInput {
  mode: LiveLegMode;
  rows: LiveLegRowLike[];
  /** Wall duration of the leg in seconds. Derived from `startedAt`/`endedAt`
   * (or `finishedAt`) when those are supplied instead; an explicit duration (the
   * harness's metered wall clock) wins over both. */
  durationS?: number;
  /** Provenance of `durationS` when the caller supplied it (the funded harness
   * writes `leg.durationS` from its own clock). Defaults to `input`. */
  durationSource?: DurationSource;
  startedAt?: string;
  /** ADAAAA-8487: end of accrual — the field the live settlements stamp. Read
   * before `finishedAt` because it excludes the clip-finalization tail. */
  endedAt?: string;
  finishedAt?: string;
  /** Metered perceive-session seconds (8483 metered 544.5 s inside a 300 s
   * authorized window: the 1.815x inflation the funded cap must evidence). */
  perceiveSessionS?: number;
  /** decide p50 from the leg's own evidence. Omitted = the decide-bound gate is
   * reported as not evaluated rather than silently passing. */
  decideP50Ms?: number;
  /** AC-C inputs. Omitted = AC-C is not evaluated on this leg. */
  accepted?: number;
  candidates?: number;
  /** Delivered rows whose `eventType` is GOAL (a suppressed GOAL is delivered
   * under its demoted type, so this counts delivered GOALs, not candidates). */
  deliveredGoalRows?: number;
}

export interface AcGrade {
  status: LegVerdict;
  reasons: string[];
}

export interface LiveLegGrade {
  mode: LiveLegMode;
  verdict: LegVerdict;
  reasons: string[];
  n: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Wall duration (s) when known; null when neither durationS nor timestamps
   * were supplied. */
  durationS: number | null;
  /** Where `durationS` came from (ADAAAA-8529 item 3). `harness_evidence` means
   * the job record carried no clock and the leg's own harness window was used. */
  durationSource: DurationSource;
  floorS: number;
  perceiveSessionS?: number;
  /** Metered seconds / wall seconds: 8483 read 1.815x because of container
   * startup/teardown. Absent when either input is missing. */
  meteredToWallRatio?: number;
  acB: AcGrade & { p50Ms: number; p95Ms: number };
  acC?: AcGrade & {
    accepted: number;
    candidates?: number;
    deliveredGoalRows: number;
    acceptedRatio?: number;
    baselineAcceptedRatio: number;
    ratioAtLeastBaseline?: boolean;
  };
  /** Rows whose stage sum (+ `localizeOffsetMs` when present) disagrees with
   * their own `deliveredLatencyMs`. >0 means the row cannot reconstruct its own
   * total, which is the ADAAAA-8495 schema-strip failure mode; 0 means the
   * decomposition is self-consistent. */
  stageSumMismatchRows: number;
}

function roundMs(n: number): number {
  return Math.round(n);
}

function resolveDuration(input: LiveLegInput): { durationS: number | null; source: DurationSource } {
  if (Number.isFinite(input.durationS) && (input.durationS as number) >= 0) {
    return { durationS: input.durationS as number, source: input.durationSource ?? "input" };
  }
  // ADAAAA-8487: the live terminal paths stamp `endedAt` (end of accrual) and
  // `finishedAt` (end of finalization). Prefer `endedAt` so the duration is the
  // time the leg actually accrued, not the clip-finalization tail after it.
  const ended = input.endedAt ?? input.finishedAt;
  if (input.startedAt && ended) {
    const start = Date.parse(input.startedAt);
    const end = Date.parse(ended);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return { durationS: (end - start) / 1000, source: "timestamps" };
    }
  }
  return { durationS: null, source: "unknown" };
}

function stageSum(row: LiveLegRowLike): number {
  return (
    row.fireLagMs +
    row.decideE2eMs +
    row.acceptWaitMs +
    row.acceptMs +
    row.persistAckMs +
    (Number.isFinite(row.localizeOffsetMs) ? (row.localizeOffsetMs as number) : 0)
  );
}

/**
 * Grade one finished leg. Pure: no clock, no network, no store.
 *
 * Order of gates matters — a leg is checked for SHAPE (empty / decide-bound /
 * too short / too few rows) before its numbers are compared to the bars, so a
 * short leg reports `UNMEASURED` with the shape reason instead of a FAIL earned
 * from a truncated sample.
 */
export function gradeLiveLeg(input: LiveLegInput): LiveLegGrade {
  const rows = input.rows;
  const n = rows.length;
  const totals = rows.map((r) => r.deliveredLatencyMs).sort((a, b) => a - b);
  const p50Ms = totals.length ? roundMs(percentile(totals, 50)) : 0;
  const p95Ms = totals.length ? roundMs(percentile(totals, 95)) : 0;
  const maxMs = totals.length ? totals[totals.length - 1] : 0;

  const resolved = resolveDuration(input);
  const durationS = resolved.durationS;
  const durationSource = resolved.source;
  const floorS = input.mode === "natural" ? LIVE_LEG_BARS.naturalFloorS : LIVE_LEG_BARS.fundedFloorS;
  const meteredToWallRatio =
    Number.isFinite(input.perceiveSessionS) && durationS !== null && durationS > 0
      ? (input.perceiveSessionS as number) / durationS
      : undefined;

  const shapeReasons: string[] = [];
  let shapeBlocked = false;

  if (n === 0) {
    // An empty window is a re-arm, never a FAIL: there was nothing to deliver.
    shapeReasons.push("empty_window: 0 delivered rows (re-arm, never FAIL)");
    shapeBlocked = true;
  }
  if (input.decideP50Ms === undefined) {
    shapeReasons.push("decide_p50_not_evaluated: no decide p50 supplied (delivery bar not proven decide-independent)");
  } else if (input.decideP50Ms > LIVE_LEG_BARS.decideP50Ms) {
    shapeReasons.push(
      `decide_bound: decide p50 ${roundMs(input.decideP50Ms)} ms > ${LIVE_LEG_BARS.decideP50Ms} ms — grade the decide stage, not delivery`
    );
    shapeBlocked = true;
  }
  if (durationS === null) {
    shapeReasons.push(
      "duration_unknown: no duration, no startedAt/endedAt pair, no --duration-s, and no harness leg evidence supplied"
    );
    shapeBlocked = true;
  } else if (durationS < floorS) {
    shapeReasons.push(
      `duration_below_floor: ${durationS.toFixed(1)} s < ${floorS} s (${input.mode}) — the leg cannot reach n >= ${LIVE_LEG_BARS.minDeliveredRows} at this density`
    );
    shapeBlocked = true;
  }
  if (n > 0 && n < LIVE_LEG_BARS.minDeliveredRows) {
    shapeReasons.push(`n_below_9: ${n} delivered rows < ${LIVE_LEG_BARS.minDeliveredRows}`);
    shapeBlocked = true;
  }

  const acB: LiveLegGrade["acB"] = { status: "UNMEASURED", reasons: [...shapeReasons], p50Ms, p95Ms };
  if (!shapeBlocked) {
    const over: string[] = [];
    if (p50Ms > LIVE_LEG_BARS.p50Ms) over.push(`p50 ${p50Ms} ms > ${LIVE_LEG_BARS.p50Ms} ms`);
    if (p95Ms > LIVE_LEG_BARS.p95Ms) over.push(`p95 ${p95Ms} ms > ${LIVE_LEG_BARS.p95Ms} ms`);
    acB.status = over.length ? "FAIL" : "PASS";
    acB.reasons = over.length
      ? ["over_bar: " + over.join(" ; ")]
      : [`within_bar: p50 ${p50Ms} ms <= ${LIVE_LEG_BARS.p50Ms} ms and p95 ${p95Ms} ms <= ${LIVE_LEG_BARS.p95Ms} ms on n=${n}`];
    // A PASS on n rows does not prove the delivery bar decide-independent: the
    // missing decide p50 stays visible on the graded verdict instead of being
    // absorbed by the PASS.
    if (input.decideP50Ms === undefined) {
      acB.reasons.push("decide_p50_not_evaluated: no decide p50 supplied (delivery bar not proven decide-independent)");
    }
  }

  let acC: LiveLegGrade["acC"];
  if (input.accepted !== undefined && input.deliveredGoalRows !== undefined) {
    const accepted = input.accepted;
    const deliveredGoalRows = input.deliveredGoalRows;
    const acceptedRatio =
      input.candidates !== undefined && input.candidates > 0 ? accepted / input.candidates : undefined;
    const ratioAtLeastBaseline =
      acceptedRatio === undefined ? undefined : acceptedRatio >= LIVE_LEG_BARS.baselineAcceptedRatio;
    const reasons: string[] = [];
    if (shapeBlocked) {
      // The counts on a shape-blocked leg are a duration artifact, not a
      // regression: a 320 s stop legitimately lands fewer accepted rows. Grade
      // AC-C only on a leg whose shape can answer the bar.
      reasons.push(
        "leg_shape_unmeasured: accepted / delivered-GOAL counts on a shape-blocked leg are a duration artifact, not an AC-C regression"
      );
    }
    if (accepted < LIVE_LEG_BARS.minAcceptedRows) {
      reasons.push(`accepted_below_9: ${accepted} < ${LIVE_LEG_BARS.minAcceptedRows}`);
    }
    if (deliveredGoalRows > LIVE_LEG_BARS.maxDeliveredGoalRows) {
      reasons.push(`delivered_goal_rows: ${deliveredGoalRows} > ${LIVE_LEG_BARS.maxDeliveredGoalRows}`);
    }
    if (acceptedRatio !== undefined) {
      reasons.push(
        `accepted_ratio: ${(acceptedRatio * 100).toFixed(2)} % vs baseline ${(LIVE_LEG_BARS.baselineAcceptedRatio * 100).toFixed(2)} % (secondary read, not a bar)`
      );
    }
    const acCFailed = reasons.some((r) => r.startsWith("accepted_below_9") || r.startsWith("delivered_goal_rows"));
    acC = {
      status: shapeBlocked ? "UNMEASURED" : acCFailed ? "FAIL" : "PASS",
      reasons,
      accepted,
      candidates: input.candidates,
      deliveredGoalRows,
      acceptedRatio,
      baselineAcceptedRatio: LIVE_LEG_BARS.baselineAcceptedRatio,
      ratioAtLeastBaseline,
    };
  }

  const statuses: LegVerdict[] = [acB.status, ...(acC ? [acC.status] : [])];
  const verdict: LegVerdict = statuses.includes("FAIL")
    ? "FAIL"
    : statuses.includes("UNMEASURED")
      ? "UNMEASURED"
      : "PASS";

  let stageSumMismatchRows = 0;
  for (const row of rows) {
    const sum = stageSum(row);
    if (Math.abs(sum - row.deliveredLatencyMs) > 1) stageSumMismatchRows += 1;
  }

  const reasons: string[] = [];
  if (verdict === "UNMEASURED") reasons.push(...acB.reasons.filter((r) => !r.startsWith("within_bar")));
  if (verdict === "FAIL") {
    if (acB.status === "FAIL") reasons.push(...acB.reasons);
    if (acC?.status === "FAIL") reasons.push(...acC.reasons.filter((r) => !r.startsWith("accepted_ratio")));
  }

  return {
    mode: input.mode,
    verdict,
    reasons,
    n,
    p50Ms,
    p95Ms,
    maxMs,
    durationS,
    durationSource,
    floorS,
    perceiveSessionS: input.perceiveSessionS,
    meteredToWallRatio,
    acB,
    ...(acC ? { acC } : {}),
    stageSumMismatchRows,
  };
}
