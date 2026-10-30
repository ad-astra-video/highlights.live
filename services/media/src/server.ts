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
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { MediaOrchestrator, type ProvisionedSession } from "./orch";
import { WebRtcIngestSession } from "./rtc";
import { guardStream, safeEnd, safeWrite } from "./guarded-write";

interface ActiveStream {
  streamId: string;
  jobId: string;
  provisioned: ProvisionedSession;
  sockets: Set<any>;
  closed: boolean;
  /** When this session was provisioned (ms) — the lease age the health surface
   *  reports (ADAAAA-6869 Phase 4). */
  startedAt: number;
  /** Active WebRTC ingest terminus (present once a browser opens an RTC session). */
  rtc?: { pcId: string; session: WebRtcIngestSession };
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
  /** ICE servers (STUN/TURN) for WebRTC ingest. A relay (TURN) candidate gives
   *  the browser a reachable media path when the media server's host candidates
   *  are private container IPs behind the public LB (ADAAAA-7304 finding 4).
   *  Also returned to the browser so both peers use the same relay. */
  rtcIceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  /** Max ms to wait for the answerer's ICE gathering to complete before the
   *  RTC answer is returned (so it carries a reachable candidate). Default 2000. */
  rtcIceGatherTimeoutMs?: number;
  /** Node identity published on `/health` + returned by `POST /sessions`
   *  (ADAAAA-6869 Phase 4). Default `media-0`. */
  nodeId?: string;
  /** Advertised concurrent-session capacity (default 1: the perceive runner is
   *  capacity-1). The console compares active sessions against it. */
  maxSessions?: number;
  /** Bearer token gating `GET /node` (per-session detail). Unset => 404, so a
   *  public media origin never exposes session/job ids. */
  healthToken?: string;
}

const EXT_BY_MIME: Record<string, string> = { "video/webm": "webm", "video/mp4": "mp4" };

const DEFAULT_RECONNECT_GRACE_MS = 8000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MediaServer {
  private active = new Map<string, ActiveStream>(); // keyed by sessionId
  // Pending teardowns during the reconnect grace window (keyed by sessionId).
  // `at` is the deadline so the health surface can report the lease expiry.
  private graceTimers = new Map<string, { t: NodeJS.Timeout; at: number }>();
  // Pending teardowns for provisioned sessions that never got a browser WS.
  private noClientTimers = new Map<string, { t: NodeJS.Timeout; at: number }>();
  private orch: MediaOrchestrator;
  /** WebRTC ingest JPEG sample cadence (fps) decoded by the media server. */
  private rtcSampleFps: number;
  /** Node identity + advertised capacity (ADAAAA-6869 Phase 4). */
  private nodeId: string;
  private maxSessions: number;
  private healthToken: string | undefined;
  private startedAt = Date.now();
  /** Provision/lease counters for the capacity/health surface. */
  private counters = {
    provisionAttempts: 0,
    provisionFailures: 0,
    noCapacityFailures: 0,
    sessionsCompleted: 0,
    sessionSeconds: 0,
  };
  constructor(private opts: MediaServerOptions, orch?: MediaOrchestrator) {
    this.rtcSampleFps = opts.rtcSampleFps ?? 1;
    this.nodeId = opts.nodeId ?? "media-0";
    this.maxSessions = opts.maxSessions && opts.maxSessions > 0 ? opts.maxSessions : 1;
    this.healthToken = opts.healthToken;
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
    // Browser cross-origin RTC signaling (ADAAAA-7294): the webapp origin
    // (https://highlights-server.dpn.gg) POSTs /sessions/:sid/rtc/offer and
    // /rtc/ice/:pcId to the PUBLIC media origin. Without CORS the browser
    // blocks the preflight (OPTIONS -> 404, no access-control headers) and
    // the offer never round-trips, so a real screen share silently falls back
    // to WS. Mirror the control plane's registration (api.ts: origin: true).
    app.register(cors, { origin: true });
    await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

    // Provision a perceive session for a stream. Returns the WS path the
    // browser connects to.
    app.post<{ Body: { jobId?: string } }>("/sessions", async (_, reply) => {
      this.counters.provisionAttempts++;
      let p: ProvisionedSession;
      try {
        p = await this.orch.provision();
      } catch (e: any) {
        this.counters.provisionFailures++;
        // Capacity exhaustion is the orchestrator's transient saturation signal
        // (capacity-1 perceive runner); count it so the console can show the
        // node as saturated rather than merely "unhealthy" (ADAAAA-6869).
        if (/no capacity available for runner/i.test(String(e?.message ?? e))) {
          this.counters.noCapacityFailures++;
        }
        throw e;
      }
      const stream: ActiveStream = {
        streamId: randomUUID(),
        jobId: (_.body?.jobId as string) || "",
        provisioned: p,
        sockets: new Set(),
        closed: false,
        startedAt: Date.now(),
      };
      this.active.set(p.sessionId, stream);
      // Pay the orchestrator for as long as the stream is open (no-op offchain).
      this.orch.startPayment(p);
      // Release the slot if the browser never connects (e.g. provision succeeded
      // but the client vanished) — otherwise a reserved slot leaks forever.
      const noClientMs = this.opts.provisionNoClientMs ?? 60000;
      if (noClientMs > 0) {
        const at = Date.now() + noClientMs;
        this.noClientTimers.set(p.sessionId, {
          at,
          t: setTimeout(() => {
            this.noClientTimers.delete(p.sessionId);
            void this.teardown(p.sessionId);
          }, noClientMs),
        });
      }
      // Full ingest WS URL (LB/public front), when the operator tells us the
      // public origin. Clients that can't route by LB fall back to wsPath.
      const publicBase = (this.opts.publicBaseUrl || "").replace(/\/+$/, "");
      const wsBase = publicBase.replace(/^http/, "ws");
      return {
        sessionId: p.sessionId,
        wsPath: `/stream/${p.sessionId}`,
        wsUrl: wsBase ? `${wsBase}/stream/${p.sessionId}` : undefined,
        // Public origin the browser uses for the RTC signaling (offer/ICE)
        // POSTs — the browser cannot reach the docker-internal service name,
        // so it must signal to the LB/public front (ADAAAA-7286). When unset,
        // clients fall back to the control plane's own MEDIA_PUBLIC_BASE_URL /
        // MEDIA_SERVER_URL.
        rtcOrigin: publicBase || undefined,
        // WebRTC ingest is enabled: the browser signals via
        // POST /sessions/:sid/rtc/offer + /rtc/ice/:pcId instead of WS frame
        // posting. Older WS clients may still connect to /stream/:sid.
        // ICE/STUN/TURN servers the browser should configure its peer with
        // (same relay the media server gathers with), so the media path can be
        // held instead of the browser reconnect-looping on unreachable host
        // candidates (ADAAAA-7304 finding 4).
        iceServers: this.opts.rtcIceServers,
        rtc: true,
        streamId: stream.streamId,
        jobId: stream.jobId,
        // Node identity so the control plane can attribute this job's Livepeer
        // GPU spend to the media node that carried it (ADAAAA-6869 Phase 4).
        nodeId: this.nodeId,
        maxSessions: this.maxSessions,
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
          const session = new WebRtcIngestSession({
            sampleFps: this.rtcSampleFps,
            iceServers: this.opts.rtcIceServers,
            iceGatherTimeoutMs: this.opts.rtcIceGatherTimeoutMs,
            // Log correlation for the guarded writes (ADAAAA-7591).
            sessionId: req.params.sid,
          });
          // Decoded frames -> orchestrator video-in rail -> observation relay.
          session.on("frame", (f) => {
            // Periodic cadence health log distinguishes "connected but silent"
            // (packets in, no frames) from "no packets at all" (AC: counters).
            const s = session.stats();
            if (f.seq % 30 === 0 || s.framesEmitted === 1) {
              // eslint-disable-next-line no-console
              console.log(
                `[rtc] frame seq=${f.seq} packets=${s.packetsReceived} frames=${s.framesEmitted} latency=${f.latencyMs ?? 0}ms`
              );
            }
            void this.publishAndObserve(stream, f.seq, f.jpeg, f.ts, undefined, f.latencyMs).catch((e) =>
              console.error("[media] rtc frame err", e)
            );
          });
          // Peer drop -> normal teardown path (reconnect grace -> release slot).
          session.on("close", () => {
            if (stream.sockets.size === 0) this.armGrace(req.params.sid);
          });
          // Audio (opus) ingest path: receive + count, and relay the raw opus
          // payload as-is. The media server does NOT assemble audio segments —
          // that is the livepeer_gateway trickle's job (board direction on
          // 7513); the perceive orchestrator trickle contract has no audio rail
          // (only video_in/events_out/control), so audio is surfaced here and
          // counted on the session for the RTC packet/frame counters (AC).
          session.on("audio", (a: { seq: number; packets: number; ts: number; payload: Buffer | undefined }) => {
            if (a.seq === 0 || a.packets === 1 || a.packets % 50 === 0) {
              // eslint-disable-next-line no-console
              console.log(
                `[rtc] audio aseq=${a.seq} audioPackets=${a.packets} payload=${(a.payload?.length ?? 0)}B ts=${a.ts.toFixed(3)}`
              );
            }
            // Forward the raw opus payload to the muxed session recording (the
            // livepeer_gateway trickle's segment-assembly input), so audio is
            // not silently dropped while the video frames go to the video-in
            // rail. Best-effort — the orchestrator has no audio-in endpoint.
            if (stream.recording && a.payload) {
              // Same guarded-write rule as every other socket/stream write here.
              safeWrite(stream.recording.stream, a.payload, `recording session=${stream.provisioned.sessionId}`, () => {
                stream.recording = undefined;
              });
            }
          });
          session.on("error", (e) => console.error("[media] rtc err", e));
          stream.rtc = { pcId: randomUUID(), session };
          // A browser attached via RTC — the no-client timer no longer applies.
          this.clearNoClient(req.params.sid);
        }
        const { session } = stream.rtc;
        try {
          const answer = await session.handleOffer(req.body.offer);
          // AC1: log whether the returned answer carries a candidate the
          // browser can actually reach (relay/srflx vs a private host). A
          // host-only answer means the media path can't be held.
          const cands = String(answer?.sdp || "")
            .split("\r\n")
            .filter((l) => l.startsWith("a=candidate:"));
          const types = [...new Set(cands.map((c) => (c.includes(" typ relay") ? "relay" : c.includes(" typ srflx") ? "srflx" : c.includes(" typ host") ? "host" : "?")))];
          // eslint-disable-next-line no-console
          console.log(`[rtc] offer answered candidates=${cands.length} types=${types.join(",")}`);
          return { pcId: stream.rtc.pcId, answer, iceServers: this.opts.rtcIceServers };
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
      // A browser that reloads / loses its network drops this socket mid-write,
      // and the write below (relay) then fails asynchronously with EPIPE. The
      // guard turns that into a warn + session close instead of an unhandled
      // 'error' that kills the process (ADAAAA-7591).
      guardStream(connection, `ws session=${stream.provisioned.sessionId}`, () => {
        stream.sockets.delete(connection);
        if (stream.sockets.size === 0) this.armGrace(req.params.sid);
      });
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

    // ---------------------------------------------------------------------
    // Capacity / health surface (ADAAAA-6869 Phase 4)
    // ---------------------------------------------------------------------
    // `/health` is PUBLIC (the media origin sits behind the public LB and is
    // polled by the control plane + box health checks). It reports liveness,
    // load and lease COUNTS only — never a session id or job id.
    app.get("/health", async () => this.healthSnapshot());
    // `/node` is the DETAIL surface: per-session ids, job ids, lease expiry, and
    // the per-node cost basis. It carries identifiers, so it is bearer-gated by
    // MEDIA_HEALTH_TOKEN. Unset => disabled (404), never public-by-default.
    app.get("/node", async (req, reply) => {
      if (!this.healthToken) return reply.code(404).send({ error: "node detail disabled (MEDIA_HEALTH_TOKEN unset)" });
      const auth = String((req.headers as any)?.authorization ?? "");
      const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (presented !== this.healthToken) return reply.code(401).send({ error: "unauthorized" });
      return this.healthSnapshot({ detail: true });
    });
    return app;
  }

  /**
   * Capacity/health snapshot. `detail:false` (public `/health`) omits every
   * identifier; `detail:true` (`GET /node`) adds the per-session lease list.
   *
   * Lease states:
   *   - `active`          a browser/peer is attached and frames are flowing
   *   - `grace`           last client dropped, slot held for `reconnectGraceMs`
   *                       so a blip reconnects to the SAME session
   *   - `awaiting-client` provisioned, no browser ever attached yet
   *
   * `cost` is the per-node cost BASIS (completed sessions + paid session
   * seconds on this node). The authoritative money figure per job is the
   * control plane's `job.costUsd`; this node only publishes the meter.
   */
  healthSnapshot(opts: { detail?: boolean } = {}): any {
    const now = Date.now();
    const sessions = [...this.active.values()].map((s) => {
      const grace = this.graceTimers.get(s.provisioned.sessionId);
      const noClient = this.noClientTimers.get(s.provisioned.sessionId);
      const lease = grace
        ? { state: "grace", expiresInS: Math.max(0, Math.round((grace.at - now) / 1000)) }
        : noClient
        ? { state: "awaiting-client", expiresInS: Math.max(0, Math.round((noClient.at - now) / 1000)) }
        : { state: "active", expiresInS: null };
      return {
        sessionId: s.provisioned.sessionId,
        jobId: s.jobId,
        transport: s.rtc ? "webrtc" : "ws",
        ageS: Math.round((now - s.startedAt) / 1000),
        sockets: s.sockets.size,
        recording: !!s.recording,
        paying: this.orch.isPaying(s.provisioned.sessionId),
        lease,
      };
    });
    const leaseCounts = {
      active: sessions.filter((s) => s.lease.state === "active").length,
      grace: sessions.filter((s) => s.lease.state === "grace").length,
      awaitingClient: sessions.filter((s) => s.lease.state === "awaiting-client").length,
    };
    const activeSessions = sessions.length;
    const availableSessions = Math.max(0, this.maxSessions - activeSessions);
    return {
      status: "ok",
      node: { id: this.nodeId, role: "media", uptimeS: Math.round((now - this.startedAt) / 1000) },
      capacity: {
        maxSessions: this.maxSessions,
        activeSessions,
        availableSessions,
        loadPct: this.maxSessions > 0 ? Math.round((activeSessions / this.maxSessions) * 100) : 0,
        saturated: availableSessions === 0,
        provisionAttempts: this.counters.provisionAttempts,
        provisionFailures: this.counters.provisionFailures,
        noCapacityFailures: this.counters.noCapacityFailures,
      },
      leases: { ...leaseCounts, paying: this.orch.payingCount(), total: activeSessions },
      payment: { onchain: this.orch.paysOnchain(), payingSessions: this.orch.payingCount() },
      cost: {
        basis: "media-node session meter (control plane attributes job.costUsd per node)",
        sessionsCompleted: this.counters.sessionsCompleted,
        sessionSeconds: Number(this.counters.sessionSeconds.toFixed(1)),
      },
      ...(opts.detail ? { sessions } : {}),
    };
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
    socket?: any,
    decodeLatencyMs?: number
  ) {
    const p = stream.provisioned;
    await this.orch.publishFrame(p, seq, jpeg, ts);

    // Relay the runner's observation (poll briefly; the runner processes
    // video-in asynchronously then publishes events-out at the same seq).
    for (let i = 0; i < 10; i++) {
      const obs = await this.orch.readObservation(p, seq).catch(() => null);
      if (obs) {
        // Live-detection latency budget (PO): wall time from frame receipt to
        // the observation being published. target 1-5s.
        // eslint-disable-next-line no-console
        console.log(`[rtc] obs seq=${seq} liveMs=${Math.round((Date.now() / 1000 - ts) * 1000)} decodeMs=${decodeLatencyMs ?? 0}`);
        this.relay(stream, socket, obs);
        void this.callback(stream, obs);
        return;
      }
      await sleep(250);
    }
  }

  private relay(stream: ActiveStream, socket: any, obs: any) {
    const payload = JSON.stringify({ type: "observation", observation: obs });
    // Guarded: a socket can be destroyed between the read and the write (the
    // browser dropped between frames). `safeWrite` skips closed sockets, logs a
    // warn with the session id, and drops the dead socket from the session.
    const label = `ws session=${stream.provisioned.sessionId}`;
    for (const s of stream.sockets) {
      safeWrite(s, payload, label, () => {
        stream.sockets.delete(s);
      });
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
      // A file-handle write error (ENOSPC, revoked fd) surfaces the same way as
      // a dead peer — asynchronously, on 'error'. Guard it so a failed recording
      // closes the recorder instead of killing the media process (ADAAAA-7591).
      const rec = stream.recording;
      guardStream(
        rec.stream,
        `recording session=${stream.provisioned.sessionId}`,
        () => {
          if (stream.recording === rec) stream.recording = undefined;
        }
      );
    }
    safeWrite(stream.recording.stream, buf, `recording session=${stream.provisioned.sessionId}`, () => {
      stream.recording = undefined;
    });
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
    this.graceTimers.set(sid, {
      at: Date.now() + ms,
      t: setTimeout(() => {
        this.graceTimers.delete(sid);
        void this.teardown(sid);
      }, ms),
    });
  }

  /** Cancel a pending reconnect-grace teardown (a browser reconnected). */
  private clearGrace(sid: string) {
    const t = this.graceTimers.get(sid);
    if (t) {
      clearTimeout(t.t);
      this.graceTimers.delete(sid);
    }
  }

  /** Cancel the provisioned-but-no-browser teardown (a browser connected). */
  private clearNoClient(sid: string) {
    const t = this.noClientTimers.get(sid);
    if (t) {
      clearTimeout(t.t);
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
    // Per-node cost meter (ADAAAA-6869 Phase 4): accrue the paid session time
    // this node carried, so the console can attribute Livepeer GPU spend to the
    // node even when the job record itself has not landed yet.
    this.counters.sessionsCompleted++;
    this.counters.sessionSeconds += Math.max(0, (Date.now() - stream.startedAt) / 1000);
    // Close the reassembled muxed recording (flush pending chunk bytes).
    if (stream.recording) {
      // Guarded end(): a destroyed/errored file stream reports its failure
      // asynchronously on 'error', never as a throw (ADAAAA-7591).
      safeEnd(stream.recording.stream, `recording session=${sid}`);
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
