// Livepeer session + payment client for highlights.live.
//
// The SERVER is the only caller. It never holds an ETH keystore. Two paths:
//   - offchain lab: talk to the orchestrator public URL directly (no payment
//     headers required; reserve returns 200 immediately).
//   - on-chain: payment material comes from the remote signer (SignerClient).
//     Reserve returns 402 -> attach Livepeer-Payment/Livepeer-Segment from
//     signer.generateLivePayment() and retry, then refresh on an interval.
//
// Talks to: orchestrator public URL + (optionally) the signer. Never runner_url.

export const ROUTES = {
  perceive: "highlights-perceive",
  // ADAAAA-8559 (S2): this is the decide APP name (the capability/discovery
  // leaf and the payment descriptor), NOT the route the client posts to. Since
  // S1 registers five per-container runners, every decide attempt selects a
  // runner id from the probe's pool and posts `/apps/{runner_id}/app/<path>`.
  // `ROUTES.decide` survives in two places only:
  //   - `isDecideRunnerApp` matching the shared `highlights-live/decide` leaf
  //     (must NOT be switched to runner-id prefix matching);
  //   - the pre-probe single-registration fallback route, used only while the
  //     pool is empty (dark discovery). On a probed fleet that retired id is
  //     never posted.
  decide: "highlights-decide",
  train: "highlights-train",
} as const;

export type Route = (typeof ROUTES)[keyof typeof ROUTES];

// --- Signer interface (remote signer is the only ETH holder) --------------

/**
 * Opaque signed state blob the remote signer returns for a live payment.
 * It MUST be passed back verbatim on the next payment/refresh (go-livepeer
 * `RemotePaymentStateSig`: both fields are base64).
 */
export interface RemotePaymentStateSig {
  State: string; // base64
  Sig: string; // base64
}

/**
 * Request body for go-livepeer `POST /generate-live-payment`
 * (`server/RemotePaymentRequest`, v0.9.2). The `orchestrator` field is the
 * base64 protobuf of `net.OrchestratorInfo` and is REQUIRED — go-livepeer
 * returns `400 err=missing orchestrator` when it is empty. A JSON object
 * shape differing from this schema is a protocol bug the signer silently
 * ignores, so keep this exactly aligned with the Go struct.
 */
export interface RemotePaymentRequest {
  /** Opaque signed state from the previous payment; omit on the first payment. */
  state?: RemotePaymentStateSig;
  /** base64 protobuf of net.OrchestratorInfo — REQUIRED. */
  orchestrator: string;
  /** Optional; ties the payment to orchestrator accounting for a session. */
  manifestID?: string;
  /** Application associated with the payment (e.g. "highlights-perceive"). */
  app?: string;
  /** Pixels to generate a ticket for. Required if `type` is not set. */
  inPixels?: number;
  /** Job type: "live" | "lv2v" | "fixed". */
  type?: "live" | "lv2v" | "fixed";
  /** Maximum acceptable price (currency must be "wei", unit per type). */
  maxPrice?: { price: string; currency: string; unit: string };
  /** base64 protobuf Capabilities; may be set for the lv2v job type. */
  capabilities?: string;
}

/** Response from go-livepeer `POST /generate-live-payment` (RemotePaymentResponse). */
export interface RemotePaymentResponse {
  payment: string; // Livepeer-Payment header value
  segCreds?: string; // Livepeer-Segment header value
  state: RemotePaymentStateSig; // pass back verbatim on the next call
}

/**
 * Build the exact JSON string go-livepeer expects for `/generate-live-payment`.
 * Only defined fields are emitted (`omitempty` semantics) so an empty-state
 * first payment omits `state`; `orchestrator` is always present.
 */
export function buildRemotePaymentRequest(req: RemotePaymentRequest): string {
  const out: Record<string, unknown> = { orchestrator: req.orchestrator };
  if (req.state && (req.state.State || req.state.Sig)) out.state = req.state;
  if (req.manifestID) out.manifestID = req.manifestID;
  if (req.app) out.app = req.app;
  if (req.inPixels !== undefined) out.inPixels = req.inPixels;
  if (req.type) out.type = req.type;
  if (req.maxPrice) out.maxPrice = req.maxPrice;
  if (req.capabilities) out.capabilities = req.capabilities;
  return JSON.stringify(out);
}

export interface GeneratePaymentResult {
  payment: string; // Livepeer-Payment header value
  segCreds: string; // Livepeer-Segment header value
  signerState: RemotePaymentStateSig | null; // opaque blob; pass back verbatim
}

export interface DiscoveredRunner {
  url: string;
  app: string;
  gpu?: { id?: string; name?: string; vram_mb?: number };
  mode?: string;
  capacity?: number;
  capacity_available?: number;
  price_info?: { price?: number; currency?: string; unit?: string };
  metadata?: string;
}

/** Signature + payment material the signer returns for a live payment. */
export interface LivePayment {
  payment: string;
  segCreds: string;
  signerState: RemotePaymentStateSig | null; // opaque signed blob; pass back verbatim
}

export interface SignerClient {
  /** Signer GET /discover-orchestrators?caps=... */
  discover(caps: string[]): Promise<{ address: string; runners: DiscoveredRunner[] }[]>;
  /** Signer POST /sign-orchestrator-info for a given orchestrator address */
  signOrchInfo(address: string): Promise<unknown>;
  /**
   * Signer POST /generate-live-payment -> payment headers + state.
   * `orchInfoB64` is the base64 protobuf of the orchestrator's
   * `net.OrchestratorInfo` (go-livepeer REQUIRES it; null -> 400).
   * `prevState` is the opaque signed blob from the previous call (null on the
   * first payment). The returned `signerState` must be passed back verbatim.
   */
  generateLivePayment(
    orchInfoB64: string,
    prevState: RemotePaymentStateSig | null,
    opts?: {
      app?: string;
      type?: "live" | "lv2v" | "fixed";
      inPixels?: number;
      /**
       * go-livepeer REQUIRES the live payment's manifestID to equal the
       * orchestrator's AuthToken.SessionId (from GetOrchestratorInfo);
       * otherwise the orchestrator's live-runner reserve returns
       * `403 mismatched manifest and auth token`.
       */
      manifestID?: string;
    }
  ): Promise<LivePayment>;
}

// --- Errors -----------------------------------------------------------------

/**
 * The orchestrator's 402 payment-challenge payload. go-livepeer
 * (`liveRunnerPaymentChallengeResponse`, server/ai_http.go) returns this in the
 * reserve 402 response BODY — the payer does NOT need to call gRPC
 * GetOrchestrator on the orchestrator to obtain the OrchestratorInfo; it is
 * already in the challenge. `paymentParams` is base64 of `net.OrchestratorInfo`
 * (exactly the `orchestrator` field `/generate-live-payment` REQUIRES) and
 * `manifestId` is `AuthToken.SessionId` (the live payment's `manifestID` must
 * equal it or the orchestrator rejects with `403 mismatched manifest and auth
 * token`).
 */
export interface LivePaymentChallenge {
  /** base64 protobuf of net.OrchestratorInfo — the /generate-live-payment `orchestrator` field. */
  paymentParams?: string;
  /** Orchestrator service URI (oInfo.Transcoder). */
  orchestrator?: string;
  /** AuthToken.SessionId — must equal the live payment manifestID. */
  manifestId?: string;
  /** Orchestrator payment endpoint (`…/session/{sid}/payment`). */
  paymentUrl?: string;
}

/** Normalize a 402 challenge body (snake_case wire keys) to camelCase. */
export function livePaymentChallengeFromBody(body: unknown): LivePaymentChallenge | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const out: LivePaymentChallenge = {};
  if (typeof b.payment_params === "string") out.paymentParams = b.payment_params as string;
  if (typeof b.orchestrator === "string") out.orchestrator = b.orchestrator as string;
  if (typeof b.manifest_id === "string") out.manifestId = b.manifest_id as string;
  if (typeof b.payment_url === "string") out.paymentUrl = b.payment_url as string;
  return Object.keys(out).length ? out : undefined;
}

export class PaymentRequiredError extends Error {
  /**
   * @param paymentParams The raw 402 challenge body (snake_case JSON) the
   *   orchestrator returned. `challenge` is the parsed camelCase view.
   * @param challenge Parsed payment material the payer should forward to the
   *   remote signer to obtain tickets (see LivePaymentChallenge). Undefined
   *   when the 402 body carried no recognizable challenge.
   */
  constructor(public paymentParams: unknown, public challenge?: LivePaymentChallenge) {
    super("402 Payment Required: reserve needs signer payment material");
    this.name = "PaymentRequiredError";
  }
}

export class NotAuthorizedError extends Error {
  constructor(msg = "401: unauthorized") {
    super(msg);
  }
}

// --- Transport ---------------------------------------------------------------

export interface Transport {
  request(method: string, url: string, init?: { headers?: Record<string, string>; body?: any }): Promise<{
    status: number;
    headers: Headers;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

export class HttpTransport implements Transport {
  private tlsReject: boolean;
  constructor(private base: string, opts?: { rejectUnauthorized?: boolean }) {
    this.tlsReject = opts?.rejectUnauthorized ?? true;
  }
  async request(method: string, url: string, init: { headers?: Record<string, string>; body?: any } = {}) {
    const headers = { ...(init.headers || {}) };
    const res = await fetch(new URL(url, this.base).toString(), {
      method,
      headers,
      body: init.body,
    });
    return {
      status: res.status,
      headers: res.headers,
      async json() {
        return res.json();
      },
      async text() {
        return res.text();
      },
    };
  }
}

// --- Client ------------------------------------------------------------------

export interface ReserveResult {
  sessionId: string;
  appUrl: string;
  controlUrl: string;
}

/**
 * Talks to a go-livepeer REMOTE SIGNER (`livepeer -remoteSigner`) over its
 * HTTP API. The signer is the only process that holds the ETH keystore; the
 * server calls it (via internal routing on Railway) to obtain signed
 * orchestrator info and live-payment ticket material.
 */
export class HttpSignerClient implements SignerClient {
  constructor(
    public readonly base: string,
    private transport: Transport = new HttpTransport(base),
    private authToken?: string
  ) {}

  /**
   * Merge the shared signer bearer token (SIGNER_AUTH_TOKEN) into outbound
   * request headers. The remote signer (`livepeer -remoteSigner` on Railway,
   * sealed as SIGNER_AUTH_TOKEN) expects `Authorization: Bearer <token>` on
   * every signing call; without it the signer rejects the request and the
   * server never obtains a valid Livepeer-Payment ticket, so go-livepeer
   * returns `402 invalid live runner payment signer address` at live-runner
   * serve time (ADAAAA-3250). Offchain/no-token signers get no header.
   */
  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    if (this.authToken) extra["Authorization"] = `Bearer ${this.authToken}`;
    return extra;
  }

  async discover(caps: string[]): Promise<{ address: string; runners: DiscoveredRunner[] }[]> {
    const qs = caps.map((c) => `caps=${encodeURIComponent(c)}`).join("&");
    const res = await this.transport.request("GET", `/discover-orchestrators${qs ? `?${qs}` : ""}`, {
      headers: this.authHeaders(),
    });
    if (res.status !== 200) throw new Error(`signer discover failed: HTTP ${res.status}`);
    return (await res.json()) as { address: string; runners: DiscoveredRunner[] }[];
  }

  async signOrchInfo(address: string): Promise<unknown> {
    const res = await this.transport.request("POST", "/sign-orchestrator-info", {
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ orchestrator: address }),
    });
    if (res.status !== 200) throw new Error(`signer signOrchInfo failed: HTTP ${res.status}`);
    return res.json();
  }

  async generateLivePayment(
    orchInfoB64: string,
    prevState: RemotePaymentStateSig | null,
    opts: { app?: string; type?: "live" | "lv2v" | "fixed"; inPixels?: number; manifestID?: string } = {}
  ): Promise<LivePayment> {
    // go-livepeer decodes a RemotePaymentRequest and REQUIRES the base64
    // net.OrchestratorInfo protobuf in the `orchestrator` field. Sending the
    // OLD `{ orchInfo, prevState }` shape made the field empty -> `400 err=missing
    // orchestrator`, which media surfaced as "signer generateLivePayment failed: HTTP 400".
    // `manifestID` must equal the orchestrator's AuthToken.SessionId, else the
    // orchestrator's live-runner reserve returns `403 mismatched manifest and auth token`.
    const body = buildRemotePaymentRequest({
      orchestrator: orchInfoB64,
      ...(prevState ? { state: prevState } : {}),
      ...(opts.manifestID ? { manifestID: opts.manifestID } : {}),
      ...(opts.app ? { app: opts.app } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.inPixels !== undefined ? { inPixels: opts.inPixels } : {}),
    });
    const res = await this.transport.request("POST", "/generate-live-payment", {
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body,
    });
    if (res.status === 482) {
      // go-livepeer returns 482 "no new tickets needed", but (ADAAAA-6609) the
      // response body now ALSO carries the re-signed, fee-accounted state. Surface
      // it on the thrown error so `refreshPerceivePayment` persists the DRAINED
      // balance and the signer mints a refill before the orchestrator's reserved
      // balance reaches the fee trough. No payment is POSTed this tick (482 still
      // means "no new tickets").
      let drained: RemotePaymentStateSig | null = null;
      try {
        drained = ((await res.json()) as RemotePaymentResponse).state ?? null;
      } catch {
        drained = null;
      }
      const err = new Error(`signer generateLivePayment failed: HTTP ${res.status}`) as Error & {
        signerState?: RemotePaymentStateSig | null;
      };
      err.signerState = drained;
      throw err;
    }
    if (res.status !== 200) throw new Error(`signer generateLivePayment failed: HTTP ${res.status}`);
    const parsed = (await res.json()) as RemotePaymentResponse;
    return {
      payment: parsed.payment,
      segCreds: parsed.segCreds ?? "",
      signerState: parsed.state ?? null,
    };
  }
}

// --- Decide admission (ADAAAA-8254 -> ADAAAA-8437) ---------------------------
// ONE gate owns every decide app-call (live observer, VOD pass, planner). The
// gate is:
//
//   1. CAPACITY-WIDE: admission follows what the fleet ADVERTISES. The effective
//      ceiling is the discovered `advertised` number clamped to
//      [1, DECIDE_MAX_ADMISSION] (default 32). It sizes UP as well as DOWN: the
//      board ruling on ADAAAA-8418 rejected the funded-8 ceiling ("The
//      DECIDE_CONCURRENCY artificially limiting to 8 is wrong. It should just be
//      limited by the capacity available"), which supersedes the ADAAAA-7803
//      framing and the ADAAAA-8254 "funded WINS, discovery can only lower it"
//      rule. DECIDE_CONCURRENCY still rides the snapshot as `funded` for
//      reporting, but it is no longer a ceiling.
//
//      The safety cap `DECIDE_MAX_ADMISSION` is NOT a funding posture: it guards
//      against a bad advertisement (a truncated pool read, a mis-set
//      `--max-num-seqs`, a signer that sums a backup set) turning into an
//      unbounded admission width. Clamped [1, cap], never 0.
//
//      No configured probe => byte-identical to the pre-8254 static gate
//      (`effective == funded`, AC7).
//   2. AN ORDERED QUEUE. Waiters are admitted FIFO. A 503 opens one shared
//      pause window; every waiter waits on the SAME deadline, and exactly ONE
//      waiter runs the probe per window, so a zero-capacity episode costs one
//      decide probe per backoff window instead of one per queued request.
//   3. BOUNDED + COUNTED LOSS. A decide whose queue wait exceeds
//      DECIDE_QUEUE_MAX_WAIT_MS (or whose 503 retries are exhausted) fails with
//      the typed {@link DecideCapacityError}, increments `decideDropped`, and
//      never aborts the owning job. The counters ride the job's observe metrics
//      (see the server's `observeMetrics` snapshot).
//
// The capacity probe is deliberately NEVER awaited on the decide path: a slow
// or failing signer must not add latency or throw (AC2). A probe failure keeps
// the last known capacity, then the funded value — never 0.

/** Funded decide value when none is configured: the decide runner's capacity-2
 * admission (ADAAAA-6911). Reporting/fallback only since ADAAAA-8437 — it is no
 * longer an admission ceiling. */
export const DECIDE_FUNDED_CEILING_DEFAULT = 2;

/** Safety cap on a discovered advertisement (`DECIDE_MAX_ADMISSION`, default 32).
 * Not a funding posture: it bounds a MALFORMED advertisement (truncated pool
 * read, mis-set `--max-num-seqs`, a sum that includes failover-only runners),
 * so a bad discovery cannot open admission wider than the box can serve. */
export const DECIDE_MAX_ADMISSION_DEFAULT = 32;

/** First backoff window of a 503 episode (shared by every queued decide). */
export const DECIDE_BACKOFF_BASE_MS = 500;

/** Cap for one backoff window. */
export const DECIDE_BACKOFF_MAX_MS = 8_000;

/** Default capacity-refresh interval (`DECIDE_CAPACITY_REFRESH_S` = 60). */
export const DECIDE_CAPACITY_REFRESH_MS_DEFAULT = 60_000;

/** Default hard per-decide queue-wait budget (`DECIDE_QUEUE_MAX_WAIT_MS`). */
export const DECIDE_QUEUE_MAX_WAIT_MS_DEFAULT = 60_000;

/** Wall-clock budget for one capacity probe (`DECIDE_CAPACITY_TIMEOUT_S` = 2). */
export const DECIDE_CAPACITY_PROBE_TIMEOUT_MS = 2_000;

/** Where the snapshot's `advertised` value came from (ADAAAA-8262). */
export type DecideCapacitySource =
  /** The most recent probe supplied the number. */
  | "probe"
  /** The most recent probe failed / gave no number; a previous probe's value is kept. */
  | "last-known"
  /** Nothing was ever advertised (dark discovery / no probe) => `effective = funded`. */
  | "funded";

/** The numbers the startup log line, the job snapshot and the admin live
 * readout carry (ADAAAA-8254 -> ADAAAA-8437). */
export interface DecideCapacitySnapshot {
  /** Sum of `capacity` over the discovered decide runners; 0 = unknown. */
  advertised: number;
  /** The FUNDED value (`DECIDE_CONCURRENCY`). Reporting only since
   * ADAAAA-8437 — it no longer caps `effective`. */
  funded: number;
  /** What the gate actually admits: `advertised` clamped to [1, `cap`], or
   * `funded` (also clamped) when discovery is dark / never advertised. */
  effective: number;
  /** ADAAAA-8262: the last probe came back well-formed (no throw / timeout).
   * `false` means "probe failed" — distinct from a probe that answered with an
   * empty fleet (`probeOk: true, runners: 0`). Never affects the arithmetic. */
  probeOk: boolean;
  /** ADAAAA-8262: decide REGISTRATIONS in the last well-formed answer (0 = none).
   * ADAAAA-8504: the name is historical — on the fleet the box registers exactly
   * one `highlights-decide` app at any worker/seq width, so this counts
   * registrations, NOT workers. The job record carries it as
   * `decideRegistrations`. */
  runners: number;
  /** ADAAAA-8262: provenance of `advertised` (see {@link DecideCapacitySource}). */
  source: DecideCapacitySource;
  /** ADAAAA-8437: the safety cap (`DECIDE_MAX_ADMISSION`, default 32) the
   * advertisement was clamped to. Guards a malformed advertisement; it is NOT a
   * funding posture. */
  cap: number;
}

/**
 * ADAAAA-8344: the transport stages of ONE decide app-call attempt, measured at
 * the client (the only layer that can separate admission queue wait, send,
 * time-to-first-byte, body transfer and reply parse). All values are measured
 * wall clock in ms; `sentBytes` is the serialized request body length.
 *
 * This is instrumentation only: it rides `onDecideAttempt` and never changes the
 * payload, the headers, the attempt count or the billable-call count.
 */
export interface DecideAttemptTiming {
  /** 0-based attempt index inside one decide CALL (503/404 retries increment). */
  attempt: number;
  /** HTTP status the attempt settled on (0 when the transport threw). */
  status: number;
  /** Wall wait in the client's admission queue (slot grant), ms. */
  queueMs: number;
  /** JSON.stringify of the request body, ms (the body the transport sent). */
  serializeMs: number;
  /** Serialized request body length in BYTES (UTF-8). */
  sentBytes: number;
  /** Time to the response HEADERS (fetch resolves on headers = TTFB), ms. */
  ttfbMs: number;
  /** Reading the response body text, ms. */
  bodyMs: number;
  /** JSON.parse of the response body, ms. */
  parseMs: number;
  /** The attempt threw at the transport (network/TLS/reset) — no status. */
  transportError?: boolean;
  /** ADAAAA-8559: the decide runner id this attempt was routed to (the
   * orchestrator route segment). Set on every attempt including the legacy
   * single-registration fallback, so attribution needs no nginx `up=` join. */
  runnerId?: string;
  /** ADAAAA-8559: that runner's discovery tier (`5090` / `x99-fallback` /
   * `unknown` / `legacy-single` for the pre-probe fallback route). */
  runnerTier?: string;
  /** ADAAAA-8559: this client's in-flight decide count for that runner AFTER
   * this attempt took its slot (1 = exclusive). Feeds AC4's concurrency
   * watermark. */
  runnerInFlight?: number;
}

/** Result of one signer discovery, reduced to the decide-relevant numbers. */
export interface DecideCapacityProbeResult {
  /** Sum of `capacity` (falling back to `capacity_available`) over the decide
   * runners; `null` when the advertisement carries no usable number. */
  capacity: number | null;
  /** True when EVERY decide runner reported `capacity_available === 0`. Used
   * only as a stall signal with hysteresis — never to size the gate. */
  noneAvailable?: boolean;
  /** ADAAAA-8262: how many decide runners the answer carried (0 = empty fleet),
   * so a failed probe is distinguishable from a runner-less advertisement. */
  runners?: number;
  /** ADAAAA-8559: the decide runners THEMSELVES, so an attempt can pick one.
   *
   * `advertised` stays the sum over decide runners; this list is the routing
   * input. Only runners whose route (= runner id) is derivable from the
   * discovery `url` (`<orch>/apps/<id>/app`) appear here — a single-registration
   * advertisement with no route leaves the list empty, and the client then keeps
   * today's fixed-id path unchanged. */
  pool?: DecideRunnerPoolEntry[];
}

/** ADAAAA-8559: one decide runner exactly as discovery described it. */
export interface DecideRunnerPoolEntry {
  /** The runner id — which IS the orchestrator route (`/apps/{id}/app`). */
  runner_id: string;
  /** Advertised capacity (`capacity`, falling back to `capacity_available`). */
  capacity: number;
  /** Slots reported free at probe time; absent when not advertised. */
  capacity_available?: number;
  /** `metadata.tier` (`5090` / `x99-fallback`); `unknown` when absent. */
  tier: string;
}

/** ADAAAA-8559: per-runner decide attribution (AC4/AC5 gradeable from the job
 * record instead of nginx/router logs). Counters are per job (delta from the
 * `beginDecideJob` baseline); `maxInFlight` is the watermark since that start. */
export interface DecideRunnerAttribution {
  runner_id: string;
  tier: string;
  /** Attempts this client routed to the runner. */
  attempts: number;
  /** Attempts the runner answered 200 (the billable ones). */
  served: number;
  /** 503 no-capacity responses from this runner. */
  s503: number;
  /** 404 runner/session-not-found responses from this runner. */
  s404: number;
  /** Peak LOCAL concurrency sent to the runner (<= its advertised capacity on a
   * healthy fleet). */
  maxInFlight: number;
}

/** ADAAAA-8559: selection order for the decide pool. Lower rank is preferred:
 * the three 5090 workers first, then an unknown tier, then the x99 fallbacks. */
export function decideTierRank(tier: string): number {
  if (tier === "5090") return 0;
  if (tier === "x99-fallback") return 2;
  return 1;
}

/**
 * ADAAAA-8559: the runner id from a discovery `url`.
 *
 * go-livepeer exposes a single-shot runner as `<orch>/apps/<runner_id>/app` and
 * a persistent one as `<orch>/apps/<runner_id>/session`; `runner.route` IS the
 * runner id for dynamic registrations (`ai/runner/live_runner.go`). A proxied
 * runner exposes `/apps/proxy/<proxy_id>/...`, which carries no runner id, so
 * it returns null and the pool simply omits that runner.
 */
export function decideRunnerIdFromDiscoveryUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = /\/apps\/([^/?#]+)\/(?:session|app)(?:[/?#]|$)/.exec(url);
  if (!m || m[1] === "proxy") return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * ADAAAA-8559: a runner's `tier` from its discovery metadata. The registrars
 * publish JSON (`{"tier": "5090", ...}`); the `tier=5090,seqs=4` k=v spelling is
 * accepted too. Anything else reads `unknown` (which ranks below 5090).
 */
export function decideRunnerTierFromMetadata(metadata: string | undefined): string {
  if (!metadata) return "unknown";
  try {
    const parsed = JSON.parse(metadata) as { tier?: unknown };
    if (parsed && typeof parsed.tier === "string" && parsed.tier.trim()) return parsed.tier.trim();
  } catch {
    /* not JSON — fall through to the k=v form */
  }
  const m = /(?:^|[,;\s])tier\s*=\s*([^,;\s]+)/i.exec(metadata);
  return m ? m[1] : "unknown";
}

/** Per-job decide-admission counters surfaced on the job's observe metrics. */
export interface DecideAdmissionMetrics {
  /** Decide calls that had to wait in the queue (retries counted separately). */
  decideQueued: number;
  /** Decides dropped by the queue budget / exhausted 503 retries. */
  decideDropped: number;
  /** 503 no-capacity responses observed by the decide path. */
  decide503: number;
  /** Shared pause windows opened (a 503 episode or the stall hysteresis). */
  decidePauses: number;
  /** Capacity probes that errored, timed out, or came back malformed. */
  capacityProbeErrors: number;
  /** {advertised, funded, effective} at snapshot time. */
  capacity: DecideCapacitySnapshot;
  /** ADAAAA-8559: per-runner serving attribution for this job, so AC4 (spread,
   * concurrency, zero 503) is gradeable from the stored record. Empty when the
   * decide path made no call since `beginDecideJob`. Optional so older/hand-built
   * metric objects stay assignable; the client always fills it. */
  runnerAttribution?: DecideRunnerAttribution[];
}

/** A decide that lost admission: the queue budget expired or the runner stayed
 * at 503 through every retry. Typed so the live rail can log + continue instead
 * of failing the job (AC4). */
export class DecideCapacityError extends Error {
  constructor(
    /** Wall ms this decide waited for admission (across retries). */
    readonly waitedMs: number,
    /** The configured DECIDE_QUEUE_MAX_WAIT_MS. */
    readonly maxWaitMs: number,
    reason = "queue wait exceeded",
  ) {
    super(`decide dropped: ${reason} (waited ${Math.round(waitedMs)} ms, budget ${maxWaitMs} ms)`);
    this.name = "DecideCapacityError";
  }
}

/** True when a discovered runner advertises the decide app. The signer is
 * queried for `caps=highlights-live/<decide>`; the runner `app` field is the
 * bare `highlights-decide` on this fleet, so accept both spellings. */
export function isDecideRunnerApp(app: string | undefined): boolean {
  if (!app) return false;
  // `highlights-decide` (the runner app) and `highlights-live/decide` (the
  // capability the signer is queried for) name the same runner; match the leaf.
  const leaf = app.split("/").pop();
  return leaf === "decide" || leaf === ROUTES.decide;
}

/**
 * Reduce a `/discover-orchestrators` answer to the decide capacity numbers.
 *
 * - `capacity` wins; a missing `capacity` falls back to `capacity_available`
 *   (an older advertisement), and a missing/NaN on EVERY runner yields `null`
 *   (unknown) — never 0, so a field-less advertisement cannot shrink the gate.
 * - `noneAvailable` is true only when every decide runner actually reported
 *   `capacity_available === 0`; it is a transient stall signal, not a size.
 */
export function summarizeDecideDiscovery(
  discovery: { runners?: DiscoveredRunner[] }[] | null | undefined,
): DecideCapacityProbeResult {
  const runners = (Array.isArray(discovery) ? discovery : [])
    .flatMap((o) => (Array.isArray(o?.runners) ? o.runners : []))
    .filter((r) => isDecideRunnerApp(r?.app));
  if (runners.length === 0) return { capacity: null, noneAvailable: false, pool: [] };
  let sum = 0;
  let known = false;
  let everyAvailableKnown = true;
  let everyAvailableZero = true;
  // ADAAAA-8559: the pool, keyed by runner id (the signer can repeat an
  // orchestrator, and two answers for one id must not double-list it).
  const pool = new Map<string, DecideRunnerPoolEntry>();
  for (const r of runners) {
    const advertised = typeof r.capacity === "number" && Number.isFinite(r.capacity)
      ? r.capacity
      : typeof r.capacity_available === "number" && Number.isFinite(r.capacity_available)
        ? r.capacity_available
        : null;
    if (advertised !== null) {
      sum += Math.max(0, Math.floor(advertised));
      known = true;
    }
    if (typeof r.capacity_available === "number" && Number.isFinite(r.capacity_available)) {
      if (r.capacity_available > 0) everyAvailableZero = false;
    } else {
      everyAvailableKnown = false;
    }
    // A runner with no usable capacity number is still routable, but it cannot
    // be ranked; it stays out of the pool so selection only weighs measured
    // registrations. A runner whose route is not derivable keeps today's
    // fixed-id fallback (pool stays empty for a single unnamed registration).
    const runnerId = decideRunnerIdFromDiscoveryUrl(r.url);
    if (runnerId && advertised !== null) {
      const capacity = Math.max(0, Math.floor(advertised));
      const prev = pool.get(runnerId);
      // Keep the wider advertisement of a duplicated id.
      if (!prev || capacity > prev.capacity) {
        pool.set(runnerId, {
          runner_id: runnerId,
          capacity,
          ...(typeof r.capacity_available === "number" && Number.isFinite(r.capacity_available)
            ? { capacity_available: Math.max(0, Math.floor(r.capacity_available)) }
            : {}),
          tier: decideRunnerTierFromMetadata(r.metadata),
        });
      }
    }
  }
  return {
    capacity: known ? sum : null,
    noneAvailable: everyAvailableKnown && everyAvailableZero,
    runners: runners.length,
    pool: [...pool.values()],
  };
}

/** Grant handed out by the decide queue: `release` frees the slot, `probe` marks
 * the single-flight probe of a paused window. */
interface DecideGrant {
  release: () => void;
  probe: boolean;
}

/** ADAAAA-8559: one runner's cumulative counters (see {@link DecideRunnerAttribution}). */
interface DecideRunnerStat {
  tier: string;
  attempts: number;
  served: number;
  s503: number;
  s404: number;
  maxInFlight: number;
}

interface DecideQueueItem {
  resolve: (grant: DecideGrant) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
  enqueuedAt: number;
  /** The decide CALL's monotonic sequence. A retry re-enters with its original
   * sequence, so the queue stays FIFO by REQUEST order rather than deprioritizing
   * an older window behind newer ones after a 503. */
  seq: number;
}

export class LivepeerClient {
  constructor(
    public readonly orchBase: string,
    private transport: Transport = new HttpTransport(orchBase),
    private opts: {
      decideBackoffBaseMs?: number;
      decideMaxAttempts?: number;
      /** ADAAAA-6911: max concurrent decide app-calls the client will keep in
       * flight. Defaults to the decide runner capacity (2) so the unbounded VOD
       * dispatch (ADAAAA-6903) actually overlaps decide inference instead of
       * being silently serialized to 1; oversubscription is absorbed by the
       * orchestrator's `503 no capacity` + this client's backoff/retry. */
      decideConcurrency?: number;
      /** ADAAAA-8437: the safety cap on a discovered advertisement
       * (`DECIDE_MAX_ADMISSION`, default {@link DECIDE_MAX_ADMISSION_DEFAULT}).
       * `effective` is clamped [1, cap]. This is NOT a funding posture — it
       * bounds a bad advertisement, it does not budget the fleet. */
      decideMaxAdmission?: number;
      /** ADAAAA-6993: short backoff (ms) before retrying a `/payment` (or the
       * matching single-shot request) after the orchestrator rejects a ticket
       * minted against expired payment params with HTTP 400 `TicketParams
       * expired`. Gives the orchestrator time to cycle its params before the
       * re-sign/retry — distinct from the benign 480/482/481 cases, which need
       * no orchestrator round-trip. */
      ticketParamsRetryBackoffMs?: number;
      /** ADAAAA-8254: the capacity probe. Returns the advertised decide capacity
       * (from the signer's `/discover-orchestrators`) or `null` when the fleet
       * advertises no number. The probe runs at job start and at most every
       * {@link decideCapacityRefreshMs}; it is NEVER awaited on the decide path
       * and a rejection/timeout only bumps `capacityProbeErrors`. Unset (no
       * signer) => the funded ceiling alone, byte-identical to pre-8254. */
      decideCapacityProbe?: () => Promise<DecideCapacityProbeResult | null>;
      /** ADAAAA-8254: minimum ms between capacity probes (default 60 000;
       * `DECIDE_CAPACITY_REFRESH_S`). */
      decideCapacityRefreshMs?: number;
      /** ADAAAA-8254: hard per-decide queue-wait budget in ms (default 60 000;
       * `DECIDE_QUEUE_MAX_WAIT_MS`). Exceeding it drops the decide with
       * {@link DecideCapacityError}. */
      decideQueueMaxWaitMs?: number;
      /** ADAAAA-8254: single-flight probe wall budget (default 2 000 ms). */
      decideCapacityProbeTimeoutMs?: number;
      /** ADAAAA-8254: jitter as a fraction of the backoff window (default 0.25). */
      decideBackoffJitterRatio?: number;
      /** ADAAAA-8254: fires when the {advertised, funded, effective} snapshot
       * changes, so the server can print the startup/refresh log line. */
      onDecideCapacity?: (snapshot: DecideCapacitySnapshot) => void;
      /** ADAAAA-8254: fires when a capacity probe fails (error/timeout), so the
       * server can log it. Never rethrows. */
      onDecideCapacityError?: (err: unknown) => void;
      /** ADAAAA-8344: fires once per decide APP-CALL ATTEMPT with the transport
       * stages of that attempt (admission queue wait, request serialize, TTFB,
       * body read, JSON parse, bytes sent). Purely observational: it is invoked
       * after the response is handled and a throwing hook is swallowed, so it can
       * neither change a verdict nor add a retry / a billable call. Unset (the
       * default) leaves the decide path byte-identical. */
      onDecideAttempt?: (timing: DecideAttemptTiming) => void;
    } = {}
  ) {
    this.capacitySnapshot = {
      advertised: 0,
      funded: this.fundedDecideCeiling,
      effective: Math.min(this.fundedDecideCeiling, this.decideMaxAdmission),
      probeOk: false,
      runners: 0,
      source: "funded",
      cap: this.decideMaxAdmission,
    };
  }

  /**
   * Reserve a persistent perceive session.
   *   - Offchain: returns 200 immediately (no payment headers needed).
   *   - On-chain: the first reserve normally returns 402 (PaymentRequiredError).
   *     The caller attaches `paymentHeaders` (Livepeer-Payment / Livepeer-Segment
   *     from the remote signer) and retries. When already retrying with payment,
   *     a 402 again means the payment was rejected -> throw PaymentRequiredError.
   */
  async reservePerceive(opts?: { payerAddress?: string; paymentHeaders?: Record<string, string> }): Promise<ReserveResult> {
    const headers: Record<string, string> = {};
    if (opts?.payerAddress) headers["Livepeer-Payer-Address"] = opts.payerAddress;
    if (opts?.paymentHeaders) Object.assign(headers, opts.paymentHeaders);
    // Guardrail (ADAAAA-6619): retry transient `503 no capacity available for
    // runner` on the capacity-1 perceive runner with bounded backoff, mirroring
    // the `decide` single-shot retry (ADAAAA-6521). Reserving a perceive session
    // for a fresh VOD/live job was NOT retried, so a momentary slot collision
    // (a second concurrent job, or an overlapped re-reserve) failed the WHOLE
    // job at reserve time. A 503 means the request was NOT routed/processed by
    // the runner, so a retry cannot double-reserve or double-bill the session.
    let lastStatus = 0;
    for (let attempt = 0; ; attempt++) {
      const res = await this.transport.request("POST", `/apps/${ROUTES.perceive}/session`, { headers });
      if (res.status === 402) {
        // The orchestrator's 402 reserve response carries the payment challenge
        // in its BODY (liveRunnerPaymentChallengeResponse): payment_params
        // (base64 net.OrchestratorInfo) + manifest_id (AuthToken.SessionId). The
        // payer forwards these to the remote signer to obtain tickets — it does
        // NOT need to call gRPC GetOrchestrator on the orchestrator directly.
        const body = await res.json().catch(() => ({}));
        throw new PaymentRequiredError(body, livePaymentChallengeFromBody(body));
      }
      if (res.status === 503) {
        lastStatus = res.status;
        if (attempt >= 4) break;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      if (res.status !== 200) {
        throw new Error(`reserve perceive failed: HTTP ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as { session_id?: string; app_url?: string; control_url?: string; id?: string };
      return {
        sessionId: body.session_id || (body as { id?: string }).id || "",
        appUrl: body.app_url || "",
        controlUrl: body.control_url || "",
      };
    }
    throw new Error(`reserve perceive failed: HTTP ${lastStatus} no capacity available for runner`);
  }

  /** Proxy a request to the perceive runner over the persistent session. */
  async appCall<T>(
    sessionId: string,
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: any } = {}
  ): Promise<{ status: number; data: T }> {
    const method = init.method || "GET";
    const res = await this.transport.request(method, `/apps/${ROUTES.perceive}/session/${sessionId}/app/${path}`, {
      headers: init.headers,
      body: init.body,
    });
    const text = await res.text();
    let data: T = null as T;
    try {
      data = text ? JSON.parse(text) : (null as T);
    } catch {
      data = text as unknown as T;
    }
    return { status: res.status, data };
  }

  /**
   * Single-shot decide call through the orchestrator (one paid slot, released on
   * finish). On-chain (payerAddress + paymentHeaders) the first call normally
   * returns 402 (`ProxyLiveRunnerSingleShot` -> `reservePaidLiveRunnerSession` ->
   * `runnerChallenge`, same fixed-price live-runner flow as reserve): the 402
   * body carries the payment challenge (payment_params / manifest_id) the caller
   * forwards to the remote signer to obtain tickets, then retries with the
   * returned Livepeer-Payment/Livepeer-Segment. A bare decide call with no
   * `Livepeer-Payer-Address` is rejected by the orchestrator with
   * `402 invalid live runner payment signer address`.
   */
  /**
   * Serialize the capacity-1 decide runner. `runLiveJob` fires the video-leg
   * decide, the audio-leg decide (via `audioLoop`) and the
   * ST what-to-track planner **concurrently**; overlapping requests to a
   * capacity-1 runner get `HTTP 503 no capacity available for runner`, which
   * threw and failed the WHOLE live job before any highlight was persisted
   * (ADAAAA-6521). A single in-flight decide/plan request means the runner's
   * one slot is never over-subscribed, so live highlights keep flowing.
   */
  /**
   * Live decide-observer (ADAAAA-7008): on the live path the server fires this
   * single-shot decide on the ~3 s cadence (`OBSERVE_CADENCE_S`) over a
   * rolling-PAST ~10 s window (`LIVE_OBSERVE_WINDOW_S`), capped at <=30 frames
   * (`LIVE_OBSERVE_MAX_FRAMES`). Each invocation is still a single paid
   * `unit: fixed` call, so the cadence at which the SERVER calls `decide()` is
   * the only thing that changes — this client's single-shot payment mechanics
   * are unchanged. The cadence + gemma end-to-end latency is measured by the
   * server-side `LiveObserver`, not by this client.
   */
  async decide(
    path: string,
    body: unknown,
    opts?: {
      headers?: Record<string, string>;
      payerAddress?: string;
      paymentHeaders?: Record<string, string>;
      /** ADAAAA-8344: per-CALL attempt-timing sink (overrides the client-level
       * `onDecideAttempt`). Concurrency-safe: an in-flight decide carries its own
       * sink, so several streams on one client cannot cross their samples. */
      onAttempt?: (timing: DecideAttemptTiming) => void;
    }
  ): Promise<{ status: number; data: unknown }> {
    return this.decideAdmitted(path, body, opts);
  }

  /** Bounded-concurrency, capacity-aware, ORDERED gate for decide-runner app
   * calls (ADAAAA-6911 -> ADAAAA-8254).
   *
   * Pre-8254 this was a static `activeDecides < decideConcurrency` counter whose
   * overflow was absorbed by a per-request 503 retry loop: every in-flight decide
   * probed the runner on its own schedule, so a zero-capacity episode cost one
   * probe per queued request per backoff window, and the gate could not see a
   * shrunken pool. Now:
   *
   * - the ceiling is the DISCOVERED capacity clamped to [1, DECIDE_MAX_ADMISSION]
   *   (ADAAAA-8437: it sizes UP as well as down — see the section comment);
   * - waiters are one FIFO queue; a 503 opens a SHARED `pausedUntil` window that
   *   every waiter respects, and only one waiter probes per window;
   * - a waiter past its DECIDE_QUEUE_MAX_WAIT_MS budget is dropped with
   *   {@link DecideCapacityError} and counted.
   *
   * Everything below is per-client process state; the server calls
   * {@link beginDecideJob} at job start to reset the per-job counters. */
  private inFlightDecides = 0;
  private decideQueue: DecideQueueItem[] = [];
  private pumping = false;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  /** A shared pause window is open (opened by a 503 or the stall hysteresis). */
  private pauseOpen = false;
  /** Absolute deadline every queued decide waits for. */
  private pausedUntil = 0;
  /** Consecutive pause windows => exponential 500 ms .. 8 s. */
  private pauseWindow = 0;
  /** The single probe of the current pause window is in flight. */
  private probeOutstanding = false;
  /** Last advertised capacity (sum over decide runners); null = unknown. */
  private lastAdvertisedCapacity: number | null = null;
  /** ADAAAA-8262: the last probe answered (no throw / timeout). */
  private probeOk = false;
  /** ADAAAA-8262: decide runners in the last well-formed answer. */
  private lastRunnerCount = 0;
  /** ADAAAA-8262: the last well-formed answer carried a usable capacity number. */
  private lastProbeYieldedCapacity = false;
  /** Set in the constructor body: class-field initializers run before the
   * parameter properties (`this.opts`) are assigned. */
  private capacitySnapshot!: DecideCapacitySnapshot;
  private capacityProbeInFlight: Promise<void> | null = null;
  private lastCapacityProbeAt = 0;
  /** Consecutive probes where every runner reported capacity_available = 0. */
  private stallStreak = 0;
  private decideQueuedCount = 0;
  private decideDroppedCount = 0;
  private decide503Count = 0;
  private decidePausesCount = 0;
  private capacityProbeErrorCount = 0;
  /** Monotonic decide-CALL sequence (a retry reuses its call's seq). */
  private decideSeq = 0;
  /** ADAAAA-8559: the decide runners the last well-formed probe described; the
   * selection input. Empty = dark discovery / a single unnamed registration, in
   * which case routing stays on the legacy fixed id (today's behaviour). */
  private decidePool: DecideRunnerPoolEntry[] = [];
  /** ADAAAA-8559: LOCAL in-flight decides per runner id (selection input). */
  private decideRunnerInFlight = new Map<string, number>();
  /** ADAAAA-8559: when each runner was last PICKED (LRU tie-break, so a
   * sequential stream rotates over the fleet instead of pinning one worker). */
  private decideRunnerLastPick = new Map<string, number>();
  private decidePickSeq = 0;
  /** ADAAAA-8559: cumulative per-runner counters (job deltas are reported). */
  private decideRunnerStats = new Map<string, DecideRunnerStat>();
  /** ADAAAA-8559: counter snapshot at job start (see {@link beginDecideJob}). */
  private decideRunnerBaseline = new Map<string, DecideRunnerStat>();
  /** Counter baseline captured at job start; the snapshot reports the DELTA so
   * a shared client (one adapter per server process) serves each job's numbers
   * instead of zeroing a job that is still running. */
  private decideBaseline = { queued: 0, dropped: 0, s503: 0, pauses: 0, probeErrors: 0 };

  /** The FUNDED value (DECIDE_CONCURRENCY). Reporting only since ADAAAA-8437: it
   * is the fallback when discovery is dark, never a ceiling on `advertised`. */
  private get fundedDecideCeiling(): number {
    return Math.max(1, Math.floor(this.opts.decideConcurrency ?? DECIDE_FUNDED_CEILING_DEFAULT));
  }
  /** ADAAAA-8437: the safety cap on a discovered advertisement. */
  private get decideMaxAdmission(): number {
    return Math.max(1, Math.floor(this.opts.decideMaxAdmission ?? DECIDE_MAX_ADMISSION_DEFAULT));
  }
  /** What the gate admits right now: `effective` from the snapshot, re-clamped
   * to [1, cap] so a stale snapshot can never exceed the cap. */
  private get effectiveDecideCeiling(): number {
    return Math.max(1, Math.min(this.decideMaxAdmission, this.capacitySnapshot.effective));
  }
  private get decideQueueMaxWaitMs(): number {
    return Math.max(0, this.opts.decideQueueMaxWaitMs ?? DECIDE_QUEUE_MAX_WAIT_MS_DEFAULT);
  }
  private get decideCapacityRefreshMs(): number {
    return Math.max(0, this.opts.decideCapacityRefreshMs ?? DECIDE_CAPACITY_REFRESH_MS_DEFAULT);
  }

  /**
   * ADAAAA-8254: mark the start of a decide-owning job (live or VOD): capture
   * the counter baseline and kick ONE capacity refresh. The refresh is
   * deliberately fire-and-forget: a 2 s signer timeout must never delay a job's
   * first decide, and admission keeps the last known value until the probe lands.
   *
   * The baseline is a DELTA, not a reset: the server keeps one client per
   * process, so zeroing would erase a concurrent live job's counters.
   */
  beginDecideJob(): void {
    this.decideBaseline = {
      queued: this.decideQueuedCount,
      dropped: this.decideDroppedCount,
      s503: this.decide503Count,
      pauses: this.decidePausesCount,
      probeErrors: this.capacityProbeErrorCount,
    };
    // ADAAAA-8559: same DELTA convention for the per-runner attribution, and the
    // concurrency watermark is reset to the live count so `maxInFlight` reads as
    // "since this job started" on a shared client.
    this.decideRunnerBaseline = new Map(
      [...this.decideRunnerStats].map(([id, stat]) => [id, { ...stat }] as const),
    );
    for (const [id, stat] of this.decideRunnerStats) stat.maxInFlight = this.decideRunnerInFlight.get(id) ?? 0;
    void this.refreshDecideCapacity(true);
  }

  /**
   * ADAAAA-8559: which runner served this job's decides, and how hard each was
   * driven. Per-job deltas from the {@link beginDecideJob} baseline; the
   * concurrency watermark is per job start. `[]` when no decide ran yet, so a
   * record can say "not measured" instead of inventing zeros.
   */
  decideRunnerAttribution(): DecideRunnerAttribution[] {
    const out: DecideRunnerAttribution[] = [];
    for (const [runner_id, stat] of this.decideRunnerStats) {
      const base = this.decideRunnerBaseline.get(runner_id);
      const delta = (now: number, then: number | undefined): number => Math.max(0, now - (then ?? 0));
      const entry: DecideRunnerAttribution = {
        runner_id,
        tier: stat.tier,
        attempts: delta(stat.attempts, base?.attempts),
        served: delta(stat.served, base?.served),
        s503: delta(stat.s503, base?.s503),
        s404: delta(stat.s404, base?.s404),
        maxInFlight: stat.maxInFlight,
      };
      if (entry.attempts === 0 && entry.served === 0) continue;
      out.push(entry);
    }
    return out.sort(
      (a, b) => decideTierRank(a.tier) - decideTierRank(b.tier) || a.runner_id.localeCompare(b.runner_id),
    );
  }

  /** ADAAAA-8254: the per-job counters + capacity snapshot for the job record. */
  decideAdmissionMetrics(): DecideAdmissionMetrics {
    const delta = (now: number, base: number): number => Math.max(0, now - base);
    return {
      decideQueued: delta(this.decideQueuedCount, this.decideBaseline.queued),
      decideDropped: delta(this.decideDroppedCount, this.decideBaseline.dropped),
      decide503: delta(this.decide503Count, this.decideBaseline.s503),
      decidePauses: delta(this.decidePausesCount, this.decideBaseline.pauses),
      capacityProbeErrors: delta(this.capacityProbeErrorCount, this.decideBaseline.probeErrors),
      capacity: { ...this.capacitySnapshot },
      runnerAttribution: this.decideRunnerAttribution(),
    };
  }

  /**
   * ADAAAA-8254: refresh the advertised decide capacity from the configured
   * probe. Single-flight, at most once per `decideCapacityRefreshMs` unless
   * forced (job start), bounded by `decideCapacityProbeTimeoutMs`.
   *
   * NEVER throws (AC2): a rejected/timed-out probe increments
   * `capacityProbeErrors` and keeps the last known value; a probe with no usable
   * number keeps the last known then the funded ceiling; the effective ceiling
   * is never 0.
   */
  async refreshDecideCapacity(force = false): Promise<DecideCapacitySnapshot> {
    const probe = this.opts.decideCapacityProbe;
    if (!probe) return this.capacitySnapshot;
    const now = Date.now();
    if (!force && now - this.lastCapacityProbeAt < this.decideCapacityRefreshMs) return this.capacitySnapshot;
    if (this.capacityProbeInFlight) {
      await this.capacityProbeInFlight.catch(() => {});
      return this.capacitySnapshot;
    }
    this.lastCapacityProbeAt = now;
    const timeoutMs = Math.max(1, this.opts.decideCapacityProbeTimeoutMs ?? DECIDE_CAPACITY_PROBE_TIMEOUT_MS);
    const inFlight = (async () => {
      let result: DecideCapacityProbeResult | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([
          probe(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`decide capacity probe timed out after ${timeoutMs} ms`)),
              timeoutMs,
            );
          }),
        ]);
      } catch (err) {
        // Discovery error / timeout: count it, keep the last known capacity,
        // and never surface the error to a decide (AC2).
        this.capacityProbeErrorCount++;
        try {
          this.opts.onDecideCapacityError?.(err);
        } catch {
          /* the logger must not break admission either */
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (result) {
        // A well-formed answer (even an empty fleet) is PROBE OK; `runners: 0`
        // then means "no decide runner advertised", not "the probe failed".
        this.probeOk = true;
        this.lastRunnerCount = typeof result.runners === "number" && Number.isFinite(result.runners)
          ? Math.max(0, Math.floor(result.runners))
          : 0;
        this.lastProbeYieldedCapacity =
          typeof result.capacity === "number" && Number.isFinite(result.capacity);
      } else {
        // Throw / timeout / null answer: provenance stays "last-known" or "funded".
        this.probeOk = false;
        this.lastRunnerCount = 0;
        this.lastProbeYieldedCapacity = false;
      }
      if (result && typeof result.capacity === "number" && Number.isFinite(result.capacity)) {
        this.lastAdvertisedCapacity = Math.max(0, Math.floor(result.capacity));
      }
      if (result && Array.isArray(result.pool)) {
        // ADAAAA-8559: a well-formed answer replaces the selection pool. An
        // answer that carries NO `pool` field (older probe wiring) leaves the
        // last known pool in place, the same way `capacity: null` keeps the
        // last-known number; an answer with `pool: []` is a real empty fleet.
        this.decidePool = result.pool
          .filter((r) => r && typeof r.runner_id === "string" && r.runner_id.length > 0)
          .map((r) => ({
            runner_id: r.runner_id,
            capacity: typeof r.capacity === "number" && Number.isFinite(r.capacity)
              ? Math.max(0, Math.floor(r.capacity))
              : 0,
            ...(typeof r.capacity_available === "number" && Number.isFinite(r.capacity_available)
              ? { capacity_available: Math.max(0, Math.floor(r.capacity_available)) }
              : {}),
            tier: typeof r.tier === "string" && r.tier ? r.tier : "unknown",
          }));
      }
      // `capacity === null` (no usable field) is NOT zero capacity: keep the last
      // known value and fall through to the funded ceiling when there is none.
      if (result?.noneAvailable) {
        // Hysteresis: ONE zero sample is noise; two consecutive zero samples mean
        // the fleet has nothing available right now, so hold the queue (one probe
        // per backoff window) instead of admitting into a guaranteed 503.
        this.stallStreak++;
        if (this.stallStreak >= 2) this.openPauseWindow();
      } else if (result) {
        this.stallStreak = 0;
      }
      this.recomputeDecideCapacity();
    })();
    this.capacityProbeInFlight = inFlight;
    try {
      await inFlight;
    } finally {
      this.capacityProbeInFlight = null;
    }
    return this.capacitySnapshot;
  }

  private recomputeDecideCapacity(): void {
    const funded = this.fundedDecideCeiling;
    const cap = this.decideMaxAdmission;
    const advertised = this.lastAdvertisedCapacity;
    // ADAAAA-8437: the advertisement IS the ceiling (up or down), bounded only
    // by the safety cap. With discovery dark (never advertised) the funded value
    // is the fallback, exactly as before (AC7).
    const effective = Math.max(1, Math.min(cap, advertised ?? funded));
    // ADAAAA-8262: provenance only — the ceiling arithmetic above is untouched.
    const source: DecideCapacitySource =
      advertised === null ? "funded" : this.lastProbeYieldedCapacity ? "probe" : "last-known";
    const probeOk = this.probeOk;
    const runners = this.lastRunnerCount;
    const changed =
      effective !== this.capacitySnapshot.effective ||
      advertised !== this.capacitySnapshot.advertised ||
      probeOk !== this.capacitySnapshot.probeOk ||
      runners !== this.capacitySnapshot.runners ||
      source !== this.capacitySnapshot.source ||
      cap !== this.capacitySnapshot.cap;
    this.capacitySnapshot = { advertised: advertised ?? 0, funded, effective, probeOk, runners, source, cap };
    if (changed) {
      try {
        this.opts.onDecideCapacity?.({ ...this.capacitySnapshot });
      } catch {
        /* observability only */
      }
      this.pumpDecideQueue();
    }
  }

  /** Open (or advance) the SHARED pause window. Every queued decide waits on
   * `pausedUntil`; one of them probes per window. */
  private openPauseWindow(): void {
    const base = Math.max(1, this.opts.decideBackoffBaseMs ?? DECIDE_BACKOFF_BASE_MS);
    this.pauseWindow++;
    const windowMs = Math.min(base * 2 ** (this.pauseWindow - 1), DECIDE_BACKOFF_MAX_MS);
    const jitterRatio = Math.max(0, this.opts.decideBackoffJitterRatio ?? 0.25);
    this.pausedUntil = Date.now() + windowMs + windowMs * jitterRatio * Math.random();
    this.pauseOpen = true;
    this.probeOutstanding = false;
    this.decidePausesCount++;
  }

  /** A decide completed without a capacity failure: close the episode so the
   * queue returns to normal admission. */
  private noteDecideSucceeded(): void {
    if (!this.pauseOpen) return;
    this.pauseOpen = false;
    this.probeOutstanding = false;
    this.pausedUntil = 0;
    this.pauseWindow = 0;
  }

  /** A 503 `no capacity available for runner`: count it and (re)open the shared
   * pause window only when the previous window has elapsed — several in-flight
   * requests 503ing together are ONE episode, not one window each. */
  private noteDecide503(): void {
    this.decide503Count++;
    if (!this.pauseOpen || Date.now() >= this.pausedUntil) this.openPauseWindow();
    else this.probeOutstanding = false;
  }

  /** FIFO admission. Resolves with a grant when this caller may issue its
   * request; rejects with {@link DecideCapacityError} when the queue budget
   * expires. */
  private acquireDecideSlot(deadline: number, callStartedAt: number, seq: number): Promise<DecideGrant> {
    if (
      this.decideQueue.length === 0 &&
      !this.pauseOpen &&
      Date.now() >= this.pausedUntil &&
      this.inFlightDecides < this.effectiveDecideCeiling
    ) {
      this.inFlightDecides++;
      return Promise.resolve({ release: this.makeRelease(), probe: false });
    }
    return new Promise<DecideGrant>((resolve, reject) => {
      const enqueuedAt = Date.now();
      const item: DecideQueueItem = {
        resolve,
        reject,
        settled: false,
        enqueuedAt,
        seq,
        timer: setTimeout(() => {
          if (item.settled) return;
          item.settled = true;
          const idx = this.decideQueue.indexOf(item);
          if (idx >= 0) this.decideQueue.splice(idx, 1);
          this.decideDroppedCount++;
          reject(
            new DecideCapacityError(Date.now() - callStartedAt, this.decideQueueMaxWaitMs, "queue wait exceeded"),
          );
          this.pumpDecideQueue();
        }, Math.max(0, deadline - enqueuedAt)),
      };
      // FIFO by request order: a retried decide keeps its original position in
      // front of requests that arrived after it (insertion sort on `seq`).
      let at = this.decideQueue.length;
      while (at > 0 && this.decideQueue[at - 1].seq > seq) at--;
      this.decideQueue.splice(at, 0, item);
      this.decideQueuedCount++;
      this.pumpDecideQueue();
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.inFlightDecides > 0) this.inFlightDecides--;
      this.pumpDecideQueue();
    };
  }

  private schedulePump(delayMs: number): void {
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pumpDecideQueue();
    }, Math.max(0, delayMs));
  }

  private clearPumpTimer(): void {
    if (!this.pumpTimer) return;
    clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
  }

  /**
   * Grant the queue in FIFO order, honoring the shared pause window.
   *
   * - Paused and before the deadline: schedule one wake-up at the deadline; no
   *   admission (so N queued decides cost ZERO probes during the window).
   * - Paused at/after the deadline: exactly ONE probe is granted per window
   *   (AC3: <= ceil(episode / window) + 1 probes, never N per window).
   * - Not paused: normal bounded admission up to the effective ceiling.
   */
  private pumpDecideQueue(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const head = this.decideQueue[0];
        if (!head) {
          this.clearPumpTimer();
          return;
        }
        if (head.settled) {
          this.decideQueue.shift();
          continue;
        }
        const now = Date.now();
        if (now < this.pausedUntil) {
          this.schedulePump(this.pausedUntil - now);
          return;
        }
        if (this.pauseOpen) {
          if (this.probeOutstanding || this.inFlightDecides > 0) return;
          this.decideQueue.shift();
          head.settled = true;
          clearTimeout(head.timer);
          this.probeOutstanding = true;
          this.inFlightDecides++;
          head.resolve({ release: this.makeRelease(), probe: true });
          return;
        }
        if (this.inFlightDecides >= this.effectiveDecideCeiling) return;
        this.decideQueue.shift();
        head.settled = true;
        clearTimeout(head.timer);
        this.inFlightDecides++;
        head.resolve({ release: this.makeRelease(), probe: false });
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * ADAAAA-8559: pick the runner for this attempt.
   *
   * - Empty pool (dark discovery, or a single registration whose route the
   *   advertisement did not carry): the legacy fixed `highlights-decide` id and
   *   today's retry-on-same-id behaviour — byte-identical to pre-8559, which the
   *   current suite pins (ADAAAA-8559 AC4).
   * - Otherwise: never a runner this CALL already tried, preferring `tier=5090`
   *   over `x99-fallback`, then least LOCAL in-flight, then wider capacity. The
   *   pick and its counter bump are synchronous, so two attempts admitted in the
   *   same tick cannot both pick the same idle runner.
   *
   * Returns null when every runner in a non-empty pool has been tried: the call
   * is out of hops and must fail with the typed/untyped error rather than
   * hammering one id.
   */
  private selectDecideRunner(tried: ReadonlySet<string>): string | null {
    if (this.decidePool.length === 0) {
      // Single-registration fallback: one fixed id and today's retry-on-same-id
      // behaviour (the current suite pins exactly that).
      return ROUTES.decide;
    }
    let best: DecideRunnerPoolEntry | null = null;
    for (const r of this.decidePool) {
      if (tried.has(r.runner_id)) continue;
      if (best === null || this.compareRunnerRank(r, best) < 0) best = r;
    }
    return best ? best.runner_id : null;
  }

  /** ADAAAA-8559: tier preference first, then least local in-flight, then the
   * least-recently PICKED runner (so sequential decisions rotate across the fleet
   * — AC4 requires all three 5090s to serve, not just the first), then the wider
   * advertised capacity, then the id (deterministic). */
  private compareRunnerRank(a: DecideRunnerPoolEntry, b: DecideRunnerPoolEntry): number {
    const tier = decideTierRank(a.tier) - decideTierRank(b.tier);
    if (tier !== 0) return tier;
    const inFlight =
      (this.decideRunnerInFlight.get(a.runner_id) ?? 0) - (this.decideRunnerInFlight.get(b.runner_id) ?? 0);
    if (inFlight !== 0) return inFlight;
    const lastPick =
      (this.decideRunnerLastPick.get(a.runner_id) ?? -1) - (this.decideRunnerLastPick.get(b.runner_id) ?? -1);
    if (lastPick !== 0) return lastPick;
    const capacity = b.capacity - a.capacity;
    if (capacity !== 0) return capacity;
    return a.runner_id.localeCompare(b.runner_id);
  }

  /** ADAAAA-8559: the single-shot decide route. The runner id IS the route
   * segment; with an empty pool it is the legacy aggregate id. */
  private decidePath(runnerId: string, path: string): string {
    return `/apps/${encodeURIComponent(runnerId)}/app/${path}`;
  }

  /** ADAAAA-8559: the runner's attribution record (created on first use). */
  private runnerStat(runnerId: string): DecideRunnerStat {
    const tier =
      this.decidePool.find((r) => r.runner_id === runnerId)?.tier ??
      (runnerId === ROUTES.decide ? "legacy-single" : "unknown");
    let stat = this.decideRunnerStats.get(runnerId);
    if (!stat) {
      stat = { tier, attempts: 0, served: 0, s503: 0, s404: 0, maxInFlight: 0 };
      this.decideRunnerStats.set(runnerId, stat);
    } else {
      stat.tier = tier;
    }
    return stat;
  }

  /** ADAAAA-8559: take this attempt's place in the runner's local in-flight
   * count and return that count (1 = exclusive). */
  private enterRunner(runnerId: string): number {
    const inFlight = (this.decideRunnerInFlight.get(runnerId) ?? 0) + 1;
    this.decideRunnerInFlight.set(runnerId, inFlight);
    const stat = this.runnerStat(runnerId);
    stat.attempts++;
    stat.maxInFlight = Math.max(stat.maxInFlight, inFlight);
    return inFlight;
  }

  /** ADAAAA-8559: hand the runner slot back (idempotent, never below 0). */
  private leaveRunner(runnerId: string): void {
    const inFlight = this.decideRunnerInFlight.get(runnerId) ?? 0;
    if (inFlight > 0) this.decideRunnerInFlight.set(runnerId, inFlight - 1);
  }

  /**
   * ADAAAA-8254: issue one decide app-call through the admission queue.
   *
   * Each attempt takes a queue slot, issues the request, and releases the slot
   * before deciding whether to retry — so a 503'd attempt goes back to the tail
   * of the FIFO queue and waits on the shared pause instead of sleeping inside
   * its slot (that was the per-request probe fan-out this ticket removes).
   *
   * Two transients stay retryable — and as of ADAAAA-8559 they HOP:
   *   - `503 no capacity available for runner` — a capacity episode. The shared
   *     pause window paces every waiter; retries are exhausted -> typed
   *     {@link DecideCapacityError} + `decideDropped`, which the live rail logs
   *     and continues from rather than aborting the job (AC4).
   *   - `404 runner not found` / `404 runner session not found` / `404 session
   *     not found` — the orchestrator briefly unregisters the runner during its
   *     ~2 s `/health` flap (ADAAAA-6521 follow-up) or released the session on
   *     a restart (ADAAAA-6623). A 404 means the request was NOT routed /
   *     processed, so a retry cannot double-bill or double-persist a highlight.
   *     This path keeps the ADAAAA-6709 exponential backoff 500 ms -> 8 s.
   *
   * ADAAAA-8559: both retryable transients now move to the NEXT runner in the
   * discovered pool (excluding the ids this call already posted to) instead of
   * re-posting the same id, bounded by the unchanged attempt budget and by the
   * pool size. The admission queue, the shared 503 pause window and the typed
   * error semantics are untouched.
   */
  private async decideAdmitted(
    path: string,
    body: unknown,
    opts?: {
      headers?: Record<string, string>;
      payerAddress?: string;
      paymentHeaders?: Record<string, string>;
      onAttempt?: (timing: DecideAttemptTiming) => void;
    }
  ): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts?.headers || {}) };
    if (opts?.payerAddress) headers["Livepeer-Payer-Address"] = opts.payerAddress;
    if (opts?.paymentHeaders) Object.assign(headers, opts.paymentHeaders);
    const maxAttempts = Math.max(1, Math.floor(this.opts.decideMaxAttempts ?? 5)); // 1 initial call + 4 retries
    const backoffBaseMs = Math.max(1, this.opts.decideBackoffBaseMs ?? DECIDE_BACKOFF_BASE_MS);
    const callStartedAt = Date.now();
    const deadline = callStartedAt + this.decideQueueMaxWaitMs;
    // ADAAAA-8254: one sequence per CALL (not per attempt) so a retry keeps its
    // FIFO position instead of queueing behind newer windows.
    const seq = this.decideSeq++;
    let lastStatus = 0;
    // ADAAAA-8559: runners this CALL already posted to. A 503/404 hops to the
    // next untried runner instead of retrying the same id; a hop is bounded by
    // the unchanged attempt budget AND by the pool size.
    const tried = new Set<string>();
    let poolExhausted = false;
    for (let attempt = 0; ; attempt++) {
      const attemptStart = Date.now();
      // ADAAAA-8254: refresh the advertised capacity on the decide path too, at
      // most every DECIDE_CAPACITY_REFRESH_S. NEVER awaited: a slow signer cannot
      // add latency and a failing one cannot throw into decide (AC2).
      if (Date.now() - this.lastCapacityProbeAt >= this.decideCapacityRefreshMs) {
        void this.refreshDecideCapacity();
      }
      const grant = await this.acquireDecideSlot(deadline, callStartedAt, seq);
      // ADAAAA-8559: select INSIDE the granted slot, and bump the runner's local
      // in-flight count synchronously with the pick, so two attempts admitted in
      // the same tick cannot both choose the same idle runner.
      const runnerId = this.selectDecideRunner(tried);
      if (runnerId === null) {
        // Every runner in a non-empty pool has been tried: no hop left.
        if (grant.probe) this.probeOutstanding = false;
        grant.release();
        poolExhausted = true;
        break;
      }
      tried.add(runnerId);
      // LRU tie-break input: a sequential stream rotates over the fleet.
      this.decideRunnerLastPick.set(runnerId, this.decidePickSeq++);
      const runnerInFlight = this.enterRunner(runnerId);
      const runnerTier = this.runnerStat(runnerId).tier;
      // ADAAAA-8344: per-attempt transport stages. Every clock read is a plain
      // `Date.now()` around work the client already does, so the decide path is
      // byte-identical and the hook is the only addition.
      const queueMs = Date.now() - attemptStart;
      let retryable = false;
      try {
        const tSerialize = Date.now();
        const bodyText = JSON.stringify(body);
        const serializeMs = Date.now() - tSerialize;
        const sentBytes = bodyText.length ? Buffer.byteLength(bodyText, "utf8") : 0;
        let ttfbMs = 0;
        let bodyMs = 0;
        let parseMs = 0;
        // Emit the attempt's stages exactly once, whichever way it settles
        // (200/402/503/404/transport throw). A throwing hook is swallowed: the
        // instrumentation can never fail or retry a decide.
        const sink = opts?.onAttempt ?? this.opts.onDecideAttempt;
        const noteAttempt = (status: number): void => {
          if (!sink) return;
          try {
            sink({
              attempt,
              status,
              queueMs,
              serializeMs,
              sentBytes,
              ttfbMs,
              bodyMs,
              parseMs,
              // ADAAAA-8559: which runner this attempt went to, and how many
              // local decides were in flight on it (AC4 attribution).
              runnerId,
              runnerTier,
              runnerInFlight,
            });
          } catch {
            /* instrumentation must never fail a decide */
          }
        };
        const tRequest = Date.now();
        let res: Awaited<ReturnType<Transport["request"]>>;
        try {
          // ADAAAA-8559: the attempt posts to the SELECTED runner id, which is
          // the orchestrator route segment. Only the pre-probe fallback uses the
          // retired aggregate id (see selectDecideRunner).
          res = await this.transport.request("POST", this.decidePath(runnerId, path), {
            headers,
            body: bodyText,
          });
        } catch (e) {
          // Network/TLS failure: recorded as a transport error, then rethrown so
          // the decide path behaves exactly as before.
          ttfbMs = Date.now() - tRequest;
          noteAttempt(0);
          throw e;
        }
        // fetch() resolves when the response HEADERS arrive, so this delta IS
        // the request's time-to-first-byte (send + orchestrator admission +
        // runner dispatch + model prefill start).
        ttfbMs = Date.now() - tRequest;
        // Read the body up front: needed both to detect the transient
        // "runner not found" / "session not found" 404 and to parse the 402
        // payment challenge, and to drain the socket on retried transients.
        const tBody = Date.now();
        const text = await res.text().catch(() => "");
        bodyMs = Date.now() - tBody;
        const runnerNotFound = res.status === 404 && /(runner not found|session not found)/i.test(text);
        if (res.status !== 503 && !runnerNotFound) {
          if (res.status === 402) {
            let body2: unknown = {};
            const tParse = Date.now();
            try {
              body2 = text ? JSON.parse(text) : {};
            } catch {
              body2 = {};
            }
            parseMs = Date.now() - tParse;
            noteAttempt(res.status);
            throw new PaymentRequiredError(body2, livePaymentChallengeFromBody(body2));
          }
          // A completed call proves the runner has capacity: close any pause.
          this.noteDecideSucceeded();
          let data: unknown = null;
          const tParse = Date.now();
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = text;
          }
          parseMs = Date.now() - tParse;
          // ADAAAA-8559: this runner served (and billed) the decide.
          this.runnerStat(runnerId).served++;
          noteAttempt(res.status);
          return { status: res.status, data };
        }
        lastStatus = res.status;
        if (res.status === 503) {
          this.noteDecide503();
          this.runnerStat(runnerId).s503++;
        } else {
          this.runnerStat(runnerId).s404++;
        }
        retryable = true;
        noteAttempt(res.status);
      } finally {
        // Clear the single-flight probe marker before handing the slot back so
        // the next window can grant its own probe (or normal admission).
        if (grant.probe) this.probeOutstanding = false;
        // ADAAAA-8559: release the runner's local slot before the admission slot.
        this.leaveRunner(runnerId);
        grant.release();
      }
      if (!retryable) break;
      if (attempt >= maxAttempts - 1) break;
      // ADAAAA-8559: a 503/404 HOPS to the next untried runner on the next
      // iteration (selectDecideRunner excludes `tried`). A 503 is paced by the
      // shared pause (the next acquire waits on it); a 404 keeps its own
      // exponential backoff so a flapping runner is not hammered.
      if (lastStatus !== 503) {
        await new Promise((r) => setTimeout(r, Math.min(backoffBaseMs * 2 ** attempt, DECIDE_BACKOFF_MAX_MS)));
      }
    }
    if (lastStatus === 503) {
      // AC4: the decide is honestly lost, counted, and typed so the live rail
      // can log it and keep the job running instead of failing the stream.
      this.decideDroppedCount++;
      throw new DecideCapacityError(
        Date.now() - callStartedAt,
        this.decideQueueMaxWaitMs,
        `decide runner unavailable after ${maxAttempts} attempts over ${tried.size} runner(s) (503 no capacity)`,
      );
    }
    const detail = "runner not found / session not found (lost decide runner)";
    throw new Error(
      `decide runner unavailable after ${maxAttempts} attempts over ${tried.size} runner(s)` +
        `${poolExhausted ? " (decide pool exhausted)" : ""} (last HTTP ${lastStatus}: ${detail})`,
    );
  }

  /**
   * Submit a single-shot fine-tune job to the highlights-train runner
   * (`POST /apps/highlights-train/app/{path}`). Same fixed-price live-runner
   * flow as `decide`: offchain 200 immediately; on-chain the first call 402s
   * with a payment challenge (payment_params / manifest_id) the caller forwards
   * to the remote signer for tickets, then retries with the returned
   * Livepeer-Payment/Livepeer-Segment. The train entrypoint reads the run inputs
   * (TRAIN_MANIFEST / TRAIN_VAL / epochs / batch size / lr) from the submitted
   * payload and blocks until the job finishes, returning the checkpoint + eval
   * report in the 200 body.
   */
  async train(
    path: string,
    body: unknown,
    opts?: { headers?: Record<string, string>; payerAddress?: string; paymentHeaders?: Record<string, string> }
  ): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts?.headers || {}) };
    if (opts?.payerAddress) headers["Livepeer-Payer-Address"] = opts.payerAddress;
    if (opts?.paymentHeaders) Object.assign(headers, opts.paymentHeaders);
    const res = await this.transport.request("POST", `/apps/${ROUTES.train}/app/${path}`, {
      headers,
      body: JSON.stringify(body),
    });
    if (res.status === 402) {
      const body2 = await res.json().catch(() => ({}));
      throw new PaymentRequiredError(body2, livePaymentChallengeFromBody(body2));
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data };
  }

  /** Stop a persistent perceive session. */
  async stopPerceive(sessionId: string): Promise<void> {
    const res = await this.transport.request("POST", `/apps/${ROUTES.perceive}/session/${sessionId}/stop`, {});
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
      throw new Error(`stop perceive failed: HTTP ${res.status}`);
    }
  }

  /**
   * Re-obtain fresh OrchestratorInfo for an EXISTING live-runner session so the
   * payer can keep re-funding it. go-livepeer's remote signer returns HTTP 480
   * ("refresh session for remote signer", remote_signer.go shouldRefreshSession)
   * once the OrchestratorInfo's auth token / ticket params expire; the payer
   * must mint fresh info for the SAME session (same manifest/session id) and
   * re-sign. POST /refresh-payment (rpc.go RefreshPayment) returns a fresh
   * challenge whose manifest_id equals the session's original manifest, so the
   * session is preserved (ADAAAA-6575).
   */
  async refreshPaymentSession(
    sender: string,
    manifestID: string
  ): Promise<{ paymentParams?: string; manifestId?: string; orchestrator?: string }> {
    const res = await this.transport.request("POST", "/refresh-payment", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender, manifest_id: manifestID }),
    });
    if (res.status !== 200) {
      throw new Error(`refresh payment session failed: HTTP ${res.status}`);
    }
    // `/refresh-payment` (and `/payment`) return the challenge in the SAME
    // snake_case shape as the 402 reserve body (`liveRunnerPaymentChallengeResponse`:
    // `payment_params`, `manifest_id`, `orchestrator`). We previously cast to
    // camelCase (`paymentParams`), so the fresh OrchestratorInfo was always
    // `undefined` and the 480 recovery re-threw the 480 — leaving the perceive
    // session to drain into a force-release (~every 9m45s). Reuse
    // `livePaymentChallengeFromBody` so the field mapping stays in one place
    // (ADAAAA-6575).
    const body = (await res.json()) as Record<string, unknown>;
    const challenge = livePaymentChallengeFromBody(body);
    return {
      paymentParams: challenge?.paymentParams,
      manifestId: challenge?.manifestId ?? manifestID,
      orchestrator: typeof body?.orchestrator === "string" ? (body.orchestrator as string) : undefined,
    };
  }

  /**
   * Interval payment refresh. No-op offchain (sessions are unpaid); no-op when
   * no signer. `orchInfoB64` is the base64 protobuf of the orchestrator's
   * `net.OrchestratorInfo` the signer needs to (re)issue a ticket; `signerState`
   * is the opaque signed state blob from the previous payment (null on first);
   * `manifestID` must equal the orchestrator's AuthToken.SessionId (else the
   * orchestrator returns `403 mismatched manifest and auth token`).
   *
   * On HTTP 480 from the signer (session needs a refresh so it can keep issuing
   * fresh tickets), mints fresh OrchestratorInfo via `/refresh-payment` and
   * re-signs once with it, so the reserved balance keeps topping up past the
   * auth-token / ticket-params expiry instead of draining into a force-release
   * (ADAAAA-6575). Returns the updated signerState AND the (possibly refreshed)
   * orchestrator info so the caller persists the freshest one for the next tick.
   */
  async refreshPerceivePayment(
    sessionId: string,
    controlUrl: string,
    signer?: SignerClient,
    orchInfoB64?: string,
    signerState?: RemotePaymentStateSig | null,
    manifestID?: string,
    payerAddress?: string
  ): Promise<{ signerState: unknown; orchInfoB64: string } | null> {
    if (!signer) return null;
    if (!orchInfoB64) throw new Error("payment refresh requires orchestrator info (orchInfoB64)");
    const doSign = async (infoB64: string, refreshed = false) => {
      let paid: LivePayment;
      try {
        paid = await signer.generateLivePayment(infoB64, signerState ?? null, {
          // The signer validates `state.App == req.App` on every refresh (remote
          // signer `GenerateLivePayment`): omitting `app` sends "" and the signer
          // rejects with `400 app mismatch` once state has been established by the
          // paid reserve (which set app=ROUTES.perceive). Keep it stable.
          app: ROUTES.perceive,
          type: "live",
          manifestID,
        });
      } catch (err) {
        // A 480 from the signer means its session's OrchestratorInfo auth-token /
        // ticket-params expired and it wants a session refresh (fresh info), not a
        // new payment. Let the caller re-mint info and retry (ADAAAA-6575).
        if (isSessionRefreshError(err) && payerAddress && manifestID) {
          const fresh = await this.refreshPaymentSession(payerAddress, manifestID);
          if (fresh?.paymentParams) return await doSign(fresh.paymentParams, true);
        }
        // 482 = "no new tickets needed": the signer's committed reserve already
        // covers the orchestrator's minimum credit for the billable window, so
        // there is genuinely nothing new to POST to the orchestrator this tick.
        // This is an EXPECTED state (a long-lived session sits in it most of the
        // time), not a payment failure — treat it as a benign no-op so the
        // refresher does not misclassify an already-funded session as a broken
        // one and spam `payment refresh failed` (ADAAAA-6588). BUT (ADAAAA-6609)
        // the signer's 482 body now carries the re-signed, fee-accounted state;
        // persist it so the next tick sees the DRAINED balance and the signer
        // mints a refill before the orchestrator's reserved balance reaches the
        // fee trough. We deliberately do NOT POST a new payment here.
        if (isNoTicketsError(err)) {
          const drained = (err as Error & { signerState?: RemotePaymentStateSig | null }).signerState;
          return { signerState: drained ?? signerState ?? null, orchInfoB64: infoB64 };
        }
        // 481 = "orchestrator price exceeds ceiling": the signer refuses to mint
        // above `maxPricePerUnit`; the session is already funded at the agreed
        // price, so a refresh that would exceed the ceiling is also a benign no-op
        // rather than a fatal payment failure (ADAAAA-6588).
        if (isPriceExceededError(err)) return null;
        throw err;
      }
      const res = await this.transport.request("POST", `${controlUrl}/payment`, {
        headers: { "Livepeer-Payment": paid.payment, "Livepeer-Segment": paid.segCreds },
      });
      // ADAAAA-6993: the orchestrator rejects a ticket minted against EXPIRED
      // payment params with HTTP 400 `TicketParams expired`. That is a recoverable
      // refresh signal (mirrors the signer-480 recovery above), not a fatal
      // payment failure: re-mint fresh OrchestratorInfo for the SAME session via
      // /refresh-payment, re-sign the ticket against the fresh params, and retry
      // the /payment POST once. Never reuse the stale `infoB64`. Give the
      // orchestrator time to cycle its params with a short backoff (distinct from
      // the benign 480/481/482 cases, which need no orchestrator round-trip).
      if (res.status === 400) {
        const bodyText = await res.text().catch(() => "");
        if (isTicketParamsExpiredText(bodyText)) {
          // Recoverable (never reuse the stale info): re-mint fresh OrchestratorInfo,
          // re-sign, and retry /payment ONCE. If we have already recovered (refreshed)
          // or cannot re-mint, give up WITHOUT looping and surface the expired signal
          // so the caller can classify it.
          if (!refreshed && payerAddress && manifestID) {
            const fresh = await this.refreshPaymentSession(payerAddress, manifestID);
            if (fresh?.paymentParams) {
              await sleep(this.opts.ticketParamsRetryBackoffMs ?? 1500);
              return await doSign(fresh.paymentParams, true);
            }
          }
          throw new Error(`payment refresh failed: HTTP 400 TicketParams expired`);
        }
      }
      if (res.status >= 400) throw new Error(`payment refresh failed: HTTP ${res.status}`);
      return { signerState: paid.signerState, orchInfoB64: infoB64 };
    };
    return await doSign(orchInfoB64);
  }
}

/** True when the remote signer asks the payer to refresh the session (HTTP 480).
 * Exported so the server's VOD/live FRESH-reserve path (which signs with a null
 * prior state) can detect a stale-signer 480 and recover the same way
 * `refreshPerceivePayment` does, instead of failing the job (ADAAAA-6705). */
export function isSessionRefreshError(err: unknown): boolean {
  return err instanceof Error && /\bHTTP 480\b/.test(err.message);
}

/** True when the signer reports "no new tickets needed" (HTTP 482) — a benign,
 * expected state for a long-lived session whose committed reserve already
 * covers the orchestrator's minimum credit (ADAAAA-6588). */
function isNoTicketsError(err: unknown): boolean {
  return err instanceof Error && /\bHTTP 482\b/.test(err.message);
}

/** True when the signer rejects a price above the configured ceiling (HTTP 481).
 * The session is already funded at the agreed price, so this is benign on a
 * refresh (ADAAAA-6588). */
function isPriceExceededError(err: unknown): boolean {
  return err instanceof Error && /\bHTTP 481\b/.test(err.message);
}

/** True when an orchestrator error body says the ticket params expired (HTTP
 * 400 `TicketParams expired`). The ticket the signer minted against the stale
 * OrchestratorInfo was rejected, so the payer must re-mint fresh info AND
 * re-sign before retrying — never reuse the stale info. Exported so the
 * server's single-shot decide/plan/train payer can detect the same signal and
 * recover instead of failing the job (ADAAAA-6993). */
export function isTicketParamsExpiredText(body: unknown): boolean {
  return typeof body === "string" && /TicketParams expired/.test(body);
}

/** Short pre-retry backoff so the orchestrator has time to cycle its payment
 * params after an expired-params rejection (ADAAAA-6993). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
