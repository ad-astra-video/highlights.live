import { HttpSignerClient } from "@highlights/livepeer-session";
import { loadConfig } from "./config";
import { MediaServer } from "./server";

async function main() {
  const cfg = loadConfig();
  // On-chain: point the media server at the remote signer so it pays the
  // orchestrator for the whole time a stream is open. Offchain (no signer) the
  // media server runs unpaid.
  const signer = cfg.signerUrl ? new HttpSignerClient(cfg.signerUrl) : undefined;
  const media = new MediaServer(
    {
      orchBase: cfg.orchBase,
      callbackBase: cfg.callbackBase,
      seedImageB64: cfg.seedImageB64,
      signer,
      payerAddress: cfg.payerAddress,
      paymentIntervalMs: cfg.paymentIntervalMs,
    },
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
