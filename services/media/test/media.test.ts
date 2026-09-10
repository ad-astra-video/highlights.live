import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
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
  async closeSession(sessionId: string) {
    this.closed.push(sessionId);
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

  it("pays the orchestrator while the stream is open and stops paying on teardown", async () => {
    expect(fake.startedPayments).toContain("sess-fake"); // provision started payment
    expect(fake.stoppedPayments).toContain("sess-fake"); // the close above stopped it
  });
});
