// Maps the LivepeerClient (orchestrator proxy) and a direct-dev transport onto
// the PipelineClient interface the analyzer needs.
import { readFile } from "node:fs/promises";
import {
  HttpSignerClient,
  LivepeerClient,
  PaymentRequiredError,
  ROUTES,
  type RemotePaymentStateSig,
  type SignerClient,
} from "@highlights/livepeer-session";
import type { ServerConfig } from "./config";
import { createPaymentRefresher, type PaymentRefresher } from "./payment";
import type { AudioChunk, DecisionResult, ObservationResult, PipelineClient, ReserveResult } from "./analyzer";
import { SessionLostError } from "./analyzer";

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
      // ADAAAA-3250: never strand a live perceive session's funding. A refresh
      // failure (e.g. the benign go-livepeer 482 "no new tickets needed", or a
      // transient network blip) must NOT permanently stop the loop, or the
      // session's signer-state LastUpdate goes stale and the next payment bills
      // the whole backlog in one batch (numTickets > 100 cap -> 400), killing
      // the VOD job. Keep the cadence and retry so LastUpdate stays fresh.
      retryOnFailure: true,
      onFailure: (e) => {
        console.error(`[adapter] payment refresh failed for session ${p.sessionId}: ${e?.message}`);
      },
    });
    this.payers.set(p.sessionId, ref);
    ref.start();
  }
  async analyze(
    sessionId: string,
    frame: { seq: number; timestamp: number; imageB64: string },
    opts?: { gameHint?: string; preferLabels?: string[] }
  ): Promise<ObservationResult> {
    const { status, data } = await this.client.appCall<any>(sessionId, "analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seq: frame.seq,
        timestamp: frame.timestamp,
        image: frame.imageB64,
        clip_path: frame.clipPath || "",  // per-JOB recorded stream (SAM persistent session)
        // ADAAAA-4109: carry the job's closed vocabulary so perceive activates
        // resolve_vocabulary() (soccer roster) instead of open-set OD in the
        // paid/orchestrator VOD path. Sent on every frame so a re-reserve
        // configures the fresh session automatically.
        gameHint: opts?.gameHint || "",
        preferLabels: opts?.preferLabels || [],
      }),
    });
    if (status >= 400) {
      // 404 "runner not found" / "runner session not found" means go-livepeer
      // released the session (static runner health flapped) — a recoverable
      // "session lost" that analyzeJob re-reserves against. Any other status
      // is a real analyze error that aborts the pass.
      if (status === 404) throw new SessionLostError(`analyze failed: HTTP ${status}`);
      throw new Error(`analyze failed: HTTP ${status}`);
    }
    return normalizeObservation(data);
  }
  async postAudio(sessionId: string, chunk: AudioChunk): Promise<void> {
    // Pure-DSP audio gate on the perceive runner — no GPU on this path. Proxy
    // through the same orchestrator session as /analyze so the gate marks
    // candidates on the live session the worker is already paying for.
    const { status } = await this.client.appCall<any>(sessionId, "audio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seq: chunk.seq,
        timestamp: chunk.timestamp,
        samples: chunk.samples,
        stream_id: chunk.streamId || "",
      }),
    });
    // A dropped audio chunk is cheap (gate is best-effort); a 404 just means
    // the video leg already re-reserved a fresh session. Never abort the pass.
    if (status >= 500) throw new Error(`postAudio failed: HTTP ${status}`);
  }
  async controlForward(sessionId: string, control: { type: string; [k: string]: any }): Promise<void> {
    // INC-6 / ADAAAA-4330: proxy a find-and-track / operator control intent
    // through the same orchestrator session as /analyze so the perceive runner
    // marks the slot selected and follows it. Best-effort like postAudio: a 404
    // means the video leg already re-reserved a fresh session — drop, never fatal.
    const { status } = await this.client.appCall<any>(sessionId, "control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(control),
    });
    if (status >= 500) throw new Error(`controlForward failed: HTTP ${status}`);
  }
  async decide(
    evidence: { eventType: string; trackCount: number; maxVelocity: number; ocrHits: number },
    opts?: { gameHint?: string; imageB64?: string; reasoningEffort?: string }
  ): Promise<DecisionResult> {
    const payerAddress = this.payerAddress;
    const payload = {
      sessionId: "job",
      eventType: evidence.eventType,
      timestamp: 0,
      gameHint: opts?.gameHint || "",
      reasoningEffort: opts?.reasoningEffort || "none",
      evidence,
      images: opts?.imageB64 ? [{ role: "full", base64: opts.imageB64 }] : [],
    };
    // The decide runner is a fixed-price single-shot live runner; the first
    // unpaid call 402s with a payment challenge. On-chain (signer + payer
    // address) we forward the challenge's orchestrator info to the remote signer
    // and retry with Livepeer-Payment/Livepeer-Segment — the same flow as
    // reservePerceive, but with a "fixed" unit (1 billable unit) instead of
    // "live" (per-second). This path is what made go-livepeer return
    // `402 invalid live runner payment signer address` for a VOD job at
    // live-runner decide time (6c723cd only paid the persistent perceive reserve).
    const run = async (paymentHeaders?: Record<string, string>) => {
      const { status, data } = await this.client.decide("highlight", payload, {
        payerAddress: payerAddress || undefined,
        paymentHeaders,
      });
      if (status >= 400) throw new Error(`decide failed: HTTP ${status}`);
      return data as DecisionResult;
    };
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof PaymentRequiredError) || !this.signer || !payerAddress) throw err;
      const b64 = err.challenge?.paymentParams;
      if (!b64) {
        throw new Error(
          "on-chain decide 402 challenge carried no payment_params (orchestrator info) to forward to the signer; cannot obtain tickets"
        );
      }
      const manifestID = err.challenge?.manifestId;
      const pmt = await this.signer.generateLivePayment(b64, null, {
        app: ROUTES.decide,
        type: "fixed",
        manifestID: manifestID || undefined,
      });
      return await run({ "Livepeer-Payment": pmt.payment, "Livepeer-Segment": pmt.segCreds });
    }
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
  async analyze(
    sessionId: string,
    frame: { seq: number; timestamp: number; imageB64: string },
    opts?: { gameHint?: string; preferLabels?: string[] }
  ): Promise<ObservationResult> {
    const r = await fetch(`${this.cfg.perceiveUrl}/app/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": this.fakeSession },
      body: JSON.stringify({
        seq: frame.seq,
        timestamp: frame.timestamp,
        image: frame.imageB64,
        clip_path: frame.clipPath || "",
        // ADAAAA-4109: carry the job's closed vocabulary (same as OrchestratorAdapter).
        gameHint: opts?.gameHint || "",
        preferLabels: opts?.preferLabels || [],
      }),
    });
    if (!r.ok) {
      if (r.status === 404) throw new SessionLostError(`analyze failed: HTTP ${r.status}`);
      throw new Error(`analyze failed: HTTP ${r.status}`);
    }
    return normalizeObservation(await r.json());
  }
  async postAudio(sessionId: string, chunk: AudioChunk): Promise<void> {
    // Direct dev path: POST straight to perceive /app/audio (pure DSP, no GPU).
    const r = await fetch(`${this.cfg.perceiveUrl}/app/audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": this.fakeSession },
      body: JSON.stringify({
        seq: chunk.seq,
        timestamp: chunk.timestamp,
        samples: chunk.samples,
        stream_id: chunk.streamId || "",
      }),
    });
    // Best-effort gate: a dropped chunk must never abort the video pass.
    if (r.status >= 500) throw new Error(`postAudio failed: HTTP ${r.status}`);
  }
  async controlForward(_sessionId: string, control: { type: string; [k: string]: any }): Promise<void> {
    // INC-6 / ADAAAA-4330: direct dev path posts the find-and-track control
    // intent straight to perceive /app/control with the fake session id.
    const r = await fetch(`${this.cfg.perceiveUrl}/app/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": this.fakeSession },
      body: JSON.stringify(control),
    });
    if (r.status >= 500) throw new Error(`controlForward failed: HTTP ${r.status}`);
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
  const signer = cfg.signerUrl ? new HttpSignerClient(cfg.signerUrl, undefined, cfg.signerAuthToken) : undefined;
  return new OrchestratorAdapter(cfg, { signer, payerAddress: cfg.payerAddress });
}
