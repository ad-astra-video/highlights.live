// ADAAAA-7984 (ADAAAA-7953 decision A+): deliver a post-goal celebration/replay
// window as an ALTERNATIVE CLIP of the GOAL highlight it follows.
//
// Context, all verified on the canonical 90 s clip (job
// 64668dff-a200-4afb-bcc0-3f2fe77be769): the ADAAAA-7865 dedup + the
// ADAAAA-7938 prior-game-state prompt stop a post-goal window being accepted as
// a SECOND scoring GOAL — every celebration window 45-89.7 s decides
// `big_play`/`near_miss` and is then rejected by the scoring-only precision gate.
// Correct precision, but the goal's aftermath was dropped: `notScoringHighlights
// = 0`, `notableHighlights = 0`, one highlight total.
//
// The board decided (2026-11-04) to DELIVER those windows as celebration clips
// tied to the goal highlight and presented as alternatives of it. This module
// owns that delivery, and it is deliberately a SEPARATE row set
// (`highlight_alternatives`), not `HighlightRecord`s:
//
//   * an alternative is NOT a highlight — `highlightsFound`, `postableHighlights`,
//     `notScoringHighlights` and `notableHighlights` must stay exactly what the
//     7865/7938 runs reported (AC1/AC3), and every counter in the server is
//     derived from `store.highlightsForJob()`, so a celebration row living there
//     would silently inflate the customer-facing clip count;
//   * the verdicts are ALREADY PAID (the decide pass judged these windows), so
//     delivery costs clip cut + encode + storage only — no decide, no confirm, no
//     new GPU work (AC4).
//
// Selection is deterministic from STORED rows (the persisted `job_candidates`
// verdicts + the accepted GOAL rows), never from arrival order: nearest to the
// goal clip end first, tie-break decide confidence descending, then the earlier
// window. A cap of {@link MAX_ALTERNATIVES_PER_HIGHLIGHT} applies per goal.
import { createHash } from "node:crypto";
import {
  CELEBRATION_ALTERNATIVE_EVENT_TYPE,
  HIGHLIGHT_ALTERNATIVE_RELATION,
  MAX_ALTERNATIVES_PER_HIGHLIGHT,
  HighlightAlternativeSchema,
  type HighlightAlternative,
  type HighlightRecord,
  type JobCandidate,
} from "@highlights/events";
import { GOAL_DUPLICATE_REACH_S } from "./analyzer";

/** Verdict classes a celebration window may carry. Both are non-scoring: the
 * window's own read says "not a second score transition". `not_highlight` is
 * excluded — that window judged nothing worth watching. */
const CELEBRATION_OUTCOMES = new Set(["big_play", "near_miss"]);

/** The owning-goal facts selection needs (a scoring GOAL highlight row). */
export interface CelebrationOwner {
  highlightId: string;
  /** The goal's content instant (the clip is centered on it). */
  anchorTs: number;
  /** The delivered GOAL clip window. */
  start: number;
  end: number;
}

/** One eligible post-goal window: the decide verdict that was rejected at the
 * scoring-only gate, plus the distance the selection orders on. */
export interface CelebrationWindow {
  /** The decide window anchor (content seconds). */
  anchorTs: number;
  /** The verdict's non-scoring outcome class. */
  outcome: "big_play" | "near_miss";
  /** The decide confidence the verdict carried (tie-break). */
  score: number;
  /** |anchorTs - owner clip end| — nearest to the goal clip end wins. */
  distanceToGoalEndS: number;
  /** The verdict's own reason (audit only; never customer copy). */
  reason?: string;
}

/** Clip-window inputs the alternative cut needs. Mirrors the accepted-clip rule:
 * the operator's configured pre/post roll, floored at the >=15 s product minimum. */
export interface AlternativeClipConfig {
  /** Decide-window pre-roll: the celebration window's own start (default 2 s). */
  preWindowS?: number;
  clipBeforeS: number;
  clipAfterS: number;
  clipWindowMinSec?: number;
}

/** The delivered alternative clip window for one celebration window.
 *
 * Anchored on the WINDOW'S OWN START (`anchorTs - preWindowS`) and then running
 * the configured clip length, NOT on `anchorTs - clipBeforeS`: a celebration
 * window lands in the post-goal band, so subtracting a 7 s pre-roll would drag
 * the clip back inside the goal highlight's own footage. Starting at the window
 * start keeps every delivered alternative inside the post-goal band the
 * ADAAAA-7938 verification measured (45-89.7 s on the canonical clip) while the
 * clip length still follows the operator's clip-window setting. Pure.
 */
export function alternativeClipWindow(
  anchorTs: number,
  cfg: AlternativeClipConfig
): { start: number; end: number } {
  const pre = Number.isFinite(cfg.preWindowS) && (cfg.preWindowS as number) >= 0 ? (cfg.preWindowS as number) : 2;
  const len = Math.max(
    Math.max(0, cfg.clipBeforeS) + Math.max(0, cfg.clipAfterS),
    Math.max(0, cfg.clipWindowMinSec ?? 15)
  );
  const start = Math.max(0, anchorTs - pre);
  return { start, end: start + len };
}

/** ADAAAA-7984 §6: the dedupe key is owning highlight id + window anchor, so a
 * re-run of the same windows can never persist a second alternative or cut a
 * second clip. The anchor is quantized to 1 ms to keep the key stable across
 * float formatting (the decide anchors are 3 s cadence values). */
export function alternativeDedupeKey(highlightId: string, anchorTs: number): string {
  return `alt:${highlightId}:${anchorTs.toFixed(3)}`;
}

/** The alternative row id derived from the dedupe key: a re-run produces the
 * SAME id, so the DB upsert/key is idempotent and the clip file is reused. */
export function alternativeIdFor(dedupeKey: string): string {
  const h = createHash("sha256").update(dedupeKey).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The goal a post-goal window belongs to: the nearest accepted GOAL whose
 * content instant is at or before the window and within
 * {@link GOAL_DUPLICATE_REACH_S} (the SAME reach the 7865 dedup uses — no second
 * threshold constant). `undefined` when the window is not a post-goal window. */
export function owningGoalFor(
  owners: readonly CelebrationOwner[],
  anchorTs: number,
  reachS: number = GOAL_DUPLICATE_REACH_S
): CelebrationOwner | undefined {
  if (!Number.isFinite(anchorTs)) return undefined;
  let best: CelebrationOwner | undefined;
  let bestDiff = Infinity;
  for (const o of owners) {
    const diff = anchorTs - o.anchorTs;
    // STRICTLY after the goal: a pre-goal window is not the goal's aftermath.
    if (!(diff > 0) || diff > reachS) continue;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = o;
    }
  }
  return best;
}

/** Is this persisted decide verdict an eligible celebration window for `owner`? */
export function isCelebrationWindow(
  c: Pick<JobCandidate, "status" | "outcome" | "timestamp">,
  owner: CelebrationOwner,
  reachS: number = GOAL_DUPLICATE_REACH_S
): boolean {
  // Only a REJECTED window: an accepted one is either the goal itself or a
  // distinct scoring event, and those must never be re-labelled a celebration.
  if (c.status !== "rejected") return false;
  if (!c.outcome || !CELEBRATION_OUTCOMES.has(c.outcome)) return false;
  const diff = c.timestamp - owner.anchorTs;
  return diff > 0 && diff <= reachS;
}

/** Build the ordered eligible set for one owner from persisted verdicts. */
export function celebrationWindowsFor(
  candidates: readonly Pick<JobCandidate, "status" | "outcome" | "timestamp" | "score" | "reason">[],
  owner: CelebrationOwner
): CelebrationWindow[] {
  const out: CelebrationWindow[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!isCelebrationWindow(c as JobCandidate, owner)) continue;
    const key = c.timestamp.toFixed(3);
    // One alternative per window anchor, however many rows re-decided it.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      anchorTs: c.timestamp,
      outcome: c.outcome as "big_play" | "near_miss",
      score: Number.isFinite(c.score) ? Math.min(100, Math.max(0, c.score)) : 0,
      distanceToGoalEndS: Math.abs(c.timestamp - owner.end),
      reason: c.reason,
    });
  }
  return out;
}

/**
 * ADAAAA-7984 §4: deterministic cap + selection. Nearest to the goal clip end
 * first, tie-break decide confidence descending, then the earlier window (so the
 * result never depends on the order rows arrived in). Never arrival-order or
 * random.
 */
export function selectCelebrationAlternatives(
  windows: readonly CelebrationWindow[],
  max: number = MAX_ALTERNATIVES_PER_HIGHLIGHT
): CelebrationWindow[] {
  const cap = Math.max(0, Math.floor(max));
  if (cap === 0) return [];
  return [...windows]
    .sort(
      (a, b) =>
        a.distanceToGoalEndS - b.distanceToGoalEndS ||
        b.score - a.score ||
        a.anchorTs - b.anchorTs
    )
    .slice(0, cap);
}

/** The owner facts for a stored highlight row (a scoring GOAL). The clip end is
 * the delivered clip's end; the anchor is the localized instant the clip is
 * centered on, falling back to the clip midpoint for legacy rows. */
export function celebrationOwnerOf(h: HighlightRecord): CelebrationOwner {
  const anchorTs = Number.isFinite(h.localizedTs as number)
    ? (h.localizedTs as number)
    : (h.start + h.end) / 2;
  return { highlightId: h.id, anchorTs, start: h.start, end: h.end };
}

/** Is this stored highlight row a scoring GOAL that can own alternatives? */
export function canOwnAlternatives(h: HighlightRecord): boolean {
  return h.status !== "rejected" && h.outcome === "scoring_play";
}

/** Build the alternative row for one selected window. `clip` is the cut result
 * (empty `clipUri` when the cut failed — the row still records the delivery
 * attempt with `clipError`, mirroring the highlight clip contract). */
export function buildCelebrationAlternative(input: {
  jobId: string;
  ownerId?: string;
  owner: CelebrationOwner;
  window: CelebrationWindow;
  clip: { clipId: string; clipUri: string };
  clipWindow: { start: number; end: number };
  clipError?: string;
  createdAt?: string;
}): HighlightAlternative {
  const dedupeKey = alternativeDedupeKey(input.owner.highlightId, input.window.anchorTs);
  return HighlightAlternativeSchema.parse({
    id: alternativeIdFor(dedupeKey),
    ownerId: input.ownerId,
    jobId: input.jobId,
    highlightId: input.owner.highlightId,
    relation: HIGHLIGHT_ALTERNATIVE_RELATION,
    eventType: CELEBRATION_ALTERNATIVE_EVENT_TYPE,
    outcome: input.window.outcome,
    windowAnchorTs: input.window.anchorTs,
    distanceToGoalEndS: input.window.distanceToGoalEndS,
    score: input.window.score,
    start: input.clipWindow.start,
    end: input.clipWindow.end,
    clipId: input.clip.clipId || undefined,
    clipUri: input.clip.clipUri,
    clipError: input.clipError,
    dedupeKey,
    reason: input.window.reason,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

/** Group delivered alternatives under their owning highlight ids (payload shape). */
export function groupAlternativesByOwner(
  alternatives: readonly HighlightAlternative[]
): Map<string, HighlightAlternative[]> {
  const out = new Map<string, HighlightAlternative[]>();
  for (const a of [...alternatives].sort((x, y) => x.windowAnchorTs - y.windowAnchorTs)) {
    const list = out.get(a.highlightId) ?? [];
    list.push(a);
    out.set(a.highlightId, list);
  }
  return out;
}

/** The delivery seam's dependencies. Narrowed to what delivery actually reads so
 * a test can drive it with a plain in-memory store. */
export interface CelebrationDeliveryDeps {
  store: {
    highlightsForJob(jobId: string): HighlightRecord[];
    candidatesForJob(jobId: string): Pick<JobCandidate, "status" | "outcome" | "timestamp" | "score" | "reason">[];
    alternativeByKey(dedupeKey: string): HighlightAlternative | undefined;
    addAlternative(a: HighlightAlternative): Promise<{ record: HighlightAlternative; created: boolean }>;
    alternativesForJob(jobId: string): HighlightAlternative[];
  };
  jobId: string;
  ownerId?: string;
  cfg: AlternativeClipConfig & { maxAlternatives?: number };
  /** Clip cutter. `win` is the explicit alternative window; the accept path's
   * own `cut(ts)` keeps its single-argument behaviour. */
  cut: (ts: number, win?: { start: number; end: number }) => Promise<{ clipId: string; clipUri: string }>;
  log?: (message: string) => void;
}

/**
 * ADAAAA-7984: deliver the celebration/replay windows of a VOD job as
 * alternative clips attached to their owning GOAL highlight.
 *
 * Derived entirely from STORED rows (the accepted GOAL highlights + the persisted
 * `job_candidates` verdicts), so it is deterministic, resume-safe and gradeable:
 * a resumed attempt that skipped earlier frames still sees every window's
 * verdict, and a second pass re-selects the identical pair. Idempotent on the
 * dedupe key, so an already-delivered window is skipped BEFORE its clip is cut —
 * zero duplicate rows and zero duplicate clip files (AC7).
 *
 * Returns the job's delivered-alternative count (`alternativeClipsDelivered`).
 * Never throws: delivery is additive and must not fail a completed job.
 */
export async function deliverCelebrationAlternatives(deps: CelebrationDeliveryDeps): Promise<number> {
  const max = deps.cfg.maxAlternatives ?? MAX_ALTERNATIVES_PER_HIGHLIGHT;
  try {
    const owners = deps.store.highlightsForJob(deps.jobId).filter(canOwnAlternatives);
    if (owners.length === 0) return deps.store.alternativesForJob(deps.jobId).length;
    const candidates = deps.store.candidatesForJob(deps.jobId);
    for (const h of owners) {
      const owner = celebrationOwnerOf(h);
      const windows = celebrationWindowsFor(candidates, owner);
      if (windows.length === 0) continue;
      for (const w of selectCelebrationAlternatives(windows, max)) {
        const key = alternativeDedupeKey(owner.highlightId, w.anchorTs);
        // Already delivered on this job (a re-run / resumed attempt): reuse the
        // stored row AND the clip it points at. Never re-cut (AC7).
        if (deps.store.alternativeByKey(key)) continue;
        const clipWindow = alternativeClipWindow(w.anchorTs, deps.cfg);
        let clip: { clipId: string; clipUri: string } = { clipId: "", clipUri: "" };
        let clipError: string | undefined;
        try {
          clip = await deps.cut(w.anchorTs, clipWindow);
        } catch (e: any) {
          clipError = String(e?.message || e);
        }
        const row = buildCelebrationAlternative({
          jobId: deps.jobId,
          ownerId: deps.ownerId,
          owner,
          window: w,
          clip,
          clipWindow,
          clipError,
        });
        const { created } = await deps.store.addAlternative(row);
        if (created) {
          deps.log?.(
            `[celebrations:${deps.jobId}] alternative ${row.id} of ${owner.highlightId} ` +
              `window@${w.anchorTs.toFixed(2)}s clip ${row.start.toFixed(1)}-${row.end.toFixed(1)}s`
          );
        }
      }
    }
    return deps.store.alternativesForJob(deps.jobId).length;
  } catch (e: any) {
    deps.log?.(`[celebrations:${deps.jobId}] delivery failed: ${String(e?.message || e)}`);
    return deps.store.alternativesForJob(deps.jobId).length;
  }
}
