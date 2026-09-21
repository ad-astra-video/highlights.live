
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
import {
  LivepeerClient,
  NoTicketsError,
  PaymentRequiredError,
  RefreshSessionError,
  type RemotePaymentStateSig,
  type SignerClient,
} from "@highlights/livepeer-session";
import { createPaymentRefresher, type PaymentRefresher } from "./payments";
import type { OrchInfoProvider, OrchInfoResult } from "./orch-info";

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
   * On-chain only: the base64 protobuf of the orchestrator's
   * `net.OrchestratorInfo` used for the payment. go-livepeer REQUIRES it in
   * every `/generate-live-payment` call (missing -> 400), so the refresher
   * needs it too. Undefined offchain.
   */
  orchInfoB64?: string;
  /**
   * On-chain only: the orchestrator's AuthToken.SessionId (from
   * GetOrchestratorInfo). go-livepeer requires the payment `manifestID` to
   * equal this, so the refresher passes it on every refresh. Undefined offchain.
   */
  orchInfoSessionId?: string;
}

/**
 * Default live-stream pixel rate (pixels/sec) used to size each top-up ticket,
 * matching go-livepeer's `defaultSegInfo` (1280x720x30, `NewLV2VPaymentProcessor`)
 * — the pixels the orchestrator bills per second of stream time. The orchestrator
 * bills inPixels × pricePerUnit/pixelsPerUnit, so sizing to this window's burn
 * keeps the prepaid balance from draining between refreshes. Override via
 * `streamPixelsPerSec` (MEDIA_STREAM_PIXELS_PER_SEC) when the actual resolution
 * is known, to avoid chronic over/under-funding.
 */
export const DEFAULT_STREAM_PIXELS_PER_SEC = 1280 * 720 * 30;

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
  /**
   * Async provider for the orchestrator's base64 `net.OrchestratorInfo`
   * protobuf (fetched via GetOrchestratorInfo). REQUIRED for the on-chain paid
   * path: go-livepeer rejects a `/generate-live-payment` with no `orchestrator`
   * field (400 missing orchestrator). Cached after the first resolve.
   */
  orchInfoProvider?: OrchInfoProvider;
  /** Interval between payment refreshes (default 10s; overridden by the
   *  orchestrator's announced `paymentIntervalMs` when present). */
  paymentIntervalMs?: number;
  /**
   * Live-stream pixel rate (pixels/sec) used to size each top-up ticket. When
   * absent, uses go-livepeer's defaultSegInfo (1280x720x30). Set to the actual
   * broadcast resolution×fps to avoid chronic over/under-funding.
   */
  streamPixelsPerSec?: number;
  /** Called when a payment refresh fails — the payer stops + releases the slot.
   *  NOT invoked for a benign 482 "no payment needed". */
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
  private orchInfoCached?: OrchInfoResult;

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

  /**
   * Effective payment cadence: the orchestrator's announced session payment
   * interval when present, else the configured `paymentIntervalMs` (default
   * 10s). Matching the orchestrator's charge cadence means each ticket is
   * sized to exactly one billing window, so the prepaid balance never drains
   * between refreshes.
   */
  private paymentIntervalMs(): number {
    if (this.orchInfoCached?.paymentIntervalMs != null) {
      return this.orchInfoCached.paymentIntervalMs;
    }
    return this.opts.paymentIntervalMs ?? 10_000;
  }

  /**
   * Size the top-up ticket to the pixels the orchestrator will bill in the next
   * window: stream pixel rate × (one payment interval in seconds). Mirrors
   * go-livepeer `unitsSinceLastProcessed = units × seconds`.
   */
  private sizeTopUpPixels(intervalMs: number): number {
    const pxPerSec = this.opts.streamPixelsPerSec ?? DEFAULT_STREAM_PIXELS_PER_SEC;
    return Math.max(1, Math.round((pxPerSec * intervalMs) / 1000));
  }

  /**
   * Resolve (and cache) the orchestrator's base64 `net.OrchestratorInfo`
   * protobuf needed for on-chain payment. The orchestrator's info (including
   * its signed TicketParams) can only come from GetOrchestratorInfo on the
   * orchestrator — it cannot be fabricated by the payer — so the caller must
   * supply an `orchInfoProvider`.
   */
  private async resolveOrchInfo(force = false): Promise<OrchInfoResult> {
    if (!force && this.orchInfoCached) return this.orchInfoCached;
    const provider = this.opts.orchInfoProvider;
    if (!provider) {
      throw new Error(
        "on-chain reserve requires orchInfoProvider (fetch orchestrator GetOrchestratorInfo)"
      );
    }
    const result = await provider(force);
    if (!result?.b64) throw new Error("orchInfoProvider returned empty orchestrator info");
    this.orchInfoCached = result;
    return result;
  }

  /**
   * Generate a live payment from the remote signer. On a 480 (auth token inside
   * the orchestrator info expired) go-livepeer expects the payer to re-fetch
   * fresh GetOrchestratorInfo (new auth token) and retry — it is NOT fatal.
   * We do exactly that: invalidate the orchestrator-info cache, re-resolve, and
   * retry once with the fresh token (and the fresh manifestID).
   */
  private async generateLivePaymentOrRefresh(): Promise<{
    pmt: import("@highlights/livepeer-session").LivePayment;
    orchInfo: OrchInfoResult;
  }> {
    const orchInfo = await this.resolveOrchInfo();
    // Size the (first) ticket to one payment window so the reserve doesn't
    // under-fund the session before the refresher takes over.
    const inPixels = this.sizeTopUpPixels(this.paymentIntervalMs());
    const request = (info: OrchInfoResult) =>
      this.opts.signer!.generateLivePayment(info.b64, null, {
        app: this.app,
        type: "live",
        manifestID: info.sessionId || undefined,
        inPixels,
      });
    try {
      const pmt = await request(orchInfo);
      return { pmt, orchInfo };
    } catch (err) {
      if (!(err instanceof RefreshSessionError) || !this.opts.signer) throw err;
      // Auth token expired — refresh the orchestrator info and retry once.
      const fresh = await this.resolveOrchInfo(true);
      const pmt = await request(fresh);
      return { pmt, orchInfo: fresh };
    }
  }

  /**
   * Reserve + open the perceive session's trickle channels.
   * On-chain the first reserve usually returns 402 (PaymentRequiredError): we
   * pull Livepeer-Payment/Livepeer-Segment from the remote signer and retry the
   * reserve with them. Offchain (no signer, orchestrator never 402s) this path
   * is a no-op and behaves exactly as before.
   */
  async provision(opts?: { seedImageB64?: string }): Promise<ProvisionedSession> {
    let signerState: RemotePaymentStateSig | null | undefined;
    let res;
    try {
      res = await this.client.reservePerceive(
        this.opts.payerAddress ? { payerAddress: this.opts.payerAddress } : undefined
      );
    } catch (err) {
      if (!(err instanceof PaymentRequiredError) || !this.opts.signer) throw err;
      // 402 on-chain: obtain the orchestrator's net.OrchestratorInfo protobuf
      // (base64) and ask the remote signer for a real payment ticket. go-livepeer
      // REQUIRES the `orchestrator` field; a null/old wire shape -> 400 and the
      // session reserve fails with "signer generateLivePayment failed: HTTP 400".
      // A 480 (expired auth token) is handled inside — re-fetch + retry once.
      const { pmt, orchInfo } = await this.generateLivePaymentOrRefresh();
      signerState = pmt.signerState;
      this.orchInfoCached = orchInfo;
      // Retry WITH the payment headers; a second 402 here means the orchestrator
      // rejected the payment -> reservePerceive throws PaymentRequiredError.
      res = await this.client.reservePerceive({
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
      orchInfoB64: this.orchInfoCached?.b64,
      orchInfoSessionId: this.orchInfoCached?.sessionId,
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

  /** Release the paid slot / perceive session. */
  async closeSession(sessionId: string): Promise<void> {
    await this.client.stopPerceive(sessionId).catch(() => {});
  }

  /**
   * Pay the orchestrator for the session for as long as it stays open. No-op
   * offchain (no signer). On-chain it starts an interval refiller on the
   * session's controlUrl; a failed refresh calls onPaymentFailure (the caller
   * closes the stream). A benign 482 ("no payment needed") does NOT fail the
   * session — the loop just waits for the next window. Idempotent per session.
   */
  async startPayment(p: ProvisionedSession): Promise<void> {
    const signer = this.opts.signer;
    if (!signer) return; // offchain lab: sessions are unpaid
    if (this.payers.has(p.sessionId)) return;
    // Resolve (cached) orch info up-front so the cadence reflects the
    // orchestrator's announced payment interval when it publishes one; a
    // failure here falls back to the configured/default interval.
    await this.resolveOrchInfo().catch(() => {});
    const intervalMs = this.paymentIntervalMs();
    // Continue the ticket sequence from the state the paid reserve established
    // (not a fresh/higher nonce, which the orchestrator would reject).
    let signerState: RemotePaymentStateSig | null = p.paymentState ?? null;
    // Resolve the latest cached orch info each tick; a prior 480 refresh updates
    // the cache so subsequent ticks carry the fresh auth token + manifestID. Each
    // top-up is sized to the pixels burned in one payment window so the prepaid
    // balance never drains between refreshes.
    const refresh = async () => {
      const inPixels = this.sizeTopUpPixels(this.paymentIntervalMs());
      let orchInfo = await this.resolveOrchInfo();
      try {
        const next = await this.client.refreshPerceivePayment(
          p.sessionId,
          p.controlUrl,
          signer,
          orchInfo.b64,
          signerState,
          orchInfo.sessionId || undefined,
          inPixels
        );
        if (next !== undefined && next !== null) signerState = next as RemotePaymentStateSig;
      } catch (err) {
        if (err instanceof NoTicketsError) {
          // 482: signer says no top-up is needed this cycle (reserved balance
          // still covers the minimum). BENIGN — continue the session, do NOT
          // tear it down. Wait for the next window to re-check.
          return;
        }
        if (!(err instanceof RefreshSessionError)) throw err;
        // Auth token expired mid-session — refresh the orchestrator info (new
        // auth token) and retry once, like go-livepeer.
        orchInfo = await this.resolveOrchInfo(true);
        const next = await this.client.refreshPerceivePayment(
          p.sessionId,
          p.controlUrl,
          signer,
          orchInfo.b64,
          signerState,
          orchInfo.sessionId || undefined,
          inPixels
        );
        if (next !== undefined && next !== null) signerState = next as RemotePaymentStateSig;
      }
    };
    const ref = createPaymentRefresher({
      refresh,
      intervalMs,
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