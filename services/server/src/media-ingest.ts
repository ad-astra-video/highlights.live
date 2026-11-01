// Media-tier attribution for live ingest that never provisions a session on the
// media node (ADAAAA-7670).
//
// The browser / browser-capture path records `media_sessions.node_id` from the
// provisioning response (`provisionMedia()` in api.ts), so `buildMediaNodeReport`
// (media-node.ts) can join `job.costUsd` to the node that carried the stream.
// RTMP-pull live jobs are pulled server-side (`live.ts`) and never call
// `POST {MEDIA_SERVER_URL}/sessions`, so they had no `media_sessions` row at all
// and all of their Livepeer spend grouped under `unattributed`.
//
// This module writes that attribution row from the ingest path. The node id is
// the one the media server reports about itself (`GET /health` -> `node.id`,
// i.e. the media service's `MEDIA_NODE_ID`), never one derived from config: a
// node that does not answer leaves the job honestly unattributed instead of
// guessing a node id.
//
// Which sources belong to the media tier (docs/plan/10-media-node-observability.md §5):
//   - LIVE ingest (`rtmp`, `webrtc`, `screenshare`, `screen`, `file-sim`):
//     attributable — the live pipeline (perceive session + Orchestrator payer)
//     runs on the media-tier host.
//   - VOD (`file`, uploads): deliberately NOT attributable — it runs in the
//     control-plane worker and holds no media-node lease.
import type { MediaSession } from "./db";

/** Live sources whose pipeline runs on the media tier. `file` (VOD) is absent
 * on purpose: VOD runs in the control-plane worker, not on a media node. */
export const LIVE_INGEST_SOURCES = ["rtmp", "webrtc", "screenshare", "screen", "file-sim"] as const;

/** True when a job source is live ingest the media tier carries. */
export function isMediaTierLiveSource(source: string | null | undefined): boolean {
  return typeof source === "string" && (LIVE_INGEST_SOURCES as readonly string[]).includes(source);
}

/** Prefix that marks a `media_sessions` row as an ingest attribution rather than
 * a media-server session provisioned through `POST /sessions`. */
export const INGEST_SESSION_PREFIX = "ingest:";

export function ingestSessionId(jobId: string): string {
  return `${INGEST_SESSION_PREFIX}${jobId}`;
}

/** Identity the media node reports about itself on `GET /health`. */
export interface MediaNodeIdentity {
  nodeId: string;
  origin: string;
}

/** Minimal DB surface this module needs (a real `Db` satisfies it). */
export interface MediaSessionStore {
  getMediaSession(jobId: string): Promise<MediaSession | undefined>;
  setMediaSession(ms: MediaSession): Promise<void>;
}

/**
 * Ask the media node who it is. Returns null when unconfigured, unreachable,
 * non-200, or not reporting a node id — callers must treat that as "cannot
 * attribute", never fall back to an invented id.
 */
export async function fetchMediaNodeIdentity(
  mediaServerUrl: string | undefined,
  timeoutMs = 1500
): Promise<MediaNodeIdentity | null> {
  if (!mediaServerUrl) return null;
  const origin = mediaServerUrl.replace(/\/+$/, "");
  if (!origin) return null;
  try {
    const r = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const body: any = await r.json();
    const nodeId = typeof body?.node?.id === "string" && body.node.id ? body.node.id : null;
    return nodeId ? { nodeId, origin } : null;
  } catch {
    return null;
  }
}

/**
 * Record the media node that carried a live job, as a settled `media_sessions`
 * row (`status: "closed"`, session id prefixed `ingest:`) so the cost join in
 * `buildMediaNodeReport` maps the job to that node.
 *
 * Idempotent and non-destructive: an existing row is never overwritten, so a
 * provisioned browser session or a first ingest attribution keeps the node that
 * actually carried the stream (a re-run after a node restart must not relabel
 * historical spend).
 *
 * Returns the row written, or null when there is nothing honest to write.
 */
export async function attributeLiveIngest(opts: {
  db: MediaSessionStore;
  mediaServerUrl?: string;
  jobId: string;
  source?: string | null;
  now?: Date;
}): Promise<MediaSession | null> {
  if (!isMediaTierLiveSource(opts.source)) return null;
  const identity = await fetchMediaNodeIdentity(opts.mediaServerUrl);
  if (!identity) return null;
  const existing = await opts.db.getMediaSession(opts.jobId);
  if (existing) return existing;
  const at = (opts.now ?? new Date()).toISOString();
  const row: MediaSession = {
    jobId: opts.jobId,
    // No media-server session exists for a server-side pull; the prefixed id
    // says so, and `status: closed` keeps it out of the live-session reuse path.
    sessionId: ingestSessionId(opts.jobId),
    streamId: opts.jobId,
    wsUrl: "",
    mediaOrigin: identity.origin,
    nodeId: identity.nodeId,
    status: "closed",
    createdAt: at,
    updatedAt: at,
  };
  await opts.db.setMediaSession(row);
  return row;
}
