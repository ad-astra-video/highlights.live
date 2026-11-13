/**
 * ADAAAA-8886 (Inc 3): the score-bug box, drawn over the Live Stage video.
 *
 * Inc 1 ([ADAAAA-8835](/ADAAAA/issues/ADAAAA-8835)) serves `scoreboardSurface`
 * on job detail and Inc 2 ([ADAAAA-8844](/ADAAAA/issues/ADAAAA-8844)) adds the
 * identity verdict, but the operator still reads four normalized numbers in a
 * chip and maps them onto a video in their head. This is the visibility half:
 * the box the scoreboard OCR actually cropped, on the picture it was cropped
 * from.
 *
 * DISPLAY ONLY. No click-to-draw, no drag, no write of `scoreboardRoi`. The
 * overlay is `aria-hidden` and `pointer-events-none`: it never intercepts the
 * video, the status line, the lag/position chips or Stop, and the textual
 * `ScoreboardSurfaceReadout` stays the accessible path.
 *
 * The box is mapped through the video CONTENT rect (`contentRect` in
 * `lib/scoreboardOverlay.ts`), never a percentage of the stage container: the
 * stage is a fixed `aspect-video` box, so a 4:3 share is letterboxed and a
 * container-percentage box is wrong by the bar width.
 *
 * No fetch, no interval: the block arrives on the existing 5 s job-detail poll
 * (`VOD_DETAIL_POLL_MS`) that already drives this page.
 */
import type { ScoreboardSurface } from "../lib/scoreboardSurface";
import {
  contentRect,
  formatContentRect,
  formatOverlayBox,
  overlayBox,
  overlayBoxClass,
  overlayLabel,
  overlayLabelClass,
  overlayRoiText,
  type Rect,
} from "../lib/scoreboardOverlay";
import { useContentGeometry } from "../lib/useContentGeometry";

export interface ScoreboardOverlayProps {
  surface?: ScoreboardSurface;
  /** The stage is showing THIS tab's stream in `video` mode. */
  enabled: boolean;
  videoRef: React.RefObject<HTMLVideoElement>;
}

export function ScoreboardOverlay({ surface, enabled, videoRef }: ScoreboardOverlayProps) {
  const active = enabled && !!surface;
  // Rendered stage size + the stream's intrinsic size, re-read on resize and on
  // `loadedmetadata`/`resize` (the stream's dimensions are only known once the
  // first frame decodes, and can change when a share changes resolution).
  // ADAAAA-8949: the measuring hook moved to `lib/useContentGeometry.ts` so the
  // no-preview still maps its `<img>` through the SAME content-rect rule.
  const geom = useContentGeometry(
    videoRef,
    active,
    (v) => ({ w: v.videoWidth, h: v.videoHeight }),
    ["loadedmetadata", "resize"],
  );

  // AC3.1 / AC3.7: no block (or no video stage) renders NO overlay node at all —
  // never a default or guessed box. AC3.1 also means no box before the stream's
  // intrinsic size is known: `contentRect` returns null and only the wrapper ships.
  if (!surface || !enabled) return null;

  const rect: Rect | null = geom ? contentRect(geom.stageW, geom.stageH, geom.elW, geom.elH) : null;
  const box = overlayBox(rect, surface.roi);

  return (
    <div
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
      data-scoreboard-overlay="stage"
      data-scoreboard-overlay-source={surface.source}
      data-scoreboard-overlay-roi={overlayRoiText(surface)}
      data-scoreboard-overlay-verified={surface.verified ? "true" : "false"}
      data-scoreboard-overlay-identity={surface.identity?.verdict ?? "none"}
      data-scoreboard-overlay-seq-first-seen={String(surface.seqFirstSeen)}
      data-scoreboard-overlay-content-rect={formatContentRect(rect)}
      // AC3.4: a prior is flagged as such in the markup, not only in the visual
      // style, so a test (and QA) can tell it from a pin without reading pixels.
      data-scoreboard-overlay-prior={surface.source === "default_top_band" ? "true" : "false"}
      title={overlayLabel(surface)}
    >
      {box ? (
        <div
          className={`absolute border-2 ${overlayBoxClass(surface.source)}`}
          data-scoreboard-overlay-box="true"
          data-scoreboard-overlay-box-px={formatOverlayBox(box)}
          // Inline style is the computed box geometry only (AC3.4 / scope 5).
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        >
          <span
            className={`absolute left-1 top-1 whitespace-nowrap rounded-full bg-void/80 px-2 py-0.5 text-xs font-bold ${overlayLabelClass(surface.source)}`}
            data-scoreboard-overlay-label
          >
            {overlayLabel(surface)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
