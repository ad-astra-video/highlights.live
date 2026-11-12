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

/** ADAAAA-8611: which ASR road this window's decide took, and what it cost.
 *
 *  The vocabulary is the one `observeDecideOnly` already logs
 *  (`[live-asr:<job>] decide @Ts lane=...`), kept identical here so the metric
 *  and the log line can never disagree about a row:
 *
 *  - `prefetched` - the side lane's transcription was ready in time and rode the
 *    decide payload (no inline ASR inside the decide call),
 *  - `miss`       - the prefetch SETTLED but did not transcribe (`ran:false`:
 *    transport / timeout / disabled), so the decide transcribed inline,
 *  - `waitmiss`   - the decide stopped waiting for the prefetch (wait budget or
 *    the ADAAAA-8611 headroom clamp) and proceeded with inline ASR; the
 *    prefetch is never aborted,
 *  - `inline`     - no prefetch existed for this window at all (`asrWaitMs: 0`).
 */
export type LiveAsrLane = "prefetched" | "miss" | "waitmiss" | "inline";

/** ADAAAA-8611: the ASR stage of ONE decided window. `waitMs` is the wall time
 *  the decide spent waiting for the side lane before it started (0 on the inert
 *  path); `prefetchMs` is the transcription's own measured cost when it landed.
 *
 *  These are attribution INSIDE `decideE2eMs`, not extra stages: the wait
 *  happens between fire and the decide call, so it is already counted there.
 *  `deliveredStageSum` deliberately does NOT add them (adding would double-count
 *  the tail on every wait-miss row). */
export interface LiveAsrStage {
  lane: LiveAsrLane;
  waitMs: number;
  prefetchMs: number;
}

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
  /** ADAAAA-8611: the row's ASR lane (`prefetched` | `miss` | `waitmiss` |
   *  `inline`) - always emitted, so the tail is attributable off the stored
   *  record instead of `docker logs`. A row with no prefetch reports `inline`;
   *  rows written before this field existed simply lack it. */
  asrLane: LiveAsrLane;
  /** ADAAAA-8611: wall ms this row's decide spent WAITING for the side lane
   *  before the decide call started (0 = it never waited). Attribution inside
   *  `decideE2eMs`, never an extra stage. */
  asrWaitMs: number;
  /** ADAAAA-8611: the side lane's own transcription cost for this row's window
   *  (0 when nothing landed). Attribution inside `decideE2eMs`. */
  asrPrefetchMs: number;
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
  /** ADAAAA-8495: null while the accept is still running. The window is
   *  registered BEFORE its accept (the store ack fires DURING accept), so the
   *  accept gate's own done clock only lands afterwards via `noteAcceptDone`. */
  acceptDoneMs: number | null;
  /** ADAAAA-8611: the window's ASR lane stage. Stamped by `noteAsrStage` as
   *  soon as the decide knows it (the staged path passes it in at registration,
   *  the serial path stamps it before its accept completes). Absent = no
   *  prefetch was ever attached, i.e. `inline`. */
  asr?: LiveAsrStage;
  /** Set by `notePersisted`; the row is emitted once the accept is done too. */
  triggerTs?: number;
  persistAckAtMs?: number;
  /** ADAAAA-8024/8495: the persisted row id carried until the row is built. */
  highlightId?: string;
}

/** Stage timings one window's accept contributes (all wall-clock epoch ms). */
export interface WindowDeliveryTimings {
  centerTs: number;
  lagMs: number;
  firedAtMs: number;
  settledAtMs: number;
  acceptStartMs: number;
  /** ADAAAA-8495: leave unset (or null) when the window is registered BEFORE
   *  its accept returns. The persist ack fires inside `accept`, so the row can
   *  only be finalised once the accept gate's own done clock is known —
   *  `noteAcceptDone` supplies it. A finite value keeps the legacy shape (a
   *  window handed over already accepted, e.g. the serial `onDecide` path). */
  acceptDoneMs?: number | null;
  /** ADAAAA-8611: the window's ASR lane stage, when the caller already knows it
   *  (the staged path: the decide has settled before the window is registered).
   *  A caller that registers before deciding stamps it later via
   *  {@link LiveDeliveryTracker.noteAsrStage}. */
  asr?: LiveAsrStage;
}

/** Bounded ring: a 300 s share yields < 100 delivered rows, so 200 is slack. */
const MAX_ROWS = 200;

/** Nearest-interpolated percentile over an already-sorted sample list. Exported
 * so the AC-B grader (`live-leg-grade.ts`, ADAAAA-8487) computes p50/p95 with
 * exactly the arithmetic `deliveredLatencySummary` writes into the record — a
 * grader that re-derives its own percentile would disagree with the stored
 * number it is grading. */
export function percentile(sorted: number[], p: number): number {
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
  input: Omit<WindowDeliveryTimings, "acceptDoneMs"> & {
    /** The accept gate's own done clock. Required here: a row is only built
     *  once the accept has completed (ADAAAA-8495). */
    acceptDoneMs: number;
    triggerTs: number;
    persistAckAtMs: number;
    contentOriginMs: number;
    /** ADAAAA-8024: the delivered highlight row id (dedupe key). */
    highlightId?: string;
    /** ADAAAA-8611: the window's ASR lane stage (attribution inside
     *  `decideE2eMs`). Absent = no prefetch existed => `inline`, 0, 0. */
    asr?: LiveAsrStage;
  }
): LiveDeliveredLatencyRow {
  const fireLagMs = Math.max(0, Math.round(input.lagMs));
  const decideE2eMs = Math.max(0, Math.round(input.settledAtMs - input.firedAtMs));
  const acceptWaitMs = Math.max(0, Math.round(input.acceptStartMs - input.settledAtMs));
  // ADAAAA-8495: on the live rails the store ack fires DURING `accept`, so the
  // accept gate's contribution to the delivered path ends at the earlier of the
  // two clocks (the row is readable then). Whatever the ack waits AFTER the
  // accept returned stays in `persistAckMs`. Splitting it this way keeps
  // `acceptMs + persistAckMs === ack - acceptStart` on both shapes, so the
  // stages still reconstruct the AC's number exactly instead of losing the
  // post-emit accept tail (or double-counting it).
  const readableAtMs = Math.min(input.persistAckAtMs, input.acceptDoneMs);
  const acceptMs = Math.max(0, Math.round(readableAtMs - input.acceptStartMs));
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
  // ADAAAA-8611: the ASR lane stage. It is attribution INSIDE `decideE2eMs`
  // (the wait sits between fire and the decide call), so it is emitted beside
  // the stages and deliberately NOT added to `stagedTotal` — the identity
  // `deliveredLatencyMs == sum(stages)` stays exact on a wait-miss row.
  const asr = input.asr;
  return {
    triggerTs: input.triggerTs,
    deliveredLatencyMs: Math.max(0, stagedTotal),
    fireLagMs,
    decideE2eMs,
    acceptWaitMs,
    acceptMs,
    persistAckMs,
    localizeOffsetMs,
    asrLane: asr?.lane ?? "inline",
    asrWaitMs: Math.max(0, Math.round(asr?.waitMs ?? 0)),
    asrPrefetchMs: Math.max(0, Math.round(asr?.prefetchMs ?? 0)),
    ...(input.highlightId ? { highlightId: input.highlightId } : {}),
  };
}

/** The stage sum a delivered row must reconstruct (ms). Lets a test (and the
 *  log line) prove the decomposition accounts for the total. ADAAAA-8024: the
 *  row now carries its own localization term, so a caller does not need the
 *  window centre; `window` stays accepted for older callers/shapes.
 *
 *  ADAAAA-8611: `asrWaitMs` / `asrPrefetchMs` are deliberately NOT terms of
 *  this sum. They attribute the part of `decideE2eMs` spent waiting for the
 *  side-lane transcription (fire -> decide start), so adding them here would
 *  count that tail twice and break the identity the AC is graded on. */
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
  /** ADAAAA-8740: readings withdrawn after delivery (a retracted cue card). */
  private retracted = 0;
  /** Wall epoch ms of content t=0, frozen off the first fired window. */
  private contentOriginMs: number | null = null;

  constructor(private readonly label = "") {}

  /** Content-clock anchor (wall epoch ms of content t=0), or null before the
   *  first accepted window. */
  contentOrigin(): number | null {
    return this.contentOriginMs;
  }

  /** Record one window's stage clocks. Idempotent per centre.
   *
   *  ADAAAA-8495: call this BEFORE `await accept()` with `acceptDoneMs` omitted.
   *  The store ack fires DURING accept, and the ack's row timestamp is the
   *  LOCALIZED trigger (a 3 s-multiple offset from the judged centre on the live
   *  rail), so an exact-centre match cannot find it — the fallback would take
   *  whatever window happened to be pending, i.e. the PREVIOUS one, and report
   *  its decide cadence and its `acceptDoneMs` as this row's delivery stages.
   *  Registering the window first makes it the row's own match, and
   *  `noteAcceptDone` closes it once the accept returns. */
  noteWindow(t: WindowDeliveryTimings): void {
    if (!Number.isFinite(t.centerTs) || !Number.isFinite(t.acceptStartMs)) return;
    if (t.acceptDoneMs != null && !Number.isFinite(t.acceptDoneMs)) return;
    if (this.contentOriginMs === null) {
      // Same derivation the rail's own lag measurement uses, so the metric and
      // the `[live-lag]` number share one content clock.
      this.contentOriginMs = t.firedAtMs - Math.max(0, t.lagMs) - t.centerTs * 1000;
    }
    // Always push (one entry per decided window), exactly like the pre-8495
    // shape: the end-of-stream force fire re-observes the newest window, so a
    // centre can legitimately appear twice and merging them would move a row's
    // stages onto the wrong window.
    this.pending.push({
      centerTs: t.centerTs,
      lagMs: t.lagMs,
      firedAtMs: t.firedAtMs,
      settledAtMs: t.settledAtMs,
      acceptStartMs: t.acceptStartMs,
      acceptDoneMs: t.acceptDoneMs ?? null,
      ...(t.asr ? { asr: t.asr } : {}),
    });
    if (this.pending.length > MAX_ROWS) this.pending.shift();
  }

  /** ADAAAA-8611: stamp the window's ASR lane stage once the decide knows it.
   *  Needed on the rails that register a window BEFORE the decide runs (the
   *  serial `onDecide` path: the persist ack fires during the accept, so the
   *  window must exist first and the lane is only known afterwards). Matching is
   *  exact on the centre — the same key `noteAcceptDone` uses — and the newest
   *  unstamped entry wins, so a re-fired centre cannot inherit the previous
   *  window's lane. A stage already stamped at registration is never overwritten
   *  by a later, less specific one. */
  noteAsrStage(centerTs: number, stage?: LiveAsrStage | null): void {
    if (!stage || !Number.isFinite(centerTs)) return;
    if (stage.lane !== "prefetched" && stage.lane !== "miss" && stage.lane !== "waitmiss" && stage.lane !== "inline") {
      return;
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (Math.abs(p.centerTs - centerTs) > 1e-6) continue;
      if (!p.asr) {
        p.asr = {
          lane: stage.lane,
          waitMs: Math.max(0, Math.round(stage.waitMs ?? 0)),
          prefetchMs: Math.max(0, Math.round(stage.prefetchMs ?? 0)),
        };
      }
      return;
    }
  }

  /** ADAAAA-8495: the accept gate returned. Stamps the window's own done clock
   *  and finalises the row if the persist ack already arrived during the accept
   *  (which is the normal live shape). */
  noteAcceptDone(centerTs: number, acceptDoneMs: number): void {
    if (!Number.isFinite(centerTs) || !Number.isFinite(acceptDoneMs)) return;
    const idx = this.pending.findIndex(
      (p) => Math.abs(p.centerTs - centerTs) <= 1e-6 && p.acceptDoneMs == null
    );
    if (idx < 0) return;
    this.pending[idx].acceptDoneMs = acceptDoneMs;
    if (this.pending[idx].persistAckAtMs != null) this.finalize(idx);
  }

  /** Pick the pending window a persist ack belongs to.
   *
   *  ADAAAA-8495: an exact centre match first (unchanged), then the NEWEST
   *  window whose accept had already started when the ack fired — the row's own
   *  clocks. A window registered after the ack (the pre-8495 shape) is never a
   *  candidate for it, which is the bug this replaces. A claimed entry is
   *  skipped so one ack can never be booked twice. */
  private matchWindow(triggerTs: number, ackAtMs: number): number {
    const unclaimed = (p: PendingDelivery) => p.persistAckAtMs == null;
    const exact = this.pending.findIndex(
      (p) => unclaimed(p) && Math.abs(p.centerTs - triggerTs) <= 1e-6
    );
    if (exact >= 0) return exact;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (unclaimed(p) && p.acceptStartMs <= ackAtMs) return i;
    }
    const last = this.pending.length - 1;
    return last >= 0 && unclaimed(this.pending[last]) ? last : -1;
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
    const idx = this.matchWindow(key, persistAckAtMs);
    if (idx < 0) return;
    const win = this.pending[idx];
    win.triggerTs = Number.isFinite(key) ? key : win.centerTs;
    win.persistAckAtMs = persistAckAtMs;
    if (highlightId) win.highlightId = highlightId;
    // ADAAAA-8495: the ack normally lands DURING the accept, so the row cannot
    // be built yet — `noteAcceptDone` finishes it. A window handed over already
    // accepted (legacy shape) is finalised here, as before.
    if (win.acceptDoneMs != null) this.finalize(idx);
  }

  /**
   * ADAAAA-8740 (§6.3 rule 3): RETRACT a row that was delivered and then withdrawn
   * because the same event's goal row shipped beside it. `samples` is the served
   * card count, so the retracted reading must leave the ledger — otherwise
   * `rowAccounting.servedCards` keeps claiming a card a viewer no longer holds.
   * Idempotent: retracting an id that was never delivered (or already retracted)
   * is a no-op, so a repeated accept can never decrement twice.
   */
  retractDelivered(highlightId: string): boolean {
    if (!highlightId) return false;
    const idx = this.delivered.findIndex((r) => r.highlightId === highlightId);
    if (idx < 0) return false;
    this.delivered.splice(idx, 1);
    this.retracted++;
    // eslint-disable-next-line no-console
    console.log(
      `[live-deliver${this.label ? `:${this.label}` : ""}] retracted row ${highlightId} ` +
        `(cue card withdrawn by its event group's goal row)`
    );
    return true;
  }

  /** ADAAAA-8740: rows retracted after delivery (audit read). */
  retractedRows(): number {
    return this.retracted;
  }

  /** Materialise one claimed window into a delivered row (splice + emit). */
  private finalize(idx: number): void {
    const win = this.pending[idx];
    if (win.acceptDoneMs == null || win.persistAckAtMs == null) return;
    const row = deliveredLatencyRow({
      ...win,
      acceptDoneMs: win.acceptDoneMs,
      triggerTs: win.triggerTs ?? win.centerTs,
      persistAckAtMs: win.persistAckAtMs,
      contentOriginMs: this.contentOriginMs as number,
      ...(win.highlightId ? { highlightId: win.highlightId } : {}),
      ...(win.asr ? { asr: win.asr } : {}),
    });
    this.pending.splice(idx, 1);
    this.delivered.push(row);
    if (this.delivered.length > MAX_ROWS) this.delivered.shift();
    // Per-row evidence line: the deployed run's AC is readable straight from
    // `docker logs highlights-server` with the same number the metric carries.
    // ADAAAA-8611: the ASR lane rides the same line (`asr=<lane>/<wait>+<prefetch>`)
    // so a wait-miss row's tail is attributable from one line instead of a
    // `docker logs` dig plus a `decide_audit` join.
    // eslint-disable-next-line no-console
    console.log(
      `[live-deliver${this.label ? `:${this.label}` : ""}] row @${row.triggerTs}s ` +
        `delivered=${row.deliveredLatencyMs}ms fire=${row.fireLagMs}ms decide=${row.decideE2eMs}ms ` +
        `acceptWait=${row.acceptWaitMs}ms accept=${row.acceptMs}ms persistAck=${row.persistAckMs}ms ` +
        `localize=${row.localizeOffsetMs}ms asr=${row.asrLane}/${row.asrWaitMs}+${row.asrPrefetchMs}ms` +
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
