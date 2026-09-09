import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "./config";
import type { Store } from "./store";
import { analyzeJob, type PipelineClient } from "./analyzer";
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
        { jobId: job.id, clipBeforeS: cfg.clipBeforeS, clipAfterS: cfg.clipAfterS, gameHint: job.gameHint || cfg.gameHintDefault }
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
        });
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
