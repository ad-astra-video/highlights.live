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
import type { HighlightRecord } from "@highlights/events";

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
  /** Merged-away duplicates, each carrying `duplicateOf`. Excluded from
   * `highlights` so the postable list has zero overlapping windows. */
  duplicates: PostableHighlight[];
  /** Counts for the operator summary: how many persisted rows came in and how
   * many were dropped by each rule (rejected / not scoring / contradicting). */
  counts: { total: number; rejected: number; notScoring: number; contradicting: number; postable: number; merged: number };
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
  const counts = { total: list.length, rejected: 0, notScoring: 0, contradicting: 0, postable: 0, merged: 0 };
  const candidates: HighlightRecord[] = [];
  const notable: HighlightRecord[] = [];
  for (const h of list) {
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
  return { highlights: collapsed.moments, notable: notableRows, duplicates, counts };
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
  // Greedy component build: each new window joins every moment it overlaps
  // (transitively), so a chain of overlapping clips collapses to one moment.
  const clusters: HighlightRecord[][] = [];
  for (const h of ordered) {
    const hit = clusters.filter((c) => c.some((m) => windowsOverlap(m, h)));
    if (hit.length === 0) {
      clusters.push([h]);
      continue;
    }
    const merged = [h, ...hit.flat()];
    for (const c of hit) clusters.splice(clusters.indexOf(c), 1);
    clusters.push(merged);
  }
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
