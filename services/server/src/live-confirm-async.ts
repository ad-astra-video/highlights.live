// ADAAAA-8205: the LIVE async confirm lane.
//
// Why this exists: the Stage-2 `decide_confirm` goal dive is the only gate that
// can turn a provisional celebration into a postable GOAL, but the accept path
// used to AWAIT it inline (`confirmReconcile` in `acceptVideoDecision`) before
// persisting/publishing the row. Measured dive latency at the funded posture is
// p50 15.7 s / p95 10.0 s per stream (ADAAAA-7777 ship-trims leg), so paying it
// on the accept path is a delivered-latency regression the live rail cannot
// carry — and a failed dive there rewrites the row to `near_miss`, deleting the
// "GOAL (UNCONFIRMED)" badge the CEO is looking at (AC-A7).
//
// The lane keeps the accept path byte-identical to the `LIVE_DECIDE_CONFIRM=0`
// baseline: the provisional row publishes exactly as today, a pending-dive
// descriptor rides the row, and the dive runs OFF the accept path once the judged
// window's lookahead has closed. Its verdict moves the SAME row id — never an
// insert — through the promote-in-place write path ADAAAA-8199 built
// (`store.attestDeferredGoal`), so there is one writer for a verdict move.
//
// Bounds are enforced HERE, not by convention (ADAAAA-8518):
//  - one dive per distinct goal (`goalEventTs` + `confirmReuseWindowS`);
//  - NO per-300 s dive cap: `LIVE_CONFIRM_MAX_DIVES_PER_300S` defaults to
//    UNLIMITED and is an operator emergency brake only (a positive value caps,
//    a non-positive one never means "no dives");
//  - NO per-stream one-in-flight serialization: a stream holds as many dives in
//    flight as the MEASURED decide capacity allows (`ConfirmDiveDispatcher`).
//    A dive with no free slot stays PENDING and replans on the next tick;
//    `pool_busy` is stamped only at stream end or after the explicit queue
//    bound — never as a first-tick drop;
//  - context is rebuilt from PERSISTED artifacts only (frames on disk + the
//    stage-1 analysis). A signal that cannot be reconstructed (motion
//    trajectories, optical flow, the audio clip) is stamped in `contextDegraded`
//    and sent EMPTY — a missing signal is never credited and never fabricated;
//  - every failure (no frames, timeout, transport, parse/passthrough) fails
//    closed: the row is untouched and the dive is counted as dropped.
import { selectRereadFrames, withTimeout, type FrameRereadCandidate } from "./live-frame-reread.js";

/** ADAAAA-8518 (AC1): the operator EMERGENCY BRAKE, not a product cap.
 *
 *  Default is `null` = UNLIMITED: an absent / non-positive value never resolves
 *  to a number that caps, so the dive runs whenever the accept carried evidence
 *  (the CEO's rule on ADAAAA-8512). Only an explicit POSITIVE value caps, and
 *  `0` never means "no dives" — the accepted tradeoff is that cost is OBSERVED
 *  per stream (see `diveAdmission`), not enforced in code. */
export function normalizeConfirmDiveCap(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}
/** ADAAAA-8513 (AC4) / ADAAAA-8518 (AC1): the PENDING DESCRIPTOR RING bound.
 *
 *  This is a memory guard on how many un-dived descriptors a run may hold, NOT
 *  an admission cap: an evicted descriptor is stamped `descriptor_overflow` (a
 *  terminal reason with a row verdict) rather than silently shifted away. It is
 *  deliberately far above any measured evidence density (`c4d33a26`: 7.19
 *  goal-shaped reads / 300 s) so it can never read as a dive cap — AC1's 20 due
 *  descriptors in one window must all dispatch. */
export const LIVE_CONFIRM_PENDING_RING = 64;
/** ADAAAA-8518 (AC3): the EXPLICIT queue bound. A dive that cannot get a decide
 *  slot waits up to this long before it is stamped `pool_busy`; before the bound
 *  it stays PENDING and replans. Time, not a dive count — the lane holds no
 *  fixed numeric dive limit. */
export const LIVE_CONFIRM_QUEUE_WAIT_MS = 120_000;
/** A dive that has not answered within this bound is DROPPED (fail closed). */
export const LIVE_CONFIRM_DIVE_TIMEOUT_MS = 45_000;
/** Frames the dive hands the model (the shipped `CONFIRM_MAX_FRAMES` cell). */
export const LIVE_CONFIRM_MAX_FRAMES = 12;
/** Keyframes (pre / event / post) added on top of the frame cell. */
export const LIVE_CONFIRM_KEYFRAMES = 3;
/** Dive lead/trail around the goal EVENT instant (seconds), before the knob. */
export const LIVE_CONFIRM_LEAD_S = 5;
export const LIVE_CONFIRM_TRAIL_S = 4;
/** How far past a judged window's close the dive must wait for final artifacts.
 *  Matches the ADAAAA-8006 deferred lookahead: the score re-read lane and the
 *  frame re-read lane both own the window until then. */
export const LIVE_CONFIRM_LOOKAHEAD_S = 20;

/** One pending dive, persisted with the row that published it. */
export interface PendingConfirmDive {
  /** The published row this verdict must move IN PLACE. */
  highlightId: string;
  jobId: string;
  /** Stable save identity: the judged window's goal EVENT content time. */
  goalEventTs: number;
  /** The judged content window `[lo, hi]` the accept was decided over. */
  window: { lo: number; hi: number };
  /** Stage-1 verdict the row was published from (goal-shaped accept). */
  stage1: {
    eventType?: string;
    outcome?: string;
    reason?: string;
  };
  /** Analysis ref: the stage-1 evidence the dive may re-read (persisted). */
  analysis: {
    /** ADAAAA-8081 ASR transcript (absent when the window had no audio). */
    transcript?: string;
    /** Audio-energy level series the window already measured. */
    audioLevels?: number[];
  };
  /** Candidate signals the dive may CITE (never a gate). */
  signals: {
    ballOutcome?: string;
    goalCrossed?: boolean;
    scoreBoardChanged?: boolean;
  };
  /** Content instant the accept that published the row was decided at. */
  queuedAt: number;
  /** ADAAAA-8513 (AC2/AC3): the evidence the ACCEPT measured for this window,
   *  copied from the persisted row so admission never has to reload it.
   *
   *  Additive optional: a descriptor written before this field existed (and a
   *  hand-built fixture) ranks on its `signals` alone, exactly as before. */
  evidence?: ConfirmDiveEvidence;
}

/**
 * ADAAAA-8513 (AC2): what the accept MEASURED, ranked before any budget token
 * is spent. `provisional` names the AC3 reservation: the row carries
 * `provisionalGoal.status === "provisional"`.
 */
export interface ConfirmDiveEvidence {
  /** AC3: the persisted row carries a provisional goal marker. */
  provisional?: boolean;
  /** AC2 tier 2: a MEASURED score transition (the row's own attestation read a
   *  scoreboard change, or a deferred read recorded a real pre -> post delta). */
  scoreMeasured?: boolean;
  /** AC2 tier 2: the score re-read's post samples against the required count. */
  postSamples?: number;
  need?: number;
  /** AC2 tier 1: the goal-line / net attestation. */
  ballInGoal?: boolean;
  goalCrossed?: boolean;
  /** AC2 tier 0 (audio/motion only): a burst with no goal channel. */
  audioBurst?: boolean;
}

/** Signals the persisted artifacts cannot reconstruct. Always stamped, never
 *  silently assumed present. */
export type DegradedSignal = "motion_trajectories" | "optical_flow" | "audio_clip" | "audio_levels";

/** What the dive sends, assembled from persisted artifacts only. */
export interface ConfirmDiveContext {
  frames: { role: string; base64: string }[];
  keyframes: { role: string; base64: string }[];
  trajectories: { label: string; trackId: string; path: number[][] }[];
  opticalFlowMagnitude: number;
  flowMagnitudes: number[];
  audioLevels: number[];
  audioB64: string;
  /** Signals that could not be reconstructed (empty result, no fabrication). */
  contextDegraded: DegradedSignal[];
}

/** The verdict fields the lane reads (a subset of `ConfirmDecision`). */
export interface ConfirmDiveVerdict {
  goalConfirmed?: "confirmed_goal" | "near_miss" | "not_goal" | null;
  corroborated?: boolean;
  corroborationSource?: "audio_text" | "scoreboard" | "frame_attestation" | null;
  reason?: string;
}

/** ADAAAA-8205: the row-level attestation stamped by a completed dive. */
export interface ConfirmAttestation {
  goalConfirmed: string;
  corroborated: boolean;
  corroborationSource: string | null;
  diveAt: string;
  diveLatencyMs: number;
  contextDegraded: DegradedSignal[];
  /** ADAAAA-8506 (AC4): why a dive ended WITHOUT a model verdict (budget,
   *  pool_busy, no_persisted_frames, timeout, transport_failure, passthrough).
   *  Present so a finished job's provisional row always carries a stored verdict
   *  field instead of staying `status:"provisional"` with nothing to read. */
  dropReason?: string;
}

/**
 * ADAAAA-8518 (AC1): the OPTIONAL operator emergency brake.
 *
 * Content-clock based (the same clock the window schedule uses), so the 300 s
 * window means 300 s of STREAM, not 300 s of wall time — a stalled stream cannot
 * bank dives. It is INERT by default (`max == null`): no stamp, no refusal, no
 * `budget` drop. The CEO directive of record (ADAAAA-8512, 22:14Z) is that the
 * product does not cap dives; only an explicitly configured positive value
 * brakes, and a non-positive value is never read as "no dives".
 *
 * The ADAAAA-8513 reserved-slice machinery (`min(3, cap)`, the snapshot's
 * cap/reserved/spentReserved/spentGeneral) is DELETED with the cap: slots, not
 * tokens, are the scarce resource now, so ranking (AC4) is all that is left.
 */
export class ConfirmDiveBudget {
  private stamps: number[] = [];
  private refusals = 0;
  /** The brake's fixed sliding window, in seconds of STREAM content. */
  static readonly WINDOW_S = 300;

  /** Spend one dive at `nowTs`, or refuse when an EXPLICIT cap is exhausted.
   *
   *  A dive is stamped even when the brake is INERT (`cap == null`): the stamp is
   *  a readout of dives spent in the window (`count`), never a gate, so an
   *  uncapped stream still answers "how many dives ran in the last 300 s" without
   *  the class ever refusing. */
  allow(nowTs: number, max: number | null | undefined): boolean {
    const cap = normalizeConfirmDiveCap(max);
    if (!Number.isFinite(nowTs)) return true;
    const cutoff = nowTs - ConfirmDiveBudget.WINDOW_S;
    this.stamps = this.stamps.filter((ts) => ts > cutoff);
    // No brake configured (the shipped default): stamp for the readout, never refuse.
    if (cap == null) {
      this.stamps.push(nowTs);
      return true;
    }
    if (this.stamps.length >= cap) {
      this.refusals++;
      return false;
    }
    this.stamps.push(nowTs);
    return true;
  }

  /** Dives spent inside the sliding window ending at `nowTs`. */
  count(nowTs: number): number {
    const cutoff = nowTs - ConfirmDiveBudget.WINDOW_S;
    return this.stamps.filter((ts) => ts > cutoff).length;
  }

  /** Brake refusals observed (0 unless an explicit cap was configured). */
  refusalsCount(): number {
    return this.refusals;
  }
}

/**
 * ADAAAA-8518 (AC3): the ONLY admission gate — measured decide capacity.
 *
 * One dispatcher per server, shared by every stream, so `inFlight` is the TOTAL
 * number of dives in flight across streams and admission compares it to the
 * decide fleet the signer probe measured (`observeMetrics.decideCapacity`).
 * There is no fixed numeric dive limit anywhere in the lane.
 */
export class ConfirmDiveDispatcher {
  private inFlightCount = 0;
  private maxSeen = 0;
  private dispatchedCount = 0;
  private lastCapacity = 0;

  constructor(private capacityOf: () => number) {}

  /** Point admission at the client whose signer probe measures the fleet. */
  useCapacitySource(capacityOf: () => number): void {
    this.capacityOf = capacityOf;
  }

  /** A dispatcher with no capacity information (unit harnesses, $0 tests). */
  static unbounded(): ConfirmDiveDispatcher {
    return new ConfirmDiveDispatcher(() => Number.MAX_SAFE_INTEGER);
  }

  /** The measured capacity right now; never below 1 (a gate that admits nothing
   *  would starve every stream instead of queueing). */
  capacity(): number {
    const raw = Number(this.capacityOf());
    const cap = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
    this.lastCapacity = cap;
    return cap;
  }

  get inFlight(): number {
    return this.inFlightCount;
  }
  get maxInFlight(): number {
    return this.maxSeen;
  }
  get dispatched(): number {
    return this.dispatchedCount;
  }

  /** Take a slot, or report that the pool is full (the dive stays PENDING). */
  tryAdmit(): boolean {
    if (this.inFlightCount >= this.capacity()) return false;
    this.inFlightCount++;
    this.dispatchedCount++;
    if (this.inFlightCount > this.maxSeen) this.maxSeen = this.inFlightCount;
    return true;
  }

  /** Give a slot back (always in a `finally`). */
  release(): void {
    this.inFlightCount = Math.max(0, this.inFlightCount - 1);
  }
}

/**
 * ADAAAA-8518 (AC3): resolve the measured decide capacity from the ADAAAA-8254 /
 * 8262 signer probe. `cfg.decideConcurrency` is the fallback ONLY when the probe
 * has no answer (`source: "funded"` = nothing was ever advertised, or no
 * snapshot at all) — never when it answered with a real fleet.
 */
export function diveCapacityFromProbe(
  snapshot: { effective?: number; source?: string } | null | undefined,
  fallback: number | undefined
): number {
  const fb = Number(fallback);
  const fromConfig = Number.isFinite(fb) && fb >= 1 ? Math.floor(fb) : 2;
  const eff = Number(snapshot?.effective);
  const answered =
    !!snapshot && Number.isFinite(eff) && eff >= 1 && snapshot.source !== "funded";
  return answered ? Math.floor(eff) : fromConfig;
}

/** ADAAAA-8518 (AC5): the admission block a stored live row publishes. */
export interface ConfirmDiveAdmissionSnapshot {
  /** Dives admitted and started (a started dive may still fail pre-call). */
  dispatched: number;
  /** Times a due dive had no free decide slot (it stayed PENDING). */
  queued: number;
  /** Peak dives in flight across the server while this stream admitted. */
  maxInFlight: number;
  /** The measured decide capacity admission last compared against. */
  capacityEffective: number;
  /** Confirm calls the stream BILLED (`billableConfirmCalls` reads the same
   *  `confirmCalls` count). */
  divesBilled: number;
  /** `decideFee x divesBilled` — cost is observed per stream, not enforced. */
  diveCostUsd: number;
}

/**
 * ADAAAA-8513 (AC2): evidence strength of one due dive, highest first.
 *   2 = a MEASURED score transition (`liveGoalHasMeasuredEvidence`'s score
 *       channel, or `postSamples >= need`),
 *   1 = a goal-line / net attestation (`ballOutcome=goal` / `goalCrossed`),
 *   0 = audio/motion only (a celebration burst with no goal channel).
 * The accept's recorded `evidence` wins; a pre-change descriptor falls back to
 * its candidate `signals`, which is exactly what the accept had.
 */
export function confirmDiveEvidenceTier(entry: PendingConfirmDive): 0 | 1 | 2 {
  const ev = entry?.evidence;
  const signals = entry?.signals;
  if (ev?.scoreMeasured === true) return 2;
  if (
    typeof ev?.postSamples === "number" &&
    typeof ev?.need === "number" &&
    ev.need > 0 &&
    ev.postSamples >= ev.need
  ) {
    return 2;
  }
  if (signals?.scoreBoardChanged === true) return 2;
  if (ev?.ballInGoal === true || ev?.goalCrossed === true || signals?.goalCrossed === true) return 1;
  if (typeof signals?.ballOutcome === "string" && /^goal$/i.test(signals.ballOutcome.trim())) return 1;
  return 0;
}

/**
 * The dives that are DUE: their judged window's lookahead has closed (so the
 * persisted artifacts are final) and the goal has not already had a dive.
 *
 * One dive per distinct goal: entries are ordered by evidence strength then
 * `goalEventTs` and an entry within `reuseWindowS` of an already-selected goal
 * is skipped — the same rule `confirmReconcile` applies to overlapping rolling
 * windows (ADAAAA-7663).
 *
 * ADAAAA-8513 (AC2): the order is EVIDENCE FIRST, then stream time. Before this
 * the list was `goalEventTs` ascending, so the budget was spent oldest-first and
 * noise earlier in the window beat a real goal later in it (16 goal-shaped reads
 * in 668 s on `c4d33a26`, 12 of them false `scoreboard changed`). Ranking the
 * measured-transition / goal-line tiers ahead of the audio-burst tier means a
 * high-evidence goal can never lose the last token to a lower-evidence
 * celebration; `goalEventTs` ascending inside a tier keeps the order
 * deterministic (and keeps the older window first among equal evidence).
 */
export function planDueConfirmDives(
  pending: ReadonlyArray<PendingConfirmDive>,
  input: {
    nowTs: number;
    lookaheadS?: number;
    /** Dive keys already attempted this run. */
    attempted?: ReadonlySet<string>;
    /** Reuse window around a goal's content time (one dive per distinct goal). */
    reuseWindowS?: number;
  }
): PendingConfirmDive[] {
  const out: PendingConfirmDive[] = [];
  if (!Number.isFinite(input.nowTs)) return out;
  const lookaheadS = Math.max(0, input.lookaheadS ?? LIVE_CONFIRM_LOOKAHEAD_S);
  const reuseWindowS = Math.max(0, input.reuseWindowS ?? 0);
  const seen: number[] = [];
  const ordered = [...(pending ?? [])]
    .filter((e) => !!e?.highlightId && Number.isFinite(e?.goalEventTs))
    .sort((a, b) => {
      // AC2: measured score -> goal-line/net -> audio-only; then stream time.
      const rank = confirmDiveEvidenceTier(b) - confirmDiveEvidenceTier(a);
      if (rank !== 0) return rank;
      if (a.goalEventTs !== b.goalEventTs) return a.goalEventTs - b.goalEventTs;
      return a.highlightId < b.highlightId ? -1 : a.highlightId > b.highlightId ? 1 : 0;
    });
  for (const e of ordered) {
    if (input.attempted?.has(confirmDiveKey(e))) continue;
    if (!Number.isFinite(e.window?.lo) || !Number.isFinite(e.window?.hi) || e.window.hi < e.window.lo) continue;
    // Due only once the deferred lookahead has closed: before that, the free
    // score-read lane and the frame re-read lane still own the window.
    if (input.nowTs < e.window.hi + lookaheadS - 1e-9) continue;
    if (reuseWindowS > 0 && seen.some((ts) => Math.abs(ts - e.goalEventTs) <= reuseWindowS + 1e-9)) continue;
    seen.push(e.goalEventTs);
    out.push(e);
  }
  return out;
}

/** Stable identity of one dive (the row + its goal event). */
export function confirmDiveKey(entry: PendingConfirmDive): string {
  const ts = Math.round((entry.goalEventTs ?? 0) * 100) / 100;
  return `${entry.highlightId}:${ts}`;
}

/** Nearest frame to each of the three keyframe targets (pre / event / post). */
export function selectConfirmDiveKeyframes(
  frames: ReadonlyArray<{ ts: number; base64: string }>,
  eventTs: number,
  leadS: number,
  trailS: number
): { role: string; base64: string }[] {
  const targets = [eventTs - leadS, eventTs, eventTs + trailS];
  const out: { role: string; base64: string }[] = [];
  for (const t of targets) {
    let best: { ts: number; base64: string } | undefined;
    let bestDiff = Infinity;
    for (const f of frames) {
      const d = Math.abs(f.ts - t);
      if (d < bestDiff) {
        bestDiff = d;
        best = f;
      }
    }
    if (best?.base64) out.push({ role: "full", base64: best.base64 });
  }
  return out;
}

/**
 * Assemble the dive context from PERSISTED artifacts only.
 *
 * `frames` is the persisted inventory the caller already loaded from
 * `live/<jobId>/frames/frame_%06d.jpg`. Selection reuses the ADAAAA-8139
 * deterministic sub-sampler, so the dive and the re-read lane pick a frame the
 * same way. Motion trajectories, optical flow and the audio clip cannot be
 * reconstructed from a persisted JPEG + the stage-1 analysis, so they are sent
 * EMPTY and named in `contextDegraded` — never invented, never credited.
 */
export function buildPersistedConfirmContext(input: {
  frames: ReadonlyArray<{ seq: number; ts: number; base64: string }>;
  eventTs: number;
  analysis?: { transcript?: string; audioLevels?: number[] };
  maxFrames?: number;
  leadS?: number;
  trailS?: number;
}): ConfirmDiveContext {
  const maxFrames = Math.max(1, Math.floor(input.maxFrames ?? LIVE_CONFIRM_MAX_FRAMES));
  const leadS = Math.max(0, input.leadS ?? LIVE_CONFIRM_LEAD_S);
  const trailS = Math.max(0, input.trailS ?? LIVE_CONFIRM_TRAIL_S);
  const eventTs = Number.isFinite(input.eventTs) ? input.eventTs : 0;
  const loaded = (input.frames ?? []).filter((f) => !!f?.base64 && Number.isFinite(f?.ts));
  // Deterministic subsample over the dive window, then only frames whose bytes
  // actually loaded may be sent (a missing file is absent evidence).
  const picked = selectRereadFrames(
    loaded.map((f) => ({ seq: f.seq, ts: f.ts })),
    { lo: eventTs - leadS, hi: eventTs + trailS },
    { maxFrames }
  );
  const bySeq = new Map(loaded.map((f) => [f.seq, f]));
  const sampled = picked
    .map((p) => bySeq.get(p.seq))
    .filter((f): f is { seq: number; ts: number; base64: string } => !!f?.base64);

  const degraded: DegradedSignal[] = ["motion_trajectories", "optical_flow", "audio_clip"];
  const audioLevels = Array.isArray(input.analysis?.audioLevels)
    ? input.analysis!.audioLevels!.filter((v) => Number.isFinite(v))
    : [];
  if (!audioLevels.length) degraded.push("audio_levels");

  return {
    frames: sampled.map((f) => ({ role: "full", base64: f.base64 })),
    keyframes: selectConfirmDiveKeyframes(sampled, eventTs, leadS, trailS),
    // Persisted artifacts carry no tracker state — empty, and named degraded.
    trajectories: [],
    opticalFlowMagnitude: 0,
    flowMagnitudes: [],
    audioLevels,
    audioB64: "",
    contextDegraded: degraded,
  };
}

/**
 * ADAAAA-8239: corroboration sources that are NOT a score measurement.
 *
 * A dive that only had persisted frames (or commentary text) to go on can say
 * "this looks like a goal", but it cannot overturn the window's own measured
 * lane. The falsifier run (ADAAAA-8236, job `8dd6a383`) promoted a provisional
 * celebration at content 29-44 s on `frame_attestation` while that same row's
 * attestation read `scoreBoardChanged=false`, `postSamples 0` of `need 2`, and
 * all four non-visual signals were degraded — frames were the only witness. The
 * one real goal in the segment was the later, score-attested transition.
 */
export const NON_SCORE_CORROBORATION_SOURCES = ["frame_attestation", "audio_text"] as const;
export type NonScoreCorroborationSource = (typeof NON_SCORE_CORROBORATION_SOURCES)[number];

/** The row fields the frame-only gate reads: the accept-time attestation the
 *  ADAAAA-7996/8071 gate stamped when it demoted the row, and the deferred score
 *  read that resolved a transition (ADAAAA-8006). Both additive optional. */
export interface RowMeasuredScoreEvidence {
  attestationUsed?: {
    scoreBoardChanged?: boolean;
    postSamples?: number;
    need?: number;
  } | null;
  deferredAttestation?: {
    deltaTs?: number;
    pre?: readonly number[];
    post?: readonly number[];
  } | null;
}

/**
 * ADAAAA-8239: did the ROW itself measure a score transition? Only two positive
 * signals count:
 *   - the accept-time attestation read a scoreboard change, or
 *   - a deferred score read recorded a REAL pre -> post delta
 *     (`deferredAttestation {pre, post, deltaTs}` — equal sides are not a
 *     transition, they are a legible non-transition).
 * A missing attestation is NOT a measurement: absent evidence is never credited,
 * the same rule the dive context applies to a degraded signal.
 */
export function rowMeasuredScoreTransition(row: RowMeasuredScoreEvidence): boolean {
  const used = row?.attestationUsed;
  if (used?.scoreBoardChanged === true) return true;
  const deferred = row?.deferredAttestation;
  if (!deferred || !Number.isFinite(deferred.deltaTs)) return false;
  const pre = Array.isArray(deferred.pre) ? deferred.pre.join("-") : "";
  const post = Array.isArray(deferred.post) ? deferred.post.join("-") : "";
  return !!pre && !!post && pre !== post;
}

/** One-line, gradable rendering of the row's own measurement, for the hold
 *  reason and the provisional note (so an audit can read WHY it was held). */
export function describeRowMeasurement(row: RowMeasuredScoreEvidence): string {
  const used = row?.attestationUsed;
  const parts = [
    `scoreBoardChanged=${used?.scoreBoardChanged === true}`,
    `postSamples=${typeof used?.postSamples === "number" ? used.postSamples : "absent"}`,
    `need=${typeof used?.need === "number" ? used.need : "absent"}`,
  ];
  const deferred = row?.deferredAttestation;
  if (deferred && Number.isFinite(deferred.deltaTs)) parts.push(`deferredDeltaTs=${deferred.deltaTs}`);
  return parts.join(", ");
}

/**
 * ADAAAA-8239: does this verdict need the row's own measured transition before
 * it may promote? True when the corroboration is a non-score source
 * (`frame_attestation` / `audio_text`) AND the row recorded no transition.
 *
 * A `scoreboard` corroboration needs no such proof (the dive itself measured the
 * score), and an uncorroborated verdict never reaches the promote arm.
 */
export function frameOnlyCorroborationNeedsTransition(
  row: RowMeasuredScoreEvidence,
  verdict: ConfirmDiveVerdict | undefined
): boolean {
  if (verdict?.corroborated !== true) return false;
  const src = verdict?.corroborationSource ?? null;
  if (!src || !(NON_SCORE_CORROBORATION_SOURCES as readonly string[]).includes(src)) return false;
  return !rowMeasuredScoreTransition(row);
}

/** The store patch a verdict produces, and which lane the row ends in. */
export interface ConfirmDiveAdoption {
  kind: "promoted" | "refuted" | "unchanged";
  /** Fields to write on the SAME row (never a new row). */
  patch: Record<string, unknown>;
  /** Why this adoption happened (audit line). */
  reason: string;
}

/**
 * Move the row the verdict earned, IN PLACE.
 *
 * `confirmed_goal` + `corroborated=true` -> scoring lane (`scoring_play` /
 * `GOAL`), the provisional marker is cleared and `confirmAttestation` stamped.
 *
 * ADAAAA-8239: a `confirmed_goal` corroborated ONLY by a non-score source
 * (`frame_attestation` / `audio_text`) may not promote a window that measured no
 * score transition. The row is HELD (`provisionalGoal status=provisional`,
 * `refuted: true`, a note naming the missing measurement) unless the row's own
 * record proves the transition — `attestationUsed.scoreBoardChanged=true` or a
 * `deferredAttestation {pre !== post, deltaTs}`. The dive's stated verdict is
 * never rewritten: `confirmAttestation` keeps the six AV10 keys and reports what
 * the dive actually said; the HOLD is carried by the row's lane and its marker.
 *
 * `near_miss` / `not_goal` (or a `confirmed_goal` whose corroboration never
 * fired) -> the row stays a celebration with its clip, `provisionalGoal` KEEPS
 * `status: "provisional"` (AC-A7: the badge the CEO sees is not removed), gains
 * `refuted: true`, and the card says the deep dive did not confirm it.
 *
 * Passthrough (`goalConfirmed` null) or an already-resolved row -> the card is
 * untouched (outcome / eventType / clip / provisionalGoal), and the descriptor
 * is cleared. Both arms still stamp `confirmAttestation`: ADAAAA-8223 B2, an
 * attempted dive that leaves no marker is indistinguishable from a descriptor
 * that was never armed, so "the key is gone" would keep grading as N/A forever.
 * A refutation with no provisional marker to refute is likewise unchanged
 * (ADAAAA-8223 B3) instead of inventing a cue/timestamp on the row.
 */
export function confirmDiveAdoption(
  row: { outcome?: string; eventType?: string; provisionalGoal?: Record<string, unknown> } & RowMeasuredScoreEvidence,
  verdict: ConfirmDiveVerdict | undefined,
  meta: { diveAt: string; diveLatencyMs: number; contextDegraded: DegradedSignal[]; droppedReason?: string }
): ConfirmDiveAdoption {
  const goalConfirmed = verdict?.goalConfirmed ?? null;
  const corroborated = verdict?.corroborated === true;
  const attestation: ConfirmAttestation = {
    // ADAAAA-8506 (AC4): a dropped dive is a settled attempt with a stored
    // verdict field of its own — never a row left `provisional` with nothing to
    // read on a finished job.
    goalConfirmed: goalConfirmed ?? (meta.droppedReason ? "dropped" : "passthrough"),
    corroborated,
    corroborationSource: verdict?.corroborationSource ?? null,
    diveAt: meta.diveAt,
    diveLatencyMs: Math.max(0, Math.round(meta.diveLatencyMs)),
    contextDegraded: meta.contextDegraded,
    ...(meta.droppedReason ? { dropReason: meta.droppedReason } : {}),
  };
  // A row that already left the provisional lane (e.g. a later scoreboard read
  // re-attested it first) is not rewritten by a late dive: one verdict move.
  // The attestation still lands so the attempt is observable (B2).
  if (row.outcome === "scoring_play") {
    return {
      kind: "unchanged",
      patch: { confirmAttestation: attestation, pendingConfirmDive: undefined },
      reason: "row already in the scoring lane — the dive does not rewrite it",
    };
  }
  if (goalConfirmed === null) {
    return {
      kind: "unchanged",
      // B2: a passthrough is an ATTEMPT that produced no verdict. Stamp the
      // attestation (`goalConfirmed: "passthrough"`) so a cleared descriptor is
      // never misread as "never armed"; clip-facing fields stay untouched.
      patch: { confirmAttestation: attestation, pendingConfirmDive: undefined },
      reason: "passthrough (no structured verdict) — row unchanged",
    };
  }
  // ADAAAA-8239: a frame/commentary-only confirmation cannot promote past a
  // window the MEASURED lane read as "no transition". Computed before the promote
  // arm so the hold reason is available to every arm below it.
  const needsMeasuredTransition =
    goalConfirmed === "confirmed_goal" && frameOnlyCorroborationNeedsTransition(row, verdict);
  if (goalConfirmed === "confirmed_goal" && corroborated && !needsMeasuredTransition) {
    return {
      kind: "promoted",
      patch: {
        outcome: "scoring_play",
        eventType: "GOAL",
        provisionalGoal: undefined,
        confirmAttestation: attestation,
        pendingConfirmDive: undefined,
      },
      reason: `deep dive CONFIRMED the goal (corroboration=${attestation.corroborationSource ?? "none"})`,
    };
  }
  // B3: refute only a row that actually carries a provisional marker. A
  // celebration that never derived one must not gain a fabricated cue/declTs —
  // that would render a false "GOAL (unconfirmed)" badge on the board.
  // (Check placed after the promote arm so a corroborated confirmation keeps
  // its promotion regardless of marker state.)
  if (row.provisionalGoal?.status !== "provisional") {
    return {
      kind: "unchanged",
      patch: { confirmAttestation: attestation, pendingConfirmDive: undefined },
      reason: needsMeasuredTransition
        ? `frame/commentary-only confirmation held: no measured transition in the window ` +
          `(${describeRowMeasurement(row)}) and no provisional marker to refute — row stays a celebration`
        : "no provisional marker — refutation not applicable",
    };
  }
  // Refuted: near_miss / not_goal, a confirmation with no corroboration, or
  // (ADAAAA-8239) a non-score corroboration over a window that measured none.
  const prev = row.provisionalGoal;
  const note = needsMeasuredTransition
    ? `The deep dive saw a goal in the frames/commentary only (corroboration=${attestation.corroborationSource}) ` +
      `while this window measured no score transition (${describeRowMeasurement(row)}), so this moment stays ` +
      "unconfirmed until a later score read measures the transition."
    : goalConfirmed === "confirmed_goal"
      ? "The deep dive described a goal but could not corroborate it, so this moment is still unconfirmed."
      : "The deep dive did not confirm this goal, so this moment stays unconfirmed.";
  const provisional = { ...prev, status: "provisional", refuted: true, note };
  return {
    kind: "refuted",
    patch: {
      provisionalGoal: provisional,
      confirmAttestation: attestation,
      pendingConfirmDive: undefined,
    },
    reason: needsMeasuredTransition
      ? `deep dive did NOT promote: non-score corroboration (${attestation.corroborationSource}) over a window ` +
        `with no measured score transition (${describeRowMeasurement(row)})`
      : `deep dive did NOT confirm the goal (goalConfirmed=${goalConfirmed}, corroborated=${corroborated})`,
  };
}

/** Injected IO so the dive is unit-testable with no disk, no GPU and no network. */
export interface ConfirmDiveIo {
  /** Persisted frame inventory for a content span (seq + content ts). */
  framesInSpan: (lo: number, hi: number) => ReadonlyArray<FrameRereadCandidate>;
  /** Load one persisted frame's JPEG bytes as base64 (null when gone). */
  loadFrame: (seq: number) => Promise<string | null>;
  /** The decide `/confirm` call (transport failures reject). */
  confirm: (req: {
    eventType: string;
    timestamp: number;
    gameHint: string;
    stage1: unknown;
    frames: { role: string; base64: string }[];
    keyframes: { role: string; base64: string }[];
    trajectories: { label: string; trackId: string; path: number[][] }[];
    opticalFlowMagnitude: number;
    flowMagnitudes: number[];
    audioLevels: number[];
    audioB64: string;
    ballOutcome?: string;
    goalCrossed?: boolean;
    scoreBoardChanged?: boolean;
  }) => Promise<ConfirmDiveVerdict>;
  gameHint: string;
  /** Stage-1 verdict handed back to the model (the row was published from it).
   *  Optional: when absent the dive derives it from the descriptor's stage-1
   *  fields, so the persisted descriptor is the single source of truth. */
  stage1Payload?: unknown;
  maxFrames?: number;
  leadS?: number;
  trailS?: number;
  timeoutMs?: number;
}

/** One dive's outcome (dropped reasons are enumerable for the metrics). */
export interface ConfirmDiveResult {
  ok: boolean;
  /** Why the dive was dropped (absent when it produced a verdict). */
  droppedReason?:
    | "no_persisted_frames"
    | "frame_unreadable"
    | "timeout"
    | "transport_failure"
    | "passthrough"
    | "budget"
    | "pool_busy"
    /** ADAAAA-8513 (AC4): the 16-entry pending ring evicted the descriptor. */
    | "descriptor_overflow"
    /** ADAAAA-8513 (AC5): a descriptor whose judged window is malformed. */
    | "descriptor_invalid";
  verdict?: ConfirmDiveVerdict;
  context: ConfirmDiveContext;
  latencyMs: number;
  framesSent: number;
}

/**
 * ADAAAA-8513 (AC4): the closed cause list a stored `confirmDroppedByReason`
 * always carries. `descriptor_overflow` and `frame_unreadable` are extra
 * causes the lane can actually observe; they are kept distinct instead of being
 * folded into a neighbour, because "the ring evicted it" and "the frames would
 * not load" are different repairs.
 */
export const CONFIRM_DROP_REASONS = [
  "pool_busy",
  "budget",
  "timeout",
  "transport_failure",
  "passthrough",
  "no_persisted_frames",
  "frame_unreadable",
  "descriptor_overflow",
  "descriptor_invalid",
] as const;

/**
 * ADAAAA-8205 AC-A4: did this dive actually issue a decide call? The two
 * pre-flight drops happen before any model call is made, so they must not be
 * billed as confirm calls. Everything else (`ok`, a timeout after the request
 * was issued, a transport failure, a structured-verdict passthrough) did send
 * one.
 */
export function confirmDiveMadeCall(result: ConfirmDiveResult): boolean {
  if (result.ok) return true;
  switch (result.droppedReason) {
    case "timeout":
    case "transport_failure":
    case "passthrough":
      return true;
    default:
      return false;
  }
}

/** ADAAAA-8506 (AC4): the result a DROPPED dive hands the adoption writer.
 *
 *  Before this a drop only cleared the run's in-memory descriptor, so the row
 *  kept `pendingConfirmDive` + `provisionalGoal.status:"provisional"` with no
 *  verdict field at all — on a finished job that row is unreadable ("did the
 *  dive run?"). Every drop is settled exactly once, so its row gets the terminal
 *  stamp (`goalConfirmed:"dropped"`, `dropReason`) through the same in-place
 *  verdict writer a promoted/refuted row uses. No model call, no spend. */
export function droppedDiveResult(reason: ConfirmDiveResult["droppedReason"], latencyMs = 0): ConfirmDiveResult {
  return {
    ok: false,
    droppedReason: reason,
    context: {
      frames: [],
      keyframes: [],
      trajectories: [],
      opticalFlowMagnitude: 0,
      flowMagnitudes: [],
      audioLevels: [],
      audioB64: "",
      contextDegraded: [],
    },
    latencyMs,
    framesSent: 0,
  };
}

/** ADAAAA-8506 (AC2/AC6): run the paid `/confirm` call ONCE and emit the same
 * self-describing Stage-2 `decide_audit` descriptor the inline
 * `confirmReconcile` path writes.
 *
 *  The async lane called `client.confirm` bare, so a fired dive left no ledger
 *  row: measured on the first armed live job (`7d99d651`) the log printed
 *  "dive ... verdict=confirmed_goal" three times while `decide_audit` held 0
 *  rows with a non-null `timestamp` and no `gNNN:confirm` group. Without that
 *  row a dive can be neither graded (AC2) nor costed (AC6 — `timings.elapsedMs`
 *  and the pass's own gemma meter ride it), and the prompt + per-frame sha256
 *  are what make the dive replayable at $0.
 *
 *  The builder is injected (`buildDescriptor`) so this module keeps no import
 *  cycle with `analyzer.ts`. Emission is best-effort: a throwing sink can only
 *  log, never change or lose the verdict. */
export async function runConfirmDiveCall<V>(args: {
  req: { timestamp: number; frames?: { role?: string; base64?: string }[] };
  confirm: () => Promise<V>;
  emit: (desc: Record<string, unknown>) => void;
  buildDescriptor: (input: {
    timestamp: number;
    frames?: { role?: string; base64?: string }[];
    elapsedMs: number;
    confirm: V;
  }) => Record<string, unknown>;
  jobId?: string;
  log?: (line: string) => void;
}): Promise<V> {
  const log = args.log ?? ((line: string) => console.error(line));
  const startedAt = Date.now();
  const verdict = await args.confirm();
  const elapsedMs = Date.now() - startedAt;
  try {
    args.emit(
      args.buildDescriptor({
        timestamp: args.req.timestamp,
        frames: args.req.frames,
        elapsedMs,
        confirm: verdict,
      })
    );
  } catch (e: any) {
    log(`[confirm-audit:${args.jobId ?? "?"}] ingest failed: ${String(e?.message || e)}`);
  }
  return verdict;
}

/**
 * Run ONE dive over the persisted artifacts. NEVER throws: every failure is a
 * fail-closed result the caller counts as `confirmDropped`.
 */
export async function runConfirmDive(
  entry: PendingConfirmDive,
  io: ConfirmDiveIo,
  ctx: { jobId?: string; log?: (line: string) => void } = {}
): Promise<ConfirmDiveResult> {
  const log = ctx.log ?? ((line: string) => console.error(line));
  const jobTag = `[live-confirm:${ctx.jobId ?? entry.jobId ?? "?"}]`;
  const timeoutMs = Math.max(1, io.timeoutMs ?? LIVE_CONFIRM_DIVE_TIMEOUT_MS);
  const startedAt = Date.now();
  const empty: ConfirmDiveContext = {
    frames: [],
    keyframes: [],
    trajectories: [],
    opticalFlowMagnitude: 0,
    flowMagnitudes: [],
    audioLevels: [],
    audioB64: "",
    contextDegraded: ["motion_trajectories", "optical_flow", "audio_clip", "audio_levels"],
  };
  const leadS = Math.max(0, io.leadS ?? LIVE_CONFIRM_LEAD_S);
  const trailS = Math.max(0, io.trailS ?? LIVE_CONFIRM_TRAIL_S);
  const eventTs = entry.goalEventTs;
  let inventory: FrameRereadCandidate[] = [];
  try {
    inventory = [...(io.framesInSpan(eventTs - leadS, eventTs + trailS) ?? [])];
  } catch {
    inventory = [];
  }
  const loaded: { seq: number; ts: number; base64: string }[] = [];
  for (const f of inventory) {
    let b64: string | null = null;
    try {
      b64 = await io.loadFrame(f.seq);
    } catch {
      b64 = null;
    }
    if (b64) loaded.push({ seq: f.seq, ts: f.ts, base64: b64 });
  }
  if (!loaded.length) {
    log(`${jobTag} no persisted frames for goal @${eventTs.toFixed(1)}s ` +
      `(window [${entry.window.lo.toFixed(1)}, ${entry.window.hi.toFixed(1)}]) — dive dropped`);
    return { ok: false, droppedReason: "no_persisted_frames", context: empty, latencyMs: Date.now() - startedAt, framesSent: 0 };
  }
  const context = buildPersistedConfirmContext({
    frames: loaded,
    eventTs,
    analysis: entry.analysis,
    maxFrames: io.maxFrames,
    leadS,
    trailS,
  });
  if (!context.frames.length) {
    log(`${jobTag} persisted frames unreadable for goal @${eventTs.toFixed(1)}s — dive dropped`);
    return { ok: false, droppedReason: "frame_unreadable", context, latencyMs: Date.now() - startedAt, framesSent: 0 };
  }
  let verdict: ConfirmDiveVerdict;
  try {
    verdict = await withTimeout(
      io.confirm({
        eventType: entry.stage1.eventType ?? "GOAL",
        timestamp: eventTs,
        gameHint: io.gameHint,
        stage1: io.stage1Payload ?? {
          isHighlight: true,
          outcome: entry.stage1.outcome,
          eventType: entry.stage1.eventType,
          reason: entry.stage1.reason,
        },
        frames: context.frames,
        keyframes: context.keyframes,
        trajectories: context.trajectories,
        opticalFlowMagnitude: context.opticalFlowMagnitude,
        flowMagnitudes: context.flowMagnitudes,
        audioLevels: context.audioLevels,
        audioB64: context.audioB64,
        ballOutcome: entry.signals.ballOutcome,
        goalCrossed: entry.signals.goalCrossed,
        scoreBoardChanged: entry.signals.scoreBoardChanged,
      }),
      timeoutMs
    );
  } catch (e: any) {
    const timedOut = /timed out/i.test(String(e?.message || e));
    const latencyMs = Date.now() - startedAt;
    log(
      `${jobTag} dive for goal @${eventTs.toFixed(1)}s dropped: ${timedOut ? "timeout" : "transport failure"} ` +
        `(${String(e?.message || e)}) after ${latencyMs} ms`
    );
    return {
      ok: false,
      droppedReason: timedOut ? "timeout" : "transport_failure",
      context,
      latencyMs,
      framesSent: context.frames.length,
    };
  }
  const latencyMs = Date.now() - startedAt;
  if (!verdict || verdict.goalConfirmed === undefined || verdict.goalConfirmed === null) {
    log(
      `${jobTag} dive for goal @${eventTs.toFixed(1)}s was a passthrough (no structured verdict) ` +
        `after ${latencyMs} ms — row unchanged`
    );
    return { ok: false, droppedReason: "passthrough", context, latencyMs, framesSent: context.frames.length };
  }
  log(
    `${jobTag} dive for goal @${eventTs.toFixed(1)}s (window [${entry.window.lo.toFixed(1)}, ${entry.window.hi.toFixed(1)}]) ` +
      `verdict=${verdict.goalConfirmed} corroborated=${verdict.corroborated === true} ` +
      `source=${verdict.corroborationSource ?? "none"} frames=${context.frames.length} ` +
      `degraded=${context.contextDegraded.join(",") || "none"} in ${latencyMs} ms`
  );
  return { ok: true, verdict, context, latencyMs, framesSent: context.frames.length };
}

/** The per-run state the lane keeps (implemented by `LiveRunShared`). */
export interface ConfirmDiveRunState {
  pendingConfirmDives(): readonly PendingConfirmDive[];
  confirmDiveAttempted(): ReadonlySet<string>;
  noteConfirmDiveAttempt(key: string): void;
  dropPendingConfirmDive(key: string): void;
  noteConfirmDiveDropped(reason: string): void;
  noteConfirmDiveDone(ok: boolean, latencyMs: number): void;
  /** Sliding budget for this run (spend + refusal counting). */
  confirmBudget: ConfirmDiveBudget;
  /** Confirm calls this run made (metered like a decide call). */
  confirmDiveCalls(): number;
  confirmDiveCount(): number;
  confirmDiveDropped(): number;
  /** ADAAAA-8513 (AC4): descriptors the pending ring evicted, awaiting a
   *  stamped `descriptor_overflow` verdict. Optional so older fakes still run. */
  takeOverflowedConfirmDives?(): readonly PendingConfirmDive[];
  /** ADAAAA-8518 (AC4): drops keyed by cause. */
  confirmDroppedByReason?(): Record<string, number>;
  /** ADAAAA-8518 (AC5): the published admission block. */
  confirmDiveAdmission?(): ConfirmDiveAdmissionSnapshot;
  /** ADAAAA-8518 (AC3): stamp/return the wall-ms this descriptor has waited for
   *  a decide slot. Optional so simple fakes still run. */
  noteConfirmDiveQueueWait?(key: string, nowMs: number): number;
  /** ADAAAA-8518 (AC3): forget a queue stamp (dispatched or dropped). */
  clearConfirmDiveQueueWait?(key: string): void;
  /** ADAAAA-8518 (AC5): count one dispatch + the observed in-flight/capacity. */
  noteConfirmDiveDispatched?(inFlight: number, capacity: number): void;
  /** ADAAAA-8518 (AC5): count one no-slot admission. */
  noteConfirmDiveQueued?(capacity: number): void;
}

/** The pump's per-tick accounting (what the tests and logs read). */
export interface ConfirmDivePumpOutcome {
  dives: number;
  dropped: number;
  promoted: number;
  refuted: number;
  /** ADAAAA-8518 (AC1): emergency-brake refusals (0 at the shipped default). */
  retries: number;
  /** ADAAAA-8518 (AC3): due dives with no free decide slot (left PENDING). */
  queued: number;
  /** ADAAAA-8513 (AC4): overflow descriptors stamped on this tick. */
  overflowDropped: number;
}

/**
 * Pump the due dives for one window: plan -> capacity -> brake -> dive -> adopt.
 * Called OFF the accept path (fire-and-forget by the caller), so a slow dive can
 * never stall the live pass.
 *
 * ADAAAA-8518 changes admission, all `$0`:
 *  - AC1: there is NO product cap. `maxDivesPer300s` is the optional operator
 *    emergency brake and is inert (`null`) at the shipped default, so no dive is
 *    ever refused for a rate reason and `dropReason: "budget"` is never written.
 *  - AC2/AC4: `planDueConfirmDives` ranks evidence first (measured score ->
 *    goal-line -> audio-only, then `goalEventTs`), so scarce SLOTS go to the
 *    strongest window rather than the oldest.
 *  - AC3: the ONLY gate is the measured decide capacity (`dispatcher`). A dive
 *    with no free slot stays PENDING and replans on the next tick; `pool_busy`
 *    is stamped only at stream end or after the explicit queue-wait bound.
 *    Every admitted dive runs CONCURRENTLY (N in flight for one stream), so the
 *    old per-stream one-in-flight serialization is gone.
 *  - AC4: the ring's evicted descriptors are stamped `descriptor_overflow`.
 *  - AC5 (`drain`): every still-pending descriptor gets a terminal verdict.
 */
export async function runDueConfirmDives(deps: {
  run: ConfirmDiveRunState;
  io: ConfirmDiveIo;
  nowTs: number;
  jobId: string;
  /** AC1: operator emergency brake — `null`/absent is UNLIMITED. */
  maxDivesPer300s?: number | null;
  lookaheadS?: number;
  reuseWindowS?: number;
  /** AC5: end-of-stream drain — no retries, no descriptor left pending. */
  drain?: boolean;
  /** AC3: the server-wide capacity dispatcher (the only admission gate). */
  dispatcher?: ConfirmDiveDispatcher;
  /** AC3: wall-ms a descriptor may wait for a slot before it is stamped. */
  queueWaitMs?: number;
  /** AC3: injectable wall clock (tests). */
  nowMs?: number;
  /** Persist the adoption (the promote-in-place write path). */
  adopt: (entry: PendingConfirmDive, result: ConfirmDiveResult) => Promise<ConfirmDiveAdoption["kind"] | void> | ConfirmDiveAdoption["kind"] | void;
  log?: (line: string) => void;
}): Promise<ConfirmDivePumpOutcome> {
  const out: ConfirmDivePumpOutcome = { dives: 0, dropped: 0, promoted: 0, refuted: 0, retries: 0, queued: 0, overflowDropped: 0 };
  const log = deps.log ?? ((line: string) => console.error(line));
  const tag = `[live-confirm:${deps.jobId}]`;
  const nowTs = deps.nowTs;
  const nowMs = Number.isFinite(deps.nowMs) ? (deps.nowMs as number) : Date.now();
  const dispatcher = deps.dispatcher ?? ConfirmDiveDispatcher.unbounded();
  const queueWaitMs = Math.max(0, deps.queueWaitMs ?? LIVE_CONFIRM_QUEUE_WAIT_MS);
  // AC4: a ring eviction is a DROP with a stamped reason, never a silent shift().
  // The count was taken at eviction time; this only settles the row (adoption).
  const pendingKeys = new Set(deps.run.pendingConfirmDives().map(confirmDiveKey));
  for (const evicted of deps.run.takeOverflowedConfirmDives?.() ?? []) {
    // A re-produced descriptor with the same key is still pending — diving it
    // wins, so the evicted stale copy is not stamped over the live one.
    if (pendingKeys.has(confirmDiveKey(evicted))) continue;
    out.overflowDropped++;
    log(`${tag} descriptor overflow: ${evicted.highlightId} dropped (pending ring full)`);
    await deps.adopt(evicted, droppedDiveResult("descriptor_overflow"));
  }
  const due = planDueConfirmDives(deps.run.pendingConfirmDives(), {
    nowTs,
    lookaheadS: deps.lookaheadS,
    attempted: deps.run.confirmDiveAttempted(),
    reuseWindowS: deps.reuseWindowS,
  });
  // AC2/AC3: admitted dives run CONCURRENTLY — the pump awaits them together, so
  // one stream can hold N in flight (bounded only by decide capacity). The loop
  // itself never awaits a dive, so admission is decided against the in-flight
  // count of the whole batch.
  const running: Promise<void>[] = [];
  for (const entry of due) {
    const key = confirmDiveKey(entry);
    // AC3: capacity first. A full pool must not consume the emergency brake's
    // token — the descriptor stays PENDING and keeps its place in the queue.
    const capacity = dispatcher.capacity();
    if (!dispatcher.tryAdmit()) {
      const waitedMs = deps.run.noteConfirmDiveQueueWait?.(key, nowMs) ?? 0;
      deps.run.noteConfirmDiveQueued?.(capacity);
      out.queued++;
      if (deps.drain !== true && waitedMs < queueWaitMs) {
        log(
          `${tag} no free decide slot (inFlight=${dispatcher.inFlight}/${capacity}) — dive for ` +
            `${entry.highlightId} stays PENDING (waited ${Math.round(waitedMs)} ms of ${queueWaitMs} ms), replanned next tick`
        );
        continue;
      }
      // Terminal ONLY at stream end or after the explicit queue bound (AC3):
      // settle the row with a stamped reason, no model call.
      deps.run.dropPendingConfirmDive(key);
      deps.run.clearConfirmDiveQueueWait?.(key);
      deps.run.noteConfirmDiveDropped("pool_busy");
      out.dropped++;
      log(
        `${tag} no free decide slot (inFlight=${dispatcher.inFlight}/${capacity}) — dive for ` +
          `${entry.highlightId} stamped pool_busy after ${Math.round(waitedMs)} ms${deps.drain ? " at stream end" : ""}`
      );
      await deps.adopt(entry, droppedDiveResult("pool_busy"));
      continue;
    }
    // AC1: the OPTIONAL emergency brake, inert at the shipped default. Checked
    // after the slot so a capacity refusal never spends a brake token.
    if (!deps.run.confirmBudget.allow(nowTs, deps.maxDivesPer300s ?? null)) {
      dispatcher.release();
      out.retries++;
      if (deps.drain !== true) {
        log(`${tag} emergency dive brake (${normalizeConfirmDiveCap(deps.maxDivesPer300s)}/300 s) — dive for ${entry.highlightId} stays PENDING`);
        continue;
      }
      deps.run.dropPendingConfirmDive(key);
      deps.run.noteConfirmDiveDropped("budget");
      out.dropped++;
      log(`${tag} emergency dive brake exhausted at stream end — ${entry.highlightId} abandoned with a stamped budget drop`);
      await deps.adopt(entry, droppedDiveResult("budget"));
      continue;
    }
    // One attempt per entry, marked BEFORE the call so a retried pump can never
    // double-bill the same goal.
    deps.run.noteConfirmDiveAttempt(key);
    deps.run.clearConfirmDiveQueueWait?.(key);
    deps.run.noteConfirmDiveDispatched?.(dispatcher.inFlight, capacity);
    running.push(
      (async () => {
        try {
          const result = await runConfirmDive(entry, deps.io, { jobId: deps.jobId, log });
          out.dives++;
          // AC-A4: only a dive that actually ISSUED a decide call is billable.
          // The two pre-flight drops (`no_persisted_frames`, `frame_unreadable`)
          // never reach the model, so counting them as confirm calls would
          // over-bill `costUsd` and break the identity `confirmCalls == calls
          // made` that a stored-row read grades. `confirmDropped` still counts them.
          if (confirmDiveMadeCall(result)) deps.run.noteConfirmDiveDone(result.ok, result.latencyMs);
          if (!result.ok) {
            deps.run.dropPendingConfirmDive(key);
            deps.run.noteConfirmDiveDropped(result.droppedReason ?? "failed");
            out.dropped++;
            // AC4: stamp the terminal drop verdict on the row (the descriptor is
            // cleared by the same patch), so a finished job never keeps a
            // provisional row with no stored verdict field.
            await deps.adopt(entry, result);
            return;
          }
          const kind = await deps.adopt(entry, result);
          // Settled: the row no longer waits on a dive (the row patch also
          // clears its stored descriptor through the one verdict-move writer).
          deps.run.dropPendingConfirmDive(key);
          if (kind === "promoted") out.promoted++;
          else if (kind === "refuted") out.refuted++;
        } finally {
          dispatcher.release();
        }
      })()
    );
  }
  await Promise.all(running);
  // AC5: a drained pump must leave NO descriptor pending. Anything the plan
  // could not judge (a malformed window) is settled with its own stamped reason
  // rather than left `provisional` with nothing to read on a finished job.
  if (deps.drain === true) {
    const planned = new Set(due.map(confirmDiveKey));
    for (const entry of deps.run.pendingConfirmDives()) {
      const key = confirmDiveKey(entry);
      if (planned.has(key)) continue;
      deps.run.dropPendingConfirmDive(key);
      deps.run.noteConfirmDiveDropped("descriptor_invalid");
      out.dropped++;
      log(`${tag} descriptor ${entry.highlightId} has no judgeable window — stamped descriptor_invalid at stream end`);
      await deps.adopt(entry, droppedDiveResult("descriptor_invalid"));
    }
  }
  return out;
}
