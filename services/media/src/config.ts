// Media server env config.
export interface MediaConfig {
  port: number;
  /** Orchestrator public URL (offchain lab) or gateway URL. */
  orchBase: string;
  /** Fastify control plane base — observations are POSTed back here. */
  callbackBase?: string;
  /** Optional seed JPEG (base64) sent to trigger the runner to open channels. */
  seedImageB64?: string;
  /** Remote signer base URL (on-chain). When set, the media server pays. */
  signerUrl?: string;
  /** Payer address advertised on reserve (on-chain). */
  payerAddress?: string;
  /** Payment refresh interval in ms (default 10_000). */
  paymentIntervalMs?: number;
  /**
   * PEM of the orchestrator self-signed cert to trust for the GetOrchestratorInfo
   * gRPC TLS handshake (on-chain only). When unset, defaults to
   * `docker/orchestrator-ca.crt` if present, else insecure gRPC (dev/offchain).
   */
  orchInfoCaPem?: string;
  /**
   * Path to the orchestrator CA PEM (used only when ORCHESTRATOR_CA is unset).
   */
  orchInfoCaPath?: string;
  /** Public origin (scheme, host, optional base) the browser should ingest to —
   * normally the load-balancer / Cloudflare front, e.g.
   * `https://highlights-media.dpn.gg`. Used to return the FULL ws ingest URL
   * from POST /sessions so clients can be routed by the LB rather than assuming
   * a path on one node. When unset, no wsUrl is returned (clients fall back to
   * deriving it from the control server's MEDIA_SERVER_URL + wsPath).
   */
  publicBaseUrl?: string;
  /** Release a provisioned-but-never-used perceive slot after this many ms. */
  provisionNoClientMs?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  return {
    port: Number(env.PORT ?? 4070),
    orchBase: env.ORCHESTRATOR_URL ?? "http://127.0.0.1:8935",
    callbackBase: env.CALLBACK_URL,
    seedImageB64: env.MEDIA_SEED_IMAGE_B64,
    signerUrl: env.SIGNER_URL,
    payerAddress: env.PAYER_ADDRESS,
    paymentIntervalMs: env.PAYMENT_INTERVAL_MS ? Number(env.PAYMENT_INTERVAL_MS) : 10_000,
    // On-chain GetOrchestratorInfo TLS: explicit PEM env wins, else the repo's
    // docker/orchestrator-ca.crt when present (media runs from the repo root).
    orchInfoCaPem: env.ORCHESTRATOR_CA,
    orchInfoCaPath: env.ORCHESTRATOR_CA_PATH ?? "docker/orchestrator-ca.crt",
    publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
    provisionNoClientMs: env.MEDIA_PROVISION_NO_CLIENT_MS ? Number(env.MEDIA_PROVISION_NO_CLIENT_MS) : 60_000,
  };
}
