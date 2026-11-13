// ADAAAA-8321 (Inc 1) AC6: an operator picks which delivered clip a moment
// SERVES (its own original cut, the replay of it, or a celebration window).
//
// The pick is a POINTER swap, not a re-cut: every alternative already has its
// own cut clip (`clipUri`), so choosing one just records which clipUri the
// moment serves. `start`/`end` on the record are untouched — the moment keeps
// its own window, so the summary ladder, the quota math and every count stay
// exactly what they were. Clearing the choice restores the original.
import type { ClipChoice, HighlightAlternative, HighlightRecord } from "@highlights/events";

/** The served clip path for a record: the chosen alternative's clip, or the
 * record's own clip when nothing is chosen (the default). */
export function servedClipUri(
  record: Pick<HighlightRecord, "clipUri" | "clipChoice">
): string {
  return record.clipChoice?.clipUri || record.clipUri;
}

/** The served clip's own window (display only; the moment's window is
 * authoritative for counts). Falls back to the record's window. */
export function servedClipWindow(
  record: Pick<HighlightRecord, "start" | "end" | "clipChoice">
): { start: number; end: number } {
  const c = record.clipChoice;
  return c ? { start: c.start, end: c.end } : { start: record.start, end: record.end };
}

/** True when the record is serving something other than its own original cut. */
export function servesAlternative(record: Pick<HighlightRecord, "clipChoice">): boolean {
  return !!record.clipChoice?.alternativeId;
}

/**
 * Build the persisted choice for `alternativeId`, validating that the
 * alternative really belongs to `highlightId`. Returns null when it does not
 * (the caller answers 422): a moment can never serve another moment's footage.
 */
export function clipChoiceFor(
  highlightId: string,
  alternativeId: string,
  alternatives: readonly Pick<HighlightAlternative, "id" | "highlightId" | "clipUri" | "start" | "end">[],
  now: string = new Date().toISOString()
): ClipChoice | null {
  const alt = alternatives.find((a) => a.id === alternativeId && a.highlightId === highlightId);
  if (!alt || !alt.clipUri) return null;
  return {
    alternativeId: alt.id,
    clipUri: alt.clipUri,
    start: alt.start,
    end: alt.end,
    chosenAt: now,
  };
}

/** The label a picker renders for an alternative: "Replay @ 207 s" /
 * "Celebration @ 165 s" / "Re-centered @ 47 s". Customer-safe — never the event
 * taxonomy or verdict.
 *
 * ADAAAA-8893 (D5): the third role is the dive's re-centered option. It reads
 * `Re-centered @ <t> s` (the dive moment), NOT "Celebration" — the customer must
 * be able to tell "the same moment, cut differently" from "the aftermath". */
export function alternativePickerLabel(alt: Pick<HighlightAlternative, "eventType" | "windowAnchorTs">): string {
  const role =
    alt.eventType === "replay" ? "Replay" : alt.eventType === "recentered" ? "Re-centered" : "Celebration";
  return `${role} @ ${Math.round(alt.windowAnchorTs)} s`;
}
