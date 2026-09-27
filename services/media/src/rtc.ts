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
}

export interface DecodedFrame {
  seq: number;
  /** End-to-end receive wall-clock timestamp (seconds). Used downstream for
   *  the orchestrator video-in trickle timestamp and the live latency budget. */
  ts: number;
  /** JPEG bytes ready for the video-in rail. */
  jpeg: Buffer;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Map a negotiated codec mimeType to ffmpeg's raw-video demuxer. */
function demuxerFor(mime: string | undefined): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("vp8")) return "vp8";
  if (m.includes("vp9") || m.includes("vp09")) return "vp9";
  return "h264"; // default: H264 (the common WebRTC video codec)
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

  // ---- decode segment state (bounded from the last IDR) ----
  /** SPS/PPS retained across IDR resets so a keyframe segment always decodes. */
  private paramSets?: Buffer[];
  /** Access units (as Annex-B) since the last IDR. */
  private seg: Buffer[] = [];
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
    // Advertise the video codecs we can decode (H264, VP8, VP9) so negotiation
    // lands on a codec the ffmpeg demuxer understands, whatever the browser
    // sends. Without this werift's default config advertises VP8 only.
    const pc = new RTCPeerConnection({
      codecs: {
        video: [useH264(), useVP8(), useVP9({ profile: 0 } as any)],
      },
    } as any);
    this.pc = pc;
    // The server is the answerer and expects to RECEIVE video: declare a
    // recvonly video transceiver so the negotiated answer carries a matching
    // recvonly m-line. The negotiated codec comes from the browser's offer;
    // we detect it on the received track and pick the ffmpeg demuxer to match.
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.onTrack.subscribe((track) => {
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
    await sleep(150); // allow ICE candidates to gather into the local description
    return pc.localDescription as any;
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

  private onRtp(rtp: RtpPacket) {
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
      isIDR = data[0] === 0 || data[0] === 1; // VP8 keyframe S bit; VP9 frame is full.
    }

    if (isIDR) {
      // New keyframe: start a fresh decoding segment.
      this.seg = [];
      this.vclCount = 0;
    }
    const stored = isH264 ? withStartCode(data) : Buffer.from(data);
    // Feed the segment: skip pure parameter/supplemental NALs (they're retained
    // via this.paramSets at the head, so we need not duplicate them per frame).
    this.seg.push(stored);
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

  /** Build the bounded decode segment (SPS/PPS + AUs since last IDR) as Annex-B. */
  private buildSegment(): Buffer {
    const parts: Buffer[] = [];
    if (this.paramSets) for (const p of this.paramSets) parts.push(withStartCode(p));
    if (this.demuxer() !== "h264") {
      // VP8/VP9 raw frame data — feed the raw concatenation directly.
      return Buffer.concat(this.seg);
    }
    for (const au of this.seg) parts.push(au);
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

    if (jpeg && jpeg.length > 2) this.emitFrame(jpeg, ts);
  }

  private emitFrame(jpeg: Buffer, ts: number) {
    if (!jpeg.length || this.closed) return;
    this.emit("frame", { seq: this.seq++, ts, jpeg } satisfies DecodedFrame);
  }

  /** Close the peer. Idempotent. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.pc) {
      try {
        await this.pc.close();
      } catch {
        /* noop */
      }
    }
  }
}
