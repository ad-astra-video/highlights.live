import { HttpSignerClient } from "@highlights/livepeer-session";
import { loadConfig } from "./config";
import { MediaServer } from "./server";
import { loadLedger, recordBoot, recordExit, saveLedger, snapshot } from "./lifecycle";

async function main() {
  const cfg = loadConfig();

  // ADAAAA-7656: the service runs with `restart: unless-stopped`, so an exit is
  // recovered by docker instead of waiting for the hourly box-health tick. That
  // makes a persistent fault a restart loop that answers /health fine, so keep a
  // small crash ledger next to the process and publish it on `/health`
  // (`status` flips to "degraded" once the node restarts too often in the window).
  // ADAAAA-7689 AC4: the ledger also carries a per-boot id and the image
  // revision, so a restart reads as a deploy or a crash from `/health` alone.
  const ledger = recordBoot(loadLedger(cfg.stateDir), { buildRef: cfg.buildRef });
  saveLedger(ledger, cfg.stateDir);
  const lifecycle = () => snapshot(ledger, { windowS: cfg.restartWindowS, threshold: cfg.restartDegradedThreshold });
  // Record exits this process can actually see. SIGKILL / OOM run no handler;
  // the next boot then records `unobserved-exit` instead of inventing a code.
  process.on("exit", (code) => {
    recordExit(ledger, { code, signal: null, reason: "exit" });
    saveLedger(ledger, cfg.stateDir);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as NodeJS.Signals[]) {
    process.on(signal, () => {
      recordExit(ledger, { code: 0, signal, reason: "signal" });
      saveLedger(ledger, cfg.stateDir);
      process.exit(0);
    });
  }

  // On-chain: point the media server at the remote signer so it pays the
  // orchestrator for the whole time a stream is open. Offchain (no signer) the
  // media server runs unpaid.
  const signer = cfg.signerUrl ? new HttpSignerClient(cfg.signerUrl, undefined, cfg.signerAuthToken) : undefined;

  // On-chain: find WHICH orchestrator / live-runner to start the session against
  // via the signer's /discover-orchestrators — the media server never dials the
  // orchestrator for OrchestratorInfo directly. The orchestrator's info comes
  // from the 402 reserve challenge, not from a gRPC GetOrchestrator. Offchain
  // (no signer) discovery is never invoked and ORCHESTRATOR_URL is used.
  const discoverOrchestrators = signer ? async () => signer.discover([]) : undefined;

  const media = new MediaServer({
    orchBase: cfg.orchBase,
    callbackBase: cfg.callbackBase,
    seedImageB64: cfg.seedImageB64,
    signer,
    payerAddress: cfg.payerAddress,
    paymentIntervalMs: cfg.paymentIntervalMs,
    discoverOrchestrators,
    publicBaseUrl: cfg.publicBaseUrl,
    provisionNoClientMs: cfg.provisionNoClientMs,
    rtcIceServers: cfg.rtcIceServers,
    rtcIceGatherTimeoutMs: cfg.rtcIceGatherTimeoutMs,
    // ADAAAA-7990: the funded live sampling baseline (LIVE_SAMPLE_BASE_FPS=3).
    // The control plane's per-session resolved rate overrides this.
    rtcSampleFps: cfg.rtcSampleFps,
    // ADAAAA-6869 Phase 4 capacity/health + per-node cost attribution surface.
    nodeId: cfg.nodeId,
    maxSessions: cfg.maxSessions,
    healthToken: cfg.healthToken,
    // ADAAAA-7656 restart/crash ledger for `/health`.
    lifecycle,
    // ADAAAA-7700 open-session ledger: same state dir as the lifecycle ledger so
    // the leftover list survives the recreate/deploy that killed the sessions.
    stateDir: cfg.stateDir,
  });
  const app = await media.build();
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(`media server on :${cfg.port} (orchestrator=${cfg.orchBase})`);
  // ADAAAA-7700: report every session the PREVIOUS boot took down (deploy /
  // crash / docker stop) to the control plane, so a browser share that died with
  // this process becomes `failed` with `failureReason: media-session-lost` and a
  // reshare hint instead of a bare `failed` row with 0 frames. Fire-and-forget:
  // recovery reporting must never delay the port from listening, and the server's
  // own boot sweep is the backstop when both containers restart together.
  void media
    .reconcileLostSessions()
    .then((r) => {
      if (r.leftover > 0) {
        // eslint-disable-next-line no-console
        console.log(`[media] lost-session reconcile leftover=${r.leftover} reported=${r.reported}`);
      }
    })
    .catch((e) => console.error("[media] lost-session reconcile failed:", String(e?.message || e)));
  const boot = lifecycle();
  // eslint-disable-next-line no-console
  console.log(
    `[media] lifecycle boots=${boot.boots} bootId=${boot.bootId ?? "-"} buildRef=${boot.buildRef ?? "-"} cause=${boot.restartCause} lastExit=${boot.lastExit ? `${boot.lastExit.reason}:${boot.lastExit.code ?? "-"}` : "none"} bootsInWindow=${boot.bootsInWindow}/${boot.threshold} degraded=${boot.degraded}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
