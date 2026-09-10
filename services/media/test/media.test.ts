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
  const ms = new MediaServer({ orchBase: "http://orch", callbackBase: "http://127.0.0.1:9888" }, fake as any);
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

  it("closes the session on WS close (teardown releases the perceived slot)", async () => {
    const ws = await wsConnect(`${base.replace("http", "ws")}/stream/sess-fake`);
    ws.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.closed).toContain("sess-fake");
  });

  it("pays the orchestrator while the stream is open and stops paying on teardown", async () => {
    expect(fake.startedPayments).toContain("sess-fake"); // provision started payment
    expect(fake.stoppedPayments).toContain("sess-fake"); // the close above stopped it
  });
});
