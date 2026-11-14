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
 * ADAAAA-8973 (Inc 5): every servable frame row in a `GET /jobs/:id/frames`
 * payload (shape unchanged: `{seq, uri, timestamp}`), skipping a row whose seq
 * is not a finite number instead of guessing. `LiveStillSource` MERGES these
 * rows across polls (an incremental poll serves only the newer ones), and
 * `latestLiveFrame` takes the max of them.
 */
export function servedFrameRows(payload: unknown): LiveFrameRef[] {
  const frames = (payload as { frames?: unknown } | null | undefined)?.frames;
  if (!Array.isArray(frames)) return [];
  const out: LiveFrameRef[] = [];
  for (const row of frames) {
    const raw = row as { seq?: unknown; uri?: unknown; timestamp?: unknown } | null;
    const seq = Number(raw?.seq);
    if (!Number.isFinite(seq)) continue;
    const uri = typeof raw?.uri === "string" ? raw.uri : "";
    const ts = Number(raw?.timestamp);
    const timestamp = raw?.timestamp !== null && raw?.timestamp !== undefined && Number.isFinite(ts) ? ts : null;
    out.push({ seq, uri, timestamp });
  }
  return out;
}

/**
 * The newest frame of a served list. Frames are ordered by seq by the route, but
 * the decimation path can drop seqs, so take the max rather than the last row —
 * and ignore a row whose seq is not a finite number instead of guessing.
 */
export function latestLiveFrame(payload: unknown): LiveFrameRef | null {
  let best: LiveFrameRef | null = null;
  for (const ref of servedFrameRows(payload)) {
    if (best === null || ref.seq > best.seq) best = ref;
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

/**
 * ADAAAA-8970 (Inc 2): the four states this slot can be in, one policy.
 *
 *   inert    - there is no `scoreboardSurface` block: the hook never builds a
 *              source, so 0 frame requests, 0 overlay nodes, 0 `<img>`.
 *   waiting  - the block exists but perceive has not cropped a frame yet
 *              (route answers `{frames: []}` or 404): a NAMED waiting state,
 *              text only, at most one list read per poll, 0 `<img>`.
 *   refused  - a frame read failed (401/403 for this token, or any other
 *              transport failure): a NAMED refusal state, distinct from
 *              "no frames yet", and the client does NOT fall back to a still it
 *              already dropped nor loop the auth fetch.
 *   ready    - there is a picture: 1 `<img>`, 1 box once measured, and the
 *              frame's own seq/stamp/age (stale past 60 s).
 */
export type LiveStillStateKind = "waiting" | "refused" | "ready";
/** Why a still could not be shown: the token was refused, or the read failed. */
export type LiveStillRefusal = "auth" | "transport" | null;

export interface LiveStillTransport {
  /**
   * `GET /jobs/:id/frames` (auth required).
   *
   * ADAAAA-8973 (Inc 5): `sinceSeq` is an optional incremental cursor. The
   * server then serves only the rows whose seq is strictly greater than it, so
   * a caught-up poll transfers `{frames: []}` (~constant bytes) instead of the
   * whole list. A transport that ignores the argument still works (it serves the
   * default window) — the client is correct either way.
   */
  listFrames(jobId: string, sinceSeq?: number): Promise<unknown>;
  /** `authFetchFrame(uri, token)` — a revocable blob object URL. */
  fetchImage(uri: string): Promise<string>;
}

export interface LiveStillSnapshot {
  state: LiveStillStateKind;
  /**
   * The frame whose BYTES ARE ON SCREEN — never merely the newest seq on the
   * route. A failed read must not relabel an older picture as the newest frame
   * (that would be a provenance lie: the caption would carry a seq the picture
   * does not belong to).
   */
  frame: LiveFrameRef | null;
  /** Newest seq the list served this poll (diagnostic; null when none/failed). */
  newestSeq: number | null;
  /** Object URL of the still; null whenever nothing is shown. */
  url: string | null;
  /** Set when a request failed, so the state can say WHY it is not rendering. */
  error: string | null;
  refusal: LiveStillRefusal;
}

/** Waiting copy: the named "no frame extracted yet" state (never a blank box). */
export const STILL_WAITING_TEXT =
  "No analyzed frame yet — the still appears when perceive crops its first frame.";

/** Refusal copy: distinct from the waiting state, and it names the reason. */
export function stillRefusalText(refusal: LiveStillRefusal, error: string | null): string {
  if (refusal === "auth") {
    return `The newest analyzed frame could not be read — this session's token was refused (${error ?? "HTTP 401"}). Sign in again to restore the still.`;
  }
  return `The newest analyzed frame could not be read (${error ?? "request failed"}) — no still to overlay.`;
}

/** HTTP status carried by a frame-read failure: `authFetchFrame` throws a plain
 *  Error with `HTTP <status>` in the message, a caller may attach `status`. */
export function frameErrorStatus(e: unknown): number | null {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === "number" && Number.isFinite(status)) return status;
  const msg = typeof (e as { message?: unknown } | null)?.message === "string" ? (e as { message: string }).message : String(e);
  const m = /HTTP\s+(\d{3})/.exec(msg);
  return m ? Number(m[1]) : null;
}

/** A 401/403 for the current token is an AUTH refusal, not "no frames yet". */
export function isAuthRefusal(status: number | null): boolean {
  return status === 401 || status === 403;
}

/**
 * The still's request lifecycle: ONE list request per poll (the page's existing
 * 5 s detail poll drives it), and an image request ONLY when the newest seq
 * changed. `counts` exists so a test can measure that instead of trusting a
 * comment.
 *
 * ADAAAA-8970 (degrade contract):
 * - an empty/absent frame list is `waiting` (text only, 0 `<img>`, nothing
 *   cached from a previous poll);
 * - a 401/403 on the JPEG is a `refused` state that LATCHES: the same seq is
 *   never re-attempted and neither is a later seq, so the client cannot loop the
 *   auth route against a dead token. `reset()` (job change, or leaving the
 *   no-preview state) clears the latch, so re-authenticating and returning
 *   recovers;
 * - an auth refusal DROPS the picture (`url: null`) instead of re-showing a still
 *   the client already dropped; any other transport failure keeps the last
 *   readable still, labelled with the frame it actually depicts (`frame`).
 *
 * The source deliberately does not own revocation of the RENDERED url: the
 * component revokes the previous object URL from the effect cleanup that React
 * runs after the new `<img src>` has committed, so a swap never blanks the
 * visible still. Dropping the URL to `null` runs the same cleanup, so a refused
 * frame is revoked too.
 *
 * ADAAAA-8962 (the unmount race this contract left open): a poll that resolves
 * AFTER `reset()`/`dispose()` — the stage left no-preview, the job changed, or
 * the page unmounted — creates a blob object URL nobody will ever render. The
 * generation guard below revokes that URL at the source and answers `waiting`,
 * so no object URL outlives its stage.
 *
 * ADAAAA-8973 (Inc 5, bounded poll): the list request is INCREMENTAL. The first
 * poll sends no cursor, so the server serves its default (latest-N) window and
 * the source records the newest seq it saw. Every later poll sends
 * `sinceSeq=<that seq>`, so a caught-up page transfers only the newer rows —
 * usually none. An empty response on a cursor poll therefore means "caught up",
 * NOT "no frames yet": the still already on screen stays `ready` with its own
 * seq/stamp/age. Only a first poll (no cursor) that serves no rows is `waiting`.
 */
export class LiveStillSource {
  private loadedSeq: number | null = null;
  private url: string | null = null;
  /** The frame the current `url` depicts (never the newest merely-listed seq). */
  private shownFrame: LiveFrameRef | null = null;
  /** ADAAAA-8973: the newest frame the server has served, kept across polls so
   *  an incremental poll that serves no rows does not blank the still. */
  private newestSeen: LiveFrameRef | null = null;
  /** ADAAAA-8973: incremental cursor = newest seq the server has served. */
  private cursor: number | null = null;
  /** Latched 401/403: no further image request until `reset()`. */
  private authRefused = false;
  private listRequests = 0;
  private imageRequests = 0;
  /** Bumped by reset()/dispose(): a poll that resolves afterwards is dropped. */
  private generation = 0;

  constructor(private readonly transport: LiveStillTransport) {}

  /** Measured request counters (AC4.1 / AC4.7). */
  get counts(): { listRequests: number; imageRequests: number } {
    return { listRequests: this.listRequests, imageRequests: this.imageRequests };
  }

  /** ADAAAA-8973: the cursor handed to the next `listFrames` (`undefined` on the
   *  first poll, so the server serves its default window). */
  get sinceSeq(): number | undefined {
    return this.cursor ?? undefined;
  }

  /** Forget the cached image (stage left the no-preview state, or the job
   *  changed): the next poll re-fetches the frame it finds, and a previously
   *  refused token is allowed one fresh attempt. ADAAAA-8973: the incremental
   *  cursor is forgotten too, so the next poll re-reads the default window. */
  reset(): void {
    this.generation += 1;
    this.loadedSeq = null;
    this.url = null;
    this.shownFrame = null;
    this.newestSeen = null;
    this.cursor = null;
    this.authRefused = false;
  }

  /** Unmount: drop the cached still AND revoke the URL nobody will render, so a
   *  closed page leaves no blob behind. */
  dispose(): void {
    const orphan = this.url;
    this.reset();
    revokeUrl(orphan);
  }

  /** The answer to a poll whose stage went away mid-flight: nothing to render. */
  private dropped(): LiveStillSnapshot {
    return { state: "waiting", frame: null, newestSeq: null, url: null, error: null, refusal: null };
  }

  private snapshot(
    state: LiveStillStateKind,
    newestSeq: number | null,
    error: string | null,
    refusal: LiveStillRefusal,
  ): LiveStillSnapshot {
    return { state, frame: this.shownFrame, newestSeq, url: this.url, error, refusal };
  }

  /** The refusal state drops the picture: no `<img>` over a frame we may not read. */
  private refuse(newestSeq: number | null, error: string, refusal: LiveStillRefusal): LiveStillSnapshot {
    this.loadedSeq = null;
    this.url = null;
    this.shownFrame = null;
    return { state: "refused", frame: null, newestSeq, url: null, error, refusal };
  }

  async poll(jobId: string): Promise<LiveStillSnapshot> {
    const generation = this.generation;
    this.listRequests += 1;
    let payload: unknown;
    try {
      // ADAAAA-8973: hand the incremental cursor to the transport so a caught-up
      // poll transfers only the rows newer than the newest frame we have.
      payload = await this.transport.listFrames(jobId, this.cursor ?? undefined);
    } catch (e: unknown) {
      if (generation !== this.generation) return this.dropped();
      const text = errorText(e);
      if (isAuthRefusal(frameErrorStatus(e))) {
        this.authRefused = true;
        return this.refuse(null, text, "auth");
      }
      // A list this poll could not read: keep an already-shown still (it is the
      // last honest picture), otherwise say the read failed.
      return this.snapshot(this.url ? "ready" : "refused", null, text, this.url ? null : "transport");
    }

    // The stage left no-preview, the job changed, or the page unmounted while the
    // list was in flight: this answer is nobody's.
    if (generation !== this.generation) return this.dropped();

    // ADAAAA-8973: MERGE the rows this poll served instead of replacing the
    // newest. A first poll (no cursor) seeds it from the server's default
    // window; an incremental poll serves only rows newer than the cursor, so an
    // empty response means "caught up" — the still on screen stays `ready` with
    // its own seq/stamp/age, it does not blank to `waiting`.
    let newest = this.newestSeen;
    for (const ref of servedFrameRows(payload)) {
      if (newest === null || ref.seq > newest.seq) newest = ref;
    }
    if (newest !== null) {
      this.newestSeen = newest;
      // The cursor only moves forward, and only from rows the server served.
      if (this.cursor === null || newest.seq > this.cursor) this.cursor = newest.seq;
    }
    const frame = newest;
    // No extracted frame yet (the job's frame dir does not exist or the writer
    // has not landed one): an honest, NAMED empty — never a placeholder picture.
    if (!frame) {
      this.loadedSeq = null;
      this.url = null;
      this.shownFrame = null;
      return { state: "waiting", frame: null, newestSeq: null, url: null, error: null, refusal: null };
    }

    // The token was refused earlier: report the refusal, do not fetch again.
    if (this.authRefused) {
      return { state: "refused", frame: null, newestSeq: frame.seq, url: null, error: null, refusal: "auth" };
    }

    if (frame.seq !== this.loadedSeq) {
      const uri = frame.uri.length > 0 ? frame.uri : `/jobs/${jobId}/frames/${frame.seq}`;
      this.imageRequests += 1;
      try {
        const url = await this.transport.fetchImage(uri);
        if (generation !== this.generation) {
          // The bytes arrived but no `<img>` will ever carry them: revoke here,
          // because the committed-src cleanup cannot see a URL never rendered.
          revokeUrl(url);
          return this.dropped();
        }
        this.url = url;
        this.loadedSeq = frame.seq;
        this.shownFrame = frame;
        return this.snapshot("ready", frame.seq, null, null);
      } catch (e: unknown) {
        if (generation !== this.generation) return this.dropped();
        const text = errorText(e);
        if (isAuthRefusal(frameErrorStatus(e))) {
          this.authRefused = true;
          return this.refuse(frame.seq, text, "auth");
        }
        // Transport failure: the still on screen (if any) stays, and it keeps the
        // provenance of the frame it depicts — never the seq that failed.
        return this.snapshot(this.url ? "ready" : "refused", frame.seq, text, this.url ? null : "transport");
      }
    }
    return this.snapshot("ready", frame.seq, null, null);
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

/** ADAAAA-8962: Node has no `URL.revokeObjectURL`; guard so a discarded fetch is
 *  a no-op there instead of a TypeError (the browser path is the one that
 *  matters, and the test stubs it to count revocations). */
function revokeUrl(url: string | null): void {
  if (!url) return;
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}
