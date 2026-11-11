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
import { liveDecideAdmission } from "./live-decide-admission";
import { LIVE_DECIDE_IMAGE_BUDGET, LIVE_DECIDE_IMAGE_CEILING, LIVE_OBSERVE_WINDOW_S, OBSERVE_CADENCE_S } from "./observe-loop";
import { liveDecideBootLines } from "./live-decide-posture";
import { runRejectSweep } from "./lifecycle";
import { runDatasetPurgeSweep, scheduleDatasetsPurgeForOwner } from "./dataset-lifecycle";
import { filePerceiveSessionLedger, releaseOrphanedPerceiveSessions } from "./perceive-ledger";
import { outcomeForStrandedJob } from "./job-failure";
import { accruedSecondsSince, buildTerminalAccountingPatch } from "./job-settlement";
import { isLiveWatchSession } from "./live-watch-minutes";
import { reconcileStaleMediaSessions } from "./media-session-reconcile";
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

async function main() {
  const cfg = loadConfig();
  // ADAAAA-7758: wire the live decide admission switch before any rail starts.
  liveDecideAdmission.configure(cfg.liveDecideAdmission);
  if (cfg.liveDecideAdmission) {
    console.log("[live-admission] one live decide slot per box (ADAAAA-7758)");
  }
  await mkdir(cfg.dataDir, { recursive: true });
  // Prod: Postgres when DATABASE_URL is set; dev: SQLite at databasePath.
  const db = await openDb(cfg);
  // Durable jobs + highlights: the Store write-throughs every mutation to the
  // Db and hydrates the in-memory working set on boot, so stateful data
  // (users, jobs, highlights, entitlements) survives restarts.
  const store = new Store(db);
  await store.load();
  // Boot-time sweep (ADAAAA-6760): no in-flight run survives a restart, so any
  // job left in `active` (no completedAt) is stranded. Reap it to `failed` so
  // the new processing-jobs surface doesn't show a perpetually-spinning row.
  try {
    // ADAAAA-7700: attribute the sweep. A browser share stranded at boot was
    // carried by a media session (`media_sessions` row) that died in the same
    // window — a recreate restarts `highlights-media` alongside `server` — so the
    // honest reason is `media-session-lost`, not a bare `failed`. Without this the
    // 22:16Z row read exactly like "the pipeline never ran".
    const stranded = store.listActiveJobs();
    const mediaRows = new Set((await db.listMediaSessions()).map((m) => m.jobId));
    const reaped = await store.sweepStrandedJobs((job) => {
      const o = outcomeForStrandedJob(job.source, mediaRows.has(job.id));
      // ADAAAA-8061: settle the cost this pass actually accumulated instead of
      // writing a bare `failed`. The decide count is MEASURED from the durable
      // per-decide rows already persisted for this job (the in-memory process is
      // gone, so nothing else survives); the perceive leg is the wall clock from
      // the pass start. Zero rows means "no decide was recorded", which is
      // `not measured`, not a proven zero — that settles as
      // `costUnavailable` + `partialCostUsd` so spend is never silently lost.
      const decideRows = store.candidatesForJob(job.id).length;
      const perceiveS =
        accruedSecondsSince(job.startedAt ?? job.scheduledAt ?? job.createdAt, Date.now()) ?? undefined;
      return {
        ...(o.status === "failed" ? { failureReason: o.failureReason, error: o.error } : {}),
        ...buildTerminalAccountingPatch({
          status: "failed",
          decideFee: cfg.decideFee,
          decideCalls: decideRows > 0 ? decideRows : null,
          perceiveSessionS: perceiveS ?? null,
          // ADAAAA-8692: a swept LIVE row's stream clock is the session it was
          // accruing (the same denominator `liveWatchMinutes` uses). A VOD row's
          // stream clock is the source clip, which this sweep cannot know — it
          // passes nothing and the readout stays absent rather than priced off
          // the wrong clock.
          streamSeconds: isLiveWatchSession({ source: job.source }) ? perceiveS ?? null : null,
          costUnavailableReason: "decide-count-not-persisted",
        }),
      };
    });
    if (reaped > 0) {
      const lost = stranded.filter((j) => mediaRows.has(j.id)).length;
      console.log(`[boot] swept ${reaped} stranded active job(s) -> failed (media-session-lost=${lost})`);
      for (const job of stranded) {
        const o = outcomeForStrandedJob(job.source, mediaRows.has(job.id));
        // Read the settled row back: the sweep's whole point (ADAAAA-8061) is
        // that a swept job carries a real spend record, so log what landed.
        const settled = store.getJob(job.id);
        const spend =
          settled?.costUsd !== undefined
            ? `decideCalls=${settled.decideCalls} costUsd=${settled.costUsd}`
            : `costUnavailable=${settled?.costUnavailable ?? "?"} partialCostUsd=${settled?.partialCostUsd ?? "?"}`;
        console.log(
          `[boot]   swept job ${job.id} source=${job.source} endedAt=${settled?.endedAt ?? "?"} ${spend}`
        );
        await db
          .appendJobLifecycleEvent({
            jobId: job.id,
            kind: "boot-swept",
            detail: `failureReason=${o.status === "failed" ? o.failureReason : "unknown"} source=${job.source} mediaSession=${mediaRows.has(job.id)} ${spend} endedAt=${settled?.endedAt ?? "?"}`,
          })
          .catch(() => {});
      }
    }
  } catch (e: any) {
    console.error("[boot] stranded-job sweep failed:", String(e?.message || e));
  }
  // ADAAAA-7764: repair the `media_sessions` liveness signal after the sweep.
  // Rows written BEFORE the terminal-transition hook (Store.patchJob ->
  // closeMediaSession) can still read `active` on a job that is already terminal
  // — the box carried 13 such rows on failed jobs, which made the deploy gate
  // ([ADAAAA-7750]) read 13 phantom live shares. Runs AFTER the stranded sweep
  // so the jobs it just reaped are already terminal; bounded, logged, and it
  // only settles `status: active` -> `closed` (rows are kept, so the
  // `media_sessions.node_id` -> `job.costUsd` attribution join is untouched).
  try {
    const rec = await reconcileStaleMediaSessions({ db, getJob: (id) => store.getJob(id) });
    if (rec.closed > 0) {
      console.log(
        `[boot] closed ${rec.closed}/${rec.scanned} stale active media_sessions row(s) ` +
          `(terminal or missing owning job); live rows kept=${rec.live}`
      );
    }
  } catch (e: any) {
    console.error("[boot] media-session reconcile failed:", String(e?.message || e));
  }
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
  // ADAAAA-8065 (rev 7) Step 3: the boot posture readout names ALL FOUR values
  // of the shipped cell — image budget, in-flight budget, window span, cadence.
  // `printenv` is NOT the proof that a leg ran the cell (the decide_audit rows
  // carry `imagesPerDecide`/`imageBudgetApplied`/`spanSec`/`cadenceMs`), but this
  // line states which values THIS process resolved, so a grade compares the two.
  for (const line of liveDecideBootLines(cfg)) console.log(line);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
