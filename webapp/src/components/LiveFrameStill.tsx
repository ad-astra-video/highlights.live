/**
 * ADAAAA-8949 (Inc 4): the latest analyze frame as a still, with the Inc 3
 * score-bug box drawn over it — the no-preview Live Stage path.
 *
 * RTMP/WebRTC ingest renders `nopreview` because the platform has no playback
 * route for external sources, so Inc 3's box ([ADAAAA-8886]) only had a picture
 * in the tab that owns a browser capture. This draws the same box on the newest
 * JPEG perceive ALREADY cropped for analysis, fetched from the existing
 * `/jobs/:id/frames` route: no new route, no extraction, no GPU, no inference.
 *
 * DISPLAY ONLY, exactly like Inc 3: no click-to-draw, no drag, no write of
 * `scoreboardRoi`. The image and the box are `pointer-events-none` +
 * `aria-hidden`; the textual `ScoreboardSurfaceReadout` chip stays the
 * accessible path.
 *
 * The box is mapped through the IMAGE's content rect (`contentRect`), never a
 * percentage of the stage: an `<img>` with `object-contain` letterboxes a 4:3
 * frame inside the stage's `aspect-video` box, so a container-percentage box is
 * wrong by the bar width (AC4.2). The mapper is the Inc 3 one, unchanged.
 *
 * Freshness is stated, never implied (AC4.3): the caption carries the frame's
 * own seq, its own served content stamp and its age, and an age over 60 s (or an
 * underivable one) renders as `stale`. No animation, no spinner, no
 * "tracking" wording — the still is a snapshot and it says so.
 */
import { useRef } from "react";
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
import {
  formatContentStamp,
  formatFrameAge,
  frameAgeSeconds,
  frameStillLabel,
  frameWallClockMs,
  isFrameStale,
  type LiveFrameRef,
} from "../lib/liveFrameStill";
import { useContentGeometry, type ContentGeometry } from "../lib/useContentGeometry";

export interface LiveFrameStillProps {
  surface: ScoreboardSurface;
  frame: LiveFrameRef | null;
  /** Object URL of the still (`authFetchFrame`); null until the fetch resolves. */
  imgSrc: string | null;
  /** Wall clock anchor of the job's content clock (`job.startedAt`) in ms. */
  anchorMs: number | null;
  /** Wall clock for the age readout; the stage already ticks this once a second. */
  nowMs: number;
  /** Why the still is missing, when a request failed (honest, no fake poster). */
  error?: string | null;
}

const STILL_IMG = "absolute inset-0 h-full w-full rounded-lg bg-black object-contain pointer-events-none";

/**
 * Pure half: renders the still and the box at EXPLICIT geometry, so react-dom/
 * server can pin both the 1-image/1-box contract and the edge arithmetic at
 * 16:9 / 4:3 / 2.4:1 stages (AC4.1, AC4.2). `geometry: null` is the honest
 * pre-measurement state — the image ships, the box does not (Inc 3's rule).
 */
export function LiveFrameStillView({
  surface,
  frame,
  imgSrc,
  anchorMs,
  nowMs,
  geometry,
  error = null,
  imgRef,
}: LiveFrameStillProps & {
  geometry: ContentGeometry | null;
  imgRef?: React.RefObject<HTMLImageElement>;
}) {
  const ageSec = frame
    ? frameAgeSeconds(frameWallClockMs(frame.timestamp, anchorMs), nowMs)
    : null;
  const stale = isFrameStale(ageSec);
  const rect: Rect | null = geometry
    ? contentRect(geometry.stageW, geometry.stageH, geometry.elW, geometry.elH)
    : null;
  // No picture, no box: the box points at the crop region of THIS still, so it
  // ships only once the image exists (an orphan box over an empty slot would be
  // a pin with nothing under it).
  const box = imgSrc ? overlayBox(rect, surface.roi) : null;

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      aria-hidden="true"
      data-live-stage-frame-still-layer
      data-live-stage-frame-still-seq={frame ? String(frame.seq) : ""}
      data-live-stage-frame-still-stamp={frame ? formatContentStamp(frame.timestamp) : ""}
      data-live-stage-frame-still-age={formatFrameAge(ageSec)}
      // AC4.3: stale is a MARKER, not only styling — a test (and QA) can read it.
      data-live-stage-frame-still-stale={stale ? "true" : "false"}
      data-live-stage-frame-still-content-rect={formatContentRect(rect)}
    >
      <img
        ref={imgRef}
        src={imgSrc ?? undefined}
        alt=""
        aria-hidden="true"
        data-live-stage-frame-still-img
        data-live-stage-frame-still-pending={imgSrc ? "false" : "true"}
        className={STILL_IMG}
      />

      {box ? (
        <div
          className={`absolute border-2 ${overlayBoxClass(surface.source)}`}
          data-live-stage-frame-still-box="true"
          data-live-stage-frame-still-box-px={formatOverlayBox(box)}
          data-scoreboard-overlay="frame-still"
          data-scoreboard-overlay-source={surface.source}
          data-scoreboard-overlay-roi={overlayRoiText(surface)}
          data-scoreboard-overlay-verified={surface.verified ? "true" : "false"}
          data-scoreboard-overlay-identity={surface.identity?.verdict ?? "none"}
          data-scoreboard-overlay-prior={surface.source === "default_top_band" ? "true" : "false"}
          title={overlayLabel(surface)}
          // Inline style is the computed box geometry only — the same shape Inc 3
          // uses on the video.
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        >
          <span
            className={`absolute left-1 top-1 whitespace-nowrap rounded-full bg-void/80 px-2 py-0.5 text-xs font-bold ${overlayLabelClass(surface.source)}`}
            data-live-stage-frame-still-label
          >
            {/* AC4.4: the Inc 3 provenance phrase (never "pinned" for a prior). */}
            {overlayLabel(surface)}
          </span>
        </div>
      ) : null}

      <span
        className={`absolute bottom-1 left-1 whitespace-nowrap rounded-full bg-void/80 px-2 py-0.5 font-mono text-xs ${stale ? "text-yellow" : "text-mut"}`}
        data-live-stage-frame-still-caption
      >
        {frameStillLabel(frame, ageSec)}
        {stale ? <span data-live-stage-frame-still-stale-label> · stale</span> : null}
      </span>

      {!frame && (
        <span
          className="absolute inset-x-1 top-1/2 -translate-y-1/2 text-center text-sm text-mut"
          data-live-stage-frame-still-empty
        >
          {error
            ? `The newest analyzed frame could not be read (${error}) — no still to overlay.`
            : "No analyzed frame yet — the still appears when perceive crops its first frame."}
        </span>
      )}
    </div>
  );
}

/**
 * Container half: measures the rendered `<img>` box and the picture's intrinsic
 * size, then hands both to the pure view. `object-contain` on the image IS the
 * letterboxing the mapper compensates for, so the measured element is the
 * `<img>` itself: its border box is the picture's containing block.
 */
export function LiveFrameStill(props: LiveFrameStillProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const geometry = useContentGeometry(
    imgRef,
    !!props.imgSrc,
    (el) => ({ w: el.naturalWidth, h: el.naturalHeight }),
    ["load"],
  );
  return <LiveFrameStillView {...props} geometry={geometry} imgRef={imgRef} />;
}
