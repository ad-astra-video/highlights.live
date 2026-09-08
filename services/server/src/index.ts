import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config";
import { Store } from "./store";
import { SqlDb } from "./db";
import { AuthService } from "./auth";
import { BillingService } from "./billing";
import { buildApp } from "./api";
import { makeAdapter } from "./livepeer-adapter";
import Stripe from "stripe";

async function main() {
  const cfg = loadConfig();
  await mkdir(cfg.dataDir, { recursive: true });
  const store = new Store();
  const db = new SqlDb(cfg.databasePath);
  const auth = new AuthService(db, cfg);
  auth.bootstrapAdmin();

  const stripe = cfg.stripeSecretKey ? new Stripe(cfg.stripeSecretKey) : null;
  const billing = new BillingService(cfg, db, stripe);

  if (!billing.enabled) {
    console.warn("WARN: billing is DISABLED (set STRIPE_SECRET_KEY + STRIPE_PRICE_PRO) — /jobs gated on free quota only.");
  }

  const adapter = makeAdapter(cfg);
  const app = buildApp({ cfg, store, adapter, db, auth, billing });
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`highlights server on :${cfg.port} (orchestrator=${cfg.orchestratorUrl})`);
  console.log(`dev admin: ${cfg.adminEmail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
