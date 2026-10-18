// Media-server VOD job driver (ADAAAA-6866 Phase 1).
//
// Phase 1 of the workload-split plan (ADAAAA-6714) moves the VOD media work
// OFF the main server and ONTO the media node: ffmpeg frame extraction, clip
// cutting, the Stage-A audio tap, and the perceive session reservation/payment.
// The media server runs the VOD candidate->decide->highlight path and reports
// typed MediaResultEvents back to the negotiating server (the DB-owner), which
// persists highlights / clip records / stage-A metrics / cost and sets status.
//
// This driver takes a MediaJobRequest (source=file/url), resolves a local file
// on the media node, reserves + pays the perceive session via the
// MediaOrchestrator (the media node is the payer), extracts frames with ffmpeg,
// feeds them to perceive, drives per-candidate Gemma decide, cuts clips from the
// SOURCE file (not a live session recording), and reports results.
//
// The Orchestrator candidate signal + Gemma verdict are provided by injected
// dependencies (in tests: a fake orchestrator + fake decide runner); the ffmpeg
// frame extraction + clip cut are real.
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CandidateEvent,
  HighlightRecord,
  MediaJobRequest,
  MediaResultEvent,
  StageAMetricsSnapshot,
} from "@highlights/events";
import type { MediaOrchestrator, ProvisionedSession } from "./orch";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const AUDIO_SAMPLE_RATE = 16_000;
const AUDIO_CHUNK_S = 0.1;

export interface MediaVodOptions {
  ffmpegPath?: string;
  decideUrl?: string;
  decideAuthToken?: string;
  decideFee?: number;
  perceivePerHourUsd?: number;
  clipBeforeS?: number;
  clipAfterS?: number;
  clipsDir?: string;
  tmpDir?: string;
  publicBaseUrl?: string;
  sampleFps?: number;
  frameScale?: string;
  /** Callback used to report a typed MediaResultEvent for a job. Wired to the
   *  source issue's app so the driver stays transport-agnostic / testable. */
  report: (jobId: string, ev: MediaResultEvent) => Promise<void>;
}

interface Accumulator {
  totalCandidates: number;
  accepted: number;
  rejected: number;
  latencySamples: number[];
  perceivedStartedAt: number;
}

interface VodFrame {
  buf: Uint8Array;
  ts: number;
}

/** Per-session VOD result carried out of run() for the server-side handoff to
 *  finalize the job (set status, record perceiveSessionId). */
export interface MediaVodResult {
  jobId: string;
  sessionId: string;
  framesAnalyzed: number;
  candidatesTriggered: number;
  decideCalls: number;
  costUsd: number;
  perceiveSessionS: number;
  stageAMetrics: StageAMetricsSnapshot;
}

export class MediaVodRunner {
  private ffmpeg: string;
  constructor(private orch: MediaOrchestrator, private opts: MediaVodOptions) {
    this.ffmpeg = opts.ffmpegPath || "ffmpeg";
  }

  /** Run one VOD job end to end on the media node. Reserves/pays the perceive
   *  session, extracts frames + Stage-A audio via ffmpeg, feeds perceive,
   *  decides per candidate, cuts clips from the source, reports typed result
   *  events, and releases the paid slot in a finally (idempotent teardown). */
  async run(req: MediaJobRequest): Promise<MediaVodResult> {
    if (req.source !== "file" && req.source !== "url") {
      throw new Error(`media vod: unsupported source '${req.source}' (Phase 1 is VOD file/url)`);
    }
    const fps = req.detailFps ?? req.sampleFps ?? this.opts.sampleFps ?? 2;
    const scale = req.frameScale ?? this.opts.frameScale ?? "640:360";
    const workDir = mkdtempSync(path.join(this.opts.tmpDir || tmpdir(), "hl-vod-"));
    let provisioned: ProvisionedSession | undefined;
    try {
      const src = await this.resolveInput(req, workDir);
      // Reserve + pay the perceive session ON the media node (the media server
      // is the Livepeer payer). Offchain this is a no-op; on-chain the 402
      // challenge + remote signer flow runs inside orch.provision().
      provisioned = await this.orch.provision().catch((e: any) => {
        throw new Error(`media vod: reserve perceive failed: ${e?.message || e}`);
      });
      this.orch.startPayment(provisioned);

      const acc: Accumulator = {
        totalCandidates: 0,
        accepted: 0,
        rejected: 0,
        latencySamples: [],
        perceivedStartedAt: Date.now(),
      };
      const frames = await this.extractFrames(src, workDir, fps, scale);
      let framesAnalyzed = 0;
      let candidatesTriggered = 0;
      for (let i = 0; i < frames.length; i++) {
        const seq = i + 1;
        const ts = frames[i].ts;
        await this.orch.publishFrame(provisioned, seq, frames[i].buf, ts);
        framesAnalyzed++;
        const obs = await this.pollObservation(provisioned, seq);
        if (this.isCandidate(obs)) {
          candidatesTriggered++;
          await this.handleCandidate(req, provisioned, acc, src, obs, seq, ts);
        }
      }
      // Stage-A audio tap: decode the source audio track (0:a:0) and POST it to
      // perceive /audio (best-effort — a silent/absent/missing track never
      // aborts the video pass). Mirrors the server's extractVodAudioChunks.
      await this.audioTap(provisioned, src, req.jobId).catch(() => {});

      const perceiveSessionS = (Date.now() - acc.perceivedStartedAt) / 1000;
      const stageA = this.stageAMetrics(acc);
      const costUsd = this.costUsd(acc, perceiveSessionS);
      // Final typed result events the server persists + bills on.
      await this.opts.report(req.jobId, {
        type: "stageAMetrics",
        timestamp: frames.length ? frames[frames.length - 1].ts : 0,
        metrics: stageA,
      } satisfies MediaResultEvent);
      await this.opts.report(req.jobId, {
        type: "cost",
        timestamp: 0,
        costUsd,
        perceiveSessionS: Number(perceiveSessionS.toFixed(1)),
        // ADAAAA-6895 Phase 1b: report the session id the media node reserved so
        // the server can record perceiveSessionId on the job record.
        perceiveSessionId: provisioned.sessionId,
      } satisfies MediaResultEvent);

      return {
        jobId: req.jobId,
        sessionId: provisioned.sessionId,
        framesAnalyzed,
        candidatesTriggered,
        decideCalls: candidatesTriggered,
        costUsd,
        perceiveSessionS: Number(perceiveSessionS.toFixed(1)),
        stageAMetrics: stageA,
      };
    } finally {
      if (provisioned) {
        this.orch.stopPayment(provisioned.sessionId);
        await this.orch.releaseSession(provisioned.sessionId, provisioned.controlUrl).catch(() => {});
      }
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** Resolve the VOD input to a local file path on the media node. source=file
   *  uses the handoff's inputPath (the caller/storage has placed it there);
   *  source=url downloads it to the media node's scratch dir via ffmpeg. */
  private async resolveInput(req: MediaJobRequest, workDir: string): Promise<string> {
    if (req.source === "file") {
      if (!req.inputPath) throw new Error("media vod: source=file requires inputPath");
      if (!existsSync(req.inputPath)) throw new Error(`media vod: input file missing: ${req.inputPath}`);
      return req.inputPath;
    }
    if (req.source === "url") {
      if (!req.inputUrl) throw new Error("media vod: source=url requires inputUrl");
      const out = path.join(workDir, "src.mp4");
      await exec(this.ffmpeg, ["-y", "-i", req.inputUrl, "-c", "copy", out]);
      if (!existsSync(out)) throw new Error("media vod: url download produced no file");
      return out;
    }
    throw new Error(`media vod: unsupported source '${req.source}'`);
  }

  /** Extract frames from the source file with ffmpeg at `fps` / `scale`, sorted,
   *  with absolute timestamps (i / fps seconds). Returns raw JPEG buffers. */
  private async extractFrames(
    src: string,
    workDir: string,
    fps: number,
    scale: string
  ): Promise<VodFrame[]> {
    const outDir = path.join(workDir, "frames");
    mkdirSync(outDir, { recursive: true });
    await exec(this.ffmpeg, [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", src,
      "-vf", `fps=${fps},scale=${scale}`,
      "-q:v", "3",
      path.join(outDir, "frame_%04d.jpg"),
    ]);
    const files = readdirSync(outDir).filter((f) => f.endsWith(".jpg")).sort();
    return files.map((f, i) => ({
      buf: readFileSync(path.join(outDir, f)),
      ts: Number((i / fps).toFixed(3)),
    }));
  }

  /** Poll the session's events-out rail for the observation at `seq`. Mirrors
   *  the live publishAndObserve loop (bounded so a never-published seq doesn't
   *  hang the VOD pass). */
  private async pollObservation(p: ProvisionedSession, seq: number): Promise<any | null> {
    for (let i = 0; i < 10; i++) {
      const obs = await this.orch.readObservation(p, seq).catch(() => null);
      if (obs) return obs;
      await sleep(150);
    }
    return null;
  }

  /** A perceive observation is a candidate when it is a typed CandidateEvent or
   *  carries a candidate envelope (mirrors the live handleCandidate gate). */
  private isCandidate(obs: any): boolean {
    if (!obs || typeof obs !== "object") return false;
    if (obs.type === "candidate") return true;
    if (obs.candidate && typeof obs.candidate === "object") return true;
    return false;
  }

  /** Drive one candidate: report it, fire exactly one Gemma decide, and on
   *  acceptance cut a clip FROM THE SOURCE FILE and report a highlight. */
  private async handleCandidate(
    req: MediaJobRequest,
    stream: ProvisionedSession,
    acc: Accumulator,
    src: string,
    obs: any,
    seq: number,
    ts: number
  ): Promise<void> {
    await this.opts.report(req.jobId, {
      type: "candidate",
      seq,
      timestamp: ts,
      candidate: obs as CandidateEvent,
    } satisfies MediaResultEvent);

    if (!this.opts.decideUrl) return;

    acc.totalCandidates += 1;
    const onLat = obs?.audio?.onsetLatencyS;
    if (typeof onLat === "number" && Number.isFinite(onLat)) acc.latencySamples.push(onLat);

    let decision: any;
    try {
      decision = await this.fireDecide(stream, obs, ts);
    } catch (e: any) {
      console.error("[media-vod] decide failed: %s", String(e?.message || e));
      decision = { isHighlight: false, score: 0 };
    }

    if (decision?.isHighlight) {
      acc.accepted += 1;
      let clipUri = "";
      let clipError: string | undefined;
      try {
        const clip = await this.cutClipFromSource(src, ts);
        clipUri = clip.clipUri;
        clipError = clip.error;
      } catch (e: any) {
        clipError = String(e?.message || e);
      }
      const rec: HighlightRecord = {
        id: randomUUID(),
        jobId: req.jobId,
        clipUri,
        start: Math.max(0, ts - (this.opts.clipBeforeS ?? 5)),
        end: ts + (this.opts.clipAfterS ?? 10),
        eventType: decision.eventType ?? obs.eventType,
        score: decision.score ?? 0,
        reason: decision.reason,
        outcome: decision.outcome,
        nearMiss: decision.nearMiss,
        status: "pending",
        ...(clipError ? { clipError } : {}),
        createdAt: new Date().toISOString(),
      };
      await this.opts.report(req.jobId, {
        type: "highlight",
        seq,
        timestamp: ts,
        highlight: rec,
        decide: decision,
      } satisfies MediaResultEvent);
    } else {
      acc.rejected += 1;
    }
  }

  /** Fire the Gemma decide runner, mirroring the server-side decide POST shape. */
  private async fireDecide(
    stream: ProvisionedSession,
    obs: any,
    _ts: number
  ): Promise<{ isHighlight: boolean; score?: number; eventType?: string; reason?: string; outcome?: string; nearMiss?: boolean }> {
    const url = `${(this.opts.decideUrl || "").replace(/\/$/, "")}/app/highlight`;
    const payload: Record<string, unknown> = {
      sessionId: stream.sessionId,
      eventType: obs?.eventType || "AUDIO",
      timestamp: typeof obs?.timestamp === "number" ? obs.timestamp : 0,
      gameHint: "",
      reasoningEffort: "none",
      evidence: {
        eventType: obs?.eventType || "AUDIO",
        trackCount: 0,
        maxVelocity: 0,
        ocrHits: 0,
        goalCrossed: obs?.goalCrossed,
        ballOutcome: obs?.ballOutcome,
        scoreBoardChanged: obs?.scoreBoardChanged,
      },
      images: [],
      frames: [],
      audioB64: "",
      audioSampleRate: 16_000,
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.decideAuthToken) headers["Authorization"] = `Bearer ${this.opts.decideAuthToken}`;
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error(`decide failed: HTTP ${r.status}`);
    return (await r.json()) as any;
  }

  /** Cut a highlight clip from the SOURCE file (VOD has no live session
   *  recording). Returns the clipUri served from /clips or an explicit error
   *  (never a silent empty clipUri). */
  private async cutClipFromSource(
    src: string,
    ts: number
  ): Promise<{ clipUri: string; error?: string }> {
    const clipId = randomUUID();
    const clipsDir = this.opts.clipsDir || path.join(tmpdir(), "hl-clips");
    mkdirSync(clipsDir, { recursive: true });
    const out = path.join(clipsDir, `${clipId}.mp4`);
    const startS = Math.max(0, ts - (this.opts.clipBeforeS ?? 5));
    const durS = Math.max(1, (this.opts.clipBeforeS ?? 5) + (this.opts.clipAfterS ?? 10));
    try {
      await exec(this.ffmpeg, [
        "-y",
        "-ss", String(startS),
        "-t", String(durS),
        "-i", src,
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        out,
      ]);
      const uri = `${(this.opts.publicBaseUrl || "").replace(/\/$/, "")}/clips/${clipId}.mp4`;
      return { clipUri: uri };
    } catch (e: any) {
      return { clipUri: "", error: String(e?.message || e) };
    }
  }

  /** Stage-A audio tap (best-effort): decode 0:a:0 to pcm_s16le 16k mono and
   *  POST ~100 ms chunks to perceive /audio, mirroring the server-side tap.
   *  Never aborts the video pass. */
  private async audioTap(stream: ProvisionedSession, src: string, streamId: string): Promise<void> {
    const appUrl = (stream.appUrl || "").replace(/\/$/, "");
    if (!appUrl) return;
    const proc = spawn(this.ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", src,
      "-map", "0:a:0?",
      "-ac", "1",
      "-ar", String(AUDIO_SAMPLE_RATE),
      "-c:a", "pcm_s16le",
      "-f", "s16le",
      "-",
    ]);
    proc.stderr.on("data", () => {});
    const chunkBytes = Math.round(AUDIO_SAMPLE_RATE * AUDIO_CHUNK_S) * 2;
    let buf = Buffer.alloc(0);
    let seq = 0;
    let baseTs = 0;
    for await (const data of proc.stdout as AsyncIterable<Buffer>) {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= chunkBytes) {
        const chunk = buf.subarray(0, chunkBytes);
        buf = buf.subarray(chunkBytes);
        seq += 1;
        baseTs += AUDIO_CHUNK_S;
        try {
          await fetch(`${appUrl}/audio`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-session-id": stream.sessionId },
            body: JSON.stringify({ seq, timestamp: Number(baseTs.toFixed(3)), samples: chunk.toString("base64"), streamId }),
          });
        } catch {
          /* best-effort */
        }
      }
    }
    proc.kill("SIGKILL");
  }

  /** Stage-A metrics snapshot (same contract as the server). */
  private stageAMetrics(acc: Accumulator): StageAMetricsSnapshot {
    const judged = acc.accepted + acc.rejected;
    const fpRate = judged > 0 ? acc.rejected / judged : 0;
    const lat = acc.latencySamples.length
      ? acc.latencySamples.reduce((a, b) => a + b, 0) / acc.latencySamples.length
      : 0;
    const maxLat = acc.latencySamples.length ? Math.max(...acc.latencySamples) : 0;
    const sorted = [...acc.latencySamples].sort((a, b) => a - b);
    const pct = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
    return {
      totalCandidates: acc.totalCandidates,
      accepted: acc.accepted,
      rejected: acc.rejected,
      fpRate: Math.round(fpRate * 1000) / 1000,
      meanOnsetLatencyS: Math.round(lat * 1000) / 1000,
      maxOnsetLatencyS: Math.round(maxLat * 1000) / 1000,
      p50LatencyS: Math.round(pct(0.5) * 1000) / 1000,
      p95LatencyS: Math.round(pct(0.95) * 1000) / 1000,
      gemmaFpRate: Math.round(fpRate * 1000) / 1000,
      fpRateWithinBudget: fpRate <= 0.6,
    };
  }

  /** Cost of the VOD pass: decide fee X calls + perceive session time. */
  private costUsd(acc: Accumulator, perceiveSessionS: number): number {
    const decideFee = this.opts.decideFee ?? 0.05;
    const perHour = this.opts.perceivePerHourUsd ?? 0.1;
    return Math.round((decideFee * acc.totalCandidates + (perceiveSessionS / 3600) * perHour) * 10000) / 10000;
  }
}
