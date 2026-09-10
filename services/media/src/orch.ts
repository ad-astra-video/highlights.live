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
//   5. GET  {events_out}/{seq}                       -> read the observation (specific seq returns
//                                                       stored data; -1 streams forever)
//   6. POST /apps/{app}/session/{sid}/stop           -> release the paid slot
import { LivepeerClient, type SignerClient } from "@highlights/livepeer-session";
import { createPaymentRefresher, type PaymentRefresher } from "./payments";

export interface ProvisionedSession {
  sessionId: string;
  appUrl: string;
  controlUrl: string;
  videoIn: string;
  eventsOut: string;
  control: string;
}

export interface MediaOrchOptions {
  orchBase: string; // orchestrator public URL (offchain lab) or gateway URL
  /** Headers to attach to the reserve (e.g. Livepeer-Payment) when on-chain. */
  paymentHeaders?: Record<string, string>;
  /** Tiny seed JPEG (base64) sent to /app/analyze so the runner opens channels. */
  seedImageB64?: string;
  /** TLS reject for self-signed orchestrator (offchain lab boxes). */
  rejectUnauthorized?: boolean;
  /** Remote signer (on-chain payment). When absent the session is unpaid (offchain lab). */
  signer?: SignerClient;
  /** Payer address advertised on reserve (on-chain). */
  payerAddress?: string;
  /** Interval between payment refreshes (default 10s). */
  paymentIntervalMs?: number;
  /** Called when a payment refresh fails — the payer stops + releases the slot. */
  onPaymentFailure?: (sessionId: string, err: Error) => void;
}

/**
 * Talks to the go-livepeer orchestrator like the broadcaster. Uses the shared
 * @highlights/livepeer-session LivepeerClient for reserve/stop and raw fetch
 * for publish/subscribe (no pooled-stream complexity — these are fire-and-read
 * HTTP calls, not long-lived subscribers).
 */
export class MediaOrchestrator {
  private client: LivepeerClient;
  private opts: Required<Pick<MediaOrchOptions, "seedImageB64" | "rejectUnauthorized" | "paymentHeaders">> & MediaOrchOptions;
  private orchBase: string;
  private payers = new Map<string, PaymentRefresher>();
  private app = "highlights-perceive";

  constructor(opts: MediaOrchOptions) {
    this.orchBase = opts.orchBase.replace(/\/$/, "");
    this.opts = {
      paymentHeaders: opts.paymentHeaders ?? {},
      seedImageB64: opts.seedImageB64 ?? "",
      rejectUnauthorized: opts.rejectUnauthorized ?? false,
      ...opts,
    };
    this.client = new LivepeerClient(this.orchBase, {
      request: (method: string, url: string, init: { headers?: Record<string, string>; body?: any } = {}) =>
        this._req(method, url, init),
    } as any);
  }

  private async _req(method: string, url: string, init: { headers?: Record<string, string>; body?: any } = {}) {
    const res = await fetch(new URL(url, this.orchBase).toString(), {
      method,
      headers: init.headers as Record<string, string>,
      body: init.body,
    });
    return {
      status: res.status,
      headers: res.headers,
      async json() { try { return await res.json(); } catch { return null; } },
      async text() { return res.text(); },
    };
  }

  /** Reserve + open the perceive session's trickle channels. */
  async provision(opts?: { seedImageB64?: string }): Promise<ProvisionedSession> {
    const res = await this.client.reservePerceive(
      this.opts.payerAddress ? { payerAddress: this.opts.payerAddress } : undefined
    );
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
    return {
      sessionId,
      appUrl,
      controlUrl,
      videoIn: t.video_in,
      eventsOut: t.events_out,
      control: t.control || "",
    };
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

  /** Release the paid slot / perceive session. */
  async closeSession(sessionId: string): Promise<void> {
    await this.client.stopPerceive(sessionId).catch(() => {});
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
    let signerState: unknown;
    const refresh = async () => {
      const next = await this.client.refreshPerceivePayment(p.sessionId, p.controlUrl, signer, signerState);
      if (next !== undefined && next !== null) signerState = next;
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

  /** Stop paying (settle) for a session. Idempotent. */
  stopPayment(sessionId: string): void {
    const ref = this.payers.get(sessionId);
    if (!ref) return;
    ref.stop();
    this.payers.delete(sessionId);
  }
}
