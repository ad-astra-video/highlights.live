import { HttpSignerClient } from "@highlights/livepeer-session";
import { existsSync } from "node:fs";
import { loadConfig } from "./config";
import { createOrchInfoB64Provider, readCaPem } from "./orch-info";
import { MediaServer } from "./server";

async function main() {
  const cfg = loadConfig();
  // On-chain: point the media server at the remote signer so it pays the
  // orchestrator for the whole time a stream is open. Offchain (no signer) the
  // media server runs unpaid.
  const signer = cfg.signerUrl ? new HttpSignerClient(cfg.signerUrl) : undefined;

  // On-chain only: resolve the orchestrator's net.OrchestratorInfo (base64) the
  // signer REQUIRES for /generate-live-payment. Fetch it from the orchestrator
  // over gRPC GetOrchestrator. Offchain (no signer) this is never used.
  const caCertPem =
    cfg.orchInfoCaPem ??
    (cfg.orchInfoCaPath && existsSync(cfg.orchInfoCaPath)
      ? readCaPem(cfg.orchInfoCaPath)
      : undefined);
  const orchInfoB64Provider =
    cfg.signerUrl && cfg.orchBase.startsWith("https")
      ? createOrchInfoB64Provider({
          signerUrl: cfg.signerUrl,
          orchBase: cfg.orchBase,
          caCertPem,
        })
      : undefined;

  const media = new MediaServer(
    {
      orchBase: cfg.orchBase,
      callbackBase: cfg.callbackBase,
      seedImageB64: cfg.seedImageB64,
      signer,
      payerAddress: cfg.payerAddress,
      paymentIntervalMs: cfg.paymentIntervalMs,
      orchInfoB64Provider,
      publicBaseUrl: cfg.publicBaseUrl,
      provisionNoClientMs: cfg.provisionNoClientMs,
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
