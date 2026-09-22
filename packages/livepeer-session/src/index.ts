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
  decide: "highlights-decide",
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
    private transport: Transport = new HttpTransport(base)
  ) {}

  async discover(caps: string[]): Promise<{ address: string; runners: DiscoveredRunner[] }[]> {
    const qs = caps.map((c) => `caps=${encodeURIComponent(c)}`).join("&");
    const res = await this.transport.request("GET", `/discover-orchestrators${qs ? `?${qs}` : ""}`, {});
    if (res.status !== 200) throw new Error(`signer discover failed: HTTP ${res.status}`);
    return (await res.json()) as { address: string; runners: DiscoveredRunner[] }[];
  }

  async signOrchInfo(address: string): Promise<unknown> {
    const res = await this.transport.request("POST", "/sign-orchestrator-info", {
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (res.status !== 200) throw new Error(`signer generateLivePayment failed: HTTP ${res.status}`);
    const parsed = (await res.json()) as RemotePaymentResponse;
    return {
      payment: parsed.payment,
      segCreds: parsed.segCreds ?? "",
      signerState: parsed.state ?? null,
    };
  }
}

export class LivepeerClient {
  constructor(
    public readonly orchBase: string,
    private transport: Transport = new HttpTransport(orchBase)
  ) {}

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
  async decide(
    path: string,
    body: unknown,
    opts?: { headers?: Record<string, string>; payerAddress?: string; paymentHeaders?: Record<string, string> }
  ): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts?.headers || {}) };
    if (opts?.payerAddress) headers["Livepeer-Payer-Address"] = opts.payerAddress;
    if (opts?.paymentHeaders) Object.assign(headers, opts.paymentHeaders);
    const res = await this.transport.request("POST", `/apps/${ROUTES.decide}/app/${path}`, {
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
   * Interval payment refresh. No-op offchain (sessions are unpaid); no-op when
   * no signer. `orchInfoB64` is the base64 protobuf of the orchestrator's
   * `net.OrchestratorInfo` the signer needs to (re)issue a ticket; `signerState`
   * is the opaque signed state blob from the previous payment (null on first);
   * `manifestID` must equal the orchestrator's AuthToken.SessionId (else the
   * orchestrator returns `403 mismatched manifest and auth token`).
   */
  async refreshPerceivePayment(
    sessionId: string,
    controlUrl: string,
    signer?: SignerClient,
    orchInfoB64?: string,
    signerState?: RemotePaymentStateSig | null,
    manifestID?: string
  ): Promise<unknown> {
    if (!signer) return null;
    if (!orchInfoB64) throw new Error("payment refresh requires orchestrator info (orchInfoB64)");
    const paid = await signer.generateLivePayment(orchInfoB64, signerState ?? null, {
      // The signer validates `state.App == req.App` on every refresh (remote
      // signer `GenerateLivePayment`): omitting `app` sends "" and the signer
      // rejects with `400 app mismatch` once state has been established by the
      // paid reserve (which set app=ROUTES.perceive). Keep it stable.
      app: ROUTES.perceive,
      type: "live",
      manifestID,
    });
    const res = await this.transport.request("POST", `${controlUrl}/payment`, {
      headers: { "Livepeer-Payment": paid.payment, "Livepeer-Segment": paid.segCreds },
    });
    if (res.status >= 400) throw new Error(`payment refresh failed: HTTP ${res.status}`);
    return paid.signerState;
  }
}
