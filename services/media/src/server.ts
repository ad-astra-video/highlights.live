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
import { WebRtcIngestSession, normalizeRtcSampleFps, FUNDED_LIVE_SAMPLE_FPS } from "./rtc";
import { AudioRelay, type AudioPcmChunk } from "./audio-relay";
import { ObservationRelay, DEFAULT_OBSERVE_DEADLINE_MS, type ObservationFrame } from "./observe-relay";
import { guardStream, safeEnd, safeWrite, sendText } from "./guarded-write";
import type { LifecycleSnapshot } from "./lifecycle";
import { drainOpenSessions, forgetOpenSession, recordOpenSession } from "./sessions-ledger";

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
  /** ADAAAA-7990: the resolved live sampling cadence for THIS session, handed
   *  down by the control plane on `POST /sessions { sampleFps }` (it resolves
   *  it with `resolveSampleFps` / `LIVE_SAMPLE_BASE_FPS`). Absent -> the node
   *  fallback (`rtcSampleFps`, funded 3 fps). */
  sampleFps?: number;
  /** Muxed (video+audio) MediaRecorder chunks reassembled in arrival order.
   *  Lazily created on the first muxed chunk; the container's own PTS is the
   *  authoritative clock for clip cutting AND for feeding the analysis rails. */
  recording?: { path: string; mime: string; stream: WriteStream };
  /** Media-edge audio relay (ADAAAA-7658): resolves the received opus RTP into
   *  ~100 ms mono PCM chunks for the perceive Stage-A gate. Lazily created on
   *  the first audio packet; absent when the stream carries no audio. */
  audioRelay?: AudioRelay;
  /**
   * ADAAAA-7990 (delivery follow-up): the ordered, bounded observation relay for
   * this session. Lazily created on the first published frame. Replaces the
   * per-frame "poll 10x250ms then silently drop" path, which delivered 0.10 obs/s
   * on a 3 fps share (job `8cb6e0a5`) because the serial perceive runner falls
   * behind the arrival cadence.
   */
  observations?: ObservationRelay;
  /**
   * True once ANY client attached (WS socket or RTC offer). Distinguishes a
   * session that carried a stream from an abandoned provision — the presence of
   * a no-client timer is NOT a reliable signal because the timer is disabled in
   * some configurations and removes itself before teardown runs
   * (ADAAAA-7689 F1/AC2).
   */
  everAttached: boolean;
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
  /** WebRTC ingest JPEG sample cadence (fps) — the node-wide FALLBACK used when
   *  a `POST /sessions` caller does not send its own resolved rate. Default:
   *  the funded live baseline, {@link FUNDED_LIVE_SAMPLE_FPS} (3 fps), bounded
   *  by `LIVE_SAMPLE_MAX_FPS` (ADAAAA-7990). The control plane's per-session
   *  `sampleFps` always wins; this default exists so a media-only / degraded
   *  provision cannot silently pin the rail back to 1 fps. */
  rtcSampleFps?: number;
  /** ICE servers (STUN/TURN) for WebRTC ingest. A relay (TURN) candidate gives
   *  the browser a reachable media path when the media server's host candidates
   *  are private container IPs behind the public LB (ADAAAA-7304 finding 4).
   *  Also returned to the browser so both peers use the same relay. */
  rtcIceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  /** Max ms to wait for the answerer's ICE gathering to complete before the
   *  RTC answer is returned (so it carries a reachable candidate). Default 2000. */
  rtcIceGatherTimeoutMs?: number;
  /**
   * ADAAAA-7990 (delivery follow-up): how long (ms) a published frame may take to
   * produce its observation before the relay abandons it. Deliberately the SAME
   * number the control plane's media rail uses to accept a frame
   * (`LIVE_OBSERVE_LAG_BUDGET_S`, default 30 s) — an observation the rail would
   * reject as stale is not worth waiting for. Not a new knob: the media node
   * reads that same env name in `config.ts`.
   */
  observeDeadlineMs?: number;
  /** Node identity published on `/health` + returned by `POST /sessions`
   *  (ADAAAA-6869 Phase 4). Default `media-0`. */
  nodeId?: string;
  /** Advertised concurrent-session capacity (default 1: the perceive runner is
   *  capacity-1). The console compares active sessions against it. */
  maxSessions?: number;
  /** Bearer token gating `GET /node` (per-session detail). Unset => 404, so a
   *  public media origin never exposes session/job ids. */
  healthToken?: string;
  /**
   * Live restart/crash ledger snapshot for `/health` (ADAAAA-7656). With
   * `restart: unless-stopped` the container comes back by itself after an exit,
   * so the plain `status:"ok"` of a freshly restarted process cannot distinguish
   * "recovered once" from "flapping". When the ledger crosses its threshold the
   * snapshot reports `status:"degraded"`; without a ledger the field is omitted
   * (tests and embedders).
   */
  lifecycle?: () => LifecycleSnapshot;
  /** Media-edge opus -> PCM audio relay (ADAAAA-7658). On by default; the
   *  decode uses the ffmpeg already in the media image, bills no GPU, and is
   *  best-effort (a failure never touches the video rail). Set
   *  `{ enabled: false }` to run the relay dark. */
  audioRelay?: { enabled?: boolean; ffmpegBin?: string; maxBacklogBytes?: number };
  /**
   * Adopt an already-provisioned session for the same job instead of reserving
   * a second one (ADAAAA-7689 AC1). Default true.
   *
   * `POST /sessions { jobId }` is called twice on the browser QA path — once by
   * the control plane (`POST /jobs/:id/media`) and once by the harness/browser
   * itself. Without adoption both reserved their own perceive session, so a
   * 24 s browser run billed TWO completed sessions (one used, one idling out on
   * the no-client timer). With adoption the second call returns the SAME
   * session, which is the one the browser then connects to.
   */
  adoptSessionPerJob?: boolean;
  /**
   * Dir holding the open-session ledger (ADAAAA-7700). Defaults to
   * `MEDIA_STATE_DIR` / the OS tmp dir, matching the lifecycle ledger, so the
   * leftover list survives the recreate that killed the sessions.
   */
  stateDir?: string;
}

const EXT_BY_MIME: Record<string, string> = { "video/webm": "webm", "video/mp4": "mp4" };

/** Why a media session ended (ADAAAA-7689 AC3). Forwarded to the control plane
 *  so the browser job's disposition is attributable, not just "it closed". */
export type SessionCloseReason =
  | "client-closed"
  | "control-close"
  | "no-client-timeout"
  | "payment-failure"
  /** ADAAAA-7700: the session died with the media node (restart/crash/recreate).
   *  Reported at boot for every leftover session on the open-session ledger, so
   *  the control plane can fail the browser job with `media-session-lost`
   *  instead of leaving it a bare `failed` / a stale `active`. */
  | "media-node-restart";

const DEFAULT_RECONNECT_GRACE_MS = 8000;

/** ADAAAA-7699: cap on the decoded JPEG attached to an observe callback. The
 *  RTC decoder samples at <=480 px wide (a few tens of KB); this bound keeps a
 *  pathological WS-rail frame from turning the internal callback into a large
 *  upload. Over the cap the observation still relays — only pixels are omitted. */
const MAX_CALLBACK_FRAME_BYTES = 2 * 1024 * 1024;
/** Bound on concurrent audio-chunk POSTs per session (ADAAAA-7658). A slow
 *  control plane must drop audio evidence, never grow a media-node backlog. */
const MAX_AUDIO_POSTS_IN_FLIGHT = 8;

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
  /** Concurrent audio-chunk POSTs in flight, per perceive session id. */
  private audioInFlight = new Map<string, number>();
  /** Provision/lease counters for the capacity/health surface. */
  private counters = {
    provisionAttempts: 0,
    provisionFailures: 0,
    noCapacityFailures: 0,
    /** ADAAAA-7689 AC1: `POST /sessions` calls answered by adopting the live
     *  session of the same job instead of reserving a second perceive slot. */
    provisionReuses: 0,
    sessionsCompleted: 0,
    sessionSeconds: 0,
    /** Sessions torn down before any client ever attached (an abandoned
     *  provision). Counted so a doubled/rejected provision stays visible even
     *  though it is excluded from the completed meter (ADAAAA-7689). */
    sessionsUnused: 0,
    /** Session-closed callbacks POSTed to the control plane. */
    sessionClosedNotifies: 0,
    /** ADAAAA-7700: leftover sessions reported to the control plane at boot
     *  (the sessions a restart/crash took down with it). */
    sessionsLostReported: 0,
    /** ADAAAA-7658 media-edge audio relay: PCM chunks POSTed to the control
     *  plane for perceive /audio, and chunks dropped on backlog/error. */
    audioChunksPosted: 0,
    audioChunksDropped: 0,
    /** Fired audio-gate candidates the control plane reported back. */
    audioTriggerCandidates: 0,
  };
  constructor(private opts: MediaServerOptions, orch?: MediaOrchestrator) {
    // ADAAAA-7990: never default the RTC cadence to 1 fps — 3 fps is the
    // funded live baseline (LIVE_SAMPLE_BASE_FPS). A per-session value from
    // `POST /sessions` overrides this.
    this.rtcSampleFps = normalizeRtcSampleFps(opts.rtcSampleFps ?? FUNDED_LIVE_SAMPLE_FPS);
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
        onPaymentFailure: (sessionId, err) => void this.teardown(sessionId, "payment-failure").catch(() => {}),
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
    app.post<{ Body: { jobId?: string; sampleFps?: number } }>("/sessions", async (_, reply) => {
      this.counters.provisionAttempts++;
      const requestedJobId = typeof _.body?.jobId === "string" ? _.body.jobId : "";
      // ADAAAA-7990: the control plane resolves the live sampling rate (one
      // resolution source: `resolveSampleFps` over `LIVE_SAMPLE_BASE_FPS`,
      // capped by `LIVE_SAMPLE_MAX_FPS`) and hands it down per session. The
      // media node used to ignore it entirely and sample at 1 fps, which is why
      // a browser/screen share delivered 0.91 fps against a funded 3 fps.
      const requestedSampleFps = normalizeRtcSampleFps(
        typeof _.body?.sampleFps === "number" ? _.body.sampleFps : undefined
      );
      // ADAAAA-7689 AC1 — a job owns ONE live session. The browser QA path calls
      // this twice for the same job (control plane `POST /jobs/:id/media`, then
      // the harness/browser itself); reserving twice billed a second perceive
      // session that no client ever joined and that still counted a full
      // no-client timeout of session seconds. Adopt the live session instead so
      // the second call hands back the session the browser actually connects to.
      if (requestedJobId && this.opts.adoptSessionPerJob !== false) {
        const existing = [...this.active.values()].find((s) => !s.closed && s.jobId === requestedJobId);
        if (existing) {
          this.counters.provisionReuses++;
          // A re-provision (control-plane retry, node failover) must still
          // honour the resolved rate the caller just sent, even when the
          // session already exists (ADAAAA-7990).
          existing.sampleFps = requestedSampleFps;
          return this.sessionPayload(existing, true);
        }
      }
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
        jobId: requestedJobId,
        provisioned: p,
        sockets: new Set(),
        closed: false,
        startedAt: Date.now(),
        everAttached: false,
        sampleFps: requestedSampleFps,
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
            void this.teardown(p.sessionId, "no-client-timeout");
          }, noClientMs),
        });
      }
      // ADAAAA-7700: remember the session on the open-session ledger BEFORE any
      // client attaches, so a media-node restart can report every dropped
      // session to the control plane at the next boot.
      this.trackSession(stream);
      return this.sessionPayload(stream);
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
            // ADAAAA-7990: the per-session resolved rate (control plane) wins
            // over the node fallback (funded 3 fps), never the old implicit 1.
            sampleFps: stream.sampleFps ?? this.rtcSampleFps,
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
          // Audio (opus) ingest path: receive + count, relay the raw opus
          // payload as-is into the muxed recording, AND (ADAAAA-7658, Option A)
          // decode it at the media edge into ~100 ms mono int16 PCM chunks that
          // are POSTed to the control plane for perceive `POST /audio`. The
          // decode is ffmpeg (already in the image), no GPU, and best-effort:
          // nothing here can stall the video-in rail.
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
            // rail.
            if (stream.recording && a.payload) {
              // Same guarded-write rule as every other socket/stream write here.
              safeWrite(stream.recording.stream, a.payload, `recording session=${stream.provisioned.sessionId}`, () => {
                stream.recording = undefined;
              });
            }
            // ADAAAA-7658: opus -> PCM at the media edge -> perceive /audio.
            if (this.opts.audioRelay?.enabled !== false && a.payload) {
              const relay = this.ensureAudioRelay(stream);
              relay?.pushPacket(a.payload, a.ts * 1000);
            }
          });
          session.on("error", (e) => console.error("[media] rtc err", e));
          stream.rtc = { pcId: randomUUID(), session };
          // ADAAAA-7990 evidence line: the cadence this session will decode at.
          // eslint-disable-next-line no-console
          console.log(`[rtc] session sid=${req.params.sid} sampleFps=${session.stats().sampleFps}`);
          // A browser attached via RTC — the no-client timer no longer applies.
          stream.everAttached = true;
          this.clearNoClient(req.params.sid);
          this.trackSession(stream);
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
      stream.everAttached = true;
      this.trackSession(stream);
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
      await this.teardown(req.params.sid, "control-close");
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
    // ADAAAA-7656: a policy-restarted process answers /health just like a fresh
    // one, so the restart ledger is what separates "recovered once" from a
    // crash loop. Degraded (not failed) keeps the 200 the box-health routine and
    // the LB probe expect, while the payload stops reading green.
    const lifecycle = this.opts.lifecycle?.();
    return {
      status: lifecycle?.degraded ? "degraded" : "ok",
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
        // ADAAAA-7689 AC1: attempts answered by adopting the job's live session
        // instead of reserving a second perceive session.
        provisionReuses: this.counters.provisionReuses,
      },
      leases: { ...leaseCounts, paying: this.orch.payingCount(), total: activeSessions },
      payment: { onchain: this.orch.paysOnchain(), payingSessions: this.orch.payingCount() },
      cost: {
        basis: "media-node session meter (control plane attributes job.costUsd per node)",
        sessionsCompleted: this.counters.sessionsCompleted,
        sessionSeconds: Number(this.counters.sessionSeconds.toFixed(1)),
        // A provision that never carried a client is NOT billed as a completed
        // session (ADAAAA-7689 AC1/AC2); it stays visible here instead.
        sessionsUnused: this.counters.sessionsUnused,
        sessionClosedNotifies: this.counters.sessionClosedNotifies,
        // ADAAAA-7700: sessions that died with the previous boot and were
        // reported to the control plane as `media-node-restart`.
        sessionsLostReported: this.counters.sessionsLostReported,
      },
      ...(lifecycle
        ? {
            restarts: {
              boots: lifecycle.boots,
              // ADAAAA-7689 AC4: per-boot identity + the running image revision,
              // and the attribution of THIS boot (deploy vs crash vs restart).
              bootId: lifecycle.bootId,
              buildRef: lifecycle.buildRef,
              restartCause: lifecycle.restartCause,
              previousBoot: lifecycle.previousBoot,
              lastStartAt: lifecycle.lastStartAt,
              lastExit: lifecycle.lastExit,
              windowS: lifecycle.windowS,
              threshold: lifecycle.threshold,
              bootsInWindow: lifecycle.bootsInWindow,
              degraded: lifecycle.degraded,
            },
          }
        : {}),
      audio: {
        // ADAAAA-7658 media-edge audio relay evidence (counts only, no ids on
        // the public /health surface).
        chunksPosted: this.counters.audioChunksPosted,
        chunksDropped: this.counters.audioChunksDropped,
        triggerCandidates: this.counters.audioTriggerCandidates,
        sessionsRelaying: [...this.active.values()].filter((s) => !!s.audioRelay && !s.audioRelay.isDisabled).length,
      },
      ...(opts.detail ? { sessions } : {}),
    };
  }

  /**
   * The `POST /sessions` response body for a stream. Shared by the fresh
   * provision path and the adopt path (ADAAAA-7689 AC1) so an adopted session
   * looks exactly like a newly provisioned one to the caller.
   */
  private sessionPayload(stream: ActiveStream, reused = false) {
    const sid = stream.provisioned.sessionId;
    // Full ingest WS URL (LB/public front), when the operator tells us the
    // public origin. Clients that can't route by LB fall back to wsPath.
    const publicBase = (this.opts.publicBaseUrl || "").replace(/\/+$/, "");
    const wsBase = publicBase.replace(/^http/, "ws");
    return {
      sessionId: sid,
      wsPath: `/stream/${sid}`,
      wsUrl: wsBase ? `${wsBase}/stream/${sid}` : undefined,
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
      // ADAAAA-7990: the resolved sampling cadence for this session, so the
      // caller can record/verify it (AC1: resolved sampleFps = 3).
      sampleFps: stream.sampleFps ?? this.rtcSampleFps,
      streamId: stream.streamId,
      jobId: stream.jobId,
      // Node identity so the control plane can attribute this job's Livepeer
      // GPU spend to the media node that carried it (ADAAAA-6869 Phase 4).
      nodeId: this.nodeId,
      maxSessions: this.maxSessions,
      // True when this response adopted an already-provisioned session for the
      // same job instead of reserving a new one (ADAAAA-7689 AC1). Lets the
      // caller tell "I created it" from "I joined the live one".
      reused,
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
   * Publish one decoded JPEG to the orchestrator video-in rail and hand it to the
   * session's ordered observation relay (over any live WS sockets + the
   * control-plane callback). Shared by the WS frame path and the WebRTC ingest
   * path, so both transports feed the perceive runner through the exact same
   * front door.
   *
   * ADAAAA-7990 (delivery follow-up): this used to await the observation inline
   * with a 10 x 250 ms poll and silently DISCARD the frame when the runner had
   * not caught up — the reason a funded-3-fps share delivered 0.10 obs/s. The
   * relay now (a) refuses to publish a frame when the in-flight window is full,
   * so the node never hands the runner frames the rail would reject as stale, and
   * (b) follows the frames it did publish in order with the rail's own lag budget,
   * so a slow runner delays delivery instead of cancelling it.
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
    const relay = this.observeRelay(stream);
    // Publish EVERY decoded frame. go-livepeer's video-in trickle is a strictly
    // ordered stream: a frame we do not publish leaves a permanent HOLE, and the
    // perceive runner's serial subscriber re-requests that seq forever instead of
    // skipping it (measured session `0251b715`: paced publishing never posted
    // idx 4/5, broker `next=4`, runner `GET idx=4 exists?=false` for the rest of
    // the share, 3 observations in 300 s). The backlog is bounded in the relay
    // (oldest undelivered frames expire, counted) instead of at the publish site.
    await this.orch.publishFrame(p, seq, jpeg, ts);
    relay.commit({ seq, ts, jpeg, socket, decodeLatencyMs } satisfies ObservationFrame);
  }

  /**
   * The session's ordered observation relay (lazily created). Delivers in publish
   * order, within the control plane's lag budget, and reports nothing silently:
   * every frame ends up `delivered` or `expired`, and frames never published for
   * lack of an in-flight slot are `refused`.
   */
  private observeRelay(stream: ActiveStream): ObservationRelay {
    if (stream.observations) return stream.observations;
    const deadlineMs = this.opts.observeDeadlineMs ?? DEFAULT_OBSERVE_DEADLINE_MS;
    const fps = stream.sampleFps ?? this.rtcSampleFps;
    stream.observations = new ObservationRelay({
      read: (seq) => this.orch.readObservation(stream.provisioned, seq),
      // Push path (ADAAAA-8004 AC2): tail events-out's live edge. Reading one
      // index per frame cannot outlive go-livepeer's segment retention — measured
      // session `3c6c8920` delivered 9 of 395 frames because `events-out idx=262`
      // answered `exists?=false` against `next=332` for the rest of the share.
      readHead: () => this.orch.readObservation(stream.provisioned, -1),
      emit: (obs, frame) => {
        // Live-detection latency budget (PO): wall time from frame receipt to
        // the observation being published. target 1-5s.
        // eslint-disable-next-line no-console
        console.log(
          `[rtc] obs seq=${frame.seq} liveMs=${Math.round((Date.now() / 1000 - frame.ts) * 1000)} ` +
            `decodeMs=${frame.decodeLatencyMs ?? 0}`
        );
        this.relay(stream, frame.socket, obs);
        // `ts` is the media node's own frame clock (epoch seconds). The control
        // plane's rail dates every decision off it, so it travels with the
        // observation instead of trusting whatever the runner echoed back.
        void this.callback(stream, obs, frame.jpeg, frame.ts);
      },
      deadlineMs,
      sampleFps: fps,
      log: (line) => {
        // eslint-disable-next-line no-console
        console.log(line);
      },
    });
    return stream.observations;
  }

  private relay(stream: ActiveStream, socket: any, obs: any) {
    const payload = JSON.stringify({ type: "observation", observation: obs });
    // Guarded: a socket can be destroyed between the read and the write (the
    // browser dropped between frames). `sendText` skips closed sockets, logs a
    // warn with the session id, and drops the dead socket from the session.
    //
    // TEXT is load-bearing (ADAAAA-7678): @fastify/websocket wraps the peer in a
    // `SocketStream`, whose write path turns a string chunk into a BINARY frame,
    // so a browser receives a Blob and `JSON.parse(e.data)` throws — a healthy
    // relay then reads as "zero observations" to every browser client.
    const label = `ws session=${stream.provisioned.sessionId}`;
    for (const s of stream.sockets) {
      sendText(s, payload, label, () => {
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

  private async callback(stream: ActiveStream, obs: any, jpeg?: Uint8Array, frameTs?: number) {
    if (!this.opts.callbackBase || !stream.jobId) return;
    try {
      // ADAAAA-7699: carry the decoded anchor JPEG with the observation. The
      // media node already holds this frame at publish time, so the control
      // plane can anchor a decide to the exact pixels the trigger fired on
      // without re-opening a session (or falling back to the /ingest rail) to
      // fetch frames. Best-effort and size-bounded: a missing/huge frame only
      // means the control plane records the observation as evidence.
      const frameB64 =
        jpeg && jpeg.length > 0 && jpeg.length <= MAX_CALLBACK_FRAME_BYTES ? Buffer.from(jpeg).toString("base64") : undefined;
      // ADAAAA-7699 fix: stamp the frame clock the media node actually decoded.
      // The runner echoes back the `timestamp` it was handed, but a relayed
      // observation can arrive with a missing/0 timestamp (evidence-only
      // payloads, older runner builds). The control plane's media rail rebases
      // its content clock on the FIRST timestamp it sees and drops a frame whose
      // content time is more than the lag budget behind the wall clock, so a
      // zero timestamp reads as 1970: every frame is dropped as stale and only
      // the tail decide ever runs (0 decides on a live share). The media node is
      // the only party that knows when it decoded this frame, so it stamps it.
      const relayTs =
        typeof frameTs === "number" && Number.isFinite(frameTs) && frameTs > 0 ? frameTs : undefined;
      const body: Record<string, unknown> = { ...obs };
      if (relayTs !== undefined) body.timestamp = relayTs;
      if (typeof body.seq !== "number" && Number.isFinite(Number(obs?.seq))) body.seq = Number(obs?.seq);
      if (frameB64) body.frameB64 = frameB64;
      const res = await fetch(`${this.opts.callbackBase}/jobs/${stream.jobId}/observe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // A rejected callback used to be invisible: the rail then reads as "no
      // observations" while the media node logs a healthy obs line. Surface it
      // (bounded: only non-2xx, and the route's own message).
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        // eslint-disable-next-line no-console
        console.log(
          `[media] observe-callback rejected job=${stream.jobId} seq=${body.seq} status=${res.status} ${detail.slice(0, 120)}`
        );
      }
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.log(`[media] observe-callback failed job=${stream.jobId} seq=${obs?.seq}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  /** Lazily create the per-session opus -> PCM relay (ADAAAA-7658). */
  private ensureAudioRelay(stream: ActiveStream): AudioRelay | null {
    if (stream.audioRelay) return stream.audioRelay;
    if (this.opts.audioRelay?.enabled === false) return null;
    stream.audioRelay = new AudioRelay({
      ffmpegBin: this.opts.audioRelay?.ffmpegBin,
      maxBacklogBytes: this.opts.audioRelay?.maxBacklogBytes,
      sessionId: stream.provisioned.sessionId,
      onChunk: (chunk) => this.forwardAudioChunk(stream, chunk),
    });
    return stream.audioRelay;
  }

  /**
   * POST one decoded ~100 ms PCM chunk to the control plane, which forwards it
   * to perceive `POST /audio` on the SAME session id the video-in rail uses
   * (A2: reuse the existing `{seq, timestamp, samples}` shape, no 4th trickle
   * channel). The live session id travels with the chunk so the control plane
   * never has to guess which runner session the media node paid for.
   *
   * Best-effort by construction: a missing callbackBase/jobId (dev), a slow
   * control plane (bounded in-flight per session) or a failed POST only drops
   * audio evidence — the video rail and its frames/observations are untouched.
   */
  private forwardAudioChunk(stream: ActiveStream, chunk: AudioPcmChunk): void {
    if (!this.opts.callbackBase || !stream.jobId) {
      this.counters.audioChunksDropped++;
      return;
    }
    const sid = stream.provisioned.sessionId;
    const inFlight = this.audioInFlight.get(sid) ?? 0;
    if (inFlight >= MAX_AUDIO_POSTS_IN_FLIGHT) {
      // The gate is ~10 chunks/s; a control plane that falls ~1 s behind is
      // better served by dropping chunk evidence than by growing a backlog on
      // the media node (this path must never become a latency source).
      this.counters.audioChunksDropped++;
      return;
    }
    this.audioInFlight.set(sid, inFlight + 1);
    void fetch(`${this.opts.callbackBase}/jobs/${stream.jobId}/audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seq: chunk.seq,
        timestamp: chunk.timestamp,
        samples: chunk.samples,
        sessionId: sid,
      }),
    })
      .then(async (r) => {
        if (!r.ok) {
          this.counters.audioChunksDropped++;
          return;
        }
        this.counters.audioChunksPosted++;
        const body: any = await r.json().catch(() => null);
        if (body?.candidate) this.counters.audioTriggerCandidates++;
      })
      .catch(() => {
        this.counters.audioChunksDropped++;
      })
      .finally(() => {
        const n = (this.audioInFlight.get(sid) ?? 1) - 1;
        if (n <= 0) this.audioInFlight.delete(sid);
        else this.audioInFlight.set(sid, n);
      });
  }

  /** Start the reconnect grace countdown (replacing any pending one). */
  private armGrace(sid: string) {
    this.clearGrace(sid);
    const ms = this.opts.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    if (ms <= 0) {
      void this.teardown(sid, "client-closed");
      return;
    }
    this.graceTimers.set(sid, {
      at: Date.now() + ms,
      t: setTimeout(() => {
        this.graceTimers.delete(sid);
        void this.teardown(sid, "client-closed");
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

  /**
   * Stop paying + release the perceive slot. Idempotent.
   *
   * `reason` says WHY the session ended, and it is forwarded to the control
   * plane in the session-closed callback (ADAAAA-7689 AC3): the browser job is
   * flipped out of `active` on session close instead of waiting for someone to
   * call `POST /jobs/:id/stop`.
   */
  private async teardown(sid: string, reason: SessionCloseReason = "client-closed") {
    this.clearGrace(sid);
    this.clearNoClient(sid);
    const stream = this.active.get(sid);
    if (!stream || stream.closed) return;
    stream.closed = true;
    // A provisioned session that never got a client is an ABANDONED provision,
    // not a session that carried inference (ADAAAA-7689 F1).
    const neverAttached = !stream.everAttached;
    // Per-node cost meter (ADAAAA-6869 Phase 4): accrue the paid session time
    // this node carried, so the console can attribute Livepeer GPU spend to the
    // node even when the job record itself has not landed yet.
    if (neverAttached) {
      // Excluded from the completed meter: no browser ever connected, so this
      // meter entry would claim a stream this session never carried. It stays
      // visible via `cost.sessionsUnused` so a doubled provision is still
      // observable (ADAAAA-7689 AC1/AC2).
      this.counters.sessionsUnused++;
    } else {
      this.counters.sessionsCompleted++;
      this.counters.sessionSeconds += Math.max(0, (Date.now() - stream.startedAt) / 1000);
    }
    // Close the reassembled muxed recording (flush pending chunk bytes).
    if (stream.recording) {
      // Guarded end(): a destroyed/errored file stream reports its failure
      // asynchronously on 'error', never as a throw (ADAAAA-7591).
      safeEnd(stream.recording.stream, `recording session=${sid}`);
      stream.recording = undefined;
    }
    // Close the media-edge audio relay decoder (ADAAAA-7658). Fire-and-forget:
    // its ffmpeg is a local child process, and teardown must not block on it.
    if (stream.audioRelay) {
      void stream.audioRelay.close().catch(() => {});
      stream.audioRelay = undefined;
    }
    // ADAAAA-7990 (delivery follow-up): report the delivery ledger BEFORE the
    // relay stops. `delivered` vs `published` is the AC1 delivered-rate evidence,
    // so a rail that went quiet is attributable to the runner/relay rather than
    // reading as "zero observations" (the pre-fix failure mode).
    if (stream.observations) {
      // eslint-disable-next-line no-console
      console.log(
        `[rtc] observe session=${stream.provisioned.sessionId} seconds=${Number(
          Math.max(0, (Date.now() - stream.startedAt) / 1000).toFixed(1)
        )} ${stream.observations.summary()}`
      );
      stream.observations.close();
      stream.observations = undefined;
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
    // ADAAAA-7700: this session ended cleanly and its close is reported right
    // below — drop it from the open-session ledger so the next boot's reconcile
    // does not double-report (and mis-attribute) a session that already ended.
    forgetOpenSession(this.opts.stateDir, sid);
    // 4) tell the control plane the job's media session is over (ADAAAA-7689
    // AC3). Before this, a browser job stayed `active` after a clean
    // SESSION_CLOSE until someone called POST /jobs/:id/stop by hand.
    this.notifySessionClosed(stream, reason, neverAttached);
  }

  /**
   * Best-effort `POST {callbackBase}/jobs/{jobId}/media/session-closed`.
   *
   * Fire-and-forget on purpose: teardown must never wait on the control plane
   * (it is on the path that releases a capacity-1 perceive slot), and a missed
   * callback only leaves the job for the next explicit `/jobs/:id/stop` — the
   * pre-7689 behaviour, not a regression.
   */
  private notifySessionClosed(stream: ActiveStream, reason: SessionCloseReason, neverAttached: boolean): void {
    if (!this.opts.callbackBase || !stream.jobId) return;
    // Sessions still live for this job AFTER the one that just closed. The
    // control plane finalizes the job only when this is 0, so a close that
    // belongs to a superseded session cannot end a stream that is still live —
    // and a close of a session the control plane never tracked (a harness that
    // provisioned its own) still ends the job instead of leaking it.
    const liveSessionsForJob = [...this.active.values()].filter((s) => !s.closed && s.jobId === stream.jobId).length;
    const payload = {
      sessionId: stream.provisioned.sessionId,
      jobId: stream.jobId,
      reason,
      liveSessionsForJob,
      // true when no client ever joined (an abandoned provision). Diagnostically
      // useful on the control plane: the job is finalized either way, because a
      // provision-only `/jobs/:id/media` call used to leave the job `active`
      // forever (ADAAAA-7689 F1).
      neverAttached,
      seconds: Number(Math.max(0, (Date.now() - stream.startedAt) / 1000).toFixed(1)),
      nodeId: this.nodeId,
      transport: stream.rtc ? "webrtc" : "ws",
    };
    this.counters.sessionClosedNotifies++;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Same shared bearer that gates GET /node, when configured, so the control
    // plane can reject a spoofed close on a public origin (AC3 guardrail).
    if (this.healthToken) headers.authorization = `Bearer ${this.healthToken}`;
    void fetch(`${this.opts.callbackBase}/jobs/${stream.jobId}/media/session-closed`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }).catch(() => {
      /* best-effort: the job can still be stopped explicitly */
    });
  }

  /**
   * Keep the open-session ledger (ADAAAA-7700) in step with this process: which
   * sessions exist RIGHT NOW, which job each carries, and whether a client ever
   * attached. Rewritten on open/adopt-attach so the next boot can tell the
   * control plane exactly which browser jobs it killed.
   */
  private trackSession(stream: ActiveStream): void {
    recordOpenSession(this.opts.stateDir, {
      sessionId: stream.provisioned.sessionId,
      jobId: stream.jobId,
      startedAt: stream.startedAt,
      transport: stream.rtc ? "webrtc" : stream.sockets.size > 0 ? "ws" : "none",
      everAttached: stream.everAttached,
    });
  }

  /**
   * Boot reconcile (ADAAAA-7700): every session on the ledger at start-up died
   * with the PREVIOUS boot — a recreate/deploy, a crash, or a docker stop — and
   * nothing else tells the control plane. Report each one with
   * `reason: "media-node-restart"` so it fails the browser job with
   * `failureReason: media-session-lost` and the console can say "the media node
   * restarted, reshare" instead of the job silently flipping to `failed`.
   *
   * Bounded retry: on a compose recreate the control plane is usually restarting
   * at the same instant, so the first POST can find it down. Three attempts over
   * ~6 s; if they all fail the server's own boot sweep attributes the stranded
   * job from `media_sessions`, so the outcome is still attributable.
   */
  async reconcileLostSessions(): Promise<{ reported: number; leftover: number }> {
    const leftover = drainOpenSessions(this.opts.stateDir);
    if (!leftover.length) return { reported: 0, leftover: 0 };
    let reported = 0;
    for (const rec of leftover) {
      const seconds = rec.startedAt ? Number(Math.max(0, (Date.now() - rec.startedAt) / 1000).toFixed(1)) : 0;
      const payload = {
        sessionId: rec.sessionId,
        jobId: rec.jobId,
        // The distinct attribution: NOT a user stop, NOT a clean client close.
        reason: "media-node-restart" as SessionCloseReason,
        neverAttached: !rec.everAttached,
        seconds,
        // ADAAAA-7689 (follow-up): the control plane only finalizes on the LAST
        // session for a job. After a restart NOTHING is live, so be explicit
        // instead of relying on its session-id fallback.
        liveSessionsForJob: 0,
        nodeId: this.nodeId,
        transport: rec.transport === "none" ? "ws" : rec.transport,
      };
      // eslint-disable-next-line no-console
      console.log(
        `[media] session-lost job=${rec.jobId || "-"} session=${rec.sessionId} reason=media-node-restart attached=${rec.everAttached}`
      );
      if (!this.opts.callbackBase || !rec.jobId) continue;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.healthToken) headers.authorization = `Bearer ${this.healthToken}`;
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        if (attempt > 0) await sleep(2000);
        try {
          const r = await fetch(`${this.opts.callbackBase}/jobs/${rec.jobId}/media/session-closed`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(2500),
          });
          ok = r.ok;
        } catch {
          /* control plane still starting — retry */
        }
      }
      if (ok) {
        reported++;
        this.counters.sessionsLostReported++;
        this.counters.sessionClosedNotifies++;
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[media] session-lost report FAILED job=${rec.jobId} session=${rec.sessionId}`);
      }
    }
    return { reported, leftover: leftover.length };
  }
}
