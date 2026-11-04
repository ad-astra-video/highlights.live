// Live stage state for the job detail page (ADAAAA-7976, PO spec ADAAAA-7973).
//
// When a live stream starts the web app navigates to `/app/jobs/<id>` and that
// page renders a live stage ABOVE the match summary: the playing browser-capture
// video, the job's real status + elapsed + the existing lag readout, and one
// Stop & finalize button. RTMP/WebRTC ingest has no playback surface anywhere in
// the platform (services/media/src/rtc.ts is ingest-only and there is no
// HLS/WHEP route), so those sources get the SAME stage slot with an explicit
// no-preview note instead of a faked poster or a dead <video>.
//
// This module is deliberately dependency-free and DOM-free: the stage state
// machine is unit-testable in the node vitest environment (this package has no
// jsdom) and the markup is pinned separately with react-dom/server.

/** Sources that get a live stage on the detail page. `file` (VOD) never does. */
export const LIVE_STAGE_SOURCES = ["browser", "screenshare", "screen", "rtmp", "webrtc", "file-sim"] as const;

export function isLiveStageSource(source: string | null | undefined): boolean {
  return !!source && (LIVE_STAGE_SOURCES as readonly string[]).includes(source);
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

export function isLiveJobStatus(status: string | null | undefined): boolean {
  return !!status && !TERMINAL.has(status);
}

export type LiveStageMode = "video" | "nopreview" | "stopped";

/** Why the stage has no local video (only meaningful when mode = nopreview). */
export type NoPreviewReason = "external" | "local-capture-absent";

export interface LiveStageView {
  mode: LiveStageMode;
  /** The job is still running server-side, so Stop is a real action. */
  inFlight: boolean;
  showVideo: boolean;
  showNoPreview: boolean;
  /** Stop & finalize is offered only while the job is in flight. */
  canStop: boolean;
  /** Uppercase job status for the status line (e.g. `LIVE`, `DONE`). */
  statusLabel: string;
  /** `m:ss` (or `h:mm:ss`) elapsed label; `—` when the start time is unknown. */
  elapsedLabel: string;
  noPreviewReason: NoPreviewReason | null;
}

export interface LiveStageInput {
  jobStatus?: string | null;
  jobSource?: string | null;
  /** ISO timestamps from the job row. */
  createdAt?: string | null;
  completedAt?: string | null;
  /** True only when THIS page's capture session owns this job and has a stream. */
  ownsCapture?: boolean;
  hasCaptureStream?: boolean;
  /** The user already stopped/finalized this stage in this page session. */
  stopped?: boolean;
  /** Wall clock (ms) used for the elapsed readout; injected so it is testable. */
  now: number;
}

/** Seconds since the job started (clamped at 0; null when unparseable). */
export function elapsedSeconds(startedAt: string | null | undefined, at: number): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((at - start) / 1000));
}

/** `m:ss` for < 1 h, `h:mm:ss` above it, `—` for an unknown elapsed time. */
export function formatElapsed(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/**
 * Decide what the live stage renders for one read of the job row.
 *
 * - terminal (done/failed/cancelled) or already stopped -> `stopped`: no video,
 *   no Stop, honest final state.
 * - in flight and this page's capture session owns the job with a live stream ->
 *   `video`.
 * - in flight with no local stream (RTMP/WebRTC ingest, or a browser capture
 *   that a reload detached) -> `nopreview` + an explicit reason. Never a fake
 *   poster and never a dead <video>.
 */
export function liveStageView(input: LiveStageInput): LiveStageView {
  const status = input.jobStatus || "";
  const inFlight = isLiveJobStatus(status);
  const stopped = input.stopped === true || !inFlight;
  const elapsedLabel = formatElapsed(
    elapsedSeconds(input.createdAt, input.completedAt ? Date.parse(input.completedAt) : input.now),
  );
  const statusLabel = status ? status.toUpperCase() : "UNKNOWN";

  if (stopped) {
    return {
      mode: "stopped",
      inFlight: false,
      showVideo: false,
      showNoPreview: false,
      canStop: false,
      statusLabel,
      elapsedLabel,
      noPreviewReason: null,
    };
  }

  const owns = input.ownsCapture === true && input.hasCaptureStream === true;
  if (owns) {
    return {
      mode: "video",
      inFlight: true,
      showVideo: true,
      showNoPreview: false,
      canStop: true,
      statusLabel,
      elapsedLabel,
      noPreviewReason: null,
    };
  }

  const external = input.jobSource === "rtmp" || input.jobSource === "webrtc";
  return {
    mode: "nopreview",
    inFlight: true,
    showVideo: false,
    showNoPreview: true,
    canStop: true,
    statusLabel,
    elapsedLabel,
    noPreviewReason: external ? "external" : "local-capture-absent",
  };
}

/** Plain-language no-preview copy; states the limitation, never fakes a frame. */
export function noPreviewText(reason: NoPreviewReason | null, source?: string | null): string {
  if (reason === "external") {
    const kind = source === "webrtc" ? "WebRTC" : "RTMP";
    return `No local preview for ${kind} ingest — the stream is analyzed on the media server, which has no playback route for external sources. Stop & finalize still closes the job.`;
  }
  return "No local preview for this capture — the screen share lives in the browser tab that started it, so this page cannot show it after a reload or from another tab. Stop & finalize still closes the job.";
}
