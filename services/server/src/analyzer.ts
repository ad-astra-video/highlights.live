// Worker orchestration: one persistent perceive session per job, sample 1fps,
// feed frames to perceive, compute evidence, call decide on candidates, cut a
// clip on each highlight, and stop the session in `finally`.
import { randomUUID } from "node:crypto";
import type { HighlightRecord, TrackObservation } from "@highlights/events";

export interface ReserveResult {
  sessionId: string;
  appUrl: string;
  controlUrl: string;
}
export interface ObservationResult {
  observation: { tracks: TrackObservation[]; seq: number; timestamp: number };
  candidate?: { eventType: string; timestamp: number };
}
export interface DecisionResult {
  isHighlight: boolean;
  score: number;
  eventType?: string;
  reason?: string;
}
export interface PipelineClient {
  reservePerceive(): Promise<ReserveResult>;
  analyze(sessionId: string, frame: { seq: number; timestamp: number; imageB64: string; clipPath?: string }): Promise<ObservationResult>;
  /**
   * Decide whether a candidate is a highlight. `imageB64` is the candidate
   * frame so the Gemma 12B QAT decide runner sees the actual moment (vision),
   * not just scalar evidence. Adapt the call site to forward it.
   */
  decide(
    evidence: { eventType: string; trackCount: number; maxVelocity: number; ocrHits: number },
    opts?: { gameHint?: string; imageB64?: string }
  ): Promise<DecisionResult>;
  stopPerceive(sessionId: string): Promise<void>;
}

export interface AnalyzerConfig {
  clipBeforeS: number;
  clipAfterS: number;
  jobId: string;
  gameHint: string;
}

/** Compute per-job evidence from the observation stream. */
export class EvidenceTracker {
  private prev = new Map<string, { cx: number; cy: number }>();
  maxVelocity = 0;
  trackCount = 0;
  step(obs: { tracks: TrackObservation[] }): void {
    this.trackCount = obs.tracks.length;
    for (const t of obs.tracks) {
      const [bx1, by1, bx2, by2] = t.bbox;
      const cx = (bx1 + bx2) / 2;
      const cy = (by1 + by2) / 2;
      const p = this.prev.get(t.trackId);
      if (p) {
        const d = Math.abs(cx - p.cx) + Math.abs(cy - p.cy);
        if (d > this.maxVelocity) this.maxVelocity = d;
      }
      this.prev.set(t.trackId, { cx, cy });
    }
  }
}

export interface AnalyzeOutcome {
  sessionId: string;
  highlights: HighlightRecord[];
  framesAnalyzed: number;
}

/** Live-console event: pushed to SSE subscribers for a job as analysis runs. */
export interface AnalyzeEvent {
  seq: number;
  timestamp: number;
  type: "observation" | "candidate" | "highlight";
  observation?: { tracks: TrackObservation[] };
  candidate?: { eventType: string; timestamp: number };
  highlight?: HighlightRecord;
}

export async function analyzeJob(
  client: PipelineClient,
  iterFrames: AsyncIterable<{ seq: number; timestamp: number; imageB64: string }>,
  cut: (ts: number) => Promise<{ clipId: string; clipUri: string }>,
  cfg: AnalyzerConfig,
  onEvent?: (ev: AnalyzeEvent) => void
): Promise<AnalyzeOutcome> {
  const { sessionId } = await client.reservePerceive();
  const evidence = new EvidenceTracker();
  const highlights: HighlightRecord[] = [];
  let framesAnalyzed = 0;
  try {
    for await (const frame of iterFrames) {
      framesAnalyzed++;
      const res = await client.analyze(sessionId, frame);
      evidence.step(res.observation);
      onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "observation", observation: res.observation });
      if (res.candidate) {
        onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "candidate", candidate: res.candidate });

        // Send the ACTUAL candidate frame so the Gemma vision decide runner can
        // see the moment, plus the game hint. Evidence remains as context.
        const decision = await client.decide(
          {
            eventType: res.candidate.eventType,
            trackCount: evidence.trackCount,
            maxVelocity: evidence.maxVelocity,
            ocrHits: 0,
          },
          { gameHint: cfg.gameHint, imageB64: frame.imageB64 }
        );
        if (decision.isHighlight) {
          const { clipId, clipUri } = await cut(res.candidate.timestamp);
          const rec: HighlightRecord = {
            id: randomUUID(),
            jobId: cfg.jobId,
            clipUri,
            start: Math.max(0, res.candidate.timestamp - cfg.clipBeforeS),
            end: res.candidate.timestamp + cfg.clipAfterS,
            eventType: decision.eventType,
            score: decision.score,
            reason: decision.reason,
            status: "pending",
            createdAt: new Date().toISOString(),
          };
          highlights.push(rec);
          onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "highlight", highlight: rec });
        }
      }
    }
  } finally {
    await client.stopPerceive(sessionId).catch(() => {});
  }
  return { sessionId, highlights, framesAnalyzed };
}
