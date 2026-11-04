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
//                delivered surface, i.e. the store write-through acknowledged
//                (`store.addHighlight` resolved: memory written before the DB
//                await, so the feed read sees it that tick).
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
  "delivered = the highlight row is readable on the delivered surface (store " +
  "write-through acked); trigger->delivered = persistAck - (contentOrigin + triggerTs)";

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
  input: WindowDeliveryTimings & { triggerTs: number; persistAckAtMs: number; contentOriginMs: number }
): LiveDeliveredLatencyRow {
  const fireLagMs = Math.max(0, Math.round(input.lagMs));
  const decideE2eMs = Math.max(0, Math.round(input.settledAtMs - input.firedAtMs));
  const acceptWaitMs = Math.max(0, Math.round(input.acceptStartMs - input.settledAtMs));
  const acceptMs = Math.max(0, Math.round(input.acceptDoneMs - input.acceptStartMs));
  const persistAckMs = Math.max(0, Math.round(input.persistAckAtMs - input.acceptDoneMs));
  // The AC's number, computed from absolute wall clocks (never from a sum of
  // rounded stages, so it can disagree with them only by rounding).
  const totalRaw = input.persistAckAtMs - (input.contentOriginMs + input.triggerTs * 1000);
  return {
    triggerTs: input.triggerTs,
    deliveredLatencyMs: Math.max(0, Math.round(totalRaw)),
    fireLagMs,
    decideE2eMs,
    acceptWaitMs,
    acceptMs,
    persistAckMs,
  };
}

/** The stage sum a delivered row must reconstruct (ms). Lets a test (and the
 *  log line) prove the decomposition accounts for the total. */
export function deliveredStageSum(
  row: LiveDeliveredLatencyRow,
  window?: { centerTs: number }
): number {
  return (
    row.fireLagMs +
    row.decideE2eMs +
    row.acceptWaitMs +
    row.acceptMs +
    row.persistAckMs +
    (window ? Math.round((window.centerTs - row.triggerTs) * 1000) : 0)
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
 * The observer calls {@link noteWindow} once per ACCEPTED window (it owns the
 * fire/settle/accept clocks), and the server's persist path calls
 * {@link notePersisted} when the store write-through acknowledged the row (it
 * owns the delivered clock). Rows are matched on the window centre; when the
 * accept re-stamps the trigger timestamp (live localization), the row's real
 * `trigger.timestamp` replaces the centre, so the AC reads exactly the value
 * the stored row carries.
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
   * The highlight row's write-through acked: this is the "delivered" instant.
   * `triggerTs` is the row's `trigger.timestamp`; a row that does not match a
   * pending window exactly (localized trigger) attaches to the newest pending
   * one, so a delivery is never silently dropped from the metric.
   */
  notePersisted(triggerTs: number, persistAckAtMs = Date.now()): void {
    if (this.contentOriginMs === null) return;
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
    });
    this.delivered.push(row);
    if (this.delivered.length > MAX_ROWS) this.delivered.shift();
    // Per-row evidence line: the deployed run's AC is readable straight from
    // `docker logs highlights-server` with the same number the metric carries.
    // eslint-disable-next-line no-console
    console.log(
      `[live-deliver${this.label ? `:${this.label}` : ""}] row @${row.triggerTs}s ` +
        `delivered=${row.deliveredLatencyMs}ms fire=${row.fireLagMs}ms decide=${row.decideE2eMs}ms ` +
        `acceptWait=${row.acceptWaitMs}ms accept=${row.acceptMs}ms persistAck=${row.persistAckMs}ms`
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
