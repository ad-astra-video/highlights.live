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
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { MediaOrchestrator, type ProvisionedSession } from "./orch";

interface ActiveStream {
  streamId: string;
  jobId: string;
  provisioned: ProvisionedSession;
  sockets: Set<any>;
  closed: boolean;
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
  port?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MediaServer {
  private active = new Map<string, ActiveStream>(); // keyed by sessionId
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
      return {
        sessionId: p.sessionId,
        wsPath: `/stream/${p.sessionId}`,
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
      connection.on("data", (buf: Buffer) => {
        void this.handleFrame(stream, connection, buf).catch((e) => console.error("[media] frame err", e));
      });
      const onClose = () => {
        stream.sockets.delete(connection);
        // No more browsers on this session -> the stream ended.
        if (stream.sockets.size === 0) void this.teardown(req.params.sid);
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

  /** Stop paying + release the perceive slot. Idempotent. */
  private async teardown(sid: string) {
    const stream = this.active.get(sid);
    if (!stream || stream.closed) return;
    stream.closed = true;
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
