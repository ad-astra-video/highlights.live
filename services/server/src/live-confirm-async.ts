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
// Bounds are enforced HERE, not by convention:
//  - one dive per distinct goal (`goalEventTs` + `confirmReuseWindowS`);
//  - `LIVE_CONFIRM_MAX_DIVES_PER_300S` (default 8) per stream;
//  - one dive in flight per stream, and a BUSY decide pool drops (never queues);
//  - context is rebuilt from PERSISTED artifacts only (frames on disk + the
//    stage-1 analysis). A signal that cannot be reconstructed (motion
//    trajectories, optical flow, the audio clip) is stamped in `contextDegraded`
//    and sent EMPTY — a missing signal is never credited and never fabricated;
//  - every failure (no frames, timeout, transport, parse/passthrough) fails
//    closed: the row is untouched and the dive is counted as dropped.
import { selectRereadFrames, withTimeout, type FrameRereadCandidate } from "./live-frame-reread.js";

/** Default per-stream dive budget: one 300 s window may spend at most this many. */
export const LIVE_CONFIRM_MAX_DIVES_PER_300S = 8;
/** The budget's sliding window (seconds). */
export const LIVE_CONFIRM_BUDGET_WINDOW_S = 300;
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
}

/**
 * Sliding per-stream dive budget.
 *
 * Content-clock based (the same clock the window schedule uses), so a 300 s
 * window means 300 s of STREAM, not 300 s of wall time — a stalled stream cannot
 * bank dives. Refusals are counted, so AC-A4/A6 are readable off the record.
 */
export class ConfirmDiveBudget {
  private stamps: number[] = [];
  private refusals = 0;

  /** Spend one dive at `nowTs`, or refuse when the window is exhausted. */
  allow(nowTs: number, max: number = LIVE_CONFIRM_MAX_DIVES_PER_300S): boolean {
    if (!Number.isFinite(nowTs)) return false;
    const cutoff = nowTs - LIVE_CONFIRM_BUDGET_WINDOW_S;
    this.stamps = this.stamps.filter((t) => t > cutoff);
    if (this.stamps.length >= Math.max(0, Math.floor(max))) {
      this.refusals++;
      return false;
    }
    this.stamps.push(nowTs);
    return true;
  }

  /** Dives spent inside the sliding window ending at `nowTs`. */
  count(nowTs: number): number {
    const cutoff = nowTs - LIVE_CONFIRM_BUDGET_WINDOW_S;
    return this.stamps.filter((t) => t > cutoff).length;
  }

  refusalsCount(): number {
    return this.refusals;
  }
}

/**
 * The dives that are DUE: their judged window's lookahead has closed (so the
 * persisted artifacts are final) and the goal has not already had a dive.
 *
 * One dive per distinct goal: entries are ordered by `goalEventTs` and an entry
 * within `reuseWindowS` of an already-selected goal is skipped — the same rule
 * `confirmReconcile` applies to overlapping rolling windows (ADAAAA-7663).
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
    .sort((a, b) => a.goalEventTs - b.goalEventTs);
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
 * `near_miss` / `not_goal` (or a `confirmed_goal` whose corroboration never
 * fired) -> the row stays a celebration with its clip, `provisionalGoal` KEEPS
 * `status: "provisional"` (AC-A7: the badge the CEO sees is not removed), gains
 * `refuted: true`, and the card says the deep dive did not confirm it.
 *
 * Passthrough (`goalConfirmed` null) or an already-resolved row -> the card is
 * untouched; only the pending descriptor is cleared.
 */
export function confirmDiveAdoption(
  row: { outcome?: string; eventType?: string; provisionalGoal?: Record<string, unknown> },
  verdict: ConfirmDiveVerdict | undefined,
  meta: { diveAt: string; diveLatencyMs: number; contextDegraded: DegradedSignal[] }
): ConfirmDiveAdoption {
  const goalConfirmed = verdict?.goalConfirmed ?? null;
  const corroborated = verdict?.corroborated === true;
  const attestation: ConfirmAttestation = {
    goalConfirmed: goalConfirmed ?? "passthrough",
    corroborated,
    corroborationSource: verdict?.corroborationSource ?? null,
    diveAt: meta.diveAt,
    diveLatencyMs: Math.max(0, Math.round(meta.diveLatencyMs)),
    contextDegraded: meta.contextDegraded,
  };
  // A row that already left the provisional lane (e.g. a later scoreboard read
  // re-attested it first) is not rewritten by a late dive: one verdict move.
  if (row.outcome === "scoring_play") {
    return {
      kind: "unchanged",
      patch: { pendingConfirmDive: undefined },
      reason: "row already in the scoring lane — the dive does not rewrite it",
    };
  }
  if (goalConfirmed === null) {
    return {
      kind: "unchanged",
      patch: { pendingConfirmDive: undefined },
      reason: "passthrough (no structured verdict) — row unchanged",
    };
  }
  if (goalConfirmed === "confirmed_goal" && corroborated) {
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
  // Refuted: near_miss / not_goal, or a confirmation with no corroboration.
  const prev = row.provisionalGoal;
  const note =
    goalConfirmed === "confirmed_goal"
      ? "The deep dive described a goal but could not corroborate it, so this moment is still unconfirmed."
      : "The deep dive did not confirm this goal, so this moment stays unconfirmed.";
  const provisional = prev
    ? { ...prev, status: "provisional", refuted: true, note }
    : { status: "provisional", cues: ["asr_goal_call"], declaredTs: 0, note, refuted: true };
  return {
    kind: "refuted",
    patch: {
      provisionalGoal: provisional,
      confirmAttestation: attestation,
      pendingConfirmDive: undefined,
    },
    reason: `deep dive did NOT confirm the goal (goalConfirmed=${goalConfirmed}, corroborated=${corroborated})`,
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
  droppedReason?: "no_persisted_frames" | "frame_unreadable" | "timeout" | "transport_failure" | "passthrough";
  verdict?: ConfirmDiveVerdict;
  context: ConfirmDiveContext;
  latencyMs: number;
  framesSent: number;
}

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
}

/**
 * Pump the due dives for one window: plan -> budget -> busy check -> dive ->
 * adopt. Called OFF the accept path (fire-and-forget by the caller), so a slow
 * dive can never stall the live pass.
 */
export async function runDueConfirmDives(deps: {
  run: ConfirmDiveRunState;
  io: ConfirmDiveIo;
  nowTs: number;
  jobId: string;
  maxDivesPer300s?: number;
  lookaheadS?: number;
  reuseWindowS?: number;
  /** Returns a drop reason when the decide pool is saturated, else null. */
  busy?: () => string | null;
  /** Persist the adoption (the promote-in-place write path). */
  adopt: (entry: PendingConfirmDive, result: ConfirmDiveResult) => Promise<ConfirmDiveAdoption["kind"] | void> | ConfirmDiveAdoption["kind"] | void;
  log?: (line: string) => void;
}): Promise<{ dives: number; dropped: number; promoted: number; refuted: number }> {
  const out = { dives: 0, dropped: 0, promoted: 0, refuted: 0 };
  const log = deps.log ?? ((line: string) => console.error(line));
  const due = planDueConfirmDives(deps.run.pendingConfirmDives(), {
    nowTs: deps.nowTs,
    lookaheadS: deps.lookaheadS,
    attempted: deps.run.confirmDiveAttempted(),
    reuseWindowS: deps.reuseWindowS,
  });
  for (const entry of due) {
    const key = confirmDiveKey(entry);
    // Busy pool: DROP, never queue (AC-A6). Checked before the budget so a busy
    // window cannot consume a dive the stream still needs later.
    const busyReason = deps.busy?.() ?? null;
    if (busyReason) {
      deps.run.dropPendingConfirmDive(key);
      deps.run.noteConfirmDiveDropped(`pool_busy:${busyReason}`);
      out.dropped++;
      log(`[live-confirm:${deps.jobId}] dive for ${entry.highlightId} dropped: decide pool busy (${busyReason})`);
      continue;
    }
    // One attempt per entry, marked BEFORE the call so a retried pump can never
    // double-bill the same goal.
    deps.run.noteConfirmDiveAttempt(key);
    if (!deps.run.confirmBudget.allow(deps.nowTs, deps.maxDivesPer300s)) {
      deps.run.dropPendingConfirmDive(key);
      deps.run.noteConfirmDiveDropped("budget");
      out.dropped++;
      log(
        `[live-confirm:${deps.jobId}] budget (${deps.maxDivesPer300s ?? LIVE_CONFIRM_MAX_DIVES_PER_300S}/` +
          `${LIVE_CONFIRM_BUDGET_WINDOW_S}s) exhausted — dive for ${entry.highlightId} dropped`
      );
      continue;
    }
    const result = await runConfirmDive(entry, deps.io, { jobId: deps.jobId, log });
    out.dives++;
    // AC-A4: only a dive that actually ISSUED a decide call is billable. The two
    // pre-flight drops (`no_persisted_frames`, `frame_unreadable`) never reach
    // the model, so counting them as confirm calls would over-bill `costUsd` and
    // break the identity `confirmCalls == calls made` that a stored-row read
    // grades. `confirmDropped` still counts them (AC-A6).
    if (confirmDiveMadeCall(result)) deps.run.noteConfirmDiveDone(result.ok, result.latencyMs);
    if (!result.ok) {
      deps.run.dropPendingConfirmDive(key);
      deps.run.noteConfirmDiveDropped(result.droppedReason ?? "failed");
      out.dropped++;
      continue;
    }
    const kind = await deps.adopt(entry, result);
    // Settled: the row no longer waits on a dive (the row patch also clears its
    // stored descriptor through the one verdict-move writer).
    deps.run.dropPendingConfirmDive(key);
    if (kind === "promoted") out.promoted++;
    else if (kind === "refuted") out.refuted++;
  }
  return out;
}
