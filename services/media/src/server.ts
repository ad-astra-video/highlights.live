// Media server (the gateway terminus + payer for one perceived live stream).
//
// Control plane is Fastify control-plane compatible:
//   POST /sessions            { jobId? } -> reserve+open a perceive session
//   GET  /stream/:sid         WebSocket the browser streams frames over
//   POST /sessions/:sid/close force-close (control path)
//
// The browser sends {seq,image,timestamp?} JSON over the WS; the media server
// publishes each frame to the orchestrator's video-in rail, reads the runner's
// events-out observation back, and relays it over the WS (and, when a callback
// URL is configured, POSTs it to the Fastify /jobs/:id/observe so highlight
// generation still runs). Any close (WS drop, explicit) tears the stream down:
// payment stops + the perceive slot is released.
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { MediaOrchestrator, type ProvisionedSession } from "./orch";
import { WebRtcIngestSession } from "./rtc";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CandidateEvent, HighlightRecord, MediaJobRequest, MediaResultEvent } from "@highlights/events";
import { MediaJobRequestSchema } from "@highlights/events";
import { MediaVodRunner } from "./vod";

const exec = promisify(execFile);

interface ActiveStream {
  streamId: string;
  jobId: string;
  provisioned: ProvisionedSession;
  sockets: Set<any>;
  closed: boolean;
  /** Active WebRTC ingest terminus (present once a browser opens an RTC session). */
  rtc?: { pcId: string; session: WebRtcIngestSession };
  /** Muxed (video+audio) MediaRecorder chunks reassembled in arrival order.
   *  Lazily created on the first muxed chunk; the container's own PTS is the
   *  authoritative clock for clip cutting AND for feeding the analysis rails. */
  recording?: { path: string; mime: string; stream: WriteStream };
  /** Live-analysis relay (perceive persistent-session data + state -> webapp).
   *  Owns the capped-cadence poll timers and the incremental relay cursor. */
  analysis?: {
    stateTimer?: NodeJS.Timeout;
    eventTimer?: NodeJS.Timeout;
    running?: boolean;
    /** Set once after a perceive fetch error, so an unreachable/app-erroring
     *  perceiver is logged once per session instead of spamming each cadence. */
    warned?: boolean;
    /** Last known stream timestamp (seconds) from the state poll. */
    lastTs?: number;
    /** End (seconds) of the last analysis window already relayed. */
    lastEventTs?: number;
  };
  /** Phase 0b (ADAAAA-6880) per-candidate decide + result-event accumulator:
   *  counts decides accepted/rejected and tracks the perceive session wall
   *  clock for the `cost` result event. Lazily initialized on the first
   *  candidate so unset never wastes memory on plain observation streams. */
  phase0?: Phase0Accumulator;
}

/** Per-session Phase 0b state: candidate/decide tallies + perceive session clock
 *  for the stage-A metrics and cost result events. */
interface Phase0Accumulator {
  totalCandidates: number;
  accepted: number;
  rejected: number;
  /** Onset->fire latency samples (s) reported on audio-gate candidates. */
  latencySamples: number[];
  /** Epoch ms when the perceive session was provisioned (cost basis). */
  perceivedStartedAt: number;
}

export interface MediaServerOptions {
  /** Orchestrator URL (offchain lab) or gateway URL. */
  orchBase: string;
  /** Where the Fastify control plane lives, to receive observations back. */
  callbackBase?: string;
  seedImageB64?: string;
  /** On-chain payer (remote signer + advertised payer address). */
  signer?: import("@highlights/livepeer-session").SignerClient;
  payerAddress?: string;
  paymentIntervalMs?: number;
  /**
   * On-chain: resolve WHICH orchestrator / live-runner to start the session
   * against from the signer's /discover-orchestrators (falls back to the
   * configured orchBase). The media server never dials the orchestrator for
   * OrchestratorInfo directly — the payment material comes from the 402
   * reserve challenge. Offchain this is unused.
   */
  discoverOrchestrators?: () => Promise<{ address: string; runners: import("@highlights/livepeer-session").DiscoveredRunner[] }[]>;
  port?: number;
  /** Public origin (LB / Cloudflare front) used for the full WS ingest URL. */
  publicBaseUrl?: string;
  /**
   * How long (ms) a session stays open after its last browser disconnects,
   * before the perceive slot is released. Lets a transient browser blip
   * reconnect to the SAME session (seamless, no session churn). Default 8000.
   * <=0 disables the grace (tear down immediately on WS close).
   */
  reconnectGraceMs?: number;
  /**
   * How long (ms) a freshly-provisioned session may sit with NO browser WS ever
   * connecting before its perceive slot is released. Prevents a reserved slot
   * from leaking forever (e.g. the server provisioned but the browser never
   * opened the WS). Default 60000. <=0 disables.
   */
  provisionNoClientMs?: number;
  /** Directory where per-session muxed recordings are reassembled. Default tmpdir. */
  tmpDir?: string;
  /** WebRTC ingest JPEG sample cadence (fps). Default 1.0. */
  rtcSampleFps?: number;
  /** Live-analysis state poll cadence (ms). Default 1000. Bounded; not a
   *  per-frame firehose. */
  analysisStateCadenceMs?: number;
  /** Live-analysis event (windowed tool) poll cadence (ms). Default 2000. */
  analysisEventCadenceMs?: number;
  /** Disable the live-analysis relay entirely (default enabled). */
  analysisEnabled?: boolean;
  /**
   * Gemma decide runner base URL (Phase 0b / ADAAAA-6880). When set, the media
   * server fires one per-candidate decide POST to `${decideUrl}/app/highlight`
   * (mirroring the server-side DirectAdapter.decide) and on acceptance cuts a
   * clip from the media server's recorded session and reports a typed
   * `highlight` result event back over the observe callback. When unset,
   * candidates are relayed only (no decide fired).
   */
  decideUrl?: string;
  /** Optional bearer token sent as `Authorization: Bearer` on decide calls. */
  decideAuthToken?: string;
  /** Cost of one Gemma decide call (USD) for the `cost` result event (default 0.05). */
  decideFee?: number;
  /** Perceive runner cost (USD/hour) for the `cost` result event (default 0.10). */
  perceivePerHourUsd?: number;
  /** Clip window: seconds before the candidate anchor (default 5). */
  clipBeforeS?: number;
  /** Clip window: seconds after the candidate anchor (default 10). */
  clipAfterS?: number;
  /** Directory where cut highlight clips are written (default <tmpdir>/hl-clips). */
  clipsDir?: string;
  /** ffmpeg binary path used to cut clips (default "ffmpeg"). */
  ffmpegPath?: string;
  /** VOD frame-sampling cadence (fps) default for a MediaJobRequest that does
   *  not carry its own detailFps/sampleFps (Phase 1 / ADAAAA-6866). Default 2. */
  vodSampleFps?: number;
  /** VOD frame-scale string default when a MediaJobRequest omits frameScale. */
  vodFrameScale?: string;
}

const EXT_BY_MIME: Record<string, string> = { "video/webm": "webm", "video/mp4": "mp4" };

const DEFAULT_RECONNECT_GRACE_MS = 8000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MediaServer {
  private active = new Map<string, ActiveStream>(); // keyed by sessionId
  // Pending teardowns during the reconnect grace window (keyed by sessionId).
  private graceTimers = new Map<string, NodeJS.Timeout>();
  // Pending teardowns for provisioned sessions that never got a browser WS.
  private noClientTimers = new Map<string, NodeJS.Timeout>();
  private orch: MediaOrchestrator;
  /** WebRTC ingest JPEG sample cadence (fps) decoded by the media server. */
  private rtcSampleFps: number;
  constructor(private opts: MediaServerOptions, orch?: MediaOrchestrator) {
    this.rtcSampleFps = opts.rtcSampleFps ?? 1;
    this.orch =
      orch ??
      new MediaOrchestrator({
        orchBase: opts.orchBase,
        seedImageB64: opts.seedImageB64,
        signer: opts.signer,
        payerAddress: opts.payerAddress,
        paymentIntervalMs: opts.paymentIntervalMs,
        discoverOrchestrators: opts.discoverOrchestrators,
        // A failed payment refresh closes the stream (release the slot rather
        // than let the runner work for free).
        onPaymentFailure: (sessionId, err) => void this.teardown(sessionId).catch(() => {}),
      });
  }

  async build() {
    const app = Fastify({ logger: false });
    await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

    // Provision a perceive session for a stream. Returns the WS path the
    // browser connects to.
    app.post<{ Body: { jobId?: string } }>("/sessions", async (_, reply) => {
      const p = await this.orch.provision();
      const stream: ActiveStream = {
        streamId: randomUUID(),
        jobId: (_.body?.jobId as string) || "",
        provisioned: p,
        sockets: new Set(),
        closed: false,
      };
      this.active.set(p.sessionId, stream);
      // Relay perceive's persistent-session live analysis data + state to the
      // webapp over this stream's WS sockets, on a capped cadence (not a
      // per-frame firehose). Starts as soon as the stream exists so a VOD/live
      // job gets analysis from the frame-by-frame AnalysisSession without
      // needing an explicit /analyze call; a browser attaching later simply
      // starts receiving on the next tick.
      this.startAnalysisRelay(stream);
      // Pay the orchestrator for as long as the stream is open (no-op offchain).
      this.orch.startPayment(p);
      // Release the slot if the browser never connects (e.g. provision succeeded
      // but the client vanished) — otherwise a reserved slot leaks forever.
      const noClientMs = this.opts.provisionNoClientMs ?? 60000;
      if (noClientMs > 0) {
        this.noClientTimers.set(
          p.sessionId,
          setTimeout(() => {
            this.noClientTimers.delete(p.sessionId);
            void this.teardown(p.sessionId);
          }, noClientMs)
        );
      }
      // Full ingest WS URL (LB/public front), when the operator tells us the
      // public origin. Clients that can't route by LB fall back to wsPath.
      const wsBase = (this.opts.publicBaseUrl || "").replace(/\/$/, "").replace(/^http/, "ws");
      return {
        sessionId: p.sessionId,
        wsPath: `/stream/${p.sessionId}`,
        wsUrl: wsBase ? `${wsBase}/stream/${p.sessionId}` : undefined,
        // WebRTC ingest is enabled: the browser signals via
        // POST /sessions/:sid/rtc/offer + /rtc/ice/:pcId instead of WS frame
        // posting. Older WS clients may still connect to /stream/:sid.
        rtc: true,
        streamId: stream.streamId,
        jobId: stream.jobId,
      };
    });

    // ---- WebRTC ingest signaling (browser -> media server) --------
    // The browser creates the offer and POSTs it; the media server answers as
    // a recvonly video terminus. Decoded frames are published to the
    // orchestrator video-in rail exactly like WS frames (publishAndObserve),
    // so the perceive runner consumes them through the same session.step().
    app.post<{ Params: { sid: string }; Body: { offer?: any } }>(
      "/sessions/:sid/rtc/offer",
      async (req, reply) => {
        const stream = this.active.get(req.params.sid);
        if (!stream || stream.closed) return reply.code(404).send({ error: "no such session" });
        if (!req.body?.offer) return reply.code(400).send({ error: "offer required" });
        if (!stream.rtc) {
          const session = new WebRtcIngestSession({ sampleFps: this.rtcSampleFps });
          // Decoded frames -> orchestrator video-in rail -> observation relay.
          session.on("frame", (f) => {
            void this.publishAndObserve(stream, f.seq, f.jpeg, f.ts).catch((e) =>
              console.error("[media] rtc frame err", e)
            );
          });
          // Peer drop -> normal teardown path (reconnect grace -> release slot).
          session.on("close", () => {
            if (stream.sockets.size === 0) this.armGrace(req.params.sid);
          });
          session.on("error", (e) => console.error("[media] rtc err", e));
          stream.rtc = { pcId: randomUUID(), session };
          // A browser attached via RTC — the no-client timer no longer applies.
          this.clearNoClient(req.params.sid);
        }
        const { session } = stream.rtc;
        try {
          const answer = await session.handleOffer(req.body.offer);
          return { pcId: stream.rtc.pcId, answer };
        } catch (e: any) {
          return reply.code(400).send({ error: String(e?.message || e) });
        }
      }
    );

    app.post<{ Params: { sid: string; pcId: string }; Body: { candidate?: any } }>(
      "/sessions/:sid/rtc/ice/:pcId",
      async (req, reply) => {
        const stream = this.active.get(req.params.sid);
        if (!stream?.rtc || !req.body?.candidate) return reply.code(404).send({ error: "no rtc session" });
        await stream.rtc.session.addIceCandidate(req.body.candidate);
        return { ok: true };
      }
    );

    // Browser streams sampled frames over this WS. The handler receives a
    // SocketStream (a Duplex): read frames as 'data', write observations via
    // .write(). Each WS message arrives as one Buffer data chunk.
    app.get<{ Params: { sid: string } }>("/stream/:sid", { websocket: true }, async (connection, req) => {
      const stream = this.active.get(req.params.sid);
      if (!stream || stream.closed) {
        connection.destroy();
        return;
      }
      stream.sockets.add(connection);
      this.clearGrace(req.params.sid); // a reconnect within the grace window cancels pending teardown
      this.clearNoClient(req.params.sid); // a browser connected, so the no-client timeout is moot
      // A browser attached: kick an immediate state + event relay so the client
      // gets live analysis right away (the capped-cadence timers keep it fresh).
      void this.relayAnalysisState(stream);
      void this.relayAnalysisEvent(stream);
      connection.on("data", (buf: Buffer) => {
        void this.handleFrame(stream, connection, buf).catch((e) => console.error("[media] frame err", e));
      });
      const onClose = () => {
        stream.sockets.delete(connection);
        // No more browsers on this session -> arm the reconnect grace window:
        // a transient browser blip can reconnect to the same sid and resume
        // seamlessly; only after the grace elapses is the slot released.
        if (stream.sockets.size === 0) this.armGrace(req.params.sid);
      };
      // The Duplex 'close' can lag; the underlying ws socket is the reliable
      // signal. teardown is idempotent, so either firing is fine.
      connection.on("close", onClose);
      (connection as any).socket?.on("close", onClose);
    });

    // Control-plane close (e.g. user Stop in the UI).
    app.post<{ Params: { sid: string } }>("/sessions/:sid/close", async (req, reply) => {
      const stream = this.active.get(req.params.sid);
      if (!stream) return reply.code(404).send({ error: "no such session" });
      await this.teardown(req.params.sid);
      return { ok: true };
    });

    // ---- ADAAAA-6739 G2 brokered decide -> perceive requests --------------
    // Decide sends its windowed tool queries and control instructions to the
    // MEDIA SERVER (the natural broker: it provisions/fronts the active
    // perceive session and owns the media session it belongs to). The media
    // server forwards the request to the perceive session's analysis/control
    // endpoint, echoes the request + updated/accepted form + result to the
    // webapp over the bidirectional connection (status "trace" so the webapp
    // relays it to the server for analysis-session tracing), and returns the
    // confirmed result to the caller. A request that targets a session that no
    // longer exists (unknown sid, closed stream, or perceive 404) errors
    // visibly instead of being silently dropped.
    app.post<{ Params: { sid: string }; Body: any }>("/sessions/:sid/analysis/query", async (req, reply) => {
      const stream = this.active.get(req.params.sid);
      if (!stream || stream.closed) return reply.code(404).send({ error: "no such session" });
      const r = await this.brokerForward(stream, "query", req.body ?? {});
      if (!r.ok) return reply.code(r.status ?? 500).send({ error: r.error || "broker query failed" });
      return { ok: true, result: r.result, trace: r.trace };
    });

    app.post<{ Params: { sid: string }; Body: any }>("/sessions/:sid/analysis/control", async (req, reply) => {
      const stream = this.active.get(req.params.sid);
      if (!stream || stream.closed) return reply.code(404).send({ error: "no such session" });
      const r = await this.brokerForward(stream, "control", req.body ?? {});
      if (!r.ok) return reply.code(r.status ?? 500).send({ error: r.error || "broker control failed" });
      return { ok: true, result: r.result, trace: r.trace };
    });

    app.get("/health", async () => ({ status: "ok" }));

    // Phase 0b (ADAAAA-6880): serve cut highlight clips from the media node so
    // a reported highlight clipUri is a real, fetchable URI. Path-traversal
    // guarded: only a bare `<id>.<ext>` filename is resolved inside clipsDir.
    app.get<{ Params: { file: string } }>("/clips/:file", async (req, reply) => {
      const name = path.basename(req.params.file);
      if (name !== req.params.file || !/^[A-Za-z0-9._-]+$/.test(name)) {
        return reply.code(400).send({ error: "invalid clip name" });
      }
      const dir = this.opts.clipsDir || path.join(tmpdir(), "hl-clips");
      const filePath = path.join(dir, name);
      try {
        const { stat } = await import("node:fs/promises");
        const s = await stat(filePath);
        if (!s.isFile()) return reply.code(404).send({ error: "no such clip" });
        reply.type("application/octet-stream");
        return reply.send(await (await import("node:fs/promises")).readFile(filePath));
      } catch {
        return reply.code(404).send({ error: "no such clip" });
      }
    });

    // ---- Phase 1 (ADAAAA-6866): VOD job handoff -------------------------
    // The negotiating server POSTs a MediaJobRequest (source=file/url) to hand
    // the VOD job to the media node. The media node runs the whole VOD path
    // (ffmpeg frame extraction + Stage-A audio tap + perceive session
    // reservation/payment + per-candidate decide + clip cut from the SOURCE
    // file) and reports typed MediaResultEvents back over the callback, plus a
    // final `cost` completion signal. The server stays the DB-owner/biller.
    app.post<{ Body: MediaJobRequest }>("/jobs/vod", async (req, reply) => {
      const parsed = MediaJobRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid MediaJobRequest", issues: parsed.error.issues });
      }
      const jobReq = parsed.data;
      const runner = new MediaVodRunner(this.orch, {
        ffmpegPath: this.opts.ffmpegPath,
        decideUrl: this.opts.decideUrl,
        decideAuthToken: this.opts.decideAuthToken,
        decideFee: this.opts.decideFee,
        perceivePerHourUsd: this.opts.perceivePerHourUsd,
        clipBeforeS: this.opts.clipBeforeS,
        clipAfterS: this.opts.clipAfterS,
        clipsDir: this.opts.clipsDir,
        tmpDir: this.opts.tmpDir,
        publicBaseUrl: this.opts.publicBaseUrl,
        sampleFps: this.opts.vodSampleFps,
        frameScale: this.opts.vodFrameScale,
        report: (jobId, ev) => this.postResultForJob(jobId, ev),
      });
      // Run in the background; the media node reports typed result events (and
      // the final cost/completion) back over the callback.
      void runner
        .run(jobReq)
        .catch((e) => console.error(`[media-vod] job ${jobReq.jobId} failed:`, String(e?.message || e)));
      return { ok: true, jobId: jobReq.jobId };
    });

    return app;
  }

  /** POST a typed MediaResultEvent to the negotiating server for a job. */
  private async postResultForJob(jobId: string, ev: MediaResultEvent): Promise<void> {
    if (!this.opts.callbackBase || !jobId) return;
    try {
      await fetch(`${this.opts.callbackBase}/jobs/${jobId}/observe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ev),
      });
    } catch {
      /* result relay is best-effort */
    }
  }

  private async handleFrame(stream: ActiveStream, socket: any, raw: any) {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    // Option-A transport: the browser streams muxed (video+audio) MediaRecorder
    // chunks ({type:"media", data, mime, seq, timestamp}). The container's PTS
    // is authoritative, so no separate video/audio timestamping is needed. We
    // reassemble the chunks into the session recording for clip-cutting; the
    // steer-to-perceive decode is added on top of the same hook.
    if (msg?.type === "media") {
      this.handleMediaChunk(stream, msg);
      return;
    }
    const { seq, image, timestamp } = msg ?? {};
    if (typeof seq !== "number" || typeof image !== "string" || !image) return;
    const jpeg = Buffer.from(image, "base64");
    if (!jpeg.length) return;
    const ts = typeof timestamp === "number" ? timestamp : seq;

    await this.publishAndObserve(stream, seq, jpeg, ts, socket);
  }

  /**
   * Publish one decoded JPEG to the orchestrator video-in rail and relay the
   * runner's observation back (over any live WS sockets + the control-plane
   * callback). Shared by the WS frame path and the WebRTC ingest path, so both
   * transports feed the perceive runner through the exact same front door.
   */
  private async publishAndObserve(
    stream: ActiveStream,
    seq: number,
    jpeg: Uint8Array,
    ts: number,
    socket?: any
  ) {
    const p = stream.provisioned;
    await this.orch.publishFrame(p, seq, jpeg, ts);

    // Relay the runner's observation (poll briefly; the runner processes
    // video-in asynchronously then publishes events-out at the same seq).
    for (let i = 0; i < 10; i++) {
      const obs = await this.orch.readObservation(p, seq).catch(() => null);
      if (obs) {
        this.relay(stream, socket, obs);
        // Phase 0b (ADAAAA-6880): a perceive candidate published on the
        // events-out rail drives the per-candidate decide + typed result events
        // on the media node. Plain observations keep the legacy bare relay.
        if (this.isCandidate(obs)) {
          void this.handleCandidate(stream, obs);
        } else {
          void this.callback(stream, obs);
        }
        return;
      }
      await sleep(250);
    }
  }

  private relay(stream: ActiveStream, socket: any, obs: any) {
    const payload = JSON.stringify({ type: "observation", observation: obs });
    this.writeSockets(stream, payload);
  }

  /**
   * Start the capped-cadence live-analysis relay for a stream (idempotent):
   * poll perceive's persistent AnalysisSession state ~1/s and a windowed tool
   * (~1/2s) and write the results over the stream's WS sockets with a
   * `type:"analysis"` prefix so the webapp can distinguish them from
   * observations. Best-effort: an unreachable/erroring perceive is logged once
   * per session and retried next cadence — it never breaks frame relay.
   */
  private startAnalysisRelay(stream: ActiveStream) {
    if (this.opts.analysisEnabled === false) return;
    const a = (stream.analysis ??= { lastEventTs: 0 });
    if (a.running) return;
    a.running = true;
    const stateMs = this.opts.analysisStateCadenceMs ?? 1000;
    const eventMs = this.opts.analysisEventCadenceMs ?? 2000;
    a.stateTimer = setInterval(() => void this.relayAnalysisState(stream), stateMs);
    a.eventTimer = setInterval(() => void this.relayAnalysisEvent(stream), eventMs);
  }

  /**
   * Poll perceive's `/analysis/state` and relay the live-analysis state to the
   * webapp. Bounded: once per cadence, and only while a browser socket is
   * attached (no work when nobody is listening).
   */
  private async relayAnalysisState(stream: ActiveStream) {
    if (stream.closed || stream.sockets.size === 0) return;
    const state = await this.analysisFetch(stream, "GET", "/analysis/state");
    if (!state || typeof state !== "object") return;
    if (typeof state.lastTs === "number") (stream.analysis ??= {}).lastTs = state.lastTs;
    this.writeSockets(
      stream,
      JSON.stringify({ type: "analysis", status: "state", state, at: Date.now() })
    );
  }

  /**
   * Query a windowed analysis tool over the un-replayed window and relay the
   * bounded result as an analysis event. One increment per cadence (~1/2s);
   * the perceive side caps points (maxPoints=5) so this is never a firehose.
   */
  private async relayAnalysisEvent(stream: ActiveStream) {
    if (stream.closed || stream.sockets.size === 0) return;
    const a = (stream.analysis ??= { lastEventTs: 0 });
    if (typeof a.lastEventTs !== "number") a.lastEventTs = 0;
    const start = a.lastEventTs;
    const q = `start=${start}&maxPoints=5` + (typeof a.lastTs === "number" ? `&end=${a.lastTs}` : "");
    const envelope = await this.analysisFetch(stream, "POST", `/analysis/get_audio_levels?${q}`);
    if (!envelope || !Array.isArray(envelope?.data)) return;
    const end = typeof envelope?.window?.end === "number" ? envelope.window.end : start;
    a.lastEventTs = Math.max(end, start);
    const event = {
      jobId: stream.jobId,
      sessionId: stream.provisioned.sessionId,
      streamId: stream.streamId,
      timestamp: end,
      kind: "audio_energy",
      data: envelope,
    };
    this.writeSockets(stream, JSON.stringify({ type: "analysis", status: "event", event }));
  }

  /**
   * Fetch a perceive analysis endpoint, sending the `x-session-id` header the
   * runner requires to bind the request to the persistent AnalysisSession.
   * Returns parsed JSON on 200, null on error/404. Best-effort: a transient
   * perceive outage is logged once per session and retried next cadence.
   */
  private async analysisFetch(
    stream: ActiveStream,
    method: "GET" | "POST",
    path: string
  ): Promise<any | null> {
    const appUrl = (stream.provisioned.appUrl || "").replace(/\/$/, "");
    if (!appUrl) return null;
    try {
      const res = await fetch(`${appUrl}${path}`, {
        method,
        headers: { "x-session-id": stream.provisioned.sessionId },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e: any) {
      const a = (stream.analysis ??= {});
      if (!a.warned) {
        a.warned = true;
        console.error(
          "[media] analysis relay: perceive unreachable for stream %s: %s",
          stream.streamId,
          String(e?.message || e)
        );
      }
      return null;
    }
  }

  /**
   * Broker one decide -> perceive request for a stream. Forwards a windowed
   * tool query to the perceive session's `/analysis/{tool}` endpoint (or a
   * control instruction to its `/control` endpoint), builds a timeline-ordered
   * analysis-session trace record {at, jobId, sessionId, streamId, tool,
   * window, request, response, updated}, echoes it to the webapp over the
   * bidirectional connection (type:"analysis", status:"trace") for server-side
   * tracing, and returns the confirmed result. Never silently drops: a
   * perceive failure / missing session surfaces a visible error.
   */
  private async brokerForward(
    stream: ActiveStream,
    kind: "query" | "control",
    payload: any
  ): Promise<{ ok: boolean; status?: number; result?: any; error?: string; trace?: any }> {
    const p = stream.provisioned;
    const appUrl = (p.appUrl || "").replace(/\/$/, "");
    if (!appUrl) return { ok: false, status: 400, error: "perceive app url unavailable" };
    let path: string;
    if (kind === "query") {
      const tool = payload?.tool;
      if (!tool) return { ok: false, status: 400, error: "tool required" };
      const qs = new URLSearchParams();
      if (typeof payload.start === "number") qs.set("start", String(payload.start));
      if (typeof payload.end === "number") qs.set("end", String(payload.end));
      if (typeof payload.maxPoints === "number") qs.set("maxPoints", String(payload.maxPoints));
      path = `/analysis/${tool}${qs.toString() ? `?${qs}` : ""}`;
    } else {
      path = "/control";
    }
    let res: Response;
    try {
      res = await fetch(`${appUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": p.sessionId },
        body: kind === "control" ? JSON.stringify(payload.instruction ?? payload) : undefined,
      });
    } catch (e: any) {
      return { ok: false, status: 502, error: `perceive unreachable: ${String(e?.message || e)}` };
    }
    if (!res.ok) {
      // A 404 (the perceive session no longer exists) is asserted here so the
      // caller returns a VISIBLE error rather than silently dropping the
      // request — the broker contract.
      return { ok: false, status: res.status, error: `perceive returned ${res.status}` };
    }
    let result: any = null;
    try {
      result = await res.json();
    } catch {
      result = null;
    }
    const trace = {
      at: Date.now(),
      jobId: stream.jobId,
      sessionId: p.sessionId,
      streamId: stream.streamId,
      tool: kind === "query" ? payload?.tool : "control",
      window:
        typeof payload?.start === "number" || typeof payload?.end === "number"
          ? { start: payload.start, end: payload.end }
          : undefined,
      request: payload,
      response: result ?? undefined,
      updated: result ?? undefined,
    };
    // Echo the request + updated/accepted form + result to the webapp over the
    // bidirectional connection; the webapp relays it to the server for the
    // analysis-session trace.
    this.writeSockets(stream, JSON.stringify({ type: "analysis", status: "trace", trace }));
    return { ok: true, result, trace };
  }

  /** Write a JSON string to every live WS socket (best-effort per socket). */
  private writeSockets(stream: ActiveStream, payload: string) {
    for (const s of stream.sockets) {
      try {
        s.write(payload);
      } catch {
        /* skip */
      }
    }
  }

  /** Append one muxed MediaRecorder chunk (base64) to the session recording,
   *  in arrival (container timestamp) order. Lazily creates the target file. */
  private handleMediaChunk(stream: ActiveStream, msg: any) {
    if (typeof msg.data !== "string" || !msg.data) return;
    const buf = Buffer.from(msg.data, "base64");
    if (!buf.length) return;
    const mime = typeof msg.mime === "string" ? msg.mime : "video/webm";
    if (!stream.recording) {
      const dir = this.opts.tmpDir || tmpdir();
      mkdirSync(dir, { recursive: true });
      const ext = EXT_BY_MIME[mime] ?? "webm";
      const recPath = path.join(dir, `${stream.provisioned.sessionId}.${ext}`);
      stream.recording = { path: recPath, mime, stream: createWriteStream(recPath, { flags: "a" }) };
    }
    stream.recording.stream.write(buf);
  }

  private async callback(stream: ActiveStream, obs: any) {
    if (!this.opts.callbackBase || !stream.jobId) return;
    try {
      await fetch(`${this.opts.callbackBase}/jobs/${stream.jobId}/observe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(obs),
      });
    } catch {
      /* observe relay is best-effort */
    }
  }

  // ---- Phase 0b (ADAAAA-6880): per-candidate decide + typed result events ----

  /** A perceive observation is a candidate when it is a typed CandidateEvent
   *  (mode of the events-out rail) or carries a candidate envelope. Reuses the
   *  perceive signal (eventType / trigger) rather than a parallel pipeline. */
  private isCandidate(obs: any): boolean {
    if (!obs || typeof obs !== "object") return false;
    if (obs.type === "candidate") return true;
    if (obs.candidate && typeof obs.candidate === "object") return true;
    return false;
  }

  /**
   * Drive one perceive candidate through the decide stage on the media node.
   * Reports a typed `candidate` result event, fires exactly one per-candidate
   * Gemma decide POST to `${decideUrl}/app/highlight`, and on acceptance cuts a
   * clip from the media server's recorded session and reports a typed
   * `highlight` result event (with a real clip URI) plus the decide verdict.
   * Also reports cumulative `stageAMetrics` and `cost` result events.
   * Best-effort: a decide failure never tears the stream down — it is logged
   * and the candidate is tallied as rejected.
   */
  private async handleCandidate(stream: ActiveStream, obs: any) {
    const seq = typeof obs?.seq === "number" ? obs.seq : 0;
    const ts = typeof obs?.timestamp === "number" ? obs.timestamp : 0;
    // Report the candidate first (typed), so the server can surface it even if
    // no decide runner is configured (relay-only mode).
    await this.postResult(stream, {
      type: "candidate",
      seq,
      timestamp: ts,
      candidate: obs as CandidateEvent,
    } satisfies MediaResultEvent);

    // No decide URL configured -> relay-only mode: stop here.
    if (!this.opts.decideUrl) return;

    const p0 = (stream.phase0 ??= {
      totalCandidates: 0,
      accepted: 0,
      rejected: 0,
      latencySamples: [],
      perceivedStartedAt: Date.now(),
    });
    p0.totalCandidates += 1;
    const onLat = obs?.audio?.onsetLatencyS;
    if (typeof onLat === "number" && Number.isFinite(onLat)) p0.latencySamples.push(onLat);

    let decision: any;
    try {
      decision = await this.fireDecide(stream, obs, seq, ts);
    } catch (e: any) {
      console.error("[media] decide failed for stream %s: %s", stream.streamId, String(e?.message || e));
      decision = { isHighlight: false, score: 0 };
    }

    if (decision?.isHighlight) {
      p0.accepted += 1;
      let clipUri = "";
      let clipError: string | undefined;
      try {
        const clip = await this.cutClipFor(stream, ts);
        clipUri = clip.clipUri;
        clipError = clip.error;
      } catch (e: any) {
        clipError = String(e?.message || e);
      }
      const rec: HighlightRecord = {
        id: randomUUID(),
        jobId: stream.jobId,
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
      await this.postResult(stream, {
        type: "highlight",
        seq,
        timestamp: ts,
        highlight: rec,
        decide: decision,
      } satisfies MediaResultEvent);
    } else {
      p0.rejected += 1;
    }

    await this.postResult(stream, {
      type: "stageAMetrics",
      timestamp: ts,
      metrics: this.stageAMetricsSnapshot(p0),
    } satisfies MediaResultEvent);
    await this.postResult(stream, {
      type: "cost",
      timestamp: ts,
      costUsd: this.costUsd(stream, p0),
      perceiveSessionS: (Date.now() - p0.perceivedStartedAt) / 1000,
    } satisfies MediaResultEvent);
  }

  /**
   * Fire the Gemma decide runner for one candidate, mirroring the server-side
   * DirectAdapter.decide POST to `${decideUrl}/app/highlight`. Returns the
   * parsed verdict; throws when the runner is unreachable or answers non-2xx.
   */
  private async fireDecide(
    stream: ActiveStream,
    obs: any,
    _seq: number,
    _ts: number
  ): Promise<{ isHighlight: boolean; score?: number; eventType?: string; reason?: string; outcome?: string; nearMiss?: boolean }> {
    const url = `${(this.opts.decideUrl || "").replace(/\/$/, "")}/app/highlight`;
    const payload: Record<string, unknown> = {
      sessionId: stream.provisioned.sessionId,
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

  /** Cut a highlight clip from the media server's recorded session via ffmpeg.
   *  Returns the clip URI (segment served from /clips) or an error — a missing
   *  recording / cut failure degrades to an explicit clipError (never a silent
   *  empty clipUri, mirroring the server-side cut contract). */
  private async cutClipFor(
    stream: ActiveStream,
    ts: number
  ): Promise<{ clipUri: string; error?: string }> {
    const rec = stream.recording;
    if (!rec) {
      return { clipUri: "", error: "no session recording to cut from" };
    }
    const ext = EXT_BY_MIME[rec.mime] ?? "webm";
    const clipId = randomUUID();
    const clipsDir = this.opts.clipsDir || path.join(tmpdir(), "hl-clips");
    mkdirSync(clipsDir, { recursive: true });
    const outPath = path.join(clipsDir, `${clipId}.${ext}`);
    const startS = Math.max(0, ts - (this.opts.clipBeforeS ?? 5));
    const durationS = Math.max(1, (this.opts.clipAfterS ?? 10) + (this.opts.clipBeforeS ?? 5));
    await exec(this.opts.ffmpegPath || "ffmpeg", [
      "-y",
      "-ss", String(startS),
      "-t", String(durationS),
      "-i", rec.path,
      "-c", "copy",
      "-avoid_negative_ts", "make_zero",
      outPath,
    ]);
    const clipUri = `${(this.opts.publicBaseUrl || "").replace(/\/$/, "")}/clips/${clipId}.${ext}`;
    return { clipUri };
  }

  /** Stage-A metrics snapshot from the per-session accumulator (INC-2 contract:
   *  accepted/rejected/fpRate over the candidates the decide stage judged). */
  private stageAMetricsSnapshot(p0: Phase0Accumulator) {
    const totalCandidates = p0.totalCandidates;
    const accepted = p0.accepted;
    const rejected = p0.rejected;
    const judged = accepted + rejected;
    const fpRate = judged > 0 ? rejected / judged : 0;
    const lat = p0.latencySamples.length
      ? p0.latencySamples.reduce((a, b) => a + b, 0) / p0.latencySamples.length
      : 0;
    const maxLat = p0.latencySamples.length ? Math.max(...p0.latencySamples) : 0;
    const sorted = [...p0.latencySamples].sort((a, b) => a - b);
    const pct = (q: number) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
    return {
      totalCandidates,
      accepted,
      rejected,
      fpRate: Math.round(fpRate * 1000) / 1000,
      meanOnsetLatencyS: Math.round(lat * 1000) / 1000,
      maxOnsetLatencyS: Math.round(maxLat * 1000) / 1000,
      p50LatencyS: Math.round(pct(0.5) * 1000) / 1000,
      p95LatencyS: Math.round(pct(0.95) * 1000) / 1000,
      gemmaFpRate: Math.round(fpRate * 1000) / 1000,
      fpRateWithinBudget: fpRate <= 0.6,
    };
  }

  /** Cost of the Phase 0b pass so far (decide fee X calls + perceive session
   *  time), mirroring the server-side cost model. */
  private costUsd(stream: ActiveStream, p0: Phase0Accumulator): number {
    const decideFee = this.opts.decideFee ?? 0.05;
    const perHour = this.opts.perceivePerHourUsd ?? 0.1;
    const perceiveSessionS = Math.max(0, (Date.now() - p0.perceivedStartedAt) / 1000);
    return Math.round((decideFee * p0.totalCandidates + (perceiveSessionS / 3600) * perHour) * 10000) / 10000;
  }

  /** POST a typed MediaResultEvent to `{callbackBase}/jobs/{jobId}/observe`. */
  private async postResult(stream: ActiveStream, ev: MediaResultEvent) {
    if (!this.opts.callbackBase || !stream.jobId) return;
    try {
      await fetch(`${this.opts.callbackBase}/jobs/${stream.jobId}/observe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ev),
      });
    } catch {
      /* result relay is best-effort */
    }
  }

  /** Start the reconnect grace countdown (replacing any pending one). */
  private armGrace(sid: string) {
    this.clearGrace(sid);
    const ms = this.opts.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    if (ms <= 0) {
      void this.teardown(sid);
      return;
    }
    this.graceTimers.set(
      sid,
      setTimeout(() => {
        this.graceTimers.delete(sid);
        void this.teardown(sid);
      }, ms)
    );
  }

  /** Cancel a pending reconnect-grace teardown (a browser reconnected). */
  private clearGrace(sid: string) {
    const t = this.graceTimers.get(sid);
    if (t) {
      clearTimeout(t);
      this.graceTimers.delete(sid);
    }
  }

  /** Cancel the provisioned-but-no-browser teardown (a browser connected). */
  private clearNoClient(sid: string) {
    const t = this.noClientTimers.get(sid);
    if (t) {
      clearTimeout(t);
      this.noClientTimers.delete(sid);
    }
  }

  /** Stop paying + release the perceive slot. Idempotent. */
  private async teardown(sid: string) {
    this.clearGrace(sid);
    this.clearNoClient(sid);
    const stream = this.active.get(sid);
    if (!stream || stream.closed) return;
    stream.closed = true;
    // Stop the live-analysis relay timers (no more perceived state/event polls).
    if (stream.analysis) {
      if (stream.analysis.stateTimer) clearInterval(stream.analysis.stateTimer);
      if (stream.analysis.eventTimer) clearInterval(stream.analysis.eventTimer);
      stream.analysis = undefined;
    }
    // Close the reassembled muxed recording (flush pending chunk bytes).
    if (stream.recording) {
      try {
        stream.recording.stream.end();
      } catch {
        /* already closed */
      }
      stream.recording = undefined;
    }
    // 1) stop paying (no more ticket refresh). Idempotent.
    this.orch.stopPayment(sid);
    // 2) close any WebRTC ingest terminus (peer + pending decode).
    if (stream.rtc) {
      void stream.rtc.session.close().catch(() => {});
      stream.rtc = undefined;
    }
    // 3) drop remaining sockets.
    for (const s of stream.sockets) {
      try {
        s.destroy();
      } catch {
        /* skip */
      }
    }
    // 3) release the paid slot / perceive session. Target the orchestrator that
    // issued the session via its control URL (correct even when it is not the
    // configured orchBase, e.g. a discovered orchestrator). releaseSession is
    // idempotent and falls back to the session-stop path when no control URL
    // was returned, so an empty control_url can never leave the slot billed.
    await this.orch.releaseSession(stream.provisioned.sessionId, stream.provisioned.controlUrl).catch(() => {});
    this.active.delete(sid);
  }
}
