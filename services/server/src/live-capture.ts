// ADAAAA-7750: WHY a live job has no analysis windows, as a customer-readable
// projection.
//
// The board reported a live screen share with "no windows processed" and the
// page said only `No analysis windows for this job.` — the same string a share
// that started ten seconds ago renders, and the same string a share whose
// browser never reached the media node renders. Three completely different
// situations, one output, so the report could not be attributed by the person
// who filed it (and the first attribution attempt blamed a media-node outage
// that was not happening — see the ADAAAA-7750 comment).
//
// This module derives, at READ time from data already stored, which of those
// situations the job is in:
//
//   - `connecting`            in-flight, no frames yet, media session live
//   - `waiting_first_window`  frames arriving, no decided window yet
//   - `capturing`             windows decided, none confirmed as a highlight
//   - `interrupted`           in-flight, no frames, and no live media session
//   - `no_capture`            terminal, zero frames ever captured
//   - `no_highlights`         terminal, frames analysed, nothing confirmed
//
// Zero decide calls, zero GPU seconds, no stored-data mutation, no change to
// window semantics, tracking limits or the live/VOD latency split. It carries
// only counters the customer already sees (frames, windows, highlights) plus
// copy; it never re-exports `observeMetrics`, `decideCalls` or `costUsd`.

import type { Job } from "@highlights/events";

/** Content seconds the live rail is allowed before the FIRST analysis window
 * is expected. Mirrors `LIVE_OBSERVE_LAG_BUDGET_S` in observe-loop.ts (the
 * READ path has no AnalyzerConfig at hand, same convention as live-progress.ts). */
export const LIVE_CAPTURE_FIRST_WINDOW_BUDGET_S = 30;

/** An in-flight share with no frames for this long and no live media session is
 * not "still connecting" — the capture surface is gone. 15 s is half the
 * first-window budget: long enough that a cold WebRTC offer (ICE + DTLS, ~2-5 s
 * measured on the box) never reads as a failure. */
export const LIVE_CAPTURE_STALE_S = 15;

/** Sources whose frames arrive in real time (same set live-progress.ts uses). */
const LIVE_SOURCES = new Set(["rtmp", "screen", "file-sim", "browser", "webrtc", "screenshare"]);

const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

export type LiveCaptureState =
  | "connecting"
  | "waiting_first_window"
  | "capturing"
  | "interrupted"
  | "no_capture"
  | "no_highlights"
  | "unknown";

/** Customer-safe cause + next action for a zero-window job. */
export interface LiveCapture {
  state: LiveCaptureState;
  /** Frames the rail analysed (persisted observations floor). */
  frames: number;
  /** Analysis windows decided so far (`summaryLog` entries). */
  windows: number;
  /** Postable highlights confirmed so far. */
  highlights: number;
  /** Seconds until the first window is due, when the rail is healthy. Only set
   * on `connecting` / `waiting_first_window`; never a fabricated lag reading. */
  firstWindowInS: number | null;
  /** One sentence naming the situation; `null` when there is nothing to say. */
  cause: string | null;
  /** One sentence naming the retry/next action; `null` when none is needed. */
  action: string | null;
  /** Wall clock this projection was derived at. */
  updatedAt: string;
}

export interface LiveCaptureInput {
  job: Partial<
    Pick<
      Job,
      | "status"
      | "source"
      | "createdAt"
      | "startedAt"
      | "finishedAt"
      | "completedAt"
      | "framesAnalyzed"
      | "framesTotal"
      | "summaryLog"
    >
  >;
  /** Persisted observations for the job (the frames the rail actually took). */
  observationCount?: number;
  /** Postable highlights stored for the job (0 = the window list is empty). */
  highlightCount?: number;
  /** True while the job still holds an `active` media_sessions row, i.e. a
   * media node is carrying (or about to carry) this share. */
  hasLiveMediaSession?: boolean;
  /** Injected reference time (ms) so the derivation is unit-testable. */
  nowMs?: number;
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseMs(v?: string | null): number | null {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function framesFor(input: LiveCaptureInput): number {
  const analysed = finiteNumber(input.job.framesAnalyzed);
  const total = finiteNumber(input.job.framesTotal);
  const observed = finiteNumber(input.observationCount) ?? 0;
  return Math.max(0, Math.round(Math.max(analysed ?? 0, total ?? 0, observed)));
}

/** Count of DECIDED windows, from the append-only summary log. */
function windowsFor(input: LiveCaptureInput): number {
  return (input.job.summaryLog ?? []).filter((e) => finiteNumber((e as { windowTs?: number })?.windowTs) !== null).length;
}

/**
 * Derive the capture projection. Pure: every input is passed in, including the
 * clock, so the unit test pins the exact copy and thresholds.
 *
 * The ordering matters: a job WITH windows never gets a capture notice (the
 * window list is the answer), and a job that is still connecting is never
 * reported as interrupted inside the staleness grace window.
 */
export function deriveLiveCapture(input: LiveCaptureInput): LiveCapture {
  const job = input.job ?? {};
  const nowMs = finiteNumber(input.nowMs) ?? Date.now();
  const frames = framesFor(input);
  const windows = windowsFor(input);
  const highlights = Math.max(0, Math.round(finiteNumber(input.highlightCount) ?? 0));
  const terminal = TERMINAL_STATUSES.has(String(job.status ?? ""));
  const live = LIVE_SOURCES.has(String(job.source ?? ""));
  const hasSession = input.hasLiveMediaSession === true;
  const anchorMs = parseMs(job.startedAt) ?? parseMs(job.createdAt);
  const ageS = anchorMs === null ? 0 : Math.max(0, (nowMs - anchorMs) / 1000);

  const base = { frames, windows, highlights, firstWindowInS: null, cause: null, action: null };

  // Not a live rail, or there is already a confirmed highlight: nothing to
  // explain, and a notice would be noise.
  if (!live || highlights > 0) {
    return { ...base, state: "unknown", updatedAt: new Date(nowMs).toISOString() };
  }

  if (terminal) {
    if (frames === 0) {
      return {
        ...base,
        state: "no_capture",
        cause: "No frames were captured for this job, so there was nothing to analyse.",
        action: "Start the share again to record a new run.",
        updatedAt: new Date(nowMs).toISOString(),
      };
    }
    const inWindows = windows > 0 ? ` across ${windows} window${windows === 1 ? "" : "s"}` : "";
    return {
      ...base,
      state: "no_highlights",
      cause: `The run analysed ${frames} frame${frames === 1 ? "" : "s"}${inWindows} and no highlight was confirmed.`,
      action: "Share again if you expected a highlight in that stretch.",
      updatedAt: new Date(nowMs).toISOString(),
    };
  }

  if (frames === 0) {
    if (ageS < LIVE_CAPTURE_STALE_S) {
      return {
        ...base,
        state: "connecting",
        firstWindowInS: LIVE_CAPTURE_FIRST_WINDOW_BUDGET_S,
        cause: "Connecting this share to the analysis node.",
        updatedAt: new Date(nowMs).toISOString(),
      };
    }
    // Past the grace window with zero frames the capture surface is not
    // delivering, whether or not the `media_sessions` row still reads `active`
    // (the row is written at provision and only cleared when the job ends, so it
    // cannot be trusted as liveness on its own). Name the shape honestly.
    return {
      ...base,
      state: "interrupted",
      cause: hasSession
        ? "Capture is connected but no frames are arriving from this share."
        : "Capture interrupted - no frames are arriving from this share.",
      action: "Stop the share and start it again.",
      updatedAt: new Date(nowMs).toISOString(),
    };
  }

  if (windows === 0) {
    const remaining = Math.max(0, Math.ceil(LIVE_CAPTURE_FIRST_WINDOW_BUDGET_S - ageS));
    return {
      ...base,
      state: "waiting_first_window",
      firstWindowInS: remaining,
      cause:
        remaining > 0
          ? `Frames are arriving; the first analysis window is about ${remaining} s behind.`
          : "Frames are arriving; the first analysis window is due now.",
      updatedAt: new Date(nowMs).toISOString(),
    };
  }

  return {
    ...base,
    state: "capturing",
    cause: `Frames are arriving (${frames} analysed) and ${windows} window${windows === 1 ? "" : "s"} decided so far; no highlight is confirmed yet.`,
    updatedAt: new Date(nowMs).toISOString(),
  };
}
