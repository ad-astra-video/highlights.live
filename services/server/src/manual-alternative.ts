// ADAAAA-8407: the OPERATOR path for cross-camera replays.
//
// Inc 1/2 (ADAAAA-8321/8325) attach a replay window only when a deterministic
// signal certifies that the window repeats another window. Measured on the
// board's named case (job 545be947: the 207 s behind-the-net replay vs the
// 152 s side-on goal) every signal fails — different camera, a `live` phase
// verdict, and no score-bug regression to read. Per the approved plan's
// falsifier that lane stopped iterating; the honest route to the original ask
// is to let an operator who already watched the job SAY the window is the same
// moment.
//
// This module is the pure half of that path. It reuses the SAME stored contract
// as Inc 1 (`replayOf` + `replayEvidence`, projected by `replayAlternativeFrom`),
// writing ONLY the window record. So all the Inc 1 invariants hold unchanged:
//
//   * no second highlight row is inserted (the window already exists);
//   * no second clip is cut or debited (the window's `clipUri` is reused);
//   * the goal count / summary ladder is unchanged (the moment is never written
//     and a `replayOf` row is filtered from every highlight lane);
//   * no detector, threshold or decide-prompt change and no GPU work — an
//     attach is a pointer write.
//
// Guards this path adds on top (all unit-tested):
//   * a moment that is itself a replay can never OWN (no chains);
//   * a window that already owns alternatives can never itself be attached
//     (no chains in the other direction);
//   * only a same-job, decided, un-attached, un-rejected window with a cut clip
//     is offered or accepted.
import {
  HighlightRecordSchema,
  type HighlightRecord,
  type ReplayEvidence,
} from "@highlights/events";
import { replayAnchorTs } from "./replay-alternatives";

/** Why a manual attach was refused. The route maps each to an HTTP error; a
 * refusal never writes anything. */
export type ManualAttachRefusal =
  | "moment_is_replay"
  | "same_window"
  | "window_not_found"
  | "cross_job"
  | "window_already_attached"
  | "window_owns_alternatives"
  | "window_rejected"
  | "window_not_decided"
  | "window_has_no_clip";

/** One window the operator may attach to a moment. Shape is display-only: the
 * anchor is the content instant the alternative will be labelled with. */
export interface ManualAttachCandidate {
  id: string;
  start: number;
  end: number;
  anchorTs: number;
  /** The window's own lane/verdict class, for the operator listing. */
  eventType?: string;
  outcome?: string;
  score: number;
  clipUri: string;
}

/** True when the record's attach came from an operator rather than a detector
 * signal. Used by the picker copy, the detach guard and the read side. */
export function isManualAttach(
  record: Pick<HighlightRecord, "replayEvidence">
): boolean {
  return record.replayEvidence?.kind === "manual";
}

/** True when some record is attached to `id` — i.e. the row already OWNS an
 * alternative and may not itself become one (no chains). */
function ownsAlternatives(id: string, records: readonly HighlightRecord[]): boolean {
  return records.some((r) => r.replayOf === id);
}

/** A window is ELIGIBLE as a manual alternative when it is a decided row of the
 * SAME job that does not already participate in an attach (as an alternative or
 * as an owner) and still carries its own cut clip. Pure predicate, shared by the
 * candidate listing and the attach validation so the two can never disagree. */
export function isManualAttachEligible(
  moment: Pick<HighlightRecord, "id" | "jobId" | "replayOf">,
  window: HighlightRecord,
  records: readonly HighlightRecord[]
): boolean {
  if (window.id === moment.id) return false;
  if (window.jobId !== moment.jobId) return false;
  if (window.replayOf) return false;
  if (ownsAlternatives(window.id, records)) return false;
  if (window.status === "rejected") return false;
  if (window.outcome === "not_highlight") return false;
  if (!window.clipUri) return false;
  return true;
}

/** The job's other decided windows an operator may attach to `moment`,
 * anchor-ordered. Empty when the moment is itself a replay (it may not own).
 * `now`-free and deterministic: the same records always produce the same list. */
export function manualAttachCandidates(
  moment: HighlightRecord,
  records: readonly HighlightRecord[]
): ManualAttachCandidate[] {
  if (moment.replayOf) return [];
  return records
    .filter((r) => isManualAttachEligible(moment, r, records))
    .map((r) => ({
      id: r.id,
      start: r.start,
      end: r.end,
      anchorTs: replayAnchorTs(r),
      ...(r.eventType ? { eventType: r.eventType } : {}),
      ...(r.outcome ? { outcome: r.outcome } : {}),
      score: r.score,
      clipUri: r.clipUri,
    }))
    .sort((a, b) => a.anchorTs - b.anchorTs || a.id.localeCompare(b.id));
}

/** Validate a manual attach. Returns the refusal (nothing may be written) or
 * null when the write is legal. */
export function manualAttachRefusal(
  moment: HighlightRecord,
  windowId: string,
  records: readonly HighlightRecord[]
): ManualAttachRefusal | null {
  if (moment.replayOf) return "moment_is_replay";
  if (windowId === moment.id) return "same_window";
  const window = records.find((r) => r.id === windowId);
  if (!window) return "window_not_found";
  if (window.jobId !== moment.jobId) return "cross_job";
  if (window.replayOf) return "window_already_attached";
  if (ownsAlternatives(window.id, records)) return "window_owns_alternatives";
  if (window.status === "rejected") return "window_rejected";
  if (window.outcome === "not_highlight") return "window_not_decided";
  if (!window.clipUri) return "window_has_no_clip";
  return null;
}

/** The evidence a manual attach stores. `kind: "manual"` plus the acting
 * operator id and instant are the provenance AC3 asks for; `matches`/
 * `compared` stay 0 because NO fingerprint comparison ran (a manual attach is
 * not a detection), and `gapS` is the honest anchor gap. */
export function manualAttachEvidence(
  moment: HighlightRecord,
  window: HighlightRecord,
  actorId: string,
  now: string = new Date().toISOString()
): ReplayEvidence {
  const gapS = Math.round(Math.abs(replayAnchorTs(window) - replayAnchorTs(moment)) * 1000) / 1000;
  return {
    kind: "manual",
    matches: 0,
    compared: 0,
    gapS,
    attachedBy: actorId,
    attachedAt: now,
  };
}

/** The patch written to the WINDOW record only. The moment's own row (status,
 * score, outcome, window, clip) is never touched — attaching cannot change a
 * count, a verdict or a debit. */
export function manualAttachPatch(
  moment: HighlightRecord,
  window: HighlightRecord,
  actorId: string,
  now?: string
): { replayOf: string; replayEvidence: ReplayEvidence } {
  return {
    replayOf: moment.id,
    replayEvidence: manualAttachEvidence(moment, window, actorId, now),
  };
}

/** Detach is legal only for a manual attach: the operator path must never be
 * able to silently undo a detector attach (Inc 1/2 provenance stays intact). */
export function canManualDetach(record: Pick<HighlightRecord, "replayOf" | "replayEvidence">): boolean {
  return !!record.replayOf && isManualAttach(record);
}

/**
 * The row a detach writes: the record WITHOUT its attach fields, i.e. exactly
 * its pre-attach shape. Nothing else on the row is touched (its clip, window,
 * score and status are the ones it had before the attach).
 */
export function manualDetachRecord(record: HighlightRecord): HighlightRecord {
  const { replayOf: _replayOf, replayEvidence: _evidence, ...rest } = record;
  return HighlightRecordSchema.parse(rest);
}

/**
 * True when the moment was SERVING the detached window — the caller must clear
 * the moment's `clipChoice` so it falls back to its own original cut (the CEO's
 * `original_default` policy). The moment is otherwise never written.
 */
export function detachClearsServedClip(
  moment: Pick<HighlightRecord, "clipChoice">,
  windowId: string
): boolean {
  return moment.clipChoice?.alternativeId === windowId;
}
