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

interface ActiveStream {
  streamId: string;
  jobId: string;
  provisioned: ProvisionedSession;
  sockets: Set<any>;
  closed: boolean;
  /** Muxed (video+audio) MediaRecorder chunks reassembled in arrival order.
   *  Lazily created on the first muxed chunk; the container's own PTS is the
   *  authoritative clock for clip cutting AND for feeding the analysis rails. */
  recording?: { path: string; mime: string; stream: WriteStream };
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
   * On-chain only: resolves the orchestrator's base64 `net.OrchestratorInfo`
   * protobuf (via gRPC GetOrchestrator) that the signer REQUIRES in
   * `/generate-live-payment`. REQUIRED for the paid path; offchain it is unused.
   */
  orchInfoB64Provider?: () => Promise<string>;
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
  constructor(private opts: MediaServerOptions, orch?: MediaOrchestrator) {
    this.orch =
      orch ??
      new MediaOrchestrator({
        orchBase: opts.orchBase,
        seedImageB64: opts.seedImageB64,
        signer: opts.signer,
        payerAddress: opts.payerAddress,
        paymentIntervalMs: opts.paymentIntervalMs,
        orchInfoB64Provider: opts.orchInfoB64Provider,
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
        streamId: stream.streamId,
        jobId: stream.jobId,
      };
    });

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

    app.get("/health", async () => ({ status: "ok" }));
    return app;
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

    const p = stream.provisioned;
    await this.orch.publishFrame(p, seq, jpeg, ts);

    // Relay the runner's observation (poll briefly; the runner processes
    // video-in asynchronously then publishes events-out at the same seq).
    for (let i = 0; i < 10; i++) {
      const obs = await this.orch.readObservation(p, seq).catch(() => null);
      if (obs) {
        this.relay(stream, socket, obs);
        void this.callback(stream, obs);
        return;
      }
      await sleep(250);
    }
  }

  private relay(stream: ActiveStream, socket: any, obs: any) {
    const payload = JSON.stringify({ type: "observation", observation: obs });
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
    // 2) drop remaining sockets.
    for (const s of stream.sockets) {
      try {
        s.destroy();
      } catch {
        /* skip */
      }
    }
    // 3) release the paid slot / perceive session.
    await this.orch.closeSession(sid).catch(() => {});
    this.active.delete(sid);
  }
}
