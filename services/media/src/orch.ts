// Media-server -> orchestrator client.
//
// The media server is the PAYER / broadcaster for a perceived live stream: it
// reserves the perceive live-runner session on the orchestrator, opens the
// runner's trickle channels, then publishes video-in frames and reads
// events-out observations back. The receive runner itself subscribes video-in
// (its media loop) and publishes events-out — the exact contract verified
// e2e on the .6 orchestrator.
//
// This mirrors the proven go-livepeer flow:
//   1. reserve /apps/{app}/session                   -> session_id, app_url, control_url
//   2. POST {app_url}/app/analyze (seed frame)       -> runner opens its trickle channels
//   3. GET  {app_url}/app/session/stats              -> trickle.video_in / events_out / control
//   4. POST {video_in}/{seq}  (jpeg bytes)           -> publish one frame
//   5. GET  {events_out}/{seq}                       -> read the observation
//   6. POST /apps/{app}/session/{sid}/stop           -> release the paid slot
//
// PAYMENT (on-chain): the media server NEVER dials the orchestrator for
// OrchestratorInfo. Confirmed against go-livepeer v0.9.2
// (server/ai_http.go `runnerChallenge` + server/remote_signer.go
// `GenerateLivePayment`):
//   1. Reserve -> the orchestrator answers 402 with a challenge BODY carrying
//      `payment_params` (base64 net.OrchestratorInfo) + `manifest_id`
//      (AuthToken.SessionId).
//   2. The media server takes THOSE parts of the 402 response and forwards
//      them to the REMOTE SIGNER's `/generate-live-payment`.
//   3. The signer (the only ETH holder) returns Livepeer-Payment /
//      Livepeer-Segment; the media server retries the reserve with them.
// The SIGNER's `/discover-orchestrators` is the source for WHICH orchestrator /
// live-runner to start the session against (resolveOrchBase below).
import {
  LivepeerClient,
  PaymentRequiredError,
  type DiscoveredRunner,
  type RemotePaymentStateSig,
  type SignerClient,
} from "@highlights/livepeer-session";
import { createPaymentRefresher, type PaymentRefresher } from "./payments";

export interface ProvisionedSession {
  sessionId: string;
  appUrl: string;
  controlUrl: string;
  videoIn: string;
  eventsOut: string;
  control: string;
  /**
   * On-chain only: the signer state (ticket nonce/round) established when the
   * paid reserve succeeded. Seeded into the payment refresher on startPayment
   * so the ongoing ticket refresh continues from the same sequence (not from a
   * fresh/higher nonce that the orchestrator would reject). Undefined offchain.
   */
  paymentState?: RemotePaymentStateSig | null;
  /**
   * On-chain only: base64 protobuf of the orchestrator's `net.OrchestratorInfo`
   * taken from the 402 challenge's `payment_params`. go-livepeer REQUIRES it in
   * every `/generate-live-payment` call (missing -> 400), so the refresher
   * needs it too. Undefined offchain.
   */
  orchInfoB64?: string;
  /**
   * On-chain only: the orchestrator's AuthToken.SessionId (the 402 challenge's
   * `manifest_id`). go-livepeer requires the payment `manifestID` to equal
   * this, so the refresher passes it on every refresh. Undefined offchain.
   */
  orchInfoSessionId?: string;
}

export interface MediaOrchOptions {
  /** Orchestrator public URL (offchain lab) or gateway URL. Used as the
   *  session-start base when `discoverOrchestrators` yields nothing (offchain
   *  / discovery unavailable). */
  orchBase: string;
  /** Headers to attach to the reserve (e.g. Livepeer-Payment) when on-chain. */
  paymentHeaders?: Record<string, string>;
  /** Tiny seed JPEG (base64) sent to /app/analyze so the runner opens channels. */
  seedImageB64?: string;
  /** Remote signer (on-chain payment). When absent the session is unpaid (offchain lab). */
  signer?: SignerClient;
  /** Payer address advertised on reserve (on-chain). */
  payerAddress?: string;
  /**
   * On-chain: resolve WHICH orchestrator / live-runner to start the session
   * against from the signer's `/discover-orchestrators` instead of a static
   * orchBase. Returns the discovery payload ({address, runners}[]); this client
   * picks the entry advertising the perceive runner (fallback: first entry) and
   * uses its `address` as the reserve base. Falls back to `orchBase` when
   * discovery returns nothing or throws. Offchain (no signer) it is never
   * invoked.
   */
  discoverOrchestrators?: () => Promise<{ address: string; runners: DiscoveredRunner[] }[]>;
  /** Interval between payment refreshes (default 10s). */
  paymentIntervalMs?: number;
  /** Called when a payment refresh fails — the payer stops + releases the slot. */
  onPaymentFailure?: (sessionId: string, err: Error) => void;
}

/**
 * Talks to the go-livepeer orchestrator like the broadcaster. Uses the shared
 * @highlights/livepeer-session LivepeerClient for reserve and raw fetch for
 * publish/subscribe (no pooled-stream complexity — these are fire-and-read
 * HTTP calls, not long-lived subscribers).
 */
export class MediaOrchestrator {
  private opts: Required<Pick<MediaOrchOptions, "seedImageB64">> & MediaOrchOptions;
  private orchBase: string;
  private payers = new Map<string, PaymentRefresher>();
  private app = "highlights-perceive";

  constructor(opts: MediaOrchOptions) {
    this.orchBase = opts.orchBase.replace(/\/$/, "");
    this.opts = {
      seedImageB64: opts.seedImageB64 ?? "",
      ...opts,
    };
  }

  /** A LivepeerClient bound to a specific orchestrator base (reserve only). */
  private _client(base: string): LivepeerClient {
    return new LivepeerClient(
      base,
      {
        request: (method: string, url: string, init: { headers?: Record<string, string>; body?: any } = {}) =>
          this._req(method, url, init, base),
      } as any
    );
  }

  private async _req(
    method: string,
    url: string,
    init: { headers?: Record<string, string>; body?: any } = {},
    base: string = this.orchBase
  ) {
    const res = await fetch(new URL(url, base).toString(), {
      method,
      headers: init.headers as Record<string, string>,
      body: init.body,
    });
    return {
      status: res.status,
      async json() { try { return await res.json(); } catch { return null; } },
      async text() { return res.text(); },
    };
  }

  /**
   * Resolve the orchestrator base URL for the session start. When a signer /
   * discovery is configured, ask the signer's `/discover-orchestrators` which
   * orchestrator + live-runner to use and prefer an entry advertising the
   * perceive runner; otherwise (offchain / discovery empty / discovery error)
   * fall back to the configured `orchBase`.
   */
  private async resolveOrchBase(): Promise<string> {
    const discover = this.opts.discoverOrchestrators;
    if (!discover) return this.orchBase;
    try {
      const list = await discover();
      if (Array.isArray(list) && list.length) {
        const withPerceive = list.find((o) => o.runners?.some((r) => r.app === this.app));
        const chosen = withPerceive ?? list[0];
        if (chosen?.address) return chosen.address.replace(/\/$/, "");
      }
    } catch {
      /* discovery unavailable — fall back to configured orchBase */
    }
    return this.orchBase;
  }

  /**
   * Reserve + open the perceive session's trickle channels.
   * On-chain the first reserve usually returns 402 with a challenge body: we
   * take `payment_params` (base64 OrchestratorInfo) + `manifest_id` from the
   * 402 response, forward them to the remote signer for tickets, and retry the
   * reserve with the returned Livepeer-Payment/Livepeer-Segment. Offchain (no
   * signer, orchestrator never 402s) this path is a no-op and behaves exactly
   * as before.
   */
  async provision(opts?: { seedImageB64?: string }): Promise<ProvisionedSession> {
    const base = await this.resolveOrchBase();
    const client = this._client(base);
    let signerState: RemotePaymentStateSig | null | undefined;
    /** Orchestrator info + session id sourced from the 402 challenge. */
    let orchInfo: { b64?: string; sessionId?: string } | undefined;
    let res;
    try {
      res = await client.reservePerceive(
        this.opts.payerAddress ? { payerAddress: this.opts.payerAddress } : undefined
      );
    } catch (err) {
      if (!(err instanceof PaymentRequiredError) || !this.opts.signer) throw err;
      // 402 on-chain: take the orchestrator info the orchestrator itself put in
      // the challenge body (`payment_params` = base64 net.OrchestratorInfo,
      // `manifest_id` = AuthToken.SessionId) and forward it to the remote
      // signer. go-livepeer REQUIRES the `orchestrator` field; a null/old wire
      // shape -> 400 and the session reserve fails. The media server does NOT
      // dial GetOrchestratorInfo on the orchestrator directly.
      const b64 = err.challenge?.paymentParams;
      if (!b64) {
        throw new Error(
          "on-chain 402 challenge carried no payment_params (orchestrator info) to forward to the signer; cannot obtain tickets"
        );
      }
      const manifestID = err.challenge?.manifestId;
      const pmt = await this.opts.signer.generateLivePayment(b64, null, {
        app: this.app,
        type: "live",
        // go-livepeer requires manifestID == orchestrator AuthToken.SessionId
        // (the 402 challenge's manifest_id), else the reserve returns
        // `403 mismatched manifest and auth token`.
        manifestID: manifestID || undefined,
      });
      signerState = pmt.signerState;
      orchInfo = { b64, sessionId: manifestID };
      // Retry WITH the payment headers; a second 402 here means the orchestrator
      // rejected the payment -> reservePerceive throws PaymentRequiredError.
      res = await client.reservePerceive({
        payerAddress: this.opts.payerAddress,
        paymentHeaders: { "Livepeer-Payment": pmt.payment, "Livepeer-Segment": pmt.segCreds },
      });
    }
    const { sessionId, appUrl, controlUrl } = res;
    if (!sessionId) throw new Error("reserve returned no session_id");

    // Seed analyze -> the perceive runner opens its trickle channels.
    const seed = opts?.seedImageB64 ?? this.opts.seedImageB64;
    await this.safeAnalyze(appUrl, sessionId, seed);

    // Read the channel URLs the runner created.
    const stats = await this._req("GET", `${appUrl}/app/session/stats`, {});
    const body: any = await stats.json();
    const t = body?.trickle;
    if (!t?.video_in || !t?.events_out) {
      throw new Error(`open channels failed: no trickle endpoints in stats: ${JSON.stringify(body)}`);
    }
    const p: ProvisionedSession = {
      sessionId,
      appUrl,
      controlUrl,
      videoIn: t.video_in,
      eventsOut: t.events_out,
      control: t.control || "",
      paymentState: signerState,
      orchInfoB64: orchInfo?.b64,
      orchInfoSessionId: orchInfo?.sessionId,
    };
    return p;
  }

  /** Seed the runner so it opens channels; tolerate the (expected) bad-image error
   * when an empty/absent seed is used — opening channels is all we need here. */
  private async safeAnalyze(appUrl: string, sessionId: string, seed: string) {
    try {
      await this._req("POST", `${appUrl}/app/analyze`, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seq: 0, timestamp: 0.0, image: seed }),
      });
    } catch {
      /* ignore — the runner opens channels regardless */
    }
  }

  /** Publish one JPEG frame to the session's video-in channel. */
  async publishFrame(p: ProvisionedSession, seq: number, jpeg: Uint8Array, timestamp: number): Promise<number> {
    const r = await this._req("POST", `${p.videoIn.replace(/\/$/, "")}/${seq}`, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Lp-Trickle-Timestamp": timestamp.toFixed(3),
      },
      body: jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength),
    });
    return r.status;
  }

  /** Read the observation the runner published to events-out at `seq`.
   * Returns parsed JSON or null when no data at that seq yet. */
  async readObservation(p: ProvisionedSession, seq: number): Promise<any | null> {
    const r = await this._req("GET", `${p.eventsOut.replace(/\/$/, "")}/${seq}`, {});
    if (r.status !== 200) return null;
    return r.json();
  }

  /**
   * Release the paid slot / perceive session. Posts `{controlUrl}/stop` so it
   * targets the SAME orchestrator that issued the session (correct in both the
   * offchain-lab and discovered-orchestrator worlds, where `orchBase` config
   * may differ from the orchestrator actually running the session).
   */
  async closeSession(controlUrl: string): Promise<void> {
    if (!controlUrl) return;
    await this._req("POST", `${controlUrl.replace(/\/$/, "")}/stop`, {}).catch(() => {});
  }

  /**
   * Pay the orchestrator for the session for as long as it stays open. No-op
   * offchain (no signer). On-chain it starts an interval refiller on the
   * session's controlUrl; a failed refresh calls onPaymentFailure (the caller
   * closes the stream). Idempotent per session.
   */
  startPayment(p: ProvisionedSession): void {
    const signer = this.opts.signer;
    if (!signer) return; // offchain lab: sessions are unpaid
    if (this.payers.has(p.sessionId)) return;
    // Continue the ticket sequence from the state the paid reserve established
    // (not a fresh/higher nonce, which the orchestrator would reject).
    let signerState: RemotePaymentStateSig | null = p.paymentState ?? null;
    const orchInfoB64: string | undefined = p.orchInfoB64;
    const manifestID: string | undefined = p.orchInfoSessionId;
    if (!orchInfoB64) {
      throw new Error(
        "startPayment requires orchestrator info (orchInfoB64) from a paid reserve's 402 challenge"
      );
    }
    const refresh = async () => {
      const next = await this.clientFor(p.controlUrl).refreshPerceivePayment(
        p.sessionId,
        p.controlUrl,
        signer,
        orchInfoB64,
        signerState,
        manifestID
      );
      if (next !== undefined && next !== null) signerState = next as RemotePaymentStateSig;
    };
    const ref = createPaymentRefresher({
      refresh,
      intervalMs: this.opts.paymentIntervalMs ?? 10_000,
      onFailure: this.opts.onPaymentFailure
        ? (e) => this.opts.onPaymentFailure!(p.sessionId, e)
        : undefined,
    });
    this.payers.set(p.sessionId, ref);
    ref.start();
  }

  /** LivepeerClient bound to an absolute controlUrl's origin (payment refresh). */
  private clientFor(controlUrl: string): LivepeerClient {
    return this._client(controlUrl);
  }

  /** Stop paying (settle) for a session. Idempotent. */
  stopPayment(sessionId: string): void {
    const ref = this.payers.get(sessionId);
    if (!ref) return;
    ref.stop();
    this.payers.delete(sessionId);
  }
}
