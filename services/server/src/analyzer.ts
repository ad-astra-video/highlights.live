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
    opts?: { gameHint?: string; imageB64?: string; reasoningEffort?: string }
  ): Promise<DecisionResult>;
  stopPerceive(sessionId: string): Promise<void>;
}

export interface AnalyzerConfig {
  clipBeforeS: number;
  clipAfterS: number;
  jobId: string;
  gameHint: string;
  /**
   * Seconds after a candidate fires before the gemma decide runs, using the
   * frame captured at that later moment instead of the exact candidate/onset
   * frame. The audio-noise gate fires on crowd-roar ONSET, which precedes the
   * visual celebration on a real goal; a decide anchored to the onset frame
   * sees a pre-celebration build-up and rejects a genuine event, inflating the
   * gemma FP-rate (`stageAMetrics.gemmaFpRate`). Deferring by ~1.5-2s snaps
   * the decide to the celebration frame, where gemma confirms the real goal,
   * while staying inside the 1-5s latency budget. Default 0 = decide on the
   * candidate frame immediately (legacy behavior).
   */
  decideAnchorDelayS?: number;
  /**
   * Max times the job will re-reserve a fresh perceive session after the
   * current one is lost mid-pass (HTTP 404 "runner not found" / "runner
   * session not found"). The perceive live-runner's health can flap and
   * go-livepeer then releases all its sessions, turning the in-flight
   * `/analyze` into a 404. Bounded re-reserve lets a VOD pass ride through a
   * transient perceive restart by reconnecting to the recovered runner;
   * beyond this we abort cleanly instead of spinning. Default 3.
   */
  maxReReserves?: number;
}

/**
 * The perceive session/runner disappeared while a pass was in flight (the
 * orchestrator returned HTTP 404 "runner not found" / "runner session not
 * found" for our proxied analyze call — released because the static runner's
 * health flapped, or the session was explicitly released). A caller may safely
 * re-reserve a fresh session and retry the current frame. Any other analyze
 * error stays a plain Error and aborts the pass.
 */
export class SessionLostError extends Error {
  constructor(msg = "perceive session/runner lost (404)") {
    super(msg);
    this.name = "SessionLostError";
  }
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
  const maxReReserves = cfg.maxReReserves ?? 3;
  const anchorDelay = cfg.decideAnchorDelayS ?? 0;
  const first = await client.reservePerceive();
  let sessionId = first.sessionId;
  // Every session we reserved (initial + any re-reserves) must be stopped /
  // un-paid in `finally`, even the ones go-livepeer already released (the
  // server-side released ones still hold a payment refiller in the adapter).
  const reserved = new Set<string>([first.sessionId]);
  const evidence = new EvidenceTracker();
  const highlights: HighlightRecord[] = [];
  let framesAnalyzed = 0;

  // A candidate awaiting its anchor frame. We keep the evidence snapshot from
  // the candidate moment but send gemma the frame captured ~anchorDelay later
  // (the celebration), so a real event that the audio onset precedes is not
  // judged on a pre-celebration build-up frame.
  interface PendingDecide {
    candTs: number;
    eventType: string;
    dueTs: number;
    evidence: { trackCount: number; maxVelocity: number; ocrHits: number };
  }
  // Sorted by dueTs ascending (we push in frame-timestamp order).
  const pending: PendingDecide[] = [];
  let lastImageB64 = "";

  // Send one candidate through its gemma decide and cut a clip on accept.
  // `imageB64` is the anchor frame the decide runner should see.
  const runDecide = async (p: PendingDecide, imageB64: string) => {
    const decision = await client.decide(
      {
        eventType: p.eventType,
        trackCount: p.evidence.trackCount,
        maxVelocity: p.evidence.maxVelocity,
        ocrHits: 0,
      },
      { gameHint: cfg.gameHint, imageB64 }
    );
    if (decision.isHighlight) {
      const { clipId, clipUri } = await cut(p.candTs);
      const rec: HighlightRecord = {
        id: randomUUID(),
        jobId: cfg.jobId,
        clipUri,
        start: Math.max(0, p.candTs - cfg.clipBeforeS),
        end: p.candTs + cfg.clipAfterS,
        eventType: decision.eventType,
        score: decision.score,
        reason: decision.reason,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      highlights.push(rec);
      onEvent?.({ seq: -1, timestamp: p.candTs, type: "highlight", highlight: rec });
    }
  };

  try {
    for await (const frame of iterFrames) {
      framesAnalyzed++;
      lastImageB64 = frame.imageB64;

      // Fire candidates whose anchor window has closed on this (later) frame,
      // so gemma sees the celebration moment rather than the onset frame.
      while (pending.length && pending[0].dueTs <= frame.timestamp) {
        const p = pending.shift()!;
        await runDecide(p, frame.imageB64);
      }
      let res: ObservationResult;
      let reReserved = 0;
      // The perceive live-runner's health can flap mid-pass; go-livepeer then
      // marks it unavailable and releases all its sessions, so our next
      // /analyze returns 404 "runner not found". Re-reserve a fresh session
      // and retry this frame (the 404 frame was never processed) up to the
      // bounded cap, then surface the error cleanly.
      for (;;) {
        try {
          res = await client.analyze(sessionId, frame);
          break;
        } catch (err) {
          if (!(err instanceof SessionLostError)) throw err;
          if (reReserved >= maxReReserves) throw err;
          reReserved++;
          const fresh = await client.reservePerceive();
          sessionId = fresh.sessionId;
          reserved.add(fresh.sessionId);
        }
      }
      evidence.step(res.observation);
      onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "observation", observation: res.observation });
      if (res.candidate) {
        onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "candidate", candidate: res.candidate });

        const p: PendingDecide = {
          candTs: res.candidate.timestamp,
          eventType: res.candidate.eventType,
          dueTs: res.candidate.timestamp + anchorDelay,
          evidence: { trackCount: evidence.trackCount, maxVelocity: evidence.maxVelocity, ocrHits: 0 },
        };

        if (anchorDelay > 0) {
          // Defer the decide until a frame ~anchorDelay after the onset fires,
          // so gemma judges the celebration frame (see decideAnchorDelayS).
          pending.push(p);
        } else {
          // Legacy: decide on the exact candidate frame.
          await runDecide(p, frame.imageB64);
        }
      }
    }

    // End of stream: flush any candidates still waiting on an anchor frame.
    // Use the last captured frame (closest the stream reached to the
    // celebration) so a candidate near the clip tail is still decided.
    for (const p of pending) {
      await runDecide(p, lastImageB64);
    }
  } finally {
    // Stop / un-pay every session we reserved this pass. Sessions the server
    // already released are a no-op on the orchestrator but still drop their
    // adapter payment refiller, so stopping them is required to avoid leaks.
    for (const s of reserved) {
      await client.stopPerceive(s).catch(() => {});
    }
  }
  return { sessionId, highlights, framesAnalyzed };
}
