import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
import { runDatasetPurgeSweep, scheduleDatasetsPurgeForOwner } from "./dataset-lifecycle";
import { filePerceiveSessionLedger, releaseOrphanedPerceiveSessions } from "./perceive-ledger";
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

/** Schedule the 30-day dataset retention purge sweep (ADAAAA-5398 C4). Runs at
 * least once per `interval`, plus a startup run, for deactivated accounts whose
 * datasets reached T+30d. Deletes DB rows + stored objects and appends to the
 * dataset_purge_log (QA-observable). Unref'd timer. */
function scheduleDatasetPurgeSweep(
  cfg: ReturnType<typeof loadConfig>,
  db: Awaited<ReturnType<typeof openDb>>
): NodeJS.Timeout {
  const run = async (dryRun: boolean) => {
    try {
      const report = await runDatasetPurgeSweep(db, cfg, { dryRun });
      // eslint-disable-next-line no-console
      console.log(
        `dataset-purge ${dryRun ? "(dry-run) " : ""}candidates=${report.candidates} ` +
          `datasets=${report.datasetsPurged} objects=${report.objectsRemoved} bytes=${report.bytesReclaimed}`
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("dataset-purge error:", e);
    }
  };
  void run(true);
  const t = setInterval(() => void run(false), cfg.datasetPurgeSweepIntervalMs);
  t.unref();
  return t;
}

/** Schedule the analysis-data retention purge sweep (ADAAAA-6746 G1b). Runs at
 * least once per `interval`, plus a startup run, hard-deleting analysis_events
 * + analysis_session_traces rows older than `analysisRetentionMs`. Unref'd
 * timer. */
function scheduleAnalysisPurgeSweep(
  cfg: ReturnType<typeof loadConfig>,
  store: Store
): NodeJS.Timeout {
  const run = async () => {
    try {
      const cutoff = new Date(Date.now() - cfg.analysisRetentionMs).toISOString();
      await store.purgeAnalysisBefore(cutoff);
      // eslint-disable-next-line no-console
      console.log(`analysis-purge swept rows older than ${cutoff}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("analysis-purge error:", e);
    }
  };
  void run();
  const t = setInterval(() => void run(), cfg.analysisPurgeSweepIntervalMs);
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
  const billing = new BillingService(cfg, db, stripe, entitlements, {
    // Plan deactivated (Stripe 'customer.subscription.deleted') -> schedule the
    // account's datasets for 30-day purge (ADAAAA-5398 C4). Retrieval is denied
    // immediately by the retrieval gate once the account leaves active-non-starter.
    onPlanDeactivated: async (userId) => {
      await scheduleDatasetsPurgeForOwner(db, userId);
    },
  });

  if (!billing.enabled) {
    console.warn("WARN: billing is DISABLED (set STRIPE_SECRET_KEY + STRIPE_PRICE_PRO) — /jobs gated on free quota only.");
  }

  if (cfg.betaGate) {
    console.log(`invite/beta-gate: ON (${cfg.betaClipQuota} clips/mo per user)`);
  }

  if (cfg.autoPublishHighlights) {
    console.log("clip auto-publish: ON — generated clips go straight to the public /feed (admin review off).");
  }

  // Durable ledger of on-chain funded perceive sessions (ADAAAA-6586). Only
  // meaningful on the on-chain orchestrator path (signer + payer); a session
  // with no running payment refresher is never force-released.
  const perceiveLedger =
    cfg.signerUrl && cfg.payerAddress
      ? filePerceiveSessionLedger(join(cfg.dataDir, "perceive-sessions.json"))
      : undefined;
  const adapter = makeAdapter(cfg, { ledger: perceiveLedger });
  const app = buildApp({ cfg, store, adapter, db, auth, billing, entitlements, mailer: mailer ?? undefined });
  scheduleRejectSweep(cfg, store);
  scheduleDatasetPurgeSweep(cfg, db);
  scheduleAnalysisPurgeSweep(cfg, store);
  // A container recreate mid-VOD drops the in-memory payment refreshers, so a
  // perceive session the orchestrator still holds stops being funded and would
  // be force-released with `insufficient balance`. Release any the previous
  // process left funded before serving new work; release is idempotent on the
  // orchestrator, and a failure logs + stays in the ledger for the next boot.
  if (perceiveLedger) {
    try {
      const { released, failed } = await releaseOrphanedPerceiveSessions(adapter, perceiveLedger);
      if (released.length || failed.length) {
        // eslint-disable-next-line no-console
        console.log(
          `perceive-ledger: released ${released.length} orphaned perceive session(s)` +
            (failed.length ? `, ${failed.length} failed (kept for retry)` : "")
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("perceive-ledger reconcile error:", e);
    }
  }
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`highlights server on :${cfg.port} (orchestrator=${cfg.orchestratorUrl})`);
  console.log(`dev admin: ${cfg.adminEmail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
