/**
 * ADAAAA-8949 (Inc 4) + ADAAAA-8970 (Inc 2): the latest analyze frame as a
 * still, with the Inc 3 score-bug box drawn over it — the no-preview Live Stage
 * path — and ONE degrade contract for the states where the happy path does not
 * hold.
 *
 * RTMP/WebRTC ingest renders `nopreview` because the platform has no playback
 * route for external sources, so Inc 3's box ([ADAAAA-8886]) only had a picture
 * in the tab that owns a browser capture. This draws the same box on the newest
 * JPEG perceive ALREADY cropped for analysis, fetched from the existing
 * `/jobs/:id/frames` route: no new route, no extraction, no GPU, no inference.
 *
 * The four states, and what each renders (one policy, no new fetch path):
 *
 *   (no surface) - this component is not mounted at all: 0 `<img>`, 0 box.
 *   waiting      - surface present, no frame extracted yet: a NAMED waiting
 *                  state, text only, `aria-hidden` false so it is announced.
 *   refused      - a frame read failed (401/403 or transport): a NAMED refusal
 *                  state that says the frame could not be read, distinct from
 *                  "no frames yet", and no `<img>` (an auth-refused still is
 *                  dropped, not re-shown).
 *   ready        - 1 `<img>`, 1 box once measured, labelled with the frame's own
 *                  seq/stamp/age; over 60 s (or an underivable age) reads stale.
 *
 * DISPLAY ONLY, exactly like Inc 3: no click-to-draw, no drag, no write of
 * `scoreboardRoi`. The image and the box are `pointer-events-none` +
 * `aria-hidden`; the textual `ScoreboardSurfaceReadout` chip stays the
 * accessible path, and the two degrade notices live OUTSIDE that hidden layer
 * so a screen reader hears them.
 *
 * The box is mapped through the IMAGE's content rect (`contentRect`), never a
 * percentage of the stage: an `<img>` with `object-contain` letterboxes a 4:3
 * frame inside the stage's `aspect-video` box, so a container-percentage box is
 * wrong by the bar width (AC4.2). The mapper is the Inc 3 one, unchanged.
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
  STILL_WAITING_TEXT,
  formatContentStamp,
  formatFrameAge,
  frameAgeSeconds,
  frameErrorStatus,
  frameStillLabel,
  frameWallClockMs,
  isFrameStale,
  isAuthRefusal,
  stillRefusalText,
  type LiveFrameRef,
  type LiveStillRefusal,
  type LiveStillStateKind,
} from "../lib/liveFrameStill";
import { useContentGeometry, type ContentGeometry } from "../lib/useContentGeometry";

export interface LiveFrameStillProps {
  surface: ScoreboardSurface;
  /** The frame whose bytes are on screen (null unless `state` is `ready`). */
  frame: LiveFrameRef | null;
  /** Object URL of the still (`authFetchFrame`); null until the fetch resolves. */
  imgSrc: string | null;
  /** Wall clock anchor of the job's content clock (`job.startedAt`) in ms. */
  anchorMs: number | null;
  /** Wall clock for the age readout; the stage already ticks this once a second. */
  nowMs: number;
  /** Why the still is missing, when a request failed (honest, no fake poster). */
  error?: string | null;
  /** ADAAAA-8970: which degrade state the source reported. Derived from the
   *  props when omitted so a caller cannot silently render the wrong one. */
  state?: LiveStillStateKind;
  /** ADAAAA-8970: `auth` (401/403) vs `transport` for the refusal copy. */
  refusal?: LiveStillRefusal;
}

const STILL_IMG = "absolute inset-0 h-full w-full rounded-lg bg-black object-contain pointer-events-none";
const STILL_NOTICE =
  "absolute inset-x-4 top-1/2 -translate-y-1/2 text-center text-sm text-mut pointer-events-none";

/** The state implied by the props when the caller did not pass one. */
export function deriveStillState(imgSrc: string | null, error: string | null): LiveStillStateKind {
  if (imgSrc) return "ready";
  return error ? "refused" : "waiting";
}

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
  state,
  refusal,
  imgRef,
}: LiveFrameStillProps & {
  geometry: ContentGeometry | null;
  imgRef?: React.RefObject<HTMLImageElement>;
}) {
  const kind = state ?? deriveStillState(imgSrc, error);
  // An auth refusal is named even when the caller only handed us the error text
  // (the transport throws a plain `Error` with `HTTP 401` in its message).
  const why: LiveStillRefusal =
    refusal ?? (kind === "refused" ? (isAuthRefusal(frameErrorStatus(error)) ? "auth" : "transport") : null);
  const shown = imgSrc !== null;
  const ageSec = frame ? frameAgeSeconds(frameWallClockMs(frame.timestamp, anchorMs), nowMs) : null;
  const stale = isFrameStale(ageSec);
  const rect: Rect | null = geometry
    ? contentRect(geometry.stageW, geometry.stageH, geometry.elW, geometry.elH)
    : null;
  // No picture, no box: the box points at the crop region of THIS still, so it
  // ships only once the image exists (an orphan box over an empty slot would be
  // a pin with nothing under it). Same rule for the caption: a "#seq · age"
  // caption with no bytes behind it would claim a still that is not on screen.
  const box = shown ? overlayBox(rect, surface.roi) : null;

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      data-live-stage-frame-still-slot
      // ADAAAA-8970: the state is a MARKER, so the matrix is readable from the
      // served DOM (and by QA) instead of inferred from styling.
      data-live-stage-frame-still-state={kind}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden="true"
        data-live-stage-frame-still-layer
        data-live-stage-frame-still-seq={shown && frame ? String(frame.seq) : ""}
        data-live-stage-frame-still-stamp={shown && frame ? formatContentStamp(frame.timestamp) : ""}
        data-live-stage-frame-still-age={formatFrameAge(ageSec)}
        // AC4.3: stale is a MARKER, not only styling — a test (and QA) can read it.
        data-live-stage-frame-still-stale={stale ? "true" : "false"}
        data-live-stage-frame-still-content-rect={formatContentRect(rect)}
      >
        {/* 0 `<img>` in every degrade state: no element, not an empty `src`. */}
        {shown && (
          <img
            ref={imgRef}
            src={imgSrc ?? undefined}
            alt=""
            aria-hidden="true"
            data-live-stage-frame-still-img
            className={STILL_IMG}
          />
        )}

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

        {shown && frame && (
          <span
            className={`absolute bottom-1 left-1 whitespace-nowrap rounded-full bg-void/80 px-2 py-0.5 font-mono text-xs ${stale ? "text-yellow" : "text-mut"}`}
            data-live-stage-frame-still-caption
          >
            {frameStillLabel(frame, ageSec)}
            {stale ? <span data-live-stage-frame-still-stale-label> · stale</span> : null}
          </span>
        )}
      </div>

      {/* ADAAAA-8970: the degrade states are ANNOUNCED (`aria-hidden` false, so
          they sit outside the display-only layer above), and each carries its own
          marker: "waiting for a first frame" is not "the frame could not be
          read". */}
      {kind === "waiting" && (
        <span
          className={STILL_NOTICE}
          role="status"
          aria-hidden="false"
          data-live-stage-frame-still-waiting="true"
          data-live-stage-frame-still-empty
        >
          {STILL_WAITING_TEXT}
        </span>
      )}

      {kind === "refused" && (
        <span
          className={STILL_NOTICE}
          role="status"
          aria-hidden="false"
          data-live-stage-frame-still-refused="true"
          data-live-stage-frame-still-refusal={why ?? "transport"}
        >
          {stillRefusalText(why, error)}
        </span>
      )}
    </div>
  );
}

/**
 * Container half: measures the rendered `<img>` box and the picture's intrinsic
 * size, then hands both to the pure view. `object-contain` on the image IS the
 * letterboxing the mapper compensates for, so the measured element is the
 * `<img>` itself: its border box is the picture's containing block. With no
 * picture (waiting/refused) the ref is empty and the hook stays inert.
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
