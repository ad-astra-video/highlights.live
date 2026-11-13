/**
 * ADAAAA-8949 (Inc 4): the latest already-extracted analyze frame as a still on
 * the Live Stage no-preview path.
 *
 * For RTMP/WebRTC ingest the stage renders `nopreview` — the platform has no
 * playback route for external sources (`services/media/src/rtc.ts` is
 * ingest-only, no HLS/WHEP) — so Inc 3's score-bug box ([ADAAAA-8886]) had no
 * picture to draw on and the operator never saw the box on an ingested stream.
 * This module supplies the honest substitute: the newest JPEG perceive ALREADY
 * cropped for analysis, fetched from the existing frame route. No new server
 * route, no extraction, no GPU, no inference.
 *
 * Three pure pieces, all measured rather than asserted:
 *
 *   latestLiveFrame(payload)      -> the newest `{seq, uri, timestamp}` the
 *                                    existing `GET /jobs/:id/frames` serves.
 *   frameAge / stale              -> FRESHNESS from the served values only. A
 *                                    still that has stopped advancing must read
 *                                    as stale, never as "live".
 *   LiveStillSource               -> the request lifecycle, with counters, so
 *                                    AC4.1/AC4.7 ("<= 1 image fetch per 5 s
 *                                    poll") is MEASURED by a test against a fake
 *                                    transport instead of asserted in prose.
 *
 * Dependency-free and DOM-free (no React, no fetch) so it is unit-testable in
 * the node vitest environment — this package deliberately has no jsdom.
 */

/** One served frame reference (`GET /jobs/:id/frames` element). */
export interface LiveFrameRef {
  seq: number;
  /** Absolute fetch path; falls back to the canonical route when empty. */
  uri: string;
  /**
   * The frame's CONTENT timestamp as served (seconds from the job's content
   * clock start — the media rail and the analyzer both normalise to that axis).
   * `null` when the served row carries no observation for that seq.
   */
  timestamp: number | null;
}

/** AC4.3: a still whose newest analyzed frame is older than this is stale. */
export const LIVE_FRAME_STALE_SEC = 60;

/** A frame stamp above this is an epoch-second wall clock (defensive: the live
 *  rails serve content-relative seconds today, and `noteBrowserContentTs` in
 *  `services/server/src/api.ts` normalises the same way for the same reason). */
const EPOCH_SEC_FLOOR = 1e9;

/**
 * The newest frame of a served list. Frames are ordered by seq by the route, but
 * the decimation path can drop seqs, so take the max rather than the last row —
 * and ignore a row whose seq is not a finite number instead of guessing.
 */
export function latestLiveFrame(payload: unknown): LiveFrameRef | null {
  const frames = (payload as { frames?: unknown } | null | undefined)?.frames;
  if (!Array.isArray(frames)) return null;
  let best: LiveFrameRef | null = null;
  for (const row of frames) {
    const raw = row as { seq?: unknown; uri?: unknown; timestamp?: unknown } | null;
    const seq = Number(raw?.seq);
    if (!Number.isFinite(seq)) continue;
    const uri = typeof raw?.uri === "string" ? raw.uri : "";
    const ts = Number(raw?.timestamp);
    const timestamp = raw?.timestamp !== null && raw?.timestamp !== undefined && Number.isFinite(ts) ? ts : null;
    const ref: LiveFrameRef = { seq, uri, timestamp };
    if (best === null || seq > best.seq) best = ref;
  }
  return best;
}

/** `startedAt` (the server's content-clock anchor, ADAAAA-7741) in ms; null when
 *  absent or unparseable — never inferred from `createdAt`, which would inflate
 *  the age by the whole provisioning delay. */
export function contentAnchorMs(startedAt: string | null | undefined): number | null {
  if (!startedAt) return null;
  const ms = Date.parse(startedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Wall clock (ms) of the instant the frame's content was captured: the served
 * content timestamp placed on the job's content-clock anchor. An epoch-valued
 * stamp is already absolute. `null` when neither source can be established —
 * the caller then renders "age unknown" instead of a fresh-looking still.
 */
export function frameWallClockMs(timestampSec: number | null, anchorMs: number | null): number | null {
  if (timestampSec === null || !Number.isFinite(timestampSec)) return null;
  if (timestampSec > EPOCH_SEC_FLOOR) return timestampSec * 1000;
  if (anchorMs === null || !Number.isFinite(anchorMs)) return null;
  return anchorMs + timestampSec * 1000;
}

/** AC4.3: age of the still in whole seconds (clamped at 0), `null` when the
 *  frame's wall clock cannot be derived from the served values. */
export function frameAgeSeconds(wallMs: number | null, nowMs: number): number | null {
  if (wallMs === null || !Number.isFinite(wallMs) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.floor((nowMs - wallMs) / 1000));
}

/** AC4.3: stale means "this still has provably stopped advancing". An unknown
 *  age is stale-by-default — it is never presented as fresh. */
export function isFrameStale(ageSec: number | null): boolean {
  return ageSec === null || ageSec > LIVE_FRAME_STALE_SEC;
}

/** `42s ago`, or `age unknown` when the frame has no derivable wall clock. */
export function formatFrameAge(ageSec: number | null): string {
  if (ageSec === null || !Number.isFinite(ageSec)) return "age unknown";
  return `${Math.floor(ageSec)}s ago`;
}

/** `T+1:52.3` — the frame's own content position, exactly as served. */
export function formatContentStamp(timestampSec: number | null): string {
  if (timestampSec === null || !Number.isFinite(timestampSec)) return "T+?";
  const s = Math.max(0, timestampSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(Math.floor(n)).padStart(2, "0");
  const body = `${two(m)}:${two(sec)}.${String(Math.round((sec % 1) * 10)).slice(0, 1)}`;
  return h > 0 ? `T+${h}:${body}` : `T+${body}`;
}

/**
 * AC4.3: the still's whole caption — its own seq, its own served content stamp
 * and its age. One line, no animation and no live-tracking wording: the still is
 * a snapshot, and the sentence says so.
 */
export function frameStillLabel(frame: LiveFrameRef | null, ageSec: number | null): string {
  const seq = frame ? `#${frame.seq}` : "#?";
  return `newest analyzed frame ${seq} · ${formatContentStamp(frame?.timestamp ?? null)} · ${formatFrameAge(ageSec)}`;
}

/** AC4.1: the still exists only on the no-preview stage AND only for a job that
 *  carries a `scoreboardSurface` block. Without the block the hook never builds
 *  a source, so no frame request is ever issued. */
export function shouldPollStill(mode: string | null | undefined, surface: unknown): boolean {
  return mode === "nopreview" && !!surface;
}

export interface LiveStillTransport {
  /** `GET /jobs/:id/frames` (auth required). */
  listFrames(jobId: string): Promise<unknown>;
  /** `authFetchFrame(uri, token)` — a revocable blob object URL. */
  fetchImage(uri: string): Promise<string>;
}

export interface LiveStillSnapshot {
  frame: LiveFrameRef | null;
  /** Object URL of the still, or the previous one while a new fetch is failing. */
  url: string | null;
  /** Set when a request failed; the caption keeps the last honest frame. */
  error: string | null;
}

/**
 * The still's request lifecycle: ONE list request per poll (the page's existing
 * 5 s detail poll drives it), and an image request ONLY when the newest seq
 * changed. `counts` exists so a test can measure that instead of trusting a
 * comment.
 *
 * The source deliberately does not own revocation: the component revokes the
 * previous object URL from the effect cleanup that React runs after the new
 * `<img src>` has committed, so a swap never blanks the visible still.
 */
export class LiveStillSource {
  private loadedSeq: number | null = null;
  private url: string | null = null;
  private listRequests = 0;
  private imageRequests = 0;

  constructor(private readonly transport: LiveStillTransport) {}

  /** Measured request counters (AC4.1 / AC4.7). */
  get counts(): { listRequests: number; imageRequests: number } {
    return { listRequests: this.listRequests, imageRequests: this.imageRequests };
  }

  /** Forget the cached image (stage left the no-preview state): the next poll
   *  re-fetches the frame it finds. */
  reset(): void {
    this.loadedSeq = null;
    this.url = null;
  }

  async poll(jobId: string): Promise<LiveStillSnapshot> {
    this.listRequests += 1;
    let payload: unknown;
    try {
      payload = await this.transport.listFrames(jobId);
    } catch (e: unknown) {
      return { frame: null, url: this.url, error: errorText(e) };
    }

    const frame = latestLiveFrame(payload);
    // No extracted frame yet (the job's frame dir does not exist or the writer
    // has not landed one): an honest empty, not a placeholder picture.
    if (!frame) return { frame: null, url: this.url, error: null };

    if (frame.seq !== this.loadedSeq) {
      const uri = frame.uri.length > 0 ? frame.uri : `/jobs/${jobId}/frames/${frame.seq}`;
      this.imageRequests += 1;
      try {
        this.url = await this.transport.fetchImage(uri);
        this.loadedSeq = frame.seq;
      } catch (e: unknown) {
        return { frame, url: this.url, error: errorText(e) };
      }
    }
    return { frame, url: this.url, error: null };
  }
}

export function createLiveStillSource(transport: LiveStillTransport): LiveStillSource {
  return new LiveStillSource(transport);
}

function errorText(e: unknown): string {
  const anyE = e as { message?: unknown; status?: unknown } | null;
  const msg = typeof anyE?.message === "string" ? anyE.message : String(e);
  return msg.length > 0 ? msg : "frame request failed";
}
