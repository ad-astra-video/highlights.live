import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config";
import { Store } from "./store";
import { buildApp } from "./api";
import { makeAdapter } from "./livepeer-adapter";

async function main() {
  const cfg = loadConfig();
  await mkdir(cfg.dataDir, { recursive: true });
  const store = new Store();
  const adapter = makeAdapter(cfg);
  const app = buildApp({ cfg, store, adapter });
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`highlights server on :${cfg.port} (orchestrator=${cfg.orchestratorUrl})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
