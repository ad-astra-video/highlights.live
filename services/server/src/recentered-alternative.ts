// ADAAAA-8893 (D5, spec ADAAAA-8891 §4 D5): the Stage-2 dive's re-centered cut
// is an OPTION of the card it corrects, never a replacement of it.
//
// Before this module the dive's moment was applied by MOVING the clip:
// `noteDiveMomentForClip` -> `reanchorLiveClipOnDiveMoment` re-cut the row and
// patched `clipUri`. The cut wrote the SAME file name
// (`${jobId}-${round(start*10)}`), so the accept-anchored clip was overwritten
// on disk and replaced on the row — after a re-anchor there was ONE clip and it
// was the dive's. The board's instruction is the opposite:
//
//   "Always keep the first clip but provide a re-centered/adjusted clip as
//    another option if the deep dive provides one."
//
// So the option is its own `highlight_alternatives` row (`relation:
// "alternative_of"`, `eventType: "recentered"`), and the owner row's
// `clipUri` / `start` / `end` / sha are never touched. Receiving an option is
// also a CLAIM-NEUTRAL event: it changes no promotion, verdict, lane, score
// attestation or metric (the binding intent of ADAAAA-8879).
//
// Because it is an alternative row it rides the existing rails unchanged: the
// detail/delta payload groups it under its owner (`groupAlternativesByOwner`),
// the webapp renders it as another slide, and `POST /highlights/:id/clip-choice`
// already serves any stored alternative for post/download as a pointer swap.
import { createHash } from "node:crypto";
import {
  HIGHLIGHT_ALTERNATIVE_RELATION,
  MAX_RECENTERED_ALTERNATIVES_PER_HIGHLIGHT,
  RECENTERED_ALTERNATIVE_EVENT_TYPE,
  HighlightAlternativeSchema,
  type HighlightAlternative,
  type HighlightRecord,
} from "@highlights/events";

/** The moment is quantized onto this bucket (seconds) so two dives that name
 * the same instant in different float digits produce ONE dedupe key — and a
 * re-delivery of the same option is idempotent instead of a second row/file. */
export const RECENTERED_MOMENT_BUCKET_S = 0.5;

/** The dive moment snapped onto the dedupe bucket.
 *
 * FLOOR (with a 1 ns nudge), not `round`: a bucket edge measured in float
 * seconds lands on either side of the same `.5` by a few ulps (162.25/0.5 is
 * 324.49999999999994), so a round-based bucket turns one instant into two keys —
 * and then two option rows / two clip files for the same dive moment. Flooring a
 * nudged quotient makes every input within a bucket agree. */
export function recenteredMomentBucket(momentTs: number): number {
  return Math.floor(momentTs / RECENTERED_MOMENT_BUCKET_S + 1e-9) * RECENTERED_MOMENT_BUCKET_S;
}

/** The reserved option's identity: owner + `recentered` + moment bucket. Its own
 * namespace, so it can never collide with (or consume) a celebration/replay
 * key (`alt:<owner>:<anchor>`). */
export function recenteredDedupeKey(highlightId: string, momentTs: number): string {
  return `alt:${highlightId}:recentered:${recenteredMomentBucket(momentTs).toFixed(3)}`;
}

/** Row id derived from the dedupe key — a re-run produces the SAME id. */
export function recenteredAlternativeId(dedupeKey: string): string {
  const h = createHash("sha256").update(dedupeKey).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The re-centered slot is reserved: at most ONE per owning row, and it never
 * eats the celebration/replay cap. */
export function canAddRecenteredAlternative(
  alternatives: readonly Pick<HighlightAlternative, "highlightId" | "eventType">[],
  highlightId: string
): boolean {
  const taken = alternatives.filter(
    (a) => a.highlightId === highlightId && a.eventType === RECENTERED_ALTERNATIVE_EVENT_TYPE
  ).length;
  return taken < MAX_RECENTERED_ALTERNATIVES_PER_HIGHLIGHT;
}

/** The option's own cut window. The card's own window is unchanged (`start`/
 * `end`/`clipGoalOffsetSec`), so the option covers the SAME span as the owner
 * clip and only the instant inside it that is centered moves. */
export function recenteredClipWindow(row: Pick<HighlightRecord, "start" | "end">): {
  start: number;
  end: number;
} {
  return { start: row.start, end: row.end };
}

/** Build the `recentered` alternative row for one owner + dive moment.
 *
 * `clipUri` is the option's OWN file — a separate name on disk, never the
 * owner's. `clipError` is carried (and `clipUri` empty) when the cut failed, so
 * the delivery attempt is auditable without pretending a playable option
 * exists; the owner clip stays served either way. */
export function buildRecenteredAlternative(input: {
  jobId: string;
  ownerId?: string;
  /** The owning highlight row (its clip is kept). */
  owner: Pick<HighlightRecord, "id" | "outcome" | "end">;
  /** The dive's named instant (content clock). */
  momentTs: number;
  momentConfidence?: number;
  /** The accept anchor the owner clip rests on (content clock), nullable when
   * the row carries neither `localizedTs` nor a trigger timestamp. */
  acceptAnchorTs: number | null;
  clipUri: string;
  clipWindow: { start: number; end: number };
  clipBytes?: number;
  clipError?: string;
  createdAt?: string;
}): HighlightAlternative {
  const dedupeKey = recenteredDedupeKey(input.owner.id, input.momentTs);
  const accept = input.acceptAnchorTs;
  const conf = input.momentConfidence;
  return HighlightAlternativeSchema.parse({
    id: recenteredAlternativeId(dedupeKey),
    ownerId: input.ownerId,
    jobId: input.jobId,
    highlightId: input.owner.id,
    relation: HIGHLIGHT_ALTERNATIVE_RELATION,
    eventType: RECENTERED_ALTERNATIVE_EVENT_TYPE,
    // The option is the same moment's footage, so it inherits the owner's own
    // outcome (a confirmed goal stays a scoring_play option; nothing is claimed
    // ABOUT the option beyond "another cut of this moment").
    outcome: input.owner.outcome,
    windowAnchorTs: input.momentTs,
    // Audit ordering only (never used to cap or to select): how far the dive's
    // instant sits from the owner clip's end.
    distanceToGoalEndS: Math.abs(input.momentTs - input.owner.end),
    // The `score` field is the alternative lane's 0-100 confidence slot. For a
    // re-centered option the only confidence that exists is the dive's (0-1).
    score: Math.min(100, Math.max(0, Math.round((Number.isFinite(conf as number) ? (conf as number) : 0) * 100))),
    start: input.clipWindow.start,
    end: input.clipWindow.end,
    clipUri: input.clipUri,
    ...(input.clipError ? { clipError: input.clipError } : {}),
    ...(Number.isFinite(input.clipBytes as number) ? { clipBytes: input.clipBytes } : {}),
    dedupeKey,
    ...(Number.isFinite(conf as number) ? { momentConfidence: clamps01(conf as number) } : {}),
    ...(accept != null && Number.isFinite(accept) ? { acceptAnchorTs: accept } : {}),
    ...(accept != null && Number.isFinite(accept) ? { driftSec: input.momentTs - accept } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

function clamps01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** The content instant a row was accepted on (`localizedTs`, else its trigger) —
 * the anchor the card's clip rests on, and what the option's drift is measured
 * against. Mirrors `acceptAnchorTs` in api.ts (one definition, no drift). */
export function acceptAnchorOf(
  row: Pick<HighlightRecord, "localizedTs"> & { trigger?: { timestamp?: number } }
): number | null {
  if (Number.isFinite(row.localizedTs as number)) return Number(row.localizedTs);
  const trig = Number(row.trigger?.timestamp);
  return Number.isFinite(trig) ? trig : null;
}

/** The narrow store seam option delivery reads/writes. Deliberately has NO
 * `patchHighlight`: the card's clip is structurally unwritable from this path. */
export interface RecenteredDeliveryDeps {
  getHighlight(id: string): HighlightRecord | undefined;
  alternativesForHighlight(id: string): readonly Pick<HighlightAlternative, "id" | "highlightId" | "eventType">[];
  addAlternative(a: HighlightAlternative): Promise<{ record: HighlightAlternative; created: boolean }>;
  log?: (message: string) => void;
}

/**
 * ADAAAA-8893 (D5): deliver the dive's re-centered cut as an OPTION of one card.
 *
 * This is THE shared option path — the browser rail's re-cut, the ingest rail's
 * re-cut, and both deferred cut sites call it, so live and VOD cannot diverge.
 * The cut is supplied by the caller (it owns the footage); everything else is
 * claim-neutral by construction:
 *
 *  - the owner row is never written (no patch seam exists here): its clip, its
 *    window, its lane, verdict and score attestation are all untouched;
 *  - the option is a `highlight_alternatives` row with `eventType:
 *    "recentered"`, `windowAnchorTs` = the dive moment, and the dive provenance;
 *  - the slot is reserved (one per row) and is NOT the celebration/replay cap;
 *  - a failed cut stores no playable option (empty `clipUri` is never claimed).
 */
export async function deliverRecenteredOption(input: {
  deps: RecenteredDeliveryDeps;
  jobId: string;
  highlightId: string;
  dive: { ts: number; confidence?: number };
  /** Cut the option's OWN file from the rail that owns the footage. */
  cut: () => Promise<{ clipUri: string; start: number; end: number; bytes?: number; clipError?: string }>;
}): Promise<HighlightAlternative | null> {
  const { deps, jobId, highlightId, dive } = input;
  const log = deps.log ?? (() => {});
  const row = deps.getHighlight(highlightId);
  if (!row) return null;
  if (!canAddRecenteredAlternative(deps.alternativesForHighlight(highlightId), highlightId)) {
    log(`[live-dive-option:${jobId}] ${highlightId} re-centered option already delivered (reserved slot taken) — no second cut`);
    return null;
  }
  const out = await input.cut();
  if (!out.clipUri) {
    log(
      `[live-dive-option:${jobId}] ${highlightId} re-centered option cut produced no file ` +
        `(${out.clipError ?? "no reason"}) — the accept-anchor clip stays the card's clip`
    );
    return null;
  }
  const acceptTs = acceptAnchorOf(row);
  const alt = buildRecenteredAlternative({
    jobId,
    ownerId: row.ownerId,
    owner: row,
    momentTs: dive.ts,
    momentConfidence: dive.confidence,
    acceptAnchorTs: acceptTs,
    clipUri: out.clipUri,
    clipWindow: { start: out.start, end: out.end },
    clipBytes: out.bytes,
    clipError: out.clipError,
  });
  const { record, created } = await deps.addAlternative(alt);
  if (!created) return null;
  const drift = acceptTs == null ? "?" : (dive.ts - acceptTs).toFixed(3);
  log(
    `[live-dive-option:${jobId}] ${highlightId} kept its accept-anchor clip ${row.clipUri} ` +
      `(sha unchanged); added re-centered option ${record.id} at ${dive.ts.toFixed(3)}s ` +
      `(drift ${drift}s, ${out.bytes == null ? "?" : out.bytes} B, window [${out.start.toFixed(3)}, ${out.end.toFixed(3)}])`
  );
  return record;
}
