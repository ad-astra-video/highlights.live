import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config";
import { Store } from "./store";
import { RejectedClipCleanup } from "./cleanup";
import { openDb } from "./db";
import { AuthService } from "./auth";
import { BillingService } from "./billing";
import { EntitlementsService } from "./entitlements";
import { buildApp } from "./api";
import { makeAdapter } from "./livepeer-adapter";
import { makeMailer } from "./mailer";
import Stripe from "stripe";

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

  const stripe = cfg.stripeSecretKey ? new Stripe(cfg.stripeSecretKey) : null;
  const billing = new BillingService(cfg, db, stripe);

  if (!billing.enabled) {
    console.warn("WARN: billing is DISABLED (set STRIPE_SECRET_KEY + STRIPE_PRICE_PRO) — /jobs gated on free quota only.");
  }

  if (cfg.betaGate) {
    console.log(`invite/beta-gate: ON (${cfg.betaClipQuota} clips/mo per user)`);
  }

  if (cfg.autoPublishHighlights) {
    console.log("clip auto-publish: ON — generated clips go straight to the public /feed (admin review off).");
  }

  const entitlements = new EntitlementsService(db, cfg);
  const adapter = makeAdapter(cfg);
  const app = buildApp({ cfg, store, adapter, db, auth, billing, entitlements, mailer: mailer ?? undefined });

  // Rejected-clip storage-lifecycle sweep (ADAAAA-5168): permanently removes the
  // DB row + storage object for every `rejected` clip aged >= rejectedClipTtlMs.
  // Runs once at boot, then on `rejectedClipSweepIntervalMs` (<= the TTL, so a
  // clip aged >= TTL is removed within <= 24h of rejection). Dry-run mode only
  // reports objects + bytes reclaimable. No inference / no GPU — pure storage.
  const cleanup = new RejectedClipCleanup(store, cfg);
  const sweep = async () => {
    try {
      const r = await cleanup.run();
      console.log(
        `[rejected-clip-sweep] ${r.dryRun ? "dry-run" : "run"} ` +
          `ttl=${r.ttlMs}ms scanned=${r.scanned} candidates=${r.candidates} ` +
          `purged=${r.purged} objects=${r.objectsDeleted} bytes=${r.bytesReclaimed} ` +
          `skipped=${r.skipped}${r.errors.length ? ` errors=${r.errors.length}` : ""}`
      );
    } catch (e) {
      console.error("[rejected-clip-sweep] failed:", e);
    }
  };
  void sweep();
  const sweepTimer = setInterval(sweep, cfg.rejectedClipSweepIntervalMs);
  sweepTimer.unref?.();

  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`highlights server on :${cfg.port} (orchestrator=${cfg.orchestratorUrl})`);
  console.log(`dev admin: ${cfg.adminEmail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
