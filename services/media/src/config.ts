// Media server env config.
export interface MediaConfig {
  port: number;
  /**
   * Orchestrator public URL (offchain lab) or gateway URL. On-chain this is the
   * fallback for the session-start base when /discover-orchestrators returns
   * nothing; the orchestrator's OrchestratorInfo is never fetched by the media
   * server — it comes from the 402 reserve challenge.
   */
  orchBase: string;
  /** Fastify control plane base — observations are POSTed back here. */
  callbackBase?: string;
  /** Optional seed JPEG (base64) sent to trigger the runner to open channels. */
  seedImageB64?: string;
  /** Remote signer base URL (on-chain). When set, the media server pays. */
  signerUrl?: string;
  /** Shared bearer token the remote signer requires (sealed SIGNER_AUTH_TOKEN),
   * sent as `Authorization: Bearer <token>` on every signer signing call.
   * Without it the signer rejects the media server, which therefore never
   * obtains a valid Livepeer-Payment ticket and go-livepeer returns
   * `402 invalid live runner payment signer address` at live-runner serve time
   * (ADAAAA-3250). */
  signerAuthToken?: string;
  /** Payer address advertised on reserve (on-chain). */
  payerAddress?: string;
  /** Payment refresh interval in ms (default 10_000). */
  paymentIntervalMs?: number;
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
  /** ICE servers (STUN/TURN) for WebRTC ingest — a JSON array of
   *  `{ urls, username?, credential? }`. When set, the media server gathers a
   *  relay (TURN) candidate and hands the same servers to the browser, so the
   *  media path can be held instead of the browser reconnect-looping on
   *  unreachable host candidates (ADAAAA-7304 finding 4). */
  rtcIceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  /** Max ms to wait for the answerer's ICE gathering to complete before the
   *  RTC answer is returned (so it carries a reachable candidate). Default 2000. */
  rtcIceGatherTimeoutMs?: number;
  /**
   * ADAAAA-7990: fallback webRTC ingest sampling cadence for this node. The
   * control plane's per-session `sampleFps` (resolved by `resolveSampleFps`
   * over `LIVE_SAMPLE_BASE_FPS`) is authoritative; this is what the node uses
   * for a session provisioned without one. Deliberately the SAME env names the
   * live analyzer path already reads — no second fps knob:
   * `LIVE_SAMPLE_BASE_FPS` (default 3, the funded live baseline) bounded by
   * `LIVE_SAMPLE_MAX_FPS` (default 10).
   */
  rtcSampleFps: number;
  /**
   * Stable identity of THIS media node (ADAAAA-6869 Phase 4). Published on
   * `/health`, returned to the control plane by `POST /sessions`, and stored per
   * job so Livepeer GPU spend can be attributed per node. One node today; the
   * field is what makes a later multi-node fleet attributable without a schema
   * change. Defaults to `media-0` (set MEDIA_NODE_ID explicitly in a fleet).
   */
  nodeId: string;
  /**
   * Concurrent perceive sessions this node advertises as its capacity. The
   * perceive runner behind it is capacity-1 today (the orchestrator 503s
   * `no capacity available for runner` past that), so the default is 1. The
   * console compares active sessions against this to show load.
   */
  maxSessions: number;
  /**
   * Bearer token gating the per-session DETAIL surface (`GET /node`: session
   * ids, job ids, lease expiry). `/health` always stays public and reports
   * counts only. Unset => the detail route is disabled (404), because the media
   * origin is reachable through the public LB and session/job ids must not leak
   * to anonymous callers.
   */
  healthToken?: string;
  /**
   * Restart-loop visibility (ADAAAA-7656). With `restart: unless-stopped` the
   * media process comes back by itself after an exit, so `/health` must publish
   * the crash ledger (boot count, last exit code, last restart time) and turn
   * `degraded` when the node restarts `restartDegradedThreshold` times inside
   * `restartWindowS`. Defaults: 600 s window, threshold 3.
   */
  restartWindowS: number;
  restartDegradedThreshold: number;
  /** Directory holding the lifecycle ledger across process restarts. */
  stateDir?: string;
  /**
   * Revision of the running image, published on `/health` as `buildRef`
   * (ADAAAA-7689 AC4). The Dockerfile bakes it at build time from the
   * `BUILD_REF` build arg (`docker compose ... up -d --build` with
   * `BUILD_REF=$(git rev-parse --short HEAD)`); an operator can also set
   * `MEDIA_BUILD_REF` at runtime. Unset => `"unknown"`, which is published
   * verbatim rather than guessed.
   */
  buildRef: string;
}

/** ADAAAA-7990: resolve the node's fallback RTC sampling cadence from the SAME
 *  env knobs the control plane's live path uses (`LIVE_SAMPLE_BASE_FPS`,
 *  default 3; `LIVE_SAMPLE_MAX_FPS`, default 10). A media node deliberately has
 *  no fps knob of its own, so a deployment cannot drift the two rails apart. */
export function rtcSampleFpsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const base = Number(env.LIVE_SAMPLE_BASE_FPS ?? 3);
  const cap = Number(env.LIVE_SAMPLE_MAX_FPS ?? 10);
  const floor = Number.isFinite(base) && base > 0 ? base : 3;
  const ceiling = Number.isFinite(cap) && cap > 0 ? cap : 10;
  return Math.min(ceiling, Math.max(0.25, floor));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  return {
    port: Number(env.PORT ?? 4070),
    orchBase: env.ORCHESTRATOR_URL ?? "http://127.0.0.1:8935",
    callbackBase: env.CALLBACK_URL,
    seedImageB64: env.MEDIA_SEED_IMAGE_B64,
    signerUrl: env.SIGNER_URL,
    signerAuthToken: env.SIGNER_AUTH_TOKEN,
    payerAddress: env.PAYER_ADDRESS,
    paymentIntervalMs: env.PAYMENT_INTERVAL_MS ? Number(env.PAYMENT_INTERVAL_MS) : 10_000,
    publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL,
    provisionNoClientMs: env.MEDIA_PROVISION_NO_CLIENT_MS ? Number(env.MEDIA_PROVISION_NO_CLIENT_MS) : 60_000,
    rtcIceServers: env.MEDIA_RTC_ICE_SERVERS ? JSON.parse(env.MEDIA_RTC_ICE_SERVERS) : undefined,
    rtcIceGatherTimeoutMs: env.MEDIA_RTC_ICE_GATHER_TIMEOUT_MS ? Number(env.MEDIA_RTC_ICE_GATHER_TIMEOUT_MS) : undefined,
    // ADAAAA-7990: the rail's fallback cadence is the funded live baseline
    // (LIVE_SAMPLE_BASE_FPS=3), never 1 fps, and bounded by the same
    // LIVE_SAMPLE_MAX_FPS ceiling the control plane resolves against.
    rtcSampleFps: rtcSampleFpsFromEnv(env),
    // ADAAAA-6869 Phase 4: node identity + advertised capacity + the optional
    // bearer that unlocks the per-session detail surface.
    nodeId: env.MEDIA_NODE_ID ?? "media-0",
    maxSessions: env.MEDIA_MAX_SESSIONS ? Number(env.MEDIA_MAX_SESSIONS) : 1,
    healthToken: env.MEDIA_HEALTH_TOKEN,
    // ADAAAA-7656: restart-loop visibility for the `restart: unless-stopped`
    // policy — how wide the loop window is and how many restarts inside it turn
    // `/health` from green to degraded.
    restartWindowS: env.MEDIA_RESTART_WINDOW_S ? Number(env.MEDIA_RESTART_WINDOW_S) : 600,
    restartDegradedThreshold: env.MEDIA_RESTART_DEGRADED_THRESHOLD ? Number(env.MEDIA_RESTART_DEGRADED_THRESHOLD) : 3,
    stateDir: env.MEDIA_STATE_DIR,
    // ADAAAA-7689 AC4: the shipped revision. `BUILD_REF` is the build arg the
    // media Dockerfile bakes into the image; `MEDIA_BUILD_REF` is the runtime
    // override for an operator running the source tree directly.
    buildRef: env.MEDIA_BUILD_REF || env.BUILD_REF || "unknown",
  };
}
