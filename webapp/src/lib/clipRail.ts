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

export type ClipRailSlideKind = "highlight" | "celebration";

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
      kind: "celebration",
      key: `alternative:${a.id}`,
      src: a.clipUri,
      error: a.clipError,
      start: a.start,
      end: a.end,
      eventType: a.eventType,
    });
  }
  return slides;
}

/** The badge copy, or `null` when the card has exactly one clip (no badge). */
export function clipRailBadgeLabel(count: number): string | null {
  return count > 1 ? `${count} clips` : null;
}

/**
 * The per-slide identity line. Customer-safe: it names the ROLE of the clip and
 * its own moment range, never the pipeline event type, score or outcome code.
 */
export function clipRailIdentityLabel(slide: ClipRailSlide): string {
  const role = slide.kind === "highlight" ? "Highlight" : "Celebration";
  return `${role} · ${momentRangeLabel(slide.start, slide.end)}`;
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
