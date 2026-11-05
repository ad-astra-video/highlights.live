// The CUSTOMER projection of a finished job's Analysis windows (ADAAAA-7737).
//
// The wire payload keeps every internal field — decide notes, scores, outcome
// codes, event taxonomy, frame refs, confirm verdicts — because the admin
// surface (decide-note banners, the frame debugger, the decide LLM audit, and
// ADAAAA-7736's clickable decide-note frame refs) reads all of it. The scrub is
// a RENDER-BOUNDARY projection, not a payload filter: a `role=user` session gets
// a time range plus a plain-language status, and `role=admin` keeps the full
// analysis on the same job id. Nothing here fetches, trims or re-requests data,
// so no operator capability is lost.
//
// Customer copy is deliberately plain prose and no numbers (ADAAAA-8135). The
// status now names WHAT was detected instead of collapsing every highlight-kind
// note into one sentence, so a goal the scoring lane demoted can never read as a
// confirmed highlight:
//
//   - a goal-shaped note still in the scoring lane (accepted, or upgraded by a
//     later confirmation) -> "Highlight detected"
//   - a goal-shaped note that LEFT the scoring lane (suppressed/demoted, no
//     confirmation yet) -> "Goal detected — awaiting score confirmation"
//   - a non-goal celebration / near miss / big play -> "Notable play detected"
//   - no highlight-kind note at all -> "Checked — no highlight"
//
// No class taxonomy, no score, no outcome code, no decide attribution, no
// frame-level track counts.
import { noteKind, sectionLabel, type DecideNote, type FrameSection } from "./jobDetail";

/** Customer copy for a window that produced an established highlight. */
export const CUSTOMER_WINDOW_HIGHLIGHT = "Highlight detected";
/** ADAAAA-8135: customer copy for a goal-shaped row the scoring lane demoted —
 *  the model saw a goal, but nothing (yet) confirms the score. */
export const CUSTOMER_WINDOW_GOAL_PENDING = "Goal detected — awaiting score confirmation";
/** ADAAAA-8135: customer copy for a non-goal celebration (near miss / big play). */
export const CUSTOMER_WINDOW_NOTABLE = "Notable play detected";
/** Customer copy for a window that was analysed and produced nothing postable. */
export const CUSTOMER_WINDOW_CHECKED = "Checked — no highlight";

export type CustomerWindowStatus =
  | typeof CUSTOMER_WINDOW_HIGHLIGHT
  | typeof CUSTOMER_WINDOW_GOAL_PENDING
  | typeof CUSTOMER_WINDOW_NOTABLE
  | typeof CUSTOMER_WINDOW_CHECKED;

/** Non-scoring verdict classes: a note carrying one of these is NOT a goal
 *  claim, even when the candidate event taxonomy said `GOAL`. */
const NON_GOAL_OUTCOMES = ["near_miss", "big_play"] as const;

/**
 * Does this decide note CLAIM a goal? True for a `scoring_play` outcome and for
 * a `GOAL` event with no demoting outcome attached. A `GOAL` candidate the
 * model scored `near_miss` / `big_play` is a celebration, not a goal claim.
 */
export function isGoalShapedNote(note: DecideNote): boolean {
  if (note.outcome === "scoring_play") return true;
  if (note.outcome && (NON_GOAL_OUTCOMES as readonly string[]).includes(note.outcome)) return false;
  return (note.eventType ?? "").toUpperCase() === "GOAL";
}

/**
 * Is this goal claim established — i.e. still in the scoring lane? Either the
 * note was accepted, or a later confirmation pass upgraded it
 * (`confirm.decision.goalConfirmed === "confirmed_goal"`). Neither case is a
 * "detected but unconfirmed" goal.
 */
export function isEstablishedGoalNote(note: DecideNote): boolean {
  if (!isGoalShapedNote(note)) return false;
  if (note.status === "accepted") return true;
  return note.confirm?.decision?.goalConfirmed === "confirmed_goal";
}

/**
 * Plain-language status for one customer-visible analysis window
 * (ADAAAA-8135). Precedence: an established goal beats a pending goal beats a
 * non-goal highlight; a window with no highlight-kind note is "checked".
 *
 * `noteKind` stays the single source of truth for what counts as a
 * highlight-kind note — a `not_highlight` verdict or `isHighlight === false` is
 * never a detected play, so a suppressed candidate can never invent a goal.
 */
export function customerWindowStatus(section: FrameSection): CustomerWindowStatus {
  const notes = section.decideNotes.filter((n) => noteKind(n) !== "not_highlight");
  if (notes.some(isEstablishedGoalNote)) return CUSTOMER_WINDOW_HIGHLIGHT;
  if (notes.some(isGoalShapedNote)) return CUSTOMER_WINDOW_GOAL_PENDING;
  if (notes.length > 0) return CUSTOMER_WINDOW_NOTABLE;
  return CUSTOMER_WINDOW_CHECKED;
}

/** The window's time range — the ONLY timing a customer sees. */
export function customerWindowRange(section: FrameSection): string {
  return sectionLabel(section);
}

/** Stable `data-*` values for a customer window status (a test/QA hook that is
 *  itself customer-safe copy). */
export type CustomerWindowKey = "highlight" | "goal_pending" | "notable" | "checked";

export function customerWindowStatusKey(status: CustomerWindowStatus): CustomerWindowKey {
  switch (status) {
    case CUSTOMER_WINDOW_HIGHLIGHT:
      return "highlight";
    case CUSTOMER_WINDOW_GOAL_PENDING:
      return "goal_pending";
    case CUSTOMER_WINDOW_NOTABLE:
      return "notable";
    case CUSTOMER_WINDOW_CHECKED:
      return "checked";
  }
}
