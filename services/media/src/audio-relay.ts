// Media-edge audio relay (ADAAAA-7658, Option A approved on ADAAAA-7592).
//
// The WebRTC terminus (`rtc.ts`) already receives the browser's opus RTP and
// emits the raw opus payload per packet. Nothing turned that into a level
// signal, so the perceive Stage-A noise gate (`services/perceive/app/audio_gate.py`)
// never saw audio on the media relay path — the live pipeline sampled blind.
//
// This module carries that audio the rest of the way WITHOUT adding a trickle
// channel, a GPU session, or a native dependency:
//
//   opus packet -> Ogg/Opus repaging -> ffmpeg (already in the media image)
//               -> mono 16 kHz int16 PCM -> fixed ~100 ms chunks
//               -> POST {seq, timestamp, samples} to the control plane, which
//                  forwards it to perceive `POST /audio` on the SAME session id
//                  the video-in rail uses.
//
// The chunk shape, cadence and timestamp semantics mirror
// `services/server/src/live.ts` `audioChunks()` / `chunkPcmBytes()` (A2 in the
// approval): that is the shape perceive's `AudioChunkRequest` already accepts.
//
// Robustness rules (the video rail must never depend on this path):
// - a malformed/empty opus packet is dropped and counted, never thrown;
// - a broken ffmpeg stdin/stdout disables the relay for the session after one
//   logged warning (frames keep flowing);
// - a chunk POST failure is logged once, then the relay keeps decoding (the
//   gate is best-effort evidence, not a gate on the video rail).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { safeWrite } from "./guarded-write";

/** Opus decodes natively at 48 kHz; the gate normalizes RMS so the tap runs at
 *  16 kHz like the server-side tap (`AUDIO_SAMPLE_RATE`). */
export const OPUS_CLOCK_RATE = 48_000;
export const PCM_SAMPLE_RATE = 16_000;
/** Target chunk cadence — 100 ms, same as the server tap. */
export const AUDIO_CHUNK_S = 0.1;
export const CHUNK_SAMPLES = Math.round(PCM_SAMPLE_RATE * AUDIO_CHUNK_S); // 1600
export const CHUNK_BYTES = CHUNK_SAMPLES * 2; // 3200 (int16 mono LE)

/** One audio chunk in the shape perceive `POST /audio` consumes. */
export interface AudioPcmChunk {
  seq: number;
  /** Chunk END timestamp in seconds on the rail's own clock (media relay =
   *  wall clock, matching the video-in frame timestamps on this rail). */
  timestamp: number;
  /** base64 int16 mono little-endian PCM. */
  samples: string;
}

/** Opus packet duration in samples at 48 kHz, parsed from the TOC byte.
 *  RFC 6716 §3.1: config -> frame duration, TOC code -> frame count. Returns 0
 *  for a packet too short to parse (caller drops it). */
export function opusPacketSamples(pkt: Buffer): number {
  if (!pkt || pkt.length < 1) return 0;
  const toc = pkt[0];
  const config = toc >> 3;
  let frameMs: number;
  if (config < 12) frameMs = [10, 20, 40, 60][config & 3];
  else if (config < 16) frameMs = [10, 20][config & 1];
  else frameMs = [2.5, 5, 10, 20][config & 3];
  const code = toc & 3;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else frames = pkt.length > 1 ? pkt[1] & 0x3f : 0;
  if (frames <= 0) return 0;
  return Math.round(frameMs * frames * (OPUS_CLOCK_RATE / 1000));
}

/** True when `pkt` is a plausible opus packet (non-empty and parseable). */
export function isValidOpusPacket(pkt: Buffer | undefined | null): boolean {
  return !!pkt && pkt.length > 0 && opusPacketSamples(pkt) > 0;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    t[i] = r >>> 0;
  }
  return t;
})();

/** Ogg CRC-32 (poly 0x04c11db7, no reflection) required by the ogg demuxer. */
export function oggCrc32(bytes: Buffer): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

/** OpusHead identification header (RFC 7845 §5.1) for `channels` channels. */
export function opusHead(channels = 1, inputSampleRate = OPUS_CLOCK_RATE): Buffer {
  const h = Buffer.alloc(19);
  h.write("OpusHead", 0, "ascii");
  h[8] = 1; // version
  h[9] = Math.max(1, Math.min(2, channels)); // channel count
  h.writeUInt16LE(312, 10); // pre-skip (typical encoder delay)
  h.writeUInt32LE(inputSampleRate, 12);
  h.writeInt16LE(0, 16); // output gain
  h[18] = 0; // mapping family 0 (mono/stereo)
  return h;
}

/** Empty OpusTags comment header (RFC 7845 §5.2) — the demuxer requires it. */
export function opusTags(): Buffer {
  const vendor = Buffer.from("highlights-media", "ascii");
  const h = Buffer.alloc(16);
  h.write("OpusTags", 0, "ascii");
  h.writeUInt32LE(vendor.length, 8);
  const tail = Buffer.alloc(4); // zero user comments
  return Buffer.concat([h, vendor, tail]);
}

/** Deterministic stream serial for the repager (per ffmpeg instance). */
export const OGG_SERIAL = 0x686c6d31; // "hlm1"

/**
 * Build one Ogg page carrying a single complete packet. One packet per page is
 * what makes a live pipe decode: ffmpeg's ogg demuxer emits decoded audio as
 * each page arrives (verified against ffmpeg in the media image's package).
 */
export function oggPage(packet: Buffer, granulePos: number, pageSeq: number, headerType = 0, serial = OGG_SERIAL): Buffer {
  const segs: number[] = [];
  let rem = packet.length;
  while (rem >= 255) {
    segs.push(255);
    rem -= 255;
  }
  segs.push(rem);
  const segTable = Buffer.from(segs);
  const header = Buffer.alloc(27);
  header.write("OggS", 0, "ascii");
  header[4] = 0; // stream structure version
  header[5] = headerType; // 0x02 = beginning of stream, 0x00 = continuation/normal
  header.writeBigUInt64LE(BigInt(Math.max(0, Math.round(granulePos))), 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(pageSeq >>> 0, 18);
  header.writeUInt32LE(0, 22); // CRC placeholder
  header[26] = segTable.length;
  const page = Buffer.concat([header, segTable, packet]);
  page.writeUInt32LE(oggCrc32(page), 22);
  return page;
}

/**
 * Repage raw opus packets (RTP payloads) into a live Ogg/Opus byte stream for
 * `ffmpeg -f ogg -i pipe:0`. Stateful: emits the two header pages once (on the
 * first packet, whose TOC tells us the channel count) then one page per packet
 * with a monotonic granule position derived from the packet durations.
 */
export class OggOpusRepager {
  private started = false;
  private granule = 0;
  private pageSeq = 0;
  /** Packets dropped because they were not parseable opus. */
  droppedPackets = 0;
  /** Packets repaged into the stream. */
  repagedPackets = 0;

  constructor(private readonly serial: number = OGG_SERIAL) {}

  /** Feed one opus packet. Returns the bytes to write to ffmpeg (possibly
   *  empty when the packet is dropped). Never throws. */
  push(packet: Buffer | undefined | null): Buffer {
    if (!isValidOpusPacket(packet)) {
      this.droppedPackets++;
      return Buffer.alloc(0);
    }
    const pkt = packet as Buffer;
    const out: Buffer[] = [];
    if (!this.started) {
      // TOC bit 2 is the stereo flag: the header must declare the real channel
      // count or ffmpeg misdecodes the stream.
      const channels = (pkt[0] & 0x04) !== 0 ? 2 : 1;
      out.push(oggPage(opusHead(channels, OPUS_CLOCK_RATE), 0, this.pageSeq++, 0x02, this.serial));
      out.push(oggPage(opusTags(), 0, this.pageSeq++, 0x00, this.serial));
      this.started = true;
    }
    this.granule += opusPacketSamples(pkt);
    out.push(oggPage(pkt, this.granule, this.pageSeq++, 0x00, this.serial));
    this.repagedPackets++;
    return out.length === 1 ? out[0] : Buffer.concat(out);
  }

  /** True once the header pages have been emitted. */
  get headerSent(): boolean {
    return this.started;
  }
}

/**
 * Split a decoded mono int16 PCM byte stream into fixed-size ~100 ms chunks.
 *
 * Timestamps are the chunk END on the caller's clock (`markMs` = wall-clock ms
 * of the newest packet folded into the chunk), clamped monotonic so a clock
 * step can never make the gate see time go backwards. Trailing partial bytes
 * stay buffered for the next stdout read (same contract as `chunkPcmBytes`).
 */
export class PcmChunker {
  private buf: Buffer = Buffer.alloc(0);
  private seq = 0;
  private lastTs = -Infinity;
  private markedMs = 0;

  constructor(
    private readonly chunkBytes: number = CHUNK_BYTES,
    private readonly chunkSec: number = AUDIO_CHUNK_S
  ) {}

  /** Note the wall-clock time of the newest packet that entered the decoder;
   *  the next emitted chunk is stamped with it (chunk end). */
  mark(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.markedMs = ms;
  }

  /** Feed decoded PCM bytes; returns every complete chunk now available. */
  push(bytes: Buffer): AudioPcmChunk[] {
    if (!bytes || bytes.length === 0) return [];
    this.buf = this.buf.length ? Buffer.concat([this.buf, bytes]) : bytes;
    const out: AudioPcmChunk[] = [];
    while (this.buf.length >= this.chunkBytes) {
      const chunk = this.buf.subarray(0, this.chunkBytes);
      this.buf = this.buf.subarray(this.chunkBytes);
      out.push(this.emit(chunk));
    }
    return out;
  }

  private emit(chunk: Buffer): AudioPcmChunk {
    const clockTs = this.markedMs > 0 ? this.markedMs / 1000 : NaN;
    // Prefer the packet clock (aligns the trigger with video-in frame
    // timestamps); fall back to chunk cadence when no packet time is known.
    const candidate = Number.isFinite(clockTs) ? clockTs : this.lastTs === -Infinity ? this.chunkSec : this.lastTs + this.chunkSec;
    const timestamp = Math.max(candidate, this.lastTs === -Infinity ? candidate : this.lastTs + 1e-3, 0);
    this.lastTs = timestamp;
    return { seq: this.seq++, timestamp, samples: chunk.toString("base64") };
  }

  /** Bytes held back waiting for the next read (diagnostics/tests). */
  get bufferedBytes(): number {
    return this.buf.length;
  }
}

export interface AudioRelayOptions {
  /** ffmpeg binary (the media image ships one). Default "ffmpeg". */
  ffmpegBin?: string;
  /** Deliver a decoded chunk; must not throw (errors are swallowed/logged). */
  onChunk: (chunk: AudioPcmChunk) => void | Promise<void>;
  /** Session id for log correlation only (never logged with audio content). */
  sessionId?: string;
  /** Hard bound on the decoder's stdin backlog before packets are dropped. */
  maxBacklogBytes?: number;
}

/**
 * Per-session opus -> PCM relay. Lazily spawns one ffmpeg (no GPU, no network
 * on the decode path) and emits ~100 ms mono int16 chunks.
 */
export class AudioRelay {
  private readonly ffmpegBin: string;
  private readonly repager = new OggOpusRepager();
  private readonly chunker = new PcmChunker();
  private readonly maxBacklogBytes: number;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private closed = false;
  private disabled = false;
  /** Packets received from RTP (incl. dropped ones). */
  packetsReceived = 0;
  /** Packets dropped (malformed / decoder backlog). */
  packetsDropped = 0;
  /** Chunks emitted to `onChunk`. */
  chunksEmitted = 0;
  /** PCM bytes decoded. */
  pcmBytes = 0;

  constructor(private readonly opts: AudioRelayOptions) {
    this.ffmpegBin = opts.ffmpegBin ?? "ffmpeg";
    this.maxBacklogBytes = opts.maxBacklogBytes ?? 1024 * 1024;
  }

  private label(): string {
    return `audio-relay session=${this.opts.sessionId || "?"}`;
  }

  private start(): void {
    if (this.proc || this.disabled || this.closed) return;
    const proc = spawn(this.ffmpegBin, [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "ogg",
      "-i", "pipe:0",
      "-ac", "1",
      "-ar", String(PCM_SAMPLE_RATE),
      "-f", "s16le",
      "pipe:1",
    ]);
    this.proc = proc;
    proc.stderr.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.warn(`[media] ${this.label()} ffmpeg: ${msg.slice(0, 300)}`);
    });
    proc.stdout.on("data", (d: Buffer) => {
      this.pcmBytes += d.length;
      for (const chunk of this.chunker.push(d)) {
        this.chunksEmitted++;
        try {
          void Promise.resolve(this.opts.onChunk(chunk)).catch(() => {});
        } catch {
          /* the consumer must never break the decoder */
        }
      }
    });
    proc.on("error", (e: Error) => {
      // No ffmpeg on PATH (dev/laptop) — disable cleanly, the video rail is
      // unaffected. One log line, not one per packet.
      console.warn(`[media] ${this.label()} disabled: ${String(e?.message || e)}`);
      this.disabled = true;
      this.proc = null;
    });
    proc.on("close", () => {
      if (!this.closed && !this.disabled) {
        console.warn(`[media] ${this.label()} decoder exited`);
      }
      this.proc = null;
    });
  }

  /** Feed one received opus packet (raw RTP payload after depacketization). */
  pushPacket(payload: Buffer | undefined | null, wallMs = Date.now()): void {
    if (this.closed || this.disabled) return;
    this.packetsReceived++;
    if (!isValidOpusPacket(payload)) {
      this.packetsDropped++;
      return;
    }
    this.start();
    const proc = this.proc;
    if (!proc || !proc.stdin.writable) {
      this.packetsDropped++;
      return;
    }
    if (proc.stdin.writableLength > this.maxBacklogBytes) {
      // Decoder is behind the network: drop rather than buffer unboundedly.
      this.packetsDropped++;
      return;
    }
    this.chunker.mark(wallMs);
    const page = this.repager.push(payload);
    if (page.length === 0) {
      this.packetsDropped++;
      return;
    }
    safeWrite(proc.stdin, page, this.label(), () => {
      this.disabled = true;
      this.proc = null;
    });
  }

  /** Stop the decoder and flush. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      proc.once("close", done);
      proc.once("error", done);
      // A decoder that will not exit must not hold the teardown path.
      setTimeout(done, 1000).unref?.();
    });
    if (!proc.killed) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  get isDisabled(): boolean {
    return this.disabled;
  }
}
