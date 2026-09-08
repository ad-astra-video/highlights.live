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

export interface GeneratePaymentResult {
  payment: string; // Livepeer-Payment header value
  segCreds: string; // Livepeer-Segment header value
  signerState: unknown;
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
  signerState: unknown;
}

export interface SignerClient {
  /** Signer GET /discover-orchestrators?caps=... */
  discover(caps: string[]): Promise<{ address: string; runners: DiscoveredRunner[] }[]>;
  /** Signer POST /sign-orchestrator-info for a given orchestrator address */
  signOrchInfo(address: string): Promise<unknown>;
  /** Signer POST /generate-live-payment -> payment headers + state */
  generateLivePayment(orchInfo: unknown, prevState: unknown): Promise<GeneratePaymentResult>;
}

// --- Errors -----------------------------------------------------------------

export class PaymentRequiredError extends Error {
  constructor(public paymentParams: unknown) {
    super("402 Payment Required: reserve needs signer payment material");
  }
}

export class NotAuthorizedError extends Error {
  constructor(msg = "401: unauthorized") {
    super(msg);
  }
}

// --- Transport ---------------------------------------------------------------

export interface Transport {
  request(method: string, url: string, init?: { headers?: Record<string, string>; body?: BodyInit }): Promise<{
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
  async request(method: string, url: string, init: { headers?: Record<string, string>; body?: BodyInit } = {}) {
    const headers = { ...(init.headers || {}) };
    const res = await fetch(new URL(url, this.base).toString(), {
      method,
      headers,
      body: init.body,
      // @ts-expect-error node-specific
      ...(process.env.NODE_ENV === "test" ? {} : { dispatcher: undefined }),
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

  async generateLivePayment(orchInfo: unknown, prevState: unknown): Promise<LivePayment> {
    const res = await this.transport.request("POST", "/generate-live-payment", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orchInfo, prevState }),
    });
    if (res.status !== 200) throw new Error(`signer generateLivePayment failed: HTTP ${res.status}`);
    return (await res.json()) as LivePayment;
  }
}

export class LivepeerClient {
  constructor(
    public readonly orchBase: string,
    private transport: Transport = new HttpTransport(orchBase)
  ) {}

  /** Reserve a persistent perceive session. On-chain: throws PaymentRequiredError on 402. */
  async reservePerceive(opts?: { payerAddress?: string }): Promise<ReserveResult> {
    const headers: Record<string, string> = {};
    if (opts?.payerAddress) headers["Livepeer-Payer-Address"] = opts.payerAddress;
    const res = await this.transport.request("POST", `/apps/${ROUTES.perceive}/session`, { headers });
    if (res.status === 402) {
      throw new PaymentRequiredError(await res.json().catch(() => ({})));
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
    init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {}
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

  /** Single-shot decide call through the orchestrator (one paid slot, released on finish). */
  async decide(
    path: string,
    body: unknown,
    opts?: { headers?: Record<string, string> }
  ): Promise<{ status: number; data: unknown }> {
    const res = await this.transport.request("POST", `/apps/${ROUTES.decide}/app/${path}`, {
      headers: { "Content-Type": "application/json", ...(opts?.headers || {}) },
      body: JSON.stringify(body),
    });
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

  /** Interval payment refresh. No-op offchain (sessions are unpaid); no-op when no signer. */
  async refreshPerceivePayment(sessionId: string, controlUrl: string, signer?: SignerClient, signerState?: unknown): Promise<unknown> {
    if (!signer) return null;
    const paid = await signer.generateLivePayment(null, signerState);
    const res = await this.transport.request("POST", `${controlUrl}/payment`, {
      headers: { "Livepeer-Payment": paid.payment, "Livepeer-Segment": paid.segCreds },
    });
    if (res.status >= 400) throw new Error(`payment refresh failed: HTTP ${res.status}`);
    return paid.signerState;
  }
}
