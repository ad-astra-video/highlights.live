// Maps the LivepeerClient (orchestrator proxy) and a direct-dev transport onto
// the PipelineClient interface the analyzer needs.
import { readFile } from "node:fs/promises";
import {
  HttpSignerClient,
  LivepeerClient,
  PaymentRequiredError,
  type RemotePaymentStateSig,
  type SignerClient,
} from "@highlights/livepeer-session";
import type { ServerConfig } from "./config";
import { createPaymentRefresher, type PaymentRefresher } from "./payment";
import type { DecisionResult, ObservationResult, PipelineClient, ReserveResult } from "./analyzer";

export function buildAnalyzeFrames(frameDir: string, sampleFps = 1) {
  // Frames are extracted by extractFrames() at `sampleFps`. This iterates them
  // in order, stamping the real time position (seq / sampleFps) so clip cutting
  // and decide land on accurate timestamps even when sampling is adaptively
  // slowed to match the card.
  return async function* (): AsyncGenerator<{ seq: number; timestamp: number; imageB64: string }> {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(frameDir)).filter((f) => f.startsWith("frame_")).sort();
    let seq = 0;
    for (const f of files) {
      const b64 = (await readFile(`${frameDir}/${f}`)).toString("base64");
      yield { seq, timestamp: seq / sampleFps, imageB64: b64 };
      seq++;
    }
  };
}

export interface PaidOrchestratorOptions {
  /** Remote signer used to generate Livepeer-Payment on 402 (on-chain only). */
  signer?: SignerClient;
  /** Payer EVM address advertised on the reserve (on-chain only). */
  payerAddress?: string;
  /** Payment-refresh interval in ms (default 10_000). */
  paymentIntervalMs?: number;
}

export class OrchestratorAdapter implements PipelineClient {
  private client: LivepeerClient;
  private signer?: SignerClient;
  private payerAddress?: string;
  private paymentIntervalMs: number;
  private app = "highlights-perceive";
  /** Per-session payment refreshers (on-chain only). */
  private payers = new Map<string, PaymentRefresher>();

  constructor(cfg: ServerConfig, opts: PaidOrchestratorOptions = {}) {
    this.client = new LivepeerClient(cfg.orchestratorUrl);
    this.signer = opts.signer;
    this.payerAddress = opts.payerAddress;
    this.paymentIntervalMs = opts.paymentIntervalMs ?? 10_000;
  }

  /**
   * Reserve a perceive session. On-chain (signer + payerAddress configured)
   * the first reserve returns 402 with a payment challenge; we take
   * `payment_params` (base64 OrchestratorInfo) + `manifest_id` from the 402
   * body, forward them to the remote signer for tickets, and retry the reserve
   * with the returned Livepeer-Payment/Livepeer-Segment, then start an interval
   * refiller so the session stays funded for the whole VOD job. Offchain (no
   * signer) this is exactly the old unpaid path.
   */
  async reservePerceive(): Promise<ReserveResult> {
    const payerAddress = this.payerAddress;
    let signerState: RemotePaymentStateSig | null | undefined;
    let orchInfo: { b64?: string; sessionId?: string } | undefined;
    let r: { sessionId: string; appUrl: string; controlUrl: string };
    try {
      const res = await this.client.reservePerceive(payerAddress ? { payerAddress } : undefined);
      r = { sessionId: res.sessionId, appUrl: res.appUrl, controlUrl: res.controlUrl };
    } catch (err) {
      if (!(err instanceof PaymentRequiredError) || !this.signer || !payerAddress) throw err;
      // 402 on-chain: source the orchestrator info the orchestrator put in the
      // challenge itself (`payment_params` = base64 net.OrchestratorInfo,
      // `manifest_id` = AuthToken.SessionId) and forward it to the remote signer.
      const b64 = err.challenge?.paymentParams;
      if (!b64) {
        throw new Error(
          "on-chain 402 challenge carried no payment_params (orchestrator info) to forward to the signer; cannot obtain tickets"
        );
      }
      const manifestID = err.challenge?.manifestId;
      // go-livepeer requires manifestID == orchestrator AuthToken.SessionId
      // (the 402 challenge's manifest_id), else reserve returns
      // `403 mismatched manifest and auth token`.
      const pmt = await this.signer.generateLivePayment(b64, null, {
        app: this.app,
        type: "live",
        manifestID: manifestID || undefined,
      });
      signerState = pmt.signerState;
      orchInfo = { b64, sessionId: manifestID };
      const res = await this.client.reservePerceive({
        payerAddress,
        paymentHeaders: { "Livepeer-Payment": pmt.payment, "Livepeer-Segment": pmt.segCreds },
      });
      r = { sessionId: res.sessionId, appUrl: res.appUrl, controlUrl: res.controlUrl };
    }
    // Pay the orchestrator for as long as the session stays open (on-chain only).
    if (this.signer && payerAddress) this.startPayment(r, orchInfo, signerState);
    return r;
  }

  /** Interval refresher for a paid session; mirrors the media server's payer. */
  private startPayment(
    p: ReserveResult,
    orchInfo?: { b64?: string; sessionId?: string },
    paymentState?: RemotePaymentStateSig | null
  ): void {
    const signer = this.signer;
    if (!signer || !orchInfo?.b64) return;
    if (this.payers.has(p.sessionId)) return;
    let signerState: RemotePaymentStateSig | null | undefined = paymentState;
    const refresh = async () => {
      const next = await this.client.refreshPerceivePayment(
        p.sessionId,
        p.controlUrl,
        signer,
        orchInfo.b64,
        signerState,
        orchInfo.sessionId
      );
      if (next !== undefined && next !== null) signerState = next as RemotePaymentStateSig;
    };
    const ref = createPaymentRefresher({
      refresh,
      intervalMs: this.paymentIntervalMs,
      onFailure: (e) => {
        console.error(`[adapter] payment refresh failed for session ${p.sessionId}: ${e?.message}`);
      },
    });
    this.payers.set(p.sessionId, ref);
    ref.start();
  }
  async analyze(sessionId: string, frame: { seq: number; timestamp: number; imageB64: string }): Promise<ObservationResult> {
    const { status, data } = await this.client.appCall<any>(sessionId, "analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seq: frame.seq,
        timestamp: frame.timestamp,
        image: frame.imageB64,
        clip_path: frame.clipPath || "",  // per-JOB recorded stream (SAM persistent session)
      }),
    });
    if (status >= 400) throw new Error(`analyze failed: HTTP ${status}`);
    return normalizeObservation(data);
  }
  async decide(
    evidence: { eventType: string; trackCount: number; maxVelocity: number; ocrHits: number },
    opts?: { gameHint?: string; imageB64?: string; reasoningEffort?: string }
  ): Promise<DecisionResult> {
    const { status, data } = await this.client.decide("highlight", {
      sessionId: "job",
      eventType: evidence.eventType,
      timestamp: 0,
      gameHint: opts?.gameHint || "",
      reasoningEffort: opts?.reasoningEffort || "none",
      evidence,
      images: opts?.imageB64 ? [{ role: "full", base64: opts.imageB64 }] : [],
    });
    if (status >= 400) throw new Error(`decide failed: HTTP ${status}`);
    return data as DecisionResult;
  }
  async stopPerceive(sessionId: string): Promise<void> {
    // Stop paying for the session before releasing it (idempotent; no-op
    // offchain where there is no refresher).
    const ref = this.payers.get(sessionId);
    if (ref) {
      ref.stop();
      this.payers.delete(sessionId);
    }
    await this.client.stopPerceive(sessionId);
  }
}

export class DirectAdapter implements PipelineClient {
  constructor(private cfg: ServerConfig) {}
  private fakeSession = "local-dev";
  async reservePerceive(): Promise<ReserveResult> {
    return { sessionId: this.fakeSession, appUrl: "", controlUrl: "" };
  }
  async analyze(sessionId: string, frame: { seq: number; timestamp: number; imageB64: string }): Promise<ObservationResult> {
    const r = await fetch(`${this.cfg.perceiveUrl}/app/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": this.fakeSession },
      body: JSON.stringify({
        seq: frame.seq,
        timestamp: frame.timestamp,
        image: frame.imageB64,
        clip_path: frame.clipPath || "",
      }),
    });
    if (!r.ok) throw new Error(`analyze failed: HTTP ${r.status}`);
    return normalizeObservation(await r.json());
  }
  async decide(
    evidence: { eventType: string; trackCount: number; maxVelocity: number; ocrHits: number },
    opts?: { gameHint?: string; imageB64?: string; reasoningEffort?: string }
  ): Promise<DecisionResult> {
    const r = await fetch(`${this.cfg.decideUrl}/app/highlight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: this.fakeSession,
        eventType: evidence.eventType,
        timestamp: 0,
        gameHint: opts?.gameHint || "",
        reasoningEffort: opts?.reasoningEffort || "none",
        evidence,
        images: opts?.imageB64 ? [{ role: "full", base64: opts.imageB64 }] : [],
      }),
    });
    if (!r.ok) throw new Error(`decide failed: HTTP ${r.status}`);
    return (await r.json()) as DecisionResult;
  }
  async stopPerceive(): Promise<void> {
    await fetch(`${this.cfg.perceiveUrl}/app/session/close`, {
      method: "POST",
      headers: { "X-Session-Id": this.fakeSession },
    }).catch(() => {});
  }
}

function normalizeObservation(body: any): ObservationResult {
  if (body && body.candidate) {
    return { observation: body.observation, candidate: body.candidate };
  }
  return { observation: body };
}

export function makeAdapter(cfg: ServerConfig): PipelineClient {
  if (cfg.perceiveUrl && cfg.decideUrl) return new DirectAdapter(cfg);
  // On-chain: wire the remote signer + payer address so VOD submissions can pay
  // the orchestrator (mirrors the live media-server payer). Offchain (no signer)
  // this is the old unpaid path and the orchestrator never 402s.
  const signer = cfg.signerUrl ? new HttpSignerClient(cfg.signerUrl) : undefined;
  return new OrchestratorAdapter(cfg, { signer, payerAddress: cfg.payerAddress });
}
