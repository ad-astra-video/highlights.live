import { loadConfig } from "./config";
import { MediaServer } from "./server";

async function main() {
  const cfg = loadConfig();
  const media = new MediaServer(
    { orchBase: cfg.orchBase, callbackBase: cfg.callbackBase, seedImageB64: cfg.seedImageB64 },
  );
  const app = await media.build();
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`media server on :${cfg.port} (orchestrator=${cfg.orchBase})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
