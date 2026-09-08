import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "./config";
import type { Store } from "./store";
import { analyzeJob, type PipelineClient } from "./analyzer";
import { buildAnalyzeFrames } from "./livepeer-adapter";
import { cutClip, extractFrames } from "./ffmpeg";
import type { SqlDb } from "./db";
import { AuthService, adminRequired, authRequired, type AuthService as AuthSvc } from "./auth";
import { BillingService, BillingRequiredError } from "./billing";

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
      if (!videoPath) return reply.code(400).send({ error: "videoPath required" });
      const job = store.createJob({
        ownerId: user.id,
        source: (req.body.source ?? "file") as any,
        sourceUrl: videoPath,
        gameHint: req.body.gameHint || cfg.gameHintDefault,
        preferLabels: req.body.preferLabels ?? [],
      });
      store.patchJob(job.id, { status: "active" });
      try {
        const frameDir = path.join(cfg.dataDir, "frames", job.id);
        await extractFrames(cfg.ffmpegPath, videoPath, frameDir);
        const clipDir = path.join(cfg.dataDir, "clips");
        const cut = async (ts: number) => {
          const clipId = randomUUID();
          const out = path.join(clipDir, `${clipId}.mp4`);
          await cutClip(cfg.ffmpegPath, videoPath, out, Math.max(0, ts - cfg.clipBeforeS), cfg.clipBeforeS + cfg.clipAfterS);
          return { clipId, clipUri: `/clips/${clipId}.mp4` };
        };
        const iter = buildAnalyzeFrames(frameDir)();
        const outcome = await analyzeJob(adapter, iter, cut, {
          jobId: job.id,
          clipBeforeS: cfg.clipBeforeS,
          clipAfterS: cfg.clipAfterS,
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
