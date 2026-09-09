import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "./config";
import type { Store } from "./store";
import { analyzeJob, type AnalyzeEvent, type PipelineClient } from "./analyzer";
import { buildAnalyzeFrames } from "./livepeer-adapter";
import { cutClip, extractFrames } from "./ffmpeg";
import { LiveIngest, type LiveKind } from "./live";
import type { SqlDb } from "./db";
import { AuthService, adminRequired, authRequired, type AuthService as AuthSvc } from "./auth";
import { BillingService, BillingRequiredError } from "./billing";

/** Resolve the perceive sampling fps from the runner's measured capability
 * (when reachable directly) else the configured interval. */
async function resolveSampleFps(cfg: ServerConfig): Promise<number> {
  let sampleFps = 1 / Math.max(0.2, cfg.sampleIntervalSec);
  if (cfg.perceiveUrl) {
    try {
      const h = (await (await fetch(`${cfg.perceiveUrl}/health`)).json()) as any;
      if (h && h.sample_interval_s > 0.2) sampleFps = Math.min(1.0, 1 / h.sample_interval_s);
    } catch {
      /* fall back to config interval */
    }
  }
  return sampleFps;
}

export interface ApiDeps {
  cfg: ServerConfig;
  store: Store;
  adapter: PipelineClient;
  db: SqlDb;
  auth: AuthService;
  billing: BillingService;
}

export function buildApp(deps: ApiDeps): FastifyInstance {
  const { cfg, store, adapter, db, auth, billing } = deps;
  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });

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

  // In-memory registry of running live ingest sessions (keyed by job id) so a
  // live job can be stopped explicitly; ends the frame iterator -> analyzeJob
  // returns -> the job is marked done.
  const liveSessions = new Map<string, LiveIngest>();
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
    job: { id: string },
    user: any,
    sub: any
  ) {
    try {
      const outcome = await analyzeJob(
        adapter,
        ingest.frames(),
        (ts) => ingest.cut(ts),
        { jobId: job.id, clipBeforeS: cfg.clipBeforeS, clipAfterS: cfg.clipAfterS, gameHint: job.gameHint || cfg.gameHintDefault },
        jobEventHook(job.id)
      );
      for (const h of outcome.highlights) {
        store.addHighlight({ ...h, ownerId: user.id });
        await billing.onHighlightCreated(user, sub);
      }
      store.patchJob(job.id, { status: "done", perceiveSessionId: outcome.sessionId });
    } catch (e) {
      store.patchJob(job.id, { status: "failed" });
      console.error(`[live:${job.id}]`, e);
    } finally {
      ingest.stop();
      liveSessions.delete(job.id);
    }
  }

  app.get("/health", async () => ({ status: "ok", billing: billing.enabled ? "live" : "disabled" }));

  // --- auth ---
  app.post<{ Body: { email?: string; password?: string } }>("/auth/register", async (req, reply) => {
    try {
      return auth.register(req.body?.email ?? "", req.body?.password ?? "");
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post<{ Body: { email?: string; password?: string } }>("/auth/login", async (req, reply) => {
    try {
      return auth.login(req.body?.email ?? "", req.body?.password ?? "");
    } catch (e: any) {
      return reply.code(401).send({ error: e.message });
    }
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
    const sub = db.getSubscription(user.id);
    return {
      tier: sub.tier,
      status: sub.status,
      usedHighlights: db.countUsage(user.id, "highlight"),
      freeHighlights: cfg.freeHighlights,
    };
  });

  // --- dev wireframe billing (BILLING_WIREFRAME=1 only) ---------------------
  // Simulate the side effects the Stripe webhook would normally produce, so the
  // full subscription lifecycle can be exercised locally without real Stripe.
  const wireframeRoute = (handler: (user: any, body: any, reply: any) => Promise<any>) =>
    async (req: any, reply: any) => {
      if (!cfg.billingWireframe) return reply.code(404).send({ error: "wireframe billing disabled" });
      const user = auth.verify((req.headers.authorization as string) || "");
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      return handler(user, req.body || {}, reply);
    };

  app.post("/dev/billing/activate", { preHandler: authReq }, wireframeRoute(async (user, body, reply) => {
    const sub = db.setSubscription(user.id, {
      tier: body.plan === "free" ? "free" : "pro",
      status: "active",
      stripeSubscriptionId: body.stripeSubscriptionId || "wireframe_sub",
      stripeSubItemId: (body.noMeter ?? false) ? null : "si_wire_metered",
    });
    return reply.send({ ok: true, sub });
  }));

  app.post("/dev/billing/deactivate", { preHandler: authReq }, wireframeRoute(async (user, _b, reply) => {
    const sub = db.setSubscription(user.id, { tier: "free", status: "canceled", stripeSubscriptionId: null, stripeSubItemId: null });
    return reply.send({ ok: true, sub });
  }));

  app.post("/dev/billing/reset-usage", { preHandler: authReq }, wireframeRoute(async (user, _b, reply) => {
    db.resetUsage(user.id, "highlight");
    return reply.send({ ok: true, usedHighlights: db.countUsage(user.id, "highlight") });
  }));

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
      const sub = db.getSubscription(user.id);
      let billingBlocked = false;
      try {
        billing.canCreateHighlight(user, sub);
      } catch (e) {
        if (e instanceof BillingRequiredError) billingBlocked = true;
        else throw e;
      }
      if (billingBlocked) {
        return reply.code(402).send({ error: "free allowance used; subscribe to Pro to continue", upgrade: "/billing/checkout" });
      }
      const videoPath = req.body?.videoPath;
      const live = !!req.body.source && req.body.source !== "file";
      if (!videoPath && !(live && req.body.source === "screen"))
        return reply.code(400).send({ error: "videoPath required for this source" });
      const job = store.createJob({
        ownerId: user.id,
        source: (req.body.source ?? "file") as any,
        sourceUrl: videoPath,
        gameHint: req.body.gameHint || cfg.gameHintDefault,
        preferLabels: req.body.preferLabels ?? [],
      });
      store.patchJob(job.id, { status: "active" });
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
        const frameDir = path.join(cfg.dataDir, "frames", job.id);
        // Tune frame sampling to the perceive card's measured capability: one
        // frame every sample_interval_s seconds (from the runner when reachable
        // directly, else the SAMPLE_INTERVAL_SEC config).
        let sampleFps = 1 / Math.max(0.2, cfg.sampleIntervalSec);
        if (cfg.perceiveUrl) {
          try {
            const h = (await (await fetch(`${cfg.perceiveUrl}/health`)).json()) as any;
            if (h && h.sample_interval_s > 0.2) sampleFps = Math.min(1.0, 1 / h.sample_interval_s);
          } catch {
            /* fall back to config interval */
          }
        }
        await extractFrames(cfg.ffmpegPath, videoPath!, frameDir, sampleFps);
        const clipDir = path.join(cfg.dataDir, "clips");
        const cut = async (ts: number) => {
          const clipId = randomUUID();
          const out = path.join(clipDir, `${clipId}.mp4`);
          await cutClip(cfg.ffmpegPath, videoPath!, out, Math.max(0, ts - cfg.clipBeforeS), cfg.clipBeforeS + cfg.clipAfterS);
          return { clipId, clipUri: `/clips/${clipId}.mp4` };
        };
        const iter = buildAnalyzeFrames(frameDir, sampleFps)();
        const outcome = await analyzeJob(adapter, iter, cut, {
          jobId: job.id,
          clipBeforeS: cfg.clipBeforeS,
          clipAfterS: cfg.clipAfterS,
          gameHint: job.gameHint || cfg.gameHintDefault,
        },
        jobEventHook(job.id)
        );
        for (const h of outcome.highlights) {
          store.addHighlight({ ...h, ownerId: user.id });
          await billing.onHighlightCreated(user, sub);
        }
        store.patchJob(job.id, { status: "done", perceiveSessionId: outcome.sessionId });
        return { job: store.getJob(job.id), framesAnalyzed: outcome.framesAnalyzed };
      } catch (e: any) {
        store.patchJob(job.id, { status: "failed" });
        return reply.code(500).send({ error: String(e?.message || e) });
      }
    }
  );

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
    if (!ing) return reply.code(409).send({ error: "job is not a live ingest" });
    ing.stop();
    return reply.send({ ok: true, job: store.getJob(job.id) });
  });

  // Frame debugger: expose the sampled frames a job actually saw + the perceive
  // observations (boxes) so the console can overlay Florence/SAM boxes on any past
  // frame. Frames live under dataDir/frames/<jobId> (VOD) or dataDir/live/<jobId>/frames (live).
  function jobFrameDir(jobId: string): string | null {
    const { existsSync } = require("node:fs") as typeof import("node:fs");
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
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const files = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
    const tsBySeq = new Map(store.observationsForJob(req.params.id).map((o) => [o.seq, o.timestamp]));
    return {
      frames: files.map((f, i) => ({ seq: i, uri: `/jobs/${req.params.id}/frames/${i}`, timestamp: tsBySeq.get(i) ?? null })),
    };
  });

  app.get<{ Params: { id: string; seq: string } }>("/jobs/:id/frames/:seq", { preHandler: authReq }, async (req: any, reply) => {
    const dir = jobFrameDir(req.params.id);
    if (!dir) return reply.code(404).send({ error: "no frames for job" });
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const files = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
    const idx = parseInt(req.params.seq, 10);
    const f = files[idx];
    if (!f) return reply.code(404).send({ error: "no such frame" });
    const { createReadStream, existsSync } = require("node:fs") as typeof import("node:fs");
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
    { preHandler: adminReq },
    async (req, reply) => {
      try {
        return store.reviewHighlight(req.params.id, req.body?.status || "accepted");
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

  return app;
}

export { AuthService };
// re-export for tests that import the service type alias
export type { AuthSvc };
