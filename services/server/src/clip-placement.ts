// ADAAAA-8714: ONE decision for WHERE the delivered window sits on the content
// clock, given `(localizedTs, anchorReason, knownGoalTs, window)`.
//
// Sibling, not duplicate, of `clip-anchor.ts`: that module decides which FRAME
// of the recording the card is cut on (pixel probe → score flip → clock).
// This module decides the WINDOW — the `[start, end)` the row promises and the
// crop is asked for — which is a pure arithmetic fact about the accept's anchor.
//
// The defect it fixes (AC1, measured on stored rows 2026-11-12): a live accept
// whose cue is a REACTION (crowd roar / celebration frames) anchors `localizedTs`
// on an instant AFTER the ball crossed (`AUDIO_TRIGGER_LEAD_S` + the onset→fire
// lag), the judged window carries no measured goal instant, and
// `clipWindow(localizedTs, 7, 8, 15)` centred the card on the roar. A goal→roar
// gap > 7 s then put the net outside the card ("the goal was not seen in the
// highlight at all"). Corpus read: 202 `measured_transition` rows sit at exactly
// 7.000 s (0.467 d, ACC-2 holds), while the reaction rows carry the same 7.000 s
// cue offset and can name no goal instant at all — the cue is placed as if it
// were the goal.
//
// The ruling (parent ADAAAA-8709 spec): when the cue IS a reaction/celebration
// and the row cannot name a goal instant, the cue is the card's END —
// `[cue - (window - tail), cue + tail]` with `tail = CELEBRATION_TAIL_S` — so the
// whole judged window (`[cue - 10, cue]` on the live rail) plus the reaction lands
// inside the card. Length is UNCHANGED (>= 15 s floor stays; lengthening the clip
// was refused on ADAAAA-8152). A row that CAN name its goal instant keeps the
// ADAAAA-8152 placement exactly: the tail rule never applies to it.

/** Seconds of card kept AFTER the cue on a reaction-anchored row (1.5-2 s band). */
export const CELEBRATION_TAIL_S = 2;
/** Band bounds: the cue must stay inside `[window - 2.5, window]` (AC2). */
export const CELEBRATION_TAIL_MIN_S = 1.5;
export const CELEBRATION_TAIL_MAX_S = 2.5;

/**
 * Anchor reasons that name a goal INSTANT rather than a reaction cue:
 * - `measured_transition` — the window's own legible scoreboard delta / measured
 *   transition instant (`localizeLiveWindowInstant` steps 1-2);
 * - `frame_attestation` — the earliest judged frame carrying a MEASURED goal
 *   attestation (step 3), i.e. the frame the corroborated dive rests on.
 * Everything else (`peak_audio_reaction`, `peak_audio_far_burst_capped`,
 * `peak_audio_far_rejected`, `trigger_evidence`) is a reaction/celebration cue:
 * it names WHEN THE CROWD REACTED, never when the ball crossed.
 */
export const GOAL_INSTANT_ANCHORS: ReadonlySet<string> = new Set(["measured_transition", "frame_attestation"]);

/** Why the delivered window sits where it does (`clipPlacementReason` on the row). */
export type ClipWindowPlacementReason = "goal_anchor" | "celebration_tail" | "evidence_anchor";

/**
 * The window a rail's `cut(ts, window)` receives: the placed `[start, end)` plus
 * whether the cue is the card's END. `cueTail` tells the footage anchor NOT to
 * re-anchor on a score flip — centring the flip would put the goal at 7 s and
 * push the reaction (the cue) off the end of the card, undoing the placement.
 */
export interface ClipCutWindow {
  start: number;
  end: number;
  cueTail?: boolean;
}

export interface PlacedClipWindow {
  /** Window start on the content clock. */
  start: number;
  /** Window end on the content clock (`start + window length`, floor preserved). */
  end: number;
  reason: ClipWindowPlacementReason;
  /** `localizedTs - start`: where the cue sits inside the placed window. */
  cueOffsetSec: number;
  /** On `celebration_tail` only: the same cue offset, the number AC2 grades. */
  celebrationOffsetSec?: number;
  /** True when the accept's cue is a reaction/celebration, not a goal instant. */
  reactionCue: boolean;
}

/**
 * Place the delivered window. PURE: no store, no ffmpeg, no model call.
 *
 * @param localizedTs  the instant the accept is anchored on (content clock).
 * @param anchorReason the row's `localizeAnchorReason` (see {@link GOAL_INSTANT_ANCHORS}).
 * @param knownGoalTs  a goal instant the caller can name independently (a credited
 *                     transition read elsewhere); wins over `anchorReason`.
 * @param window       the nominal window from `clipWindow(...)` (length already floored).
 * @param live         the judgment is the live lane's trailing window, so a reaction
 *                     cue may END the card. The VOD rail always passes false: its
 *                     placement is unchanged.
 * @param tailS        override for the tail (tests); clamped to the 1.5-2.5 s band.
 */
export function placeLiveClipWindow(input: {
  localizedTs: number;
  anchorReason?: string | null;
  knownGoalTs?: number | null;
  window: { start: number; end: number };
  live?: boolean;
  tailS?: number;
}): PlacedClipWindow {
  const { window } = input;
  const dur = Math.max(0, window.end - window.start);
  const cue = Number.isFinite(input.localizedTs) ? input.localizedTs : window.start;
  // The cue's offset in the NOMINAL window — what an unchanged placement keeps.
  const nominalOffset = Math.max(0, Math.min(dur, cue - window.start));
  const namedGoal = Number.isFinite(input.knownGoalTs as number)
    ? (input.knownGoalTs as number)
    : GOAL_INSTANT_ANCHORS.has(String(input.anchorReason ?? ""))
      ? cue
      : null;

  // 1. The row can NAME its goal instant: ADAAAA-8152 placement, untouched.
  if (namedGoal != null) {
    if (namedGoal >= window.start && namedGoal <= window.end) {
      return { ...window, reason: "goal_anchor", cueOffsetSec: nominalOffset, reactionCue: false };
    }
    // AC3 invariant: never ship a card that does not contain the goal instant it
    // names. Shift by the same cue offset (ACC-2 shape preserved), same length.
    const start = Math.max(0, namedGoal - nominalOffset);
    return { start, end: start + dur, reason: "goal_anchor", cueOffsetSec: cue - start, reactionCue: false };
  }

  // 2. No judged live window (the VOD rail): nominal centre, unchanged.
  if (!input.live) {
    return { ...window, reason: "evidence_anchor", cueOffsetSec: nominalOffset, reactionCue: true };
  }

  // 3. Reaction cue, no goal instant: the cue ENDS the card.
  const requested = Number.isFinite(input.tailS as number) ? (input.tailS as number) : CELEBRATION_TAIL_S;
  const tail = Math.max(CELEBRATION_TAIL_MIN_S, Math.min(CELEBRATION_TAIL_MAX_S, Math.min(requested, dur)));
  // Clamping at 0 (a cue very early in the share) keeps the LENGTH: the tail of
  // the card slides forward instead of the card going short.
  const start = Math.max(0, cue - (dur - tail));
  const offset = Math.max(0, cue - start);
  return {
    start,
    end: start + dur,
    reason: "celebration_tail",
    cueOffsetSec: offset,
    celebrationOffsetSec: offset,
    reactionCue: true,
  };
}
