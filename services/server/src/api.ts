import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { existsSync, statSync, readdirSync, createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { clipWindow, validateClipWindow } from "./config";
import type { ServerConfig } from "./config";
import { Store } from "./store";
import {
  analyzeJob,
  EvidenceTracker,
  LIVE_AUDIO_RETAIN_S,
  LiveRunShared,
  decideGroupKey,
  highlightIdempotencyKey,
  highlightDedupKey,
  observeOnDecide,
  type AnalyzeEvent,
  type AnalyzerConfig,
  type AnalyzeOutcome,
  type GoalLineCalibration,
  type PipelineClient,
} from "./analyzer";
import type { SignalGateOptions } from "./observe-loop";
import { audioTriggerFromCandidate, audioTriggerFromWhistle } from "./audio-trigger";
import { MediaRailObserver } from "./media-rail";
import { LiveFrameWriter, parseLiveFrameSeq } from "./live-frames";
import { resolvePerceiveCalibration } from "./perceive-calibration";
import { trailDecisionFromEvent } from "./jobTrail";
import { buildAnalyzeFrames } from "./livepeer-adapter";
import { cutClip, extractAudioWindow, extractBurstFrames, extractFrames, probeHasAudio } from "./ffmpeg";
import { extractFramesForDataset, writeTrainValManifests } from "./dataset";
import { probeDuration } from "./ffmpeg";
import {
  buildDatasetZip,
  readPersistedImage,
} from "./dataset-zip";
import {
  DatasetSchema,
  DetectionTrainingSampleSchema,
  JobDetailSchema,
  type Dataset,
  type DetectionTrainingSample,
  type HighlightRecord,
  type JobCandidate,
  type JobDecision,
} from "@highlights/events";
import { attachWindowAudioUris, buildSections, buildTraces, maxTracesForSource } from "./job-detail";
import { completedCounterFields, completedLiveCounterFields, counterFieldsForJob } from "./job-counters";
import { stageAEvidenceLine, whistleEvidenceLine } from "./stage-a-metrics";
import { aggregateLiveWatchMinutes, monthKeyUtc } from "./live-watch-minutes";
import { buildPostableHighlights } from "./highlight-postable";
import { buildSummaryLadder } from "./summary-ladder";
import { applyJobTitle } from "./job-title";
import { jobDetailForRole, jobEventForRole, jobForRole, jobsForRole } from "./job-visibility";
import { deriveLiveProgress, newestObservationTs } from "./live-progress";
import { deriveLiveCapture } from "./live-capture";
import { appendSummaryEntry } from "./summary-log";
import { recordDecideAudit } from "./decide-audit";
import { outcomeForMediaCloseReason, outcomeForStrandedJob, type JobFailureReason, type JobOutcome } from "./job-failure";
import {
  datasetAccessActive,
  scheduleDatasetsPurgeForOwner,
} from "./dataset-lifecycle";
import { LiveIngest, type LiveKind } from "./live";
import { extractVodAudioChunks } from "./vod-audio";
import type { Db, MediaSession, AnalyticsSnapshot, Subscription, User } from "./db";
import { attributionFrom, recordJobFunnel, recordGenerateFunnel, recordSubscribeFunnel, recordSignupFunnel } from "./funnel";
import { reportMonitoring, RELIABILITY_FLOOR } from "./monitoring";
import { buildMediaNodeReport } from "./media-node";
import { attributeLiveIngest } from "./media-ingest";
import { AuthService, BetaGateError, adminRequired, adminReadonlyRequired, authRequired, type AuthService as AuthSvc } from "./auth";
import { BillingService, BillingRequiredError, canRetrieveDataset } from "./billing";
import { EntitlementsService, QuotaExceededError } from "./entitlements";
import { FixedWindowLimiter, rateLimit } from "./rate-limit";
import { enqueueBestEffort, type Mailer } from "./mailer";
import { composeInviteEmail } from "./invites";
import { createTrainService, TrainValidationError } from "./train";
import { inspectCuratedManifests, loadCuratedManifest } from "./train-curated";
import { prepareArtifactDownload } from "./train-artifacts";

/** Human-readable size for the oversized-file message, e.g. "2 GB". Byte-exact:
 * 1024-based units, so it always renders the configured cap truthfully. Mirrors
 * `formatBytes` in webapp/src/lib/api.ts so the client pre-check and the server
 * 413 render the SAME string for the SAME cap (ADAAAA-5698). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  const rounded = Math.round(v);
  const str = v >= 10 || i === 0 || v === rounded ? String(rounded) : v.toFixed(1);
  return `${str} ${units[i]}`;
}

/** Resolve the VOD sampling fps from the runner's measured capability (when
 * reachable directly) else the configured interval.
 *
 * ADAAAA-3726: this previously hard-capped VOD sampling at 1 fps
 * (`Math.min(1.0, ...)`) regardless of device, so a GPU that sustains 3-8 fps
 * still only sampled one frame per second. On a short clip a brief high-value
 * moment (a soccer goal) can occur in the one or two frames between samples —
 * the tracker never accumulates a sharp move, no candidate fires, and the
 * decide runner never sees the moment, so the goal is missed. The perceive
 * CPU capability already reports `sample_interval_s >= 1.0` (test_cpu_policy),
 * so CPU safely stays at 1 fps on its own; here we honor the runner's reported
 * interval and bound it only by `vodSampleMaxFps`.
 */
export interface SampleFpsOpts {
  /** Base per-job FPS override (VOD passes `vodSampleFpsDefault`; the live
   * route passes `liveSampleBaseFps`, ADAAAA-6796). When absent the configured
   * `sampleIntervalSec` cadence is the base AND the floor. */
  defaultFps?: number;
  /** Hard ceiling on the resolved sampling fps. VOD's bound is
   * `vodSampleMaxFps` (default 8); live passes `liveSampleMaxFps` (default 10). */
  maxFps?: number;
  /** Headroom (0..1) applied to the runner's measured max fps so the runner
   * never sits at its sustained ceiling. VOD's legacy behavior has no headroom
   * (default 1); live applies `liveSampleHeadroom` (default 0.9). */
  headroom?: number;
}

/** Resolve the sampling fps from the runner's measured capability (when
 * reachable directly) else the configured interval.
 *
 * ADAAAA-5342: live mirrors the VOD mechanism (ADAAAA-3726) that drives
 * sampling from perceive's reported `sample_interval_s`. The base cadence is a
 * FLOOR: a headroom < 1 must never push a low-capability runner below its
 * incumbent rate. ADAAAA-6796 (Stage 1) raises the live base to
 * `liveSampleBaseFps` (default 3 fps) so the decide read samples the dense
 * crossing/conversion window for every live job; a CPU runner (which reports
 * interval >= 1.0) samples at the 3 fps baseline while a GPU accelerates toward
 * the chartered cadence bounded by the live cap.
 */
export async function resolveSampleFps(
  cfg: ServerConfig,
  opts: SampleFpsOpts = {}
): Promise<number> {
  const { defaultFps, maxFps = cfg.vodSampleMaxFps, headroom = 1 } = opts;
  // Base cadence: the configured default fps (VOD: `vodSampleFpsDefault`,
  // default 5; ADAAAA-5059) else the configured interval (live:
  // sampleIntervalSec). Used when perceive is unreachable, and it also floors
  // the resolved value so a headroom < 1 never regresses the cadence.
  const baseFps = Math.max(0.25, defaultFps ?? 1 / Math.max(0.2, cfg.sampleIntervalSec));
  let sampleFps = baseFps;
  if (cfg.perceiveUrl) {
    try {
      const h = (await (await fetch(`${cfg.perceiveUrl}/health`)).json()) as any;
      const interval = Number(h?.sample_interval_s);
      // Honor the runner's sustainable interval and apply headroom. No 1 fps
      // clamp: CPU reports interval >= 1.0 itself (the base floor keeps it at
      // ~1 fps even × headroom), GPU reports a smaller interval so sampling
      // accelerates toward the chartered cadence.
      if (Number.isFinite(interval) && interval > 0.05) sampleFps = (1 / interval) * headroom;
    } catch {
      /* fall back to config interval */
    }
  }
  return Math.min(maxFps, Math.max(baseFps, sampleFps));
}

/** Perceive persistent-session list price per hour (docker/runners.json
 * perceives `$0.01/hr`). Used for the recorded per-video `costUsd` list cost on
 * VOD jobs (ADAAAA-4954 spec §4.1). Flat hour unit, so session billing is
 * proportional to perceiveSessionS. */
const PERCEIVE_PER_HOUR_USD = 0.01;

/** ADAAAA-6625: thrown inside a VOD pass once `POST /jobs/:id/stop` has
 * cancelled it, so the run unwinds at the next safe boundary instead of
 * finalizing a partial pass as `done` (or letting a late session-lost error
 * overwrite the operator-visible `cancelled` outcome with `failed`). */
class VodCancelledError extends Error {
  constructor(readonly jobId: string) {
    super(`job ${jobId} cancelled`);
    this.name = "VodCancelledError";
  }
}

// Extension-based fallback for sources that ship a generic MIME (mpegts is
// frequently served as application/octet-stream; some MP4s as audio/mp4).
const VIDEO_UPLOAD_EXT = /\\.(mp4|m4v|mov|webm|mkv|mpeg|mpg|ts|m2ts|mts)$/i;
/** Accept a browser upload when its declared type is a common video type
 * (mp4, mov, webm, matroska/mkv, mpegts). Clearly non-video uploads are
 * rejected with a readable message so they never reach GPU compute. */
function isVideoUpload(mime: string | null | undefined, filename: string): boolean {
  const m = (mime || "").toLowerCase().trim();
  if (m.startsWith("video/")) return true;
  if (m === "application/octet-stream" || m === "audio/mp4" || m === "") {
    return VIDEO_UPLOAD_EXT.test(filename);
  }
  return false;
}

/** Keep only safe filename characters and the basename; never allow path
 * traversal or separators to escape the job's upload directory. */
function sanitizeFilename(name: string): string {
  const base = path.basename(name || "").replace(/[^\w.\- ]+/g, "_").trim();
  return base && base !== "." ? base : "upload.mp4";
}

/** Human-readable upload cap for 413 messages — reflects the ACTUAL configured
 * cap (vorMaxUploadBytes), not a hardcoded "2 GB", matching the client's
 * `formatBytes` wording so the edge-vs-app story stays self-consistent. */
function formatUploadLimit(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  if (Number.isInteger(gb) && gb > 0) return `${gb} GB`;
  const mb = bytes / 1024 / 1024;
  if (Number.isInteger(mb)) return `${mb} MB`;
  return `${Math.round(mb)} MB`;
}

/** Lightweight projection of a persisted dataset for list/summary responses:
 * the manifest arrays stay server-side for the detail route; the list carries
 * counts + imageRefs the curation UI needs to re-materialize a saved set. */
function toDatasetSummary(d: Dataset) {
  return {
    id: d.id,
    name: d.name ?? null,
    ownerId: d.ownerId,
    trainCount: d.trainCount,
    valCount: d.valCount,
    imageRefs: d.imageRefs,
    status: d.status,
    createdAt: d.createdAt,
  };
}

export interface ApiDeps {
  cfg: ServerConfig;
  store: Store;
  adapter: PipelineClient;
  db: Db;
  auth: AuthService;
  billing: BillingService;
  entitlements: EntitlementsService;
  mailer?: Mailer;
}

/** The persisted-record shape used when a highlight is accepted: write-through
 * the record (memory + DB) so GET /highlights and GET /feed see it immediately,
 * then bill + debit quota exactly once. */
export interface LiveHighlightPersistence {
  store: Store;
  cfg: ServerConfig;
  billing: BillingService;
  entitlements: EntitlementsService;
  db: Db;
}

/** Persist + publish an accepted highlight to the user's feed at DECISION time
 * (ADAAAA-5777). Previously the live path only called store.addHighlight after
 * `ingest.stop()` at session end, so end users saw highlights only once the live
 * session completed. This writes the record through at the moment the highlight
 * is decided (store memory write is synchronous, so the feed reads it the same
 * tick), then applies billing (billing.onHighlightCreated) and the quota debit
 * (entitlements.onClipGenerated) — exactly once per accepted highlight.
 *
 * Called fire-and-forget from the live onEvent `highlight` hook; a rejected
 * record never reaches it, and a failure is logged without stalling the live
 * frame loop. Keep db (highlight persist) <-> server (publish) <-> ui (feed
 * surface) contracts in sync when editing this. */
export async function persistLiveHighlight(
  deps: LiveHighlightPersistence,
  user: User,
  sub: Subscription,
  highlight: HighlightRecord
): Promise<HighlightRecord> {
  const { record, created } = await deps.store.addHighlight({
    ...highlight,
    ownerId: user.id,
    status: deps.cfg.autoPublishHighlights ? "accepted" : "pending",
  });
  // ADAAAA-6874 (Phase 2): idempotency — bill/debit/funnel only on the FIRST
  // insert. A re-claimed/resumed job that re-persists the same idempotencyKey
  // returns `created: false` and must NOT re-bill, re-debit quota, or double
  // count the highlight.
  if (created) {
    await deps.billing.onHighlightCreated(user, sub);
    // A clip generated successfully debits the quota once.
    await deps.entitlements.onClipGenerated(user);
    // Funnel stage 3: generate (a highlight was produced). Idempotent per user.
    await recordGenerateFunnel(deps.db, user.id);
    // ADAAAA-6874 (Phase 2): surface the live highlight count on the job the
    // instant a highlight lands (never gated on job completion). Guarded on the
    // job being present in this store instance so an edge case (job already
    // deleted / not hydrated here) never fails highlight persistence itself.
    // ADAAAA-7118: set the live highlight counter to the ABSOLUTE persisted
    // count from the store (the source of truth), never an increment of the
    // current value. bumping `job.highlightsFound + 1` overcounted when the
    // count had already been advanced by the job's own progress writer (the
    // local tally going 0->1), so highlightsFound transiently read 2 while only
    // 1 highlight was persisted. Deriving from `store.highlightsForJob` is
    // correct for VOD and live alike and can never drift from the persisted
    // count. (Same guard ADAAAA-6874 keeps billing/quota exactly-once: the
    // store addHighlight dedup + `created` gate is untouched.)
    const job = deps.store.getJob(record.jobId);
    if (job) await deps.store.patchJob(record.jobId, { highlightsFound: deps.store.highlightsForJob(record.jobId).length });
  }
  return record;
}

/** Remove a deleted job's on-disk artifacts (ADAAAA-6838). Best-effort: every
 * path is removed with `force` and any failure (e.g. a dir that never existed)
 * is swallowed. Removes the VOD upload dir, the extracted-frames dir, the live
 * capture dir, and every clip this job produced under `dataDir/clips` (matched
 * via its highlight `clipUri` values, plus the `<jobId>-*` browser-clip naming). */
async function removeJobArtifacts(dataDir: string, jobId: string, clipUris: string[]): Promise<void> {
  const dirs = [path.join(dataDir, "uploads", jobId), path.join(dataDir, "frames", jobId), path.join(dataDir, "live", jobId)];
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  const clipDir = path.join(dataDir, "clips");
  const clipFiles = new Set<string>();
  for (const uri of clipUris) {
    // clipUri is a web path like "/clips/<file>.mp4"; strip the leading /clips/.
    const m = /^\/clips\/(.+)$/.exec(uri);
    if (m) clipFiles.add(m[1]);
  }
  try {
    for (const f of readdirSync(clipDir)) {
      if (f.startsWith(`${jobId}-`)) clipFiles.add(f);
    }
  } catch {
    /* no clips dir — nothing to do */
  }
  for (const f of clipFiles) {
    await rm(path.join(clipDir, f), { force: true }).catch(() => {});
  }
}

export function buildApp(deps: ApiDeps): FastifyInstance {
  const { cfg, store, adapter, db, auth, billing, entitlements, mailer } = deps;
  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });
  // Multipart parsing for browser VOD uploads (POST /jobs/upload). Files are
  // streamed (never buffered in memory). The 2 GB cap is enforced authoritatively
  // by the route's own byte counter, which aborts an over-limit upload with 413
  // before reaching compute. We MUST set busboy's `limits.fileSize` ABOVE the cap:
  // @fastify/multipart otherwise defaults it to fastify.initialConfig.bodyLimit
  // (1 MiB = 1,048,576), which silently truncates every upload to exactly
  // 1,048,576 bytes and makes the 2 GB counter unreachable (ADAAAA-3041).
  // fileSize must be > cap (not == cap): when busboy's own limit trips first it
  // rejects inside `req.file()` with an unhandled FST_REQ_FILE_TOO_LARGE (500),
  // stealing the route counter's clean 413. A +1 MiB margin keeps busboy from
  // ever firing for a file the 2 GB counter has already accepted, so the counter
  // alone decides 413 at the cap.
  app.register(multipart, {
    limits: { files: 1, fields: 10, fileSize: cfg.vodMaxUploadBytes + 1024 * 1024 },
  });

  // Keep raw JSON body for Stripe webhook signature verification.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, function (req: any, body: Buffer, done) {
    try {
      const text = body.toString("utf8");
      req.raw.body = body;
      done(null, text ? JSON.parse(text) : {});
    } catch (e: any) {
      done(e as any);
    }
  });

  const authReq = authRequired(auth);
  const adminReq = adminRequired(auth);
  const adminReadOnlyReq = adminReadonlyRequired(auth);
  const train = createTrainService(db, adapter, cfg);

  // ADAAAA-7247 (ACC-7): resolve the per-company clip window that WINS at
  // assembly. Reads the webui-configured, DB-persisted value first; falls back
  // to the deployment env default (ServerConfig.clipBeforeS / clipAfterS). The
  // `>=clipWindowMinSec` floor is enforced downstream by `clipWindow`, so no
  // persisted setting can ever produce a delivered clip <15 s (ACC-1).
  async function resolveClipWindow(): Promise<{ clipBeforeS: number; clipAfterS: number; clipWindowMinSec: number }> {
    const s = await db.getClipWindowSettings();
    return {
      clipBeforeS: s?.clipBeforeS ?? cfg.clipBeforeS,
      clipAfterS: s?.clipAfterS ?? cfg.clipAfterS,
      clipWindowMinSec: cfg.clipWindowMinSec ?? 15,
    };
  }

  // Public auth endpoints share one anti-abuse budget per IP (login, register,
  // forgot, reset). In-process fixed-window: fine for a single beta instance;
  // move to a shared store if the server is ever scaled horizontally.
  const authLimiter = new FixedWindowLimiter({ limit: cfg.authRateLimit, windowMs: cfg.authRateLimitWindowSec * 1000 });
  const limitAuth = rateLimit(authLimiter, "auth");

  // In-memory registry of running live ingest sessions (keyed by job id) so a
  // live job can be stopped explicitly; ends the frame iterator -> analyzeJob
  // returns -> the job is marked done.
  const liveSessions = new Map<string, LiveIngest>();
  // Browser-capture (client-side screen share / element capture) jobs: the
  // CLIENT streams sampled frames in via POST /jobs/:id/ingest and a recording
  // via POST /jobs/:id/recording; this holds the per-job evidence + lazy perceive
  // session.
  const browserJobs = new Map<string, { evidence: EvidenceTracker; sessionId?: string; recordingExt?: string; mediaSessionId?: string; mediaWsUrl?: string; mediaIceServers?: any[]; rail?: MediaRailObserver; frames?: LiveFrameWriter }>();
  // ADAAAA-6561: per live-ingest job, the CURRENT perceive session held by that
  // job plus whether the job has been stopped. The stop path uses this to
  // release the perceive slot SYNCHRONOUSLY (independent of the in-flight GPU
  // /analyze that analyzeJob's `finally` would otherwise wait for), so a job
  // started right after POST /jobs/:id/stop can re-reserve without a 503.
  const livePerceiveSlots = new Map<string, { current?: { sessionId: string; appUrl: string; controlUrl: string }; stopped: boolean }>();
  // ADAAAA-6625: VOD `file` job cancellation. `POST /jobs/:id/stop` adds the
  // job here and aborts its controller, so (a) a decode already running inside
  // extractFrames is killed, (b) runVodJob unwinds at the next phase boundary,
  // and (c) analyzeJob's frame loop exits on its next frame via the slotRef
  // instead of re-reserving. Without this, stop only released the perceive
  // slot and the pass still ran to `done` (or, with no slot held, 409'd and the
  // row stayed non-terminal until a container restart).
  const vodStops = new Set<string>();
  const vodStopControllers = new Map<string, AbortController>();
  function isVodStopped(jobId: string): boolean {
    return vodStops.has(jobId);
  }

  // --- Resumable VOD upload sessions (ADAAAA-5714) ---
  // The single-shot POST /jobs/upload is served through a Cloudflare tunnel that
  // caps each proxied request body at ~100 MB (free plan), so a 454 MB video is
  // rejected by Cloudflare's own 413 before the origin. The webapp instead
  // slices large files into `vodChunkBytes` parts and posts each through
  // /jobs/upload/:uploadId/chunk; we append them here to the same staged file
  // the single-shot rail produces and finalize exactly like it. Sessions are
  // in-memory (the server is a single box) with an idle TTL sweep; a client that
  // abandons mid-upload leaves a staging file that the sweep cleans up.
  interface UploadSession {
    ownerId: string;
    filename: string;
    mimetype: string;
    size: number;
    received: number;
    stagePath: string;
    dir: string;
    finalPath: string;
    gameHint: string;
    preferLabels: string[];
    sampleFps?: number;
    lastChunkAt: number;
  }
  const uploadSessions = new Map<string, UploadSession>();
  const UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000;
  function sweepUploadSessions(forceExpiredAt = Date.now()) {
    for (const [id, s] of uploadSessions) {
      if (forceExpiredAt - s.lastChunkAt > UPLOAD_SESSION_TTL_MS) {
        uploadSessions.delete(id);
        rm(s.stagePath, { force: true }).catch(() => {});
        rm(s.dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async function isMediaHealthy(base: string): Promise<boolean> {
    try {
      const r = await fetch(`${base.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  // Media-server handshake: provision a perceive session on the standalone
  // media server (the payer/broadcaster) and return the browser's WS URL. The
  // Fastify control plane never carries media bytes — the browser streams
  // sampled frames over the returned WS to the media server, which publishes
  // them to the orchestrator's video-in rail.
  //
  // The session is tracked in the DB (media_sessions) so that:
  //   - repeat /jobs/:id/media calls are idempotent (reuse the live session),
  //   - if the media node that served the session goes DOWN, isMediaHealthy()
  //     fails and we re-provision on a healthy node, seamlessly re-routing the
  //     browser to a fresh wsUrl (no user action needed).
  async function provisionMedia(jobId: string): Promise<{ wsUrl: string; mediaSessionId: string; mediaOrigin: string; iceServers?: any[] }> {
    if (!cfg.mediaServerUrl) throw new Error("media server not configured (MEDIA_SERVER_URL)");
    // The control plane reaches the media node on its docker-internal URL
    // (media:4070) for provisioning + health checks; a browser cannot resolve
    // that service name, so the value handed BACK to the webapp for the WebRTC
    // signaling POSTs is the PUBLIC media origin when configured (ADAAAA-7286).
    const internalOrigin = cfg.mediaServerUrl.replace(/\/+$/, "");
    const browserOrigin = (cfg.mediaPublicBaseUrl ?? cfg.mediaServerUrl).replace(/\/+$/, "");
    const existing = await db.getMediaSession(jobId);
    if (existing && existing.status === "active" && (await isMediaHealthy(existing.mediaOrigin))) {
      // Reconnect to the SAME live session: reuse its cached ICE servers so the
      // browser reconfigures its peer with the relay on every offer.
      return { wsUrl: existing.wsUrl, mediaSessionId: existing.sessionId, mediaOrigin: browserOrigin, iceServers: browserJobs.get(jobId)?.mediaIceServers };
    }
    const r = await fetch(`${internalOrigin}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    if (r.status !== 200) throw new Error(`media provision failed: HTTP ${r.status} ${await r.text()}`);
    const body: any = await r.json();
    // Prefer the media server's own full URL (LB-routable); fall back to
    // deriving ws:// from the browser-facing media origin + the returned path.
    const base = browserOrigin.replace(/^http/, "ws");
    const wsUrl = body.wsUrl ?? `${base}${body.wsPath}`;
    const now = new Date().toISOString();
    await db.setMediaSession({
      jobId,
      sessionId: body.sessionId,
      streamId: body.streamId ?? "",
      wsUrl,
      // Persist the internal origin so isMediaHealthy() health-checks the media
      // node directly; the PUBLIC origin is what the browser is told.
      mediaOrigin: internalOrigin,
      // ADAAAA-6869 Phase 4: which node carried this stream, so Livepeer GPU
      // spend is attributable per node (single node today, fleet-ready shape).
      nodeId: typeof body.nodeId === "string" && body.nodeId ? body.nodeId : null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    // Keep the in-memory browser job pointer current for teardown + hand the
    // browser the media server's ICE/TURN servers so its peer allocates a relay
    // candidate (reachable across the LB) instead of a private host candidate.
    const bj = browserJobs.get(jobId);
    if (bj) {
      bj.mediaSessionId = body.sessionId;
      bj.mediaWsUrl = wsUrl;
      bj.mediaIceServers = body.iceServers;
    }
    return { wsUrl, mediaSessionId: body.sessionId, mediaOrigin: browserOrigin, iceServers: body.iceServers };
  }
  function browserRecordingPath(jobId: string): string {
    return path.join(cfg.dataDir, "live", jobId, "capture" + (browserJobs.get(jobId)?.recordingExt || ".webm"));
  }
  // The client flushes its final MediaRecorder chunk before POST /stop, but a
  // chunk can still land a few hundred ms behind (base64 encode + retry over a
  // flaky link). Wait a bounded window for the recording to materialize before
  // giving up, so a short share's final chunk isn't clipped away by the stop
  // race (ADAAAA-6522). Returns the path once it exists and is non-empty, else
  // null after the window (caller surfaces the miss instead of silently
  // producing an empty clipUri).
  async function waitForRecording(jobId: string, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const p = browserRecordingPath(jobId);
      if (existsSync(p) && statSync(p).size > 0) return p;
      if (Date.now() >= deadline) return existsSync(p) ? p : null;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // ADAAAA-7689 AC3: browser finalization now has TWO triggers — the client's
  // `POST /jobs/:id/stop` and the media node's session-closed callback (the
  // browser's RTC/WS session ended). They can fire within milliseconds of each
  // other (the webapp closes the peer, then posts /stop), so the work must run
  // exactly once per job. This holds the in-flight promise; the second caller
  // awaits the same finalization instead of cutting clips twice.
  const browserFinalizing = new Map<string, Promise<{ ok: boolean; job: any; reason: string }>>();
  function finishBrowserJob(
    jobId: string,
    reason: string,
    outcome: JobOutcome = { status: "done" }
  ): Promise<{ ok: boolean; job: any; reason: string }> {
    const running = browserFinalizing.get(jobId);
    if (running) return running;
    const task = (async () => {
      const job = store.getJob(jobId);
      const bj = browserJobs.get(jobId);
      if (!job || !bj) return { ok: true, job, reason };
      // ADAAAA-7699: settle the media-rail decide observer BEFORE the perceive
      // session is released and before clips are cut — the tail window must be
      // decided while the session the media node paid for is still alive, and
      // every accepted highlight must exist before the cut loop runs.
      // ADAAAA-7700: a media-node restart / lost session ends the share as a
      // FAILURE — do not spend a tail decide on a session that is already gone.
      if (bj.rail && outcome.status === "done") {
        await bj.rail.finish().catch((e) => console.error(`[media-rail:${jobId}] finish failed:`, e?.message || e));
        // ADAAAA-7734: settle every queued frame write before the job is marked
        // done — a reader polling right after POST /stop must find the frames the
        // share analysed on disk (the writes are off the observe callback's path).
        if (bj.frames) await bj.frames.drain().catch(() => {});
        const railStats = bj.rail.stats();
        const railMetrics = bj.rail.observeMetrics();
        await store
          .patchJob(jobId, {
            // Mirror a live RTMP job's record: the observer owns the decide
            // count, the anchored/cadence split and the latency/lag snapshot.
            decideCalls: railMetrics.decideCalls,
            observeMetrics: railMetrics,
            // ADAAAA-7734: the share's real analyzed-frame count (the rail's
            // relayed frames, each persisted to the job frame dir) so
            // `GET /jobs/:id` progress + the job header read the number instead
            // of null/0 ("Frames shown 0").
            framesAnalyzed: railStats.frames,
            framesTotal: railStats.frames,
            framesPct: railStats.frames > 0 ? 100 : 0,
            // ADAAAA-7667 semantics: the persisted (deduped) highlight count is
            // the candidate count; `observe` is the path that ran.
            ...completedLiveCounterFields(bj.rail.run.stageA.snapshot(), railMetrics, store.highlightsForJob(jobId).length),
            // ADAAAA-7670: inference cost attribution for the share. The
            // streaming decide fee is waived at BILLING time (ADAAAA-5341), so
            // the decide term is the list-price measure of the calls made, not
            // money charged; the perceive session was already paid by the share.
            perceiveSessionS: railStats.sessionSeconds,
            // ADAAAA-7722: the measured live watch-minutes for this session — the
            // media node's own session clock, the same seconds the share is
            // billed on. Feeds the month-to-date ceiling basis.
            liveWatchMinutes: Number((railStats.sessionSeconds / 60).toFixed(3)),
            costUsd: Number((cfg.decideFee * railMetrics.decideCalls + (railStats.sessionSeconds / 3600) * PERCEIVE_PER_HOUR_USD).toFixed(4)),
          })
          .catch((e: any) => console.error(`[media-rail:${jobId}] metrics persist failed:`, e?.message || e));
      }
      if (bj.sessionId) await adapter.stopPerceive(bj.sessionId).catch(() => {});
      // Media-path session: tell the media server to stop paying + release the
      // perceive slot (also idempotently triggered by the browser WS closing),
      // and forget the DB record so a fresh session is provisioned next time.
      if (bj.mediaSessionId && cfg.mediaServerUrl) {
        await fetch(`${cfg.mediaServerUrl}/sessions/${bj.mediaSessionId}/close`, { method: "POST" }).catch(() => {});
        // ADAAAA-7764: SETTLE the row instead of deleting it. The session is
        // over, so it must stop reading as a live share, but the row is the only
        // record of which node carried the stream (`session_id`/`node_id`) and
        // feeds the `media_sessions.node_id` -> `job.costUsd` attribution join.
        // A closed row still forces a fresh provision next time (reuse requires
        // `active`), which is all `clearMediaSession` bought us here.
        await db.closeMediaSession(jobId).catch(() => {});
      }
      const recPath = await waitForRecording(jobId, 4000);
      const { mkdir } = await import("node:fs/promises");
      const outDir = path.join(cfg.dataDir, "clips");
      await mkdir(outDir, { recursive: true });
      // ADAAAA-7247 (ACC-7): use the webui-configured (DB-persisted) per-company
      // clip window for the final browser clip cuts.
      const cw = await resolveClipWindow();
      // Cut a clip for every highlight that doesn't already have one. If the
      // recording is missing or a cut fails, surface the miss on the highlight
      // (clipError) instead of silently leaving an empty clipUri -> blank card.
      let missed = 0;
      for (const h of store.highlightsForJob(jobId)) {
        if (h.clipUri) continue;
        if (!recPath) {
          missed++;
          await store.patchHighlight(h.id, {
            clipError: "No screen-share recording was captured, so this highlight's clip could not be produced.",
          });
          continue;
        }
        const name = `${jobId}-${Math.round(h.start * 10)}`;
        try {
          const out = path.join(outDir, `${name}.mp4`);
          const win = clipWindow(h.start, cw.clipBeforeS, cw.clipAfterS, cw.clipWindowMinSec);
          const dur = Math.max(h.end - h.start, win.end - win.start);
          // ADAAAA-7724: cutClip picks stream-copy when the recording's codecs fit
          // the mp4 container and re-encodes when they do not (a VP8/VP9+opus
          // webm recording cannot be copied into mp4 — ffmpeg exits leaving a
          // 0-byte file and every highlight got an empty clipUri). The cut also
          // removes a failed/empty output, so a 0-byte clip never lands on disk.
          const cut = await cutClip(cfg.ffmpegPath, recPath, out, Math.max(0, h.start), dur);
          if (cut.mode === "reencode") {
            const src = cut.sourceFormat;
            console.log(
              `[browser:${jobId}] cut ${path.basename(out)} by re-encoding ` +
                `(${src?.container || "?"} ${src?.videoCodec || "?"}/${src?.audioCodec || "none"} -> mp4 h264/aac, ${cut.bytes} B)`
            );
          }
          // ADAAAA-7248: record whether the source recording carried audio so
          // the card can show an explicit "no audio captured" state (e.g. a
          // screen/window share yields no audio track) instead of implying
          // sound. `-c copy` preserves the source's audio, so a `false` here
          // means the source itself had no audio stream. A probe failure leaves
          // it unset (unknown) rather than mislabeling.
          const hasAudio = await probeHasAudio(cfg.ffmpegPath, recPath);
          await store.patchHighlight(h.id, {
            clipUri: `/clips/${name}.mp4`,
            ...(hasAudio != null ? { hasAudio } : {}),
          });
        } catch (e: any) {
          missed++;
          // ADAAAA-7724: surface the actual ffmpeg reason (runFfmpeg embeds the
          // meaningful stderr lines) instead of only counting a "no clip" and
          // leaving the operator to guess from a bare 0-byte file.
          const reason = String(e?.message || e);
          console.error(`[browser:${jobId}] clip cut failed for highlight ${h.id} (${name}.mp4): ${reason}`);
          await store.patchHighlight(h.id, { clipError: `Clip cut failed: ${reason}` });
        }
      }
      if (missed > 0) {
        console.error(
          `[browser:${jobId}] ${missed} highlight(s) produced no clip (recording=${recPath ? "present" : "missing"}) — reasons logged above`
        );
      }
      browserJobs.delete(jobId);
      // ADAAAA-7700: a share that died with the media node is NOT a user stop —
      // the job lands `failed` with a machine-readable failureReason and an
      // actionable message, instead of a bare `failed` with 0 frames (the 22:16Z
      // report). A client/control close keeps finalizing as `done`.
      await store.patchJob(
        jobId,
        outcome.status === "failed"
          ? {
              status: "failed",
              failureReason: outcome.failureReason,
              error: outcome.error,
              finishedAt: new Date().toISOString(),
            }
          : { status: "done" }
      );
      // Activity log (durable) + live-console event, so the console shows the
      // attribution within the SSE tick rather than on the next poll.
      await recordJobLifecycle(jobId, outcome.status === "failed" ? "failed" : "stopped", `reason=${reason}${outcome.status === "failed" ? ` failureReason=${outcome.failureReason}` : ""}`);
      emitJobEvent(jobId, {
        seq: -1,
        timestamp: -1,
        type: "lifecycle",
        status: outcome.status,
        failureReason: outcome.status === "failed" ? outcome.failureReason : undefined,
        message: outcome.status === "failed" ? outcome.error : "Share ended.",
        reason,
      });
      emitJobEvent(jobId, { seq: -1, timestamp: -1, type: "observation", observation: { tracks: [] } }); // wake SSE
      return { ok: true, job: store.getJob(jobId), reason };
    })().finally(() => {
      browserFinalizing.delete(jobId);
    });
    browserFinalizing.set(jobId, task);
    return task;
  }
  // ADAAAA-7699: per-share decide observer for the media (RTC) rail. The media
  // node relays each perceive observation back WITH the anchor JPEG it already
  // holds at publish time, so this rail can run the same cadence-bound
  // decide-observer the live RTMP rail uses — without reserving a second
  // perceive session and without routing the share back onto the control-plane
  // `/ingest` rail (which would regress the Phase-2 media-server migration,
  // ADAAAA-6867). Lazily created on the first relayed observation/audio chunk.
  async function ensureMediaRail(
    job: { id: string; ownerId?: string; gameHint?: string; preferLabels?: string[]; cameraId?: string },
    bj: { rail?: MediaRailObserver; mediaSessionId?: string; frames?: LiveFrameWriter }
  ): Promise<MediaRailObserver | null> {
    if (bj.rail) return bj.rail;
    // Same rollout switch as the live rail's decide-observer.
    if (!cfg.liveObserveLoop) return null;
    if (!job.ownerId) return null;
    const user = await db.getUserById(job.ownerId);
    if (!user) return null;
    const sub = await db.getSubscription(user.id);
    const cw = await resolveClipWindow();
    const shared = new LiveRunShared({ audioRetainS: LIVE_AUDIO_RETAIN_S });
    const anaCfg: AnalyzerConfig = buildLiveAnalyzerConfig({
      cfg,
      job,
      clipWindow: cw,
      // ADAAAA-6851 Inc 2: persist every decide evaluation durably.
      onDecision: persistDecision,
      // ADAAAA-7028 Inc 2: durable decide_audit rows (AC-2 parity with the
      // live rail: promptText / frameCount / timings / replays).
      onDecideAudit: persistDecideAudit,
      getRunningSummary: () => store.getJob(job.id)?.runningSummary ?? "",
      onRunningSummary: (summary, meta) =>
        appendSummaryEntry(store, job.id, summary, meta).catch((e: any) =>
          console.error(`[running-summary:${job.id}] persist failed:`, String(e?.message || e))
        ),
    });
    // Clips are cut from the browser recording at share end (finishBrowserJob
    // cuts every highlight that has no clipUri yet): the recording is still
    // being written while the share is live, so a decide must not try to cut
    // from a truncated file. The highlight record persists at DECISION time so
    // the live feed updates during the share (ADAAAA-5777 behaviour).
    const deferredCut = async () => ({ clipId: "", clipUri: "" });
    // ADAAAA-7734: persist every frame the media rail analyses. The media node
    // hands us the decoded JPEG with each observation and we used to throw it
    // away, so the job page rendered "Frames shown 0" with blank tiles and
    // `GET /jobs/:id/frames` 404'd. Writes are queued by the writer (never awaited
    // on the observe callback) and capped per job (LiveFrameWriter), and each
    // frame's observation row is recorded so `/observations` + the section
    // builder can place it in a 3 s window.
    const frames = new LiveFrameWriter({
      dataDir: cfg.dataDir,
      jobId: job.id,
      recordObservation: (jobId, obs) => store.recordObservation(jobId, obs as any),
    });
    bj.frames = frames;
    const onEvent = (ev: AnalyzeEvent) => {
      emitJobEvent(job.id, ev);
      if (ev.type === "highlight" && ev.highlight) {
        persistLiveHighlight({ store, cfg, billing, entitlements, db }, user, sub, ev.highlight).catch((e) =>
          console.error(`[media-rail:${job.id}] persist highlight ${ev.highlight?.id} failed:`, e?.message || e)
        );
      }
    };
    const rail = new MediaRailObserver(
      {
        jobId: job.id,
        stageA: shared.stageAOutcomes,
        signalGate: cfg.observeSignalGate,
        signalGateOpts: buildObserveSignalGateOpts(cfg),
        // ADAAAA-7734: persist the JPEG this rail just decided on (queued write).
        onFrame: (frame) =>
          frames.enqueue({
            seq: frame.seq,
            timestamp: frame.timestamp,
            frameB64: frame.frameB64,
            tracks: (frame.observation.tracks ?? []) as any,
          }),
        onDecide: async (payload) => {
          // Streaming waiver (ADAAAA-5341): the share is an ACTIVE streaming
          // session, so the per-decide fee is $0 and the gate never 402s
          // mid-share; the decide is still metered so volume stays observable.
          await billing.canDecide(user, sub, { streaming: true });
          const accepted = await observeOnDecide(adapter, shared, deferredCut, anaCfg, onEvent, bj.mediaSessionId ?? "", payload);
          await billing.onDecideCompleted(user, sub, { streaming: true });
          return accepted;
        },
      },
      shared
    );
    bj.rail = rail;
    return rail;
  }
  // The same recording as the perceive runner sees it (shared volume): the
  // perceive container mounts this server's dataDir at cfg.perceiveClipRoot, so
  // hand perceive the in-container path and it SAM-tracks THAT stream in the
  // persistent session (not a server-side path it can't read).
  function browserClipInPerceive(jobId: string): string {
    const ext = browserJobs.get(jobId)?.recordingExt || ".webm";
    return `${cfg.perceiveClipRoot}/live/${jobId}/capture${ext}`;
  }
  // Per-job live-console event fans (SSE subscribers); a job inactive for too
  // long is cleaned from the registry on job completion.
  const jobEvents = new Map<string, Set<(ev: AnalyzeEvent) => void>>();
  function subscribeJob(jobId: string, fn: (ev: AnalyzeEvent) => void): () => void {
    let set = jobEvents.get(jobId);
    if (!set) {
      set = new Set();
      jobEvents.set(jobId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) jobEvents.delete(jobId);
    };
  }
  function emitJobEvent(jobId: string, ev: AnalyzeEvent) {
    for (const fn of jobEvents.get(jobId) ?? []) fn(ev);
  }
  // Shared analyze hook: fans to SSE subscribers AND persists observations so
  // the frame debugger can overlay boxes on any past frame (VOD + live).
  function jobEventHook(jobId: string) {
    return (ev: AnalyzeEvent) => {
      emitJobEvent(jobId, ev);
      if (ev.type === "observation" && ev.observation) {
        // ADAAAA-6851 Inc 1: durable write-through so per-frame perceive data
        // survives a server restart (memory is updated synchronously first).
        store
          .recordObservation(jobId, {
            seq: ev.seq,
            timestamp: ev.timestamp,
            tracks: ev.observation.tracks,
          })
          .catch((e: any) => console.error(`[obs:${jobId}] persist failed:`, e?.message || e));
      }
    };
  }
  // Emit + persist a job progress update (ADAAAA-6760). Fanned over the SAME
  // jobEventHook/SSE channel as other job events (an additive `progress` event),
  // so an open LiveConsole gets sub-second updates; the job record carries the
  // latest value for the polling backstop. Best-effort: a failed persist never
  // stops the (already dispatched) job.
  function emitJobProgress(jobId: string, progress: number, label: string) {
    store
      .patchJob(jobId, { progress, progressLabel: label })
      .catch((e: any) => console.error(`[vod:${jobId}] progress persist failed:`, String(e?.message || e)));
    emitJobEvent(jobId, { type: "progress", progress, progressLabel: label } as any);
  }
  // ADAAAA-6851 Inc 2: durable write-through for every decide evaluation
  // (accepted highlight, burst-suppressed, near-miss, not-highlight). Wired into
  // the AnalyzerConfig `onDecision` hook for both the live and VOD passes.
  const persistDecision = (cand: JobCandidate): void => {
    store.recordJobCandidate(cand).catch((e: any) =>
      console.error(`[decide-note:${cand.jobId}] persist failed:`, e?.message || e)
    );
  };

  // --- LLM job title (ADAAAA-6798 Inc 1) ------------------------------------
  // Title helpers live in ./job-title so the exactly-one-call / fallback /
  // non-blocking logic is unit-testable without driving the pipeline. Here we
  // only invoke it fire-and-forget at each completion point. `GET /jobs` /
  // `GET /jobs/:id` / `GET /jobs/:id/detail` return the title (it rides the Job
  // object), and title generation NEVER blocks or fails the job.

  // ADAAAA-7028 Inc 2: durable write-through of the decide audit descriptor
  // (group identity, prompt text, media hashes, raw reply, verdicts, timings)
  // into the decide_audit index, with the retention cap enforced on the write
  // path. Best-effort: never a pipeline failure.
  const persistDecideAudit = (desc: unknown): void => {
    recordDecideAudit(db, desc, cfg.decideAuditRetention);
  };
  /**
   * ADAAAA-7741: stamp the job's content-clock anchor (`startedAt`) when a LIVE
   * ingest / browser share starts. VOD writes it on the worker claim; the live
   * paths never did, which left `liveProgress.lagSec` with no wall anchor to
   * measure against (the read path would have to infer it, conservatively, from
   * the summary log's first `ts`/`windowTs` pair). Metadata only — no compute, no
   * decide call, and idempotent: a reconnect/re-fetch never moves the anchor.
   */
  async function stampContentClockStart(jobId: string): Promise<void> {
    const job = store.getJob(jobId);
    if (!job || job.startedAt) return;
    await store.patchJob(jobId, { startedAt: new Date().toISOString() }).catch((e: any) =>
      console.error(`[live-progress:${jobId}] startedAt stamp failed:`, String(e?.message || e))
    );
  }
  async function runLiveJob(
    ingest: LiveIngest,
    job: { id: string; gameHint?: string; preferLabels?: string[] },
    user: any,
    sub: any
  ) {
    // ADAAAA-7670: paid-perceive clock for the completed record's costUsd —
    // the live path never recorded one, so live inference spend could not be
    // attributed to a node (or counted by /admin/monitoring) at all.
    const t0 = Date.now();
    try {
      // Reserve ONE perceive session for this live job, shared by the video
      // /analyze leg and the Stage-A audio /audio tap (INC-2 / ADAAAA-4325) so
      // both mark candidates on the same live session. analyzeJob() receives it
      // as `initialSession` and stops it (and any re-reserves) in its finally.
      const initial = await adapter.reservePerceive();
      // ADAAAA-6561: track this job's current perceive session so the stop path
      // can release the slot synchronously (see /jobs/:id/stop). `slot.stopped`
      // is flipped by the stop route to stop analyzeJob re-reserving a fresh
      // session once the slot has been released. `current` is kept up to date
      // on every re-reserve via the slotRef.onReserve hook.
      const slot = { current: initial, stopped: false };
      livePerceiveSlots.set(job.id, slot);
      // ADAAAA-7247 (ACC-7): resolve the webui-configured (DB-persisted) per-company
      // clip window — it wins over the bare env default at assembly.
      const cw = await resolveClipWindow();
      // Bind `ingest.cut` (it reads `this.cfg`): analyzeJob and the observer
      // receive it as a plain function reference, so an unbound method loses
      // `this` and throws (job->failed) the moment a highlight needs a clip.
      const cut = (ts: number) => ingest.cut(ts);
      const anaCfg: AnalyzerConfig = buildLiveAnalyzerConfig({
        cfg,
        job,
        clipWindow: cw,
        // ADAAAA-6851 Inc 2: persist every decide evaluation durably.
        onDecision: persistDecision,
        // ADAAAA-7028 Inc 2: ingest the decide audit descriptor durably.
        onDecideAudit: persistDecideAudit,
        // ADAAAA-7111 (Increment D): maintain the job's running video summary
        // (story-so-far) across cadence observe ticks — read it to carry into
        // the decide request, persist the updated one for the job-detail UI.
        getRunningSummary: () => store.getJob(job.id)?.runningSummary ?? "",
        onRunningSummary: (summary, meta) =>
          appendSummaryEntry(store, job.id, summary, meta).catch((e: any) =>
            console.error(`[running-summary:${job.id}] persist failed:`, String(e?.message || e))
          ),
      });
      // Persist + publish each accepted highlight at DECISION time, not at
      // session end, so the user's feed streams highlights continuously while
      // the live session runs (ADAAAA-5777). jobEventHook fans the same event
      // to the live-console SSE subscribers; the `highlight` branch additionally
      // write-throughs the record (store memory + DB) and bills/debits exactly
      // once. Best-effort: a failed persist logs and never stalls the live
      // frame loop, so the stream keeps identifying highlights regardless.
      const onEvent = (ev: AnalyzeEvent) => {
        jobEventHook(job.id)(ev);
        if (ev.type === "highlight" && ev.highlight) {
          persistLiveHighlight({ store, cfg, billing, entitlements, db }, user, sub, ev.highlight).catch((e) =>
            console.error(`[live:${job.id}] persist highlight ${ev.highlight?.id} failed:`, e?.message || e)
          );
        }
      };
      // Shared live-run context (INC-2 / ADAAAA-4325 slice 4): the video
      // /analyze leg and the audio tap leg both feed their frames + evidence
      // into this so an audio-triggered candidate can be decided on the
      // anchored video frame, exactly like a video candidate.
      // ADAAAA-7671: retain LIVE_AUDIO_RETAIN_S of tapped audio (20 s) so a
      // window's whole 10 s span + margins survives even when the decide loop
      // lags the real-time tap.
      const shared = new LiveRunShared({ audioRetainS: LIVE_AUDIO_RETAIN_S });
      // Drive the audio tap (a second ffmpeg decoding 0:a:0 -> mono pcm_s16le)
      // in parallel with the video pass at ~10 Hz. Best-effort: a dropped
      // chunk or a stopped tap never aborts the video look. When the gate
      // fires, postAudio() returns the CandidateEvent and we route it through
      // decide() on the anchored frame — the gate itself never decides, and
      // this path bills no GPU for the gate. The loop ends when ingest.stop()
      // (below) kills the audio ffmpeg.
      const audioLoop = (async () => {
        try {
          for await (const chunk of ingest.audioChunks()) {
            // Buffer the raw mono PCM chunk into the shared live-run context so
            // an audio-triggered candidate can assemble the AROUND audio clip
            // for Gemma (ADAAAA-4785: video + audio frame analysis per trigger).
            shared.addAudioChunk(chunk.timestamp, chunk.samples);
            try {
              // Perceive audio gate is a DATA SEEDER (audio level curve context)
              // and never a decide trigger (ADAAAA-7008). The decide-observer
              // drives decide on the ~3 s cadence regardless, so the audio
              // candidate (if any) is provenance-only now — no candidate-gated
              // decide. The bounded (t, energy, baseline) inspection series also
              // rides the response (ADAAAA-7255) for the graph.
              const res = await adapter.postAudio(initial.sessionId, {
                seq: chunk.seq,
                timestamp: chunk.timestamp,
                samples: chunk.samples,
                streamId: job.id,
              });
              if (res?.series?.length) shared.setAudioSeries(res.series);
              // ADAAAA-7707: the perceive `whistle` block is the Stage-B fire and
              // it WINS over the generic candidate on the same chunk (perceive
              // puts the whistle in the candidate slot too, and the tone onset is
              // also a Stage-A level rise — the whistle is the more precise
              // anchor). One fire = one anchored window; the 2.5 s coalesce in
              // audio-trigger.ts stays the anti-storm bound. `audioTriggerFromWhistle`
              // returns null while the emit switch is off, so the config-only
              // rollback leaves this wiring inert.
              const whistleTrig = audioTriggerFromWhistle(res?.whistle);
              if (whistleTrig) {
                shared.recordAudioTrigger(whistleTrig);
              } else if (res?.candidate?.audio) {
                // ADAAAA-7658: a fired audio trigger anchors ONE decide window at
                // the onset (the live decide-observer drains these each frame).
                // Provenance for the window, never a decision by itself.
                const trig = audioTriggerFromCandidate(res.candidate as any);
                if (trig) shared.recordAudioTrigger(trig);
              }
            } catch {
              /* gate is best-effort — keep going */
            }
          }
        } catch {
          /* tap never started or ended early — video leg unaffected */
        }
      })();

      const outcome = await analyzeJob(adapter, ingest.frames(), cut, anaCfg, onEvent, initial, shared, {
        onReserve: (res) => {
          slot.current = res;
        },
        isStopped: () => slot.stopped,
      });
      // Terminate ingest (kills both ffmpeg procs); the audio tap drains and
      // the loop resolves any in-flight candidates. Highlights from BOTH legs
      // (video + audio) were already persisted + billed at DECISION time via
      // the onEvent `highlight` hook above — nothing to re-persist here.
      await ingest.stop();
      await audioLoop;
      // Durable Stage-A FP-rate + latency metric (INC-2 / ADAAAA-4325 slice 5):
      // snapshotted onto the job so the noise-trigger cost bound (<= 60% of
      // audio candidates rejected by Gemma) is inspectable/queryable post-run.
      const stageA = shared.stageA.snapshot();
      // ADAAAA-7667: the live pass wrote `observeMetrics` but never the
      // candidate counters, so a live job that accepted highlights persisted
      // `candidatesTriggered: 0` / `candidatePath: "none"` (and, before
      // ADAAAA-7624, no path at all) and the job-detail "Candidates" header
      // read 0 next to a non-zero Decide-calls header. Persist the counters the
      // observe pass produced here, exactly like the VOD completion patch, using
      // the store's DEDUPED highlight count for the job so overlapping live
      // windows cannot re-count one play (the accepted tally is the fallback
      // when no highlight landed yet — see job-counters.ts).
      // ADAAAA-7670: also record the live job's inference cost the way the VOD
      // path does (decide fee × decide calls + perceive seconds at list price).
      // Before this the live path wrote no `costUsd`/`perceiveSessionS`, so live
      // spend could not be attributed to a node at all and `/admin/monitoring`
      // silently excluded it. Decide calls come from the observe pass (the only
      // decide path a live job has; absent => 0 recorded calls).
      const perceiveSessionS = (Date.now() - t0) / 1000;
      const liveDecideCalls = outcome.observeMetrics?.decideCalls ?? 0;
      const liveCostUsd = cfg.decideFee * liveDecideCalls + (perceiveSessionS / 3600) * PERCEIVE_PER_HOUR_USD;
      await store.patchJob(job.id, {
        status: "done",
        perceiveSessionId: outcome.sessionId,
        perceiveSessionS: Number(perceiveSessionS.toFixed(1)),
        // ADAAAA-7722: measured live watch-minutes for this session (the live
        // rail's own session clock), so the ADAAAA-7713 envelope ceiling can be
        // read as a measurement instead of a continuous-attachment assumption.
        liveWatchMinutes: Number((perceiveSessionS / 60).toFixed(3)),
        costUsd: Number(liveCostUsd.toFixed(4)),
        // ADAAAA-7624/7667: Stage-A status + the live candidate counters.
        ...completedLiveCounterFields(stageA, outcome.observeMetrics, store.highlightsForJob(job.id).length),
        // ADAAAA-7011: cadence + decide gemma E2E latency snapshot from the live
        // decide-observer, so the Livepeer runner shows the ~30 s budget
        // utilization. Absent when the observer was not enabled.
        // ADAAAA-7664: the observer owns the decide count for a live job, so
        // mirror it onto the job-level `decideCalls` field (only the VOD path
        // used to write it). Without this, a live job with 17 real decides
        // reported `decideCalls: null` and the job-detail header read 0.
        ...(outcome.observeMetrics
          ? { observeMetrics: outcome.observeMetrics, decideCalls: outcome.observeMetrics.decideCalls }
          : {}),
      });
      // ADAAAA-6798 Inc 1: generate the LLM job title once the job reaches
      // `done` (fire-and-forget; fallback title on any failure; never blocks).
      void applyJobTitle(store, cfg, job.id);
      // ADAAAA-7670: if the media node was unreachable when the ingest started,
      // retry the attribution once now that the spend is settled. Idempotent —
      // an existing row keeps the node that carried the stream.
      await attributeLiveIngest({
        db,
        mediaServerUrl: cfg.mediaServerUrl,
        jobId: job.id,
        source: store.getJob(job.id)?.source,
      }).catch(() => {});
      const stageALine = stageAEvidenceLine("live", job.id, stageA);
      if (stageALine) console.log(stageALine);
      // ADAAAA-7707: the Stage-B crowding guardrail, printed on every live
      // completion so the ADAAAA-7713 whistle-share tripwire is measurable from
      // the server log alone (fires / decides / share / decideCalls).
      const whistleLine = whistleEvidenceLine("live", job.id, outcome.observeMetrics);
      if (whistleLine) console.log(whistleLine);
    } catch (e) {
      await markJobFailed(job.id, e);
      console.error(`[live:${job.id}]`, e);
    } finally {
      await ingest.stop();
      liveSessions.delete(job.id);
      livePerceiveSlots.delete(job.id);
    }
  }

  // Run a VOD `file` job through the standard extractFrames -> analyzeJob ->
  // clip pipeline, storing generated highlights + clips. Shared by the server
  // path/URL POST /jobs route and the browser-upload POST /jobs/upload route so
  // both feed identical compute and quota/billing side effects.

  //
  // ADAAAA-4954 (detail-first build): the VOD pass now runs its decide pass in
  // a SHARED LiveRunShared (exactly like the live path) and feeds audio through
  // the Stage-A noise-change gate (/audio, pure DSP — no GPU) via a second
  // ffmpeg decode of the file's audio track. It persists job.stageAMetrics and
  // the per-video cost/volume fields (§4.5) so the FP-rate + budget gate are
  // measured on VOD exactly as on live. The GPU eval run itself is spend-gated
  // (PO budget-gate approval); this only wires + records the compute.
  /**
   * ADAAAA-6694: ride out a momentary `503 no capacity available for runner`
   * on the capacity-1 perceive slot instead of failing the VOD job instantly.
   * reservePerceive() itself already retries 4x (~4s) for the transient; this
   * wraps it in a bounded exponential backoff over the WHOLE reserve so a VOD
   * submitted while another job holds the slot stays `active`/queued and
   * eventually processes once the slot frees. The job is already `active` when
   * runVodJob starts, so it reads as processing/queued while we wait. If the
   * slot is STILL unavailable after the bounded window (e.g. a genuinely stuck
   * session), throw so the job fails loudly with a clear message instead of
   * hanging forever.
   */
  async function reservePerceiveWithBackoff(jobId?: string) {
    const maxMs = cfg.vodReserveRetryTotalMs;
    const t0 = Date.now();
    for (let attempt = 0; ; attempt++) {
      // ADAAAA-6625: a stop while queued for capacity must not keep retrying —
      // otherwise the pass reserves a session for a job the operator cancelled.
      if (jobId && isVodStopped(jobId)) throw new VodCancelledError(jobId);
      try {
        return await adapter.reservePerceive();
      } catch (e: any) {
        const msg = String(e?.message || e);
        // Only the no-capacity transient is ride-out; any other reserve failure
        // (402 payment, network, 4xx/5xx) should surface immediately.
        if (!/no capacity available for runner/i.test(msg)) throw e;
        if (Date.now() - t0 >= maxMs) throw e;
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // ADAAAA-6781: persist the server-side error text (truncated) on a failed
  // job so GET /jobs / GET /jobs/:id and the webapp processing-jobs surface
  // render the real reason instead of the generic client string. `error` lives
  // on the shared Job contract (packages/events); patchJob writes it through to
  // the durable record. Shared by the runLiveJob + all VOD failure paths.
  // ADAAAA-7700: durable activity-log row for a job lifecycle transition. The
  // Store is in-memory (hydrated from `jobs`), so the ATTRIBUTION of a failure
  // would otherwise live only in the JSON blob; this row is the append-only
  // activity trail an operator/QA can read back with GET /jobs/:id/lifecycle.
  function recordJobLifecycle(jobId: string, kind: string, detail: string): Promise<void> {
    return db.appendJobLifecycleEvent({ jobId, kind, detail }).catch((e: any) => {
      console.error(`[activity:${jobId}] ${kind} persist failed:`, String(e?.message || e));
    });
  }
  const JOB_ERROR_MAX_CHARS = 500;
  function jobErrorMessage(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    return raw.trim().slice(0, JOB_ERROR_MAX_CHARS);
  }
  async function markJobFailed(jobId: string, e: unknown): Promise<void> {
    try {
      // ADAAAA-6625: `cancelled` is terminal and operator-visible. The stop
      // path releases the perceive session, which makes the in-flight /analyze
      // fail session-lost; that late error must never rewrite a stopped job as
      // `failed` (or resurrect it from `done`).
      if (isVodStopped(jobId) || store.getJob(jobId)?.status === "cancelled") return;
      // ADAAAA-7700: a thrown pipeline error is attributable too — never leave a
      // bare `failed` that reads the same as "the pipeline never ran".
      await store.patchJob(jobId, { status: "failed", error: jobErrorMessage(e), failureReason: "pipeline-error" });
      await recordJobLifecycle(jobId, "failed", `failureReason=pipeline-error error=${jobErrorMessage(e)}`);
    } catch {
      /* ignore — job record gone */
    }
  }

  /** ADAAAA-6625: release every Livepeer perceive session a VOD `file` job
   * holds, SYNCHRONOUSLY from the stop path (same contract as the live path's
   * ADAAAA-6561 release). analyzeJob's `finally` re-leases as a no-op, so this
   * never double-stops. Media-row reconciliation is included: a VOD job does
   * not normally open a media session, but a legacy/odd row must not survive
   * the stop at status=active. Returns the session ids released. */
  async function releaseVodPerceive(jobId: string): Promise<string[]> {
    const slot = livePerceiveSlots.get(jobId);
    if (slot) {
      // Delete before awaiting the stop so a concurrently-reserved session
      // cannot re-register this job as live.
      livePerceiveSlots.delete(jobId);
      slot.stopped = true;
    }
    const ids = new Set<string>();
    if (slot?.current?.sessionId) ids.add(slot.current.sessionId);
    const cur = store.getJob(jobId);
    if (cur?.perceiveSessionId) ids.add(cur.perceiveSessionId);
    for (const sid of ids) await adapter.stopPerceive(sid).catch(() => {});
    await db.clearMediaSession(jobId).catch(() => {});
    return [...ids];
  }

  /** ADAAAA-6625: move a VOD job to the terminal `cancelled` state. Idempotent
   * and never overwrites `done`/`failed`. Called synchronously from the stop
   * route so the row is terminal the moment the caller gets its response —
   * even if the in-flight pass is still unwinding (or the process dies first). */
  async function markJobCancelled(jobId: string, progressLabel = "cancelled"): Promise<void> {
    const cur = store.getJob(jobId);
    if (!cur) return;
    if (cur.status === "done" || cur.status === "failed") return;
    try {
      await store.patchJob(jobId, {
        status: "cancelled",
        stage: "cancelled",
        progressLabel,
        finishedAt: cur.finishedAt ?? new Date().toISOString(),
      });
      // Wake any open LiveConsole/SSE consumer on the terminal transition.
      emitJobEvent(jobId, {
        seq: -1,
        timestamp: -1,
        type: "progress",
        progress: cur.progress ?? 0,
        progressLabel,
      } as any);
    } catch (e: any) {
      console.error(`[vod:${jobId}] cancel persist failed:`, String(e?.message || e));
    }
  }

  // ADAAAA-7325: the capacity-1 perceive runner's SessionRegistry fills
  // transiently (orphaned server-side session ids), and reservePerceive /
  // provisionMedia surface it as "no capacity available for runner" (HTTP 503).
  // That is RETRYABLE — the client/server should back off, not treat it as a
  // server bug. Map it to 503 in the /jobs/:id/ingest and /jobs/:id/media
  // routes so the client can back off; every other error stays 500.
  function isCapacityExhaustion(e: any): boolean {
    const msg = String(e?.message ?? e ?? "");
    return /no capacity available for runner/i.test(msg)
      || e?.statusCode === 503
      || e?.status === 503;
  }
  function mediaErrorStatus(e: any): number {
    return isCapacityExhaustion(e) ? 503 : 500;
  }

  async function runVodJob(job: { id: string; gameHint?: string; preferLabels?: string[] }, videoPath: string, user: any, sub: any) {
    const jobId = job.id;
    const scheduledAt = new Date().toISOString();
    // ADAAAA-6625: a stop that landed before the worker claimed this job wins.
    // Never start (or resume) compute for an already-cancelled row.
    const queuedAtClaim = store.getJob(jobId);
    if (isVodStopped(jobId) || queuedAtClaim?.status === "cancelled" || Store.isTerminalStatus(queuedAtClaim?.status ?? "queued")) {
      throw new VodCancelledError(jobId);
    }
    // Abort handle for the decode + frame loop of this pass; the stop route
    // aborts it (processVodJob's finally clears it).
    const stopCtl = new AbortController();
    vodStopControllers.set(jobId, stopCtl);
    // ADAAAA-7247 (ACC-7): resolve the webui-configured (DB-persisted) per-company
    // clip window once for this job — it wins over the bare env default at
    // assembly (shared by anaCfg and the VOD cut closure below).
    const cw = await resolveClipWindow();
    // Durable lifecycle (ADAAAA-6873): claim the job off the request path and
    // persist the extracting transition so status + progress survive a
    // refresh/restart. `attempts` increments on every re-claim so a restart
    // resumes exactly once and the idempotent onEvent never re-debits quota.
    const prior = store.getJob(jobId);
    await store.patchJob(jobId, {
      status: "extracting",
      stage: "extracting",
      startedAt: new Date().toISOString(),
      attempts: (prior?.attempts ?? 0) + 1,
    });
    emitJobProgress(jobId, 0, "extracting frames");
    const anaCfg: AnalyzerConfig = {
      jobId,
      clipBeforeS: cw.clipBeforeS,
      clipAfterS: cw.clipAfterS,
      clipWindowMinSec: cw.clipWindowMinSec,
      gameHint: job.gameHint || cfg.gameHintDefault,
      preferLabels: job.preferLabels,
      // ADAAAA-7399: VOD must wire `audioContext` so the decide-observer's
      // `buildObserveDecideRequest` slices the tapped window-aligned audio
      // (and Stage-1 audio levels) instead of gating it off. The VOD tap
      // (vod-audio.ts extractVodAudioChunks) feeds the shared window; with the
      // config unset here, `cfg.audioContext` is undefined and every VOD window
      // persisted `audio.path:"none"` / empty `asr.transcript`. Mirrors the live
      // path (audioContext: cfg.audioContext).
      audioContext: cfg.audioContext,
      // ADAAAA-6577: bounded exponential backoff between a perceive session-
      // lost re-reserve and the retry of the same frame (shared analyzeJob
      // loop; default 500ms base / 8000ms cap).
      sessionRetryBackoffMs: cfg.vodSessionRetryBackoffMs,
      sessionRetryBackoffMaxMs: cfg.vodSessionRetryBackoffMaxMs,
      // Detail-first knobs (ADAAAA-4954): deeper than live (3 fps / 640p / 24
      // frame window). Opt into the temporal frames[] + audio decide payload.
      sampleFps: cfg.vodDetailFps,
      frameScale: cfg.vodFrameScale,
      decideWindowN: cfg.vodDecideWindowN,
      // ADAAAA-7007/7011: drive the VOD decide-observer on the detail-first pass
      // (config-gated). When on, decide runs on the ~3 s cadence regardless of
      // whether perceive emitted a candidate.
      observeLoop: cfg.observeLoop,
      // ADAAAA-7145: gate the VOD decide-observer's billable decide calls on a
      // real highlight signal (recall-safe). Wired so box QA can enable it once
      // the perceive goal-line/homography channels are configured.
      observeSignalGate: cfg.observeSignalGate,
      observeSignalGateOpts: buildObserveSignalGateOpts(cfg),
      // ADAAAA-7152 Gap 1: adaptive perceive cadence for the VOD detail-first
      // pass — cut the per-frame perceive cost in cool regions while keeping the
      // escalated goal window fully perceived. Auto-on with the gated observe
      // loop; tunable via PERCEIVE_* (see config.ts).
      perceiveCadence: cfg.perceiveCadence,
      perceiveQuietStride: cfg.perceiveQuietStride,
      perceiveHotAfterS: cfg.perceiveHotAfterS,
      // ADAAAA-7152 (Gap 2): per-camera pitch calibration (homography 3x3 +
      // goalLine) the server forwards to the perceive session via the
      // `configure` control so perceive emits a REAL goalCrossed/ballOutcome
      // attestation (a `scoring_play` accept). Resolved from the server's
      // `perceiveCalibration` map by camera id; absent => no `configure` sent,
      // the session stays uncalibrated (recall-safe, unchanged). Never
      // fabricated — only explicit per-camera config is carried here.
      perceiveCalibration: resolvePerceiveCalibration(cfg.perceiveCalibration, (job as any).cameraId),
      // Increment D (ADAAAA-6467): the what-to-track planner's warm-up window
      // + out-of-band re-check cadence on the VOD pass (cap 8).
      warmupSeconds: cfg.warmupSeconds,
      recheckIntervalSeconds: cfg.recheckIntervalSeconds,
      planMode: "vod",
      // ADAAAA-6851 Inc 2: persist every decide evaluation durably.
      onDecision: persistDecision,
      onDecideAudit: persistDecideAudit,
      // ADAAAA-7111 (Increment D): maintain the job's running video summary
      // (story-so-far) across cadence observe ticks — read it to carry into the
      // decide request, persist the updated one for the job-detail UI.
      getRunningSummary: () => store.getJob(jobId)?.runningSummary ?? "",
      onRunningSummary: (summary, meta) =>
        appendSummaryEntry(store, jobId, summary, meta).catch((e: any) =>
          console.error(`[running-summary:${jobId}] persist failed:`, String(e?.message || e))
        ),
      // Increment F / ADAAAA-6465: VOD gets the HIGHER-cap / longer-window
      // detail-first frame-sequence assembly (speed secondary; detail-first).
      analysisFps: cfg.vodAnalysisFps,
      maxFramesPerAnalysis: cfg.vodMaxFramesPerAnalysis,
      preWindowS: cfg.vodAnalysisPreWindowS,
      postWindowS: cfg.vodAnalysisPostWindowS,
      // ADAAAA-6489 / ADAAAA-7159 Gap 2: deliver this VOD clip's per-camera/
      // per-clip goal-line calibration to the perceive session so the goal-line
      // signal (goalCrossed/ballOutcome) is real. Absent -> perceive emits no
      // ballOutcome and the metric reports not_captured (never a fabricated
      // signal). Keyed by job id, then the clip filename/source, then `default`
      // (ADAAAA-7163 Blocker 1).
      calibration: resolveGoalLineCalibration(cfg, [jobId, stableClipCalibrationKey(videoPath)]),
      // ADAAAA-6797: Stage-2 goal/near-miss confirmation pass. ADAAAA-7663: the
      // live pass builds the same gate through `buildLiveAnalyzerConfig`, so
      // `DECIDE_CONFIRM_ENABLED` now covers both passes; off is a strict no-op
      // on both. VOD keys exactly-once on the goal's content time (no reuse
      // window), which is unchanged.
      confirmEnabled: cfg.decideConfirmEnabled,
      confirmWindowExtraS: cfg.decideConfirmExtraWindowS,
    };
    // Count candidates (video + audio) for the recorded decide/cost fields.
    let candidatesTriggered = 0;
    // ADAAAA-6870 (Increment 3 T1): accumulate the live decision trail as a
    // bounded ordered `candidates` array on the job record (candidate trigger ->
    // accepted highlight). Appended here via the onEvent hook and persisted with
    // a throttled `patchJob` (mirroring the progress emitter — NOT per-frame:
    // candidates/highlights are sparse scoring plays). This both feeds the
    // in-flight SSE view (jobEventHook already fans the raw events) and survives
    // a server restart on the completed job.
    const jobTrail: JobDecision[] = [];
    const MAX_TRAIL = 500;
    const TRAIL_FLUSH_MS = 500;
    let trailDirty = false;
    let lastTrailFlush = 0;
    const flushTrail = () => {
      if (!trailDirty) return;
      trailDirty = false;
      // Bound the array (oldest-first trim) so it cannot grow without bound.
      while (jobTrail.length > MAX_TRAIL) jobTrail.shift();
      store
        .patchJob(jobId, { candidates: [...jobTrail] })
        .catch((e: any) => console.error(`[vod:${jobId}] candidate trail persist failed:`, e?.message || e));
    };
    const scheduleTrailFlush = () => {
      trailDirty = true;
      const now = Date.now();
      if (now - lastTrailFlush >= TRAIL_FLUSH_MS) {
        lastTrailFlush = now;
        flushTrail();
      } else {
        setTimeout(() => {
          if (!trailDirty) return;
          lastTrailFlush = Date.now();
          flushTrail();
        }, TRAIL_FLUSH_MS - (now - lastTrailFlush));
      }
    };
    // ADAAAA-7135 (two-tier): record ONLY confirmed highlights into the durable
    // `job.candidates` trail. A raw `candidate` trigger is a Tier-1 watch
    // hypothesis — the tracker labels the fast-strike MOVE/KILL primitive as
    // GOAL via `sport_specific_event_type` on essentially every soccer frame —
    // so persisting it as `{decision:"candidate"}` is what produced the
    // 168-candidate / all-GOAL trail flood. Candidate triggers still fan out
    // live over the SSE `baseHook` (the in-flight note stream) but are never
    // written as a decision. `candidatesTriggered` below keeps counting raw
    // candidate triggers solely for the decide/cost accounting. `decision`
    // equals `highlight.outcome ?? status` (accepted / near_miss / ...).
    const recordTrailDecision = (ev: AnalyzeEvent) => {
      const entry = trailDecisionFromEvent(ev);
      if (!entry) return;
      jobTrail.push(entry);
      scheduleTrailFlush();
    };
    const baseHook = jobEventHook(jobId);

    // Durable idempotent resume (ADAAAA-6873): highlights already persisted for
    // this job are NOT re-added and their quota is NOT re-debited, so a stale
    // re-claim (restart) never duplicates a clip or double-charges. ADAAAA-7118:
    // the onEvent dedup guard is keyed on the SAME highlightIdempotencyKey that
    // store.addHighlight uses (hl:<jobId>:<seq>:<eventType>) via
    // highlightDedupKey, so a candidate that emits two `highlight` events with an
    // identical idempotency key (e.g. the GOAL anchor at the same seq) increments
    // highlightsFound exactly once and the live counter matches the persisted
    // count during processing. Legacy rows without an idempotencyKey fall back to
    // the start|eventType form so resume protection still holds for them.
    const existingHl = new Set(store.highlightsForJob(jobId).map(highlightDedupKey));

    // Throttled, monotonic progress persistence (ADAAAA-6873). We persist at most
    // once per second (or force on a highlight/terminal write) and never let
    // framesAnalyzed/framesPct regress, so a resume from a lower watermark can
    // only move progress forward. `framesTotal` is filled in after frame
    // extraction below.
    let lastProgressAt = 0;
    let framesTotal = 0;
    const persistProgress = async (framesAnalyzed: number, force = false) => {
      // ADAAAA-6625: a cancelled row is terminal — never resurrect it to
      // `analyzing` from a late progress write during unwinding.
      if (isVodStopped(jobId)) return;
      const now = Date.now();
      if (!force && now - lastProgressAt < 1000) return;
      lastProgressAt = now;
      const cur = store.getJob(jobId);
      if (!cur || cur.status === "cancelled") return;
      if ((cur?.framesAnalyzed ?? 0) >= framesAnalyzed) return; // never regress
      const pct = framesTotal > 0 ? Math.min(100, Math.round((framesAnalyzed / framesTotal) * 100)) : 0;
      await store.patchJobProgress(jobId, {
        status: "analyzing",
        stage: "analyzing",
        framesAnalyzed,
        framesTotal,
        framesPct: pct,
        // ADAAAA-7118: surface the live highlight count as the ABSOLUTE
        // persisted count from the store (source of truth), never a local
        // tally, so highlightsFound always equals what addHighlight persisted
        // during processing (a same-idempotency-key double-emit counts once).
        highlightsFound: store.highlightsForJob(jobId).length,
        progress: Math.min(100, Math.max(1, pct)),
        progressLabel: `analyzing (frame ${framesAnalyzed}/${framesTotal})`,
      });
      emitJobEvent(jobId, {
        type: "progress",
        progress: Math.min(100, Math.max(1, pct)),
        progressLabel: `analyzing (frame ${framesAnalyzed}/${framesTotal})`,
      } as any);
    };

    const onEvent: (ev: AnalyzeEvent) => void = (ev) => {
      // ADAAAA-6625: after a stop, never bill/persist a highlight from a frame
      // that was already in flight when the operator cancelled the job.
      if (isVodStopped(jobId) && ev.type === "highlight") return;
      if (ev.type === "candidate") {
        candidatesTriggered++;
        recordTrailDecision(ev);
        baseHook(ev);
        return;
      }
      // ADAAAA-6851 Inc 2/3: record the decision trail for accepted highlights
      // too (the per-job detail panel reads accepted/rejected/suppressed notes).
      if (ev.type === "highlight") recordTrailDecision(ev);
      // ADAAAA-6352: persist + bill + quota-debit each accepted highlight at
      // DECISION time (mirror the live publish-at-decision ADAAAA-5777) via the
      // same write-through helper. jobEventHook already fanned the `highlight`
      // event to SSE subscribers. ADAAAA-6873/7118: guard against double-persist
      // on a re-claim — a highlight whose highlightIdempotencyKey is already on
      // disk is skipped so its quota is never re-debited.
      if (ev.type === "highlight" && ev.highlight) {
        // ADAAAA-7118: dedup on the same highlightIdempotencyKey used by
        // store.addHighlight, so two `highlight` events carrying an identical
        // key (the GOAL anchor at the same seq) increment highlightsFound once,
        // matching the persisted count. Legacy highlights without an
        // idempotencyKey fall back to the start|eventType form.
        const key = highlightDedupKey(ev.highlight);
        if (existingHl.has(key)) {
          baseHook(ev);
          return; // already persisted on an earlier attempt — no re-debit
        }
        existingHl.add(key);
        persistLiveHighlight({ store, cfg, billing, entitlements, db }, user, sub, ev.highlight)
          .then(() => persistProgress(store.getJob(jobId)?.framesAnalyzed ?? 0, true))
          .catch((e) => console.error(`[vod:${jobId}] persist highlight ${ev.highlight?.id} failed:`, e?.message || e));
        baseHook(ev);
        return;
      }
      baseHook(ev);
    };
    const onProgress: (framesAnalyzed: number) => void = (n) => {
      persistProgress(n).catch((e) => console.error(`[vod:${jobId}] progress`, String(e?.message || e)));
    };
    const frameDir = path.join(cfg.dataDir, "frames", jobId);
    const sampleFps = cfg.vodDetailFps;
    emitJobProgress(jobId, 5, "extracting frames");
    await extractFrames(cfg.ffmpegPath, videoPath, frameDir, sampleFps, cfg.vodFrameScale, undefined, stopCtl.signal);
    // ADAAAA-6625: a stop during extraction aborts the decode; unwind here
    // instead of analyzing a frame set the operator just cancelled.
    if (isVodStopped(jobId)) throw new VodCancelledError(jobId);
    // I7 / ADAAAA-6361: re-sample a higher-FPS burst of frames around each
    // trigger so the ball-goal-crossing instant is present in the decide window
    // (the detail-first pass samples at `sampleFps`, which can skip it). Bounded:
    // only around trigger candidates, at the resample fps. Best-effort ([] on
    // failure) so a burst extraction glitch never aborts the pass.
    anaCfg.resampleFrames = async (ts: number) => {
      // ADAAAA-6625: no burst extraction (and no further frame writes) after a
      // stop — the pass is unwinding, the operator asked for it to end.
      if (isVodStopped(jobId)) return [];
      return extractBurstFrames(
        cfg.ffmpegPath,
        videoPath,
        path.join(frameDir, "bursts"),
        ts,
        cfg.vodResampleWindowS,
        cfg.vodResampleWindowS,
        cfg.vodResampleFps,
        cfg.vodFrameScale,
        stopCtl.signal
      );
    };

    const clipDir = path.join(cfg.dataDir, "clips");
    const cut = async (ts: number) => {
      // ADAAAA-6625: a stop in flight wins over a clip cut — never spend ffmpeg
      // encode time (or write a clip) for a cancelled pass.
      if (isVodStopped(jobId)) throw new VodCancelledError(jobId);
      emitJobProgress(jobId, 90, "cutting clips");
      const clipId = randomUUID();
      const out = path.join(clipDir, `${clipId}.mp4`);
      const win = clipWindow(ts, cw.clipBeforeS, cw.clipAfterS, cw.clipWindowMinSec);
      await cutClip(cfg.ffmpegPath, videoPath, out, win.start, win.end - win.start);
      return { clipId, clipUri: `/clips/${clipId}.mp4` };
    };
    // Async-VOD progress: wrap the frame iterator so analyzeJob's frame pull
    // drives a throttled `analyzing (frame i/N)` progress (ADAAAA-6760). We
    // count the pre-extracted frames for N, and emit ~every 25 frames / 500 ms
    // so the SSE overlay + polling stay within ~1s without spamming the store.
    const { readdir } = await import("node:fs/promises");
    let totalFrames = 0;
    try {
      totalFrames = (await readdir(frameDir)).filter((f) => f.startsWith("frame_")).length;
    } catch {
      totalFrames = 0;
    }
    // Durable framesTotal (ADAAAA-6873): the pre-extracted frame count, used by
    // the monotonic progress snapshot to derive framesPct.
    framesTotal = totalFrames;
    let processedFrames = 0;
    let lastProgressEmit = 0;
    const baseIter = buildAnalyzeFrames(frameDir, sampleFps)();
    const iter = (async function* () {
      for await (const f of baseIter) {
        processedFrames++;
        if (totalFrames > 0 && (processedFrames % 25 === 0 || Date.now() - lastProgressEmit >= 500)) {
          lastProgressEmit = Date.now();
          const pct = Math.round(20 + 69 * Math.min(1, processedFrames / totalFrames));
          emitJobProgress(jobId, pct, `analyzing (frame ${processedFrames}/${totalFrames})`);
        }
        yield f;
      }
    })();
    const t0 = Date.now();
    // Reserve ONE perceive session shared by the video /analyze leg and the
    // Stage-A audio /audio tap (same pattern as runLiveJob); analyzeJob stops
    // it (and any re-reserves) in its finally. The shared LiveRunShared is
    // passed so both legs anchor to the SAME frame window + evidence.
    // ADAAAA-6694: use the no-capacity backoff wrapper so a VOD submitted while
    // the capacity-1 perceive slot is held stays queued and eventually runs.
    const initial = await reservePerceiveWithBackoff(jobId);
    // ADAAAA-6625: a stop during the capacity wait wins — release nothing and
    // unwind (no session was reserved).
    if (isVodStopped(jobId)) throw new VodCancelledError(jobId);
    // ADAAAA-6694: track this VOD job's current perceive session so the stop
    // path can release the capacity-1 slot synchronously (mirroring the live
    // path ADAAAA-6561). `slot.stopped` is flipped by the stop route to stop
    // analyzeJob re-reserving a fresh session once the slot has been released.
    const slot = { current: initial, stopped: false };
    livePerceiveSlots.set(job.id, slot);
    const shared = new LiveRunShared({ decideWindowN: cfg.vodDecideWindowN, audioRetainS: cfg.vodAudioRetainS });
    // Drive the Stage-A audio tap from the VOD file's audio track in parallel
    // with the video pass. Best-effort: no audio track or a dropped chunk never
    // aborts the video look. When the gate fires, route the candidate through
    // decide() on the anchored frame + detail-first frames/audio — the gate
    // itself never decides and bills no GPU.
    const audioLoop = (async () => {
      try {
        for await (const chunk of extractVodAudioChunks(cfg.ffmpegPath, videoPath)) {
          // ADAAAA-6625: stop feeding /audio (and stop paying for it) the
          // moment the operator cancels. Breaking the generator reaps ffmpeg.
          if (isVodStopped(jobId)) break;
          shared.addAudioChunk(chunk.timestamp, chunk.samples);
          try {
            // Perceive audio gate is a DATA SEEDER (audio level curve context)
            // and never a decide trigger (ADAAAA-7008). The decide-observer
            // drives decide on the ~3 s cadence regardless, so the audio
            // candidate (if any) is provenance-only now — no candidate-gated
            // decide. The bounded (t, energy, baseline) inspection series also
            // rides the response (ADAAAA-7255) for the graph.
            const res = await adapter.postAudio(initial.sessionId, {
              seq: chunk.seq,
              timestamp: chunk.timestamp,
              samples: chunk.samples,
              streamId: jobId,
            });
            if (res?.series?.length) shared.setAudioSeries(res.series);
            // ADAAAA-7694: a fired Stage-A trigger enters the run's outcome
            // ledger so the VOD decide pass can record the verdict of the
            // window that judges its onset (`stageAMetrics` -> "measured").
            // The VOD rail never anchors a decide window to a trigger (there
            // is no frame ahead of the decode to anchor to) — measurement only.
            if (res?.candidate?.audio) {
              const trig = audioTriggerFromCandidate(res.candidate as any);
              if (trig) shared.recordAudioTrigger(trig);
            }
          } catch {
            /* gate best-effort — keep going */
          }
        }
      } catch {
        /* tap ended early — video leg unaffected */
      }
    })();
    let outcome: AnalyzeOutcome;
    try {
      // ADAAAA-6873: advance to analyzing + persist framesTotal (durable), then
      // pass the onProgress hook so the worker persists a throttled, monotonic
      // progress snapshot per frame (the `slotRef` drives the stop-path slot
      // release; onProgress is a trailing optional param).
      // ADAAAA-6625: a stop between extraction and the first frame must not
      // resurrect the terminal `cancelled` row as `analyzing`.
      if (isVodStopped(jobId)) throw new VodCancelledError(jobId);
      await store.patchJob(jobId, { status: "analyzing", stage: "analyzing", framesTotal });
      outcome = await analyzeJob(adapter, iter, cut, anaCfg, onEvent, initial, shared, {
        onReserve: (res) => {
          slot.current = res;
          // A stop that landed while analyzeJob re-reserved: release the fresh
          // session immediately instead of letting it bill until the loop ends.
          if (slot.stopped || isVodStopped(jobId)) void adapter.stopPerceive(res.sessionId).catch(() => {});
        },
        isStopped: () => slot.stopped || isVodStopped(jobId),
      }, onProgress);
    } finally {
      await audioLoop;
      livePerceiveSlots.delete(job.id);
    }
    // ADAAAA-6625: analyzeJob exits its loop when the slot is stopped, returning
    // a PARTIAL outcome. That must never be finalized as `done` — the stop
    // already owns the terminal state, so unwind as cancelled.
    if (isVodStopped(jobId) || slot.stopped) throw new VodCancelledError(jobId);
    // Every accepted highlight was already persisted + billed + quota-debited
    // at DECISION time by the onEvent `highlight` hook above (ADAAAA-6352),
    // mirroring the live path. The old end-of-job batch loop was removed so a
    // highlight is never re-persisted or double-billed here — the final HTTP
    // response / GET /jobs/:id reads the same store the decision-time writes
    // populated, so the full set is present once processing ends.
    const perceiveSessionS = (Date.now() - t0) / 1000;
    const stageA = shared.stageA.snapshot();
    // ADAAAA-6797: Stage-1 vs Stage-2 confirmation-pass metric (disagreement
    // rate = disagreed / totalRuns). The core value metric for the feature —
    // how often the deep frame dive corrects the primary read.
    const confirmTotal = shared.confirmMetrics.totalRuns;
    const confirmDisagreed = shared.confirmMetrics.disagreed;
    const confirmMetrics = {
      totalRuns: confirmTotal,
      disagreed: confirmDisagreed,
      gapRate: confirmTotal > 0 ? confirmDisagreed / confirmTotal : 0,
    };
    // ADAAAA-7007: under the observe architecture (CEO directive, ADAAAA-7000
    // rev 4) decide invocations are the cadence-driven observer calls
    // (`vodObserveMetrics.decideCalls`), NOT one per candidate — candidates are
    // recorded as bias hints / provenance, never the decide on/off gate. So the
    // per-job decide spend uses the observer's actual call count when the
    // observe path ran, and falls back to the legacy one-decide-per-candidate
    // count (decideCalls == candidatesTriggered) otherwise.
    const decideCalls = outcome.vodObserveMetrics?.decideCalls ?? candidatesTriggered;
    const costUsd = cfg.decideFee * decideCalls + (perceiveSessionS / 3600) * PERCEIVE_PER_HOUR_USD;
    // Source runtime (D-I2.2 / ADAAAA-6838): probe the media duration so the
    // completed result card can show it. Best-effort (ms; null on probe failure).
    const durationS = await probeDuration(cfg.ffmpegPath, videoPath).catch(() => null);
    // Durable finalizing transition (ADAAAA-6873 state machine) before done.
    await store.patchJob(jobId, { status: "finalizing", stage: "finalizing" });
    const doneFramesPct = framesTotal > 0 ? Math.min(100, Math.round((outcome.framesAnalyzed / framesTotal) * 100)) : 0;
    // ADAAAA-7624: the user-facing candidate count is the number of distinct
    // candidates this job actually produced (the persisted highlights), not the
    // observer's per-window `accepted` tally — overlapping decide windows
    // re-count the same play (75 windows vs 24 distinct highlights on
    // d61e52f6). Deriving it here keeps a new record identical to what the
    // read-time projection reports for a pre-fix record.
    const producedCandidates = store.highlightsForJob(jobId).length;
    await store.patchJob(jobId, {
      status: "done",
      stage: "done",
      perceiveSessionId: outcome.sessionId,
      // ADAAAA-7624: candidates are counted by the path that actually ran (the
      // observe cadence pass) and the Stage-A snapshot is only persisted when it
      // is a real measurement, so the completed record cannot report a
      // fabricated `0 candidates` / `0% FP` for a stage that never judged one.
      // `undefined` when the observe cadence never ran, so the legacy
      // perceive-gate counter is still the fallback path.
      ...completedCounterFields(stageA, outcome.vodObserveMetrics ? producedCandidates : undefined, candidatesTriggered),
      confirmMetrics,
      sampleFps,
      frameScale: cfg.vodFrameScale,
      decideWindowN: cfg.vodDecideWindowN,
      framesAnalyzed: outcome.framesAnalyzed,
      framesTotal,
      framesPct: doneFramesPct,
      // ADAAAA-7118: completed record surfaces the ABSOLUTE persisted highlight
      // count from the store (source of truth), matching what addHighlight wrote.
      highlightsFound: store.highlightsForJob(jobId).length,
      decideCalls,
      perceiveSessionS: Number(perceiveSessionS.toFixed(1)),
      costUsd: Number(costUsd.toFixed(4)),
      // ADAAAA-7007: VOD decide-observer per-call input-size + cap snapshot so
      // the acceptance criteria (<=30-frame cap exercised, per-call decide size,
      // -67% cost measure) are readable per job from the completed record.
      ...(outcome.vodObserveMetrics ? { vodObserveMetrics: outcome.vodObserveMetrics } : {}),
      scheduledAt,
      finishedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      progress: 100,
      progressLabel: "done",
      durationMs: durationS ? Math.round(durationS * 1000) : undefined,
      // ADAAAA-6870 (Increment 3 T1): persist the full decision trail on the
      // completed job record so it survives a server restart.
      candidates: [...jobTrail],
    });
    // ADAAAA-6798 Inc 1: generate the LLM job title once the job reaches `done`
    // (fire-and-forget; fallback title on any failure; never blocks the job).
    void applyJobTitle(store, cfg, jobId);
    emitJobProgress(jobId, 100, "done");
    const stageALine = stageAEvidenceLine(
      "vod",
      jobId,
      stageA,
      `, costUsd=${costUsd.toFixed(4)} (${decideCalls} decide @ $${cfg.decideFee}, ${perceiveSessionS.toFixed(0)}s perceive)`
    );
    if (stageALine) console.log(stageALine);
    if (confirmTotal > 0) {
      console.log(
        `[vod:${jobId}] stage2 confirm=${confirmTotal} run(s), disagreed=${confirmDisagreed}, ` +
          `disagreementRate=${confirmMetrics.gapRate.toFixed(3)}`
      );
    }
    return { job: store.getJob(jobId), framesAnalyzed: outcome.framesAnalyzed, costUsd, stageA };
  }

  // -------------------------------------------------------------------------
  // Durable VOD queue + worker (ADAAAA-6873). POST /jobs, /jobs/upload and
  // /jobs/upload/complete now enqueue a file/URL VOD job and return 202
  // immediately; a worker claims queued jobs and runs the pipeline off the
  // request path, so a refresh / disconnect / restart never abandons a job.
  // Non-terminal jobs left by a prior process are re-claimed on boot so
  // nothing is stranded (the persisted state machine makes the restart resume
  // exactly once, and the idempotent onEvent never re-debits quota).
  // -------------------------------------------------------------------------
  const vodJobPaths = new Map<string, string>(); // jobId -> videoPath
  const vodProcessing = new Set<string>(); // jobIds currently running
  const vodDraining = { running: false };

  function enqueueVodJob(jobId: string, videoPath: string): void {
    vodJobPaths.set(jobId, videoPath);
    // Fire-and-forget: kick the drain loop if it isn't already running.
    drainVodQueue().catch((e) => console.error(`[vod:${jobId}] drain`, e));
  }

  async function drainVodQueue(): Promise<void> {
    if (vodDraining.running) return;
    vodDraining.running = true;
    try {
      // Claim up to `vodWorkerConcurrency` queued jobs and run each off the
      // request path. When a claimed job finishes its finally re-kicks the
      // drain, so a newly-queued or remaining job is never left stranded.
      const queued = store
        .allJobs()
        .filter((j) => j.status === "queued" && !vodProcessing.has(j.id) && !isVodStopped(j.id))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      for (const job of queued.slice(0, cfg.vodWorkerConcurrency)) {
        const videoPath = vodJobPaths.get(job.id) ?? job.sourceUrl;
        if (!videoPath) continue;
        vodProcessing.add(job.id);
        processVodJob(job.id, videoPath)
          .catch((e) => console.error(`[vod:${job.id}] worker`, e))
          .finally(() => {
            vodProcessing.delete(job.id);
            drainVodQueue().catch(() => {});
          });
      }
    } finally {
      vodDraining.running = false;
    }
  }

  async function processVodJob(jobId: string, videoPath: string): Promise<void> {
    const job = store.getJob(jobId);
    if (!job) return;
    // ADAAAA-6625: never start (or resume) a pass the operator already stopped.
    if (job.status === "cancelled" || isVodStopped(jobId)) return;
    const user = job.ownerId ? await db.getUserById(job.ownerId) : undefined;
    if (!user) {
      await store
        .patchJob(jobId, { status: "failed", stage: "failed", finishedAt: new Date().toISOString() })
        .catch(() => {});
      return;
    }
    const sub = await db.getSubscription(user.id);
    try {
      await runVodJob(job, videoPath, user, sub);
    } catch (e: any) {
      // A cancelled pass is a normal terminal outcome, not a failure: the job
      // is already `cancelled` and markJobFailed refuses to overwrite it. Log
      // it distinctly so the stop is visible in the server log.
      if (e instanceof VodCancelledError || isVodStopped(jobId)) {
        console.log(`[vod:${jobId}] cancelled (stopped via POST /jobs/:id/stop)`);
        await markJobCancelled(jobId);
      } else {
        console.error(`[vod:${jobId}] failed`, e);
        await markJobFailed(jobId, e).catch(() => {});
      }
    } finally {
      vodStopControllers.delete(jobId);
    }
  }

  /** Re-claim non-terminal jobs left over from a prior process (a restart or a
   * crash mid-pipeline): queue them again so the worker resumes them exactly
   * once. Highlights already persisted are skipped by the idempotent onEvent,
   * so no duplicate clip and no double quota debit. */
  async function recoverStaleVodJobs(): Promise<void> {
    for (const job of store.allJobs()) {
      if (
        job.status === "queued" ||
        job.status === "extracting" ||
        job.status === "analyzing" ||
        job.status === "finalizing"
      ) {
        const videoPath = job.sourceUrl;
        if (!videoPath) continue;
        if (!vodJobPaths.has(job.id)) vodJobPaths.set(job.id, videoPath);
        // Re-queue a stuck non-terminal job (extracting/analyzing/finalizing).
        if (job.status !== "queued") {
          await store.patchJob(job.id, { status: "queued", stage: "queued" }).catch(() => {});
        }
      }
    }
    await drainVodQueue();
  }

  app.get("/health", async () => ({ status: "ok", billing: billing.enabled ? "live" : "disabled" }));

  // Public config surfaced so the webapp can mirror the server's upload cap as
  // a client-side pre-check (kept in sync with VOD_MAX_UPLOAD_BYTES), plus the
  // rejected-clip recovery TTL (ADAAAA-5168/5204) so the rejected-clips UI
  // derives its "recover until" deadline from the server's own purge config
  // rather than a hardcoded client copy.
  app.get("/config", async () => ({
    vodMaxUploadBytes: cfg.vodMaxUploadBytes,
    // Chunk size (bytes) for the resumable upload rail; 0 = disabled. The webapp
    // slices files larger than the Cloudflare edge cap into these parts.
    vodChunkBytes: cfg.vodChunkBytes,
    rejectedClipTtlMs: cfg.rejectTtlMs,
  }));

  // ADAAAA-7247 (ACC-7): webui-configured clip-window setting, persisted per
  // company. GET returns the currently-effective window (persisted value if set,
  // else the deployment env default) plus the nominal `windowSec` and the
  // `deliveredWindowSec` after the >=15 s floor, so the settings UI shows what a
  // clip will actually run. PUT accepts whole-second clipBeforeS/clipAfterS
  // (defaults 7/8), validates on the server, persists per company, and returns
  // the same shape. The >=15 s floor is enforced at assembly by `clipWindow` —
  // an invalid/too-short setting can never produce a delivered clip <15 s.
  app.get("/config/clip-window", async () => {
    const s = await db.getClipWindowSettings();
    const before = s?.clipBeforeS ?? cfg.clipBeforeS;
    const after = s?.clipAfterS ?? cfg.clipAfterS;
    const minSec = cfg.clipWindowMinSec ?? 15;
    return {
      clipBeforeS: before,
      clipAfterS: after,
      clipWindowMinSec: minSec,
      windowSec: before + after,
      deliveredWindowSec: Math.max(before + after, minSec),
      persisted: Boolean(s),
    };
  });

  app.put<{ Body: { clipBeforeS?: unknown; clipAfterS?: unknown } }>(
    "/config/clip-window",
    { preHandler: authReq },
    async (req: any, reply) => {
      const minSec = cfg.clipWindowMinSec ?? 15;
      const v = validateClipWindow(req.body?.clipBeforeS, req.body?.clipAfterS, minSec);
      if (!v.ok) {
        return reply.code(400).send({ error: v.error, code: "invalid_clip_window" });
      }
      const before = v.clipBeforeS as number;
      const after = v.clipAfterS as number;
      await db.setClipWindowSettings({ clipBeforeS: before, clipAfterS: after });
      const floored = before + after < minSec;
      return {
        clipBeforeS: before,
        clipAfterS: after,
        clipWindowMinSec: minSec,
        windowSec: before + after,
        deliveredWindowSec: Math.max(before + after, minSec),
        persisted: true,
        ...(floored
          ? { note: `Configured window is ${before + after}s (< ${minSec}s). Delivered clips will be padded to the ${minSec}s minimum so the highlight stays >=${minSec}s (ACC-1).` }
          : {}),
      };
    }
  );

  // --- auth (public endpoints are rate limited per IP) ---
  app.post<{ Body: { email?: string; password?: string; inviteCode?: string } }>("/auth/register", { preHandler: limitAuth }, async (req, reply) => {
    try {
      const att = attributionFrom(req);
      const result = await auth.register(req.body?.email ?? "", req.body?.password ?? "", req.body?.inviteCode, att);
      // Funnel stage 1: signup (dimensioned by the user's acquisition channel).
      await recordSignupFunnel(db, result.user.id);
      return result;
    } catch (e: any) {
      // Invite/beta-gate rejection -> 403 (not a client 400); keeps "you need an
      // invite" distinct from a malformed request so the UI can route to waitlist.
      if (e instanceof BetaGateError) return reply.code(403).send({ error: e.message, code: "invite_required" });
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post<{ Body: { email?: string; password?: string } }>("/auth/login", { preHandler: limitAuth }, async (req, reply) => {
    try {
      return await auth.login(req.body?.email ?? "", req.body?.password ?? "");
    } catch (e: any) {
      if (e instanceof BetaGateError) return reply.code(403).send({ error: e.message, code: "invite_required" });
      return reply.code(401).send({ error: e.message });
    }
  });

  // Start a password reset. Always returns `{ ok: true }` (no account
  // enumeration). The reset link is delivered by email via the email-sender
  // container; the single-use token is never returned inline (ADAAAA-2481).
  app.post<{ Body: { email?: string } }>("/auth/forgot", { preHandler: limitAuth }, async (req, reply) => {
    try {
      return await auth.requestPasswordReset(req.body?.email ?? "");
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // Redeem a reset token with a new password. Invalid/expired tokens -> 400.
  app.post<{ Body: { token?: string; password?: string } }>("/auth/reset", { preHandler: limitAuth }, async (req, reply) => {
    try {
      await auth.resetPassword(req.body?.token ?? "", req.body?.password ?? "");
      return { ok: true };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // Session re-hydration: confirm the current token and return the user so the
  // SPA can restore a logged-in session (and detect a stale/revoked one) on load.
  app.get("/auth/me", { preHandler: authReq }, async (req: any) => {
    const u = req.user as { id: string; email: string; role: string };
    return { user: { id: u.id, email: u.email, role: u.role } };
  });

  // --- public waitlist (no auth) ---
  // "Join the beta" captures an email on the landing page. Public, but with its
  // own per-IP rate limit so the endpoint can't be used to bloat the list.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const waitlistLimiter = new FixedWindowLimiter({ limit: 20, windowMs: 60 * 1000 });
  const limitWaitlist = rateLimit(waitlistLimiter, "waitlist");

  app.post<{ Body: { email?: string } }>("/waitlist", { preHandler: limitWaitlist }, async (req, reply) => {
    const raw = (req.body?.email ?? "").trim();
    const email = raw.toLowerCase();
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: "valid email required" });
    try {
      const { registered } = await db.addWaitlistEmail(email);
      return { ok: true, registered, message: "You're on the list. We'll email your invite." };
    } catch (e: any) {
      // A storage failure must not look like a successful signup.
      return reply.code(500).send({ error: String(e?.message || "waitlist unavailable") });
    }
  });

  // Admin inspection + signup-rate counter source (gate X / ADAAAA-27).
  app.get("/waitlist", { preHandler: adminReq }, async () => ({
    count: await db.waitlistCount(),
    emails: await db.listWaitlistEmails(),
  }));

  // --- invite / beta-gate (admin / cohort-owner tooling) -------------------
  // The gate has two activation paths: (a) single-use invite codes and
  // (b) a waitlisted email flipped to invited. Both are cohort-owner/admin-only.
  app.post<{ Body: { email?: string } }>("/admin/invite-codes", { preHandler: adminReq }, async (req: any, reply) => {
    const raw = (req.body?.email ?? "").trim().toLowerCase();
    if (raw && !EMAIL_RE.test(raw)) return reply.code(400).send({ error: "valid email required" });
    const code = randomBytes(6).toString("hex"); // 12 hex chars, cohort-owner hands out of band
    await db.createInviteCode({
      id: randomUUID(),
      codeHash: AuthService.hashInviteCode(code),
      email: raw || null,
      createdBy: req.user.id,
      createdAt: new Date().toISOString(),
    });
    // When the code is bound to an email, deliver it there via the email sender
    // (so the invite is openable and the code is usable at registration). An
    // unbound code is still handed out of band by the cohort owner.
    if (raw) {
      await enqueueBestEffort(mailer, {
        to: raw,
        subject: "You're invited to highlights.live — here's your code",
        body: `You've been invited to the highlights.live beta.\n\nYour invite code is:\n\n${code}\n\nOpen ${cfg.publicBaseUrl}/auth and choose "Create account", entering this code to activate your account.`,
      });
    }
    return { code, email: raw || null };
  });

  app.post<{ Body: { code?: string } }>("/admin/invite-codes/revoke", { preHandler: adminReq }, async (req, reply) => {
    const code = (req.body?.code ?? "").trim();
    if (!code) return reply.code(400).send({ error: "code required" });
    await db.revokeInvite(AuthService.hashInviteCode(code));
    return { ok: true };
  });

  app.get("/admin/invite-codes", { preHandler: adminReq }, async () => {
    const codes = await db.listInvites();
    return {
      codes: codes.map((c) => ({
        id: c.id,
        email: c.email,
        createdBy: c.createdBy,
        createdAt: c.createdAt,
        used: Boolean(c.usedAt),
        usedAt: c.usedAt,
        revoked: Boolean(c.revokedAt),
        revokedAt: c.revokedAt,
      })),
    };
  });

  // Flip a waitlisted email to invited (give that inbox the ability to activate
  // an account without a code). Idempotent; also accepts an email that never
  // signed up (records it directly as invited).
  app.post<{ Params: { email: string } }>("/admin/waitlist/:email/invite", { preHandler: adminReq }, async (req, reply) => {
    const email = decodeURIComponent(req.params.email).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: "valid email required" });
    const entry = await db.setWaitlistInvited(email);
    // Waitlist -> invite delivery: flipping an inbox to `invited` grants it
    // account activation, so email that inbox a working invitation. (An invited
    // waitlist email can register without a code.) Copy is shared with the
    // email-runner allocator (invites.ts) so both send identical invites.
    const invite = composeInviteEmail(cfg.publicBaseUrl);
    await enqueueBestEffort(mailer, { to: email, subject: invite.subject, body: invite.body });
    return { ok: true, email: entry.email, status: entry.status };
  });

  // Admin analytics: signups, clips generated, and paying-user conversion vs
  // the 100-public-beta-user goal. Feeds the beta telemetry + box-health board
  // view (ADAAAA-25). Admin-only; derived live from the DB on each call.
  app.get<{ Querystring: { goal?: string } }>("/admin/analytics", { preHandler: adminReq }, async (req) => {
    const a = await db.analytics();
    const goal = req.query?.goal ? Number(req.query.goal) : 100;
    const payingPro = a.subscriptions
      .filter((s) => s.tier === "pro" && s.status === "active")
      .reduce((n, s) => n + s.count, 0);
    const payingAnyActive = a.subscriptions
      .filter((s) => s.status === "active" && s.tier !== "free")
      .reduce((n, s) => n + s.count, 0);
    return {
      generatedAt: new Date().toISOString(),
      goal: { payingUsersTarget: goal },
      signups: { usersTotal: a.usersTotal, usersActivated: a.usersActivated, waitlistTotal: a.waitlistTotal, waitlistInvited: a.waitlistInvited },
      clips: { clipsTotal: a.clipsTotal, clipsUsed: a.clipsUsed, usageEvents: a.usageEvents },
      conversion: {
        payingProActive: payingPro,
        payingAnyActive: payingAnyActive,
        pctOfGoal: Math.round((payingAnyActive / goal) * 10000) / 100,
      },
      subscriptions: a.subscriptions,
    };
  });

  // In-flight perceive analyze jobs (ADAAAA-7203 deploy gate). Read-only so the
  // staged-deploy gate can query it with the bounded `admin_readonly`
  // credential (which every write route rejects). Returns jobs currently
  // `active` (mid-analysis) so the deployer can wait/drain before recreating the
  // capacity-1 perceive runner instead of dropping its session mid-pass.
  app.get("/admin/inflight-jobs", { preHandler: adminReadOnlyReq }, async () => {
    const inflight = store.listActiveJobs();
    // ADAAAA-7750 AC4: the gate also has to cover LIVE MEDIA sessions, not only
    // mid-pass analyze jobs. The 2026-11-01 22:16Z incident (ADAAAA-7700) was a
    // `highlights-media` recreate landing mid-share, which fails the job as
    // `media-session-lost` even though the analyze queue was empty - so a gate
    // that only reads `inflight` reports a clear runway during a live share.
    // `liveSessions` is the durable `media_sessions` row per job still `active`.
    const sessions = await db
      .listMediaSessions()
      .catch(() => [] as Array<{ jobId: string; sessionId: string; status: string; createdAt: string }>);
    // Only a session whose JOB is genuinely in flight is a live share. The
    // durable rows are written at provision and cleared on some job-end paths
    // only, so the box carries stale `active` rows on FAILED jobs (measured
    // 2026-11-02: 13 such rows) - reading `status: "active"` alone made the gate
    // block every deploy for the whole wait budget on shares that had already
    // ended. `store.getJob` is the in-memory owner of an in-flight run.
    const IN_FLIGHT = new Set(["queued", "active", "extracting", "analyzing", "finalizing"]);
    const liveSessions = sessions
      .filter((s) => s.status === "active")
      .map((s) => {
        const job = store.getJob(s.jobId);
        return {
          jobId: s.jobId,
          sessionId: s.sessionId,
          createdAt: s.createdAt,
          status: job?.status ?? "unknown",
          source: job?.source ?? "unknown",
        };
      })
      .filter((s) => IN_FLIGHT.has(s.status));
    return {
      generatedAt: new Date().toISOString(),
      inflight: inflight.map((j) => ({
        id: j.id,
        source: j.source,
        gameHint: j.gameHint ?? "",
        createdAt: j.createdAt,
      })),
      liveSessions,
    };
  });

  // Conversion-funnel + per-channel CAC readout (ADAAAA-6368, plan §3b.2).
  // Admin-only; on demand. Reports N users per funnel stage (signup ->
  // activate -> generate -> subscribe -> retain), the same dimensioned by
  // acquisition channel, and CAC per channel = recorded spend / paying
  // subscribers attributed to that channel. Feed channel spend via
  // POST /admin/spend.
  app.get("/admin/funnel", { preHandler: adminReadOnlyReq }, async () => await db.funnelReport());

  // Record / inspect per-channel ad spend over the paid-acquisition window so
  // CAC per channel is computable (ADAAAA-6368). Spend is an input from the ad
  // platform (Meta / Google / referral) ledger; upserted per channel.
  app.post<{ Body: { channel?: string; spendUsd?: number; note?: string } }>("/admin/spend", { preHandler: adminReq }, async (req: any, reply) => {
    const channel = (req.body?.channel ?? "").trim().toLowerCase();
    const spendUsd = Number(req.body?.spendUsd);
    if (!channel) return reply.code(400).send({ error: "channel required" });
    if (!Number.isFinite(spendUsd) || spendUsd < 0) return reply.code(400).send({ error: "spendUsd must be a non-negative number" });
    const stored = await db.recordChannelSpend(channel, Number(spendUsd.toFixed(2)), req.body?.note || null);
    return stored;
  });

  app.get("/admin/spend", { preHandler: adminReadOnlyReq }, async () => ({ spend: await db.listChannelSpend() }));

  // ADAAAA-7722: live watch-minutes — the measured basis for the ADAAAA-7713
  // spend envelope's monthly ceiling.
  //
  // `?month=YYYY-MM` (UTC) defaults to the current month. Every LIVE session
  // contributes its own persisted `liveWatchMinutes` (written at completion from
  // the rail's session clock); VOD jobs are excluded because decoding a file is
  // compute time, not watch time. Sessions in the month with no measurement are
  // reported as `unmeasuredSessions` instead of being counted as 0.
  app.get<{ Querystring: { month?: string } }>("/admin/live-watch-minutes", { preHandler: adminReadOnlyReq }, async (req, reply) => {
    const month = (req.query?.month ?? "").trim() || monthKeyUtc();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return reply.code(400).send({ error: "month must be YYYY-MM" });
    }
    const jobs = await db.listJobs();
    return aggregateLiveWatchMinutes(jobs, month);
  });

  // New-job reliability + per-clip Livepeer inference cost readout, folded into
  // per-channel CAC (ADAAAA-6369, plan §3b.4 / §3c). This is the hard-stop gate
  // for the paid-acquisition push: when `spendPaused` is true, new-job
  // reliability is below the floor and spend must pause (budget hard-stop).
  // Admin-only; on demand. `?days=` (default 7) or `?since=<ISO>` sets the
  // window; `since` is the authoritative bound once the push start is known.
  app.get<{ Querystring: { since?: string; days?: string } }>("/admin/monitoring", { preHandler: adminReadOnlyReq }, async (req) => {
    const q = req.query ?? {};
    const days = q.days !== undefined ? Number(q.days) : undefined;
    const report = await reportMonitoring(db, { since: q.since || undefined, days });
    if (report.spendPaused) {
      // Detection: log the breach so any run/box-health tail can see the
      // spend-pause condition, not just the JSON readout.
      console.warn(
        `[monitoring] new-job reliability ${report.reliabilityPct}% < ${(RELIABILITY_FLOOR * 100).toFixed(0)}% floor — spend PAUSE condition (hard-stop)`
      );
    }
    return report;
  });

  app.get("/admin/waitlist", { preHandler: adminReq }, async () => ({
    entries: (await db.listWaitlist()).map((w) => ({
      email: w.email,
      status: w.status,
      invitedAt: w.invitedAt,
      createdAt: w.createdAt,
    })),
  }));

  // Waitlist->invite allocation gate (ADAAAA-2555). The email-runner allocator
  // polls the waitlist hourly and allocates new signups in FIFO order ONLY
  // while the gate is OPEN. The server admin toggles it: allocationOpen=false
  // means "no new users currently" (allocation suppressed); true (or unset)
  // resumes polling. Persisted in the shared DB; admin-only toggling.
  app.get("/admin/waitlist/gate", { preHandler: adminReq }, async () => await db.getWaitlistGate());

  app.put<{ Body: { allocationOpen?: boolean } }>("/admin/waitlist/gate", { preHandler: adminReq }, async (req: any, reply) => {
    const allocationOpen = req.body?.allocationOpen;
    if (typeof allocationOpen !== "boolean") return reply.code(400).send({ error: "allocationOpen boolean required" });
    const gate = await db.setWaitlistGate(allocationOpen, req.user.email);
    return gate;
  });

  // --- billing ---
  app.get("/billing/plans", async () => ({ plans: billing.plans() }));

  app.post<{ Body: { returnPath?: string } }>("/billing/checkout", { preHandler: authReq }, async (req, reply) => {
    try {
      // Attribution at checkout: if the user signed up without a channel but
      // this checkout carries UTM, capture it (COALESCE keeps the first-touch
      // signup value when present). Subscribe event is recorded on activation.
      const att = attributionFrom(req);
      if (att.channel || att.utmSource) await db.setAttribution((req as any).user.id, att);
      return await billing.createCheckout((req as any).user, req.body?.returnPath || "/billing");
    } catch (e: any) {
      return reply.code(400).send({ error: e.message || "billing not configured" });
    }
  });

  app.post<{ Body: { returnPath?: string } }>("/billing/portal", { preHandler: authReq }, async (req, reply) => {
    try {
      return await billing.portal((req as any).user, req.body?.returnPath || "/billing");
    } catch (e: any) {
      return reply.code(400).send({ error: e.message || "billing not configured" });
    }
  });

  app.get("/billing/status", { preHandler: authReq }, async (req) => {
    const user = (req as any).user as { id: string };
    const sub = await db.getSubscription(user.id);
    return {
      tier: sub.tier,
      status: sub.status,
      // Both figures derive from the SAME per-period entitlement ledger (not the
      // lifetime usage_events counter) so enforcement, display, and this status
      // surface can never drift apart (ADAAAA-5129).
      usedHighlights: await entitlements.used(user.id),
      freeHighlights: cfg.freeHighlights,
      // Per-user per-calendar-month clip quota (the entitlement ledger) surfaced
      // so the UI can show remaining quota and so an exhausted quota is visible
      // without making a submission.
      clipQuotaPeriod: entitlements.periodKey(),
      clipQuotaLimit: entitlements.limitFor(sub),
      clipQuotaUsed: await entitlements.used(user.id),
      clipQuotaRemaining: await entitlements.remaining(user.id, sub),
    };
  });

  // --- fine-tune "train" trigger (ADAAAA-5262 / 5323) -------------------------
  // Board user starts a Florence-2 fine-tune on the highlights-train single-shot
  // runner. POST accepts a DetectionTrainingSample manifest (array, serialized
  // to JSONL) + optional hyper-params, persists the run, and submits the job.
  // With `manifestSource: "curated"` the curated manifests published by the
  // annotation loop (Increment A) are loaded server-side — the one-click path
  // that replaces manual paste; manual paste stays as the operator fallback.
  // GET /train lists the caller's runs (newest first); GET /train/curated
  // returns whether a curated manifest is present; GET /train/:run returns a
  // run's live status + result; GET /train/:run/artifact streams the run's
  // LoRA artifact with integrity (SHA-256) verification.
  app.post<{ Body: { manifest?: unknown[] | string; val?: unknown[] | string; manifestSource?: "curated" | "paste"; epochs?: number; batchSize?: number; lr?: number; baseModel?: string } }>(
    "/train",
    { preHandler: authReq },
    async (req: any, reply) => {
      const user = req.user as { id: string };
      try {
        let manifest: unknown[] | string | undefined = req.body?.manifest;
        let val: unknown[] | string | undefined = req.body?.val;
        if (req.body?.manifestSource === "curated") {
          // Increment B: pull the curated train/val manifests directly from the
          // annotation loop's published files instead of a pasted body.
          const curated = await loadCuratedManifest(cfg);
          manifest = curated.manifest;
          val = curated.val;
        }
        const run = await train.submit(user.id, {
          manifest,
          val,
          epochs: req.body?.epochs,
          batchSize: req.body?.batchSize,
          lr: req.body?.lr,
          baseModel: req.body?.baseModel,
        });
        return { run };
      } catch (err) {
        if (err instanceof TrainValidationError) {
          return reply.code(422).send({ error: err.message, code: "invalid_manifest" });
        }
        if (err instanceof Error && /no curated train manifest/.test(err.message)) {
          return reply.code(422).send({ error: err.message, code: "no_curated_manifest" });
        }
        throw err;
      }
    }
  );

  app.get("/train", { preHandler: authReq }, async (req: any) => {
    const user = req.user as { id: string };
    return { runs: await train.list(user.id) };
  });

  app.get("/train/curated", { preHandler: authReq }, async () => {
    return { curated: inspectCuratedManifests(cfg) };
  });

  app.get<{ Params: { id: string } }>("/train/:id", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user as { id: string; role?: string };
    const run = await train.get(req.params.id);
    if (!run) return reply.code(404).send({ error: "train run not found", code: "not_found" });
    // Company boundary: only the owning user (or admin) can read a run.
    if (run.ownerId !== user.id && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", code: "forbidden" });
    return { run };
  });

  // Run-scoped LoRA artifact download (ADAAAA-5323). Same company boundary as
  // GET /train/:id; the file is re-hashed on the way out and compared against
  // the run's recorded digest, so a user downloads the exact bytes the runner
  // produced (integrity check), with the digest surfaced in headers.
  app.get<{ Params: { id: string } }>("/train/:id/artifact", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user as { id: string; role?: string };
    const run = await train.get(req.params.id);
    if (!run) return reply.code(404).send({ error: "train run not found", code: "not_found" });
    if (run.ownerId !== user.id && user.role !== "admin")
      return reply.code(403).send({ error: "forbidden", code: "forbidden" });
    if (run.status !== "done" || !run.result?.artifact)
      return reply.code(409).send({ error: "artifact not ready", code: "artifact_not_ready" });
    try {
      const dl = await prepareArtifactDownload(cfg, run);
      reply
        .header("Content-Type", run.result.artifact.contentType || "application/octet-stream")
        .header("Content-Disposition", `attachment; filename="${dl.filename.replace(/"/g, "")}"`)
        .header("Content-Length", String(dl.size))
        .header("X-Checksum-Sha256", dl.sha256)
        .header("Digest", `sha-256=${Buffer.from(dl.sha256, "hex").toString("base64")}`)
        .header("ETag", `"${dl.sha256}"`)
        .header("Cache-Control", "private, no-store");
      return reply.send(dl.stream);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(409).send({ error: msg, code: "artifact_unavailable" });
    }
  });

  // --- dev wireframe billing (BILLING_WIREFRAME=1, NON-PRODUCTION only) -----
  // Simulate the side effects the Stripe webhook would normally produce, so the
  // full subscription lifecycle can be exercised locally without real Stripe.
  // These routes are MOUNTED ONLY when BILLING_WIREFRAME is set AND the server
  // is not running in production (NODE_ENV != production). When either is
  // false (prod default), the routes do not exist at all — Fastify answers 404
  // route-not-found — so the wireframe "free upgrade" surface is never
  // reachable from a prod deploy, regardless of auth or client. The NODE_ENV
  // check is the server-side env gate that keeps the simulator unreachable in
  // prod even if BILLING_WIREFRAME is accidentally set in the deploy env.
  if (cfg.billingWireframe && cfg.nodeEnv !== "production") {
    app.post("/dev/billing/activate", { preHandler: authReq }, async (req: any, reply) => {
      const user = (req as any).user;
      const sub = await db.setSubscription(user.id, {
        tier: req.body?.plan === "free" ? "free" : "pro",
        status: "active",
        stripeSubscriptionId: req.body?.stripeSubscriptionId || "wireframe_sub",
        stripeSubItemId: (req.body?.noMeter ?? false) ? null : "si_wire_metered",
      });
      // Funnel stage 4: subscribe (only on a paid, active Pro conversion).
      if (sub.tier === "pro" && sub.status === "active") await recordSubscribeFunnel(db, user.id);
      return reply.send({ ok: true, sub });
    });

    app.post("/dev/billing/deactivate", { preHandler: authReq }, async (req: any, reply) => {
      const user = (req as any).user;
      const sub = await db.setSubscription(user.id, { tier: "free", status: "canceled", stripeSubscriptionId: null, stripeSubItemId: null });
      // Plan deactivated (dev wireframe of the Stripe 'customer.subscription.deleted'
      // webhook) -> schedule the account's stored datasets for 30-day purge.
      // Retrieval is denied immediately by the retrieval gate (now free/canceled).
      await scheduleDatasetsPurgeForOwner(db, user.id);
      return reply.send({ ok: true, sub });
    });

    app.post("/dev/billing/reset-usage", { preHandler: authReq }, async (req: any, reply) => {
      const user = (req as any).user;
      await db.resetUsage(user.id, "highlight");
      await db.resetUsage(user.id, "decide");
      // The per-period quota ledger is the enforcement + display counter now
      // (ADAAAA-5129); reset the current period so the "reset" fully restores a
      // fresh month's allowance rather than leaving the ledger drifting from
      // what `/billing/status` reports.
      await db.resetQuota(user.id, entitlements.periodKey());
      return reply.send({ ok: true, usedHighlights: await entitlements.used(user.id) });
    });
  }

  app.post("/stripe/webhook", async (req: any, reply) => {
    const sig = req.headers["stripe-signature"];
    try {
      return await billing.handleWebhook(req.raw.body, sig);
    } catch (e: any) {
      return reply.code(400).send({ error: `webhook rejected: ${e.message}` });
    }
  });

  // --- pipeline (auth + billing gated) ---
  app.post<{ Body: { source?: string; videoPath?: string; gameHint?: string; preferLabels?: string[]; sampleFps?: number } }>(
    "/jobs",
    { preHandler: authReq },
    async (req, reply) => {
      const user = (req as any).user;
      const sub = await db.getSubscription(user.id);
      // Budget hard-stop: reject at submission time as soon as the month's clip
      // quota is exhausted. This runs BEFORE any job is created or any compute
      // (Livepeer GPU / decide) is scheduled — quota overspend never runs a job.
      try {
        await entitlements.canSubmit(user, sub);
      } catch (e) {
        if (e instanceof QuotaExceededError) {
          return reply.code(429).send({
            error: "monthly clip quota used up — resets at the start of next month",
            code: "quota_exceeded",
            clipQuotaPeriod: entitlements.periodKey(),
            clipQuotaLimit: entitlements.limitFor(sub),
            clipQuotaRemaining: 0,
          });
        }
        throw e;
      }
      let billingBlocked = false;
      try {
        await billing.canCreateHighlight(user, sub);
      } catch (e) {
        if (e instanceof BillingRequiredError) billingBlocked = true;
        else throw e;
      }
      if (billingBlocked) {
        return reply.code(402).send({ error: "free allowance used; subscribe to Pro to continue", upgrade: "/billing/checkout" });
      }
      const videoPath = req.body?.videoPath;
      const live = !!req.body.source && req.body.source !== "file";
      if (!videoPath && !(live && (req.body.source === "screen" || req.body.source === "browser")))
        return reply.code(400).send({ error: "videoPath required for this source" });
      // Funnel activate/retain detection: read the user's prior-job state BEFORE
      // this job is persisted so the new job cannot consume the "first job" slot.
      const priorJobs = await db.countJobsForUser(user.id);
      const firstJobAt = priorJobs > 0 ? await db.firstJobAt(user.id) : null;
      const job = await store.createJob({
        ownerId: user.id,
        source: (req.body.source ?? "file") as any,
        sourceUrl: videoPath,
        gameHint: req.body.gameHint || cfg.gameHintDefault,
        preferLabels: req.body.preferLabels ?? [],
        sampleFps: req.body.sampleFps,
      });
      // File/URL VOD jobs stay `queued` and are claimed by the durable worker
      // (ADAAAA-6873 non-blocking submit); live / browser-capture flip to active.
      if (req.body.source === "browser" || live) await store.patchJob(job.id, { status: "active" });
      await recordJobFunnel(db, user.id, priorJobs, firstJobAt, cfg.funnelRetainDays);
      if (req.body.source === "browser") {
        // Client-side capture (screen share / element capture): the client posts
        // sampled frames to /jobs/:id/ingest and a recording to
        // /jobs/:id/recording. Nothing to pull server-side.
        browserJobs.set(job.id, { evidence: new EvidenceTracker() });
        return { job: jobForRole(store.getJob(job.id), (req as any).user.role), status: "ready" };
      }
      if (live) {
        // Live ingest: capture/pull the stream, record it to disk, and sample
        // frames into the analyzer rail. Runs in the background; the job is
        // stopped via POST /jobs/:id/stop.
        // ADAAAA-5342: live sampling driven from the runner's measured
        // capability (mirroring VOD) — capped at a live-specific ceiling with
        // a headroom so capable GPUs accelerate while the runner never sits at
        // its sustained max, and floored at the base cadence so ~1 fps CPU
        // runners never regress. The resolved rate is recorded on the job so
        // it surfaces in job/stream metrics for verification.
        // ADAAAA-6796 (Stage 1): the live primary-pass baseline is raised to
        // 3 fps (liveSampleBaseFps) so the decide read samples the dense
        // crossing/conversion window for every live job; the capability cap
        // (liveSampleMaxFps) bounds cost per deployment.
        const sampleFps = await resolveSampleFps(cfg, {
          defaultFps: cfg.liveSampleBaseFps,
          maxFps: cfg.liveSampleMaxFps,
          headroom: cfg.liveSampleHeadroom,
        });
        await store.patchJob(job.id, { sampleFps });
        // ADAAAA-7741: anchor the content clock at the live tap's start so the
        // read-time liveProgress can measure wall-vs-content lag exactly.
        await stampContentClockStart(job.id);
        const kind: LiveKind =
          req.body.source === "screen" ? "screen" : (req.body.source as LiveKind) === "file-sim" ? "file-sim" : "rtmp";
        // ADAAAA-7247 (ACC-7): the live session's `cut` reads `this.cfg`, so hand
        // it a shallow copy of the server config with the webui-configured
        // (DB-persisted) clip window replacing the bare env default.
        const cw = await resolveClipWindow();
        const ingestCfg = { ...cfg, clipBeforeS: cw.clipBeforeS, clipAfterS: cw.clipAfterS, clipWindowMinSec: cw.clipWindowMinSec };
        const ingest = new LiveIngest(ingestCfg, job.id, {
          kind,
          url: videoPath,
          sampleInterval: 1 / sampleFps,
        });
        await ingest.start();
        liveSessions.set(job.id, ingest);
        // ADAAAA-7670: attribute this live job's GPU spend to the media node
        // that carries the live pipeline. RTMP-pull (and the other live
        // sources) never provision a session through `POST /sessions`, so
        // without this row the job's costUsd groups under `unattributed` in
        // `GET /media/node`. Best-effort: an unreachable node leaves the job
        // honestly unattributed and never blocks the ingest.
        await attributeLiveIngest({
          db,
          mediaServerUrl: cfg.mediaServerUrl,
          jobId: job.id,
          source: req.body.source,
        }).catch((e: any) =>
          console.error(`[live:${job.id}] media-node attribution failed:`, String(e?.message || e))
        );
        runLiveJob(ingest, job, user, sub).catch(() => {});
        return { job: jobForRole(store.getJob(job.id), user.role), status: "ingesting", framesAnalyzed: 0 };
      }
      // Durable non-blocking submit (ADAAAA-6873): enqueue the file/URL VOD job
      // for the durable worker and return 202 immediately so the upload POST
      // never blocks on the (multi-minute) analyze pipeline and the edge
      // request timeout can't hand the browser a 5xx. The worker claims the job
      // and drives queued -> extracting -> analyzing -> finalizing -> done|
      // failed; progress/status stream over the job's SSE channel and the
      // webapp polls GET /jobs / GET /jobs/:id as a backstop.
      enqueueVodJob(job.id, videoPath!);
      const q = store.getJob(job.id)!;
      return reply.code(202).send({
        job: jobForRole(q, user.role),
        accepted: true,
        status: "queued",
        progress: { stage: "queued", framesAnalyzed: 0, framesTotal: 0, framesPct: 0, highlightsFound: 0 },
      });
    }
  );

  // Browser VOD file upload (the "Upload / file" source). Multipart/streamed;
  // the file lands at dataDir/uploads/<jobId>/<safe-filename> and then runs the
  // SAME extractFrames -> analyzeJob -> clip path as any local path source.
  // Auth, quota (429), and billing (402) gates apply identically BEFORE any
  // bytes are persisted or any compute is queued; an over-limit or non-video
  // upload returns 413/415 and never reaches GPU.
  app.post("/jobs/upload", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user;
    const sub = await db.getSubscription(user.id);
    // Budget hard-stop, identical to POST /jobs.
    try {
      await entitlements.canSubmit(user, sub);
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        return reply.code(429).send({
          error: "monthly clip quota used up — resets at the start of next month",
          code: "quota_exceeded",
          clipQuotaPeriod: entitlements.periodKey(),
          clipQuotaLimit: entitlements.limitFor(sub),
          clipQuotaRemaining: 0,
        });
      }
      throw e;
    }
    let billingBlocked = false;
    try {
      await billing.canCreateHighlight(user, sub);
    } catch (e) {
      if (e instanceof BillingRequiredError) billingBlocked = true;
      else throw e;
    }
    if (billingBlocked) {
      return reply.code(402).send({ error: "free allowance used; subscribe to Pro to continue", upgrade: "/billing/checkout" });
    }

    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "multipart file part required" });
    const { file, fields, filename, mimetype } = data;
    if (!isVideoUpload(mimetype, filename)) {
      // Drain the rejected part so the connection can be reused.
      file.resume();
      return reply.code(415).send({
        error: "Unsupported file type — upload a video (mp4, mov, webm, mkv, or mpegts).",
      });
    }
    const fv = (v: any) => (Array.isArray(v) ? v[0] : v)?.value ?? "";
    const gameHint = fv(fields.gameHint) || cfg.gameHintDefault;
    let preferLabels: string[] = [];
    try {
      const raw = fv(fields.preferLabels);
      if (raw) preferLabels = JSON.parse(raw);
    } catch {
      preferLabels = [];
    }

    const jobId = randomUUID();
    const safeName = sanitizeFilename(filename);
    // Stream to a dataDir-level staging file first (dataDir already exists, so
    // this creates no dirs); the uploads/<jobId> dir is only created once the
    // upload is accepted, so a rejected/over-limit upload leaves no footprint.
    const stagePath = path.join(cfg.dataDir, `.upload-stage-${jobId}.tmp`);
    const { mkdir, rename, rm } = await import("node:fs/promises");
    const dir = path.join(cfg.dataDir, "uploads", jobId);
    const finalPath = path.join(dir, safeName);

    // Stream to the staging file while counting bytes; abort + 413 + clean up
    // if the hard cap is crossed (never buffer the whole file, never queue
    // compute).
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > cfg.vodMaxUploadBytes) {
          cb(Object.assign(new Error("too_large"), { statusCode: 413 }) as any);
          return;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(file, counter, createWriteStream(stagePath));
    } catch (e: any) {
      await rm(stagePath, { force: true }).catch(() => {});
      if (e?.statusCode === 413 || e?.message === "too_large" || e?.code === "FST_REQ_FILE_TOO_LARGE") {
        // Report the ACTUAL configured cap, never a hardcoded "2 GB" — a lowered
        // VOD_MAX_UPLOAD_BYTES must surface as the real limit (ADAAAA-5698). Mirrors
        // the client's oversizedHelp(limit) message byte-for-byte.
        return reply.code(413).send({
          error: `File too large (max ${formatBytes(cfg.vodMaxUploadBytes)}). Paste a download URL instead to process it.`,
        });
      }
      return reply.code(500).send({ error: String(e?.message || e) });
    }
    // Accepted: create the job dir and land the file at its final path.
    await mkdir(dir, { recursive: true });
    await rename(stagePath, finalPath);

    let sampleFps: number | undefined;
    try {
      const raw = fv(fields.sampleFps);
      if (raw) sampleFps = Number(raw);
    } catch {
      sampleFps = undefined;
    }

    const priorJobs = await db.countJobsForUser(user.id);
    const firstJobAt = priorJobs > 0 ? await db.firstJobAt(user.id) : null;
    const job = await store.createJob({
      id: jobId,
      ownerId: user.id,
      source: "file",
      sourceUrl: finalPath,
      gameHint,
      preferLabels,
      sampleFps,
    });
    await recordJobFunnel(db, user.id, priorJobs, firstJobAt, cfg.funnelRetainDays);
    // Durable non-blocking submit (ADAAAA-6873): enqueue the landed file for
    // the durable worker and return 202 immediately (the file is already at
    // dataDir/uploads/<jobId>/<name>). The old synchronous await blocked the
    // request for minutes on a long VOD, which outlasted the edge request
    // timeout and handed the browser a 5xx — same fix as the resumable rail.
    enqueueVodJob(job.id, finalPath);
    const q = store.getJob(job.id)!;
    return reply.code(202).send({
      job: jobForRole(q, user.role),
      accepted: true,
      status: "queued",
      progress: { stage: "queued", framesAnalyzed: 0, framesTotal: 0, framesPct: 0, highlightsFound: 0 },
    });
  });

  // --- Resumable VOD upload rail (ADAAAA-5714) ---
  // The single-shot POST /jobs/upload above caps the FILE at vodMaxUploadBytes,
  // but the whole request body must cross the Cloudflare tunnel in one proxied
  // POST, which the free plan cuts at ~100 MB (Cloudflare's own 413, before the
  // origin is reached). The webapp instead slices files larger than that into
  // `vodChunkBytes` parts and posts each through /jobs/upload/:uploadId/chunk;
  // the server appends each part to the same staged file the single-shot rail
  // produces, then /jobs/upload/complete lands it and runs the identical
  // job+compute path. Auth/quota/billing gates are enforced at init (and the
  // pipeline at complete), so no bytes persist and no compute queues for an
  // unauthorized/over-quota session.
  const uploadTooLargeMsg = () =>
    `File too large (max ${formatUploadLimit(cfg.vodMaxUploadBytes)}). Paste a download URL instead to process it.`;

  app.post<{ Body: any }>("/jobs/upload/init", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user;
    // Sweep idle sessions left by abandoned clients before opening a new one.
    sweepUploadSessions();
    const { filename, size, mime, gameHint, preferLabels, sampleFps } = req.body ?? {};
    const sub = await db.getSubscription(user.id);
    try {
      await entitlements.canSubmit(user, sub);
    } catch (e: any) {
      if (e instanceof QuotaExceededError) {
        return reply.code(429).send({
          error: "monthly clip quota used up — resets at the start of next month",
          code: "quota_exceeded",
          clipQuotaPeriod: entitlements.periodKey(),
          clipQuotaLimit: entitlements.limitFor(sub),
          clipQuotaRemaining: 0,
        });
      }
      throw e;
    }
    try {
      await billing.canCreateHighlight(user, sub);
    } catch (e: any) {
      if (e instanceof BillingRequiredError) {
        return reply.code(402).send({ error: "free allowance used; subscribe to Pro to continue", upgrade: "/billing/checkout" });
      }
      throw e;
    }
    const total = Number(size);
    if (!Number.isFinite(total) || total <= 0) return reply.code(400).send({ error: "upload size is required and must be positive" });
    if (total > cfg.vodMaxUploadBytes) return reply.code(413).send({ error: uploadTooLargeMsg() });
    if (total > 0 && isVideoUpload(mime, filename) === false) {
      return reply.code(415).send({ error: "Unsupported file type — upload a video (mp4, mov, webm, mkv, or mpegts)." });
    }
    const jobId = randomUUID();
    const safeName = sanitizeFilename(filename);
    const stagePath = path.join(cfg.dataDir, `.upload-chunk-${jobId}.tmp`);
    const dir = path.join(cfg.dataDir, "uploads", jobId);
    const finalPath = path.join(dir, safeName);
    let labels: string[] = [];
    try {
      const raw = Array.isArray(preferLabels) ? JSON.stringify(preferLabels) : preferLabels;
      if (raw) labels = JSON.parse(String(raw));
    } catch {
      labels = [];
    }
    uploadSessions.set(jobId, {
      ownerId: user.id,
      filename: safeName,
      mimetype: mime ?? "",
      size: total,
      received: 0,
      stagePath,
      dir,
      finalPath,
      gameHint: gameHint || cfg.gameHintDefault,
      preferLabels: labels,
      sampleFps: sampleFps !== undefined ? Number(sampleFps) : undefined,
      lastChunkAt: Date.now(),
    });
    return { uploadId: jobId, chunkBytes: cfg.vodChunkBytes, vodMax: cfg.vodMaxUploadBytes };
  });

  app.post<{ Params: { uploadId: string } }>("/jobs/upload/:uploadId/chunk", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user;
    const session = uploadSessions.get(req.params.uploadId);
    if (!session || session.ownerId !== user.id) return reply.code(404).send({ error: "upload session not found" });
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "multipart file part required" });
    const { file } = data;
    // Whether this is a video was already validated once at init against the
    // declared mime+filename; a chunk is opaque bytes appended to the staged
    // file, so its cosmetic part-name is irrelevant here.
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        session.received += chunk.length;
        if (session.received > session.size) {
          cb(Object.assign(new Error("too_large"), { statusCode: 413 }) as any);
          return;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(file, counter, createWriteStream(session.stagePath, { flags: "a" }));
    } catch (e: any) {
      if (e?.statusCode === 413 || e?.code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: uploadTooLargeMsg() });
      }
      return reply.code(500).send({ error: String(e?.message || e) });
    }
    session.lastChunkAt = Date.now();
    return { received: session.received };
  });

  app.post<{ Body: any }>("/jobs/upload/complete", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user;
    const { uploadId } = req.body ?? {};
    const session = uploadSessions.get(uploadId);
    if (!session || session.ownerId !== user.id) return reply.code(404).send({ error: "upload session not found" });
    if (session.received !== session.size) {
      return reply.code(400).send({ error: `incomplete upload: received ${session.received} of ${session.size} bytes` });
    }
    const { mkdir, rename } = await import("node:fs/promises");
    await mkdir(session.dir, { recursive: true });
    await rename(session.stagePath, session.finalPath);
    uploadSessions.delete(uploadId);
    const sub = await db.getSubscription(user.id);
    const priorJobs = await db.countJobsForUser(user.id);
    const firstJobAt = priorJobs > 0 ? await db.firstJobAt(user.id) : null;
    const job = await store.createJob({
      id: uploadId,
      ownerId: user.id,
      source: "file",
      sourceUrl: session.finalPath,
      gameHint: session.gameHint,
      preferLabels: session.preferLabels,
      sampleFps: session.sampleFps,
    });
    await recordJobFunnel(db, user.id, priorJobs, firstJobAt, cfg.funnelRetainDays);
    // Durable non-blocking submit (ADAAAA-6873): the full file is already
    // reassembled on origin; enqueue it for the durable worker and return 202
    // immediately. The old synchronous awaited runVodJob blocked this request
    // for minutes on a long VOD, which outlasted the Cloudflare/tunnel edge
    // request timeout and handed the browser a Cloudflare 5xx (HTML) page; the
    // webapp polls GET /jobs/:id to a terminal state instead (ADAAAA-5714).
    enqueueVodJob(job.id, session.finalPath);
    const q = store.getJob(job.id)!;
    return reply.code(202).send({
      job: jobForRole(q, user.role),
      accepted: true,
      status: "queued",
      progress: { stage: "queued", framesAnalyzed: 0, framesTotal: 0, framesPct: 0, highlightsFound: 0 },
    });
  });

  // List the caller's jobs (ADAAAA-6760) for the webapp's processing-jobs
  // surface. Newest first, default 50, capped at 200. Caller-scoped: an admin
  // sees every job in this instance; any other role sees only its own, so one
  // user can never read another user's jobs. (This server instance is the
  // company scope, so the query is inherently company-scoped.)
  app.get("/jobs", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user;
    const limitRaw = Number(req.query?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 200) : 50;
    const ownerId = user.role === "admin" ? undefined : user.id;
    // ADAAAA-7624: records written before the counter fix carry no
    // `candidatePath`; project the honest counters so the board tiles read the
    // count the job actually produced instead of a legacy 0.
    // ADAAAA-7727: a non-admin caller never sees the cost/decide/perceive
    // diagnostics on a job (they are internal pipeline + spend data).
    return {
      jobs: jobsForRole(store.listJobsForOwner(ownerId, limit).map((j) => ({ ...j, ...counterFieldsForJob(j) })), user.role),
    };
  });

  app.get("/jobs/:id", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user;
    const job = store.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "not found" });
    if (job.ownerId !== user.id && user.role !== "admin") return reply.code(403).send({ error: "forbidden" });
    // Stable progress projection (ADAAAA-6873) so a full browser refresh
    // re-hydrates the persisted state machine + accumulated progress from
    // GET /jobs/:id, and the durable progress fields roll up into one object.
    const progress = {
      stage: job.stage ?? job.status,
      framesAnalyzed: job.framesAnalyzed ?? 0,
      framesTotal: job.framesTotal ?? 0,
      framesPct: job.framesPct ?? 0,
      highlightsFound: job.highlightsFound ?? 0,
    };
    // ADAAAA-7741: the customer-facing "how live is this" projection, derived at
    // READ time from stored data only (content-clock anchor + summaryLog pairs +
    // newest observation). Zero decide calls, zero GPU. For a terminal job the
    // observation set is not read at all — the edge freezes at completion and the
    // UI renders the completion state instead of a lag chip.
    const liveProgress = deriveLiveProgress({
      job,
      newestObservationTs:
        job.status === "done" || job.status === "failed" || job.status === "cancelled"
          ? 0
          : newestObservationTs(store.observationsForJob(job.id)),
    });
    return {
      job: jobForRole({ ...job, ...counterFieldsForJob(job) }, user.role),
      highlights: store.highlightsForJob(job.id),
      progress,
      liveProgress,
    };
  });

  // ADAAAA-7700: the durable activity log for one job — the append-only trail of
  // why it ended (failureReason + close reason + boot sweep). This is what makes a
  // terminal transition auditable after the in-memory Store is gone, and it is the
  // surface QA reads to prove the attribution landed.
  app.get<{ Params: { id: string } }>("/jobs/:id/lifecycle", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user;
    const job = store.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "not found" });
    if (job.ownerId !== user.id && user.role !== "admin") return reply.code(403).send({ error: "forbidden" });
    const events = await db.jobLifecycleEvents(job.id).catch(() => []);
    return { jobId: job.id, status: job.status, failureReason: job.failureReason ?? null, events };
  });

  // Composite job-detail payload (ADAAAA-6851 Inc 3): { job, highlights, traces,
  // sections }. Frames are grouped into fixed 3 s buckets (section index =
  // floor(timestamp/3)); a frame belongs to exactly one section (partition, no
  // duplicate seq across sections). Decide notes attach to the section that
  // contains their trigger timestamp. Frames are metadata-only (image bytes stay
  // lazy via /jobs/:id/frames/:seq). Owner-or-admin scoped like GET /jobs/:id.
  app.get<{ Params: { id: string } }>("/jobs/:id/detail", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user;
    const job = store.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "not found" });
    if (job.ownerId !== user.id && user.role !== "admin") return reply.code(403).send({ error: "forbidden" });

    // Capacity budget the job ran under: live 3 / VOD 8 (plan: traces <= capacity).
    const maxTraces = maxTracesForSource(job.source);

    const obs = store.observationsForJob(job.id);
    const candidates = store.candidatesForJob(job.id);

    // ADAAAA-7624: per-frame observations are a capped durable window, so a job
    // longer than the cap loses the rows for its first windows and those
    // sections rendered `0 frames` although the JPEGs exist and serve 200. Join
    // the on-disk frame inventory so every frame keeps its section:
    //   - `file` (VOD): a contiguous ffmpeg series in dataDir/frames/<jobId>, so
    //     `frameCount` derives seq 0..n-1 (timestamp from `sampleFps`).
    //   - `browser` (screen-share rail, ADAAAA-7734): the rail persists the JPEGs
    //     it analysed in dataDir/live/<jobId>/frames named by global seq and
    //     decimates the oldest past the storage cap, so the inventory is the
    //     ACTUAL seq list — a count would re-derive deleted frames as tiles.
    const inventory =
      job.source === "file"
        ? { frameCount: jobFrameCount(job.id), sampleFps: job.sampleFps ?? cfg.vodDetailFps }
        : job.source === "browser"
          ? { frameCount: jobFrameCount(job.id), frameSeqs: jobFrameList(job.id).map((f) => f.seq), sampleFps: 1 }
          : undefined;

    const sectionList = buildSections(obs, candidates, job.id, inventory);
    // ADAAAA-7285: point each analysis window that captured audio at a real
    // per-window audio resource (re-extracted on demand from the source), so
    // the analysis-window player has something to play. Silent windows (audio
    // path === "none") are left with no URI — the UI shows "No audio captured".
    attachWindowAudioUris(sectionList, job.id);
    const traces = buildTraces(obs);

    // ADAAAA-7621: `highlights` is the POSTABLE list, not the raw persisted
    // rows. Rejected clips, non-scoring outcomes and self-contradicting verdicts
    // are excluded, and overlapping clip windows collapse into one moment
    // (`duplicateCount` / `mergedIds` on the winner, `duplicateOf` on the
    // merged-away clips, which move to `duplicateHighlights`). The full audit
    // trail of every decide evaluation is unaffected — it rides `sections`.
    const postable = buildPostableHighlights(store.highlightsForJob(job.id));

    // ADAAAA-7623: the summary ladder (match summary -> chapters -> window
    // narratives) derived from STORED data only. Zero decide calls / GPU
    // seconds — the read re-shapes `summaryLog` + the postable highlights.
    const summaryLadder = buildSummaryLadder({
      summaryLog: job.summaryLog,
      highlights: postable.highlights,
      gameHint: job.gameHint,
    });

    // ADAAAA-7727: the embedded job record is filtered for a non-admin caller
    // exactly like GET /jobs/:id, so the composite detail route can never be a
    // side door to the cost/decide/perceive diagnostics.
    return jobDetailForRole(
      JobDetailSchema.parse({
        // ADAAAA-7624: derive the honest counters for records written before the
        // completion-time fix (read-time, no stored-data mutation).
        job: { ...job, ...counterFieldsForJob(job) },
        highlights: postable.highlights,
        notableHighlights: postable.notable,
        duplicateHighlights: postable.duplicates,
        traces,
        sections: sectionList,
        maxTraces,
        summaryLadder,
        // ADAAAA-7741: the customer's own "how live is this" reading, derived
        // read-time from the same stored data the sections are rebuilt from.
        // Top-level (not under `job`) so the role filter keeps it: it carries no
        // pipeline/spend internals, only the lag projection.
        liveProgress: deriveLiveProgress({ job, newestObservationTs: newestObservationTs(obs) }),
        // ADAAAA-7750: WHY the window list is empty, when it is. Derived from
        // stored counters only (no decide, no GPU): a dead capture surface, a
        // share still inside the first-window budget, and a run whose windows
        // were all judged "not a highlight" are three different answers and used
        // to render as the same bare `No analysis windows for this job.`
        capture: deriveLiveCapture({
          job,
          observationCount: obs.length,
          highlightCount: postable.highlights.length,
          // A live share holds an `active` media_sessions row while a media node
          // is carrying it; the row is cleared when the job ends.
          hasLiveMediaSession:
            (await db.getMediaSession(job.id).catch(() => undefined))?.status === "active",
        }),
      }),
      user.role
    );
  });

  // ADAAAA-7742: incremental section stream for an OPEN live job-detail page.
  // `/jobs/:id/detail` is a composite payload whose `sections` grow with every
  // 3 s window (each decide note carries its full analysis, prompt included), so
  // on a long live job every refresh gets heavier and the page can sit one slow
  // request behind — which reads to a viewer as "nothing is streaming". This
  // route returns ONLY the sections whose bucket index is greater than
  // ?afterIndex (bucket index = floor(timestamp / SECTION_WINDOW) — stable and
  // monotonic), plus the small mutable companions the same page renders (job
  // status/summary, postable highlights, summary ladder), so the open page can
  // append the new windows instead of re-sending the accumulated payload. Same
  // owner-or-admin scoping as `/jobs/:id/detail`. Read path only: no decide or
  // inference call is added, and window semantics, bucket size and the decide
  // cadence are unchanged.
  app.get<{ Params: { id: string }; Querystring: { afterIndex?: string } }>(
    "/jobs/:id/sections-delta",
    { preHandler: authReq },
    async (req: any, reply) => {
      const user = req.user;
      const job = store.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: "not found" });
      if (job.ownerId !== user.id && user.role !== "admin") return reply.code(403).send({ error: "forbidden" });

      const raw = (req.query as any).afterIndex;
      const afterIndex = raw === undefined || raw === "" ? -1 : Number(raw);
      if (!Number.isInteger(afterIndex) || afterIndex < -1)
        return reply.code(400).send({ error: "afterIndex must be an integer >= -1" });

      const obs = store.observationsForJob(job.id);
      const candidates = store.candidatesForJob(job.id);
      const sectionList = buildSections(obs, candidates, job.id);
      attachWindowAudioUris(sectionList, job.id);
      const sections = sectionList.filter((s) => s.index > afterIndex);

      // ADAAAA-7621/7623 companions: the postable highlight list and the summary
      // ladder are derived from STORED data on every read (zero decide calls) and
      // are small next to the accumulated sections, so an incremental refresh can
      // carry them and keep highlights/summary streaming with the windows.
      const postable = buildPostableHighlights(store.highlightsForJob(job.id));
      const summaryLadder = buildSummaryLadder({
        summaryLog: job.summaryLog,
        highlights: postable.highlights,
        gameHint: job.gameHint,
      });

      return {
        jobId: job.id,
        afterIndex,
        maxIndex: sectionList.length ? sectionList[sectionList.length - 1].index : -1,
        sectionCount: sectionList.length,
        sections,
        job,
        highlights: postable.highlights,
        notableHighlights: postable.notable,
        duplicateHighlights: postable.duplicates,
        maxTraces: maxTracesForSource(job.source),
        summaryLadder,
      };
    }
  );

  // ADAAAA-7028 Inc 2: queryable decide-audit surface. Returns the durable
  // decide_audit rows for a job (one per frame group), optionally narrowed to a
  // single frame group via ?groupKey=. Owner-or-admin scoped. Each row carries
  // the prompt text, media content hashes (re-attach by hash), raw reply,
  // parsed verdicts, timings, fallback flag, and a replayable marker so an
  // operator can reconstruct + re-submit the exact request.
  app.get<{ Params: { id: string }; Querystring: { groupKey?: string } }>(
    "/jobs/:id/decide-audit",
    { preHandler: authReq },
    async (req: any, reply) => {
      const user = req.user;
      const job = store.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: "not found" });
      if (job.ownerId !== user.id && user.role !== "admin") return reply.code(403).send({ error: "forbidden" });
      const all = await db.decideAuditsForJob(job.id);
      const groupKey = (req.query as any).groupKey as string | undefined;
      const rows = groupKey ? all.filter((a) => a.groupKey === groupKey) : all;
      return { jobId: job.id, groupKey: groupKey ?? null, audits: rows };
    }
  );

  // Delete a job (ADAAAA-6838, increment 2). Owner-or-admin; 404 if missing,
  // 403 if another user. For a VOD `file` job we release any held Livepeer
  // perceive slot synchronously (mirroring the stop path) so deleting never
  // strands a session or squats the capacity-1 slot, then hard-delete the job
  // row + its highlights + media_sessions and remove its on-disk artifacts.
  // A live/browser job still holding an active ingest session returns 409 and
  // the caller must POST /jobs/:id/stop first.
  app.delete<{ Params: { id: string } }>("/jobs/:id", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user;
    const job = store.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "not found" });
    if (job.ownerId !== user.id && user.role !== "admin") return reply.code(403).send({ error: "forbidden" });

    // Live/browser ingest still holding an active session -> 409; caller stops first.
    const liveKinds = ["rtmp", "webrtc", "screenshare", "browser", "file-sim"];
    if (liveKinds.includes(job.source) && (liveSessions.has(job.id) || browserJobs.has(job.id))) {
      return reply.code(409).send({ error: "live/browser ingest still active; use POST /jobs/:id/stop first" });
    }

    // Release any held perceive slot synchronously (mirror the stop path) so
    // deleting never strands a Livepeer session or squats the capacity-1 slot.
    // Idempotent: analyzeJob's `finally` re-leases as a no-op.
    const slot = livePerceiveSlots.get(job.id);
    if (slot) {
      livePerceiveSlots.delete(job.id);
      slot.stopped = true;
      if (slot.current) await adapter.stopPerceive(slot.current.sessionId).catch(() => {});
    }
    if (job.perceiveSessionId) await adapter.stopPerceive(job.perceiveSessionId).catch(() => {});
    // Tear down any lingering live/browser session map entry for a done/failed job.
    const ing = liveSessions.get(job.id);
    if (ing) {
      ing.stop();
      liveSessions.delete(job.id);
    }
    if (browserJobs.has(job.id)) browserJobs.delete(job.id);

    // Remove on-disk artifacts (best-effort) and hard-delete the job + cascade.
    const clipUris = store.highlightsForJob(job.id).map((h) => h.clipUri).filter(Boolean);
    await removeJobArtifacts(cfg.dataDir, job.id, clipUris);
    await store.deleteJob(job.id);

    return { deleted: job.id };
  });

  app.post<{ Params: { id: string } }>("/jobs/:id/stop", { preHandler: authReq }, async (req: any, reply) => {
    const job = store.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "not found" });
    if (job.ownerId !== req.user.id && req.user.role !== "admin")
      return reply.code(403).send({ error: "forbidden" });
    const ing = liveSessions.get(job.id);
    if (ing) {
      ing.stop();
      liveSessions.delete(job.id);
      // ADAAAA-6561: release the perceive slot NOW (synchronously from the
      // stop path) instead of waiting for analyzeJob's `finally`, which only
      // runs after the in-flight GPU /analyze completes (~1.4s). A live job
      // started right after this stop can then re-reserve the capacity-1 slot
      // without a 503. Idempotent — analyzeJob's `finally` re-leases as a no-op,
      // and the slotRef.isStopped flag prevents it re-reserving a fresh session.
      const slot = livePerceiveSlots.get(job.id);
      livePerceiveSlots.delete(job.id);
      if (slot) {
        slot.stopped = true;
        if (slot.current) await adapter.stopPerceive(slot.current.sessionId).catch(() => {});
      }
      return reply.send({ ok: true, job: jobForRole(store.getJob(job.id), req.user.role) });
    }
    // VOD `file` job: the API-level cancel path (ADAAAA-6625). This must work
    // for an in-flight pass (queued / extracting / analyzing / finalizing) AND
    // for an orphaned non-terminal row left behind by a previous process — the
    // ADAAAA-6571 incident, where the only termination path was restarting the
    // container, which dropped the in-flight runVodJob promise and left the row
    // at `active`. Before this, a job holding no perceive slot (queued, still
    // extracting, or orphaned) fell through to the 409 below.
    if (job.source === "file") {
      // Idempotent: a repeated stop on a terminal job is a no-op, never an
      // error, so a caller retrying after a timeout gets a stable answer.
      if (Store.isTerminalStatus(job.status)) {
        return reply.send({ ok: true, alreadyTerminal: true, job: jobForRole(store.getJob(job.id), req.user.role) });
      }
      // 1. Signal cancellation into the in-flight pass: abort a running decode,
      //    and have runVodJob/analyzeJob unwind at the next frame/boundary.
      vodStops.add(job.id);
      const ctl = vodStopControllers.get(job.id);
      vodStopControllers.delete(job.id);
      ctl?.abort();
      vodJobPaths.delete(job.id);
      // 2. Release the held perceive session(s) SYNCHRONOUSLY (mirrors the live
      //    ADAAAA-6561 path). A stop that leaks a perceive session still burns
      //    Livepeer GPU minutes, which is the cost lens this increment is judged
      //    against — analyzeJob's `finally` re-leases as a no-op.
      const released = await releaseVodPerceive(job.id);
      // 3. Terminal row NOW, not on the run's unwind: no stale status=active /
      //    analyzing orphan survives even if this process dies immediately.
      await markJobCancelled(job.id, "stopped (cancelled via API)");
      return reply.send({
        ok: true,
        cancelled: true,
        releasedPerceiveSessions: released,
        job: jobForRole(store.getJob(job.id), req.user.role),
      });
    }
    // Browser capture job: release the perceive session, then cut clips for any
    // recorded highlights from the assembled client recording. Idempotent — a
    // job the media node already finalized on session close (ADAAAA-7689 AC3)
    // answers 200 instead of 409, so the webapp's own stop is harmless.
    if (job.source === "browser") {
      if (!browserJobs.has(job.id) && !browserFinalizing.has(job.id)) {
        if (!Store.isTerminalStatus(job.status)) {
          return reply.code(409).send({ error: "job is not a live ingest or browser capture" });
        }
        return reply.send({ ok: true, alreadyTerminal: true, job: jobForRole(store.getJob(job.id), req.user.role) });
      }
      const finished = await finishBrowserJob(job.id, "stop");
      return reply.send({ ok: true, job: jobForRole(finished.job, req.user.role) });
    }
    return reply.code(409).send({ error: "job is not a live ingest or browser capture" });
  });

  // Media node -> control plane: the media/RTC session carrying this browser
  // job has ended (ADAAAA-7689 AC3). Before this route, a browser job stayed
  // `status: active` after a clean SESSION_CLOSE until someone called
  // `POST /jobs/:id/stop` by hand, which also left the console's
  // `capacity.activeSessions` reading a stream that no longer existed.
  //
  // Called by the media node's teardown path (best-effort, fire-and-forget), so
  // it must be safe to miss, safe to repeat, and safe to arrive late. When the
  // shared MEDIA_HEALTH_TOKEN is configured on both sides the callback is
  // bearer-gated; unset (dev) it behaves like the sibling `/observe` callback.
  app.post<{ Params: { id: string } }>("/jobs/:id/media/session-closed", async (req: any, reply) => {
    if (cfg.mediaHealthToken) {
      const presented = String(req.headers?.authorization ?? "").replace(/^Bearer /, "");
      if (presented !== cfg.mediaHealthToken) return reply.code(401).send({ error: "unauthorized" });
    }
    const job = store.getJob(req.params.id);
    // Not a browser job / unknown / already finalized: 200 with `ignored` so the
    // media node's fire-and-forget call never retries a dead job.
    if (!job || job.source !== "browser") return reply.send({ ok: true, ignored: "not a browser capture job" });
    if (!browserJobs.has(job.id) && !browserFinalizing.has(job.id)) {
      return reply.send({ ok: true, ignored: "job already finalized", job });
    }
    const body = req.body ?? {};
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const bj = browserJobs.get(job.id);
    // A close must only end the job when NO media session is still carrying it.
    // The node reports how many sessions for this job remain live after the one
    // that closed (`liveSessionsForJob`); a newer session can exist when the
    // browser re-provisioned (or when a harness provisioned its own instead of
    // adopting the control plane's). Older nodes do not send the count — then
    // fall back to session-id matching and ignore a close for a stale session.
    const liveForJob = typeof body.liveSessionsForJob === "number" ? body.liveSessionsForJob : null;
    if (liveForJob !== null) {
      if (liveForJob > 0) {
        return reply.send({ ok: true, ignored: "another media session is still live for this job", liveSessionsForJob: liveForJob });
      }
    } else if (sessionId && bj?.mediaSessionId && sessionId !== bj.mediaSessionId) {
      return reply.send({ ok: true, ignored: "stale session", sessionId });
    }
    const reason = typeof body.reason === "string" ? body.reason : "unknown";
    // ADAAAA-7700: attribute the close. `media-node-restart` means the media node
    // took the session down with it (recreate/crash) — that is `media-session-lost`,
    // not a user stop. Every other reason keeps the pre-7700 `done` finalization.
    const outcome = outcomeForMediaCloseReason(reason);
    const finished = await finishBrowserJob(job.id, `media-session-closed:${reason}`, outcome);
    // `reason` travels back in the response and in the media node's own
    // `/health` counters; the SSE wake for the transition is emitted by
    // finishBrowserJob.
    return reply.send({ ok: true, job: finished.job, reason });
  });

  // Browser-capture rail: client posts a sampled frame; run it through the
  // perceive -> decide pipeline inline (lazy persistent perceive session).
  app.post<{ Params: { id: string }; Body: { seq?: number; timestamp?: number; image?: string; reasoningEffort?: string } }>(
    "/jobs/:id/ingest",
    { preHandler: authReq },
    async (req: any, reply) => {
      const job = store.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: "no job" });
      const bj = browserJobs.get(req.params.id);
      if (job.source !== "browser" || !bj) return reply.code(409).send({ error: "not a browser capture job" });
      const { seq = 0, timestamp = 0, image } = req.body ?? {};
      if (!image) return reply.code(400).send({ error: "image required" });
      // ADAAAA-7741: anchor the content clock on the first frame of a WS-rail
      // browser share (no media handshake ran on this path). Idempotent.
      await stampContentClockStart(req.params.id);
      try {
        if (!bj.sessionId) {
          const r = await adapter.reservePerceive();
          bj.sessionId = r.sessionId;
        }
        // Hand perceive the full recorded stream (shared-volume in-container path)
        // so the persistent session's SAM tracker tracks THIS job's whole stream.
        const res = await adapter.analyze(
          bj.sessionId,
          {
            seq,
            timestamp,
            imageB64: image,
            clipPath: browserClipInPerceive(req.params.id),
          },
          // ADAAAA-4109: carry the job's closed vocabulary to perceive so the
          // session activates resolve_vocabulary() on the browser rail too.
          { gameHint: job.gameHint || cfg.gameHintDefault, preferLabels: job.preferLabels }
        );
        bj.evidence.step(res.observation);
        emitJobEvent(req.params.id, { seq, timestamp, type: "observation", observation: res.observation });
        let highlight: any = null;
        if (res.candidate) {
          emitJobEvent(req.params.id, { seq, timestamp, type: "candidate", candidate: res.candidate });
          // Fixed-fee single-shot decide (Gemma 4 12B): gate + meter at the
          // call. This rail is an ACTIVE streaming session (the client is
          // continuously posting sampled frames and is already billed stream
          // processing), so the per-decide fee is WAIVED (ADAAAA-5341): the
          // gate never 402s mid-stream and the decide is metered at $0.
          const duser = (req as any).user;
          const dsub = await db.getSubscription(duser.id);
          await billing.canDecide(duser, dsub, { streaming: true }).catch((err: any) => {
            if (err?.statusCode === 402) {
              emitJobEvent(req.params.id, { seq, timestamp, type: "candidateBlocked", reason: String(err?.message) });
            }
            throw err;
          });
          const d = await adapter.decide(
            {
              eventType: res.candidate.eventType,
              trackCount: bj.evidence.trackCount,
              maxVelocity: bj.evidence.maxVelocity,
              ocrHits: res.observation?.ocr?.length ?? 0,
              scoreBoardChanged: res.candidate?.scoreBoardChanged,
            },
            {
              gameHint: job.gameHint || cfg.gameHintDefault,
              imageB64: image,
              // Frontend-selectable; defaults to "none" (thinking off / fast JSON)
              reasoningEffort: (req.body as any)?.reasoningEffort || "none",
              // ADAAAA-7028 Inc 2: audit identity so the descriptor keys the
              // durable decide_audit index by (sessionId, groupKey).
              jobId: job.id,
              groupKey: decideGroupKey(timestamp),
            }
          );
          await billing.onDecideCompleted(duser, dsub, { streaming: true });
          // ADAAAA-7028 Inc 2: ingest the decide audit descriptor (best-effort;
          // never a pipeline failure).
          await recordDecideAudit(db, (d as any).audit, cfg.decideAuditRetention);
          if (d.isHighlight) {
            // ADAAAA-7247 (ACC-7): use the webui-configured (DB-persisted)
            // per-company clip window (it wins over the bare env default).
            const cw = await resolveClipWindow();
            const win = clipWindow(timestamp, cw.clipBeforeS, cw.clipAfterS, cw.clipWindowMinSec);
            highlight = {
              id: randomUUID(),
              jobId: job.id,
              ownerId: job.ownerId,
              // ADAAAA-6874 (Phase 2): deterministic idempotency key so a
              // re-claimed/resumed job can't double-persist or double-debit the
              // same candidate highlight.
              idempotencyKey: highlightIdempotencyKey(job.id, Math.round(timestamp), d.eventType),
              clipUri: "",
              start: win.start,
              end: win.end,
              eventType: d.eventType,
              score: d.score,
              reason: d.reason,
              status: cfg.autoPublishHighlights ? "accepted" : "pending",
              createdAt: new Date().toISOString(),
            };
            const added = await store.addHighlight(highlight);
            if (added.created) {
              // A browser-capture highlight generated successfully debits the
              // quota once (like VOD/live). Board-capture jobs must also count
              // toward the monthly clip quota. Guarded on first insert so an
              // idempotent retry never double-debits.
              await entitlements.onClipGenerated(duser);
              // Funnel stage 3: generate (a highlight was produced).
              await recordGenerateFunnel(db, duser.id);
              const j = store.getJob(job.id);
              if (j) await store.patchJob(job.id, { highlightsFound: (j.highlightsFound ?? 0) + 1 });
            }
            emitJobEvent(req.params.id, { seq, timestamp, type: "highlight", highlight });
          }
        }
        return { ok: true, highlight, trackCount: bj.evidence.trackCount };
      } catch (e: any) {
        // ADAAAA-7325: perceive capacity exhaustion is transient/retryable —
        // return 503 (not the catch-all 500) so the client can back off.
        return reply.code(mediaErrorStatus(e)).send({ error: String(e?.message || e) });
      }
    }
  );

  // Media-server handshake (b): reserve a perceive session through the media
  // server and return the browser's WS endpoint. The browser then streams
  // sampled frames over that WS (NOT to /ingest) when MEDIA_SERVER_URL is set.
  app.post<{ Params: { id: string } }>("/jobs/:id/media", { preHandler: authReq }, async (req: any, reply) => {
    const job = store.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "no job" });
    if (job.ownerId !== req.user.id && req.user.role !== "admin") return reply.code(403).send({ error: "forbidden" });
    const bj = browserJobs.get(req.params.id);
    // ADAAAA-7700: a session that already died (media-node restart) must NOT be
    // re-provisioned onto a fresh paid session for the same job — the browser's
    // reconnect would silently start a SECOND session for one share. Answer 409
    // with the attribution so the webapp stops capture and says "reshare".
    if (Store.isTerminalStatus(job.status)) {
      return reply.code(409).send({
        error: job.error || `job already ${job.status}`,
        status: job.status,
        failureReason: job.failureReason ?? null,
      });
    }
    if (job.source !== "browser" || !bj) return reply.code(409).send({ error: "not a browser capture job" });
    // ADAAAA-7741: anchor the content clock at the share's start (the media
    // handshake is the first client call of a capture). Idempotent — a reconnect
    // that reuses the session must not move the anchor.
    await stampContentClockStart(req.params.id);
    // Always consult the DB-backed provisioner: it reuses the live session,
    // or — if the media node serving it went down — transparently re-provisions
    // on a healthy node so the browser's reconnect is seamlessly re-routed.
    try {
      const { wsUrl, mediaSessionId, mediaOrigin, iceServers } = await provisionMedia(req.params.id);
      bj.mediaWsUrl = wsUrl;
      bj.mediaSessionId = mediaSessionId;
      // WebRTC ingest (C1): the browser signals to the media server via
      // POST {mediaOrigin}/sessions/{mediaSessionId}/rtc/offer instead of
      // posting sampled frames over the WS. wsUrl is kept for the WS fallback.
      // iceServers lets the browser configure TURN so its peer allocates a
      // relay candidate the media server can reach (ADAAAA-7353).
      return { wsUrl, mediaSessionId, mediaOrigin, rtc: true, iceServers };
    } catch (e: any) {
      // ADAAAA-7325: perceive capacity exhaustion surfaces through provisionMedia
      // as "no capacity available for runner" — return 503 (not the catch-all
      // 500) so the client can back off.
      return reply.code(mediaErrorStatus(e)).send({ error: String(e?.message || e) });
    }
  });

  // Media-node capacity/health + per-node Livepeer GPU cost attribution
  // (ADAAAA-6869 Phase 4). The live console polls this next to a running job.
  //
  // Sources: the node's public `/health` (counts-only), its bearer-gated `/node`
  // detail (session leases — only when MEDIA_HEALTH_TOKEN is configured), and
  // the durable attribution join `media_sessions.node_id` -> `job.costUsd`.
  // ADAAAA-7727: admin-only. This is media-server + spend internals (node ids,
  // session leases, per-node cost), never a customer readout — a non-admin call
  // is 403 and the webapp renders the strip only for an admin session.
  app.get("/media/node", { preHandler: adminReq }, async () => {
    const origin = (cfg.mediaServerUrl ?? "").replace(/\/+$/, "");
    if (!origin) {
      return buildMediaNodeReport({ origin: "", health: null, mediaSessions: [], jobs: [] });
    }
    const getJson = async (path: string, token?: string): Promise<any | null> => {
      try {
        const r = await fetch(`${origin}${path}`, {
          signal: AbortSignal.timeout(2000),
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
        });
        if (!r.ok) return null;
        return (await r.json()) as any;
      } catch {
        // Node down / unreachable: the report degrades to `reachable: false` and
        // still publishes the DB-derived cost attribution.
        return null;
      }
    };
    const health = await getJson("/health");
    // Per-session detail is optional: an unconfigured or down node just yields
    // null, and the console renders capacity/load without lease rows.
    const detail = cfg.mediaHealthToken ? await getJson("/node", cfg.mediaHealthToken) : null;
    const [mediaSessions, jobs] = await Promise.all([db.listMediaSessions(), db.listJobs()]);
    return buildMediaNodeReport({ origin, health, detail, mediaSessions, jobs });
  });

  // Internal callback from the media server: relay an observation the perceive
  // runner published to events-out, stepping the per-job evidence and fanning
  // to the live console. The browser streaming to the media server never touches
  // the Fastify control plane's frame ingest.
  //
  // ADAAAA-7699: the media node ALSO posts the decoded anchor JPEG it already
  // holds at publish time as `frameB64`, which is what lets this rail decide
  // (candidate/trigger -> decide -> highlight) on the same perceive session —
  // the frame travels with the observation, so no second session is opened to
  // fetch pixels. `frameB64` is stripped before the observation is stepped or
  // fanned to SSE (pixels must not ride the console stream).
  app.post<{ Params: { id: string } }>(
    "/jobs/:id/observe",
    // A 480-px-wide JPEG samples to a few tens of KB, but a WS-rail frame can be
    // larger; the default 1 MiB JSON limit is too tight for an anchor frame.
    { bodyLimit: 8 * 1024 * 1024 },
    async (req: any, reply) => {
      const job = store.getJob(req.params.id);
      const bj = browserJobs.get(req.params.id);
      if (!job || job.source !== "browser" || !bj) return reply.code(409).send({ error: "not a browser capture job" });
      const body = req.body;
      if (!body || typeof body !== "object") return reply.code(400).send({ error: "observation required" });
      const { frameB64, ...obs } = body as { frameB64?: string } & Record<string, any>;
      const seq = typeof obs.seq === "number" ? obs.seq : 0;
      const timestamp = typeof obs.timestamp === "number" ? obs.timestamp : 0;
      bj.evidence.step(obs as any);
      emitJobEvent(req.params.id, { seq, timestamp, type: "observation", observation: obs as any });
      // Media (RTC) rail decide wiring: schedule a cadence/anchored decide on
      // the frame the media node just handed us. Returns immediately — decides
      // run on the rail's serial chain so this callback never blocks frames.
      if (typeof frameB64 === "string" && frameB64) {
        const rail = await ensureMediaRail(job, bj).catch(() => null);
        rail?.onObservation(obs as any, frameB64);
      }
      return { ok: true };
    }
  );

  // Media-edge audio relay callback (ADAAAA-7658). The media node decodes the
  // browser's opus RTP with the ffmpeg already in its image and POSTs ~100 ms
  // mono int16 PCM chunks here (the same `{seq, timestamp, samples}` shape the
  // server's own Stage-A tap produces). This route forwards the chunk to
  // perceive `POST /audio` on the SAME runner session the video-in rail uses
  // (the media node tells us which session it paid for), so the Stage-A gate
  // runs on the media path too. Pure DSP — no GPU on this path.
  //
  // A fired candidate is surfaced on the job's SSE stream as `candidate`
  // evidence (provenance for the live console).
  //
  // ADAAAA-7699: it ALSO anchors a decide window on this rail. The media node
  // relays the decoded anchor JPEG with each observation, so the control plane
  // holds the pixels the trigger fired on; the rail keeps the chunk as window
  // audio (ASR text reaches gemma, GEMMA_SEND_AUDIO=0) and queues the trigger
  // for the per-share decide observer, which coalesces re-fires into ONE
  // anchored window and spends the same per-cadence decide budget as any other
  // window (never a per-chunk decide storm).
  app.post<{ Params: { id: string } }>(
    "/jobs/:id/audio",
    // A chunk is ~3.2 KB of base64; reject anything that could be an abuse
    // payload before touching perceive.
    { bodyLimit: 256 * 1024 },
    async (req: any, reply) => {
      const job = store.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: "no job" });
      const body = req.body ?? {};
      const samples = typeof body.samples === "string" ? body.samples : "";
      if (!samples) return reply.code(400).send({ error: "samples required" });
      let pcmBytes = 0;
      try {
        pcmBytes = Buffer.from(samples, "base64").length;
      } catch {
        return reply.code(400).send({ error: "samples must be base64" });
      }
      // int16 mono => even byte count. A misaligned chunk is a broken packet:
      // drop it with a 400 instead of feeding perceive a half sample.
      if (pcmBytes === 0 || pcmBytes % 2 !== 0) {
        return reply.code(400).send({ error: "samples must be aligned int16 PCM" });
      }
      const bj = browserJobs.get(req.params.id);
      const sessionId =
        (typeof body.sessionId === "string" && body.sessionId) ||
        bj?.sessionId ||
        job.perceiveSessionId ||
        "";
      if (!sessionId) return reply.code(409).send({ error: "no perceive session for this job" });
      const seq = Number.isFinite(body.seq) ? Number(body.seq) : -1;
      const timestamp = Number.isFinite(body.timestamp) ? Number(body.timestamp) : 0;
      try {
        const res = await adapter.postAudio(sessionId, { seq, timestamp, samples, streamId: job.id });
        const candidate = res?.candidate ?? null;
        if (candidate) {
          emitJobEvent(job.id, { seq: Math.max(0, seq), timestamp, type: "candidate", candidate });
        }
        // ADAAAA-7699: hand the chunk + a fired trigger to the per-share decide
        // observer. Best-effort: the audio gate stays pure DSP evidence on the
        // media path and a rail hiccup can never fail the chunk forward.
        if (bj) {
          const rail = await ensureMediaRail(job, bj).catch(() => null);
          rail?.onAudioChunk(timestamp, samples);
          if (candidate) rail?.onAudioCandidate(candidate as any);
        }
        return { candidate, series: res?.series ?? [] };
      } catch (e: any) {
        // A gate POST failure is best-effort evidence: 502 so the media node
        // counts it as a dropped chunk and keeps the video rail untouched.
        return reply.code(502).send({ error: String(e?.message || e) });
      }
    }
  );

  // Browser-capture rail: client appends a chunk of the recorded capture (base64)
  // so the server can cut highlight clips from it at stop.
  app.post<{ Params: { id: string }; Body: { base64?: string; mime?: string } }>(
    "/jobs/:id/recording",
    // Allow larger chunk bodies than Fastify's 1 MiB JSON default: a 1 s chunk of
    // a 3 Mbps MediaRecorder stream base64-encodes well over that on a burst,
    // and an over-limit chunk was silently 413'd + swallowed client-side, leaving
    // a truncated/absent recording and empty clipUri at stop (ADAAAA-6522).
    { preHandler: authReq, bodyLimit: 8 * 1024 * 1024 },
    async (req: any, reply) => {
      const job = store.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: "no job" });
      const bj = browserJobs.get(req.params.id);
      if (job.source !== "browser" || !bj) return reply.code(409).send({ error: "not a browser capture job" });
      const { base64, mime } = req.body ?? {};
      if (!base64) return reply.code(400).send({ error: "base64 required" });
      try {
        const { mkdir, writeFile, appendFile, stat } = await import("node:fs/promises");
        if (mime && !bj.recordingExt) bj.recordingExt = mime.includes("mp4") ? ".mp4" : ".webm";
        const p = browserRecordingPath(req.params.id);
        await mkdir(path.dirname(p), { recursive: true });
        const buf = Buffer.from(base64, "base64");
        if (existsSync(p) && (await stat(p)).size > 0) await appendFile(p, buf);
        else await writeFile(p, buf);
        return { ok: true, bytes: buf.length };
      } catch (e: any) {
        return reply.code(500).send({ error: String(e?.message || e) });
      }
    }
  );

  // Frame debugger: expose the sampled frames a job actually saw + the perceive
  // observations (boxes) so the console can overlay Florence/SAM boxes on any past
  // frame. Frames live under dataDir/frames/<jobId> (VOD) or dataDir/live/<jobId>/frames (live).
  function jobFrameDir(jobId: string): string | null {
    const live = path.join(cfg.dataDir, "live", jobId, "frames");
    if (existsSync(live)) return live;
    const vod = path.join(cfg.dataDir, "frames", jobId);
    if (existsSync(vod)) return vod;
    return null;
  }

  /** ADAAAA-7734: whether this job's frame files carry their seq in the NAME
   *  (`frame_<seq>.jpg`) instead of being a contiguous ffmpeg series numbered
   *  from 000001. The media (screen-share/RTC) rail names frames by the global
   *  seq and decimates old ones to stay under a storage cap, so the sorted
   *  POSITION is no longer the seq for those jobs — the routes must parse the
   *  suffix or tile N would render frame M after decimation. */
  function jobFrameSeqIsAbsolute(jobId: string): boolean {
    return store.getJob(jobId)?.source === "browser";
  }

  /** ADAAAA-7734: every servable frame of a job as `{seq, file}`, ordered by seq.
   *  Empty when the job has no frame dir (the routes 404 on that). */
  function jobFrameList(jobId: string): { seq: number; file: string }[] {
    const dir = jobFrameDir(jobId);
    if (!dir) return [];
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
    } catch {
      return [];
    }
    // VOD / live-RTMP dirs: ffmpeg wrote frame_000001.jpg.. contiguously, so the
    // sorted position IS the seq (unchanged legacy mapping).
    if (!jobFrameSeqIsAbsolute(jobId)) return files.map((file, seq) => ({ seq, file }));
    // Browser rail dirs: the file's numeric suffix is the frame's global seq.
    const out: { seq: number; file: string }[] = [];
    for (const file of files) {
      const seq = parseLiveFrameSeq(file);
      if (seq === null) continue;
      out.push({ seq, file });
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  /** ADAAAA-7624: count the sampled JPEGs a job wrote to disk, so
   * `GET /jobs/:id/detail` can partition every frame even when the per-frame
   * observation window was trimmed. Best-effort: 0 when the dir is missing. */
  function jobFrameCount(jobId: string): number {
    return jobFrameList(jobId).length;
  }

  app.get<{ Params: { id: string } }>("/jobs/:id/observations", { preHandler: authReq }, async (req: any, reply) => {
    if (!store.getJob(req.params.id)) return reply.code(404).send({ error: "no job" });
    return { observations: store.observationsForJob(req.params.id) };
  });

  app.get<{ Params: { id: string } }>("/jobs/:id/frames", { preHandler: authReq }, async (req: any, reply) => {
    const dir = jobFrameDir(req.params.id);
    if (!dir) return reply.code(404).send({ error: "no frames for job" });
    const list = jobFrameList(req.params.id);
    const tsBySeq = new Map(store.observationsForJob(req.params.id).map((o) => [o.seq, o.timestamp]));
    return {
      frames: list.map((f) => ({ seq: f.seq, uri: `/jobs/${req.params.id}/frames/${f.seq}`, timestamp: tsBySeq.get(f.seq) ?? null })),
    };
  });

  app.get<{ Params: { id: string; seq: string } }>("/jobs/:id/frames/:seq", { preHandler: authReq }, async (req: any, reply) => {
    const dir = jobFrameDir(req.params.id);
    if (!dir) return reply.code(404).send({ error: "no frames for job" });
    const idx = parseInt(req.params.seq, 10);
    // ADAAAA-7734: a browser-rail job's seq is the file's numeric suffix (it
    // survives decimation); every other rail keeps the sorted-position mapping.
    const list = jobFrameList(req.params.id);
    const f = jobFrameSeqIsAbsolute(req.params.id) ? list.find((e) => e.seq === idx)?.file : list[idx]?.file;
    if (!f) return reply.code(404).send({ error: "no such frame" });
    const abs = path.join(dir, f);
    if (!existsSync(abs)) return reply.code(404).send({ error: "not found" });
    return reply.type("image/jpeg").send(createReadStream(abs));
  });

  // ADAAAA-7285: serve a per-window audio clip (mono 16 kHz WAV) re-extracted on
  // demand from the job source recording, so the analysis-window player can
  // actually play. The job-detail read path points each analysis window's
  // `audio.uri` at this route. Public like `/clips/*` so the `<audio>` element
  // can fetch it directly without an Authorization header (per the ADAAAA-7277
  // player design); the media is per-job and the job/timestamp range is only
  // reachable from the (auth-protected) job-detail payload.
  //   GET /jobs/:id/windows/audio?start=<s>&end=<s>
  // 400 for a missing/invalid window, 404 when the source recording is gone or
  // carries no audio stream (a silent source must not yield a bogus URI).
  const jobSourceRecordingPath = (job: { source: string; sourceUrl?: string; id: string }): string | null => {
    const candidates: string[] = [];
    if (job.sourceUrl) candidates.push(job.sourceUrl); // VOD `file` job local path
    if (job.source !== "file") {
      // Live-injest MPEG-TS session, or the browser capture once assembled.
      candidates.push(path.join(cfg.dataDir, "live", job.id, "session.ts"));
      candidates.push(path.join(cfg.dataDir, "live", job.id, "capture.webm"));
      candidates.push(path.join(cfg.dataDir, "live", job.id, "capture.mp4"));
    }
    for (const c of candidates) {
      if (c && existsSync(c) && statSync(c).size > 0) return c;
    }
    return null;
  };
  app.get<{ Params: { id: string }; Querystring: { start?: string; end?: string } }>(
    "/jobs/:id/windows/audio",
    async (req: any, reply) => {
      const job = store.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: "not found" });
      const start = parseFloat(req.query.start as string);
      const end = parseFloat(req.query.end as string);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        return reply.code(400).send({ error: "start/end query args required (seconds), end must be > start" });
      }
      const source = jobSourceRecordingPath(job);
      if (!source) {
        return reply.code(404).send({ error: "source recording not available for this job (live source no longer on disk)" });
      }
      // A silent source must not yield a "valid-looking" URI: pre-check so the
      // ADAAAA-7248 "no audio captured" semantics stay honest.
      if (!(await probeHasAudio(cfg.ffmpegPath, source))) {
        return reply.code(404).send({ error: "no audio track in job source (silent window)" });
      }
      let wav: Buffer;
      try {
        wav = await extractAudioWindow(cfg.ffmpegPath, source, start, end - start);
      } catch (e: any) {
        return reply.code(404).send({ error: `could not extract window audio: ${String(e?.message || e).slice(0, 200)}` });
      }
      if (!wav || wav.length === 0) return reply.code(404).send({ error: "no audio in window" });
      return reply.type("audio/wav").header("Content-Length", String(wav.length)).send(wav);
    }
  );

  // Live-console overlay: Server-Sent Events stream of observations / candidates
  // / highlights for a live (or file-sim) job, as analysis runs. Client re-subscribes
  // with EventSource; heartbeats keep proxies from closing an idle connection.
  app.get<{ Params: { id: string } }>("/jobs/:id/events", { preHandler: authReq }, async (req: any, reply: any) => {
    const job = store.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "no job" });
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown) => {
      try {
        // ADAAAA-7727: the event stream is fanned to the caller, so it is
        // filtered for a non-admin viewer at the send boundary (cost/decide/
        // perceive diagnostics never ride a customer SSE channel).
        const payload = jobEventForRole(data as Record<string, any>, req.user?.role);
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        /* client gone */
      }
    };
    send("ready", { status: job.status });
    const unsub = subscribeJob(job.id, (ev) => send(ev.type, ev));
    const hb = setInterval(() => {
      try {
        res.write(": hb\n\n");
      } catch {
        /* ignore */
      }
    }, 15000);
    req.raw.on("close", () => {
      clearInterval(hb);
      unsub();
    });
    return reply; // keep the socket open
  });

  // Operator control intent for a live-console session, including the INC-6
  // on-demand find-and-track intent (track/seed/evict/lock). The `track` /
  // `find-track` intent carries the user-selected object bbox and is forwarded
  // to the perceive session over HTTP so the runner actually follows it
  // (Florence find -> SAM track -> selected-track accuracy surfaced in the UI).
  // Async + best-effort: we ack immediately with the recorded intent and always
  // return the current job; a dropped forward (session re-reserved/404) never
  // fails the request.
  app.post<{ Params: { id: string }; Body: { type?: string; args?: any } }>(
    "/jobs/:id/control",
    { preHandler: authReq },
    async (req: any, reply) => {
      const job = store.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: "no job" });
      const type = req.body?.type || "none";
      const args = req.body?.args ?? {};
      // Resolve the active perceive session for this job: the browser-capture
      // rail keeps it on the job record, and a VOD/live job persists it on the
      // job once the session is reserved.
      const sid = browserJobs.get(job.id)?.sessionId || job.perceiveSessionId;
      // Control messages (find-and-track intent) mirror the perceive schema: a
      // flat object with `type` plus its args spread at top level.
      const fwd = { type, ...args };
      if (sid && ["track", "find-track", "seed", "lock", "evict", "configure"].includes(type)) {
        adapter.controlForward(sid, fwd).catch((e: any) => {
          // Best-effort: never surface a dropped find-and-track to the user as a
          // failure; the console ack reflects the recorded intent.
          console.error(`[control:${job.id}] forward ${type} failed:`, e?.message || e);
        });
      }
      return { ok: true, control: { type, args, at: new Date().toISOString() }, job: jobForRole(store.getJob(job.id), req.user.role) };
    }
  );

  // --- Florence-2 fine-tune data path (ADAAAA-5164) --------------------------
  // Extract a VOD clip to curation frames (sliding-window frame-rate aware).
  // The client sets inSec/outSec time handles + an fps (default ~1); only the
  // frames inside that window are extracted. No training GPU is scheduled on
  // this leg; this only stages frames for the Dataset Curation UI.
  app.post<{ Body: { source?: string; fps?: number; inSec?: number; outSec?: number } }>("/training/extract", { preHandler: authReq }, async (req, reply) => {
    const source = req.body?.source;
    if (!source) return reply.code(400).send({ error: "source is required" });
    const outDir = path.join(cfg.dataDir, "training", "extract", randomUUID());
    try {
      const frames = await extractFramesForDataset({
        ffmpegPath: cfg.ffmpegPath,
        source,
        outDir,
        fps: req.body?.fps,
        inSec: req.body?.inSec,
        outSec: req.body?.outSec,
      });
      // Probe the clip's total duration so the curation UI's sliding-window
      // carousel can bound the timeline (ADAAAA-5512 / ADAAAA-5509). Non-fatal:
      // when the source can't be probed the UI keeps an unbounded timeline.
      const clipDuration = await probeDuration(cfg.ffmpegPath, source);
      return { frames, clipDuration };
    } catch (e: any) {
      return reply.code(422).send({ error: String(e?.message || e) });
    }
  });

  // Validate + write the curated train/val manifests. Server-side gate: any
  // sample that fails the shared Zod schema returns 422 and writes nothing.
  //
  // ADAAAA-5396 (Change 3): when a dataset is SENT here, it is also persisted
  // to the server DB (datasets table) so it is retrievable across reloads and
  // new sessions while the owning account stays active on a paid plan.
  // Retrieval (GET /datasets, GET /datasets/:id) is plan-gated separately; the
  // send itself is open to any authenticated user who has curated a valid set.
  app.post<{ Body: { train?: unknown[]; val?: unknown[] } }>("/training/manifests", { preHandler: authReq }, async (req, reply) => {
    const train = (req.body?.train ?? []) as DetectionTrainingSample[];
    const val = (req.body?.val ?? []) as DetectionTrainingSample[];
    const res = await writeTrainValManifests({
      train,
      val,
      evalsDir: path.join(cfg.dataDir, "..", "evals"),
    });
    if (!res.ok) return reply.code(422).send(res);
    const user = (req as any).user as { id: string };
    const now = new Date().toISOString();
    const dataset: Dataset = DatasetSchema.parse({
      id: randomUUID(),
      ownerId: user.id,
      name: `dataset-${now}`,
      train,
      val,
      imageRefs: [...new Set([...train, ...val].map((s) => s.imageRef))],
      trainCount: train.length,
      valCount: val.length,
      status: "active",
      createdAt: now,
    });
    await db.saveDataset(dataset);
    return reply.send({ ...res, dataset: toDatasetSummary(dataset) });
  });

  // Serve extracted training frames so the Dataset Curation UI can render
  // them. imageRef from /training/extract is "<bucket>/frame_XXXX.jpg" relative
  // to dataDir/training/extract; map it here, confined to that directory so a
  // malicious ref can never escape the training staging root.
  app.get<{ Params: { "*": string } }>("/training/frames/*", { preHandler: authReq }, async (req: any, reply: any) => {
    const rel = req.params["*"] as string;
    if (!rel || !rel.endsWith(".jpg") || rel.includes("..")) {
      return reply.code(400).send({ error: "bad frame ref" });
    }
    const root = path.join(cfg.dataDir, "training", "extract");
    const abs = path.join(root, rel);
    if (!abs.startsWith(root + path.sep) || !existsSync(abs)) {
      return reply.code(404).send({ error: "frame not found" });
    }
    return reply.type("image/jpeg").send(createReadStream(abs));
  });

  // --- saved dataset archive (ADAAAA-5396, Change 3) ------------------------
  // The curated train/val manifests persisted on send (POST /training/manifests)
  // are retrievable here. Same company/owner-scope rules as other entities
  // (owner or admin may read), plus a plan gate: retrieval is allowed only while
  // the owning account is ACTIVE on a paid (non-starter) plan. A starter (free)
  // account or a deactivated paid account (canceled / past_due) is denied
  // (403), so the archive never surfaces to accounts that no longer qualify.
  app.get("/datasets", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user as { id: string; role?: string };
    const sub = await db.getSubscription(user.id);
    if (user.role !== "admin" && !canRetrieveDataset(sub)) {
      return reply.code(403).send({ error: "dataset archive requires an active paid plan", code: "paid_plan_required" });
    }
    const all = await db.listDatasets(user.role === "admin" ? undefined : user.id);
    return { datasets: all.map(toDatasetSummary) };
  });

  app.get<{ Params: { id: string } }>("/datasets/:id", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user as { id: string; role?: string };
    const ds = await db.getDataset(req.params.id);
    if (!ds) return reply.code(404).send({ error: "dataset not found", code: "not_found" });
    // Company/owner scope: only the owning user (or an admin) may read a saved
    // dataset — matches the other owner-scoped entities (e.g. train runs).
    if (ds.ownerId !== user.id && user.role !== "admin") {
      return reply.code(403).send({ error: "forbidden", code: "forbidden" });
    }
    const sub = await db.getSubscription(user.id);
    if (user.role !== "admin" && !canRetrieveDataset(sub)) {
      return reply.code(403).send({ error: "dataset retrieval requires an active paid plan", code: "paid_plan_required" });
    }
    return { dataset: ds };
  });

  // --- Dataset zip download for local retention (ADAAAA-5391 C5) ----------
  // Download a persisted dataset (manifests + annotated frames) as a
  // self-contained ZIP the user keeps locally. Company/owner-scoped like the
  // rest of the dataset API, gated on the Change 3 retention rule — available
  // while the owning account is paid & active (canRetrieveDataset); blocked on
  // starter or a deactivated paid plan; 404 when nothing is persisted yet. An
  // optional ?id= pins a specific saved dataset; otherwise the newest one for
  // the user is downloaded.
  app.get<{ Querystring: { id?: string } }>("/training/dataset.zip", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user as { id: string; role?: string };
    const sub = await db.getSubscription(user.id);
    if (user.role !== "admin" && !canRetrieveDataset(sub)) {
      return reply.code(403).send({ error: "dataset download requires an active paid (Pro) plan", code: "plan_required" });
    }
    let ds: Dataset | undefined;
    if (req.query?.id) {
      ds = await db.getDataset(req.query.id);
      // Owner scope: a non-admin may only download their own dataset.
      if (ds && ds.ownerId !== user.id && user.role !== "admin") ds = undefined;
      if (!ds) return reply.code(404).send({ error: "dataset not found", code: "not_found" });
    } else {
      const all = await db.listDatasets(user.role === "admin" ? undefined : user.id);
      ds = all[0]; // newest first
      if (!ds) return reply.code(404).send({ error: "no persisted dataset for this account yet", code: "no_dataset" });
    }
    let zip: Buffer;
    try {
      zip = await buildDatasetZip({ dataset: ds, readImage: (ref) => readPersistedImage(cfg, ref) });
    } catch (e: any) {
      // Never serve a corrupt/partial archive (e.g. frames purged or missing).
      return reply.code(409).send({ error: String(e?.message || e), code: "dataset_incomplete" });
    }
    reply.header("Content-Disposition", `attachment; filename="dataset-${ds.id}.zip"`);
    reply.header("X-Dataset-Id", ds.id);
    reply.header("X-Dataset-Train", String(ds.trainCount));
    reply.header("X-Dataset-Val", String(ds.valCount));
    return reply.type("application/zip").send(zip);
  });

  // --- Store a dataset directly (ADAAAA-5398 C4) ---------------------------
  // Same persistence model as POST /training/manifests (inline Dataset record
  // in the server DB), exposed as its own route for callers that persist a
  // curated set without going through the eval-manifest send. Zod-validates
  // every sample, is plan-gated like the rest of the dataset API, and returns
  // the stored record (with a null purgingAt) on 201.
  app.post<{ Body: { name?: string; train?: unknown[]; val?: unknown[] } }>(
    "/datasets",
    { preHandler: authReq },
    async (req: any, reply) => {
      const user = req.user as { id: string; role?: string };
      const sub = await db.getSubscription(user.id);
      if (user.role !== "admin" && !datasetAccessActive(sub)) {
        return reply.code(403).send({ error: "storing a dataset requires an active non-starter plan" });
      }
      const train = (req.body?.train ?? []) as DetectionTrainingSample[];
      const val = (req.body?.val ?? []) as DetectionTrainingSample[];
      const errors: string[] = [];
      (["train", "val"] as const).forEach((side) => {
        (side === "train" ? train : val).forEach((sample, i) => {
          const r = DetectionTrainingSampleSchema.safeParse(sample);
          if (!r.success) errors.push(`${side}[${i}]: ${r.error.message}`);
        });
      });
      if (errors.length) return reply.code(422).send({ error: "invalid manifest", errors });
      const now = new Date().toISOString();
      const dataset: Dataset = DatasetSchema.parse({
        id: randomUUID(),
        ownerId: user.id,
        name: String(req.body?.name ?? `dataset-${now}`).slice(0, 200),
        train,
        val,
        imageRefs: [...new Set([...train, ...val].map((sample) => sample.imageRef))],
        trainCount: train.length,
        valCount: val.length,
        status: "active",
        createdAt: now,
      });
      await db.saveDataset(dataset, null);
      return reply.code(201).send({ ...dataset, purgingAt: null });
    }
  );

  // Admin: the 30-day dataset retention purge log (QA-observable run/purge log).
  app.get("/admin/dataset-purge-log", { preHandler: adminReq }, async () => ({
    entries: await db.listDatasetPurgeLog(200),
  }));
  app.get("/highlights", { preHandler: authReq }, async (req: any) => {
    const user = req.user;
    const all = store.allHighlights();
    return { highlights: user.role === "admin" ? all : all.filter((h) => h.ownerId === user.id) };
  });

  app.post<{ Params: { id: string }; Body: { status: "accepted" | "rejected" } }>(
    "/highlights/:id/review",
    { preHandler: authReq },
    async (req: any, reply) => {
      try {
        const user = req.user as { id: string; role: string };
        const cur = store.getHighlight(req.params.id);
        if (!cur) return reply.code(404).send({ error: "no highlight" });
        // Ownership scoping: the owner (or an admin) may review a clip. This is
        // the user's precision backstop over auto-detected highlights, so it
        // must work for the owning user, not just admins.
        if (user.role !== "admin" && cur.ownerId !== user.id) {
          return reply.code(403).send({ error: "not your highlight" });
        }
        const status: "accepted" | "rejected" = req.body?.status === "rejected" ? "rejected" : "accepted";
        const prev = cur.status;
        const next = await store.reviewHighlight(cur.id, status);
        // Quota accounting — only accepted clips consume the clip-count limit,
        // and the change must be idempotent (no off-by accounting on replay):
        //  - reject releases the slot the generation debited (skip if already
        //    rejected, so re-rejecting never double-releases);
        //  - accept re-consumes it only when coming back from rejected (a
        //    first accept or a re-accept of an accepted/pending clip is a
        //    no-op — the slot was already debited at generation).
        if (status === "rejected" && prev !== "rejected") {
          await entitlements.onClipRejected(user);
        } else if (status === "accepted" && prev === "rejected") {
          await entitlements.onClipAccepted(user);
        }
        return next;
      } catch (e: any) {
        return reply.code(404).send({ error: String(e?.message || e) });
      }
    }
  );

  // Public feed — accepted clips only, no auth (public beta finish line).
  app.get("/feed", async () => ({ highlights: store.acceptedHighlights() }));

  app.get("/clips/*", async (req: any, reply) => {
    const fileParts = (req.params as any)["*"];
    const f = path.join(cfg.dataDir, "clips", fileParts);
    try {
      const { createReadStream } = await import("node:fs");
      return reply.type("video/mp4").send(createReadStream(f));
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  // Serve the built webapp (SPA) for any unmatched GET; API routes above win.
  attachSpaServing(app, cfg);

  // Boot-time durable VOD re-claim (ADAAAA-6873): the store was hydrated by
  // server/index.ts before buildApp, so re-claim any non-terminal job left by a
  // prior process (restart/crash). Fire-and-forget so the listener starts
  // immediately; the drain re-queues stranded jobs and resumes them exactly
  // once (idempotent onEvent prevents duplicate clips / double quota debit).
  recoverStaleVodJobs().catch((e) => console.error(`[vod] boot re-claim failed:`, String(e?.message || e)));

  return app;
}

// ---------------------------------------------------------------------------
// Static SPA serving
//
// The public beta landing page is the built webapp. It ships as static files
// in `webapp/dist`, and the server serves them over HTTP(S) so the landing
// (and the rest of the SPA) is reachable on the domain without a separate
// static host. API routes are registered above and win; anything else on GET
// falls through here. A non-existent path falls back to index.html so the
// SPA's client-side routes (/auth, /privacy, …) work on deep links.
// ---------------------------------------------------------------------------

const SPA_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

/** Resolve the built webapp directory: explicit env, else repo-local dist. */
function resolveWebappDist(cfg: ServerConfig): string | null {
  const candidates: string[] = [];
  if (cfg.webappDist) candidates.push(cfg.webappDist);
  candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../webapp/dist"));
  for (const c of candidates) {
    try {
      if (existsSync(path.join(c, "index.html"))) return c;
    } catch {
      /* ignore unreadable candidate */
    }
  }
  return null;
}

/** ADAAAA-7147: derive the Tier-2 signal-gate tuning for an AnalyzeConfig from
 * server config. Returns undefined when neither knob is set (the gate keeps the
 * recall-safe baseline — ball velocity ignored, uncalibrated windows escalate).
 * `ballMinSpeedMps` is the calibration-free image-space `speedMps` threshold;
 * `suppressQuiet` enables quiet-uncalibrated suppression. */
function buildObserveSignalGateOpts(cfg: ServerConfig): SignalGateOptions | undefined {
  if (cfg.observeSignalGateBallMinSpeedMps === undefined && !cfg.observeSignalGateSuppressQuiet) return undefined;
  return {
    ...(cfg.observeSignalGateBallMinSpeedMps !== undefined ? { ballMinSpeedMps: cfg.observeSignalGateBallMinSpeedMps } : {}),
    suppressQuietUncalibrated: cfg.observeSignalGateSuppressQuiet,
  };
}

/**
 * ADAAAA-7663: build the LIVE pass's `AnalyzerConfig`.
 *
 * Extracted from `runLiveJob` so the live wiring is directly unit-testable — in
 * particular the Stage-2 confirm gate. The live observe pass used to omit
 * `confirmEnabled` entirely (VOD-first rollout), so `shouldRunConfirm()`
 * early-returned and a live RTMP job that accepted goal-shaped Stage-1 reads
 * still wrote 0 `gNNN:confirm` decide-audit rows. Both passes now derive the
 * gate from `DECIDE_CONFIRM_ENABLED`; flag off => `confirmEnabled: false`, which
 * is a strict no-op (the Stage-1 path is byte-identical to today).
 *
 * `confirmReuseWindowS` is LIVE-only: the live observer's rolling window center
 * slides with the cadence, so one goal is re-read by every window that still
 * contains it and the center-keyed identity is not stable. The horizon is the
 * observe window plus one cadence tick of slack, which keeps the dive at one per
 * distinct goal without letting a nearby dive refute a genuinely different one.
 */
export interface LiveAnalyzerConfigDeps {
  cfg: ServerConfig;
  job: { id: string; gameHint?: string; preferLabels?: string[]; cameraId?: string };
  clipWindow: { clipBeforeS: number; clipAfterS: number; clipWindowMinSec?: number };
  onDecision?: AnalyzerConfig["onDecision"];
  onDecideAudit?: AnalyzerConfig["onDecideAudit"];
  getRunningSummary?: AnalyzerConfig["getRunningSummary"];
  onRunningSummary?: AnalyzerConfig["onRunningSummary"];
}

export function buildLiveAnalyzerConfig(deps: LiveAnalyzerConfigDeps): AnalyzerConfig {
  const { cfg, job, clipWindow: cw, onDecision, onDecideAudit, getRunningSummary, onRunningSummary } = deps;
  return {
    jobId: job.id,
    clipBeforeS: cw.clipBeforeS,
    clipAfterS: cw.clipAfterS,
    clipWindowMinSec: cw.clipWindowMinSec,
    gameHint: job.gameHint || cfg.gameHintDefault,
    preferLabels: job.preferLabels,
    // ADAAAA-6577: bounded exponential backoff between a perceive
    // session-lost re-reserve and the retry of the same frame.
    sessionRetryBackoffMs: cfg.vodSessionRetryBackoffMs,
    sessionRetryBackoffMaxMs: cfg.vodSessionRetryBackoffMaxMs,
    // ADAAAA-6314 Path 2: live trigger candidates forward the surrounding
    // audio clip so the decide prompt gets ASR'd audio context (env-gated).
    audioContext: cfg.audioContext,
    // ADAAAA-7777 (lever B, trim 2): the live window's AUDIO CLIP is a per-call
    // trim knob. The audio-ENERGY level curve (noise-change detection contract)
    // stays wired through `audioContext`; only the raw clip + its ASR transcript
    // are gated here.
    decideAudioClip: cfg.liveDecideAudioClip,
    // ADAAAA-7781: the COMPACT verdict contract on the live rail only. The live
    // pass is decode-bound, so the per-call output-token count IS its throughput
    // ceiling; VOD keeps the full long-form contract.
    liveDecideCompact: cfg.liveDecideCompact,
    // ADAAAA-7777 (lever B, trim 1): the live window's frame budget (default 30,
    // the historic shared cap). A live decide call's wall time is decode-bound,
    // so this trims the smaller per-frame prefill term without touching VOD.
    observeMaxFrames: cfg.liveObserveMaxFrames,
    // Increment D (ADAAAA-6467): the what-to-track planner's warm-up window
    // + out-of-band re-check cadence on the LIVE pass (cap 3).
    warmupSeconds: cfg.warmupSeconds,
    recheckIntervalSeconds: cfg.recheckIntervalSeconds,
    planMode: "live",
    // ADAAAA-7011: wire the LIVE decide-observer into the live job path
    // (config-gated). When on, decide runs on the ~3 s cadence regardless
    // of whether perceive emitted a candidate.
    liveObserveLoop: cfg.liveObserveLoop,
    // ADAAAA-7676: bound the live observe lag against the wall clock — see
    // AnalyzerConfig.liveObserveLagBudgetS. Default 30 s (`LIVE_OBSERVE_LAG_BUDGET_S`).
    liveObserveLagBudgetS: cfg.liveObserveLagBudgetS,
    // ADAAAA-7771: keep K decide windows in flight per live stream so the ~3 s
    // cadence is held (acceptance stays serial in content order). Default 4.
    liveObserveInFlight: cfg.liveObserveInFlight,
    // ADAAAA-7771: the box's decide admission width, so the per-stream in-flight
    // depth is shared instead of oversubscribing the client's decide gate.
    liveDecideAdmission: cfg.decideConcurrency ?? 2,
    // ADAAAA-7145: gate the live decide-observer's billable decide calls on
    // a real highlight signal (recall-safe). Default off.
    observeSignalGate: cfg.observeSignalGate,
    observeSignalGateOpts: buildObserveSignalGateOpts(cfg),
    // ADAAAA-7152 (Gap 2): per-camera pitch calibration forwarded to the
    // perceive session via the `configure` control so perceive emits a REAL
    // goalCrossed/ballOutcome attestation. Resolved per camera; absent =>
    // no `configure` sent (uncalibrated, recall-safe, unchanged).
    perceiveCalibration: resolvePerceiveCalibration(cfg.perceiveCalibration, job.cameraId),
    // ADAAAA-6851 Inc 2: persist every decide evaluation durably.
    onDecision,
    // ADAAAA-7028 Inc 2: ingest the decide audit descriptor durably.
    onDecideAudit,
    // ADAAAA-7111 (Increment D): maintain the job's running video summary
    // (story-so-far) across cadence observe ticks — read it to carry into
    // the decide request, persist the updated one for the job-detail UI.
    getRunningSummary,
    onRunningSummary,
    // Increment F / ADAAAA-6465: capped frame-sequence assembly (primary
    // evidence). Live uses the default analysis_fps / windows.
    analysisFps: cfg.analysisFps,
    maxFramesPerAnalysis: cfg.maxFramesPerAnalysis,
    preWindowS: cfg.analysisPreWindowS,
    postWindowS: cfg.analysisPostWindowS,
    // ADAAAA-6489 / ADAAAA-7159 Gap 2: per-camera/per-clip goal-line
    // calibration for this live stream/job (absent -> no goal-line signal,
    // reported not_captured, never fabricated). Keyed by job id (a live
    // stream has no stable clip id configured on the job), then `default`
    // (ADAAAA-7163 Blocker 1).
    calibration: resolveGoalLineCalibration(cfg, [job.id]),
    // ADAAAA-7663: Stage-2 goal/near-miss confirmation pass on the LIVE pass.
    // The live pass previously left this unset, so shouldRunConfirm() returned
    // false on every live read and no gNNN:confirm row could ever be written.
    // ADAAAA-7777 (lever B, trim 3): the live rail can skip the Stage-2 dive
    // without touching VOD (`LIVE_DECIDE_CONFIRM=0`). DECIDE_CONFIRM_ENABLED
    // stays the master gate, so `off` is still a strict no-op.
    confirmEnabled: cfg.decideConfirmEnabled && cfg.liveDecideConfirm,
    confirmWindowExtraS: cfg.decideConfirmExtraWindowS,
    // One confirm dive per distinct goal across the overlapping rolling windows
    // (the observe window + a cadence tick of slack; see
    // LiveRunShared.confirmedGoalNear). Deliberately smaller than the goal burst
    // window so a nearby distinct goal keeps its own dive.
    confirmReuseWindowS: cfg.decideConfirmLiveReuseWindowS,
  };
}

/** Stable clip/camera key an operator would configure a calibration under.
 * Derives a basename from the job's source URL/path so a calibration can be
 * keyed per clip (e.g. `real_goal_3080.mp4`) rather than the server-side random
 * job id. Falls back to the raw source string when a basename is unavailable. */
export function stableClipCalibrationKey(sourceUrl?: string): string | undefined {
  if (!sourceUrl) return undefined;
  try {
    const u = new URL(sourceUrl);
    const base = path.basename(u.pathname);
    return base || sourceUrl;
  } catch {
    return path.basename(sourceUrl) || sourceUrl;
  }
}

/** ADAAAA-7152 cont / ADAAAA-7163 Blocker 1: resolve a job's per-camera/per-clip
 * goal-line calibration by trying a prioritized list of keys in order — the
 * exact job id first, then any stable clip/camera identifier, then a reserved
 * `default`. A job id is a server-side random UUID, so keying by it alone made
 * the calibration UNREACHABLE for an operator. Absent any match -> undefined
 * (perceive reports not_captured, never fabricated). */
export function resolveGoalLineCalibration(
  cfg: ServerConfig,
  keys: Array<string | undefined>,
): GoalLineCalibration | undefined {
  for (const key of keys) {
    if (!key) continue;
    const v = cfg.goalLineCalibrations?.[key];
    if (v) return v;
  }
  return cfg.goalLineCalibrations?.default;
}

function spaHandler(cfg: ServerConfig) {
  return async (req: any, reply: any) => {
    if (req.method !== "GET" && req.method !== "HEAD") return reply.code(404).send({ error: "not found" });
    const dist = resolveWebappDist(cfg);
    const url = (req.url.split("?")[0] ?? "/");
    // API-only mode (no built webapp) or an unknown API route -> JSON 404.
    if (!dist || url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    let rel: string;
    try {
      rel = decodeURIComponent(url).replace(/^\/+/, "") || "index.html";
    } catch {
      rel = "index.html";
    }
    const distNorm = path.normalize(dist);
    const filePath = path.normalize(path.join(dist, rel));
    // Path-traversal guard: resolved path must stay inside dist.
    if (filePath !== distNorm && !filePath.startsWith(distNorm + path.sep)) {
      return reply.code(403).send("forbidden");
    }
    const abs = existsSync(filePath) && statSync(filePath).isFile() ? filePath : path.join(dist, "index.html");
    const ext = path.extname(abs).toLowerCase();
    return reply.type(SPA_MIME[ext] || "application/octet-stream").send(createReadStream(abs));
  };
}

// Attach the SPA catch-all. Because every real API route is registered above,
// only unmatched requests reach this handler.
function attachSpaServing(app: any, cfg: ServerConfig) {
  app.setNotFoundHandler(spaHandler(cfg));
}

export { AuthService };
// re-export for tests that import the service type alias
export type { AuthSvc };
