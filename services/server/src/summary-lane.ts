// ADAAAA-8668 (spec ADAAAA-8665 §3): the SERVER side of the `summary` copy lane.
//
// The card's headline (`postTitle`, ADAAAA-8318) and announcer line (`caption`,
// ADAAAA-7933) both stay exactly as ratified. This lane adds BODY copy beside
// them: one text-only inference per PROMOTED highlight, run AFTER promotion and
// off the decide loop, so the live detect path gains zero latency (AC4) and the
// card is servable on `postTitle` before the copy lands.
//
// Bounds are enforced HERE, not by convention:
//  - the call is issued only after the row is readable (never at decide time, and
//    never awaited by the promotion path);
//  - ONE inference per promoted row, at most ONE retry (AC5), then drop-and-serve;
//  - the lane is serialized to one in-flight call per job and holds a small
//    pending ring: a row that finds the lane busy waits, and a row that finds the
//    ring full is dropped `pool_busy` — the lane never queues a storm behind
//    decide (the decide pool is the priority lane, this one is lowest);
//  - the reply is gated by `gateSummaryDetail` from `@highlights/events`, the ONE
//    summary contract (depth bands, clamp, grounding reuse, caption overlap);
//    a DETERMINISTIC refusal ends the row on one call and only the AC8 repeat
//    path may spend a second one (AC5 / spec §13.2);
//  - a drop writes ONLY the meter (`summaryDropped`, `summaryDroppedByReason`)
//    and never a `summary` value, so a failed generation can never blank the card
//    or emit a placeholder (AC6);
//  - every row carries its own meter (`summaryCalls`, `summaryDropped`,
//    `summaryDroppedByReason`, `summaryP95Ms`), which is what QA reads.
import {
  SUMMARY_CALL_TIMEOUT_MS,
  SUMMARY_DETERMINISTIC_REFUSALS,
  SUMMARY_FEE_RATIO,
  SUMMARY_MAX_CALLS_PER_ROW,
  SUMMARY_RAW_MAX_CHARS,
  buildSummaryPrompt,
  gateSummaryDetail,
  resolveSummaryFee,
  summaryOpeningRun,
  type SummaryDropReason,
  type SummaryEvidence,
  type SummaryRail,
} from "@highlights/events";

/** The subset of the store this lane needs (narrow on purpose: the lane must not
 *  be able to touch a verdict, a clip or a price field). */
export interface SummaryLaneStore {
  patchHighlightSummary(
    id: string,
    patch: {
      summary?: string;
      summaryGate?: string;
      summaryRaw?: string;
      summaryCaptionOverlap?: number;
      summaryCalls?: number;
      summaryDropped?: number;
      summaryDroppedByReason?: Record<string, number>;
      summaryP95Ms?: number;
    }
  ): Promise<unknown>;
}

/** One promoted highlight waiting for (or holding) its summary call. */
export interface SummaryRowDescriptor {
  jobId: string;
  highlightId: string;
  /** The row's own evidence — see `SummaryEvidence` in `@highlights/events`. */
  evidence: SummaryEvidence;
}

/**
 * AC8 (rev 3): the state the opening guard needs, scoped to ONE JOB.
 *
 * The set holds every normalized opening run already SERVED in this job — the
 * scope is the job, not the row, because the defect is two cards on the same
 * video opening the same way. Two different jobs may legitimately reuse an
 * opening; the lane owns one instance per job (`SummaryLane`), so that scope is
 * structural, not a convention a caller can forget.
 */
export interface SummaryJobState {
  servedOpenings: Set<string>;
}

export function newSummaryJobState(): SummaryJobState {
  return { servedOpenings: new Set<string>() };
}

export interface SummaryLaneConfig {
  /** Decide-service base URL. Absent => the lane is inert and drops `pool_busy`
   *  (never a fabricated summary). */
  decideUrl?: string;
  /** Operator override for the per-call fee; clamped to the AC5 ceiling. */
  summaryFee?: number | null;
  /** List price per decide call, for the fee ceiling. */
  decideFee: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

/** How many promoted rows may WAIT for the single in-flight slot. Deliberately
 *  small: the lane is lowest priority, and a row that cannot get the slot is
 *  dropped and served on the headline rather than queued behind decide. */
export const SUMMARY_LANE_PENDING_RING = 8;

/** The meter a run (or a job) reports. Mirrors the stored-row counters. */
export interface SummaryMeterSnapshot {
  summaryCalls: number;
  summaryDropped: number;
  summaryDroppedByReason: Record<string, number>;
  /** Measured p95 generation latency in ms (0 when nothing was measured). */
  summaryP95Ms: number;
}

function emptyMeter(): SummaryMeterSnapshot {
  return { summaryCalls: 0, summaryDropped: 0, summaryDroppedByReason: {}, summaryP95Ms: 0 };
}

/** p95 of a sample set (nearest-rank), 0 for an empty set. */
export function summaryP95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

/** The per-call fee this lane bills (AC5: <= 1.5x DECIDE_FEE). */
export function summaryFeeFor(cfg: Pick<SummaryLaneConfig, "decideFee" | "summaryFee">): number {
  return resolveSummaryFee(cfg.decideFee, cfg.summaryFee ?? null);
}

/** Body of the text-only `/app/summary` call. The PROMPT is composed here, in
 *  the shared contract module, so the prompt is snapshot-tested in TS and the
 *  decide service stays a thin text runner. */
export interface SummaryCallBody {
  prompt: string;
  rail: SummaryRail;
  /** Ceiling for the reply: the band's hard max plus headroom for the clamp. */
  maxWords: number;
}

/** One text-only call. Returns the raw reply text, or the drop cause. Never
 *  throws. */
export async function requestSummaryCall(
  cfg: SummaryLaneConfig,
  body: SummaryCallBody
): Promise<{ text: string } | { reason: SummaryDropReason }> {
  const base = cfg.decideUrl?.replace(/\/+$/, "");
  if (!base) return { reason: "pool_busy" };
  const fetchImpl = cfg.fetchImpl ?? fetch;
  try {
    const r = await fetchImpl(`${base}/app/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: body.prompt, rail: body.rail, maxWords: body.maxWords }),
      signal: AbortSignal.timeout(SUMMARY_CALL_TIMEOUT_MS),
    });
    if (!r.ok) return { reason: "transport_failure" };
    const data: any = await r.json();
    const text = typeof data?.summary === "string" ? data.summary.trim() : "";
    // An empty reply is a PARSE failure, not a gate refusal: nothing was written.
    if (!text) return { reason: "parse" };
    return { text };
  } catch (e: any) {
    const name = e?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(String(e?.message ?? ""))) {
      return { reason: "timeout" };
    }
    return { reason: "transport_failure" };
  }
}

export interface SummaryLaneRunResult {
  /** `stored` = copy written; `dropped` = meter written, no copy. */
  outcome: "stored" | "dropped";
  reason?: SummaryDropReason;
  gate?: string;
  calls: number;
  latencyMs: number;
}

/**
 * Generate, gate, store. ONE inference plus at most one retry; a failure writes
 * the meter only. The row's status, verdict, caption, title and clip fields are
 * never touched — only the six `summary*` fields.
 *
 * AC8 (rev 3): `state` carries the JOB's already-served opening runs. A body
 * whose opening repeats one of them is regenerated ONCE (the retry slot the
 * contract already allows, so the row still bills at most two calls, AC5); a
 * regeneration that repeats too drops with `repeat`, stores the candidate body as
 * `summaryRaw` and leaves the card on its headline.
 */
export async function runSummaryForRow(
  store: SummaryLaneStore,
  cfg: SummaryLaneConfig,
  descriptor: SummaryRowDescriptor,
  state?: SummaryJobState
): Promise<SummaryLaneRunResult> {
  const now = cfg.now ?? (() => Date.now());
  const log = cfg.log ?? ((line: string) => console.log(line));
  const evidence = descriptor.evidence;
  const servedOpenings = state?.servedOpenings;
  let calls = 0;
  let lastReason: SummaryDropReason | null = null;
  /** The last refusal, so the drop path can keep its reply as `summaryRaw`. */
  let lastGate: ReturnType<typeof gateSummaryDetail> | null = null;
  const started = now();
  for (let attempt = 1; attempt <= SUMMARY_MAX_CALLS_PER_ROW; attempt++) {
    // AC8 prompt-first: the regeneration (and any retry) is asked to avoid the
    // openings already served in this job, so the gate is a backstop, not the
    // only defence.
    const prompt = buildSummaryPrompt({
      ...evidence,
      ...(servedOpenings && servedOpenings.size > 0 ? { avoidOpenings: [...servedOpenings] } : {}),
    });
    const body: SummaryCallBody = {
      prompt,
      rail: evidence.rail,
      maxWords: evidence.rail === "vod" ? 120 : 70,
    };
    calls++;
    const reply = await requestSummaryCall(cfg, body);
    if ("reason" in reply) {
      lastReason = reply.reason;
      // A parse failure is deterministic: one retry only for transport-shaped
      // failures, so a broken reply cannot spend a second call.
      if (reply.reason === "parse" || reply.reason === "pool_busy") break;
      continue;
    }
    const decision = gateSummaryDetail(reply.text, evidence);
    if (!decision.summary) {
      lastGate = decision;
      lastReason = "gate";
      // ADAAAA-8773 / spec §13.2 (rev 7): a DETERMINISTIC refusal ends the row on
      // ONE call. The row's fact menu is fixed and the same prompt cannot repair a
      // clock anchor, an invented name or an enum-shaped token; the served VOD job
      // `70400b1d` spent 2 calls on both promoted rows to reach the identical
      // `too-few-facts` refusal, which billed 2 x the 1.5x ceiling = 2.0x
      // DECIDE_FEE per row. The second call is now the AC8 repeat path's alone.
      if (decision.violations.some((v) => SUMMARY_DETERMINISTIC_REFUSALS.includes(v))) {
        log(
          `[summary:${descriptor.jobId}] deterministic-refusal highlight=${descriptor.highlightId} violations=${decision.violations.join(",")} raw=${JSON.stringify(decision.raw.slice(0, 200))}`
        );
        break;
      }
      // ADAAAA-8687: a refusal is retried ONCE, inside the contract's existing
      // bound (`SUMMARY_MAX_CALLS_PER_ROW`, so a row still bills at most two
      // calls, AC5) and inside the post-promotion p95 budget. A gate refusal is
      // a property of ONE sampled reply, not of the row: the served probe
      // measured 2/9 refusals spread across three repeats of the same three
      // rows, so a second sample is the difference between 78% coverage and the
      // 95% bar. A refused reply is still never stored as `summary`.
      if (attempt < SUMMARY_MAX_CALLS_PER_ROW) {
        log(
          `[summary:${descriptor.jobId}] gate-retry highlight=${descriptor.highlightId} violations=${decision.violations.join(",")} raw=${JSON.stringify(decision.raw.slice(0, 200))}`
        );
        continue;
      }
      break;
    }
    // AC8: a repeated opening is regenerated once (prompt asks for a different
    // one); a second repeat drops the body rather than serving two identical
    // openings in one job.
    const opening = summaryOpeningRun(decision.summary);
    if (opening && servedOpenings?.has(opening)) {
      if (attempt < SUMMARY_MAX_CALLS_PER_ROW) {
        log(
          `[summary:${descriptor.jobId}] repeat-opening highlight=${descriptor.highlightId} opening=${JSON.stringify(opening)} — regenerating once`
        );
        continue;
      }
      lastGate = decision;
      lastReason = "repeat";
      log(
        `[summary:${descriptor.jobId}] repeat-opening highlight=${descriptor.highlightId} opening=${JSON.stringify(opening)} — drop (repeat) raw=${JSON.stringify(decision.raw.slice(0, 200))}`
      );
      break;
    }
    servedOpenings?.add(opening);
    const latencyMs = Math.max(0, Math.round(now() - started));
    await store.patchHighlightSummary(descriptor.highlightId, {
      summary: decision.summary,
      summaryGate: decision.gate,
      summaryCaptionOverlap: decision.captionOverlap,
      summaryCalls: calls,
      summaryDropped: 0,
      summaryP95Ms: latencyMs,
    });
    log(
      `[summary:${descriptor.jobId}] stored highlight=${descriptor.highlightId} words=${decision.words} sentences=${decision.sentences} gate=${decision.gate} calls=${calls} ms=${latencyMs} opening=${JSON.stringify(opening)}`
    );
    return { outcome: "stored", gate: decision.gate, calls, latencyMs };
  }
  const reason: SummaryDropReason = lastReason ?? "transport_failure";
  const latencyMs = Math.max(0, Math.round(now() - started));
  // ADAAAA-8687: a refusal keeps the model's own reply as `summaryRaw` (and an
  // excerpt in the log), so the next QA can quote WHAT was refused instead of
  // only the violation token. Still never a `summary`: the card renders on its
  // headline exactly as before (AC6).
  const raw = lastGate ? lastGate.raw.slice(0, SUMMARY_RAW_MAX_CHARS) : undefined;
  await store.patchHighlightSummary(descriptor.highlightId, {
    summaryGate: `dropped:${reason}`,
    ...(raw ? { summaryRaw: raw } : {}),
    ...(lastGate ? { summaryCaptionOverlap: lastGate.captionOverlap } : {}),
    summaryCalls: calls,
    summaryDropped: 1,
    summaryDroppedByReason: { [reason]: 1 },
    summaryP95Ms: latencyMs,
  });
  log(
    `[summary:${descriptor.jobId}] dropped (${reason}) highlight=${descriptor.highlightId} calls=${calls}${lastGate ? ` violations=${lastGate.violations.join(",")} raw=${JSON.stringify((raw ?? "").slice(0, 200))}` : ""}`
  );
  return { outcome: "dropped", reason, gate: lastGate?.gate, calls, latencyMs };
}

/**
 * The lane. `enqueue` is SYNCHRONOUS and never awaits a call, so the promotion
 * path returns to the frame loop immediately (AC4: zero added detect latency).
 * The drain loop runs one call at a time per job.
 */
export class SummaryLane {
  private readonly pending: SummaryRowDescriptor[] = [];
  private inFlight = false;
  private draining = false;
  private readonly samples: number[] = [];
  private meter: SummaryMeterSnapshot = emptyMeter();
  /** AC8 (rev 3): the openings already served in THIS job. The lane is one per
   *  job, so the guard's scope is the job by construction. */
  private readonly jobState: SummaryJobState = newSummaryJobState();
  /** Rows that could not even be queued (ring full / lane inert). */
  private droppedAtEnqueue = 0;

  constructor(
    readonly jobId: string,
    private readonly store: SummaryLaneStore,
    private readonly cfg: SummaryLaneConfig
  ) {}

  /** Queue a promoted row. Returns true when it will be attempted. Never throws,
   *  never awaits: the caller is the promotion seam. */
  enqueue(descriptor: SummaryRowDescriptor): boolean {
    if (!this.cfg.decideUrl) {
      // The lane is INERT with no decide service: no call is issued and no row
      // write is spent — the meter still records why nothing shipped. This is the
      // operator kill-switch path, and a card with no copy renders exactly as it
      // did before the lane existed.
      this.recordDrop("pool_busy");
      return false;
    }
    if (this.pending.length >= SUMMARY_LANE_PENDING_RING) {
      this.recordDrop("pool_busy");
      void this.writeDropMeter(descriptor.highlightId, "pool_busy");
      return false;
    }
    this.pending.push(descriptor);
    void this.drain();
    return true;
  }

  private async writeDropMeter(highlightId: string, reason: SummaryDropReason): Promise<void> {
    try {
      await this.store.patchHighlightSummary(highlightId, {
        summaryGate: `dropped:${reason}`,
        summaryCalls: 0,
        summaryDropped: 1,
        summaryDroppedByReason: { [reason]: 1 },
      });
    } catch (e: any) {
      (this.cfg.log ?? console.log)(`[summary:${this.jobId}] drop-meter write failed: ${e?.message ?? e}`);
    }
  }

  private recordDrop(reason: SummaryDropReason): void {
    this.meter.summaryDropped++;
    this.meter.summaryDroppedByReason[reason] = (this.meter.summaryDroppedByReason[reason] ?? 0) + 1;
    this.droppedAtEnqueue++;
  }

  /** Await the queue empty (used by tests and by a job's settle path). */
  async idle(): Promise<void> {
    while (this.draining || this.inFlight || this.pending.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift()!;
        this.inFlight = true;
        try {
          const result = await runSummaryForRow(this.store, this.cfg, next, this.jobState);
          this.meter.summaryCalls += result.calls;
          this.samples.push(result.latencyMs);
          if (result.outcome === "dropped") {
            this.meter.summaryDropped++;
            const reason = result.reason ?? "transport_failure";
            this.meter.summaryDroppedByReason[reason] = (this.meter.summaryDroppedByReason[reason] ?? 0) + 1;
          }
        } catch (e: any) {
          (this.cfg.log ?? console.log)(`[summary:${this.jobId}] lane error: ${e?.message ?? e}`);
          this.recordDrop("transport_failure");
        } finally {
          this.inFlight = false;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** The meter a settle path folds into `observeMetrics` / `costUsd`. */
  snapshot(): SummaryMeterSnapshot {
    return {
      summaryCalls: this.meter.summaryCalls,
      summaryDropped: this.meter.summaryDropped,
      summaryDroppedByReason: { ...this.meter.summaryDroppedByReason },
      summaryP95Ms: summaryP95(this.samples),
    };
  }

  /** Pending rows never attempted (drained on a job end so they are not lost
   *  silently). */
  get pendingCount(): number {
    return this.pending.length;
  }

  get enqueueDrops(): number {
    return this.droppedAtEnqueue;
  }
}

/**
 * The evidence a stored row carries, mapped to the summary contract. Pure, so a
 * caller can assert the inputs the model sees without a pipeline.
 */
export function summaryEvidenceForRow(row: {
  verdict?: string | null;
  eventType?: string | null;
  outcome?: string | null;
  reason?: string | null;
  caption?: string | null;
  postTitle?: string | null;
  trigger?: { timestamp?: number; durationS?: number } | null;
  start?: number;
  end?: number;
  deferredAttestation?: { scoreboardDelta?: { from?: string; to?: string } } | null;
  asrTranscript?: string | null;
  matchContext?: unknown;
}, rail: SummaryRail, adjacentScoreCue?: string | null): SummaryEvidence {
  const ts = row.trigger?.timestamp;
  const windowTs = typeof ts === "number" && Number.isFinite(ts) ? ts : typeof row.start === "number" ? row.start : null;
  const duration =
    row.trigger?.durationS ?? (typeof row.start === "number" && typeof row.end === "number" ? row.end - row.start : null);
  return {
    rail,
    // The row's stored verdict wins; the event type only labels the window.
    verdict: row.verdict ?? row.outcome ?? null,
    eventType: row.eventType ?? null,
    reason: row.reason ?? null,
    caption: row.caption ?? null,
    postTitle: row.postTitle ?? null,
    windowTs,
    windowDurationS: duration ?? null,
    scoreTransition: row.deferredAttestation?.scoreboardDelta
      ? { from: row.deferredAttestation.scoreboardDelta.from ?? null, to: row.deferredAttestation.scoreboardDelta.to ?? null }
      : null,
    matchContext: row.matchContext ?? null,
    transcript: row.asrTranscript ?? null,
    adjacentScoreCue: adjacentScoreCue ?? null,
  };
}

export { SUMMARY_FEE_RATIO };
