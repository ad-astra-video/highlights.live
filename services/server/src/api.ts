import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "./config";
import type { Store } from "./store";
import { analyzeJob, type PipelineClient } from "./analyzer";
import { buildAnalyzeFrames } from "./livepeer-adapter";
import { cutClip, extractFrames } from "./ffmpeg";

export interface ApiDeps {
  cfg: ServerConfig;
  store: Store;
  adapter: PipelineClient;
}

export function buildApp(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });

  app.get("/health", async () => ({ status: "ok" }));

  app.post<{ Body: { source?: string; videoPath: string; gameHint?: string; preferLabels?: string[] } }>("/jobs", async (req, reply) => {
    const videoPath = req.body?.videoPath;
    if (!videoPath) return reply.code(400).send({ error: "videoPath required" });
    const job = deps.store.createJob({
      source: (req.body.source ?? "file") as any,
      sourceUrl: videoPath,
      gameHint: req.body.gameHint || deps.cfg.gameHintDefault,
      preferLabels: req.body.preferLabels ?? [],
    });
    deps.store.patchJob(job.id, { status: "active" });
    try {
      const frameDir = path.join(deps.cfg.dataDir, "frames", job.id);
      await extractFrames(deps.cfg.ffmpegPath, videoPath, frameDir);
      const clipDir = path.join(deps.cfg.dataDir, "clips");
      const cut = async (ts: number) => {
        const clipId = randomUUID();
        const out = path.join(clipDir, `${clipId}.mp4`);
        await cutClip(deps.cfg.ffmpegPath, videoPath, out, Math.max(0, ts - deps.cfg.clipBeforeS), deps.cfg.clipBeforeS + deps.cfg.clipAfterS);
        return { clipId, clipUri: `/clips/${clipId}.mp4` };
      };
      const iter = buildAnalyzeFrames(frameDir)();
      const outcome = await analyzeJob(deps.adapter, iter, cut, {
        jobId: job.id,
        clipBeforeS: deps.cfg.clipBeforeS,
        clipAfterS: deps.cfg.clipAfterS,
      });
      for (const h of outcome.highlights) {
        deps.store.addHighlight(h);
      }
      deps.store.patchJob(job.id, { status: "done", perceiveSessionId: outcome.sessionId });
      return { job: deps.store.getJob(job.id), framesAnalyzed: outcome.framesAnalyzed };
    } catch (e: any) {
      deps.store.patchJob(job.id, { status: "failed" });
      return reply.code(500).send({ error: String(e?.message || e) });
    }
  });

  app.get("/jobs/:id", async (req: any, reply) => {
    const job = deps.store.getJob(req.params.id);
    if (!job) return reply.code(404).send({ error: "not found" });
    return { job, highlights: deps.store.highlightsForJob(job.id) };
  });

  app.get("/highlights", async () => ({ highlights: deps.store.allHighlights() }));

  app.post<{ Params: { id: string }; Body: { status: "accepted" | "rejected" } }>("/highlights/:id/review", async (req, reply) => {
    try {
      const h = deps.store.reviewHighlight(req.params.id, req.body?.status || "accepted");
      return h;
    } catch (e: any) {
      return reply.code(404).send({ error: String(e?.message || e) });
    }
  });

  app.get("/clips/*", async (req: any, reply) => {
    const fileParts = (req.params as any)["*"];
    const f = path.join(deps.cfg.dataDir, "clips", fileParts);
    try {
      const { createReadStream } = await import("node:fs");
      return reply.type("video/mp4").send(createReadStream(f));
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  return app;
}
