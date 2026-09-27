import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config";
import { Store } from "./store";
import { openDb } from "./db";
import { AuthService } from "./auth";
import { BillingService } from "./billing";
import { EntitlementsService } from "./entitlements";
import { buildApp } from "./api";
import { makeAdapter } from "./livepeer-adapter";
import { makeMailer } from "./mailer";
import { runRejectSweep } from "./lifecycle";
import Stripe from "stripe";

/** Schedule the rejected-clip TTL sweep (runs at least once per `interval`,
 * plus one startup run so newly-elapsed clips are reclaimed promptly). Returns
 * an unref'd timer so it never keeps the process alive on its own. Pure
 * storage-lifecycle work — no inference, no Livepeer GPU cost. */
function scheduleRejectSweep(cfg: ReturnType<typeof loadConfig>, store: Store): NodeJS.Timeout {
  const run = async (dryRun: boolean) => {
    try {
      const report = await runRejectSweep(store, cfg, { dryRun });
      // eslint-disable-next-line no-console
      console.log(
        `reject-sweep ${dryRun ? "(dry-run) " : ""}candidates=${report.candidates} ` +
          `objects=${report.objectsRemoved} bytes=${report.bytesReclaimed} rows=${report.rowsRemoved}`
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("reject-sweep error:", e);
    }
  };
  // First pass: dry-run report only (per requirement) so operators see what a
  // sweep would reclaim before any hard delete happens.
  void run(true);
  const t = setInterval(() => void run(false), cfg.rejectSweepIntervalMs);
  t.unref();
  return t;
}

async function main() {
  const cfg = loadConfig();
  await mkdir(cfg.dataDir, { recursive: true });
  // Prod: Postgres when DATABASE_URL is set; dev: SQLite at databasePath.
  const db = await openDb(cfg);
  // Durable jobs + highlights: the Store write-throughs every mutation to the
  // Db and hydrates the in-memory working set on boot, so stateful data
  // (users, jobs, highlights, entitlements) survives restarts.
  const store = new Store(db);
  await store.load();
  const mailer = makeMailer(cfg);
  if (mailer) console.log(`mailer: email-sender @ ${cfg.emailSenderUrl}`);
  else console.log("mailer: not configured (EMAIL_SENDER_URL unset) — transactional emails skipped.");
  const auth = new AuthService(db, cfg, mailer ?? undefined);
  await auth.bootstrapAdmin();

  const entitlements = new EntitlementsService(db, cfg);
  const stripe = cfg.stripeSecretKey ? new Stripe(cfg.stripeSecretKey) : null;
  const billing = new BillingService(cfg, db, stripe, entitlements);

  if (!billing.enabled) {
    console.warn("WARN: billing is DISABLED (set STRIPE_SECRET_KEY + STRIPE_PRICE_PRO) — /jobs gated on free quota only.");
  }

  if (cfg.betaGate) {
    console.log(`invite/beta-gate: ON (${cfg.betaClipQuota} clips/mo per user)`);
  }

  if (cfg.autoPublishHighlights) {
    console.log("clip auto-publish: ON — generated clips go straight to the public /feed (admin review off).");
  }

  const adapter = makeAdapter(cfg);
  const app = buildApp({ cfg, store, adapter, db, auth, billing, entitlements, mailer: mailer ?? undefined });
  scheduleRejectSweep(cfg, store);
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`highlights server on :${cfg.port} (orchestrator=${cfg.orchestratorUrl})`);
  console.log(`dev admin: ${cfg.adminEmail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
