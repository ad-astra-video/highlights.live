// ADAAAA-7658: control-plane audio relay route (`POST /jobs/:id/audio`).
//
// The media node decodes the browser's opus RTP at the edge and POSTs ~100 ms
// mono int16 PCM chunks here; this route must forward the chunk to perceive
// `POST /audio` on the session the media node paid for (session id
// propagation), reject broken chunks without touching perceive, and surface a
// fired candidate as job evidence.
import { describe, it, expect } from "vitest";
import { buildTestApp, fakePipeline } from "./helpers";

async function register(app: any, email: string, pw: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

/** A 100 ms mono int16 PCM chunk at 16 kHz (3200 bytes), as base64. */
function pcmChunkB64(fill = 1000): string {
  const n = 1600;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(fill, i * 2);
  return buf.toString("base64");
}

function adapterWithAudio() {
  const calls: any[] = [];
  const base = fakePipeline();
  const trigger = {
    kind: "burst",
    ts: 4.5,
    firedAt: 5.4,
    onsetLatencyS: 0.9,
    peakEnergy: 0.42,
    baselineEnergy: 0.03,
    thresholdId: "stageA/burst/1.3x/0.3s",
  };
  return {
    calls,
    adapter: {
      ...base,
      async postAudio(sessionId: string, chunk: any) {
        calls.push({ sessionId, chunk });
        // fire a trigger on the 3rd chunk (a real gate only fires occasionally)
        if (calls.length === 3) {
          return { candidate: { type: "candidate", sessionId, eventType: "AUDIO", timestamp: trigger.ts, audio: trigger }, series: [] };
        }
        return { candidate: null, series: [{ t: chunk.timestamp, energy: 0.05, baseline: 0.02 }] };
      },
    },
  };
}

describe("POST /jobs/:id/audio (media relay -> perceive /audio)", () => {
  it("forwards the chunk on the media session id and returns the fired candidate", async () => {
    const { calls, adapter } = adapterWithAudio();
    const { app } = await buildTestApp({}, { adapter });
    const token = await register(app, "audio1@test.dev", "password123");
    const jr = await app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token}` }, payload: { source: "browser", gameHint: "soccer" } });
    expect([200, 202]).toContain(jr.statusCode);
    const jobId = jr.json().job.id as string;

    // chunk 1 + 2: no trigger
    for (const seq of [0, 1]) {
      const r = await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/audio`,
        payload: { seq, timestamp: 1.1 + seq * 0.1, samples: pcmChunkB64(), sessionId: "media-sess-1" },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().candidate).toBeNull();
    }
    // chunk 3: gate fires
    const fired = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/audio`,
      payload: { seq: 2, timestamp: 1.3, samples: pcmChunkB64(), sessionId: "media-sess-1" },
    });
    expect(fired.statusCode).toBe(200);
    const body = fired.json();
    expect(body.candidate.audio.kind).toBe("burst");
    expect(body.candidate.audio.thresholdId).toBe("stageA/burst/1.3x/0.3s");

    // session id propagation: every chunk went to the SAME runner session
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.sessionId))).toEqual(new Set(["media-sess-1"]));
    // the shape forwarded to perceive is the frozen {seq, timestamp, samples}
    expect(calls[0].chunk).toMatchObject({ seq: 0, timestamp: 1.1, streamId: jobId });
    expect(Buffer.from(calls[0].chunk.samples, "base64").length).toBe(3200);
  });

  it("rejects broken chunks (empty / misaligned int16) before touching perceive", async () => {
    const { calls, adapter } = adapterWithAudio();
    const { app } = await buildTestApp({}, { adapter });
    const token = await register(app, "audio2@test.dev", "password123");
    const jr = await app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token}` }, payload: { source: "browser" } });
    const jobId = jr.json().job.id as string;

    const empty = await app.inject({ method: "POST", url: `/jobs/${jobId}/audio`, payload: { samples: "", sessionId: "s" } });
    expect(empty.statusCode).toBe(400);
    const odd = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/audio`,
      payload: { samples: Buffer.from([1, 2, 3]).toString("base64"), sessionId: "s" },
    });
    expect(odd.statusCode).toBe(400);
    expect(odd.json().error).toMatch(/aligned int16/);
    expect(calls).toHaveLength(0);
  });

  it("404s an unknown job and 409s when no perceive session is resolvable", async () => {
    const { calls, adapter } = adapterWithAudio();
    const { app } = await buildTestApp({}, { adapter });
    const token = await register(app, "audio3@test.dev", "password123");
    const missing = await app.inject({
      method: "POST",
      url: "/jobs/does-not-exist/audio",
      payload: { samples: pcmChunkB64(), sessionId: "s" },
    });
    expect(missing.statusCode).toBe(404);

    const jr = await app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token}` }, payload: { source: "browser" } });
    const jobId = jr.json().job.id as string;
    const noSession = await app.inject({ method: "POST", url: `/jobs/${jobId}/audio`, payload: { samples: pcmChunkB64() } });
    expect(noSession.statusCode).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it("a perceive failure returns 502 (dropped chunk) instead of failing the rail", async () => {
    const base = fakePipeline();
    const adapter = {
      ...base,
      async postAudio() {
        throw new Error("postAudio failed: HTTP 404");
      },
    };
    const { app } = await buildTestApp({}, { adapter });
    const token = await register(app, "audio4@test.dev", "password123");
    const jr = await app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token}` }, payload: { source: "browser" } });
    const jobId = jr.json().job.id as string;
    const r = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/audio`,
      payload: { samples: pcmChunkB64(), sessionId: "media-sess-2" },
    });
    expect(r.statusCode).toBe(502);
  });
});
