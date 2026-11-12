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
export type ClipWindowPlacementReason =
  | "goal_anchor"
  | "celebration_tail"
  | "evidence_anchor"
  /** ADAAAA-8740 (§6.3 rule 2): the group's goal instant does NOT fit the cue's
   *  tail window, so the card is goal-anchored at the fixed length and the cue
   *  keeps its actual position inside it. Goal containment beats
   *  celebration-at-end when the two conflict. */
  | "goal_anchor_over_leading_cue";

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

// ---------------------------------------------------------------------------
// ADAAAA-8740 (§6.3): ONE decision over the EVENT GROUP, not over the row.
// ---------------------------------------------------------------------------
//
// Row-local placement cannot see that a SIBLING row of the same event carries
// the goal instant. Measured on the graded leg (`1b0a3221-e805-452e-a3f5-fdeb6693766e`,
// read-only psql, 2026-11-12): the reaction cue `localizedTs 96.500`
// (`peak_audio_reaction`, judged window `[86.5, 96.5]`, no goal instant in the
// row) and the measured transition `localizedTs 102.743` were the SAME goal.
// The tail rule put the cue card's end at `98.500` — 4.243 s before the ball
// crossed — and the goal row shipped a second, overlapping card beside it
// (`rowAccounting {servedCards 2, persistedRows 2, acceptedWindows 1,
// suppressedWindows 0, demotedCelebrations 1}`). Both rules were right; the
// composition was not.
//
// Precedence inside the group (§6.3):
//   1. goal containment beats celebration-at-end — a goal instant that fits
//      `[cue - (d - tail), cue + tail]` keeps `celebration_tail` (goal inside);
//   2. a goal instant that does NOT fit => a goal-anchored card at the same
//      fixed length, `goal_anchor_over_leading_cue`, with the cue's actual
//      position disclosed in `clipCelebrationOffsetSec`. The celebration stays
//      in the card where it falls; it is never forced to the end at the price
//      of the goal;
//   3. one card per event group — when the group's goal row ships, a cue row
//      whose card competes with it is SUPPRESSED (`cue_row_covered_by_goal`),
//      not demoted-and-still-served. Recall is preserved: the goal row IS the
//      card, and the duplicate is what costs a debit and confuses the reel.
//
// Pure arithmetic: no store, no ffmpeg, no model call. The live accept path
// supplies the rows it already delivered plus the row it is deciding; the VOD
// rail never calls this (it passes `live: false` to `placeLiveClipWindow` and
// stays byte-identical).

/** Why a cue row is dropped from the group's delivery. */
export type ClipGroupSuppressionReason = "cue_row_covered_by_goal";

/** One decided row of an event group, as the group decision sees it. */
export interface ClipEventGroupRow {
  /** The persisted row id, when the row already exists (a delivered row). */
  id?: string;
  /** The instant this row's accept is anchored on (content clock). */
  localizedTs: number;
  /** The row's `localizeAnchorReason` (see {@link GOAL_INSTANT_ANCHORS}). */
  anchorReason?: string | null;
  /** The row's nominal `clipWindow(...)` window (a row still being placed). */
  window?: { start: number; end: number };
  /** The card the row already carries (a delivered row). */
  card?: { start: number; end: number };
  /** The placement a DELIVERED row shipped with (`clipPlacementReason`), so an
   *  event-group card for that row reports the reason the viewer's card has. */
  placementReason?: ClipWindowPlacementReason;
  /** A goal instant this row names independently of its anchor. */
  knownGoalTs?: number | null;
}

/** One emitted card of the group (`rowIndex` keys it back to the input row). */
export interface ClipEventGroupCard {
  rowIndex: number;
  start: number;
  end: number;
  reason?: ClipWindowPlacementReason;
}

/** One suppressed cue row of the group. */
export interface ClipEventGroupSuppression {
  rowIndex: number;
  id?: string;
  /** The cue row's own anchor instant. */
  localizedTs: number;
  /** The group goal instant the cue row could not hold. */
  goalTs: number;
  reason: ClipGroupSuppressionReason;
}

export interface PlacedClipEventGroup {
  /** The event's measured goal instant, when the group names one. */
  goalTs: number | null;
  /** Index of the row that owns the goal card, or null when none ships. */
  goalRowIndex: number | null;
  /** Per input row, in input order. */
  rows: Array<{
    row: ClipEventGroupRow;
    /** The placed window, or null for a delivered row / a suppressed row. */
    placed: PlacedClipWindow | null;
    suppressed: ClipGroupSuppressionReason | null;
  }>;
  /** The cards the group emits. A conflicting event emits exactly ONE. */
  cards: ClipEventGroupCard[];
  suppressed: ClipEventGroupSuppression[];
}

/** The goal instant a row names, or null when the row is a reaction cue. */
function namedGoalInstant(row: ClipEventGroupRow): number | null {
  const explicit = row.knownGoalTs;
  if (Number.isFinite(explicit as number)) return explicit as number;
  if (GOAL_INSTANT_ANCHORS.has(String(row.anchorReason ?? "")) && Number.isFinite(row.localizedTs)) {
    return row.localizedTs;
  }
  return null;
}

/** The tail card a reaction cue would ship on its own (`[cue - (d - tail), cue + tail]`). */
function tailCard(cue: number, dur: number, tailS?: number): { start: number; end: number } {
  const requested = Number.isFinite(tailS as number) ? (tailS as number) : CELEBRATION_TAIL_S;
  const tail = Math.max(CELEBRATION_TAIL_MIN_S, Math.min(CELEBRATION_TAIL_MAX_S, Math.min(requested, dur)));
  return { start: Math.max(0, cue - (dur - tail)), end: Math.max(0, cue - (dur - tail)) + dur };
}

/**
 * Place a cue row goal-anchored at the fixed length (§6.3 rule 2).
 *
 * The goal sits at the row's nominal cue offset (the ACC-2 `0.467 d` shape the
 * `measured_transition` rows already use), which makes the card identical to
 * the goal row's own card. The start slides back as far as needed to keep the
 * celebration inside the card too; when the cue→goal gap is wider than the card
 * both cannot fit, and goal containment wins (ruling 1: detail value — the
 * board's complaint is the missing goal).
 */
function placeGoalAnchoredCue(cue: number, goalTs: number, window: { start: number; end: number }): PlacedClipWindow {
  const dur = Math.max(0, window.end - window.start);
  const nominalOffset = Math.max(0, Math.min(dur, cue - window.start));
  const preferred = goalTs - nominalOffset;
  // Every start in [goalTs - d, goalTs] contains the goal; every start in
  // [cue - d, cue] contains the cue. Prefer the ACC-2 shape, then the
  // intersection when one exists.
  const goalLo = Math.max(0, goalTs - dur);
  const goalHi = goalTs;
  const bothLo = Math.max(goalLo, Math.max(0, cue - dur));
  const bothHi = Math.min(goalHi, cue);
  const start =
    bothLo <= bothHi
      ? Math.max(bothLo, Math.min(bothHi, preferred))
      : Math.max(goalLo, Math.min(goalHi, preferred));
  const offset = Math.max(0, Math.min(dur, cue - start));
  return {
    start,
    end: start + dur,
    reason: "goal_anchor_over_leading_cue",
    cueOffsetSec: offset,
    celebrationOffsetSec: offset,
    reactionCue: true,
  };
}

/**
 * §6.3 rule 3: does this cue card compete with the group's goal card?
 *
 * Same event = the two cards overlap on the footage. (A cue whose card shares
 * only an edge with the goal card is a different moment — the ADAAAA-8087 R2
 * shape — so it keeps its own row.) The cue row is the duplicate when the goal
 * row already carries the event's card.
 */
export function cueCardCompetesWithGoal(
  cueCard: { start: number; end: number },
  goalCard: { start: number; end: number }
): boolean {
  return cueCard.start < goalCard.end && goalCard.start < cueCard.end;
}

/**
 * The ONE placement decision over an event group (ADAAAA-8740, §6.3).
 *
 * @param rows   the group's decided rows in accept order. Delivered rows carry
 *               `card`; the row under decision carries `window`.
 * @param goalTs a goal instant the caller knows for the group and no row of the
 *               group names (a credited transition whose row did not ship).
 * @param live   the live rail's decision. `false` leaves every row on the VOD
 *               placement and suppresses nothing.
 * @param tailS  override for the celebration tail (tests); clamped to 1.5-2.5 s.
 */
export function placeLiveEventGroupClipWindows(input: {
  rows: readonly ClipEventGroupRow[];
  goalTs?: number | null;
  live?: boolean;
  tailS?: number;
}): PlacedClipEventGroup {
  const rows = input.rows;
  const live = input.live === true;
  const goalRowIndex = rows.findIndex((r) => namedGoalInstant(r) != null);
  const goalRow = goalRowIndex >= 0 ? rows[goalRowIndex] : undefined;
  const explicitGoal = Number.isFinite(input.goalTs as number) ? (input.goalTs as number) : null;
  const goalTs = explicitGoal ?? (goalRow ? namedGoalInstant(goalRow) : null);
  const goalCard =
    goalRow && goalRow.card
      ? goalRow.card
      : goalRow && goalRow.window
        ? { start: goalRow.window.start, end: goalRow.window.end }
        : null;

  const out: PlacedClipEventGroup = {
    goalTs,
    goalRowIndex: goalRowIndex >= 0 ? goalRowIndex : null,
    rows: [],
    cards: [],
    suppressed: [],
  };

  rows.forEach((row, i) => {
    const named = namedGoalInstant(row);
    // 0. The VOD rail / a row with no live judgment: nominal placement, no group
    //    rule. Byte-identical to the pre-8740 path.
    if (!live) {
      const placed = row.window
        ? placeLiveClipWindow({
            localizedTs: row.localizedTs,
            anchorReason: row.anchorReason,
            knownGoalTs: named,
            window: row.window,
            live: false,
          })
        : null;
      out.rows.push({ row, placed, suppressed: null });
      if (placed) out.cards.push({ rowIndex: i, start: placed.start, end: placed.end, reason: placed.reason });
      // A delivered row is not re-placed: it keeps the card (and the reason) it
      // shipped with, so an event-group card for it is auditable from the group.
      else if (row.card)
        out.cards.push({
          rowIndex: i,
          start: row.card.start,
          end: row.card.end,
          ...(row.placementReason ? { reason: row.placementReason } : {}),
        });
      return;
    }
    // 1. The row names the goal instant: the §1 placement, untouched (ACC-2).
    if (named != null) {
      const placed = row.window
        ? placeLiveClipWindow({
            localizedTs: row.localizedTs,
            anchorReason: row.anchorReason,
            knownGoalTs: named,
            window: row.window,
            live: true,
          })
        : null;
      out.rows.push({ row, placed, suppressed: null });
      if (placed) out.cards.push({ rowIndex: i, start: placed.start, end: placed.end, reason: placed.reason });
      // A delivered row is not re-placed: it keeps the card (and the reason) it
      // shipped with, so an event-group card for it is auditable from the group.
      else if (row.card)
        out.cards.push({
          rowIndex: i,
          start: row.card.start,
          end: row.card.end,
          ...(row.placementReason ? { reason: row.placementReason } : {}),
        });
      return;
    }
    // 2. A reaction cue row. Its own card (delivered rows) or the tail card it
    //    would ship on its own.
    const dur = row.window ? Math.max(0, row.window.end - row.window.start) : goalCard ? goalCard.end - goalCard.start : 0;
    const cueCard = row.card ?? tailCard(row.localizedTs, dur, input.tailS);
    // 2a. (§6.3 rule 3) The group's goal row ships and this cue card competes
    //     with it: the cue row is suppressed, not served beside it.
    if (goalRow && goalCard && goalTs != null && i !== goalRowIndex && cueCardCompetesWithGoal(cueCard, goalCard)) {
      out.rows.push({ row, placed: null, suppressed: "cue_row_covered_by_goal" });
      out.suppressed.push({
        rowIndex: i,
        ...(row.id ? { id: row.id } : {}),
        localizedTs: row.localizedTs,
        goalTs,
        reason: "cue_row_covered_by_goal",
      });
      return;
    }
    // 2b. (§6.3 rule 1) A known goal instant that fits the cue's tail window:
    //     celebration_at_end stands, the goal is inside the card.
    if (goalTs != null && row.window && !goalRow) {
      const tail = tailCard(row.localizedTs, dur, input.tailS);
      if (goalTs >= tail.start && goalTs <= tail.end) {
        const placed = placeLiveClipWindow({
          localizedTs: row.localizedTs,
          anchorReason: row.anchorReason,
          window: row.window,
          live: true,
          tailS: input.tailS,
        });
        out.rows.push({ row, placed, suppressed: null });
        out.cards.push({ rowIndex: i, start: placed.start, end: placed.end, reason: placed.reason });
        return;
      }
      // 2c. (§6.3 rule 2) It does not fit: goal-anchored card, cue's real offset
      //     disclosed. The celebration is not forced to the end at the goal's
      //     price.
      const placed = placeGoalAnchoredCue(row.localizedTs, goalTs, row.window);
      out.rows.push({ row, placed, suppressed: null });
      out.cards.push({ rowIndex: i, start: placed.start, end: placed.end, reason: placed.reason });
      return;
    }
    // 3. No goal in the group: the shipped tail rule, unchanged.
    const placed = row.window
      ? placeLiveClipWindow({
          localizedTs: row.localizedTs,
          anchorReason: row.anchorReason,
          window: row.window,
          live: true,
          tailS: input.tailS,
        })
      : null;
    out.rows.push({ row, placed, suppressed: null });
    if (placed) out.cards.push({ rowIndex: i, start: placed.start, end: placed.end, reason: placed.reason });
    // A delivered row is not re-placed: it keeps the card (and the reason) it
    // shipped with, so an event-group card for it is auditable from the group.
    else if (row.card)
      out.cards.push({
        rowIndex: i,
        start: row.card.start,
        end: row.card.end,
        ...(row.placementReason ? { reason: row.placementReason } : {}),
      });
  });
  return out;
}
