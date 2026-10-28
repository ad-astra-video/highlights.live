// WebRTC ingest terminus for the media server.
//
// The browser captures (getDisplayMedia or getUserMedia) and opens a WebRTC
// session to this terminus instead of posting JPEG frames over a WebSocket.
// This module terminates the WebRTC connection (werift), receives the encoded
// video track (H264/VP8/VP9 over RTP), depacketizes complete access units,
// decodes a sampled frame with ffmpeg, and hands the JPEG + ts to a sink
// callback. The sink is the media server's existing orchestrator publish path
// (video-in rail), so the perceive runner consumes frames through the same
// `session.step()` front door — nothing downstream changes.
//
// Decode strategy: ffmpeg will NOT stream decoded frames out of a pipe/file
// while the input stays open (the demuxer probes/blocks and only flushes at
// EOF). So instead of one long-lived ffmpeg, we keep a bounded H264 segment
// (from the last IDR keyframe) and run a short-lived one-shot ffmpeg per
// sample cadence that decodes the segment and writes the single most recent
// frame as JPEG (verified: `-update 1 -frames:v N out.jpg`). This is cheap at
// the 1–5 fps live cadence, matches the repo's existing one-shot ffmpeg style
// (services/server/src/ffmpeg.ts), and is reliable because every invocation
// reaches EOF and flushes.
//
// The media server is the WebRTC "answerer": the browser creates the offer and
// sends it to the server. Signaling is thin HTTP:
//   POST /sessions/:sid/rtc/offer     body: { offer }    -> { answer, pcId }
//   POST /sessions/:sid/rtc/ice/:pcId body: { candidate } -> { ok }
import {
  RTCPeerConnection,
  type RTCSessionDescriptionInit,
  type RtpPacket,
  dePacketizeRtpPackets,
  useH264,
  useVP8,
  useVP9,
  useOPUS,
  type MediaStreamTrack,
} from "werift";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export interface RtcIngestOptions {
  /** ffmpeg binary path (default "ffmpeg"). */
  ffmpegBin?: string;
  /** Target JPEG sample cadence (fps). Default 1.0 (perceive CPU target). */
  sampleFps?: number;
  /** JPEG quality passed to ffmpeg -q:v (2-31; lower = higher quality). Default 5. */
  jpegQuality?: number;
  /** Max longest-side resolution for the decode sample. Default 480. */
  maxWidth?: number;
  /** ICE servers (STUN/TURN) the answerer gathers candidates with. The media
   *  server sits behind the public LB, so its host candidates are private
   *  container IPs unreachable from the browser; a relay (TURN) candidate gives
   *  the browser a reachable path so the DTLS/media path can be held instead of
   *  falling into a ~17s reconnect loop (ADAAAA-7304 finding 4). */
  iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  /** Max ms to wait for the answerer's ICE gathering to complete before
   *  returning the answer, so the answer carries a reachable candidate.
   *  Default 2000. */
  iceGatherTimeoutMs?: number;
}

export interface DecodedFrame {
  seq: number;
  /** End-to-end receive wall-clock timestamp (seconds). Used downstream for
   *  the orchestrator video-in trickle timestamp and the live latency budget. */
  ts: number;
  /** JPEG bytes ready for the video-in rail. */
  jpeg: Buffer;
  /** Ingest latency (ms) from the last RTP packet received to this decoded
   *  JPEG being emitted — the RTC video-in decode leg of the live budget. */
  latencyMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Map a negotiated codec mimeType to ffmpeg's raw-video demuxer. VP8/VP9 have
 *  no native raw-video demuxer in ffmpeg (verified: `-f vp8` / `-f vp9` both
 *  fail with "Unknown input format"), so they are carried in an IVF container
 *  and decoded with `-f ivf`. H264 stays Annex-B (`-f h264`). */
function demuxerFor(mime: string | undefined): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("vp8") || m.includes("vp9") || m.includes("vp09")) return "ivf";
  return "h264"; // default: H264 (the common WebRTC video codec)
}

/** IVF fourCC for a negotiated VP8/VP9 codec. */
function ivfFourcc(mime: string | undefined): string {
  const m = (mime || "").toLowerCase();
  return m.includes("vp9") || m.includes("vp09") ? "VP90" : "VP80";
}

/** 32-byte IVF container header ("DKIF"). Width/height are unknown until
 *  decode, so 0 — ffmpeg's ivf demuxer reads true dimensions from the keyframe
 *  bitstream (verified: an all-zero-dim IVF still decodes and scales via
 *  `scale=min(w,iw):-2`). The numerator/denominator frame-rate pair MUST be
 *  nonzero or ffmpeg rejects the container with "Invalid frame rate". */
function ivfHeader(fourcc: string, frameCount: number): Buffer {
  const h = Buffer.alloc(32);
  h.write("DKIF", 0, "ascii");
  h.writeUInt16LE(0, 4); // version
  h.writeUInt16LE(32, 6); // header length
  h.write(fourcc, 8, "ascii");
  h.writeUInt16LE(0, 12); // width (unknown)
  h.writeUInt16LE(0, 14); // height (unknown)
  h.writeUInt32LE(30, 16); // nominal frame rate (numerator)
  h.writeUInt32LE(1, 20); // ... (denominator)
  h.writeUInt32LE(frameCount, 24);
  return h;
}

/** 12-byte IVF frame record (uint32 size + uint64 PTS) followed by the frame. */
function ivfFrame(data: Buffer, pts: number): Buffer {
  const rec = Buffer.alloc(12);
  rec.writeUInt32LE(data.length, 0);
  rec.writeBigUInt64LE(BigInt(Math.max(0, Math.round(pts))), 4);
  return Buffer.concat([rec, data]);
}

/** True when `data` starts a VP8 keyframe — the frame-tag P bit (bit 0) is 0
 *  (RFC 6386). The old `data[0]===0||1` never matched a real frame tag (a
 *  keyframe tags byte0=0x50), so the decode segment never reset on a keyframe
 *  and grew unboundedly. */
export function isVp8Keyframe(data: Buffer): boolean {
  return data.length > 0 && (data[0] & 0x01) === 0;
}

/** True when `data` starts a VP9 keyframe — frame_marker (low 2 bits) == 0b10
 *  and the keyframe bit (frame_type, bit 2) == 0. Verified on real libvpx-vp9
 *  frames: keyframe byte0=0x82, interframe byte0=0x86. */
export function isVp9Keyframe(data: Buffer): boolean {
  return data.length > 0 && (data[0] & 0x07) === 0x02;
}

/** Split Annex-B into its NAL units (payloads, no start codes). */
function nalUnits(annexb: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i < annexb.length - 3) {
    if (annexb[i] === 0 && annexb[i + 1] === 0 && annexb[i + 2] === 1) {
      let s = i + 3;
      if (annexb[s] === 0 && annexb[s + 1] === 1) s += 1;
      let e = s;
      while (e < annexb.length && !(annexb[e] === 0 && annexb[e + 1] === 0 && (annexb[e + 2] === 1 || annexb[e + 2] === 0))) e++;
      if (e > s) out.push(annexb.subarray(s, e));
      i = e;
    } else i++;
  }
  return out;
}

/** Annex-B start code + one NAL unit. */
function withStartCode(nal: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]);
}

/**
 * One logical WebRTC ingest session backed by a werift RTCPeerConnection and a
 * per-session ffmpeg decode pipeline. Emits `"frame"` (DecodedFrame) for each
 * sampled JPEG and `"error"` / `"ffmpeg"` for diagnostics.
 */
export class WebRtcIngestSession extends EventEmitter {
  pc?: RTCPeerConnection;
  private au: RtpPacket[] = [];
  /** werift's cross-call fragment buffer for fragmented NAL units. */
  private fragment?: Buffer;
  private seq = 0;
  private started = false;
  private closed = false;
  private codecMime = "";
  private activeTrack?: MediaStreamTrack;
  /** Number of RTP packets received through onReceiveRtp (diagnostics). */
  packetsReceived = 0;
  /** Number of decoded JPEG frames emitted on the orchestrator rail. */
  framesEmitted = 0;
  /** Wall-clock ms of the last RTP packet received (decode-latency baseline). */
  private lastPacketAt = 0;
  /** Number of audio (opus) RTP packets received. */
  audioPacketsReceived = 0;
  /** Active audio track (receives raw opus RTP for the audio ingest path). */
  private activeAudioTrack?: MediaStreamTrack;
  /** werift fragment buffer for fragmented audio packets. */
  private audioFragment?: Buffer;
  /** Monotonic seq for emitted audio payloads. */
  private audioSeq = 0;
  /** Wall-clock ms of the last audio RTP packet received. */
  private lastAudioPacketAt = 0;

  // ---- decode segment state (bounded from the last IDR) ----
  /** SPS/PPS retained across IDR resets so a keyframe segment always decodes. */
  private paramSets?: Buffer[];
  /** Access units (as Annex-B for H264 / raw frame for VP8-VP9) since the last
   *  IDR, each with the RTP timestamp used as the IVF PTS. */
  private seg: { data: Buffer; pts: number }[] = [];
  /** Number of VCL (picture) access units in `seg` — used as `-frames:v`. */
  private vclCount = 0;
  /** NAL header byte of the last access unit (to detect VCL / IDR). */
  private lastNalType = -1;
  private lastSampleWall = 0;

  constructor(private opts: RtcIngestOptions = {}) {
    super();
  }

  /** Handle a browser offer, answering (best-effort ICE gathering). */
  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    // Reconnect to the SAME session (transport blip, node still healthy) will
    // POST a fresh offer on this session. Reset all per-connection ingest state
    // (incl. closing the old peer) so the new connection re-subscribes onTrack;
    // otherwise `started` stays true and frames silently stop flowing.
    this.resetConnection();
    // Advertise the video codecs we can decode (H264, VP8, VP9) so negotiation
    // lands on a codec the ffmpeg demuxer understands, whatever the browser
    // sends. Without this werift's default config advertises VP8 only.
    const pc = new RTCPeerConnection({
      codecs: {
        video: [useH264(), useVP8(), useVP9({ profile: 0 } as any)],
        // opus so a browser-typical video+audio offer (`m=video` + `m=audio`,
        // H264 + opus) negotiates instead of failing with "negotiate codecs
        // failed." (ADAAAA-7524). Without an audio codec the answerer advertises
        // no audio m-line and the whole offer is rejected (measure 7512).
        audio: [useOPUS()],
      },
      // A relay (TURN) ICE server gives the answerer a candidate the browser
      // can actually reach when the media server's host candidates are private
      // container IPs behind the public LB (ADAAAA-7304 finding 4). Without it
      // the DTLS/media path cannot be held and the browser reconnect-loops.
      ...(this.opts.iceServers?.length ? { iceServers: this.opts.iceServers } : {}),
    } as any);
    this.pc = pc;
    // The server is the answerer and expects to RECEIVE video: declare a
    // recvonly video transceiver so the negotiated answer carries a matching
    // recvonly m-line. The negotiated codec comes from the browser's offer;
    // we detect it on the received track and pick the ffmpeg demuxer to match.
    pc.addTransceiver("video", { direction: "recvonly" });
    // Recvonly audio transceiver so a video+audio offer negotiates a second
    // (audio) m-line and opus RTP flows to us; without it the audio track is
    // never negotiated (ADAAAA-7524).
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.onTrack.subscribe((track) => {
      // Audio (opus) track: receive + count the RTP, and relay the raw opus
      // payload out as-is ("copy as received"). The perceive orchestrator
      // trickle contract (services/perceive/app/trickle.py) exposes no audio
      // rail — only video_in/events_out/control — so audio segment assembly is
      // the livepeer_gateway trickle's responsibility (board direction on
      // ADAAAA-7513); the media server just ingests + forwards the packets.
      if (track.kind === "audio") {
        this.activeAudioTrack = track;
        track.onReceiveRtp.subscribe((rtp) => {
          this.audioPacketsReceived++;
          this.lastAudioPacketAt = Date.now();
          try {
            const { data } = dePacketizeRtpPackets("OPUS", [rtp], this.audioFragment);
            this.audioFragment = undefined;
            if (data && data.length) {
              this.emit("audio", {
                seq: this.audioSeq++,
                ts: this.lastAudioPacketAt / 1000,
                payload: data,
                packets: this.audioPacketsReceived,
              });
            }
          } catch {
            /* drop a broken audio packet */
          }
        });
        return;
      }
      if (this.started) return;
      this.started = true;
      this.codecMime = track.codec?.mimeType || "";
      this.activeTrack = track;
      track.onReceiveRtp.subscribe((rtp) => {
        try {
          this.onRtp(rtp);
        } catch (e) {
          this.emit("error", e);
        }
      });
    });
    // Surface disconnects so the media server can run its normal teardown
    // (reconnect-grace -> release the perceive slot) when the peer drops.
    (pc.connectionState as any)?.subscribe?.((state: string) => {
      if (state === "closed" || state === "failed") this.emit("close");
    });
    await pc.setRemoteDescription(offer as any);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer as any);
    // Wait for ICE gathering to finish (bounded) so the returned answer
    // actually carries a reachable candidate. Returning before gathering puts
    // no candidate in the answer, so the browser never connects and falls into
    // the ~17s reconnect loop (ADAAAA-7304 finding 4).
    await this.waitForIceGathering(pc);
    return pc.localDescription as any;
  }

  /** Wait (bounded) for the answerer's ICE gathering to complete so the answer
   *  carries a candidate. No-op when already complete. */
  private async waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return;
    const timeout = this.opts.iceGatherTimeoutMs ?? 2000;
    await Promise.race([
      new Promise<void>((resolve) => {
        const check = () => {
          if (pc.iceGatheringState === "complete") resolve();
        };
        check();
        pc.iceGatheringStateChange.subscribe(check);
      }),
      sleep(timeout),
    ]);
  }

  /** Add a remote ICE candidate (trickle). */
  async addIceCandidate(candidate: any): Promise<void> {
    if (!this.pc || !candidate) return;
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      /* tolerate duplicates / late candidates */
    }
  }

  /** Reset ALL per-connection ingest state. Safe to call when idle or before
   *  accepting a fresh offer on an already-connected session (reconnect). */
  private resetConnection() {
    if (this.pc) {
      try {
        void this.pc.close();
      } catch {
        /* noop */
      }
      this.pc = undefined;
    }
    this.au = [];
    this.fragment = undefined;
    this.seq = 0;
    this.started = false;
    this.codecMime = "";
    this.activeTrack = undefined;
    this.paramSets = undefined;
    this.seg = [];
    this.vclCount = 0;
    this.lastNalType = -1;
    this.lastSampleWall = 0;
    this.packetsReceived = 0;
    this.framesEmitted = 0;
    this.lastPacketAt = 0;
    this.audioPacketsReceived = 0;
    this.activeAudioTrack = undefined;
    this.audioFragment = undefined;
    this.audioSeq = 0;
    this.lastAudioPacketAt = 0;
  }

  private onRtp(rtp: RtpPacket) {
    this.packetsReceived++;
    this.lastPacketAt = Date.now();
    this.au.push(rtp);
    if (!rtp.header.marker) return; // more packets in this access unit
    // Access unit complete -> reassemble Annex-B/IVF and schedule a decode.
    try {
      const { data, frameFragmentBuffer } = dePacketizeRtpPackets(this.packetCodec(), this.au, this.fragment);
      this.fragment = frameFragmentBuffer;
      if (data && data.length) this.processAccessUnit(data, rtp.header.timestamp);
    } catch {
      /* drop a broken access unit */
    }
    this.au = [];
  }

  private packetCodec(): "MPEG4/ISO/AVC" | "VP8" | "VP9" {
    const m = this.codecMime.toLowerCase();
    if (m.includes("vp8")) return "VP8";
    if (m.includes("vp9")) return "VP9";
    return "MPEG4/ISO/AVC";
  }

  private demuxer(): string {
    return demuxerFor(this.codecMime);
  }

  /**
   * Ingest one complete access unit. We only ever decode the raw codec stream
   * (Annex-B for H264; raw frame data for VP8/VP9), so boundaries don't matter
   * to us beyond tracking SPS/PPS (retained) and IDR (segment reset).
   */
  private processAccessUnit(data: Buffer, rtpTs: number) {
    const isH264 = this.packetCodec() === "MPEG4/ISO/AVC";
    let isVCL = false;
    let isIDR = false;
    let nalType = -1;

    if (isH264) {
      // Determine the primary NAL type of this access unit for segment bookkeeping.
      const units = nalUnits(data);
      for (const u of units) {
        const t = u[0] & 0x1f;
        if (t === 7) this.paramSets = this.paramSets ? this.paramSets : [u];
        else if (t === 8) {
          this.paramSets = this.paramSets ? [...this.paramSets.filter((p) => (p[0] & 0x1f) !== 8), u] : [u];
        }
      }
      // NAL type of the LAST unit is the slice NAL (the one that starts a frame).
      const last = units[units.length - 1];
      nalType = last ? last[0] & 0x1f : -1;
      isVCL = nalType >= 1 && nalType <= 5;
      isIDR = nalType === 5;
    } else {
      // VP8/VP9: every access unit is a whole frame.
      isVCL = true;
      isIDR = this.packetCodec() === "VP8" ? isVp8Keyframe(data) : isVp9Keyframe(data);
    }

    if (isIDR) {
      // New keyframe: start a fresh decoding segment.
      this.seg = [];
      this.vclCount = 0;
    }
    const stored = isH264 ? withStartCode(data) : Buffer.from(data);
    // Feed the segment: skip pure parameter/supplemental NALs (they're retained
    // via this.paramSets at the head, so we need not duplicate them per frame).
    this.seg.push({ data: stored, pts: rtpTs });
    if (isVCL) this.vclCount++;
    this.lastNalType = nalType;

    // Sample cadence: emit a JPEG at ~sampleFps.
    const sampleFps = this.opts.sampleFps ?? 1;
    const now = Date.now();
    const due = this.lastSampleWall === 0 || now - this.lastSampleWall >= 1000 / sampleFps;
    if (due && isVCL) {
      this.lastSampleWall = now;
      void this.sampleFrame(now / 1000, rtpTs).catch((e) => this.emit("error", e));
    }
  }

  /** Build the bounded decode segment as a single ffmpeg-addressable byte
   *  stream. H264 is Annex-B (SPS/PPS at the head); VP8/VP9 are wrapped in an
   *  IVF container so ffmpeg's `-f ivf` demuxer can decode them. */
  private buildSegment(): Buffer {
    if (this.demuxer() === "ivf") {
      // VP8/VP9: wrap each whole-frame access unit in an IVF frame record.
      const parts: Buffer[] = [ivfHeader(ivfFourcc(this.codecMime), this.seg.length)];
      for (const f of this.seg) parts.push(ivfFrame(f.data, f.pts));
      return Buffer.concat(parts);
    }
    const parts: Buffer[] = [];
    if (this.paramSets) for (const p of this.paramSets) parts.push(withStartCode(p));
    for (const f of this.seg) parts.push(f.data);
    return Buffer.concat(parts);
  }

  /** One-shot ffmpeg decode of the current segment -> single JPEG of the newest frame. */
  private async sampleFrame(ts: number, rtpTs: number): Promise<void> {
    if (this.closed || this.vclCount < 1) return;
    const bin = this.opts.ffmpegBin ?? "ffmpeg";
    const q = this.opts.jpegQuality ?? 5;
    const maxW = this.opts.maxWidth ?? 480;
    const segment = this.buildSegment();
    // NOTE: the comma inside min() must be escaped (`\\,`) or ffmpeg's filter
    // graph parser splits `scale=min(maxW,iw)` into two filters and fails with
    // "No such filter: 'iw):-2'". `scale=min(${maxW}\\,iw):-2` keeps the
    // cap-to-maxWidth intent (no upscaling of small sources).
    const scaleExpr = `scale=min(${maxW}\\,iw):-2`;
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", this.demuxer(), "-i", "pipe:0",
      "-vf", scaleExpr,
      "-frames:v", String(this.vclCount),
      "-f", "mjpeg", "-q:v", String(q),
      "pipe:1",
    ];

    const jpeg = await new Promise<Buffer | null>((resolve) => {
      let done = false;
      const ff: ChildProcessWithoutNullStreams = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
      let out = Buffer.alloc(0);
      let errBuf = "";
      ff.on("error", (e) => {
        if (!done) { done = true; this.emit("ffmpeg", String(e?.message || e)); resolve(null); }
      });
      ff.stdout.on("data", (d: Buffer) => {
        out = Buffer.concat([out, d]);
        // -update 1 emits one JPEG per decoded frame, overwriting; keep the last.
        const idx = out.lastIndexOf(Buffer.from([0xff, 0xd8]));
        if (idx >= 0) out = out.subarray(idx);
      });
      ff.stderr.on("data", (d: Buffer) => {
        const s = String(d);
        if (s && /error|invalid|failed|no frame|broken/i.test(s)) errBuf += s;
      });
      ff.on("close", () => {
        if (done) return;
        done = true;
        // Final JPEG: last SOI..EOI in the stream.
        const soi = out.indexOf(Buffer.from([0xff, 0xd8]));
        const eoi = out.indexOf(Buffer.from([0xff, 0xd9]), Math.max(0, soi));
        if (soi >= 0 && eoi > soi) resolve(out.subarray(soi, eoi + 2));
        else {
          if (errBuf) this.emit("ffmpeg", errBuf.trim().slice(0, 300));
          resolve(null);
        }
      });
      ff.stdin.write(segment);
      ff.stdin.end(); // EOF -> ffmpeg flushes + emits, then closes
    });

    if (jpeg && jpeg.length > 2) {
      const latencyMs = this.lastPacketAt ? Date.now() - this.lastPacketAt : 0;
      this.emitFrame(jpeg, ts, latencyMs);
    }
  }

  private emitFrame(jpeg: Buffer, ts: number, latencyMs?: number) {
    if (!jpeg.length || this.closed) return;
    this.framesEmitted++;
    this.emit("frame", { seq: this.seq++, ts, jpeg, latencyMs } satisfies DecodedFrame);
  }

  /** Live diagnostics for this ingest session (packets in / frames out). */
  stats() {
    return {
      packetsReceived: this.packetsReceived,
      framesEmitted: this.framesEmitted,
      audioPacketsReceived: this.audioPacketsReceived,
      codecMime: this.codecMime,
      started: this.started,
      closed: this.closed,
    };
  }

  /** Close the peer. Idempotent. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    // Diagnostic summary so a connected-but-silent session is distinguishable
    // from "no frames at all" (AC: packet/frame counters on the RTC path).
    // eslint-disable-next-line no-console
    console.log(`[rtc] close codec=${this.codecMime || "?"} packets=${this.packetsReceived} frames=${this.framesEmitted} audioPackets=${this.audioPacketsReceived}`);
    if (this.pc) {
      try {
        await this.pc.close();
      } catch {
        /* noop */
      }
    }
  }
}
