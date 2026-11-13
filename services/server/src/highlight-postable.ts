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
//   1. `status: "rejected"` is never postable (a human said no). `pending` IS
//      postable (ADAAAA-8678): status is a PUBLISH state, not an evidence
//      verdict — auto-publish off stores `pending` and the card carries the
//      Approve control, so dropping it would strand that flow and blank every
//      such box. The GOAL-ness of a shipped card is disclosed by its
//      `confirmation` lane (`confirmation-lane.ts`), which words an unapproved
//      row as "Awaiting approval — …" and badges it UNCONFIRMED, never as an
//      evidenced GOAL. `published` does not exist on the record (the enum is
//      pending|accepted|rejected); an exported clip is settled to `accepted`,
//      which this gate keeps serving unchanged.
//   2. Only `outcome: "scoring_play"` is postable. `near_miss` / `big_play` are
//      "notable, not a goal" and ride a separate lane; `not_highlight` and a
//      legacy verdict with no outcome are not postable.
//   3. A verdict that contradicts itself is not postable, whatever its
//      `eventType` says: a structured Stage-2 `near_miss` / `not_goal`, a stored
//      Stage-2 dive attestation that did not corroborate the goal (ADAAAA-8647),
//      or a reason whose own text refutes the goal ("...does not enter the net").
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
//   6. ADAAAA-8733 (GT-2): two GOAL-class moments whose SCOREBUG MATCH CLOCK
//      reads prove they are the same game moment collapse into ONE moment even
//      when their clip windows do not overlap; two whose clocks prove they are
//      distinct are never collapsed. See the clock lane below for R1-R6.

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
 * structured Stage-2 verdict of near_miss/not_goal, a refuting Stage-2 dive
 * attestation, or refuting reason text. */
export function hasContradictingVerdict(
  h: Pick<HighlightRecord, "reason" | "goalConfirmed" | "confirmAttestation">
): boolean {
  if (h.goalConfirmed === "near_miss" || h.goalConfirmed === "not_goal") return true;
  if (hasRefutingDiveAttestation(h)) return true;
  return isGoalRefutingReason(h.reason);
}

/** The dive verdicts that argue about a goal. `dropped` / `passthrough` are
 * settled attempts that produced NO verdict, so they never refute. */
const GOAL_VERDICTS = ["confirmed_goal", "near_miss", "not_goal"] as const;

/**
 * ADAAAA-8647: did the row's OWN stored Stage-2 dive argue against the goal?
 *
 * The live async confirm lane stamps `confirmAttestation` on the HIGHLIGHT row
 * while `job_candidates` stores no confirm record, so this row-level field is
 * the only evidence a served read has about the dive. A `corroborated:true`
 * verdict confirmed the moment (it never refutes); a real verdict with
 * `corroborated:false` — including a `confirmed_goal` the dive could not
 * corroborate — is a refutation and the row must not ship as a GOAL card.
 */
export function hasRefutingDiveAttestation(
  h: Pick<HighlightRecord, "confirmAttestation">
): boolean {
  const att = h.confirmAttestation;
  if (!att || att.corroborated === true) return false;
  // ADAAAA-8894 (D4): a dive that ran on a row which MEASURED its own goal cannot
  // refute it. The measurement is the accept's corroboration, so the row keeps its
  // GOAL card and its lane; reading the verdict as a refutation here would demote
  // a measured GOAL into the notable lane — the precise regression the D4
  // precision guard exists to prevent.
  if (att.laneKeptByMeasurement === true) return false;
  return (GOAL_VERDICTS as readonly string[]).includes(att.goalConfirmed);
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
  counts: { total: number; rejected: number; notScoring: number; contradicting: number; postable: number; merged: number };
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
  | "replay_owner_missing";

export interface RowAccounting {
  /** Every persisted row served as a card (or as a served replay), and how. */
  served: { id: string; representation: RowRepresentation }[];
  /** Every persisted row with NO page representation, with the reason. */
  unrepresented: { id: string; reason: RowRepresentation }[];
}

/** Why a row that is in no bucket has no page representation. */
function unrepresentedReason(row: HighlightRecord): RowRepresentation {
  if (row.status === "rejected") return "rejected";
  if (row.outcome !== "scoring_play") {
    // A near_miss / big_play that reached no moment was capped off the rail; any
    // other outcome was never a card in the first place.
    return row.outcome === "near_miss" || row.outcome === "big_play"
      ? "notable_option_over_rail_cap"
      : "not_scoring";
  }
  return "contradicting";
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

/** Rule 1-3: may this single persisted record be posted? (ADAAAA-8678: `pending`
 *  is postable — a publish state, not a verdict — and its lane is disclosed on
 *  the card; only `rejected` is refused.) */
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
  const counts = { total: list.length, rejected: 0, notScoring: 0, contradicting: 0, postable: 0, merged: 0 };
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
    // ADAAAA-8647: a scoring row whose OWN stored Stage-2 dive refuted the goal
    // is not a GOAL card. job_candidates stores no confirm record, so rule 3
    // below could not see the dive and the row shipped as a postable GOAL while
    // its badge read CONFIRMED. Downgrade it into the notable lane (its clip
    // exists) so 0 false GOAL cards ship; the persisted row is NOT rewritten —
    // `outcome` is projected here exactly like the celebration absorb below, and
    // the card's badge is `dive_disagreed` from `confirmationForHighlightRow`.
    if (hasRefutingDiveAttestation(h)) {
      counts.notScoring += 1;
      notable.push({ ...h, outcome: "big_play" });
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
  // ADAAAA-8733 (GT-2): combine the surviving moments on the SCOREBUG MATCH
  // CLOCK. This runs AFTER the precision gate and the overlap collapse, so the
  // clock can never add, confirm, demote or re-lane a GOAL (R3) — it can only
  // recognise that two already-postable moments are one game moment. The job's
  // own rows decide whether the lane is live at all (R5: no clock / frozen bug
  // => disabled => byte-identical delivery).
  const clockLane = clockCombineForJob(collapsed.moments, visible);
  counts.merged += clockLane.merged;
  // ADAAAA-8199: absorb the goal-shaped celebration lane into the confirmed GOAL
  // it overlaps, so one transition never ships as a GOAL card PLUS a celebration
  // card. The rows are NOT mutated or deleted (the persisted audit trail keeps
  // both); the read-side projection is what the board and the counts show.
  const absorbed = absorbGoalCelebrations(clockLane.moments, notable);
  counts.merged += absorbed.absorbed;
  // ADAAAA-8155: a demoted row that survives the overlap absorb can still be the
  // SAME transition as an accepted GOAL when its judged instant sits inside that
  // GOAL's clip window — the clip was localized away from the judged instant, so
  // the windows no longer overlap and the absorb rule cannot see it. Clear the
  // marker there too, or the board prints "GOAL (unconfirmed)" beside the
  // accepted card for one goal. Marker only: the fail-closed invariant stands.
  const notableRows = suppressCoveredProvisionalMarkers(clockLane.moments, absorbed.notable);
  // The absorbed rows leave the "not scoring" drop bucket and join the merged
  // one, so the count identity `raw - postable = merged + rejected + notScoring +
  // contradicting` still holds (nothing is counted twice or lost).
  counts.notScoring = Math.max(0, counts.notScoring - absorbed.absorbed);
  const duplicates = [...clockLane.duplicates, ...collapsed.duplicates, ...absorbed.duplicates].sort((a, b) => a.start - b.start);
  counts.postable = clockLane.moments.length;
  // ADAAAA-8422 (N1): the surviving notable rows grouped into moments. Pure
  // presentation over the SAME rows — counts above are already final and never
  // read this projection.
  const notableMoments = clusterNotableWindows(notableRows);
  // ADAAAA-8542 (AC3): account every persisted row against exactly this served
  // projection — one pass, so the accounting can never disagree with the page.
  const rowAccounting = accountHighlightRows(list, { highlights: clockLane.moments, duplicates, notableMoments });
  return { highlights: clockLane.moments, notable: notableRows, notableMoments, duplicates, counts, rowAccounting };
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
// ADAAAA-8733 (GT-2): combine GOAL moments on the SCOREBUG MATCH CLOCK
// ---------------------------------------------------------------------------
//
// Every lane that combines clips today guesses about the STREAM, not the GAME:
// footage overlap (`collapseOverlappingWindows` above), the 30 s burst window,
// the 60 s duplicate reach and the 120 s same-transition horizon. Measured cost
// of guessing: live job `9a6b1d8f` shipped ONE `1-1 -> 2-1` goal THREE times, 37 s
// and 82 s apart — every row honestly attested by a legible forward score read.
//
// When the clock is legible it is the only on-screen signal that says "this is
// the same game moment" without needing a score transition to parse. The rules
// below are the GT-1 census's verdict turned into a lane, and they only ever
// REMOVE duplicates from the postable list — the persisted rows are untouched:
//
//   R1 same moment  — two GOAL-class moments whose clocks agree within
//                     `CLOCK_SAME_MOMENT_S` (same period, coherent with content
//                     time) are one event even when their windows do not overlap
//                     and their transition keys disagree or are null.
//   R2 distinct     — clocks separated by >= `CLOCK_DISTINCT_S` are distinct
//                     events and are never absorbed.
//   R3 never attestation — the lane runs AFTER the precision gate, so a clock
//                     can never add, confirm, demote or re-lane a GOAL. Where
//                     the clock and the score disagree, the SCORE wins; a null
//                     clock is a no-op.
//   R4 coherence    — a clock participates only when it advances with content
//                     time. A REWOUND read is a replay inset, not a same-moment
//                     proof, so it never combines (it keeps riding the existing
//                     replay/alternative lane).
//   R5 frozen bug   — a job whose bug shows an unchanging clock while content
//                     time advances has NO clock lane, so a placeholder graphic
//                     can never merge genuinely distinct goals.
//   R6 no new clip budget — nothing is re-cut or lengthened: the owner's clip
//                     stays as delivered and the others are absorbed as
//                     duplicates, exactly like the overlap collapse.
//   R7 score identity (ADAAAA-8754) — the clock value is the OBSERVATION time,
//                     not the goal's game time: `matchClockFromTimeline` stores
//                     `ts` = the OCR frame nearest THAT window's own anchor, so
//                     a re-delivery of one goal reads the bug again, later (job
//                     `9a6b1d8f`: per-row ts 2.6 / 38.7 / 84.9 s). When the
//                     SCORE already ties two GOAL-class moments to one
//                     transition (the same `pre -> post` pair, from
//                     `attestationUsed.transitionScore` / `transitionKey` or the
//                     stored verdict text), the pair is one game event even
//                     though the clock moved: a held value is the goal clock
//                     re-shown, an advancing value is the same running clock
//                     sampled later. For that class the content-coherence term
//                     is dropped — only a read that CONTRADICTS a running clock
//                     (rewound = replay inset, or a cut) blocks. R1/R2/R4 keep
//                     their meaning for every pair the score does not tie, so a
//                     clock can still never merge two genuinely distinct score
//                     transitions.
//
// The tolerances are GT-1's measurements, not intuition: the largest |Δclock|
// between two re-reads of the SAME event was 7 s (=> CLOCK_SAME_MOMENT_S = 10),
// and the smallest |Δclock| between genuinely distinct goals on one coherent
// segment was 309 s with nothing measured between 10 s and 309 s (=> 30 s as a
// safe floor, 3x the same-moment spread).

/** GT-1: two clock reads this close (seconds) are the SAME game moment. */
export const CLOCK_SAME_MOMENT_S = 10;
/** GT-1: two legible clocks this far apart (seconds) are DISTINCT events. */
export const CLOCK_DISTINCT_S = 30;
/** GT-1 coherence: |Δclock - Δcontent| within this is a coherent read. The
 * measured same-event re-read ticked +7 s of clock over +4 s of content. */
export const CLOCK_COHERENCE_TOLERANCE_S = 3;
/** R5: a clock that does not move while content advances this far is a frozen
 * (static/placeholder) bug, measured as Δclock=0 over >20 s in the census. */
export const CLOCK_FROZEN_SPAN_S = 20;

/** How a pair of clock readings relates, for the merge decision. */
export type ClockPairRelation =
  /** R1: agree within CLOCK_SAME_MOMENT_S on one coherent segment. */
  | "same_moment"
  /** R7 (ADAAAA-8754): the score ties both rows to ONE transition, and the
   * clock reading is consistent with re-observing that event later (held value,
   * or a clock advancing in step with content). */
  | "same_event"
  /** R2: both legible, >= CLOCK_DISTINCT_S apart, coherent. */
  | "distinct"
  /** R5 (ADAAAA-8754): an UNCHANGING value while content advanced past
   * `CLOCK_FROZEN_SPAN_S`, on a pair the score does NOT tie to one transition —
   * a static/placeholder bug, never a merge. (A frozen pair the score DOES tie
   * is `same_event`: that is the goal clock re-shown.) */
  | "frozen"
  /** R4: the clock went BACKWARDS against content time (a replay inset). */
  | "rewound"
  /** R4: the clock does not advance with content (a graphic/match cut). */
  | "jumping"
  /** Between the two tolerances, or two reads at the same content instant that
   * disagree: neither rule applies, so the lane is a no-op. */
  | "inconclusive"
  /** At least one side carries no legible clock: nothing to combine on. */
  | "unknown";

/** The clock fields the lane reads. Structural so a bare fixture row works. */
type ClockBearing = {
  matchClock?: { seconds: number | null; period?: string | null; legible?: boolean; ts?: number };
  start?: number;
  end?: number;
  localizedTs?: number;
  /** ADAAAA-8754 (R7): the score transition the row already credits. Read-only:
   * the lane uses it to decide that two rows are ONE event, and never to attest,
   * confirm, demote or re-lane a GOAL (R3). */
  attestationUsed?: {
    transitionKey?: string | null;
    transitionScore?: { pre: readonly number[]; post: readonly number[] } | null;
  } | null;
  /** ADAAAA-8754: the persisted verdict text. On rows written before
   * `attestationUsed.transitionScore` existed this is the only score-pair
   * evidence on the row (job `9a6b1d8f`: "Scoreboard changes from 1-1 to 2-1"). */
  reason?: string;
};

/** The `pre -> post` score pair in a transition key or a verdict sentence. */
const TRANSITION_PAIR = /(\d+)\s*[-\u2013:]\s*(\d+)\s*(?:->|>|\u2192|\bto\b)\s*(\d+)\s*[-\u2013:]\s*(\d+)/i;

/** Canonical `pre>post` form of a transition, e.g. `1-1>2-1`. */
function canonicalTransition(preA: number, preB: number, postA: number, postB: number): string {
  return `${preA}-${preB}>${postA}-${postB}`;
}

/**
 * ADAAAA-8754 (R7): the scoreboard transition a row credits, or null.
 *
 * Priority is the most explicit evidence first — the disclosed `transitionScore`
 * pair, then the `transitionKey` string, then the pair named in the stored
 * verdict text — so a row written before ADAAAA-8663 (job `9a6b1d8f`) can still
 * be tied to its transition. Only identity: two rows that name the SAME
 * `pre -> post` pair describe the same scoreboard event. A row whose evidence is
 * absent (or not a pair) returns null, which keeps every existing rule exactly as
 * it was.
 */
export function transitionIdentity(h: ClockBearing): string | null {
  const att = h.attestationUsed;
  const pair = att?.transitionScore;
  if (pair && Array.isArray(pair.pre) && Array.isArray(pair.post) && pair.pre.length === 2 && pair.post.length === 2) {
    const [preA, preB, postA, postB] = [pair.pre[0], pair.pre[1], pair.post[0], pair.post[1]];
    if ([preA, preB, postA, postB].every((n) => Number.isInteger(n) && n >= 0)) {
      return canonicalTransition(preA, preB, postA, postB);
    }
  }
  const key = att?.transitionKey;
  if (typeof key === "string" && key.trim()) {
    const m = key.match(TRANSITION_PAIR);
    if (m) return canonicalTransition(+m[1], +m[2], +m[3], +m[4]);
    return key.trim().toLowerCase();
  }
  const fromReason = typeof h.reason === "string" ? h.reason.match(TRANSITION_PAIR) : null;
  if (fromReason) return canonicalTransition(+fromReason[1], +fromReason[2], +fromReason[3], +fromReason[4]);
  return null;
}

/** ADAAAA-8754 (R7): do both rows credit the SAME score transition? */
export function sharesTransition(a: ClockBearing, b: ClockBearing): boolean {
  const ia = transitionIdentity(a);
  if (ia === null) return false;
  return ia === transitionIdentity(b);
}

/** The legible clock of a row, or undefined (a null/unreadable clock never
 * participates — R3's no-op). A period-less reading is allowed: the census's
 * FOX Euro bug shows none. */
function legibleClock(h: ClockBearing): { seconds: number; period: string | null; ts: number } | undefined {
  const c = h.matchClock;
  if (!c || c.legible === false) return undefined;
  if (typeof c.seconds !== "number" || !Number.isFinite(c.seconds) || c.seconds < 0) return undefined;
  return { seconds: c.seconds, period: c.period ?? null, ts: clockContentTs(h) };
}

/** The content instant a row's clock was read at: the reading's own frame ts
 * when it has one, else the row's localized instant, else its window centre. */
function clockContentTs(h: ClockBearing): number {
  if (typeof h.matchClock?.ts === "number" && Number.isFinite(h.matchClock.ts)) return h.matchClock.ts;
  if (typeof h.localizedTs === "number" && Number.isFinite(h.localizedTs)) return h.localizedTs;
  const start = typeof h.start === "number" ? h.start : 0;
  const end = typeof h.end === "number" ? h.end : start;
  return (start + end) / 2;
}

/**
 * ADAAAA-8733: how a PAIR of moments relates on the clock. Pure and symmetric —
 * the order of the two rows never changes the answer.
 *
 * R4 is the segment gate GT-1 says is mandatory: every incoherent pair in the
 * census was a graphic/match cut (a bumper, a studio cut-away, a quarter edit),
 * never an OCR error, so requiring the clock to track content time is what stops
 * one match's bug from merging another match's goals.
 */
export function clockPairRelation(a: ClockBearing, b: ClockBearing): ClockPairRelation {
  const ca = legibleClock(a);
  const cb = legibleClock(b);
  if (!ca || !cb) return "unknown";
  // A different period (1H vs 2H, Q3 vs Q4) is a different moment, never a
  // duplicate. Two period-less readings (many bugs show none) stay comparable.
  if (ca.period && cb.period && ca.period !== cb.period) return "distinct";
  const [first, second] = ca.ts <= cb.ts ? [ca, cb] : [cb, ca];
  const deltaClock = second.seconds - first.seconds;
  const deltaContent = second.ts - first.ts;
  const skew = Math.abs(deltaClock - deltaContent);
  if (deltaContent <= 0) {
    // Two reads at the same content instant: agreeing clocks are one moment.
    return Math.abs(deltaClock) <= CLOCK_SAME_MOMENT_S ? "same_moment" : "inconclusive";
  }
  // ADAAAA-8754 (R7): the score already ties both rows to ONE transition, so a
  // clock that moved with the re-delivery is not evidence of a second event —
  // `matchClock.ts` is the observation frame of THIS window's anchor, and a later
  // delivery observes the same running bug later. A held value (the goal clock
  // re-shown) and a value advancing in step with content (a later live sample)
  // are both consistent with one event here; the content-coherence term that R4
  // uses for untied pairs is deliberately dropped. Only a read that contradicts a
  // running clock blocks: rewound (a replay inset) or a jump (a cut).
  if (sharesTransition(a, b)) {
    if (Math.abs(deltaClock) <= CLOCK_SAME_MOMENT_S) return "same_event";
    if (skew <= CLOCK_COHERENCE_TOLERANCE_S) return "same_event";
    return deltaClock < 0 ? "rewound" : "jumping";
  }
  // R5: an unchanging value over a long span with no score tie is the static /
  // placeholder bug the lane must never merge on.
  if (deltaClock === 0 && deltaContent > CLOCK_FROZEN_SPAN_S) return "frozen";
  if (skew > CLOCK_COHERENCE_TOLERANCE_S) {
    // Incoherent: the clock moved independently of content time. Backwards is a
    // replay inset (R4); forwards is a cut to another graphic/match.
    return deltaClock < 0 ? "rewound" : "jumping";
  }
  if (Math.abs(deltaClock) <= CLOCK_SAME_MOMENT_S) return "same_moment";
  if (Math.abs(deltaClock) >= CLOCK_DISTINCT_S) return "distinct";
  return "inconclusive";
}

/**
 * ADAAAA-8733 (R5) / ADAAAA-8754 (R7): is the clock lane live for THIS job?
 *
 * Disabled when the job carries fewer than two legible clock readings (nothing
 * to combine on), and disabled when two reads show an UNCHANGING clock while
 * content time advances past `CLOCK_FROZEN_SPAN_S` — a static/placeholder bug,
 * which would otherwise merge genuinely distinct goals. Deliberately conservative:
 * a job with no clock keeps byte-identical delivery (AC-GT5).
 *
 * ADAAAA-8754: a frozen pair that the SCORE ties to one transition is exempt —
 * a re-delivered goal reads the same goal clock again, and the score (not the
 * clock) is what keeps two distinct goals apart there. Without the exemption the
 * measured `9a6b1d8f` shape (held 1520 over 36/82 s, same `1-1 -> 2-1`) turned
 * the whole lane off and AC-GT2 could not pass. A job whose frozen value has NO
 * score tie anywhere is still a placeholder bug and keeps the lane off (AC-GT5);
 * in a mixed job each untied frozen pair is refused pairwise (`frozen`), so the
 * no-op guarantee survives without losing the score-tied merge.
 */
export function clockLaneEnabledForJob(rows: ReadonlyArray<ClockBearing>): boolean {
  const bearing = rows
    .map((h) => ({ h, c: legibleClock(h) }))
    .filter((e): e is { h: ClockBearing; c: { seconds: number; period: string | null; ts: number } } => !!e.c);
  if (bearing.length < 2) return false;
  let frozenPairs = 0;
  let explained = 0;
  for (let i = 0; i < bearing.length; i++) {
    for (let j = i + 1; j < bearing.length; j++) {
      const a = bearing[i];
      const b = bearing[j];
      if (a.c.seconds !== b.c.seconds || Math.abs(b.c.ts - a.c.ts) <= CLOCK_FROZEN_SPAN_S) continue;
      frozenPairs += 1;
      if (sharesTransition(a.h, b.h)) explained += 1;
    }
  }
  // No frozen pair at all, or at least one that the score explains.
  return frozenPairs === 0 || explained > 0;
}

/**
 * ADAAAA-8733 (R1/R2/R6): collapse moments whose clocks prove they are the SAME
 * game moment, and never collapse two whose clocks prove they are distinct.
 *
 * Membership is a pairwise `same_moment` test against EVERY member of an open
 * cluster (and a hard spread bound of `CLOCK_SAME_MOMENT_S`), so a chain of
 * reads cannot drift one cluster across a longer span. The winner is the same
 * ranking the overlap collapse uses (best corroboration, then score, then the
 * earlier window), its delivered window is unchanged — nothing is re-cut or
 * lengthened (R6) — and every loser moves to the duplicate lane with
 * `duplicateOf`, exactly like the overlap collapse.
 */
export function combineClockMoments(moments: PostableHighlight[]): CollapsedMoments {
  const ordered = [...moments].sort((a, b) => clockContentTs(a) - clockContentTs(b) || a.start - b.start);
  const clusters: PostableHighlight[][] = [];
  for (const m of ordered) {
    const mine = legibleClock(m);
    // R3: a moment with no legible clock never participates — it opens its own
    // cluster and can be neither a merge owner nor a merge target.
    if (!mine) {
      clusters.push([m]);
      continue;
    }
    const joined = clusters.find((cluster) => {
      // ADAAAA-8754 (R7): a cluster the score ties to one transition is compared
      // on the relation alone — the clock's own spread is the re-observation lag,
      // not a second event (held 1520 or advancing 1520/1556/1602 both merge).
      // Every other cluster keeps the spread bound so a chain of reads can never
      // drift a cluster across a longer clock span.
      const allSameEvent = cluster.every((member) => sharesTransition(member, m));
      const sameMoment = (member: PostableHighlight) => {
        const relation = clockPairRelation(member, m);
        return relation === "same_moment" || relation === "same_event";
      };
      if (!allSameEvent) {
        // A clockless member can neither own nor join a clock cluster; reading its
        // clock here would throw (start order decides which cluster is open).
        if (cluster.some((member) => !legibleClock(member))) return false;
        const spread = (seconds: number[]) => Math.max(...seconds) - Math.min(...seconds);
        const memberClocks = cluster.map((h) => legibleClock(h)!.seconds);
        if (spread([...memberClocks, mine.seconds]) > CLOCK_SAME_MOMENT_S) return false;
      }
      return cluster.every(sameMoment);
    });
    if (joined) joined.push(m);
    else clusters.push([m]);
  }
  const outMoments: PostableHighlight[] = [];
  const duplicates: PostableHighlight[] = [];
  let merged = 0;
  for (const cluster of clusters) {
    if (cluster.length === 1) {
      outMoments.push({ ...cluster[0] });
      continue;
    }
    const winner = cluster.reduce((best, h) => betterMoment(best, h));
    const losers = cluster.filter((h) => h.id !== winner.id).sort((a, b) => a.start - b.start);
    outMoments.push({
      ...winner,
      duplicateCount: (winner.duplicateCount ?? 0) + losers.length,
      mergedIds: [...(winner.mergedIds ?? []), ...losers.map((h) => h.id)],
    });
    for (const l of losers) duplicates.push({ ...l, duplicateOf: winner.id });
    merged += losers.length;
  }
  outMoments.sort((a, b) => a.start - b.start);
  duplicates.sort((a, b) => a.start - b.start);
  return { moments: outMoments, duplicates, merged };
}

/**
 * ADAAAA-8733: the clock lane's read-side entry point. A no-op (returns the same
 * rows, zero merged) when the job has no usable clock, which is what keeps a
 * clock-less / static-bug job byte-identical to master (AC-GT4 / AC-GT5).
 */
export function clockCombineForJob(
  moments: PostableHighlight[],
  jobRows: ReadonlyArray<ClockBearing>
): CollapsedMoments {
  if (!clockLaneEnabledForJob(jobRows)) return { moments, duplicates: [], merged: 0 };
  return combineClockMoments(moments);
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
