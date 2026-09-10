// Maps the LivepeerClient (orchestrator proxy) and a direct-dev transport onto
// the PipelineClient interface the analyzer needs.
import { readFile } from "node:fs/promises";
import { LivepeerClient } from "@highlights/livepeer-session";
import type { ServerConfig } from "./config";
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

export class OrchestratorAdapter implements PipelineClient {
  private client: LivepeerClient;
  constructor(cfg: ServerConfig) {
    this.client = new LivepeerClient(cfg.orchestratorUrl);
  }
  async reservePerceive(): Promise<ReserveResult> {
    const r = await this.client.reservePerceive();
    return { sessionId: r.sessionId, appUrl: r.appUrl, controlUrl: r.controlUrl };
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
    opts?: { gameHint?: string; imageB64?: string }
  ): Promise<DecisionResult> {
    const { status, data } = await this.client.decide("highlight", {
      sessionId: "job",
      eventType: evidence.eventType,
      timestamp: 0,
      gameHint: opts?.gameHint || "",
      evidence,
      images: opts?.imageB64 ? [{ role: "full", base64: opts.imageB64 }] : [],
    });
    if (status >= 400) throw new Error(`decide failed: HTTP ${status}`);
    return data as DecisionResult;
  }
  async stopPerceive(sessionId: string): Promise<void> {
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
    opts?: { gameHint?: string; imageB64?: string }
  ): Promise<DecisionResult> {
    const r = await fetch(`${this.cfg.decideUrl}/app/highlight`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: this.fakeSession,
        eventType: evidence.eventType,
        timestamp: 0,
        gameHint: opts?.gameHint || "",
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
  return new OrchestratorAdapter(cfg);
}
