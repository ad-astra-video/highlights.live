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

  // Highest quality first, so the strongest clip of a cluster owns the window.
  // Merge OVERLAP CHAINS (a overlaps b, b overlaps c => one moment), so the
  // postable list can never carry a transitive overlap.
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
    counts.merged += losers.length;
  }

  // Time order for the postable list (and its duplicate lane) so the board reads
  // left-to-right; the ranking above only decides which clip owns a moment.
  moments.sort((a, b) => a.start - b.start);
  duplicates.sort((a, b) => a.start - b.start);
  counts.postable = moments.length;
  return { highlights: moments, notable, duplicates, counts };
}
