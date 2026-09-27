import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RTCPeerConnection,
  MediaStreamTrack,
  RtpHeader,
  RtpPacket,
  useH264,
} from "werift";
import { MediaServer } from "../src/server";
import type { ProvisionedSession } from "../src/orch";

const wsConnect = (url: string) =>
  new Promise<WebSocket>((res, rej) => {
    const ws = new WebSocket(url);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });

// --- fake orchestrator (mirrors the LIVE .6 behavior: publish -> step ->
// events-out observation at the same seq) -------------------------------
class FakeOrch {
  publishes: Array<{ seq: number; jpeg: Buffer; ts: number }> = [];
  obsBySeq = new Map<number, any>();
  provisioned: ProvisionedSession = {
    sessionId: "sess-fake",
    appUrl: "http://fake",
    controlUrl: "http://fake",
    videoIn: "http://orch/ai/trickle/sess-fake-video-in",
    eventsOut: "http://orch/ai/trickle/sess-fake-events-out",
    control: "http://orch/ai/trickle/sess-fake-control",
  };
  closed: string[] = [];
  startedPayments: string[] = [];
  stoppedPayments: string[] = [];

  constructor(public sid: string = "sess-fake") {
    this.provisioned.sessionId = sid;
  }

  async provision(): Promise<ProvisionedSession> {
    return this.provisioned;
  }
  startPayment(p: ProvisionedSession) {
    this.startedPayments.push(p.sessionId);
  }
  stopPayment(sessionId: string) {
    this.stoppedPayments.push(sessionId);
  }
  async publishFrame(p: ProvisionedSession, seq: number, jpeg: Uint8Array, ts: number) {
    this.publishes.push({ seq, jpeg: Buffer.from(jpeg), ts });
    // the runner "steps" the frame and publishes an observation at the same seq
    this.obsBySeq.set(seq, { type: "observation", sessionId: p.sessionId, seq, tracks: [] });
    return 200;
  }
  async readObservation(p: ProvisionedSession, seq: number) {
    return this.obsBySeq.get(seq) ?? null;
  }
  async closeSession(controlUrl: string) {
    // MediaServer now targets the session via its control URL; record the
    // session this fake orchestrator owns so assertions stay on session ids.
    this.closed.push(this.provisioned.sessionId);
  }
}

const fake = new FakeOrch();
let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  const ms = new MediaServer({ orchBase: "http://orch", callbackBase: "http://127.0.0.1:9888", reconnectGraceMs: 80 }, fake as any);
  app = await ms.build();
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as any).port}`;
});

afterAll(async () => {
  await app.close();
});

describe("media server handshake (b)", () => {
  it("POST /sessions provisions a perceive session and returns a WS path", async () => {
    const res = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-1" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessionId).toBe("sess-fake");
    expect(body.wsPath).toBe("/stream/sess-fake");
    expect(body.jobId).toBe("job-1");
    expect(body.wsUrl).toBeUndefined(); // no publicBaseUrl -> clients fall back to wsPath
  });

  it("returns the FULL LB-routable ws ingest URL when publicBaseUrl is set", async () => {
    const ms = new MediaServer(
      { orchBase: "http://orch", callbackBase: "http://127.0.0.1:9888", publicBaseUrl: "https://media.example.com" },
      fake as any,
    );
    const srv = await ms.build();
    await srv.listen({ port: 0, host: "127.0.0.1" });
    const res = await srv.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-2" } });
    const body = res.json();
    expect(body.wsUrl).toBe("wss://media.example.com/stream/sess-fake");
    expect(body.wsPath).toBe("/stream/sess-fake");
    await srv.close();
  });

  it("streams a frame over WS -> publishes to video-in -> relays the observation", async () => {
    const ws = await wsConnect(`${base.replace("http", "ws")}/stream/sess-fake`);
    const jpegB64 = Buffer.from("fake-jpeg-bytes").toString("base64");
    const msgP = new Promise<any>((res) => {
      ws.on("message", (data: any) => res(JSON.parse(String(data))));
    });
    ws.send(JSON.stringify({ seq: 7, image: jpegB64, timestamp: 7.5 }));
    const obs = await msgP;
    expect(fake.publishes.some((p) => p.seq === 7)).toBe(true);
    expect(fake.publishes.find((p) => p.seq === 7)!.jpeg.toString()).toBe("fake-jpeg-bytes");
    expect(obs.type).toBe("observation");
    expect(obs.observation.seq).toBe(7);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("closes the session after the reconnect grace window elapses (slot released)", async () => {
    const ws = await wsConnect(`${base.replace("http", "ws")}/stream/sess-fake`);
    ws.close();
    await new Promise((r) => setTimeout(r, 400)); // > reconnectGraceMs (80)
    expect(fake.closed).toContain("sess-fake");
  });

  it("does NOT release the slot when the browser reconnects within the grace window", async () => {
    const g = new FakeOrch("sess-grace");
    const ms = new MediaServer(
      { orchBase: "http://orch", callbackBase: "http://127.0.0.1:9888", reconnectGraceMs: 500 },
      g as any,
    );
    const srv = await ms.build();
    await srv.listen({ port: 0, host: "127.0.0.1" });
    const sBase = `http://127.0.0.1:${(srv.server.address() as any).port}`;
    await srv.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-grace" } });
    // first browser drops, reconnects within the 500ms grace...
    const ws1 = await wsConnect(`${sBase.replace("http", "ws")}/stream/sess-grace`);
    ws1.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(g.closed).not.toContain("sess-grace"); // slot still held
    const ws2 = await wsConnect(`${sBase.replace("http", "ws")}/stream/sess-grace`);
    await new Promise((r) => setTimeout(r, 100));
    expect(g.closed).not.toContain("sess-grace"); // reconnect cancelled pending teardown
    ws2.close();
    await new Promise((r) => setTimeout(r, 900)); // > 500ms grace
    expect(g.closed).toContain("sess-grace"); // now released
    await srv.close();
  });

  it("releases the slot when a provisioned session never gets a browser (no-client timeout)", async () => {
    const g = new FakeOrch("sess-nocli");
    const ms = new MediaServer(
      { orchBase: "http://orch", callbackBase: "http://127.0.0.1:9888", provisionNoClientMs: 100, reconnectGraceMs: 1000 },
      g as any,
    );
    const srv = await ms.build();
    await srv.listen({ port: 0, host: "127.0.0.1" });
    await srv.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-nocli" } }); // no WS ever connects
    await new Promise((r) => setTimeout(r, 300)); // > provisionNoClientMs (100)
    expect(g.closed).toContain("sess-nocli");
    await srv.close();
  });

  it("reassembles muxed (video+audio) MediaRecorder chunks in arrival order", async () => {
    const g = new FakeOrch("sess-mux");
    const tmp = mkdtempSync(path.join(tmpdir(), "hl-media-"));
    const ms = new MediaServer(
      { orchBase: "http://orch", callbackBase: "http://127.0.0.1:9888", reconnectGraceMs: 1000, tmpDir: tmp },
      g as any,
    );
    const srv = await ms.build();
    await srv.listen({ port: 0, host: "127.0.0.1" });
    const sBase = `http://127.0.0.1:${(srv.server.address() as any).port}`;
    const res = await srv.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-mux" } });
    const sid = res.json().sessionId;
    const ws = await wsConnect(`${sBase.replace("http", "ws")}/stream/${sid}`);
    // two muxed chunks, in timeline order (the container PTS is authoritative)
    ws.send(JSON.stringify({ type: "media", mime: "video/webm", seq: 1, timestamp: 1, data: Buffer.from("AA").toString("base64") }));
    ws.send(JSON.stringify({ type: "media", mime: "video/webm", seq: 2, timestamp: 2, data: Buffer.from("BB").toString("base64") }));
    await new Promise((r) => setTimeout(r, 150)); // let them write
    // muxed chunks must NOT be published as single frames to the vision rail
    expect(g.publishes.length).toBe(0);
    // close -> teardown flushes + closes the recording
    await srv.inject({ method: "POST", url: `/sessions/${sid}/close` });
    await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(path.join(tmp, `${sid}.webm`)).toString()).toBe("AABB");
    expect(g.closed).toContain(sid);
    ws.close();
    await srv.close();
  });

  it("pays the orchestrator while the stream is open and stops paying on teardown", async () => {
    expect(fake.startedPayments).toContain("sess-fake"); // provision started payment
    expect(fake.stoppedPayments).toContain("sess-fake"); // the close above stopped it
  });
});

describe("media server WebRTC ingest (C1)", () => {
  // Generate a tiny valid H264 stream (SPS/PPS/IDR + P frames) via ffmpeg so
  // the loopback test has real decodable bytes (ffmpeg is a hard dependency of
  // the media server, so it is safe to require in tests).
  let h264: Buffer;
  beforeAll(() => {
    const p = path.join(tmpdir(), `hl-rtc-${process.pid}.h264`);
    execFileSync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15",
      "-t", "0.6", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-f", "h264", p,
    ]);
    h264 = readFileSync(p);
  });

  function nalUnits(data: Buffer): Buffer[] {
    const out: Buffer[] = [];
    let i = 0;
    while (i < data.length - 3) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        let s = i + 3;
        if (data[s] === 0 && data[s + 1] === 1) s += 1;
        let e = s;
        while (e < data.length && !(data[e] === 0 && data[e + 1] === 0 && (data[e + 2] === 1 || data[e + 2] === 0))) e++;
        if (e > s) out.push(data.subarray(s, e));
        i = e;
      } else i++;
    }
    return out;
  }

  /** Establish a browser (offerer) WebRTC session against a media server,
   *  wait for ICE to connect, then stream the module-level H264 fixture as RTP
   *  and poll for a real decoded JPEG landing in the fake orchestrator. Returns
   *  the browser peer + the elapsed ms from first RTP to first publish. */
  async function rtcPublish(
    srv: FastifyInstance,
    sBase: string,
    sid: string,
    orch: FakeOrch
  ): Promise<{ pc: any; elapsedMs: number }> {
    const browserPc = new RTCPeerConnection({ codecs: { video: [useH264()] } } as any);
    const sendTrack = new MediaStreamTrack({ kind: "video" });
    browserPc.addTransceiver(sendTrack, { direction: "sendonly" } as any);
    const offer = await browserPc.createOffer();
    await browserPc.setLocalDescription(offer);

    const ans = await srv.inject({
      method: "POST",
      url: `/sessions/${sid}/rtc/offer`,
      payload: { offer },
    });
    expect(ans.statusCode).toBe(200);
    const { answer } = ans.json();
    await browserPc.setRemoteDescription(answer);

    for (let i = 0; i < 40 && browserPc.connectionState !== "connected"; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(browserPc.connectionState).toBe("connected");

    const sender = browserPc.getTransceivers().find((t) => t.sender)?.sender;
    if (sender) {
      const s = sender as any;
      s.sequenceNumber = 0;
      s.timestamp = 0;
      s.seqOffset = 0;
      s.timestampOffset = 0;
    }

    const before = orch.publishes.length;
    const added = () => orch.publishes.slice(before);
    const pay = sender?.codec?.payloadType ?? 96;
    const t0 = Date.now();
    const nals = nalUnits(h264);
    let clock = 0, ts = 0;
    for (const nal of nals) {
      const header = new RtpHeader({
        payloadType: pay,
        sequenceNumber: (clock++) % 65536,
        timestamp: (ts += 90000 / 15),
        ssrc: sender?.ssrc ?? 1,
        marker: 1,
      } as any);
      sendTrack.writeRtp(new RtpPacket(header, nal));
    }
    let published = false;
    for (let i = 0; i < 40 && !published; i++) {
      await new Promise((r) => setTimeout(r, 100));
      published = added().some((p) => p.jpeg.length > 100 && p.jpeg[0] === 0xff && p.jpeg[1] === 0xd8);
    }
    const elapsedMs = Date.now() - t0;
    expect(published).toBe(true);
    return { pc: browserPc, elapsedMs };
  }

  it("browser WebRTC -> media server -> orchestrator video-in rail (frame published)", async () => {
    // 1) provision a session via the Fastify control plane.
    const prov = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-rtc" } });
    expect(prov.statusCode).toBe(200);
    const sid = prov.json().sessionId;
    expect(prov.json().rtc).toBe(true);

    // full loopback through the shared fake orchestrator
    const before = fake.publishes.length;
    const added = () => fake.publishes.slice(before);
    const { pc, elapsedMs } = await rtcPublish(app, base, sid, fake);
    // the media-server ingest leg (RTP -> depacketize -> ffmpeg decode -> video-in
    // publish) must land a real JPEG well inside the 1-5s budget.
    expect(elapsedMs).toBeLessThan(3000);
    const pub = [...added()].reverse().find((p) => p.jpeg.length > 100)!;
    expect(pub.jpeg.length).toBeGreaterThan(100);
    // a real JPEG SOI mark opens the decoded sample
    expect(pub.jpeg[0]).toBe(0xff);
    expect(pub.jpeg[1]).toBe(0xd8);
    expect(elapsedMs).toBeGreaterThan(0);

    await pc.close();
  });

  it("same-session reconnect: a fresh offer on an already-ingesting session keeps frames flowing", async () => {
    // Independent media server + fake orch with a long grace so the session
    // survives between connections (mirrors a transport blip on a healthy node).
    const g = new FakeOrch("sess-reconnect");
    const ms = new MediaServer(
      { orchBase: "http://orch", callbackBase: "http://127.0.0.1:9888", reconnectGraceMs: 3000 },
      g as any,
    );
    const srv = await ms.build();
    await srv.listen({ port: 0, host: "127.0.0.1" });
    const sBase = `http://127.0.0.1:${(srv.server.address() as any).port}`;
    try {
      const prov = await srv.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-reconnect" } });
      const sid = prov.json().sessionId;

      // first connection sends frames -> published
      const first = await rtcPublish(srv, sBase, sid, g);
      await first.pc.close();
      await new Promise((r) => setTimeout(r, 100)); // let the server observe the drop

      // second offer on the SAME sid (reconnect): frames must flow again
      const before2 = g.publishes.length;
      const second = await rtcPublish(srv, sBase, sid, g);
      const added2 = g.publishes.slice(before2);
      expect(added2.some((p) => p.jpeg.length > 100 && p.jpeg[0] === 0xff && p.jpeg[1] === 0xd8)).toBe(true);
      await second.pc.close();
    } finally {
      await srv.close();
    }
  });

  it("falls through to 404 for unknown sessions on the RTC offer route", async () => {
    const res = await app.inject({ method: "POST", url: "/sessions/nope/rtc/offer", payload: { offer: {} } });
    expect(res.statusCode).toBe(404);
  });
});
