// ADAAAA-7621: the precision gate + overlap dedupe for the POSTABLE highlight
// list.
//
// Review of VOD job d61e52f6 (ADAAAA-7620) found the postable list was not
// trustworthy even though every record said `outcome: "scoring_play"`:
//
// - 2 accepted clips carried their own verdict text saying the ball "does not
//   enter the net" (a Stage-1 `near_miss` that the Stage-2 confirm pass
//   "rescued" from a scoreboard delta).
// - 1 clip was `status: "rejected"` yet still returned in the highlights array.
// - 6 overlapping clip windows meant 24 clips covered only 18 unique moments.
//
// This module owns the read-side gate: given the persisted HighlightRecords for
// a job it returns the list that may actually be posted to the board. It is
// pure and additive — the persisted rows are never mutated, and the full audit
// trail (every decide evaluation) still lives in `sections[].decideNotes`.
//
// Rules, in order:
//   1. `status: "rejected"` is never postable (a human said no).
//   2. Only `outcome: "scoring_play"` is postable. `near_miss` / `big_play` are
//      "notable, not a goal" and ride a separate lane; `not_highlight` and a
//      legacy verdict with no outcome are not postable.
//   3. A verdict that contradicts itself is not postable, whatever its
//      `eventType` says: a structured Stage-2 `near_miss` / `not_goal`, or a
//      reason whose own text refutes the goal ("...does not enter the net").
//   4. Overlapping clip windows collapse into ONE moment: the best-scoring (then
//      best-corroborated) clip wins, the rest are marked `duplicateOf` the
//      winner and reported with the winner's `duplicateCount` / `mergedIds`.
//   5. ADAAAA-8199: a GOAL-SHAPED celebration (a `big_play` row the live gate
//      demoted from the GOAL lane, or a row carrying the ADAAAA-8139 provisional
//      marker) whose window overlaps a postable `scoring_play` moment is absorbed
//      into that moment instead of shipping as a second card. The overlap is the
//      same moment, so the confirmed GOAL owns it; the celebration moves to the
//      duplicate lane with `duplicateOf`. A true non-goal notable (near miss, a
//      score-steady big play, the clip-loop tail reads) keeps its own row: only
//      the narrow, goal-bounded class above is absorbable.
import {
  MAX_NOTABLE_ALTERNATIVES_PER_HIGHLIGHT,
  NOTABLE_MOMENT_GAP_S,
  type HighlightRecord,
} from "@highlights/events";

/**
 * Reason phrases that refute a goal. The persisted `reason` on an accepted
 * highlight is a concatenation of the Stage-1 read, the decide-side verdict
 * suffix and the Stage-2 confirm text, so a refutation anywhere in it means the
 * record's own evidence disagrees with the accept.
 *
 * Kept deliberately narrow: every pattern below was checked against the 21
 * postable windows of job d61e52f6 (2026-10-31) and matches only the 2
 * self-contradicting ones. Do not add a phrase that can appear in a genuine
 * accept ("no scoreboard change" is legitimate when the confirm pass accepted
 * on frame attestation — never add it here).
 */
const GOAL_REFUTING_PATTERNS: RegExp[] = [
  // The decide service appends this suffix when its own gate downgraded the
  // window (e.g. "outcome=near_miss is not a scoring highlight").
  /outcome=(near_miss|big_play|not_highlight)\s+is\s+not\s+a\s+scoring\s+highlight/i,
  /\bnot\s+a\s+scoring\s+highlight\b/i,
  /\bnot\s+a\s+goal\b/i,
  /\bno\s+goal\s+(?:was\s+)?(?:scored|here)\b/i,
  // "the ball ... does not enter the net" / "didn't cross into the goal".
  /\b(?:does\s+not|doesn't|did\s+not|didn't|never)\s+(?:enter|cross(?:\s+into)?|go\s+into)\s+the\s+(?:net|goal)\b/i,
  /\bfails?\s+to\s+(?:enter|cross)\s+the\s+(?:net|goal)\b/i,
];

/** True when a persisted verdict `reason` argues the goal did NOT happen. */
export function isGoalRefutingReason(reason?: string): boolean {
  if (!reason) return false;
  return GOAL_REFUTING_PATTERNS.some((re) => re.test(reason));
}

/** True when the record's own verdict contradicts an accepted goal: a
 * structured Stage-2 verdict of near_miss/not_goal, or refuting reason text. */
export function hasContradictingVerdict(h: Pick<HighlightRecord, "reason" | "goalConfirmed">): boolean {
  if (h.goalConfirmed === "near_miss" || h.goalConfirmed === "not_goal") return true;
  return isGoalRefutingReason(h.reason);
}

/** A postable moment. `duplicateCount` / `mergedIds` / `duplicateOf` are set on
 * records that absorbed (or were absorbed by) an overlapping clip. */
export type PostableHighlight = HighlightRecord & {
  /** Number of overlapping clips merged INTO this moment (absent when 0). */
  duplicateCount?: number;
  /** Ids of the overlapping clips merged into this moment. */
  mergedIds?: string[];
  /** Set on a merged-away duplicate: the id of the moment that owns the footage. */
  duplicateOf?: string;
};

export interface PostableHighlights {
  /** The postable, deduped list. No two windows overlap. */
  highlights: PostableHighlight[];
  /** "Notable, not a goal" lane: non-rejected near_miss / big_play clips, kept
   * out of the postable list by rule 2. Never a GOAL label. */
  notable: HighlightRecord[];
  /** ADAAAA-8422 (N1), ADAAAA-8443 (N1b): the SAME notable rows, grouped into
   * proximity moments by anchor gap — one card per moment with its siblings as
   * clip options. Presentation only: the membership is exactly `notable`, so no
   * count depends on it. */
  notableMoments: NotableMoments;
  /** Merged-away duplicates, each carrying `duplicateOf`. Excluded from
   * `highlights` so the postable list has zero overlapping windows. */
  duplicates: PostableHighlight[];
  /** Counts for the operator summary: how many persisted rows came in and how
   * many were dropped by each rule (rejected / not scoring / contradicting). */
  counts: {
    total: number;
    rejected: number;
    notScoring: number;
    contradicting: number;
    postable: number;
    merged: number;
    /** ADAAAA-8549: attached replay rows, in their own bucket (see
     * `PostableHighlightCounts.replayHighlights`). */
    replay: number;
  };
  /** ADAAAA-8542 (AC3): where EVERY persisted row lands on the page, so a
   * delivered row can never be silently absent. See {@link RowAccounting}. */
  rowAccounting: RowAccounting;
}

// ---------------------------------------------------------------------------
// ADAAAA-8542 (AC3): row accounting — a delivered row must never be silently
// absent from the page
// ---------------------------------------------------------------------------
//
// The gate (ADAAAA-8508) found row `eccc4e25` "in neither highlights nor
// notableHighlights" on job 50b7aed6. A notable moment is ONE card whose other
// windows ride `siblingClips[]` (ADAAAA-8443), so "in notableHighlights" is a
// membership test over owners AND their options — a grader that only reads the
// top-level ids will call a served row lost (the ADAAAA-8447 counting lesson).
//
// Rather than leave that to each reader, the projection now states it: every
// persisted row is either reachable from the served payload (`served`, with the
// surface that serves it) or named with the reason it has no page representation
// (`unrepresented`). "Not stated" is no longer a possible state — which is what
// makes the re-cert's "no delivered row missing from the page" gradable without
// reconstructing the grouping.

/** Why a persisted row is reachable from the page — or why it is not. */
export type RowRepresentation =
  /** Owner of a postable moment (`highlights[]`). */
  | "card"
  /** Owner of a notable moment (`notableHighlights[]`). */
  | "notable_card"
  /** A notable moment's other window (`notableHighlights[].siblingClips[]`). */
  | "sibling_clip"
  /** A replay delivered under its owner's `alternatives[]` (ADAAAA-8321). */
  | "replay_alternative"
  /** Merged into another moment's footage (`duplicateHighlights[]`): deduped by
   *  design, so it has no card of its own — disclosed, never a silent gap. */
  | "merged_duplicate"
  /** Same notable moment, but beyond the rail cap (`MAX_NOTABLE_ALTERNATIVES_PER_HIGHLIGHT`). */
  | "notable_option_over_rail_cap"
  /** Rule 1: a human rejected it. */
  | "rejected"
  /** Rule 2: accepted, but its outcome is not a near_miss / big_play card. */
  | "not_scoring"
  /** Rule 3: the record's own verdict contradicts the accept. */
  | "contradicting"
  /** A replay whose owner row is not present in the list (fail-closed). */
  | "replay_owner_missing"
  /** Fail-closed: no lane and no known drop rule explains this row. Never
   * produced by a shipped projection (ADAAAA-8549). */
  | "unaccounted";

export interface RowAccounting {
  /** Every persisted row served as a card (or as a served replay), and how. */
  served: { id: string; representation: RowRepresentation }[];
  /** Every persisted row with NO page representation, with the reason. */
  unrepresented: { id: string; reason: RowRepresentation }[];
}

/** Why a row that is in no bucket has no page representation. Fail-closed: a row
 * that matches no known rule answers `unaccounted`, never a plausible-looking
 * default. `unaccounted` must never be produced by a shipped projection — its
 * presence means a new drop path escaped the gate (ADAAAA-8549). */
function unrepresentedReason(row: HighlightRecord): RowRepresentation {
  if (row.status === "rejected") return "rejected";
  if (row.outcome !== "scoring_play") {
    // A near_miss / big_play that reached no moment was capped off the rail; any
    // other outcome was never a card in the first place.
    return row.outcome === "near_miss" || row.outcome === "big_play"
      ? "notable_option_over_rail_cap"
      : "not_scoring";
  }
  // A non-postable scoring_play row is only `contradicting` when its own verdict
  // refutes the goal. Anything else reached NO lane and matched NO rule — say so
  // instead of asserting a cause.
  return hasContradictingVerdict(row) ? "contradicting" : "unaccounted";
}

/**
 * ADAAAA-8542 (AC3): account for every persisted row against the served
 * projection. Pure: the inputs are not read beyond their ids.
 *
 * Reachable means "the detail payload leads to this row AS A CARD": a postable
 * moment's own clip, a notable moment's own clip, a notable moment's
 * `siblingClips[]` option, or a replay alternative whose owner is served. A row
 * merged into another moment's footage (and every gate drop) is DELIVERED but
 * has no card of its own, so it is disclosed in `unrepresented` with its reason.
 */
export function accountHighlightRows(
  list: HighlightRecord[],
  out: Pick<PostableHighlights, "highlights" | "duplicates" | "notableMoments">
): RowAccounting {
  const reachable = new Map<string, RowRepresentation>();
  for (const h of out.highlights) if (!reachable.has(h.id)) reachable.set(h.id, "card");
  for (const m of out.notableMoments.moments) {
    if (!reachable.has(m.owner.id)) reachable.set(m.owner.id, "notable_card");
    for (const option of m.options) if (!reachable.has(option.id)) reachable.set(option.id, "sibling_clip");
  }

  const accounting: RowAccounting = { served: [], unrepresented: [] };
  for (const row of list) {
    if (row.replayOf) {
      // A replay is served as its owner's alternative. An owner that is not
      // present is a real gap, not a card — named rather than assumed served.
      if (reachable.has(row.replayOf)) accounting.served.push({ id: row.id, representation: "replay_alternative" });
      else accounting.unrepresented.push({ id: row.id, reason: "replay_owner_missing" });
      continue;
    }
    const representation = reachable.get(row.id);
    if (representation) {
      accounting.served.push({ id: row.id, representation });
      continue;
    }
    // A row merged into another moment's footage is DELIVERED but has no card of
    // its own (that is the dedupe); it is disclosed with its reason, not served.
    const merged = out.duplicates.some((d) => d.id === row.id) || out.highlights.some((m) => (m.mergedIds ?? []).includes(row.id));
    accounting.unrepresented.push({ id: row.id, reason: merged ? "merged_duplicate" : unrepresentedReason(row) });
  }
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  accounting.served.sort(byId);
  accounting.unrepresented.sort(byId);
  return accounting;
}

/** Rule 1-3: may this single persisted record be posted? */
export function isPostableHighlight(h: HighlightRecord): boolean {
  if (h.status === "rejected") return false;
  if (h.outcome !== "scoring_play") return false;
  if (hasContradictingVerdict(h)) return false;
  return true;
}

/** True when two clip windows share footage. Touching windows (a.end ===
 * b.start) do not overlap — they are adjacent moments, not duplicates. */
export function windowsOverlap(
  a: Pick<HighlightRecord, "start" | "end">,
  b: Pick<HighlightRecord, "start" | "end">
): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Best corroboration wins, then the higher score, then the earlier window. A
 * frame-attested or scoreboard/file-corroborated goal outranks an
 * uncorroborated one at the same score. */
function qualityRank(h: HighlightRecord): number {
  const corroboration = h.corroborated === true ? 2 : 0;
  return corroboration + (h.score ?? 0);
}

function betterMoment(a: PostableHighlight, b: PostableHighlight): PostableHighlight {
  const ra = qualityRank(a);
  const rb = qualityRank(b);
  if (ra !== rb) return ra > rb ? a : b;
  if ((a.score ?? 0) !== (b.score ?? 0)) return (a.score ?? 0) > (b.score ?? 0) ? a : b;
  return a.start <= b.start ? a : b;
}

/**
 * Turn a job's persisted highlights into the postable list: precision gate
 * (rejected / non-scoring / self-contradicting dropped) then overlap dedupe.
 *
 * Deterministic and pure: input records are not mutated (merged moments are
 * fresh objects), so the caller can hand it the live store array.
 */
export function buildPostableHighlights(list: HighlightRecord[]): PostableHighlights {
  // ADAAAA-8321: a replay window is footage of a moment this job already has.
  // It is delivered under that moment's `alternatives` (never its own card, never
  // the notable lane) and must not touch any count — including the merged /
  // quota arithmetic. Drop it before any bucket sees it, so the count identity
  // `raw - postable = merged + rejected + notScoring + contradicting` still
  // holds against the RAW row total.
  const visible = list.filter((h) => !h.replayOf);
  const counts = {
    total: list.length,
    rejected: 0,
    notScoring: 0,
    contradicting: 0,
    postable: 0,
    merged: 0,
    // ADAAAA-8549: replay rows are dropped before every bucket, so without their
    // own bucket they vanish between `total` and the rest and the row identity
    // `total - postable = merged + rejected + notScoring + contradicting` is short
    // by exactly the replay count. Count them explicitly instead.
    replay: list.length - visible.length,
  };
  const candidates: HighlightRecord[] = [];
  const notable: HighlightRecord[] = [];
  for (const h of visible) {
    if (h.status === "rejected") {
      counts.rejected += 1;
      continue;
    }
    if (h.outcome !== "scoring_play") {
      counts.notScoring += 1;
      // "Notable, not a goal": a near miss / big play a human may still want to
      // see, but it must never be postable as a GOAL.
      if (h.outcome === "near_miss" || h.outcome === "big_play") notable.push(h);
      continue;
    }
    if (hasContradictingVerdict(h)) {
      counts.contradicting += 1;
      continue;
    }
    candidates.push(h);
  }

  const collapsed = collapseOverlappingWindows(candidates);
  counts.merged = collapsed.merged;
  // ADAAAA-8199: absorb the goal-shaped celebration lane into the confirmed GOAL
  // it overlaps, so one transition never ships as a GOAL card PLUS a celebration
  // card. The rows are NOT mutated or deleted (the persisted audit trail keeps
  // both); the read-side projection is what the board and the counts show.
  const absorbed = absorbGoalCelebrations(collapsed.moments, notable);
  counts.merged += absorbed.absorbed;
  // ADAAAA-8155: a demoted row that survives the overlap absorb can still be the
  // SAME transition as an accepted GOAL when its judged instant sits inside that
  // GOAL's clip window — the clip was localized away from the judged instant, so
  // the windows no longer overlap and the absorb rule cannot see it. Clear the
  // marker there too, or the board prints "GOAL (unconfirmed)" beside the
  // accepted card for one goal. Marker only: the fail-closed invariant stands.
  const notableRows = suppressCoveredProvisionalMarkers(collapsed.moments, absorbed.notable);
  // The absorbed rows leave the "not scoring" drop bucket and join the merged
  // one, so the count identity `raw - postable = merged + rejected + notScoring +
  // contradicting` still holds (nothing is counted twice or lost).
  counts.notScoring = Math.max(0, counts.notScoring - absorbed.absorbed);
  const duplicates = [...collapsed.duplicates, ...absorbed.duplicates].sort((a, b) => a.start - b.start);
  counts.postable = collapsed.moments.length;
  // ADAAAA-8422 (N1): the surviving notable rows grouped into moments. Pure
  // presentation over the SAME rows — counts above are already final and never
  // read this projection.
  const notableMoments = clusterNotableWindows(notableRows);
  // ADAAAA-8542 (AC3): account every persisted row against exactly this served
  // projection — one pass, so the accounting can never disagree with the page.
  const rowAccounting = accountHighlightRows(list, { highlights: collapsed.moments, duplicates, notableMoments });
  return { highlights: collapsed.moments, notable: notableRows, notableMoments, duplicates, counts, rowAccounting };
}

/**
 * ADAAAA-8199: is this notable row a GOAL-SHAPED celebration — i.e. a row the
 * live gate took OUT of the scoring lane for lack of a measured attestation, as
 * opposed to a genuine non-goal big play?
 *
 * Deliberately narrow (AC3 precision): only `big_play` records are candidates,
 * and only when the ADAAAA-8139 provisional marker says a goal cue was present
 * (the measured leg's three celebration rows all carry it) or the record's own
 * event type is a goal label. A `near_miss`, a score-steady `big_play` or a
 * clip-loop tail read never qualifies, so a true notable keeps its own row.
 */
export function isGoalShapedCelebration(h: HighlightRecord): boolean {
  if (h.outcome !== "big_play") return false;
  if (h.provisionalGoal) return true;
  return /^(GOAL|GOL)$/i.test(h.eventType ?? "");
}

/** The result of absorbing goal-shaped celebrations into confirmed moments. */
interface AbsorbedCelebrations {
  /** The notable lane with the absorbed rows removed. */
  notable: HighlightRecord[];
  /** The absorbed rows, each carrying `duplicateOf` its owning GOAL. */
  duplicates: PostableHighlight[];
  /** How many rows were absorbed. */
  absorbed: number;
}

/**
 * ADAAAA-8199: move every goal-shaped celebration that overlaps a postable
 * `scoring_play` moment into that moment's duplicate lane.
 *
 * Overlap is the same-moment test the postable list already uses: a celebration
 * window that shares footage with a confirmed GOAL is that goal's row, so the
 * GOAL owns the moment and the celebration is reported as `duplicateOf` it. Two
 * confirmed moments can never overlap (they were collapsed first), so a
 * celebration has at most ONE owner. A celebration that overlaps nothing stays
 * in the notable lane untouched.
 */
function absorbGoalCelebrations(
  moments: PostableHighlight[],
  notable: HighlightRecord[]
): AbsorbedCelebrations {
  const kept: HighlightRecord[] = [];
  const duplicates: PostableHighlight[] = [];
  let absorbed = 0;
  for (const h of notable) {
    if (!isGoalShapedCelebration(h)) {
      kept.push(h);
      continue;
    }
    const owner = moments.find((m) => m.outcome === "scoring_play" && windowsOverlap(m, h));
    if (!owner) {
      kept.push(h);
      continue;
    }
    owner.duplicateCount = (owner.duplicateCount ?? 0) + 1;
    owner.mergedIds = [...(owner.mergedIds ?? []), h.id];
    // ADAAAA-8199 AC6: the transition this celebration belonged to now HAS a
    // confirmed GOAL, so its provisional marker is resolved — the duplicate copy
    // must not keep "GOAL (unconfirmed)" on the merged lane (the surviving GOAL
    // card is the only row that speaks for the transition). The STORED row keeps
    // its marker: the persisted audit trail is not mutated here.
    duplicates.push({ ...h, provisionalGoal: undefined, duplicateOf: owner.id });
    absorbed += 1;
  }
  return { notable: kept, duplicates, absorbed };
}

/**
 * ADAAAA-8155: is the demoted row the SAME transition as an accepted GOAL?
 *
 * The overlap absorb above catches every demoted row whose clip window shares
 * footage with the confirmed GOAL. This catches the case that rule cannot see:
 * the demoted row's clip was LOCALIZED away from the instant the window was
 * judged at, so its window no longer overlaps the accepted clip even though the
 * GOAL's clip window still contains that judged instant (`declaredTs`) — the
 * measured QA shape on job b5de5a9a. Coverage is strict containment with no
 * tolerance: a row whose judged instant merely sits NEAR the accepted clip stays
 * provisional, because the marker is a fail-closed claim about one transition.
 */
export function isCoveredByAcceptedGoal(
  h: Pick<HighlightRecord, "provisionalGoal" | "start" | "end">,
  moments: Pick<HighlightRecord, "outcome" | "start" | "end">[]
): boolean {
  const ts = h.provisionalGoal?.declaredTs;
  if (ts === undefined) return false;
  return moments.some((m) => m.outcome === "scoring_play" && ts >= m.start && ts <= m.end);
}

/**
 * ADAAAA-8155: clear the provisional marker on every notable row whose judged
 * instant an accepted postable GOAL covers, so one goal never renders as a
 * postable GOAL card PLUS a "GOAL (unconfirmed)" notable row.
 *
 * Marker-only projection: `outcome` / `eventType` are untouched, the row stays
 * in the notable lane and never enters the postable list (a provisional row
 * still needs its own measured re-attestation to become a GOAL), and the
 * persisted record keeps its marker. Returns the SAME array when nothing was
 * covered, so callers can rely on referential identity for the no-op case.
 */
export function suppressCoveredProvisionalMarkers(
  moments: PostableHighlight[],
  notable: HighlightRecord[]
): HighlightRecord[] {
  if (!notable.some((h) => h.provisionalGoal)) return notable;
  let cleared = 0;
  const out = notable.map((h) => {
    if (!isCoveredByAcceptedGoal(h, moments)) return h;
    cleared += 1;
    return { ...h, provisionalGoal: undefined };
  });
  return cleared ? out : notable;
}

/** The result of collapsing overlapping clip windows into moments. */
export interface CollapsedMoments {
  /** One entry per distinct moment, time-ordered. */
  moments: PostableHighlight[];
  /** Merged-away duplicates, each carrying `duplicateOf`. */
  duplicates: PostableHighlight[];
  /** How many rows were absorbed into another row's moment. */
  merged: number;
}

// ---------------------------------------------------------------------------
// ADAAAA-8422 (N1) + ADAAAA-8443 (N1b): ONE notable card per MOMENT
// ---------------------------------------------------------------------------
//
// The notable lane used to ship one card per window, because only postable
// candidates were clustered (`collapseOverlappingWindows` above) and clip
// options were only ever minted for an ACCEPTED scoring GOAL
// (`celebration-alternatives.ts`). Measured shape: live job
// b55c5781-7976-4777-905c-847a06f3d3a8 carried 5 non-scoring windows that read
// as 5 cards where the board expects 2 moments with 2 and 3 clip options.
//
// N1 grouped them with the postable lane's strict-overlap chain and QA measured
// that WRONG on the same job: those five windows overlap only inside the second
// group (685.135-700.135 vs 697.930-712.930); the 725.182 window starts 12.252 s
// after that chain ends, and the first two windows (255.400 / 306.388) are
// 35.988 s apart and never overlap. Strict overlap yields 4 moments; the board's
// reading is 2. A notable moment is PROXIMITY: each candidate is a 15 s window
// cut around the same play, so the anchor gap (`NOTABLE_MOMENT_GAP_S`) is what
// groups them.
//
// This projection clusters the SURVIVING notable rows (after the precision gate
// AND the ADAAAA-8199 goal-shaped absorb) by anchor gap, so one card owns one
// moment and its sibling rows become that card's options. It deliberately does
// NOT touch `overlapChainClusters` / `collapseOverlappingWindows`: the postable
// lane's dedupe and the quota basis stay strict-overlap.
//
// Every option is another stored row's own already-cut `clipUri`: nothing is
// re-encoded, no decide runs, no row is mutated, and no count moves (the rows
// are the same rows — only the presentation changes).

/** One notable moment: the row that owns the card plus the sibling rows of the
 * same moment offered as clip options. */
export interface NotableMomentCluster {
  /** The row that owns the card (best footage, then best quality/score/earliest). */
  owner: HighlightRecord;
  /** Sibling rows of the same moment, time-ordered, capped at the notable rail
   * contract (`MAX_NOTABLE_ALTERNATIVES_PER_HIGHLIGHT` options). Each is its own
   * stored row with its own already-cut clip. */
  options: HighlightRecord[];
  /** Rows in the cluster: 1 + options + (optionsSuppressed for this moment). */
  memberCount: number;
  /** Sibling rows beyond the rail cap. Never silently dropped: counted here so a
   * job whose cluster is larger than the rail can be told apart from one that
   * lost footage. */
  optionsSuppressed: number;
}

export interface NotableMoments {
  /** One entry per distinct notable moment, time-ordered. */
  moments: NotableMomentCluster[];
  /** Option rows beyond the rail cap across all moments. */
  optionsSuppressed: number;
}

/** How much footage a row can show: 2 = an already-cut clip, 1 = a named clip
 * failure (the card still renders its reason), 0 = no footage at all. Ordering
 * the card owner on this first keeps a moment whose best-quality row never got a
 * cut from hiding a sibling that DID get one. */
function footageTier(h: HighlightRecord): number {
  if (h.clipUri) return 2;
  if (h.clipError) return 1;
  return 0;
}

/**
 * ADAAAA-8443 (N1b): group notable rows into moments by ANCHOR GAP. Pure and
 * deterministic: no row is mutated, and the returned lists hold the caller's own
 * records.
 *
 * A row joins the open moment when its start is within `gap` of that moment's
 * RUNNING MAX END (`start - maxEnd < gap`, so a real overlap — a negative
 * distance — always joins). Otherwise it opens a new moment. Rows are taken in
 * start order, so membership is order-independent.
 */
export function anchorGapClusters<T extends Pick<HighlightRecord, "start" | "end">>(
  rows: T[],
  gap: number = NOTABLE_MOMENT_GAP_S
): T[][] {
  const ordered = [...rows].sort((a, b) => a.start - b.start);
  const clusters: T[][] = [];
  let open: T[] = [];
  let maxEnd = Number.NEGATIVE_INFINITY;
  for (const h of ordered) {
    if (open.length > 0 && h.start - maxEnd < gap) {
      open.push(h);
      maxEnd = Math.max(maxEnd, h.end);
      continue;
    }
    if (open.length > 0) clusters.push(open);
    open = [h];
    maxEnd = h.end;
  }
  if (open.length > 0) clusters.push(open);
  return clusters;
}

/**
 * ADAAAA-8422 (N1) / ADAAAA-8443 (N1b): cluster notable rows into moments. Pure
 * and deterministic: no row is mutated, and the returned lists hold the caller's
 * own records.
 *
 * Owner = the row whose footage the card shows: a row with a clip first, then
 * the existing quality ranking (corroborated + score, then score, then the
 * earlier window). Options = the remaining rows of the cluster in time order,
 * capped at {@link MAX_NOTABLE_ALTERNATIVES_PER_HIGHLIGHT} (the notable rail
 * contract: 1 + up to 3 options). A single-window cluster renders no rail.
 */
export function clusterNotableWindows(
  rows: HighlightRecord[],
  cap: number = MAX_NOTABLE_ALTERNATIVES_PER_HIGHLIGHT,
  gap: number = NOTABLE_MOMENT_GAP_S
): NotableMoments {
  const sorted = [...rows].sort((a, b) => a.start - b.start);
  const clusters = anchorGapClusters(sorted, gap);
  const moments: NotableMomentCluster[] = [];
  let optionsSuppressed = 0;
  for (const cluster of clusters) {
    const owner = cluster.reduce((best, h) => {
      const tb = footageTier(best);
      const th = footageTier(h);
      if (tb !== th) return th > tb ? h : best;
      return betterMoment(best as PostableHighlight, h as PostableHighlight) === h ? h : best;
    });
    const siblings = cluster.filter((h) => h.id !== owner.id).sort((a, b) => a.start - b.start);
    const limit = Math.max(0, cap);
    const options = siblings.slice(0, limit);
    const suppressed = siblings.length - options.length;
    optionsSuppressed += suppressed;
    moments.push({ owner, options, memberCount: cluster.length, optionsSuppressed: suppressed });
  }
  moments.sort((a, b) => a.owner.start - b.owner.start);
  return { moments, optionsSuppressed };
}

/**
 * Transitive OVERLAP CHAINS over `rows` (a overlaps b, b overlaps c => one
 * moment). The component build is shared by the postable dedupe below and the
 * notable moment projection (ADAAAA-8422), so both agree on what ONE moment is.
 * Input order decides the cluster order (callers sort for their own ranking);
 * membership is the same either way.
 */
export function overlapChainClusters<T extends Pick<HighlightRecord, "start" | "end">>(rows: T[]): T[][] {
  const clusters: T[][] = [];
  // Greedy component build: each new window joins every moment it overlaps
  // (transitively), so a chain of overlapping clips collapses to one moment.
  for (const h of rows) {
    const hit = clusters.filter((c) => c.some((m) => windowsOverlap(m, h)));
    if (hit.length === 0) {
      clusters.push([h]);
      continue;
    }
    const merged = [h, ...hit.flat()];
    for (const c of hit) clusters.splice(clusters.indexOf(c), 1);
    clusters.push(merged);
  }
  return clusters;
}

/**
 * Collapse OVERLAP CHAINS (a overlaps b, b overlaps c => one moment) over a set
 * of already-gated candidate rows, so the result can never carry a transitive
 * overlap. Shared by the postable list (display) and the quota basis
 * ({@link quotaMomentCount}) so both agree on what one moment is.
 */
export function collapseOverlappingWindows(candidates: HighlightRecord[]): CollapsedMoments {
  // Highest quality first, so the strongest clip of a cluster owns the window.
  const ordered = [...candidates].sort((a, b) => qualityRank(b) - qualityRank(a) || a.start - b.start);
  const moments: PostableHighlight[] = [];
  const duplicates: PostableHighlight[] = [];
  const clusters = overlapChainClusters(ordered);
  let mergedCount = 0;
  for (const cluster of clusters) {
    if (cluster.length === 1) {
      moments.push({ ...cluster[0] });
      continue;
    }
    const winner = cluster.reduce((best, h) => betterMoment(best, h));
    const losers = cluster.filter((h) => h.id !== winner.id).sort((a, b) => a.start - b.start);
    moments.push({
      ...winner,
      duplicateCount: losers.length,
      mergedIds: losers.map((h) => h.id),
    });
    for (const l of losers) duplicates.push({ ...l, duplicateOf: winner.id });
    mergedCount += losers.length;
  }

  // Time order for the postable list (and its duplicate lane) so the board reads
  // left-to-right; the ranking above only decides which clip owns a moment.
  moments.sort((a, b) => a.start - b.start);
  duplicates.sort((a, b) => a.start - b.start);
  return { moments, duplicates, merged: mergedCount };
}

// ---------------------------------------------------------------------------
// Count projection (ADAAAA-7854)
// ---------------------------------------------------------------------------
//
// The canonical user-facing "total clips" for a job is the DEDUPED POSTABLE
// moment count — `buildPostableHighlights(...).highlights.length`. The persisted
// `highlights` rows are the raw audit total (they include rejected, contradicting
// and merged-away duplicates), so a surface that counts rows inflates the number
// a customer sees. Every payload that carries a per-job clip count therefore
// takes it from {@link postableCountFields}, never from `store.highlightsForJob()
// .length`. The rows are never deleted or rewritten: merged-ness stays derived
// here at read time from `start` / `end` / `score` / `corroborated` / `outcome`.

/** Read-time clip counts for one job. `rawHighlights` is the audit row total;
 * `postableHighlights` is the canonical user-facing count. */
export interface PostableHighlightCounts {
  /** Persisted rows in the audit trail, merged-away duplicates included. */
  rawHighlights: number;
  /** Canonical user-facing clip count: deduped postable moments. */
  postableHighlights: number;
  /** Duplicate rows absorbed into a postable moment (excluded from the count). */
  mergedHighlights: number;
  /** Rows dropped by the gate, reported so admin surfaces can explain the gap. */
  rejectedHighlights: number;
  notScoringHighlights: number;
  contradictingHighlights: number;
  /** ADAAAA-8549: attached replay rows (`replayOf` set). They are delivered under
   * their owner's `alternatives[]` and touch no other bucket, so the row identity
   * is `raw = postable + merged + rejected + notScoring + contradicting + replay`
   * (the four-term form holds when `replay` is 0). */
  replayHighlights: number;
}

/**
 * The count projection every job payload carries. It is a projection of ONE
 * `buildPostableHighlights` pass, so the list, the counts and the merged read can
 * never disagree with each other or with `GET /jobs/:id/detail`.
 */
export function postableCountFields(list: HighlightRecord[]): PostableHighlightCounts {
  return countsFromPostable(buildPostableHighlights(list));
}

/** The same projection when the caller already ran `buildPostableHighlights` for
 * the list it is about to return (`/jobs/:id/detail`), so the count and the list
 * come from ONE pass and cannot disagree. */
export function countsFromPostable(out: PostableHighlights): PostableHighlightCounts {
  const { counts } = out;
  return {
    rawHighlights: counts.total,
    postableHighlights: counts.postable,
    mergedHighlights: counts.merged,
    rejectedHighlights: counts.rejected,
    notScoringHighlights: counts.notScoring,
    contradictingHighlights: counts.contradicting,
    replayHighlights: counts.replay,
  };
}

/**
 * Deduped vs raw clip totals across every persisted row (admin analytics,
 * ADAAAA-7854 AC4). Dedupe is PER JOB: two different jobs must never collapse
 * into one moment just because their windows happen to overlap in content time.
 */
export function dedupedClipTotals(records: Iterable<HighlightRecord>): { raw: number; postable: number } {
  const byJob = new Map<string, HighlightRecord[]>();
  let raw = 0;
  for (const h of records) {
    raw += 1;
    const key = h.jobId ?? "";
    const list = byJob.get(key);
    if (list) list.push(h);
    else byJob.set(key, [h]);
  }
  let postable = 0;
  for (const list of byJob.values()) postable += buildPostableHighlights(list).counts.postable;
  return { raw, postable };
}

/**
 * The quota moment count for a job (ADAAAA-7854 AC6): overlapping clip rows
 * collapse into ONE moment, so a merged-away duplicate never charges the customer
 * twice for the same footage, while the surviving moment still debits exactly once.
 *
 * Deliberately VERDICT-INDEPENDENT: it filters only `status: "rejected"` (a human
 * said no, and the review route releases that slot). The precision gate that
 * decides what may be POSTED is a display decision — it does not change what was
 * generated, and every live/VOD/browser path persisted such a clip before this
 * change, so gating the quota on it would silently stop debiting real clips (an
 * esports `KILL` highlight has a non-goal `outcome` but is still the customer's
 * clip). The only rows this function excludes that the old per-row debit charged
 * are the overlapping duplicates — exactly the defect AC6 names.
 */
export function quotaMomentCount(list: HighlightRecord[]): number {
  return collapseOverlappingWindows(list.filter((h) => h.status !== "rejected")).moments.length;
}

/** Slot arithmetic for one insert: 1 debit for a new moment, 1 refund when an
 * insert bridges two moments into one (the absorbed moment's slot is released),
 * nothing when the row merged into an existing moment or took no slot at all. */
export function clipQuotaDelta(beforeMoments: number, afterMoments: number): { debit: number; refund: number } {
  const delta = afterMoments - beforeMoments;
  if (delta > 0) return { debit: Math.min(delta, 1), refund: 0 };
  if (delta < 0) return { debit: 0, refund: Math.min(-delta, 1) };
  return { debit: 0, refund: 0 };
}

/**
 * The quota decision for a highlight insert, order-independent: the winner of an
 * overlap cluster may land before OR after its duplicate, and the debit follows
 * the MOMENT count either way (so `slotsDebited === moments` always holds).
 */
export function quotaDeltaForInsert(
  before: HighlightRecord[],
  after: HighlightRecord[]
): { debit: number; refund: number } {
  return clipQuotaDelta(quotaMomentCount(before), quotaMomentCount(after));
}
