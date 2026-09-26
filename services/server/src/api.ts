import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { existsSync, statSync, readdirSync, createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config";
import type { Store } from "./store";
import { analyzeJob, EvidenceTracker, type AnalyzeEvent, type PipelineClient } from "./analyzer";
import { buildAnalyzeFrames } from "./livepeer-adapter";
import { cutClip, extractFrames } from "./ffmpeg";
import { LiveIngest, type LiveKind } from "./live";
import type { Db, MediaSession, AnalyticsSnapshot } from "./db";
import { AuthService, BetaGateError, adminRequired, authRequired, type AuthService as AuthSvc } from "./auth";
import { BillingService, BillingRequiredError } from "./billing";
import { EntitlementsService, QuotaExceededError } from "./entitlements";
import { FixedWindowLimiter, rateLimit } from "./rate-limit";
import { enqueueBestEffort, type Mailer } from "./mailer";
import { composeInviteEmail } from "./invites";

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
export async function resolveSampleFps(cfg: ServerConfig): Promise<number> {
  // Base: the configured interval (used when perceive is unreachable).
  let sampleFps = 1 / Math.max(0.2, cfg.sampleIntervalSec);
  if (cfg.perceiveUrl) {
    try {
      const h = (await (await fetch(`${cfg.perceiveUrl}/health`)).json()) as any;
      const interval = Number(h?.sample_interval_s);
      // Honor the runner's sustainable interval when it reports one. No 1 fps
      // clamp: CPU reports interval >= 1.0 itself (stays at 1 fps), GPU reports
      // a smaller interval so VOD samples faster toward the chartered cadence.
      if (Number.isFinite(interval) && interval > 0.05) sampleFps = 1 / interval;
    } catch {
      /* fall back to config interval */
    }
  }
  return Math.min(cfg.vodSampleMaxFps, Math.max(0.25, sampleFps));
}

// Extension-based fallback for sources that ship a generic MIME (mpegts is
// frequently served as application/octet-stream; some MP4s as audio/mp4).
const VIDEO_UPLOAD_EXT = /\.(mp4|m4v|mov|webm|mkv|mpeg|mpg|ts|m2ts|mts)$/i;
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
  const browserJobs = new Map<string, { evidence: EvidenceTracker; sessionId?: string; recordingExt?: string; mediaSessionId?: string; mediaWsUrl?: string }>();

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
  async function provisionMedia(jobId: string): Promise<{ wsUrl: string; mediaSessionId: string; mediaOrigin: string }> {
    if (!cfg.mediaServerUrl) throw new Error("media server not configured (MEDIA_SERVER_URL)");
    const mediaOrigin = cfg.mediaServerUrl.replace(/\/+$/, "");
    const existing = await db.getMediaSession(jobId);
    if (existing && existing.status === "active" && (await isMediaHealthy(existing.mediaOrigin))) {
      return { wsUrl: existing.wsUrl, mediaSessionId: existing.sessionId, mediaOrigin: existing.mediaOrigin };
    }
    const r = await fetch(`${mediaOrigin}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    if (r.status !== 200) throw new Error(`media provision failed: HTTP ${r.status} ${await r.text()}`);
    const body: any = await r.json();
    // Prefer the media server's own full URL (LB-routable); fall back to
    // deriving ws:// from MEDIA_SERVER_URL + the returned path.
    const base = mediaOrigin.replace(/^http/, "ws");
    const wsUrl = body.wsUrl ?? `${base}${body.wsPath}`;
    const now = new Date().toISOString();
    await db.setMediaSession({
      jobId,
      sessionId: body.sessionId,
      streamId: body.streamId ?? "",
      wsUrl,
      mediaOrigin,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    // Keep the in-memory browser job pointer current for teardown.
    const bj = browserJobs.get(jobId);
    if (bj) {
      bj.mediaSessionId = body.sessionId;
      bj.mediaWsUrl = wsUrl;
    }
    return { wsUrl, mediaSessionId: body.sessionId, mediaOrigin };
  }
  function browserRecordingPath(jobId: string): string {
    return path.join(cfg.dataDir, "live", jobId, "capture" + (browserJobs.get(jobId)?.recordingExt || ".webm"));
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
        store.recordObservation(jobId, {
          seq: ev.seq,
          timestamp: ev.timestamp,
          tracks: ev.observation.tracks,
        });
      }
    };
  }
  async function runLiveJob(
    ingest: LiveIngest,
    job: { id: string; gameHint?: string; preferLabels?: string[] },
    user: any,
    sub: any
  ) {
    try {
      const outcome = await analyzeJob(
        adapter,
        ingest.frames(),
        (ts) => ingest.cut(ts),
        {
          jobId: job.id,
          clipBeforeS: cfg.clipBeforeS,
          clipAfterS: cfg.clipAfterS,
          gameHint: job.gameHint || cfg.gameHintDefault,
          preferLabels: job.preferLabels,
        },
        jobEventHook(job.id)
      );
      for (const h of outcome.highlights) {
        await store.addHighlight({ ...h, ownerId: user.id, status: cfg.autoPublishHighlights ? "accepted" : "pending" });
        await billing.onHighlightCreated(user, sub);
        // A clip generated successfully debits the quota once.
        await entitlements.onClipGenerated(user);
      }
      await store.patchJob(job.id, { status: "done", perceiveSessionId: outcome.sessionId });
    } catch (e) {
      await store.patchJob(job.id, { status: "failed" });
      console.error(`[live:${job.id}]`, e);
    } finally {
      ingest.stop();
      liveSessions.delete(job.id);
    }
  }

  // Run a VOD `file` job through the standard extractFrames -> analyzeJob ->
  // clip pipeline, storing generated highlights + clips. Shared by the server
  // path/URL POST /jobs route and the browser-upload POST /jobs/upload route so
  // both feed identical compute and quota/billing side effects.
  async function runVodJob(job: { id: string; gameHint?: string; preferLabels?: string[] }, videoPath: string, user: any, sub: any) {
    const frameDir = path.join(cfg.dataDir, "frames", job.id);
    const sampleFps = await resolveSampleFps(cfg);
    await extractFrames(cfg.ffmpegPath, videoPath, frameDir, sampleFps);
    const clipDir = path.join(cfg.dataDir, "clips");
    const cut = async (ts: number) => {
      const clipId = randomUUID();
      const out = path.join(clipDir, `${clipId}.mp4`);
      await cutClip(cfg.ffmpegPath, videoPath, out, Math.max(0, ts - cfg.clipBeforeS), cfg.clipBeforeS + cfg.clipAfterS);
      return { clipId, clipUri: `/clips/${clipId}.mp4` };
    };
    const iter = buildAnalyzeFrames(frameDir, sampleFps)();
    const outcome = await analyzeJob(
      adapter,
      iter,
      cut,
      {
        jobId: job.id,
        clipBeforeS: cfg.clipBeforeS,
        clipAfterS: cfg.clipAfterS,
        gameHint: job.gameHint || cfg.gameHintDefault,
        preferLabels: job.preferLabels,
      },
      jobEventHook(job.id)
    );
    for (const h of outcome.highlights) {
      await store.addHighlight({ ...h, ownerId: user.id, status: cfg.autoPublishHighlights ? "accepted" : "pending" });
      await billing.onHighlightCreated(user, sub);
      // A clip generated successfully debits the quota once.
      await entitlements.onClipGenerated(user);
    }
    await store.patchJob(job.id, { status: "done", perceiveSessionId: outcome.sessionId });
    return { job: store.getJob(job.id), framesAnalyzed: outcome.framesAnalyzed };
  }

  app.get("/health", async () => ({ status: "ok", billing: billing.enabled ? "live" : "disabled" }));

  // Public config surfaced so the webapp can mirror the server's upload cap as
  // a client-side pre-check (kept in sync with VOD_MAX_UPLOAD_BYTES).
  app.get("/config", async () => ({ vodMaxUploadBytes: cfg.vodMaxUploadBytes }));

  // --- auth (public endpoints are rate limited per IP) ---
  app.post<{ Body: { email?: string; password?: string; inviteCode?: string } }>("/auth/register", { preHandler: limitAuth }, async (req, reply) => {
    try {
      return await auth.register(req.body?.email ?? "", req.body?.password ?? "", req.body?.inviteCode);
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
      usedHighlights: await db.countUsage(user.id, "highlight"),
      freeHighlights: cfg.freeHighlights,
      // Per-user per-calendar-month clip quota (the entitlement ledger) surfaced
      // so the UI can show remaining quota and so an exhausted quota is visible
      // without making a submission.
      clipQuotaPeriod: entitlements.periodKey(),
      clipQuotaLimit: entitlements.limit,
      clipQuotaUsed: await entitlements.used(user.id),
      clipQuotaRemaining: await entitlements.remaining(user.id),
    };
  });

  // --- dev wireframe billing (BILLING_WIREFRAME=1 only) ---------------------
  // Simulate the side effects the Stripe webhook would normally produce, so the
  // full subscription lifecycle can be exercised locally without real Stripe.
  // These routes are MOUNTED ONLY when BILLING_WIREFRAME is set. When the flag
  // is off (prod), the routes do not exist at all — Fastify answers 404
  // route-not-found — so the wireframe "free upgrade" surface is never
  // reachable outside the dev simulator, regardless of auth or client.
  if (cfg.billingWireframe) {
    app.post("/dev/billing/activate", { preHandler: authReq }, async (req: any, reply) => {
      const user = (req as any).user;
      const sub = await db.setSubscription(user.id, {
        tier: req.body?.plan === "free" ? "free" : "pro",
        status: "active",
        stripeSubscriptionId: req.body?.stripeSubscriptionId || "wireframe_sub",
        stripeSubItemId: (req.body?.noMeter ?? false) ? null : "si_wire_metered",
      });
      return reply.send({ ok: true, sub });
    });

    app.post("/dev/billing/deactivate", { preHandler: authReq }, async (req: any, reply) => {
      const user = (req as any).user;
      const sub = await db.setSubscription(user.id, { tier: "free", status: "canceled", stripeSubscriptionId: null, stripeSubItemId: null });
      return reply.send({ ok: true, sub });
    });

    app.post("/dev/billing/reset-usage", { preHandler: authReq }, async (req: any, reply) => {
      const user = (req as any).user;
      await db.resetUsage(user.id, "highlight");
      return reply.send({ ok: true, usedHighlights: await db.countUsage(user.id, "highlight") });
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
  app.post<{ Body: { source?: string; videoPath?: string; gameHint?: string; preferLabels?: string[] } }>(
    "/jobs",
    { preHandler: authReq },
    async (req, reply) => {
      const user = (req as any).user;
      // Budget hard-stop: reject at submission time as soon as the month's clip
      // quota is exhausted. This runs BEFORE any job is created or any compute
      // (Livepeer GPU / decide) is scheduled — quota overspend never runs a job.
      try {
        await entitlements.canSubmit(user);
      } catch (e) {
        if (e instanceof QuotaExceededError) {
          return reply.code(429).send({
            error: "monthly clip quota used up — resets at the start of next month",
            code: "quota_exceeded",
            clipQuotaPeriod: entitlements.periodKey(),
            clipQuotaLimit: entitlements.limit,
            clipQuotaRemaining: 0,
          });
        }
        throw e;
      }
      const sub = await db.getSubscription(user.id);
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
      const job = await store.createJob({
        ownerId: user.id,
        source: (req.body.source ?? "file") as any,
        sourceUrl: videoPath,
        gameHint: req.body.gameHint || cfg.gameHintDefault,
        preferLabels: req.body.preferLabels ?? [],
      });
      await store.patchJob(job.id, { status: "active" });
      if (req.body.source === "browser") {
        // Client-side capture (screen share / element capture): the client posts
        // sampled frames to /jobs/:id/ingest and a recording to
        // /jobs/:id/recording. Nothing to pull server-side.
        browserJobs.set(job.id, { evidence: new EvidenceTracker() });
        return { job: store.getJob(job.id), status: "ready" };
      }
      if (live) {
        // Live ingest: capture/pull the stream, record it to disk, and sample
        // frames into the analyzer rail. Runs in the background; the job is
        // stopped via POST /jobs/:id/stop.
        const sampleFps = await resolveSampleFps(cfg);
        const kind: LiveKind = req.body.source === "screen" ? "screen" : "rtmp";
        const ingest = new LiveIngest(cfg, job.id, {
          kind,
          url: videoPath,
          sampleInterval: 1 / sampleFps,
        });
        await ingest.start();
        liveSessions.set(job.id, ingest);
        runLiveJob(ingest, job, user, sub).catch(() => {});
        return { job: store.getJob(job.id), status: "ingesting", framesAnalyzed: 0 };
      }
      try {
        const out = await runVodJob(job, videoPath!, user, sub);
        return out;
      } catch (e: any) {
        await store.patchJob(job.id, { status: "failed" });
        const raw = String(e?.message || e);
        // A remote URL source that ffmpeg can't fetch (404/403/406, unreachable,
        // hotlink-protected, or not a directly downloadable file) gets a human
        // message; the ffmpeg detail stays in `detail` for diagnosis.
        if (/^https?:\/\//i.test(req.body?.videoPath || "") && /^ffmpeg:/i.test(raw)) {
          return reply.code(422).send({ error: "Video not available for download", detail: raw });
        }
        return reply.code(500).send({ error: raw });
      }
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
    // Budget hard-stop, identical to POST /jobs.
    try {
      await entitlements.canSubmit(user);
    } catch (e) {
      if (e instanceof QuotaExceededError) {
        return reply.code(429).send({
          error: "monthly clip quota used up — resets at the start of next month",
          code: "quota_exceeded",
          clipQuotaPeriod: entitlements.periodKey(),
          clipQuotaLimit: entitlements.limit,
          clipQuotaRemaining: 0,
        });
      }
      throw e;
    }
    const sub = await db.getSubscription(user.id);
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
        return reply.code(413).send({
          error: "File too large (max 2 GB). Paste a download URL instead to process it.",
        });
      }
      return reply.code(500).send({ error: String(e?.message || e) });
    }
    // Accepted: create the job dir and land the file at its final path.
    await mkdir(dir, { recursive: true });
    await rename(stagePath, finalPath);

    const job = await store.createJob({
      id: jobId,
      ownerId: user.id,
      source: "file",
      sourceUrl: finalPath,
      gameHint,
      preferLabels,
    });
    await store.patchJob(job.id, { status: "active" });
    try {
      return await runVodJob(job, finalPath, user, sub);
    } catch (e: any) {
      await store.patchJob(job.id, { status: "failed" });
      return reply.code(500).send({ error: String(e?.message || e) });
    }
  });

  app.get("/jobs/:id", { preHandler: authReq }, async (req: any, reply) => {
    const user = req.user;
    const job = store.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "not found" });
    if (job.ownerId !== user.id && user.role !== "admin") return reply.code(403).send({ error: "forbidden" });
    return { job, highlights: store.highlightsForJob(job.id) };
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
      return reply.send({ ok: true, job: store.getJob(job.id) });
    }
    // Browser capture job: release the perceive session, then cut clips for any
    // recorded highlights from the assembled client recording.
    if (job.source === "browser" && browserJobs.has(job.id)) {
      const bj = browserJobs.get(job.id)!;
      if (bj.sessionId) await adapter.stopPerceive(bj.sessionId).catch(() => {});
      // Media-path session: tell the media server to stop paying + release the
      // perceive slot (also idempotently triggered by the browser WS closing),
      // and forget the DB record so a fresh session is provisioned next time.
      if (bj.mediaSessionId && cfg.mediaServerUrl) {
        await fetch(`${cfg.mediaServerUrl}/sessions/${bj.mediaSessionId}/close`, { method: "POST" }).catch(() => {});
        await db.clearMediaSession(job.id).catch(() => {});
      }
      const recPath = browserRecordingPath(job.id);
      if (existsSync(recPath)) {
        const { mkdir } = await import("node:fs/promises");
        const outDir = path.join(cfg.dataDir, "clips");
        await mkdir(outDir, { recursive: true });
        for (const h of store.highlightsForJob(job.id)) {
          if (h.clipUri) continue;
          try {
            const name = `${job.id}-${Math.round(h.start * 10)}`;
            const out = path.join(outDir, `${name}.mp4`);
            await cutClip(cfg.ffmpegPath, recPath, out, Math.max(0, h.start), cfg.clipBeforeS + cfg.clipAfterS);
            await store.patchHighlight(h.id, { clipUri: `/clips/${name}.mp4` });
          } catch (e: any) {
            console.error(`[browser:${job.id}] clip cut failed:`, String(e?.message || e));
          }
        }
      }
      browserJobs.delete(job.id);
      await store.patchJob(job.id, { status: "done" });
      emitJobEvent(job.id, { seq: -1, timestamp: -1, type: "observation", observation: { tracks: [] } }); // wake SSE
      return reply.send({ ok: true, job: store.getJob(job.id) });
    }
    return reply.code(409).send({ error: "job is not a live ingest or browser capture" });
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
          // Fixed-fee single-shot decide (Gemma 4 12B): gate + meter at the call.
          const duser = (req as any).user;
          const dsub = await db.getSubscription(duser.id);
          await billing.canDecide(duser, dsub).catch((err: any) => {
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
              ocrHits: 0,
            },
            {
              gameHint: job.gameHint || cfg.gameHintDefault,
              imageB64: image,
              // Frontend-selectable; defaults to "none" (thinking off / fast JSON)
              reasoningEffort: (req.body as any)?.reasoningEffort || "none",
            }
          );
          await billing.onDecideCompleted(duser, dsub);
          if (d.isHighlight) {
            highlight = {
              id: randomUUID(),
              jobId: job.id,
              ownerId: job.ownerId,
              clipUri: "",
              start: Math.max(0, timestamp - cfg.clipBeforeS),
              end: timestamp + cfg.clipAfterS,
              eventType: d.eventType,
              score: d.score,
              reason: d.reason,
              status: cfg.autoPublishHighlights ? "accepted" : "pending",
              createdAt: new Date().toISOString(),
            };
            await store.addHighlight(highlight);
            // A browser-capture highlight generated successfully debits the
            // quota once (like VOD/live). Board-capture jobs must also count
            // toward the monthly clip quota.
            await entitlements.onClipGenerated(duser);
            emitJobEvent(req.params.id, { seq, timestamp, type: "highlight", highlight });
          }
        }
        return { ok: true, highlight, trackCount: bj.evidence.trackCount };
      } catch (e: any) {
        return reply.code(500).send({ error: String(e?.message || e) });
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
    if (job.source !== "browser" || !bj) return reply.code(409).send({ error: "not a browser capture job" });
    // Always consult the DB-backed provisioner: it reuses the live session,
    // or — if the media node serving it went down — transparently re-provisions
    // on a healthy node so the browser's reconnect is seamlessly re-routed.
    try {
      const { wsUrl, mediaSessionId } = await provisionMedia(req.params.id);
      bj.mediaWsUrl = wsUrl;
      bj.mediaSessionId = mediaSessionId;
      return { wsUrl, mediaSessionId };
    } catch (e: any) {
      return reply.code(500).send({ error: String(e?.message || e) });
    }
  });

  // Internal callback from the media server: relay an observation the perceive
  // runner published to events-out, stepping the per-job evidence and fanning
  // to the live console. The browser streaming to the media server never touches
  // the Fastify control plane's frame ingest. (Candidate->decide->highlight
  // wiring is the next increment — the runner currently publishes observation
  // without a candidate on events-out.)
  app.post<{ Params: { id: string } }>("/jobs/:id/observe", async (req: any, reply) => {
    const job = store.getJob(req.params.id);
    const bj = browserJobs.get(req.params.id);
    if (!job || job.source !== "browser" || !bj) return reply.code(409).send({ error: "not a browser capture job" });
    const obs = req.body;
    if (!obs || typeof obs !== "object") return reply.code(400).send({ error: "observation required" });
    const seq = typeof obs.seq === "number" ? obs.seq : 0;
    const timestamp = typeof obs.timestamp === "number" ? obs.timestamp : 0;
    bj.evidence.step(obs);
    emitJobEvent(req.params.id, { seq, timestamp, type: "observation", observation: obs });
    return { ok: true };
  });

  // Browser-capture rail: client appends a chunk of the recorded capture (base64)
  // so the server can cut highlight clips from it at stop.
  app.post<{ Params: { id: string }; Body: { base64?: string; mime?: string } }>(
    "/jobs/:id/recording",
    { preHandler: authReq },
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

  app.get<{ Params: { id: string } }>("/jobs/:id/observations", { preHandler: authReq }, async (req: any, reply) => {
    if (!store.getJob(req.params.id)) return reply.code(404).send({ error: "no job" });
    return { observations: store.observationsForJob(req.params.id) };
  });

  app.get<{ Params: { id: string } }>("/jobs/:id/frames", { preHandler: authReq }, async (req: any, reply) => {
    const dir = jobFrameDir(req.params.id);
    if (!dir) return reply.code(404).send({ error: "no frames for job" });
    const files = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
    const tsBySeq = new Map(store.observationsForJob(req.params.id).map((o) => [o.seq, o.timestamp]));
    return {
      frames: files.map((f, i) => ({ seq: i, uri: `/jobs/${req.params.id}/frames/${i}`, timestamp: tsBySeq.get(i) ?? null })),
    };
  });

  app.get<{ Params: { id: string; seq: string } }>("/jobs/:id/frames/:seq", { preHandler: authReq }, async (req: any, reply) => {
    const dir = jobFrameDir(req.params.id);
    if (!dir) return reply.code(404).send({ error: "no frames for job" });
    const files = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
    const idx = parseInt(req.params.seq, 10);
    const f = files[idx];
    if (!f) return reply.code(404).send({ error: "no such frame" });
    const abs = path.join(dir, f);
    if (!existsSync(abs)) return reply.code(404).send({ error: "not found" });
    return reply.type("image/jpeg").send(createReadStream(abs));
  });

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
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

  // Operator control intent for a live-console session (preferLabels, lock,
  // evict, confirm). Recorded + acked on the job. Delivery to the perceive
  // runner's control channel is the next adapter increment (see perceive WS
  // control); the API surface and ack are live now so the UI can send it.
  app.post<{ Params: { id: string }; Body: { type?: string; args?: any } }>(
    "/jobs/:id/control",
    { preHandler: authReq },
    async (req: any, reply) => {
      const job = store.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: "no job" });
      const type = req.body?.type || "none";
      const args = req.body?.args ?? {};
      // Ack to the operator immediately; delivery to the perceive control
      // channel is handled once the adapter exposes a control forward.
      return { ok: true, control: { type, args, at: new Date().toISOString() }, job: store.getJob(job.id) };
    }
  );

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
