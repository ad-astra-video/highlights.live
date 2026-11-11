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
  /** ADAAAA-8611 additive optional: which ASR road the row's decide took and what
   *  the wait cost (`prefetched` | `miss` | `waitmiss` | `inline`). Attribution
   *  INSIDE `decideE2eMs` — never a term of the stage sum. Absent on rows written
   *  before this field existed, which is why it is optional here. */
  asrLane?: "prefetched" | "miss" | "waitmiss" | "inline";
  asrWaitMs?: number;
  asrPrefetchMs?: number;
}

/** The bars this ticket is graded against. One place, so the grader, the leg
 * evidence and the result comment quote the same numbers. */
export const LIVE_LEG_BARS = {
  /** AC-B legacy bar: deliveredLatency p50 <= 3.0 s. Kept as the left column of
   * the delta table — the pre-amendment number, not the bar in force. */
  p50Ms: 3_000,
  /** AC-B bar IN FORCE: deliveredLatency p50 <= 4.0 s, amended by CEO ruling A
   * on ADAAAA-8528 (`cap-record` rev `ed4cfb59`, 2026-11-10T00:47Z). Grading
   * uses this one for the AC-B verdict; the legacy 3.0 s bar is reported beside
   * it so the amendment's delta stays auditable instead of silently dropped. */
  p50MsInForce: 4_000,
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
  /** AC-C's actual bar on the goal-dense shape-2 fixture: delivered GOAL rows
   * whose own attestation did NOT measure a scoreboard change (and are therefore
   * false positives). `deliveredGoalRows` alone cannot carry the verdict there —
   * the fixture re-presents 4 real score transitions, so delivering GOALs is
   * correct and the 8483 "0 delivered GOAL" count is the wrong instrument. When
   * supplied, this is the bar and `deliveredGoalRows` is reported as context. */
  goalFalsePositiveRows?: number;
  /** ADAAAA-8487 AC-B shape amendment: the fixture's `N` anchors, pre-committed
   * by the `$0` OCR census BEFORE the leg runs (`N >= 9` required). Supplying
   * this WITH `rowAnchors` makes `n` an anchor count instead of a row count —
   * the amendment's whole point, because a row count can be inflated by a
   * second row at an anchor that was already delivered. */
  fixtureAnchors?: FixtureAnchorLike[];
  /** Where each delivered row localized in content time, so the row can be
   * attributed to an anchor. Same order does not matter: rows are matched by
   * the fields they carry. */
  rowAnchors?: RowAnchorLike[];
  /** How far (content seconds) a row may sit from an anchor and still own it.
   * Defaults to half the smallest gap the census would produce; a row outside
   * it is reported as unresolved rather than snapped to a neighbour. */
  anchorMaxGapS?: number;
  /** The leg's AUTHORIZED window in seconds, from its cap record. The default
   * floors are the 480 s funded / 600 s natural shapes, but `cap-record-2`
   * authorized a 410 s shape-2 leg — grading that leg against 480 s would read
   * `duration_below_floor` on a leg that ran its authorized shape exactly. The
   * value comes from the cap record, never from the leg. */
  authorizedDurationS?: number;
}

/** One fixture anchor: the census window the leg's content re-presents. `atS` is
 * the content second the window's score transition sits at, `transition` the
 * physical transition it re-presents (the fixture cannot exceed the content
 * ceiling — 4 on the 8154 reel). */
export interface FixtureAnchorLike {
  id: string;
  atS: number;
  transition: number;
}

/** A delivered row's localization, as the stored highlight carries it. */
export interface RowAnchorLike {
  highlightId?: string;
  triggerTs: number;
  /** `localizedTs` on the stored highlight. Preferred over `triggerTs` because
   * the trigger is a candidate timestamp and the localization is where the
   * moment actually was. */
  localizedTs?: number;
}

/** AC-B shape amendment readout: `n` anchored rows over `N` anchors, with the
 * duplicate and uncovered anchors named so "fixture re-presents a transition"
 * and "coverage regressed" stay separable. */
export interface AnchorAccounting {
  /** `N` — anchors in the fixture, from the pre-run census. */
  anchors: number;
  /** Rows that resolved to an anchor (<= delivered rows). */
  resolvedRows: number;
  /** `n` — anchors owned by exactly one counted row. This is AC-B's `n`. */
  nAnchored: number;
  /** Anchors that received more than one row, with those rows' ids. */
  duplicateAnchors: { id: string; transition: number; rows: string[] }[];
  /** Anchors in the fixture that no row covered. */
  uncoveredAnchors: string[];
  /** Distinct physical transitions covered (<= `physicalTransitions`). */
  distinctMoments: number;
  /** Physical transitions the fixture holds (4 on the ADAAAA-8154 reel). */
  physicalTransitions: number;
  /** Rows that never resolved to an anchor. Reported, never silently dropped:
   * a row outside every anchor's gap is a localization problem, not coverage. */
  unresolvedRows: string[];
}


export interface AcGrade {
  status: LegVerdict;
  reasons: string[];
}

/** The two p50 bars a prospective leg reports against (ADAAAA-8487 AC-B). */
export interface P50BarRead {
  /** The bar the AC-B verdict is graded against: the amended one in force. */
  inForceMs: number;
  /** The pre-amendment bar, kept as the delta table's left column. */
  legacyMs: number;
  inForcePass: boolean;
  legacyPass: boolean;
  /** `both` = clears 3.0 s and 4.0 s; `legacy_only` = the amendment is what
   * makes it pass (the exact case the amendment exists for); `neither`. */
  delta: "both" | "legacy_only" | "neither";
}

export interface LiveLegGrade {
  mode: LiveLegMode;
  verdict: LegVerdict;
  reasons: string[];
  /** AC-B's `n` when anchor accounting is supplied (anchors owned by exactly one
   * row), else the delivered-row count. */
  n: number;
  /** Delivered rows on the leg, always. Published beside `n` so a row count is
   * never read as anchored coverage (ADAAAA-8487 AC-B shape amendment). */
  nRows: number;
  /** Present only when `fixtureAnchors` + `rowAnchors` were supplied. Absent
   * means `n` is a row count and the leg says so in its reasons. */
  anchors?: AnchorAccounting;
  p50Ms: number;
  p95Ms: number;
  /** AC-B estimator disclosure: the nearest-rank p95 (`sorted[ceil(0.95n)-1]`),
   * which at n < 20 IS the max row. `p95Ms` stays the metric of record — the
   * product's `deliveredLatencySummary` interpolates between the two nearest
   * ranks — but a single over-bar tail row must be visible on the verdict, not
   * averaged away by that interpolation (ADAAAA-8487 leg a7d61806: p95 4,583 ms
   * PASS vs nearest-rank 5,630 ms). */
  p95NearestRankMs: number;
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
  acB: AcGrade & { p50Ms: number; p95Ms: number; p95NearestRankMs: number; p50Bars: P50BarRead };
  acC?: AcGrade & {
    accepted: number;
    candidates?: number;
    deliveredGoalRows: number;
    /** AC-C's bar when the caller measured false positives explicitly. */
    goalFalsePositiveRows?: number;
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

/** A row's content second: its localization when it has one, else its trigger. */
function rowContentTs(row: RowAnchorLike): number {
  return Number.isFinite(row.localizedTs) ? (row.localizedTs as number) : row.triggerTs;
}

/**
 * Attribute delivered rows to the fixture's census anchors (ADAAAA-8487 AC-B
 * shape amendment). Pure, like the grader: no clock, no store.
 *
 * `n` is the number of anchors owned by a row — an anchor delivered twice counts
 * once, which is exactly the `merged_duplicate` / re-measured-twin case the
 * amendment exists for. `unresolvedRows` carries rows that sat outside every
 * anchor's gap instead of snapping them onto a neighbouring anchor, because a
 * silent snap would manufacture coverage.
 */
export function accountAnchors(
  fixtureAnchors: FixtureAnchorLike[],
  rowAnchors: RowAnchorLike[],
  anchorMaxGapS?: number
): AnchorAccounting {
  const gap =
    Number.isFinite(anchorMaxGapS) && (anchorMaxGapS as number) > 0
      ? (anchorMaxGapS as number)
      : defaultAnchorGapS(fixtureAnchors);
  const byAnchor = new Map<string, { anchor: FixtureAnchorLike; rows: string[] }>();
  const unresolvedRows: string[] = [];

  rowAnchors.forEach((row, index) => {
    const at = rowContentTs(row);
    const label = row.highlightId ?? `row#${index}@${row.triggerTs}s`;
    if (!Number.isFinite(at)) {
      unresolvedRows.push(label);
      return;
    }
    let best: FixtureAnchorLike | undefined;
    let bestDistance = Infinity;
    for (const anchor of fixtureAnchors) {
      const distance = Math.abs(anchor.atS - at);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = anchor;
      }
    }
    if (!best || bestDistance > gap) {
      unresolvedRows.push(label);
      return;
    }
    const slot = byAnchor.get(best.id) ?? { anchor: best, rows: [] };
    slot.rows.push(label);
    byAnchor.set(best.id, slot);
  });

  const duplicates = [...byAnchor.values()]
    .filter((slot) => slot.rows.length > 1)
    .map((slot) => ({ id: slot.anchor.id, transition: slot.anchor.transition, rows: slot.rows }));

  return {
    anchors: fixtureAnchors.length,
    resolvedRows: rowAnchors.length - unresolvedRows.length,
    nAnchored: byAnchor.size,
    duplicateAnchors: duplicates,
    uncoveredAnchors: fixtureAnchors.filter((anchor) => !byAnchor.has(anchor.id)).map((a) => a.id),
    distinctMoments: new Set([...byAnchor.values()].map((slot) => slot.anchor.transition)).size,
    physicalTransitions: new Set(fixtureAnchors.map((anchor) => anchor.transition)).size,
    unresolvedRows,
  };
}

/** Half the closest anchor spacing: a row is attributed to an anchor only inside
 * its own window, never across a boundary into a neighbour's. */
function defaultAnchorGapS(fixtureAnchors: FixtureAnchorLike[]): number {
  const sorted = fixtureAnchors.map((a) => a.atS).sort((a, b) => a - b);
  let closest = Infinity;
  for (let i = 1; i < sorted.length; i += 1) {
    closest = Math.min(closest, sorted[i] - sorted[i - 1]);
  }
  return Number.isFinite(closest) ? closest / 2 : 17;
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
  const nRows = rows.length;
  // ADAAAA-8487 AC-B shape amendment: when the fixture's census anchors and the
  // rows' localizations are supplied, `n` is anchors-owned-once, not rows.
  const anchorAccounting =
    input.fixtureAnchors && input.rowAnchors
      ? accountAnchors(input.fixtureAnchors, input.rowAnchors, input.anchorMaxGapS)
      : undefined;
  const n = anchorAccounting ? anchorAccounting.nAnchored : nRows;
  const totals = rows.map((r) => r.deliveredLatencyMs).sort((a, b) => a - b);
  const p50Ms = totals.length ? roundMs(percentile(totals, 50)) : 0;
  const p95Ms = totals.length ? roundMs(percentile(totals, 95)) : 0;
  // The metric of record interpolates, so at n = 12 the p95 sits between the
  // 11th and 12th value and one 5.6 s row reads 4.58 s. Both reads are published
  // so an in-bar p95 is never quoted without the tail row beside it.
  const p95NearestRankMs = totals.length ? totals[Math.max(0, Math.ceil(0.95 * totals.length) - 1)] : 0;
  const maxMs = totals.length ? totals[totals.length - 1] : 0;

  const resolved = resolveDuration(input);
  const durationS = resolved.durationS;
  const durationSource = resolved.source;
  const floorS =
    Number.isFinite(input.authorizedDurationS) && (input.authorizedDurationS as number) > 0
      ? (input.authorizedDurationS as number)
      : input.mode === "natural"
        ? LIVE_LEG_BARS.naturalFloorS
        : LIVE_LEG_BARS.fundedFloorS;
  const meteredToWallRatio =
    Number.isFinite(input.perceiveSessionS) && durationS !== null && durationS > 0
      ? (input.perceiveSessionS as number) / durationS
      : undefined;

  const shapeReasons: string[] = [];
  let shapeBlocked = false;

  if (nRows === 0) {
    // An empty window is a re-arm, never a FAIL: there was nothing to deliver.
    shapeReasons.push("empty_window: 0 delivered rows (re-arm, never FAIL)");
    shapeBlocked = true;
  }
  if (
    anchorAccounting &&
    anchorAccounting.anchors > 0 &&
    anchorAccounting.anchors < LIVE_LEG_BARS.minDeliveredRows
  ) {
    // The census is a pre-commitment: a fixture under `N >= 9` cannot answer the
    // bar at all, so the leg must not run and AC-B closes `N of N` with the
    // content ceiling named (ADAAAA-8570 `cap-record-2`).
    shapeReasons.push(
      `fixture_below_9_anchors: N=${anchorAccounting.anchors} < ${LIVE_LEG_BARS.minDeliveredRows} — AC-B closes N of N on the content ceiling; the leg cannot answer the bar`
    );
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
  if (nRows > 0 && n < LIVE_LEG_BARS.minDeliveredRows) {
    shapeReasons.push(
      anchorAccounting
        ? `n_below_9: ${n} anchored rows < ${LIVE_LEG_BARS.minDeliveredRows} (${nRows} delivered rows, one row per anchor)`
        : `n_below_9: ${n} delivered rows < ${LIVE_LEG_BARS.minDeliveredRows}`
    );
    shapeBlocked = true;
  }

  // ADAAAA-8487 AC-B: report p50 against BOTH bars (3.0 s legacy / 4.0 s in
  // force, the latter amended by CEO ruling A on ADAAAA-8528). The verdict uses
  // the bar in force; the legacy read rides along so the amendment's delta is
  // visible on every leg instead of being re-derived by hand afterwards.
  const p50Bars: P50BarRead = {
    inForceMs: LIVE_LEG_BARS.p50MsInForce,
    legacyMs: LIVE_LEG_BARS.p50Ms,
    inForcePass: p50Ms <= LIVE_LEG_BARS.p50MsInForce,
    legacyPass: p50Ms <= LIVE_LEG_BARS.p50Ms,
    delta:
      p50Ms <= LIVE_LEG_BARS.p50MsInForce && p50Ms <= LIVE_LEG_BARS.p50Ms
        ? "both"
        : p50Ms <= LIVE_LEG_BARS.p50MsInForce
          ? "legacy_only"
          : "neither",
  };
  const p50BarLabel = `p50 ${p50Ms} ms vs ${LIVE_LEG_BARS.p50MsInForce} ms (in force) / ${LIVE_LEG_BARS.p50Ms} ms (legacy)`;

  const acB: LiveLegGrade["acB"] = {
    status: "UNMEASURED",
    reasons: [...shapeReasons],
    p50Ms,
    p95Ms,
    p95NearestRankMs,
    p50Bars,
  };
  if (!shapeBlocked) {
    const over: string[] = [];
    if (!p50Bars.inForcePass) over.push(`${p50BarLabel} = over`);
    if (p95Ms > LIVE_LEG_BARS.p95Ms) over.push(`p95 ${p95Ms} ms > ${LIVE_LEG_BARS.p95Ms} ms`);
    acB.status = over.length ? "FAIL" : "PASS";
    acB.reasons = over.length
      ? ["over_bar: " + over.join(" ; ")]
      : [
          `within_bar: ${p50BarLabel} = within (legacy read: ${p50Bars.delta === "both" ? "PASS" : "FAIL"}) and p95 ${p95Ms} ms <= ${LIVE_LEG_BARS.p95Ms} ms on n=${n}${anchorAccounting ? ` anchored rows over N=${anchorAccounting.anchors}` : ""}`,
        ];
    // A PASS on n rows does not prove the delivery bar decide-independent: the
    // missing decide p50 stays visible on the graded verdict instead of being
    // absorbed by the PASS.
    if (input.decideP50Ms === undefined) {
      acB.reasons.push("decide_p50_not_evaluated: no decide p50 supplied (delivery bar not proven decide-independent)");
    }
    // A PASS on the metric of record must not hide a row that busts the bar on
    // its own: at n = 12 the interpolated p95 can sit 45 % of the way between the
    // 11th value and a single tail row, so the tail is named on the verdict.
    if (acB.status === "PASS" && p95NearestRankMs > LIVE_LEG_BARS.p95Ms) {
      acB.reasons.push(
        `tail_over_bar: nearest-rank p95 ${p95NearestRankMs} ms > ${LIVE_LEG_BARS.p95Ms} ms on ${totals.length} rows` +
          ` (interpolated p95 ${p95Ms} ms is the metric of record; max ${maxMs} ms) — one row, stated not discounted`,
      );
    }
  }
  if (!anchorAccounting && nRows > 0) {
    // A row count is not anchored coverage (ADAAAA-8487 AC-B shape amendment).
    // Say it on the verdict itself so a leg graded without the census cannot be
    // read as having satisfied the shape.
    acB.reasons.push(
      "anchor_accounting_absent: n is a delivered-row count, not anchored coverage — supply fixtureAnchors + rowAnchors to grade the AC-B shape amendment"
    );
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
    const goalFp = input.goalFalsePositiveRows;
    if (goalFp !== undefined) {
      // ADAAAA-8487 AC-C on the shape-2 fixture: the bar is goal FALSE POSITIVES
      // (a delivered GOAL whose attestation measured no scoreboard change), not
      // the raw GOAL count — the fixture re-presents 4 real transitions, so 10
      // delivered GOAL rows with 0 FP is the correct reading and `> 0` would
      // fail a leg for having content.
      reasons.push(
        `delivered_goal_rows: ${deliveredGoalRows} (context — a goal-dense fixture delivers real GOALs, not the bar)`
      );
      if (goalFp > LIVE_LEG_BARS.maxDeliveredGoalRows) {
        reasons.push(`goal_false_positives: ${goalFp} > ${LIVE_LEG_BARS.maxDeliveredGoalRows}`);
      }
    } else if (deliveredGoalRows > LIVE_LEG_BARS.maxDeliveredGoalRows) {
      reasons.push(`delivered_goal_rows: ${deliveredGoalRows} > ${LIVE_LEG_BARS.maxDeliveredGoalRows}`);
    }
    if (acceptedRatio !== undefined) {
      reasons.push(
        `accepted_ratio: ${(acceptedRatio * 100).toFixed(2)} % vs baseline ${(LIVE_LEG_BARS.baselineAcceptedRatio * 100).toFixed(2)} % (secondary read, not a bar)`
      );
    }
    const acCFailed = reasons.some(
      (r) =>
        r.startsWith("accepted_below_9") ||
        r.startsWith("goal_false_positives") ||
        (goalFp === undefined && r.startsWith("delivered_goal_rows"))
    );
    acC = {
      status: shapeBlocked ? "UNMEASURED" : acCFailed ? "FAIL" : "PASS",
      reasons,
      accepted,
      candidates: input.candidates,
      deliveredGoalRows,
      ...(goalFp !== undefined ? { goalFalsePositiveRows: goalFp } : {}),
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
    if (acC?.status === "FAIL")
      reasons.push(
        ...acC.reasons.filter(
          (r) =>
            !r.startsWith("accepted_ratio") &&
            // A context line is not a failure: only drop the GOAL-count wording
            // when the caller supplied the FP read that actually decided AC-C.
            !(input.goalFalsePositiveRows !== undefined && r.startsWith("delivered_goal_rows"))
        )
      );
  }

  return {
    mode: input.mode,
    verdict,
    reasons,
    n,
    nRows,
    ...(anchorAccounting ? { anchors: anchorAccounting } : {}),
    p50Ms,
    p95Ms,
    p95NearestRankMs,
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
