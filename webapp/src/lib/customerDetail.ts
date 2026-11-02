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
// Customer copy is deliberately two sentences and no numbers: a window that
// holds a highlight-kind note reads "Highlight detected"; anything else (a
// suppressed candidate, a not-highlight verdict, a window with no analysis at
// all) reads "Checked — no highlight". No class taxonomy, no score, no outcome
// code, no decide attribution, no frame-level track counts.
import { noteKind, sectionLabel, type FrameSection } from "./jobDetail";

/** Customer copy for a window that produced a highlight. */
export const CUSTOMER_WINDOW_HIGHLIGHT = "Highlight detected";
/** Customer copy for a window that was analysed and produced nothing postable. */
export const CUSTOMER_WINDOW_CHECKED = "Checked — no highlight";

export type CustomerWindowStatus = typeof CUSTOMER_WINDOW_HIGHLIGHT | typeof CUSTOMER_WINDOW_CHECKED;

/**
 * Plain-language status for one customer-visible analysis window. Only a
 * highlight-kind note makes a window a highlight; a `suppressed` note or a
 * `not_highlight` verdict is "checked, nothing found" from the customer's point
 * of view (the distinction between them is internal taxonomy).
 */
export function customerWindowStatus(section: FrameSection): CustomerWindowStatus {
  return section.decideNotes.some((n) => noteKind(n) === "highlight")
    ? CUSTOMER_WINDOW_HIGHLIGHT
    : CUSTOMER_WINDOW_CHECKED;
}

/** The window's time range — the ONLY timing a customer sees. */
export function customerWindowRange(section: FrameSection): string {
  return sectionLabel(section);
}

/** Stable `data-*` value for a customer window status (a test/QA hook that is
 *  itself customer-safe copy). */
export function customerWindowStatusKey(status: CustomerWindowStatus): "highlight" | "checked" {
  return status === CUSTOMER_WINDOW_HIGHLIGHT ? "highlight" : "checked";
}
