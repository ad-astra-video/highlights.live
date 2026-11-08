import type { JobDetailHighlight } from "./jobDetail";
import { momentRangeLabel } from "./highlightPost";

/**
 * ADAAAA-8304: the goal card's clip rail.
 *
 * A delivered goal can carry its own highlight clip PLUS up to
 * `MAX_ALTERNATIVES_PER_HIGHLIGHT` (2) celebration/replay clips on the detail
 * payload (`highlight.alternatives[]`, already nearest-to-goal-end first). The
 * card renders them as ONE horizontal rail inside the video area, primary
 * slide first, one slide per clip.
 *
 * The index/scroll math lives here (pure, node-env testable) because this
 * package has no jsdom: the component is graded with `react-dom/server`
 * markup tests, and the interactive rules are pinned on these helpers.
 */

export type ClipRailSlideKind = "highlight" | "celebration" | "replay" | "sibling";

export interface ClipRailSlide {
  kind: ClipRailSlideKind;
  /** Stable React key / slide identity. */
  key: string;
  src: string;
  /** `clipError` for this clip — a delivered-but-failed clip still renders a
   *  slide (and still counts in the badge), it just shows the failure state. */
  error?: string;
  start: number;
  end: number;
  /** Operator-only label for the player's aria description. Never rendered as
   *  customer copy: the identity line is fixed ("Highlight" / "Celebration"). */
  eventType?: string;
  /** ADAAAA-8032: the primary slide keeps the bounded wait state. */
  waitingSinceMs?: number;
  /** ADAAAA-8321: the delivered alternative this slide shows (absent on the
   * moment's own clip). The picker posts THIS id. */
  alternativeId?: string;
  /** ADAAAA-8325 (Inc 2): the alternative's footage phase from the decide
   * verdict (`replay` on an attached replay window). Operator-facing only. */
  phase?: "live" | "replay";
  /** ADAAAA-8325: TRUE when the attach needed the phase-corroborated band (the
   * Inc 1 hash bar alone missed it), so the picker names that provenance. */
  phaseCorroborated?: boolean;
  /** ADAAAA-8422 (N1): a notable moment's SIBLING clip — the same moment's other
   * window, read-only (no pick). Carries that row's own id + export URL. */
  siblingClipId?: string;
  exportUri?: string;
}

/**
 * The rail's slides, in payload order: the highlight's own clip first, then one
 * slide per alternative. The count is the number of slides actually rendered —
 * that is what the badge reports and what the server caps at 3.
 */
export function clipRailSlides(h: JobDetailHighlight): ClipRailSlide[] {
  const slides: ClipRailSlide[] = [
    {
      kind: "highlight",
      key: `highlight:${h.id}`,
      src: h.clipUri,
      error: h.clipError,
      start: h.start,
      end: h.end,
      eventType: h.eventType,
      waitingSinceMs: h.createdAt ? Date.parse(h.createdAt) : undefined,
    },
  ];
  for (const a of h.alternatives ?? []) {
    slides.push({
      kind: a.eventType === "replay" ? "replay" : "celebration",
      alternativeId: a.id,
      key: `alternative:${a.id}`,
      src: a.clipUri,
      error: a.clipError,
      start: a.start,
      end: a.end,
      eventType: a.eventType,
      // ADAAAA-8325 (Inc 2): carry the phase provenance so the picker can say
      // WHY this alternative is offered.
      ...(a.phase ? { phase: a.phase } : {}),
      ...(a.replayEvidence?.phase === "replay" ? { phaseCorroborated: true } : {}),
    });
  }
  // ADAAAA-8422 (N1): a notable moment's other windows ride the SAME rail — one
  // read-only slide per sibling, each playing/downloading its OWN already-cut
  // clip. No `alternativeId`, because a notable option is not (yet) pickable:
  // pick/serve parity for a notable moment is the P2 follow-on.
  for (const s of h.siblingClips ?? []) {
    slides.push({
      kind: "sibling",
      siblingClipId: s.id,
      key: `sibling:${s.id}`,
      src: s.clipUri,
      error: s.clipError,
      start: s.start,
      end: s.end,
      eventType: s.eventType,
      ...(s.exportUri ? { exportUri: s.exportUri } : {}),
    });
  }
  return slides;
}

/**
 * ADAAAA-8321 (AC6): the slide the card opens on. The moment's pick wins; with
 * no pick the original clip stays the default (board policy: the original
 * carries the live-pass evidence).
 */
export function clipRailDefaultIndex(h: JobDetailHighlight): number {
  const chosen = h.clipChoice?.alternativeId;
  if (!chosen) return 0;
  const idx = (h.alternatives ?? []).findIndex((a) => a.id === chosen);
  return idx >= 0 ? idx + 1 : 0;
}

/** The picker's copy for an alternative: "Replay @ 207 s" / "Celebration @ 165 s".
 * ADAAAA-8325 (Inc 2): a replay whose attach needed the decide verdict's `phase`
 * signal names that provenance ("Replay @ 207 s · phase") so an operator can see
 * WHY the alternative is offered — a hash match alone reads as the plain label. */
export function clipRailPickerLabel(slide: ClipRailSlide): string {
  const role = slide.kind === "replay" ? "Replay" : "Celebration";
  const base = `${role} @ ${Math.round(slide.start)} s`;
  return slide.phaseCorroborated ? `${base} · phase` : base;
}

/** The badge copy, or `null` when the card has exactly one clip (no badge). */
export function clipRailBadgeLabel(count: number): string | null {
  return count > 1 ? `${count} clips` : null;
}

/**
 * The per-slide identity line. Customer-safe: it names the ROLE of the clip and
 * its own moment range, never the pipeline event type, score or outcome code.
 *
 * ADAAAA-8422 (AC4): on a NOTABLE card the role words change. `Highlight` would
 * assert a confirmed score the window never measured, so a notable moment's own
 * slide reads `Moment` and its siblings read `Clip`. The postable feed keeps the
 * shipped `Highlight` / `Celebration` / `Replay` labels byte-for-byte.
 */
export function clipRailIdentityLabel(slide: ClipRailSlide, notable = false): string {
  if (notable) {
    const role = slide.kind === "sibling" ? "Clip" : "Moment";
    return `${role} · ${momentRangeLabel(slide.start, slide.end)}`;
  }
  const role = slide.kind === "highlight" ? "Highlight" : slide.kind === "replay" ? "Replay" : "Celebration";
  return `${role} · ${momentRangeLabel(slide.start, slide.end)}`;
}

/** ADAAAA-8422 (N1): the read-only option line on a notable card's sibling slide
 * — the same moment, another cut, named by its own window. Never a goal claim. */
export function clipRailOptionLabel(slide: ClipRailSlide): string {
  return `Same moment · ${momentRangeLabel(slide.start, slide.end)}`;
}

/** Clamp a requested slide index into the rail. Out-of-range is a no-op at the
 *  edges (the prev/next buttons stay focusable and never wrap around). */
export function clipRailClampIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(index)));
}

/** The slide the rail is on after a prev/next step (`delta` -1 / +1). */
export function clipRailStepIndex(index: number, delta: number, count: number): number {
  return clipRailClampIndex(index + delta, count);
}

/** Horizontal offset of a slide: every slide occupies the rail's client width. */
export function clipRailScrollLeft(index: number, clientWidth: number): number {
  if (!Number.isFinite(clientWidth) || clientWidth <= 0) return 0;
  return clipRailClampIndex(index, Number.MAX_SAFE_INTEGER) * clientWidth;
}

/** The slide the rail is nearest to after a user scroll (snap settles on one). */
export function clipRailIndexFromScroll(scrollLeft: number, clientWidth: number, count: number): number {
  if (!Number.isFinite(clientWidth) || clientWidth <= 0) return 0;
  return clipRailClampIndex(Math.round(scrollLeft / clientWidth), count);
}

/**
 * Pause every player except the active slide's, so at most one clip plays at a
 * time (AC4). DOM-only, applied on advance and on (touch/wheel/trackpad) scroll.
 */
export function pauseClipRailPlayers(rail: HTMLElement | null, activeIndex: number): void {
  if (!rail) return;
  const slides = Array.from(rail.querySelectorAll<HTMLElement>("[data-detail-clip-slide]"));
  slides.forEach((slide, i) => {
    if (i === activeIndex) return;
    slide.querySelectorAll<HTMLVideoElement>("video").forEach((video) => {
      if (!video.paused) video.pause();
    });
  });
}
