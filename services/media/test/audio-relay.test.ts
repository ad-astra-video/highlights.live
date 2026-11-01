// Media-edge audio relay (ADAAAA-7658).
//
// Unit coverage for the pieces that turn the browser's opus RTP into the
// `{seq, timestamp, samples}` chunks perceive `POST /audio` consumes, plus a
// real ffmpeg end-to-end run (the media image ships ffmpeg; the test is skipped
// when the binary is missing, e.g. a bare CI image).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AudioRelay,
  CHUNK_BYTES,
  CHUNK_SAMPLES,
  OggOpusRepager,
  PcmChunker,
  oggCrc32,
  oggPage,
  opusHead,
  opusPacketSamples,
  isValidOpusPacket,
  type AudioPcmChunk,
} from "../src/audio-relay";

const hasFfmpeg = (() => {
  try {
    return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

// --- opus packet helpers ----------------------------------------------------
const TOC = (config: number, code: number, stereo = false) => (config << 3) | (stereo ? 0x04 : 0) | code;

function packet(config: number, code: number, payloadLen = 40, stereo = false): Buffer {
  const b = Buffer.alloc(payloadLen);
  b[0] = TOC(config, code, stereo);
  if (code === 3 && payloadLen > 1) b[1] = 3; // frame count for the arbitrary code
  return b;
}

/** Split Ogg page bodies into packets by lacing (segment < 255 ends a packet). */
function packetsFromOgg(buf: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let off = 0;
  let cur: Buffer[] = [];
  while (off + 27 <= buf.length && buf.toString("ascii", off, off + 4) === "OggS") {
    const nsegs = buf[off + 26];
    const segs = [...buf.subarray(off + 27, off + 27 + nsegs)];
    let bodyLen = 0;
    for (const s of segs) bodyLen += s;
    const body = buf.subarray(off + 27 + nsegs, off + 27 + nsegs + bodyLen);
    let bOff = 0;
    for (const s of segs) {
      cur.push(body.subarray(bOff, bOff + s));
      bOff += s;
      if (s < 255) {
        packets.push(Buffer.concat(cur));
        cur = [];
      }
    }
    off += 27 + nsegs + bodyLen;
  }
  return packets;
}

describe("opusPacketSamples (TOC duration parse)", () => {
  it("decodes the common CELT/SILK durations at 48 kHz", () => {
    // config 16 = CELT 2.5 ms -> 120 samples; config 19 = CELT 20 ms -> 960
    expect(opusPacketSamples(packet(16, 0))).toBe(120);
    expect(opusPacketSamples(packet(19, 0))).toBe(960);
    // config 1 = SILK 20 ms -> 960; config 3 = SILK 60 ms -> 2880
    expect(opusPacketSamples(packet(1, 0))).toBe(960);
    expect(opusPacketSamples(packet(3, 0))).toBe(2880);
  });

  it("accounts for the frame-count code", () => {
    expect(opusPacketSamples(packet(19, 1))).toBe(1920); // 2 equal frames
    expect(opusPacketSamples(packet(19, 2))).toBe(1920); // 2 different frames
    const arbitrary = packet(19, 3);
    arbitrary[1] = 4;
    expect(opusPacketSamples(arbitrary)).toBe(3840);
  });

  it("returns 0 for an unparseable/empty packet", () => {
    expect(opusPacketSamples(Buffer.alloc(0))).toBe(0);
    expect(isValidOpusPacket(Buffer.alloc(0))).toBe(false);
    expect(isValidOpusPacket(undefined)).toBe(false);
    const zeroFrames = packet(19, 3);
    zeroFrames[1] = 0;
    expect(isValidOpusPacket(zeroFrames)).toBe(false);
  });
});

describe("oggPage (container framing)", () => {
  it("writes a valid Ogg page (magic, lacing, CRC-verified)", () => {
    const pkt = packet(19, 0, 300);
    const page = oggPage(pkt, 960, 7, 0x00, 0xabcddcba);
    expect(page.toString("ascii", 0, 4)).toBe("OggS");
    expect(page.readUInt32LE(14)).toBe(0xabcddcba);
    expect(page.readUInt32LE(18)).toBe(7);
    expect(page.readBigUInt64LE(6)).toBe(960n);
    // 300-byte packet -> lacing [255, 45]
    expect(page[26]).toBe(2);
    expect([...page.subarray(27, 29)]).toEqual([255, 45]);
    expect(page.length).toBe(27 + 2 + 300);
    // CRC must verify with the field zeroed (the demuxer rejects a bad CRC).
    const copy = Buffer.from(page);
    copy.writeUInt32LE(0, 22);
    expect(page.readUInt32LE(22)).toBe(oggCrc32(copy));
  });

  it("builds a mono/stereo OpusHead with the real channel count", () => {
    expect(opusHead(1).toString("ascii", 0, 8)).toBe("OpusHead");
    expect(opusHead(1)[9]).toBe(1);
    expect(opusHead(2)[9]).toBe(2);
    expect(opusHead(9)[9]).toBe(2); // clamped to the family-0 max
  });
});

describe("OggOpusRepager (RTP packets -> live Ogg stream)", () => {
  it("emits the header pages once, then one page per packet with monotonic granule", () => {
    const r = new OggOpusRepager();
    const first = r.push(packet(19, 0));
    expect(r.headerSent).toBe(true);
    expect(first.toString("ascii", 0, 4)).toBe("OggS");
    // header + tags + packet = 3 pages in the first push
    expect(first.toString("ascii").split("OggS").length - 1).toBe(3);
    const second = r.push(packet(19, 0));
    expect(second.toString("ascii").split("OggS").length - 1).toBe(1);
    // granule grows by the packet duration (960 @ 20 ms)
    const granule = second.readBigUInt64LE(6);
    expect(granule).toBe(1920n);
    expect(r.repagedPackets).toBe(2);
  });

  it("drops malformed packets instead of corrupting the stream", () => {
    const r = new OggOpusRepager();
    expect(r.push(Buffer.alloc(0)).length).toBe(0);
    expect(r.push(undefined).length).toBe(0);
    const zeroFrames = packet(19, 3);
    zeroFrames[1] = 0;
    expect(r.push(zeroFrames).length).toBe(0);
    expect(r.droppedPackets).toBe(3);
    // a valid packet still starts the stream after the drops
    expect(r.push(packet(19, 0)).length).toBeGreaterThan(0);
    expect(r.headerSent).toBe(true);
  });

  it("declares stereo when the TOC stereo bit is set", () => {
    const r = new OggOpusRepager();
    const out = r.push(packet(19, 0, 40, true));
    // OpusHead lives in the body of the first page (after the 27-byte header
    // and its segment table).
    const headOffset = 27 + out[26];
    expect(out.toString("ascii", headOffset, headOffset + 8)).toBe("OpusHead");
    expect(out[headOffset + 9]).toBe(2);
  });
});

describe("PcmChunker (chunk alignment + monotonic seq/timestamp)", () => {
  it("emits fixed 100 ms int16 chunks with end timestamps", () => {
    const c = new PcmChunker();
    c.mark(10_000);
    const chunks = c.push(Buffer.alloc(CHUNK_BYTES * 3));
    expect(chunks).toHaveLength(3);
    expect(chunks.map((x) => x.seq)).toEqual([0, 1, 2]);
    expect(CHUNK_SAMPLES).toBe(1600);
    for (const ch of chunks) {
      expect(Buffer.from(ch.samples, "base64").length).toBe(CHUNK_BYTES);
    }
    // all three carry the packet clock, clamped strictly increasing
    expect(chunks[0].timestamp).toBe(10);
    expect(chunks[1].timestamp).toBeGreaterThan(chunks[0].timestamp);
    expect(chunks[2].timestamp).toBeGreaterThan(chunks[1].timestamp);
  });

  it("holds back a trailing partial chunk (and carries it into the next read)", () => {
    const c = new PcmChunker();
    c.mark(1000);
    expect(c.push(Buffer.alloc(CHUNK_BYTES + 7))).toHaveLength(1);
    expect(c.bufferedBytes).toBe(7);
    c.mark(1100);
    const next = c.push(Buffer.alloc(CHUNK_BYTES - 7));
    expect(next).toHaveLength(1);
    expect(next[0].seq).toBe(1);
    expect(c.bufferedBytes).toBe(0);
  });

  it("never lets a clock step make timestamps go backwards", () => {
    const c = new PcmChunker();
    c.mark(5000);
    const a = c.push(Buffer.alloc(CHUNK_BYTES))[0];
    c.mark(4000); // clock regression (NTP step)
    const b = c.push(Buffer.alloc(CHUNK_BYTES))[0];
    expect(b.timestamp).toBeGreaterThan(a.timestamp);
  });

  it("returns nothing for an empty read", () => {
    expect(new PcmChunker().push(Buffer.alloc(0))).toEqual([]);
  });
});

describe("AudioRelay (real ffmpeg end-to-end opus -> PCM)", () => {
  const itFfmpeg = hasFfmpeg ? it : it.skip;

  itFfmpeg(
    "decodes real opus packets into monotonic 100 ms chunks and survives broken packets",
    async () => {
      // 1. encode a 1 s tone to opus/ogg with the same ffmpeg the image ships
      const src = path.join(tmpdir(), `hl-audio-relay-probe-${process.pid}.ogg`);
      const enc = spawnSync("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-ac", "1", "-ar", "48000", "-c:a", "libopus", src,
      ]);
      expect(enc.status).toBe(0);
      const pkts = packetsFromOgg(readFileSync(src));
      // drop the OpusHead/OpusTags packets — RTP carries only audio packets
      const audioPackets = pkts.filter((p) => !p.toString("ascii", 0, 8).startsWith("OpusHead") && !p.toString("ascii", 0, 8).startsWith("OpusTags"));
      expect(audioPackets.length).toBeGreaterThan(20);

      const chunks: AudioPcmChunk[] = [];
      const relay = new AudioRelay({
        sessionId: "probe",
        onChunk: (c) => {
          chunks.push(c);
        },
      });

      // 2. feed the packets with a monotonic wall clock, injecting broken ones
      const t0 = Date.now();
      audioPackets.forEach((p, i) => {
        if (i % 10 === 0) relay.pushPacket(Buffer.alloc(0), t0 + i * 20); // broken packet
        relay.pushPacket(p, t0 + i * 20);
      });
      expect(relay.packetsDropped).toBeGreaterThan(0);

      // 3. wait for ffmpeg to drain (bounded)
      const deadline = Date.now() + 8000;
      while (chunks.length < 5 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      await relay.close();

      expect(chunks.length).toBeGreaterThanOrEqual(5);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].seq).toBe(chunks[i - 1].seq + 1);
        expect(chunks[i].timestamp).toBeGreaterThanOrEqual(chunks[i - 1].timestamp);
      }
      for (const c of chunks) {
        const pcm = Buffer.from(c.samples, "base64");
        expect(pcm.length).toBe(CHUNK_BYTES);
      }
      // the tone actually decoded (non-silent PCM) at the gate's 16 kHz rate
      const pcm = Buffer.from(chunks[chunks.length - 1].samples, "base64");
      let sum = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) sum += Math.abs(pcm.readInt16LE(i));
      expect(sum / (pcm.length / 2)).toBeGreaterThan(100);
      expect(relay.pcmBytes).toBeGreaterThan(10_000);
    },
    20_000
  );

  it("a missing/broken decoder never throws and never blocks the caller", async () => {
    const relay = new AudioRelay({ ffmpegBin: "/nonexistent/ffmpeg", onChunk: () => {} });
    // pushing a valid packet starts the decoder, which fails asynchronously
    expect(() => relay.pushPacket(packet(19, 0), Date.now())).not.toThrow();
    expect(() => relay.pushPacket(Buffer.alloc(0), Date.now())).not.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(relay.isDisabled).toBe(true);
    await relay.close();
  });
});
