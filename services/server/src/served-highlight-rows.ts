/**
 * ADAAAA-8854: the ONE shape a SERVED highlight / notable row has.
 *
 * The composite read (`GET /jobs/:id/detail`) and the incremental stream
 * (`GET /jobs/:id/sections-delta`) both ship the same cards, and the webapp
 * REPLACES its arrays wholesale with whatever a delta returns
 * (`JobDetail.tsx` mergeDelta). Before this module the two routes built the row
 * shape independently: the composite attached `confirmation`, `postTitle` and
 * `caption`, the delta attached only `exportUri`. So every refresh silently
 * degraded the page — a card born from the delta stream read UNCONFIRMED while
 * its stored lane was `measured` / `dive`, and its title/caption fell back to
 * the raw stored row (ADAAAA-8854, parent ADAAAA-8850).
 *
 * The fix is structural, not a second copy of the fields: both routes call
 * these builders, so a field added here is added on both surfaces at once and
 * the two can never drift again. Read-path only — nothing here derives a lane
 * (the caller passes the one it already derived) and nothing is stored.
 */
import {
  postTitleTeamSubject,
  projectAnnouncerCaption,
  projectPostTitle,
  type HighlightAlternative,
  type HighlightConfirmation,
  type HighlightRecord,
} from "@highlights/events";
import { servedClipUri } from "./clip-choice";
import type { NotableMomentCluster, PostableHighlight } from "./highlight-postable";

/** What a served row needs from the request: the caller's id (export tokens are
 *  minted per caller), the job's match context (copy derivation only names a
 *  team the job recorded), and the route's own export-URL minter. */
export interface ServedRowContext {
  matchContext?: { teams?: { name?: string | null }[]; ambiguous?: boolean } | null;
  exportUriFor: (row: HighlightRecord) => string;
}

/** ADAAAA-8318: the card's copy target — the stored `postTitle` byte-for-byte
 *  while it satisfies the title shape bar, else the deterministic
 *  `LABEL · m:ss · subject` title. Pure, no model call, never empty. */
export function copyTargetFor(
  h: HighlightRecord,
  matchContext?: ServedRowContext["matchContext"]
): string {
  return projectPostTitle(
    { ...h, reasonRaw: h.reason_raw ?? null },
    { subject: postTitleTeamSubject(h, matchContext) }
  );
}

/** ADAAAA-8328: the card's never-empty announcer detail. A stored caption is
 *  served byte-for-byte; a refused/absent one degrades to the row's own gated
 *  sentence (never the title) exactly like the composite read. */
export function announcerDetailFor(
  h: HighlightRecord,
  matchContext?: ServedRowContext["matchContext"]
): string {
  return projectAnnouncerCaption(
    { ...h, reasonRaw: h.reason_raw ?? null },
    copyTargetFor(h, matchContext)
  );
}

/** The clip a served row plays: the operator's chosen alternative, else the
 *  record's own cut. */
export function servedRowClip(h: HighlightRecord): HighlightRecord {
  return { ...h, clipUri: servedClipUri(h) };
}

/**
 * One SERVED postable card. `confirmation` is the lane the caller derived for
 * THIS row (`confirmationForHighlightRow`), absent when nothing could be
 * derived — the card then reads UNCONFIRMED rather than inventing a lane.
 * `alternatives` are the caller's grouped celebration/replay windows; the
 * composite groups them per job, the delta carries none, so both call sites pass
 * what they already computed.
 */
export function servedHighlightRow(
  h: PostableHighlight,
  confirmation: HighlightConfirmation | undefined,
  ctx: ServedRowContext,
  extras?: { alternatives?: HighlightAlternative[] }
) {
  const served = servedRowClip(h);
  return {
    ...served,
    postTitle: copyTargetFor(h, ctx.matchContext),
    caption: announcerDetailFor(h, ctx.matchContext),
    exportUri: ctx.exportUriFor(served),
    ...(confirmation ? { confirmation } : {}),
    ...(extras?.alternatives?.length ? { alternatives: extras.alternatives } : {}),
  };
}

/**
 * ADAAAA-8422 (N1): the sibling windows of a notable moment are its clip
 * options — each its OWN stored row, served from its own already-cut `clipUri`
 * (no re-encode, no decide) with a per-caller export URL minted against that
 * row's id. Shared so the delta cannot serve a moment's rail differently.
 *
 * ADAAAA-8912 (D5b ruling): only the moment OWNER can carry an alternative. A
 * sibling row's own `highlight_alternatives[]` (measured: `daa53f58` on job
 * `a0e60cc2` carries `11d4d688`, a `recentered` option at window 416) is
 * deliberately NOT projected here, because a sibling is served as a read-only
 * option (`ClipRailSlide` with no `alternativeId`): it has no pick row, and
 * picking it would swap which MOMENT the card serves, not which clip — a
 * product decision the D5 contract does not take.
 *
 * A write-seam refusal is not available for the same reason: `siblingClips` /
 * owner is a READ-time anchor clustering over the whole row set
 * (`notableMomentCluster`), so a row is not yet "sibling-eligible" when the
 * dive delivers its option. The contract is therefore stated at the read seam
 * (here) and in the D5 spec's "sibling windows" section, not enforced on write.
 */
export function servedSiblingClips(m: NotableMomentCluster, ctx: ServedRowContext) {
  return m.options.map((o) => {
    const row = servedRowClip(o);
    return {
      id: row.id,
      start: row.start,
      end: row.end,
      clipUri: row.clipUri,
      ...(row.clipError ? { clipError: row.clipError } : {}),
      ...(row.eventType ? { eventType: row.eventType } : {}),
      exportUri: ctx.exportUriFor(row),
    };
  });
}

/**
 * ADAAAA-8912 (D5b/AC5.6b): the options this read SUPPRESSES.
 *
 * {@link servedSiblingClips} deliberately drops a sibling row's own
 * `highlight_alternatives[]` (only the moment OWNER can carry an option), so a
 * delivered option on a sibling-eligible row reaches no slide and no pick row.
 * The D5 contract (spec rev 4, §4 D5 item 7b) says such an option must be
 * COUNTED rather than silently dropped — measured on job `a0e60cc2`: row
 * `daa53f58` carries `11d4d688` (`recentered`, window 416) while the card serves
 * `-4150.mp4`. Pure: ids only, no stored data is touched.
 */
export function countSuppressedSiblingAlternatives(
  moments: NotableMomentCluster[],
  alternativesByOwner: Map<string, HighlightAlternative[]>
): { count: number; rows: { rowId: string; ownerId: string; alternativeIds: string[] }[] } {
  const rows: { rowId: string; ownerId: string; alternativeIds: string[] }[] = [];
  for (const m of moments) {
    for (const option of m.options) {
      const alts = alternativesByOwner.get(option.id);
      if (!alts?.length) continue;
      rows.push({ rowId: option.id, ownerId: m.owner.id, alternativeIds: alts.map((a) => a.id) });
    }
  }
  rows.sort((a, b) => (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0));
  return { count: rows.reduce((n, r) => n + r.alternativeIds.length, 0), rows };
}

/**
 * One SERVED notable card (ADAAAA-8178 / ADAAAA-8530): the same card the
 * postable feed mounts, so it needs the same export URL, copy target, caption
 * and confirmation lane, plus its one-card-per-moment grouping.
 */
export function servedNotableRow(
  m: NotableMomentCluster,
  confirmation: HighlightConfirmation | undefined,
  ctx: ServedRowContext,
  /** ADAAAA-8893 (D5): the notable card's OWN alternatives — a dive's
   *  re-centered option of a `dive_held`/`big_play` moment lives here, and the
   *  notable lane used to serve none, so the option was invisible on exactly the
   *  rows the dive most often re-centers. */
  extras?: { alternatives?: HighlightAlternative[] }
) {
  const served = servedRowClip(m.owner);
  const siblingClips = servedSiblingClips(m, ctx);
  return {
    ...served,
    postTitle: copyTargetFor(m.owner, ctx.matchContext),
    caption: announcerDetailFor(m.owner, ctx.matchContext),
    exportUri: ctx.exportUriFor(served),
    ...(confirmation ? { confirmation } : {}),
    siblingCount: m.memberCount,
    ...(extras?.alternatives?.length ? { alternatives: extras.alternatives } : {}),
    ...(siblingClips.length ? { siblingClips } : {}),
  };
}
