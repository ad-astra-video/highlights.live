// Adopt the media-node session a browser share is carried by, when the control
// plane did not provision it (ADAAAA-8776).
//
// A browser share has TWO legal ways to open its media session:
//
//   - through the control plane (`POST /jobs/:id/media` -> `provisionMedia`),
//     which writes the `media_sessions` row and stamps `bj.mediaSessionId`;
//   - straight on the media node (`POST {media}/sessions` with the job id, as
//     `scripts/rtc-browser-measure.py` does), which the node carries, relays
//     and reports observations for — while the control plane learns nothing
//     about the session id.
//
// On the second path `bj.mediaSessionId` stays undefined, so BOTH readers of it
// post empty: `observeOnDecide`/`observeDecideOnly` (`api.ts` rail wiring) and
// the match-context fold (`liveMatchContextSession`), and the record keeps no
// `matchContext`. Measured on job `4cd84e86` (media node session `16ee75dc`,
// 624 frames published, `perceiveSessionS` 231.3): `media_sessions` held 0 rows
// for the job and every fold logged "no perceive session ... fold skipped".
// Its three peer browser legs were provisioned through the control plane, which
// is the only difference — they each have one row.
//
// The media node's own callbacks name the session it is carrying
// (`/jobs/:id/media/frames` -> `{sessionId, frames}`, `/jobs/:id/audio` ->
// `{sessionId, ...}`), so the control plane can adopt it on first sight instead
// of depending on which provisioner the client used.
//
// Two independent effects, both best-effort:
//   1. bind the rail's `mediaSessionId` (the field the fold and the decide path
//      read) — in memory, synchronous, so it holds for the next fold;
//   2. register the `media_sessions` row so the share is tracked and its Livepeer
//      spend stays attributable to the node that carried it.
import type { MediaSession } from "./db";
import { fetchMediaNodeIdentity } from "./media-ingest";

/** Minimal DB surface this module needs (a real `Db` satisfies it). */
export interface MediaSessionAdoptStore {
  getMediaSession(jobId: string): Promise<MediaSession | undefined>;
  setMediaSession(ms: MediaSession): Promise<void>;
}

/**
 * Whether a callback's session id should be adopted onto the rail.
 *
 * Only an UNBOUND rail adopts: a session the control plane provisioned keeps
 * precedence (`bj.mediaSessionId` is already set), and a late callback from an
 * older session must never move a share onto it. An unchanged id is not a new
 * adoption either.
 */
export function shouldAdoptMediaSession(
  current: string | undefined | null,
  incoming: string | undefined | null
): boolean {
  const next = typeof incoming === "string" ? incoming.trim() : "";
  if (!next) return false;
  const held = typeof current === "string" ? current.trim() : "";
  return held === "";
}

/**
 * Register the `media_sessions` row for a session the control plane did not
 * provision.
 *
 * Idempotent and non-destructive, exactly like the ingest attribution row: an
 * existing row is returned untouched, so a provisioned share keeps its browser
 * endpoint and its node.
 *
 * The row reads `status: "active"` because the session IS live at this moment
 * (the node is publishing frames on it); the job's terminal transition settles
 * it (`Store.patchJob` -> `closeMediaSession`), so it cannot go stale.
 *
 * `wsUrl` is deliberately empty: the node's callbacks carry no browser
 * endpoint, and inventing one would hand a reconnect a URL the media node may
 * not serve. `provisionMedia` therefore refuses to reuse this row and
 * re-provisions instead of returning an empty wsUrl.
 *
 * `nodeId` comes from the node's own `GET /health` (`fetchMediaNodeIdentity`),
 * never from config — a node that does not answer leaves the row honestly
 * unattributed (`nodeId: null`), the same shape `provisionMedia` writes when the
 * node reports no node id.
 */
export async function registerAdoptedMediaSession(opts: {
  db: MediaSessionAdoptStore;
  mediaServerUrl?: string;
  jobId: string;
  sessionId: string;
  now?: Date;
}): Promise<MediaSession | null> {
  const sessionId = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
  if (!sessionId) return null;
  const existing = await opts.db.getMediaSession(opts.jobId);
  if (existing) return existing;
  const identity = await fetchMediaNodeIdentity(opts.mediaServerUrl);
  const at = (opts.now ?? new Date()).toISOString();
  const row: MediaSession = {
    jobId: opts.jobId,
    sessionId,
    streamId: "",
    wsUrl: "",
    mediaOrigin: identity?.origin ?? (opts.mediaServerUrl ?? "").replace(/\/+$/, ""),
    nodeId: identity?.nodeId ?? null,
    status: "active",
    createdAt: at,
    updatedAt: at,
  };
  await opts.db.setMediaSession(row);
  return row;
}
