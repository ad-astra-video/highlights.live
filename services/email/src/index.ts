// Email-sender container entrypoint.
//
// Standalone service that (a) accepts API requests to queue a send and (b)
// completes those sends over SMTP, with the queue persisted in the shared DB.
// It holds the mailbox SMTP credentials (host/port/user/pass from env/secrets)
// and always sends as onboarding@highlights.live.
//
//   POST /emails   {to, subject, body}  -> 202 {id, status:'queued'}   (bearer queue token)
//   GET  /emails/:id                    -> delivery status              (bearer queue token)
//   GET  /health                        -> liveness
//
// The worker loop is started with the app; SIGTERM/close drains gracefully.

import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { loadEmailConfig, type EmailSenderConfig } from "./config";
import { createTransport } from "./transport";
import { EmailWorker } from "./queue";
import { ipInAllowlist } from "./allowlist";
import { openDb, type Db } from "../../server/src/db";

export interface EmailServiceDeps {
  cfg: EmailSenderConfig;
  db: Db;
  worker?: EmailWorker;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function buildEmailApp(deps: EmailServiceDeps): FastifyInstance {
  const { cfg, db, worker } = deps;
  const app = Fastify({ logger: false });

  // Security gate (ADAAAA-2475): every request to the queue/status API must
  // (1) come from a source address on the allow-list when one is configured,
  // and (2) carry the shared bearer token. Both are enforced before any work
  // happens; failures are rejected 403/401 and logged.
  const auth = async (req: any, reply: any) => {
    const src = (req.ip as string) || "";
    if (cfg.allowlistIps.length > 0 && !ipInAllowlist(src, cfg.allowlistIps)) {
      // eslint-disable-next-line no-console
      console.error(`[email] rejected source ${src} (not on allow-list)`);
      return reply.code(403).send({ error: "forbidden" });
    }
    if (!cfg.queueToken) return;
    const h = (req.headers.authorization as string) || "";
    if (h !== `Bearer ${cfg.queueToken}`) {
      // eslint-disable-next-line no-console
      console.error(`[email] rejected unauthenticated ${req.method} ${req.url} from ${src}`);
      return reply.code(401).send({ error: "unauthorized" });
    }
  };

  app.get("/health", async () => ({ status: "ok" }));

  app.post<{ Body: { to?: string; subject?: string; body?: string } }>("/emails", { preHandler: auth }, async (req, reply) => {
    const to = (req.body?.to ?? "").trim().toLowerCase();
    const subject = (req.body?.subject ?? "").trim();
    const body = req.body?.body ?? "";
    if (!EMAIL_RE.test(to)) return reply.code(400).send({ error: "valid to email required" });
    if (!subject) return reply.code(400).send({ error: "subject required" });
    if (!body) return reply.code(400).send({ error: "body required" });
    const row = await db.enqueueEmailSend({
      id: randomUUID(),
      toEmail: to,
      subject,
      body,
      createdAt: new Date().toISOString(),
      maxAttempts: cfg.maxAttempts,
    });
    return reply.code(202).send({ id: row.id, status: row.status });
  });

  app.get<{ Params: { id: string } }>("/emails/:id", { preHandler: auth }, async (req, reply) => {
    const row = await db.getEmailSend(req.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return {
      id: row.id,
      status: row.status,
      to: row.toEmail,
      subject: row.subject,
      attempts: row.attempts,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sentAt: row.sentAt,
    };
  });

  if (worker) {
    app.addHook("onClose", async () => worker.close());
    worker.start(cfg.pollIntervalMs);
  }
  return app;
}

async function main() {
  const cfg = loadEmailConfig();
  await mkdir(cfg.databasePath.split("/")[0] || ".", { recursive: true });
  const db = await openDb({ databasePath: cfg.databasePath, databaseUrl: cfg.databaseUrl });
  const transport = createTransport(cfg);
  const worker = new EmailWorker({ db, transport, ...cfg });
  const app = buildEmailApp({ cfg, db, worker });
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  const mode = cfg.smtpHost ? `smtp://${cfg.smtpHost}:${cfg.smtpPort}` : "LOG (no SMTP_HOST configured)";
  // eslint-disable-next-line no-console
  console.log(`email sender on :${cfg.port} (transport=${mode}, from=${cfg.fromEmail})`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
