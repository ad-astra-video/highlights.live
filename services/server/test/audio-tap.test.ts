// Server-side Stage-A audio tap (INC-2 / ADAAAA-4325).
// Unit coverage for the two new pieces:
//   1. chunkPcmBytes — the pure PCM chunker behind LiveIngest.audioChunks().
//   2. DirectAdapter.postAudio — the server -> perceive /audio client.
// Full live integration (real ffmpeg tap feeding a live session) is exercised
// in the perceive HTTP suite + a manual/live run; these tests pin the math and
// the client contract so the tap cannot silently break the gate.
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkPcmBytes, AUDIO_SAMPLE_RATE, AUDIO_CHUNK_S } from "../src/live";
import { DirectAdapter } from "../src/livepeer-adapter";
import { loadConfig } from "../src/config";

const CHUNK_BYTES = Math.round(AUDIO_SAMPLE_RATE * AUDIO_CHUNK_S) * 2; // 3200 @16k/100ms

describe("chunkPcmBytes (audio tap chunker)", () => {
  it("splits 16-bit mono PCM into fixed-size base64 chunks with end timestamps", () => {
    const nChunks = 3;
    const bytes = Buffer.alloc(nChunks * CHUNK_BYTES);
    // give each chunk a distinct int16 value so base64 differs
    for (let c = 0; c < nChunks; c++) {
      bytes.writeInt16LE(1000 + c, c * CHUNK_BYTES);
    }
    const out = chunkPcmBytes(bytes, CHUNK_BYTES, AUDIO_CHUNK_S, 5, 1.0);
    expect(out).toHaveLength(nChunks);
    expect(out[0].seq).toBe(5);
    expect(out[1].seq).toBe(6);
    // end timestamps: base + (idx+1)*chunkSec -> 1.1, 1.2, 1.3
    expect(out.map((c) => c.timestamp)).toEqual([1.1, 1.2, 1.3]);
    // base64 round-trip back to int16 length
    for (const c of out) {
      const raw = Buffer.from(c.samples, "base64");
      expect(raw.length).toBe(CHUNK_BYTES);
    }
  });

  it("holds back a trailing partial chunk for the caller to buffer", () => {
    const full = Buffer.alloc(CHUNK_BYTES);
    const partial = Buffer.alloc(7); // < one chunk
    const out = chunkPcmBytes(Buffer.concat([full, partial]), CHUNK_BYTES, AUDIO_CHUNK_S, 0, 0);
    expect(out).toHaveLength(1); // only the complete chunk
  });

  it("monotonic seq + timestamp across successive read batches (caller passes baseSeq/baseTs)", () => {
    const b1 = chunkPcmBytes(Buffer.alloc(CHUNK_BYTES * 2), CHUNK_BYTES, AUDIO_CHUNK_S, 0, 0);
    expect(b1.map((c) => c.seq)).toEqual([0, 1]);
    expect(b1[1].timestamp).toBeCloseTo(0.2, 9);
    const last = b1[1];
    const b2 = chunkPcmBytes(Buffer.alloc(CHUNK_BYTES), CHUNK_BYTES, AUDIO_CHUNK_S, last.seq + 1, last.timestamp);
    expect(b2[0].seq).toBe(2);
    expect(b2[0].timestamp).toBeCloseTo(0.3, 9);
  });
});

describe("DirectAdapter.postAudio (server -> perceive /audio client)", () => {
  const cfg = loadConfig({ PERCEIVE_URL: "http://p", DECIDE_URL: "http://d" });
  afterEach(() => vi.restoreAllMocks());

  it("POSTs the chunk to /app/audio with session header and correct body", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("{}", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new DirectAdapter(cfg);
    await adapter.postAudio("sess-1", { seq: 3, timestamp: 1.2, samples: "AAAA", streamId: "job-x" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [{}, Record<string, any>];
    expect(url).toBe("http://p/app/audio");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Session-Id"]).toBe("local-dev");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ seq: 3, timestamp: 1.2, samples: "AAAA", stream_id: "job-x" });
  });

  it("controlForward POSTs an operator find-and-track intent to /app/control (INC-6 / ADAAAA-4330)", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("{}", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new DirectAdapter(cfg);
    await adapter.controlForward("session-abc", { type: "track", bbox: [0.1, 0.2, 0.4, 0.5], label: "player" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [{}, Record<string, any>];
    expect(url).toBe("http://p/app/control");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Session-Id"]).toBe("local-dev"); // DirectAdapter fake session
    const body = JSON.parse(init.body);
    expect(body.type).toBe("track");
    expect(body.bbox).toEqual([0.1, 0.2, 0.4, 0.5]);
  });

  it("throws on 5xx (sick runner) but tolerates 404/4xx (session re-reserved — best effort)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 }))
    );
    const adapter = new DirectAdapter(cfg);
    // 404 must NOT throw — analysisJob may have re-reserved a fresh session.
    await expect(adapter.postAudio("sess-1", { seq: 0, timestamp: 0, samples: "AA" })).resolves.toBeUndefined();
    // 500 must throw.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 }))
    );
    await expect(adapter.postAudio("sess-1", { seq: 0, timestamp: 0, samples: "AA" })).rejects.toThrow(/5\d\d/);
  });
});
