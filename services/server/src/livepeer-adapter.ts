// Maps the LivepeerClient (orchestrator proxy) and a direct-dev transport onto
// the PipelineClient interface the analyzer needs.
import { readFile } from "node:fs/promises";
import {
  HttpSignerClient,
  LivepeerClient,
  PaymentRequiredError,
  ROUTES,
  isSessionRefreshError,
  isTicketParamsExpiredText,
  type LivePayment,
  type RemotePaymentStateSig,
  type SignerClient,
} from "@highlights/livepeer-session";
import type { ServerConfig } from "./config";
import { createPaymentRefresher, type PaymentRefresher } from "./payment";
import type { PerceiveSessionLedger } from "./perceive-ledger";
import type {
  AudioCandidate,
  AudioChunk,
  DecisionResult,
  GroupDecodeRequest,
  ObservationResult,
  PipelineClient,
  PlanRequest,
  ReactionEvidence,
  ReserveResult,
  TrackingPlanResult,
  TrainResult,
  TrainRunRequest,
} from "./analyzer";
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

/** Short pre-retry backoff so the orchestrator has time to cycle its payment
 * params after an expired-params rejection (ADAAAA-6993). */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PaidOrchestratorOptions {
  /** Remote signer used to generate Livepeer-Payment on 402 (on-chain only). */
  signer?: SignerClient;
  /** Payer EVM address advertised on the reserve (on-chain only). */
  payerAddress?: string;
  /** Payment-refresh interval in ms (default 10_000). */
  paymentIntervalMs?: number;
  /** Durable ledger of funded perceive sessions, so a server restart can
   * release any the previous process left funded instead of letting the
   * orchestrator bill-and-force-release them (ADAAAA-6586). */
  ledger?: PerceiveSessionLedger;
  /** ADAAAA-6993: short backoff (ms) before retrying a single-shot
   * decide/plan/train after the orchestrator rejects a ticket minted against
   * expired payment params with HTTP 400 `TicketParams expired` (default 1000).
   * Gives the orchestrator time to cycle its params before the re-sign/retry. */
  ticketParamsRetryBackoffMs?: number;
}

export class OrchestratorAdapter implements PipelineClient {
  private client: LivepeerClient;
  private signer?: SignerClient;
  private payerAddress?: string;
  private paymentIntervalMs: number;
  private app = "highlights-perceive";
  /** Per-session payment refreshers (on-chain only). */
  private payers = new Map<string, PaymentRefresher>();
  /** Durable ledger of funded sessions (survives a server restart). */
  private ledger?: PerceiveSessionLedger;
  private ticketParamsRetryBackoffMs: number;

  constructor(cfg: ServerConfig, opts: PaidOrchestratorOptions = {}) {
    this.client = new LivepeerClient(
      cfg.orchestratorUrl,
      undefined,
      cfg.decideConcurrency !== undefined ? { decideConcurrency: cfg.decideConcurrency } : undefined
    );
    this.signer = opts.signer;
    this.payerAddress = opts.payerAddress;
    this.paymentIntervalMs = opts.paymentIntervalMs ?? 10_000;
    this.ledger = opts.ledger;
    this.ticketParamsRetryBackoffMs = opts.ticketParamsRetryBackoffMs ?? 1000;
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
      // `403 mismatched manifest and auth token`. A signer HTTP 480 on this
      // INITIAL sign (stale per-session/`manifest_id` payment state carried
      // across a job that never released, or a reused OrchestratorInfo
      // auth-token) is recovered by re-minting fresh info and re-signing so it
      // does NOT fail the whole VOD/live job (ADAAAA-6705).
      const { pmt, infoB64 } = await this.generateLivePaymentRecovering480(b64, manifestID || undefined, {
        app: this.app,
        type: "live",
      });
      signerState = pmt.signerState;
      orchInfo = { b64: infoB64, sessionId: manifestID };
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

  /**
   * Generate a live-payment ticket for the (base64 OrchestratorInfo) `b64` on a
   * FRESH reserve — i.e. with a NULL prior signer state. The remote signer
   * (go-livepeer `-remoteSigner`) carries per-session/`manifest_id` payment
   * state that is NOT cleared between jobs; if the same `manifest_id` /
   * OrchestratorInfo auth-token is reused across a stale-active job that never
   * released or a server restart, its persisted `shouldRefreshSession` flag
   * makes even a null-state generate-live-payment return HTTP 480 (the
   * "session needs a refresh" signal). That used to fail the WHOLE VOD/live job
   * at the initial sign. This mirrors the interval `refreshPerceivePayment`
   * recovery (ADAAAA-6575): on 480, re-mint fresh OrchestratorInfo for the same
   * manifest/session via `/refresh-payment` and re-sign ONCE with it, so a 480
   * on the initial sign does NOT fail the job (ADAAAA-6705). A second 480, or a
   * refresh that yields no fresh info (no payer address / manifest id), is a
   * genuine failure and propagates. Returns the re-signed ticket plus the
   * (possibly refreshed) OrchestratorInfo so the interval refresher persists
   * the freshest one instead of re-using the expired info.
   */
  private async generateLivePaymentRecovering480(
    b64: string,
    manifestID: string | undefined,
    opts: { app: string; type: "live" | "lv2v" | "fixed" }
  ): Promise<{ pmt: LivePayment; infoB64: string }> {
    const sign = async (infoB64: string) =>
      this.signer!.generateLivePayment(infoB64, null, {
        app: opts.app,
        type: opts.type,
        manifestID: manifestID || undefined,
      });
    try {
      return { pmt: await sign(b64), infoB64: b64 };
    } catch (err) {
      if (!isSessionRefreshError(err)) throw err;
      // Recovery needs the payer address + the 402 challenge's manifest id to
      // re-mint fresh info for the SAME session; without them the 480 is fatal.
      if (!this.payerAddress || !manifestID) throw err;
      const fresh = await this.client.refreshPaymentSession(this.payerAddress, manifestID);
      if (!fresh?.paymentParams) throw err;
      return { pmt: await sign(fresh.paymentParams), infoB64: fresh.paymentParams };
    }
  }

  /**
   * ADAAAA-6993: build the HTTP error for a single-shot decide/plan/train
   * request and mark a `TicketParams expired` rejection (orchestrator HTTP 400
   * whose body names the signal) so the caller can trigger the recovery below.
   */
  private httpError(status: number, data: unknown, label: string): Error & { ticketParamsExpired?: boolean } {
    const err = new Error(`${label} failed: HTTP ${status}`) as Error & { ticketParamsExpired?: boolean };
    if (status === 400 && isTicketParamsExpiredText(JSON.stringify(data))) err.ticketParamsExpired = true;
    return err;
  }

  /**
   * ADAAAA-6993: fixed-price single-shot decide/plan/train recovery. Signs a
   * ticket for the 402 challenge's OrchestratorInfo, runs the paid request, and
   * on an orchestrator HTTP 400 `TicketParams expired` — a recoverable refresh
   * signal — re-issues the request WITHOUT payment headers to get a FRESH 402
   * challenge (new payment_params / manifest_id), re-signs against the fresh
   * params so the stale OrchestratorInfo is never reused, and retries the paid
   * request once after a short backoff. A second expired rejection throws
   * without looping (the caller decides whether to degrade).
   */
  private async retryPaidSingleShot(
    probeUnpaid: () => Promise<unknown>,
    initial: { b64: string; manifestID?: string },
    signOpts: { app: string; type: "live" | "lv2v" | "fixed" },
    runPaid: (headers: Record<string, string>) => Promise<unknown>
  ): Promise<unknown> {
    const first = await this.generateLivePaymentRecovering480(initial.b64, initial.manifestID, signOpts);
    try {
      return await runPaid({ "Livepeer-Payment": first.pmt.payment, "Livepeer-Segment": first.pmt.segCreds });
    } catch (err) {
      if (!(err as { ticketParamsExpired?: boolean })?.ticketParamsExpired) throw err;
      // Re-issue WITHOUT payment headers to get a fresh 402 challenge (new params):
      // the orchestrator only re-mints fresh OrchestratorInfo when the request is
      // unpaid (it 402s), so the stale info is never reused.
      let fresh: unknown;
      try {
        const got = await probeUnpaid();
        // Unpaid probe unexpectedly succeeded (offchain / no charge) -> use it.
        return got;
      } catch (e) {
        if (!(e instanceof PaymentRequiredError)) throw err;
        fresh = e;
      }
      const freshB64 = (fresh as PaymentRequiredError).challenge?.paymentParams;
      const freshManifest = (fresh as PaymentRequiredError).challenge?.manifestId;
      if (freshB64 && freshManifest) {
        await sleepMs(this.ticketParamsRetryBackoffMs);
        const again = await this.generateLivePaymentRecovering480(freshB64, freshManifest, signOpts);
        return await runPaid({ "Livepeer-Payment": again.pmt.payment, "Livepeer-Segment": again.pmt.segCreds });
      }
      throw err;
    }
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
    // The OrchestratorInfo (base64 net.OrchestratorInfo) used for each refresh.
    // When the remote signer returns 480 (the session's auth-token / ticket
    // params expired), refreshPerceivePayment re-mints fresh info via
    // /refresh-payment and returns it — adopt it so subsequent refreshes keep
    // the reserved balance topped up past the ~10-min token window instead of
    // draining into a force-release (ADAAAA-6575).
    let orchB64 = orchInfo.b64;
    const manifestID = orchInfo.sessionId;
    const refresh = async () => {
      const next = await this.client.refreshPerceivePayment(
        p.sessionId,
        p.controlUrl,
        signer,
        orchB64,
        signerState,
        manifestID,
        this.payerAddress
      );
      if (next) {
        signerState = next.signerState as RemotePaymentStateSig | null;
        if (next.orchInfoB64) orchB64 = next.orchInfoB64;
      }
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
    // Persist the funded session so a server restart (which drops the in-memory
    // refreshers) knows to release it instead of letting the orchestrator
    // account it to `insufficient balance` and force-release it (ADAAAA-6586).
    this.ledger?.register(p.sessionId).catch((e) =>
      console.error(`[adapter] ledger register ${p.sessionId} failed:`, (e as Error)?.message || e)
    );
  }
  async analyze(
    sessionId: string,
    frame: { seq: number; timestamp: number; imageB64: string; clipPath?: string },
    opts?: { gameHint?: string; preferLabels?: string[]; loraRef?: string; trackingPlan?: Record<string, unknown> }
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
        // Per-stream LoRA injection (ADAAAA-5324): carry the stream-attached
        // merged model dir so perceive serves this stream's adapter variant.
        loraRef: opts?.loraRef || "",
        // Increment D (ADAAAA-6467): the active what-to-track plan, delivered
        // on every /analyze so detect/seeding stays scoped to the plan roster
        // (and a re-reserved session inherits it on its first frame).
        ...(opts?.trackingPlan ? { trackingPlan: opts.trackingPlan } : {}),
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
  /** Increment D (ADAAAA-6467): single-shot what-to-track planner call, routed
   * through the same fixed-price decide runner as /highlight (one billable
   * unit; 402 -> signer -> retry with the returned payment headers). Returns a
   * validated TrackingPlan or a safe-default fallback — never throws. */
  async plan(req: PlanRequest): Promise<TrackingPlanResult> {
    const payerAddress = this.payerAddress;
    const payload = {
      sessionId: "job",
      intent: req.intent || "",
      category: req.category || "",
      gameHint: req.gameHint || "",
      mode: req.mode || "live",
      context: req.context ?? {},
      image: req.imageB64 || "",
      reasoningEffort: "none",
    };
    const run = async (paymentHeaders?: Record<string, string>) => {
      const { status, data } = await this.client.decide("plan", payload, {
        payerAddress: payerAddress || undefined,
        paymentHeaders,
      });
      const err = this.httpError(status, data, "plan");
      if (status >= 400) throw err;
      return (data ?? {}) as TrackingPlanResult;
    };
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof PaymentRequiredError) || !this.signer || !payerAddress) {
        // Degrade to a safe-default plan on ANY failure (never a dead stream).
        return { planVersion: 1, category: req.category || "", intent: req.intent || "", source: "planner-fallback", maxTracks: req.mode === "vod" ? 8 : 3, reason: "planner unavailable" };
      }
      const b64 = err.challenge?.paymentParams;
      if (!b64) {
        return { planVersion: 1, category: req.category || "", intent: req.intent || "", source: "planner-fallback", maxTracks: req.mode === "vod" ? 8 : 3, reason: "planner 402 without payment params" };
      }
      const manifestID = err.challenge?.manifestId;
      // Reuse the one-shot 480 recovery (ADAAAA-6705) so a reused session that
      // returns signer HTTP 480 on this single-shot fixed-price call is
      // re-minted via /refresh-payment and re-signed once instead of failing
      // the run hard (ADAAAA-6710). ADAAAA-6993 adds the orchestrator HTTP 400
      // `TicketParams expired` recovery (fresh 402 challenge + re-sign).
      try {
        const res = await this.retryPaidSingleShot(
          () => this.client.decide("plan", payload, { payerAddress: payerAddress || undefined }),
          { b64, manifestID: manifestID || undefined },
          { app: ROUTES.decide, type: "fixed" },
          (h) => run(h)
        );
        return (res ?? {}) as TrackingPlanResult;
      } catch {
        // Degrade to a safe-default plan on any failure (never a dead stream).
        return { planVersion: 1, category: req.category || "", intent: req.intent || "", source: "planner-fallback", maxTracks: req.mode === "vod" ? 8 : 3, reason: "planner unavailable" };
      }
    }
  }
  async postAudio(sessionId: string, chunk: AudioChunk): Promise<AudioCandidate | null> {
    // Pure-DSP audio gate on the perceive runner — no GPU on this path. Proxy
    // through the same orchestrator session as /analyze so the gate marks
    // candidates on the live session the worker is already paying for. The
    // gate's CandidateEvent (or null) rides the response back so the server can
    // route an audio-triggered candidate to decide() on the anchored frame.
    const { status, data } = await this.client.appCall<any>(sessionId, "audio", {
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
    return (status >= 200 && status < 300 ? data?.candidate : null) ?? null;
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
    evidence: {
      eventType: string;
      trackCount: number;
      maxVelocity: number;
      ocrHits: number;
      reaction?: ReactionEvidence; // INC-4 people-reaction context
      goalCrossed?: boolean; // I2 (ADAAAA-6359) goal-line ground-truth
      ballOutcome?: string; // I2 (ADAAAA-6359) ball-outcome outcome
      scoreBoardChanged?: boolean; // I3 (ADAAAA-6360) scoreboard delta
      // I4 / ADAAAA-6361: rich geometry + audio level curve (forwarded verbatim).
      detections?: { label: string; bbox: number[]; confidence: number; trackId: string }[];
      ballPosition?: [number, number] | null;
      distanceToGoal?: number;
      goalLineDelta?: number;
      audioLevels?: number[];
    },
    opts?: {
      gameHint?: string;
      imageB64?: string;
      reasoningEffort?: string;
      frames?: { role: string; base64: string }[];
      audioB64?: string;
      // ADAAAA-6855: the job's requested highlight labels, forwarded so the
      // decide runner exports a requested non-goal class as a distinct highlight.
      preferLabels?: string[];
    }
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
      // ADAAAA-6855: thread the job's requested highlight labels verbatim.
      preferLabels: opts?.preferLabels ?? [],
      // Detail-first (ADAAAA-4954): the temporal frame SEQUENCE + surrounding
      // audio clip the Gemma runner reasons across. Absent on the live baseline.
      frames: opts?.frames ?? [],
      audioB64: opts?.audioB64 ?? "",
      audioSampleRate: 16_000,
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
      const err = this.httpError(status, data, "decide");
      if (status >= 400) throw err;
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
      // Reuse the one-shot 480 recovery (ADAAAA-6705) so a reused session that
      // returns signer HTTP 480 on this single-shot fixed-price call is
      // re-minted via /refresh-payment and re-signed once instead of failing
      // the run hard (ADAAAA-6710). ADAAAA-6993 adds the orchestrator HTTP 400
      // `TicketParams expired` recovery: re-issue WITHOUT payment headers for a
      // fresh 402 challenge and re-sign once so the stale OrchestratorInfo is
      // never reused (retryPaidSingleShot).
      const res = await this.retryPaidSingleShot(
        () => this.client.decide("highlight", payload, { payerAddress: payerAddress || undefined }),
        { b64, manifestID: manifestID || undefined },
        { app: ROUTES.decide, type: "fixed" },
        (h) => run(h)
      );
      return res as DecisionResult;
    }
  }
  /** ADAAAA-6935: ONE merged decide review for all candidates inside a 3 s
   * frame group. Sends the group's frame sequence + every candidate (with its
   * own evidence snapshot) as a single fixed-price /highlight call and returns
   * a verdict per candidate. Mirrors `decide`'s 402 -> signer -> retry payment
   * flow so the merged group call is priced the same as one decide. */
  async decideGroup(req: GroupDecodeRequest): Promise<{ verdicts: DecisionResult[] }> {
    const payerAddress = this.payerAddress;
    const payload = {
      sessionId: "job",
      eventType: req.candidates[0]?.eventType ?? "",
      timestamp: req.candidates[0]?.timestamp ?? 0,
      gameHint: req.gameHint || "",
      reasoningEffort: req.reasoningEffort || "none",
      // ADAAAA-6935: the merged group-review payload (one gemma call).
      candidates: req.candidates.map((c) => ({ eventType: c.eventType, timestamp: c.timestamp, evidence: c.evidence })),
      images: [],
      preferLabels: req.preferLabels ?? [],
      frames: req.frames ?? [],
      audioB64: req.audioB64 ?? "",
      audioSampleRate: 16_000,
    };
    const run = async (paymentHeaders?: Record<string, string>) => {
      const { status, data } = await this.client.decide("highlight", payload, {
        payerAddress: payerAddress || undefined,
        paymentHeaders,
      });
      const err = this.httpError(status, data, "decide group");
      if (status >= 400) throw err;
      return data as { verdicts?: DecisionResult[] };
    };
    try {
      const data = await run();
      return { verdicts: (data.verdicts ?? []).map((v) => v as DecisionResult) };
    } catch (err) {
      if (!(err instanceof PaymentRequiredError) || !this.signer || !payerAddress) throw err;
      const b64 = err.challenge?.paymentParams;
      if (!b64) {
        throw new Error("on-chain decide 402 challenge carried no payment_params (orchestrator info) to forward to the signer; cannot obtain tickets");
      }
      const manifestID = err.challenge?.manifestId;
      // ADAAAA-6993: recover an orchestrator HTTP 400 `TicketParams expired` on
      // the paid decide-group retry by re-issuing WITHOUT payment headers (fresh
      // 402 challenge) and re-signing once, so the stale OrchestratorInfo is
      // never reused (retryPaidSingleShot).
      const res = (await this.retryPaidSingleShot(
        () => this.client.decide("highlight", payload, { payerAddress: payerAddress || undefined }),
        { b64, manifestID: manifestID || undefined },
        { app: ROUTES.decide, type: "fixed" },
        (h) => run(h)
      )) as { verdicts?: DecisionResult[] };
      return { verdicts: (res.verdicts ?? []).map((v) => v as DecisionResult) };
    }
  }
  /** Submit a single-shot fine-tune to the highlights-train runner, mirroring
   * `decide`: one fixed-price live-runner app call, with the 402 -> signer ->
   * retry payment flow on-chain. The payload maps TrainRunRequest fields to the
   * train-entrypoint env contract (manifest path + hyper-params). */
  async train(request: TrainRunRequest): Promise<TrainResult> {
    const payerAddress = this.payerAddress;
    const payload = {
      manifest: request.manifest,
      val: request.val ?? "",
      epochs: request.epochs ?? 5,
      batch_size: request.batchSize ?? 8,
      lr: request.lr ?? 1e-4,
      base_model: request.baseModel ?? "microsoft/Florence-2-base",
    };
    const run = async (paymentHeaders?: Record<string, string>) => {
      const { status, data } = await this.client.train("train", payload, {
        payerAddress: payerAddress || undefined,
        paymentHeaders,
      });
      const err = this.httpError(status, data, "train");
      if (status >= 400) throw err;
      return data as TrainResult;
    };
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof PaymentRequiredError) || !this.signer || !payerAddress) throw err;
      const b64 = err.challenge?.paymentParams;
      if (!b64) {
        throw new Error(
          "on-chain train 402 challenge carried no payment_params (orchestrator info) to forward to the signer; cannot obtain tickets"
        );
      }
      const manifestID = err.challenge?.manifestId;
      // Reuse the one-shot 480 recovery (ADAAAA-6705) so a reused session that
      // returns signer HTTP 480 on this single-shot fixed-price call is
      // re-minted via /refresh-payment and re-signed once instead of failing
      // the run hard (ADAAAA-6710). ADAAAA-6993 adds the orchestrator HTTP 400
      // `TicketParams expired` recovery (fresh 402 challenge + re-sign).
      return (await this.retryPaidSingleShot(
        () => this.client.train("train", payload, { payerAddress: payerAddress || undefined }),
        { b64, manifestID: manifestID || undefined },
        { app: ROUTES.train, type: "fixed" },
        (h) => run(h)
      )) as TrainResult;
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
    // Drop the durable ledger entry only once the orchestrator confirmed the
    // stop (or already-absent session -> 404 = success), so a failed release
    // stays registered for a later boot reconcile retry (ADAAAA-6586).
    this.ledger?.unregister(sessionId).catch((e) =>
      console.error(`[adapter] ledger unregister ${sessionId} failed:`, (e as Error)?.message || e)
    );
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
    frame: { seq: number; timestamp: number; imageB64: string; clipPath?: string },
    opts?: { gameHint?: string; preferLabels?: string[]; loraRef?: string; trackingPlan?: Record<string, unknown> }
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
        // Per-stream LoRA injection (ADAAAA-5324): carry the stream-attached
        // merged model dir so perceive serves this stream's adapter variant.
        loraRef: opts?.loraRef || "",
        // Increment D (ADAAAA-6467): the active what-to-track plan.
        ...(opts?.trackingPlan ? { trackingPlan: opts.trackingPlan } : {}),
      }),
    });
    if (!r.ok) {
      if (r.status === 404) throw new SessionLostError(`analyze failed: HTTP ${r.status}`);
      throw new Error(`analyze failed: HTTP ${r.status}`);
    }
    return normalizeObservation(await r.json());
  }
  /** Increment D (ADAAAA-6467): single-shot what-to-track planner via the
   * direct dev decide runner (/app/plan). Degrades to a safe-default plan on
   * any failure — never throws, never a dead stream. */
  async plan(req: PlanRequest): Promise<TrackingPlanResult> {
    try {
      const r = await fetch(`${this.cfg.decideUrl}/app/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.fakeSession,
          intent: req.intent || "",
          category: req.category || "",
          gameHint: req.gameHint || "",
          mode: req.mode || "live",
          context: req.context ?? {},
          image: req.imageB64 || "",
          reasoningEffort: "none",
        }),
      });
      if (!r.ok) throw new Error(`plan failed: HTTP ${r.status}`);
      return (await r.json()) as TrackingPlanResult;
    } catch {
      return { planVersion: 1, category: req.category || "", intent: req.intent || "", source: "planner-fallback", maxTracks: req.mode === "vod" ? 8 : 3, reason: "planner unavailable" };
    }
  }
  async postAudio(sessionId: string, chunk: AudioChunk): Promise<AudioCandidate | null> {
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
    // Best-effort gate: a dropped chunk must never abort the video pass. The
    // gate's CandidateEvent (or null) rides the response back so the server can
    // route an audio-triggered candidate to decide() on the anchored frame.
    if (r.status >= 500) throw new Error(`postAudio failed: HTTP ${r.status}`);
    if (r.status < 200 || r.status >= 300) return null;
    const body = (await r.json().catch(() => null)) as { candidate?: AudioCandidate } | null;
    return body?.candidate ?? null;
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
    evidence: {
      eventType: string;
      trackCount: number;
      maxVelocity: number;
      ocrHits: number;
      reaction?: ReactionEvidence; // INC-4 people-reaction context
      goalCrossed?: boolean; // I2 (ADAAAA-6359) goal-line ground-truth
      ballOutcome?: string; // I2 (ADAAAA-6359) ball-outcome outcome
      scoreBoardChanged?: boolean; // I3 (ADAAAA-6360) scoreboard delta
      // I4 / ADAAAA-6361: rich geometry + audio level curve (forwarded verbatim).
      detections?: { label: string; bbox: number[]; confidence: number; trackId: string }[];
      ballPosition?: [number, number] | null;
      distanceToGoal?: number;
      goalLineDelta?: number;
      audioLevels?: number[];
    },
    opts?: {
      gameHint?: string;
      imageB64?: string;
      reasoningEffort?: string;
      frames?: { role: string; base64: string }[];
      audioB64?: string;
    }
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
        frames: opts?.frames ?? [],
        audioB64: opts?.audioB64 ?? "",
        audioSampleRate: 16_000,
      }),
    });
    if (!r.ok) throw new Error(`decide failed: HTTP ${r.status}`);
    return (await r.json()) as DecisionResult;
  }
  async decideGroup(req: GroupDecodeRequest): Promise<{ verdicts: DecisionResult[] }> {
    const r = await fetch(`${this.cfg.decideUrl}/app/highlight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: this.fakeSession,
        eventType: req.candidates[0]?.eventType ?? "",
        timestamp: req.candidates[0]?.timestamp ?? 0,
        gameHint: req.gameHint || "",
        reasoningEffort: req.reasoningEffort || "none",
        // ADAAAA-6935: merged group review (one gemma call) — every candidate
        // in the 3 s group + the group's frame sequence.
        candidates: req.candidates.map((c) => ({ eventType: c.eventType, timestamp: c.timestamp, evidence: c.evidence })),
        images: [],
        frames: req.frames ?? [],
        audioB64: req.audioB64 ?? "",
        audioSampleRate: 16_000,
      }),
    });
    if (!r.ok) throw new Error(`decide group failed: HTTP ${r.status}`);
    const data = (await r.json()) as { verdicts?: DecisionResult[] };
    return { verdicts: (data.verdicts ?? []).map((v) => v as DecisionResult) };
  }
  async train(request: TrainRunRequest): Promise<TrainResult> {
    // Direct dev path: requires a reachable TRAIN_URL exposing /app/train (the
    // train single-shot app). Unknown in this adapter if unset.
    if (!this.cfg.trainUrl) {
      throw new Error("train unsupported in direct mode (TRAIN_URL not set)");
    }
    const r = await fetch(`${this.cfg.trainUrl}/app/train`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: request.manifest,
        val: request.val ?? "",
        epochs: request.epochs ?? 5,
        batch_size: request.batchSize ?? 8,
        lr: request.lr ?? 1e-4,
        base_model: request.baseModel ?? "microsoft/Florence-2-base",
      }),
    });
    if (!r.ok) throw new Error(`train failed: HTTP ${r.status}`);
    return (await r.json()) as TrainResult;
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

export function makeAdapter(cfg: ServerConfig, opts?: { ledger?: PerceiveSessionLedger }): PipelineClient {
  if (cfg.perceiveUrl && cfg.decideUrl) return new DirectAdapter(cfg);
  // On-chain: wire the remote signer + payer address so VOD submissions can pay
  // the orchestrator (mirrors the live media-server payer). Offchain (no signer)
  // this is the old unpaid path and the orchestrator never 402s.
  const signer = cfg.signerUrl ? new HttpSignerClient(cfg.signerUrl, undefined, cfg.signerAuthToken) : undefined;
  return new OrchestratorAdapter(cfg, { signer, payerAddress: cfg.payerAddress, ledger: opts?.ledger });
}
