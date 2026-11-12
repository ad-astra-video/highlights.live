// ADAAAA-7699: the media node must carry the decoded anchor JPEG with the
// observation it relays to the control plane. Without it the control plane has
// no pixels on the media (RTC) rail to anchor a decide to, which is exactly why
// a live screen share produced observations but 0 decide calls.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import { MediaServer } from "../src/server";
import type { ProvisionedSession } from "../src/orch";

/** Minimal orchestrator: one frame in -> one observation out at the same seq. */
class FakeOrch {
  publishes: Array<{ seq: number; jpeg: Buffer; ts: number }> = [];
  obsBySeq = new Map<number, any>();
  /** When false the observation comes back WITHOUT the timestamp the media node
   *  published — the shape a runner that does not echo the frame clock returns
   *  (and the shape that silently poisoned the media rail's lag gate). */
  echoTs = true;
  provisioned: ProvisionedSession = {
    sessionId: "sess-7699",
    appUrl: "http://fake",
    controlUrl: "http://fake",
    videoIn: "http://orch/ai/trickle/sess-7699-video-in",
    eventsOut: "http://orch/ai/trickle/sess-7699-events-out",
    control: "http://orch/ai/trickle/sess-7699-control",
  };
  async provision(): Promise<ProvisionedSession> {
    return this.provisioned;
  }
  startPayment() {}
  stopPayment() {}
  isPaying() {
    return true;
  }
  payingCount() {
    return 0;
  }
  paysOnchain() {
    return false;
  }
  async publishFrame(_p: ProvisionedSession, seq: number, jpeg: Uint8Array, ts: number) {
    this.publishes.push({ seq, jpeg: Buffer.from(jpeg), ts });
    this.obsBySeq.set(seq, {
      type: "observation",
      sessionId: this.provisioned.sessionId,
      seq,
      ...(this.echoTs ? { timestamp: ts } : {}),
      tracks: [{ trackId: "t1", bbox: [0.1, 0.1, 0.2, 0.2], kind: "player", slot: 0, lostFrames: 0 }],
      evidence: { ballInNet: false },
    });
    return 200;
  }
  async readObservation(_p: ProvisionedSession, seq: number) {
    // The node tails the live edge (`GET {events-out}/-1`) for a queued frame, so
    // the fake has to answer it with the NEWEST observation, the way the deployed
    // runner does. Without it the push relay can never pair a frame, the observe
    // callback never fires, and this test read as "no anchor frame" (pre-existing
    // red on master; the relay's read index is the publish index — ADAAAA-8817).
    if (seq === -1) {
      const keys = [...this.obsBySeq.keys()];
      return keys.length ? this.obsBySeq.get(Math.max(...keys)) : null;
    }
    return this.obsBySeq.get(seq) ?? null;
  }
  async releaseSession() {}
  async closeSession() {}
}

const wsConnect = (url: string) =>
  new Promise<WebSocket>((res, rej) => {
    const ws = new WebSocket(url);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });

describe("media node observe callback carries the anchor frame (ADAAAA-7699)", () => {
  let cb: Server;
  let cbBodies: any[] = [];
  let srv: any;
  let sBase = "";
  const g = new FakeOrch();

  beforeAll(async () => {
    cb = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          cbBodies.push({ url: req.url, body: JSON.parse(raw) });
        } catch {
          cbBodies.push({ url: req.url, body: raw });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => cb.listen(0, "127.0.0.1", () => r()));
    const port = (cb.address() as any).port;
    const ms = new MediaServer({ orchBase: "http://orch", callbackBase: `http://127.0.0.1:${port}`, reconnectGraceMs: 200 }, g as any);
    srv = await ms.build();
    await srv.listen({ port: 0, host: "127.0.0.1" });
    sBase = `http://127.0.0.1:${(srv.server.address() as any).port}`;
  });

  afterAll(async () => {
    await srv?.close();
    await new Promise<void>((r) => cb.close(() => r()));
  });

  it("posts the observation WITH frameB64 (the pixels the decide anchors to)", async () => {
    cbBodies = [];
    const prov = await srv.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-7699" } });
    const sid = prov.json().sessionId as string;
    const ws = await wsConnect(`${sBase.replace("http", "ws")}/stream/${sid}`);
    const image = Buffer.from("decoded-jpeg-pixels").toString("base64");
    const ts = Date.now() / 1000;
    ws.send(JSON.stringify({ seq: 0, image, timestamp: ts }));

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !cbBodies.some((b) => b.url === "/jobs/job-7699/observe")) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const call = cbBodies.find((b) => b.url === "/jobs/job-7699/observe");
    expect(call).toBeTruthy();
    // The anchor frame travels with the observation (no second session needed).
    expect(call.body.frameB64).toBe(image);
    // The observation itself is intact (perceive evidence still relayed).
    expect(call.body.seq).toBe(0);
    expect(call.body.timestamp).toBeCloseTo(ts, 3);
    expect(Array.isArray(call.body.tracks)).toBe(true);

    ws.close();
    await srv.inject({ method: "POST", url: `/sessions/${sid}/close` });
  });

  it("stamps the frame clock when the runner does not echo it (no 1970 content clock)", async () => {
    cbBodies = [];
    g.echoTs = false;
    try {
      const prov = await srv.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-7699-nots" } });
      const sid = prov.json().sessionId as string;
      const ws = await wsConnect(`${sBase.replace("http", "ws")}/stream/${sid}`);
      const image = Buffer.from("decoded-jpeg-pixels").toString("base64");
      const ts = Date.now() / 1000;
      ws.send(JSON.stringify({ seq: 7, image, timestamp: ts }));

      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !cbBodies.some((b) => b.url === "/jobs/job-7699-nots/observe")) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const call = cbBodies.find((b) => b.url === "/jobs/job-7699-nots/observe");
      expect(call).toBeTruthy();
      // The control plane dates every window off this value; a runner that
      // omits it must not leave the rail on a 1970 clock (which made the lag
      // gate drop every frame and produced 0 decides on a live share).
      expect(call.body.timestamp).toBeCloseTo(ts, 3);
      expect(call.body.frameB64).toBe(image);

      ws.close();
      await srv.inject({ method: "POST", url: `/sessions/${sid}/close` });
    } finally {
      g.echoTs = true;
    }
  });
});
