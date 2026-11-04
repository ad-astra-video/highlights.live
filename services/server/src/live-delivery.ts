// ADAAAA-8005 (gate 3): the per-row trigger -> DELIVERED latency metric.
//
// Why this module exists
// ----------------------
// The board's gate-3 AC ("trigger -> delivered p50 <= 5 s") had no metric that
// could satisfy it. `observeMetrics.triggerLatencyByFamily` measures onset ->
// *decided window* (stageA/judged/stageB), which is entirely PRE-delivery, and
// the only number that actually matched the AC was a hand join of two log
// families (`[live-lag:<job>] decide @Ts lag` + `[ingest-gap:<job>] decide
// e2e`). A hand join cannot be re-graded from the job record.
//
// This module pins the definition ONCE and emits the per-row number from the
// metric layer:
//
//   delivered  = the wall instant the highlight row becomes READABLE on the
//                delivered surface: the store accepts it (in-memory write), so
//                a feed read on that tick already returns it. The DB
//                write-through that follows is durability, not readability, and
//                is therefore NOT part of the measured instant.
//   trigger    = the row's own `trigger.timestamp` (content seconds), the same
//                value `row.createdAt - (startedAt + trigger.timestamp)` uses.
//
//   deliveredLatencyMs = persistAckMs - (contentOriginMs + triggerTs * 1000)
//
// where `contentOriginMs` is the wall epoch-ms of content t=0. It is derived
// once per run from the first fired window (`firedAtMs - lagMs - centerTs*1000`)
// so it is consistent BY CONSTRUCTION with the rail's own lag measurement, and
// the row total decomposes exactly into the stages a replay must blame:
//
//   deliveredLatencyMs = fireLagMs      (content ts -> cadence fire; frame
//                                        arrival/relay lag)
//                      + decideE2eMs    (fire -> decide settle, gemma e2e)
//                      + acceptWaitMs   (settle -> accept gate entry; head of
//                                        line behind an earlier window)
//                      + acceptMs       (accept gate: localize/suppress/record/
//                                        emit)
//                      + persistAckMs   (emit -> store write-through ack)
//                      + (centerTs - triggerTs) * 1000  (localized trigger vs
//                                        the judged window centre, usually 0)
//
// Every stage is wall-clock `Date.now()` deltas taken by the observer, so the
// metric needs no log join and no clock re-derivation at read time.

/** The one-sentence definition the AC is graded against (also in
 *  `docs/live-observe-lag.md`). Kept here so a metric consumer can quote it. */
export const DELIVERED_LATENCY_DEFINITION =
  "delivered = the highlight row is readable on the delivered surface (the store " +
  "accepts the row, so a feed read returns it that tick); " +
  "trigger->delivered = persistAck - (contentOrigin + triggerTs)";

/** One emitted, delivered row (the AC's per-row reading). */
export interface LiveDeliveredLatencyRow {
  /** The row's `trigger.timestamp` (content seconds). */
  triggerTs: number;
  /** Trigger -> delivered total (ms); the number gate 3 grades. */
  deliveredLatencyMs: number;
  /** Content ts -> cadence fire (frame arrival / relay lag). */
  fireLagMs: number;
  /** Fire -> decide settle (gemma E2E). */
  decideE2eMs: number;
  /** Decide settle -> accept gate entry (content-order head of line). */
  acceptWaitMs: number;
  /** Accept gate duration (localize + suppress + record + emit). */
  acceptMs: number;
  /** Emit -> store write-through ack. */
  persistAckMs: number;
  /** ADAAAA-8024: the judged window centre -> the row's own (localized) trigger,
   *  `(centerTs - triggerTs) * 1000`. Emitted so the five wall-clock stages above
   *  PLUS this term reconstruct `deliveredLatencyMs` exactly on any row whose
   *  trigger was localized inside the window (the re-attested GOAL rows are
   *  exactly that shape), instead of leaving the caller to re-derive the centre.
   *  Zero when the trigger sits on the window centre. */
  localizeOffsetMs: number;
  /** ADAAAA-8024: the persisted highlight row id. The metric's dedupe key: one
   *  delivered reading per delivered highlight ROW, no matter which delivery
   *  path (accept-time persist or deferred re-attestation) reported it. */
  highlightId?: string;
}

/** Per-row metric block emitted on `observeMetrics.deliveredLatency`. */
export interface LiveDeliveredLatencySnapshot {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  /** Per-row readings, oldest first (bounded; newest kept). */
  rows: LiveDeliveredLatencyRow[];
}

/** A window whose accept produced a delivered row but whose persist has not
 *  acked yet. */
interface PendingDelivery {
  centerTs: number;
  lagMs: number;
  firedAtMs: number;
  settledAtMs: number;
  acceptStartMs: number;
  acceptDoneMs: number;
  /** Set by `notePersisted`; the row is emitted into the snapshot only then. */
  triggerTs?: number;
  persistAckAtMs?: number;
}

/** Stage timings one window's accept contributes (all wall-clock epoch ms). */
export interface WindowDeliveryTimings {
  centerTs: number;
  lagMs: number;
  firedAtMs: number;
  settledAtMs: number;
  acceptStartMs: number;
  acceptDoneMs: number;
}

/** Bounded ring: a 300 s share yields < 100 delivered rows, so 200 is slack. */
const MAX_ROWS = 200;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/**
 * The pure arithmetic behind one row. Exported so the AC's number is unit
 * tested without driving a live pass.
 */
export function deliveredLatencyRow(
  input: WindowDeliveryTimings & {
    triggerTs: number;
    persistAckAtMs: number;
    contentOriginMs: number;
    /** ADAAAA-8024: the delivered highlight row id (dedupe key). */
    highlightId?: string;
  }
): LiveDeliveredLatencyRow {
  const fireLagMs = Math.max(0, Math.round(input.lagMs));
  const decideE2eMs = Math.max(0, Math.round(input.settledAtMs - input.firedAtMs));
  const acceptWaitMs = Math.max(0, Math.round(input.acceptStartMs - input.settledAtMs));
  const acceptMs = Math.max(0, Math.round(input.acceptDoneMs - input.acceptStartMs));
  const persistAckMs = Math.max(0, Math.round(input.persistAckAtMs - input.acceptDoneMs));
  // ADAAAA-8024: a localized live trigger sits INSIDE the judged window, so the
  // window centre contributes a constant offset that the five wall-clock stages
  // cannot express. Emitting it as its own term is what makes the row's
  // breakdown reconstruct the AC's number EXACTLY (no re-derivation of the
  // centre at read time, and no silent residue on a re-attested GOAL row).
  const localizeOffsetMs = Math.round((input.centerTs - input.triggerTs) * 1000);
  // The AC's number: the stages themselves, so `sum(stages) + offset === total`
  // by construction. An absolute-clock reading can disagree only by rounding,
  // which is exactly the disagreement a grader must not have to explain.
  const stagedTotal = fireLagMs + decideE2eMs + acceptWaitMs + acceptMs + persistAckMs + localizeOffsetMs;
  return {
    triggerTs: input.triggerTs,
    deliveredLatencyMs: Math.max(0, stagedTotal),
    fireLagMs,
    decideE2eMs,
    acceptWaitMs,
    acceptMs,
    persistAckMs,
    localizeOffsetMs,
    ...(input.highlightId ? { highlightId: input.highlightId } : {}),
  };
}

/** The stage sum a delivered row must reconstruct (ms). Lets a test (and the
 *  log line) prove the decomposition accounts for the total. ADAAAA-8024: the
 *  row now carries its own localization term, so a caller does not need the
 *  window centre; `window` stays accepted for older callers/shapes. */
export function deliveredStageSum(
  row: LiveDeliveredLatencyRow,
  window?: { centerTs: number }
): number {
  const offset = Number.isFinite(row.localizeOffsetMs)
    ? row.localizeOffsetMs
    : window
      ? Math.round((window.centerTs - row.triggerTs) * 1000)
      : 0;
  return (
    row.fireLagMs +
    row.decideE2eMs +
    row.acceptWaitMs +
    row.acceptMs +
    row.persistAckMs +
    offset
  );
}

export function deliveredLatencySummary(rows: LiveDeliveredLatencyRow[]): LiveDeliveredLatencySnapshot {
  const totals = rows.map((r) => r.deliveredLatencyMs).sort((a, b) => a - b);
  return {
    samples: rows.length,
    p50Ms: Math.round(percentile(totals, 50)),
    p95Ms: Math.round(percentile(totals, 95)),
    maxMs: totals.length ? totals[totals.length - 1] : 0,
    rows: [...rows],
  };
}

/**
 * Per-run collector for the trigger -> delivered metric.
 *
 * The observer calls {@link noteWindow} once per DECIDED window that carries
 * the fire/settle/accept clocks (it owns them) — accepted or not: the ADAAAA-7996
 * gate can demote an accepted GOAL into a celebration row, and ADAAAA-8024 pins
 * that such a row's delivery is still measurable (its window clocks must not be
 * withheld). The server's persist paths call {@link notePersisted} when the store
 * write-through acknowledged the row (they own the delivered clock): the
 * accept-time persist for a newly inserted row, and the deferred re-attestation
 * upgrade for a row the recall path re-classified. Rows are matched on the window
 * centre; when the accept re-stamps the trigger timestamp (live localization),
 * the row's real `trigger.timestamp` replaces the centre, so the AC reads exactly
 * the value the stored row carries. The persisted row id is the dedupe key, so a
 * row that both paths report is counted once (ADAAAA-8024).
 */
export class LiveDeliveryTracker {
  private readonly pending: PendingDelivery[] = [];
  private readonly delivered: LiveDeliveredLatencyRow[] = [];
  /** Wall epoch ms of content t=0, frozen off the first fired window. */
  private contentOriginMs: number | null = null;

  constructor(private readonly label = "") {}

  /** Content-clock anchor (wall epoch ms of content t=0), or null before the
   *  first accepted window. */
  contentOrigin(): number | null {
    return this.contentOriginMs;
  }

  /** Record one accepted window's stage clocks. Idempotent per centre. */
  noteWindow(t: WindowDeliveryTimings): void {
    if (!Number.isFinite(t.centerTs) || !Number.isFinite(t.acceptDoneMs)) return;
    if (this.contentOriginMs === null) {
      // Same derivation the rail's own lag measurement uses, so the metric and
      // the `[live-lag]` number share one content clock.
      this.contentOriginMs = t.firedAtMs - Math.max(0, t.lagMs) - t.centerTs * 1000;
    }
    this.pending.push({
      centerTs: t.centerTs,
      lagMs: t.lagMs,
      firedAtMs: t.firedAtMs,
      settledAtMs: t.settledAtMs,
      acceptStartMs: t.acceptStartMs,
      acceptDoneMs: t.acceptDoneMs,
    });
    if (this.pending.length > MAX_ROWS) this.pending.shift();
  }

  /**
   * The highlight row reached the delivered surface: this is the "delivered"
   * instant. `triggerTs` is the row's `trigger.timestamp`; a row that does not
   * match a pending window exactly (localized trigger) attaches to the newest
   * pending one, so a delivery is never silently dropped from the metric.
   *
   * ADAAAA-8024: `highlightId` is the persisted row's id and is the metric's
   * dedupe key. TWO delivery paths now report the same row — the accept-time
   * persist (`persistLiveHighlight`, which reads the row as a celebration the
   * ADAAAA-7996 gate demoted) and the deferred re-attestation upgrade
   * (`attestDeferredGoalHighlight`, which re-classifies it as a GOAL). A row
   * counts ONCE: the first path to report it wins, and the other path is a
   * no-op, so `samples === distinct delivered rows` no matter how many paths
   * fired. Callers that cannot supply an id keep the old window-only behaviour.
   */
  notePersisted(triggerTs: number, persistAckAtMs = Date.now(), highlightId?: string): void {
    if (this.contentOriginMs === null) return;
    // One reading per delivered highlight ROW (ADAAAA-8024). Checked against the
    // emitted rows, so the dedupe window matches the ring's own retention.
    if (highlightId && this.delivered.some((r) => r.highlightId === highlightId)) return;
    const key = Number.isFinite(triggerTs) ? triggerTs : NaN;
    let idx = this.pending.findIndex((p) => Math.abs(p.centerTs - key) <= 1e-6);
    if (idx < 0) idx = this.pending.length - 1;
    if (idx < 0) return;
    const win = this.pending.splice(idx, 1)[0];
    const row = deliveredLatencyRow({
      ...win,
      triggerTs: Number.isFinite(key) ? key : win.centerTs,
      persistAckAtMs,
      contentOriginMs: this.contentOriginMs,
      ...(highlightId ? { highlightId } : {}),
    });
    this.delivered.push(row);
    if (this.delivered.length > MAX_ROWS) this.delivered.shift();
    // Per-row evidence line: the deployed run's AC is readable straight from
    // `docker logs highlights-server` with the same number the metric carries.
    // eslint-disable-next-line no-console
    console.log(
      `[live-deliver${this.label ? `:${this.label}` : ""}] row @${row.triggerTs}s ` +
        `delivered=${row.deliveredLatencyMs}ms fire=${row.fireLagMs}ms decide=${row.decideE2eMs}ms ` +
        `acceptWait=${row.acceptWaitMs}ms accept=${row.acceptMs}ms persistAck=${row.persistAckMs}ms ` +
        `localize=${row.localizeOffsetMs}ms` +
        (row.highlightId ? ` highlight=${row.highlightId}` : "")
    );
  }

  rows(): LiveDeliveredLatencyRow[] {
    return [...this.delivered];
  }

  /** The snapshot persisted on `observeMetrics.deliveredLatency`; absent until
   *  at least one delivered row exists (additive optional field). */
  snapshot(): LiveDeliveredLatencySnapshot | undefined {
    if (this.delivered.length === 0) return undefined;
    return deliveredLatencySummary(this.delivered);
  }
}
