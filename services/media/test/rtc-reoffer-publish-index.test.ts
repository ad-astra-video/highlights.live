// ADAAAA-8817: the video-in / events-out trickle index is a property of the
// SESSION, not of the peer connection that produced the frame.
//
// Measured defect (leg `3740585f`, served build `881aa33cd8cb…`): a 600 s share
// was driven as 6 harness segments of 100 s on ONE media session. Every segment
// opened a fresh `RTCPeerConnection` and re-POSTed `/sessions/:sid/rtc/offer`
// (all 200). `WebRtcIngestSession.handleOffer` -> `resetConnection()` zeroed the
// decoder's per-connection `seq`, `emitFrame` published `seq: this.seq++` and
// `publishAndObserve` forwarded it to `POST {video-in}/{seq}` unchanged — so
// segment 2 republished idx 0 on a stream that had already advanced ~299
// indices. go-livepeer's trickle is index-addressed and the perceive runner's
// subscriber is strictly ordered (see the ADAAAA-7990 notes in
// `../src/observe-relay.ts`): a rewind leaves the runner re-requesting an index
// that never arrives, so EVERY later publish stalled. Video died while audio
// (a separate rail on the same session) kept flowing, and both the observation
// clock and the frame-tick clock froze at the first segment boundary.
//
// These tests pin the fix: `stream.publishSeq` is incremented once per published
// frame in `publishAndObserve`, so two consecutive offers on one session publish
// a strictly increasing, contiguous index that resumes instead of restarting;
// the relay reads events-out at that same index; and a WS re-attach (which also
// restarts its own frame numbering) cannot rewind it either.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RTCPeerConnection, MediaStreamTrack, RtpHeader, RtpPacket, useH264 } from "werift";
import { MediaServer } from "../src/server";
import { ObservationRelay } from "../src/observe-relay";
import type { ProvisionedSession } from "../src/orch";

const wsConnect = (url: string) =>
  new Promise<WebSocket>((res, rej) => {
    const ws = new WebSocket(url);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake perceive runner that mirrors the deployed shape this defect depends on:
 * `video-in` is index-addressed, the runner publishes ONE observation per stepped
 * frame at the SAME index, and the media node tails the live edge
 * (`GET {events-out}/-1`) for it.
 */
class RunnerFakeOrch {
  /** Every video-in index the node POSTed, in arrival order. */
  publishes: number[] = [];
  /** Observations the runner published, keyed by the video-in index it consumed. */
  obsBySeq = new Map<number, any>();
  /** Live-edge (`events-out/-1`) read count — the server's normal read path. */
  headReads = 0;
  provisioned: ProvisionedSession = {
    sessionId: "sess-8817",
    appUrl: "http://fake",
    controlUrl: "http://fake",
    videoIn: "http://orch/ai/trickle/sess-8817-video-in",
    eventsOut: "http://orch/ai/trickle/sess-8817-events-out",
    control: "http://orch/ai/trickle/sess-8817-control",
  };
  closed: string[] = [];

  constructor(public sid: string = "sess-8817") {
    this.provisioned.sessionId = sid;
  }

  async provision(): Promise<ProvisionedSession> {
    return this.provisioned;
  }
  startPayment(_p: ProvisionedSession) {}
  stopPayment(_sessionId: string) {}
  async publishFrame(p: ProvisionedSession, seq: number, jpeg: Uint8Array, _ts: number) {
    this.publishes.push(seq);
    this.obsBySeq.set(seq, { type: "observation", sessionId: p.sessionId, seq, tracks: [] });
    return 200;
  }
  async readObservation(_p: ProvisionedSession, seq: number) {
    if (seq === -1) {
      this.headReads++;
      const keys = [...this.obsBySeq.keys()];
      return keys.length ? this.obsBySeq.get(Math.max(...keys)) : null;
    }
    return this.obsBySeq.get(seq) ?? null;
  }
  async closeSession(_controlUrl: string, sessionId?: string) {
    this.closed.push(sessionId ?? this.provisioned.sessionId);
  }
  async releaseSession(sessionId: string, _controlUrl?: string) {
    this.closed.push(sessionId);
  }
}

let h264: Buffer;

beforeAll(() => {
  const p = path.join(tmpdir(), `hl-rtc-8817-${process.pid}.h264`);
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

/**
 * Establish ONE browser peer against an already-provisioned media session, send
 * the H264 fixture as RTP, and wait until at least one real decoded JPEG has
 * been published to video-in. Returns the browser peer so the caller can drop it
 * (exactly what a transient network blip says to the media node).
 *
 * Every call opens a NEW `RTCPeerConnection` and re-POSTs the offer on the SAME
 * session — the harness segment shape (and a real reconnect) that carries the
 * defect.
 */
async function browserSegment(
  srv: any,
  sid: string,
  orch: RunnerFakeOrch,
  waitFor: number,
): Promise<{ pc: any }> {
  const browserPc = new RTCPeerConnection({ codecs: { video: [useH264()] } } as any);
  const sendTrack = new MediaStreamTrack({ kind: "video" });
  browserPc.addTransceiver(sendTrack, { direction: "sendonly" } as any);
  const offer = await browserPc.createOffer();
  await browserPc.setLocalDescription(offer);

  const ans = await srv.inject({ method: "POST", url: `/sessions/${sid}/rtc/offer`, payload: { offer } });
  expect(ans.statusCode).toBe(200);
  await browserPc.setRemoteDescription(ans.json().answer);

  for (let i = 0; i < 40 && browserPc.connectionState !== "connected"; i++) await sleep(50);
  expect(browserPc.connectionState).toBe("connected");

  const sender = browserPc.getTransceivers().find((t: any) => t.sender)?.sender as any;
  if (sender) {
    sender.sequenceNumber = 0;
    sender.timestamp = 0;
    sender.seqOffset = 0;
    sender.timestampOffset = 0;
  }
  const pay = sender?.codec?.payloadType ?? 96;
  const before = orch.publishes.length;
  let clock = 0;
  let ts = 0;
  // Three passes of the fixture at ~real time (15 fps), so the 3 fps sampler
  // gets several decode ticks inside the segment instead of one.
  for (let pass = 0; pass < 3; pass++) {
    for (const nal of nalUnits(h264)) {
      const header = new RtpHeader({
        payloadType: pay,
        sequenceNumber: (clock++) % 65536,
        timestamp: (ts += 90000 / 15),
        ssrc: sender?.ssrc ?? 1,
        marker: 1,
      } as any);
      sendTrack.writeRtp(new RtpPacket(header, nal));
      await sleep(35);
    }
  }
  for (let i = 0; i < 80 && orch.publishes.length - before < waitFor; i++) await sleep(100);
  expect(orch.publishes.length - before).toBeGreaterThanOrEqual(waitFor);
  return { pc: browserPc };
}

/** `[0,1,2,…]` — the dense sequence go-livepeer's trickle requires. */
const denseFrom = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("RTC re-offer keeps the video-in index monotonic (ADAAAA-8817)", () => {
  it("two consecutive offers on one session publish a strictly increasing index that resumes, never restarts", async () => {
    const g = new RunnerFakeOrch("sess-reoffer-8817");
    // Long grace: the session (and its perceive slot) must survive the drop, as
    // it did on the measured leg.
    const ms = new MediaServer(
      { orchBase: "http://orch", reconnectGraceMs: 5000, rtcSampleFps: 3 },
      g as any,
    );
    const srv = await ms.build();
    await srv.listen({ port: 0, host: "127.0.0.1" });

    const logged: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: any[]) => {
      logged.push(a.map(String).join(" "));
    });
    try {
      const prov = await srv.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-reoffer-8817" } });
      expect(prov.statusCode).toBe(200);
      const sid = prov.json().sessionId;

      // ---- segment 1 ----
      const first = await browserSegment(srv, sid, g, 2);
      const firstIdx = [...g.publishes];
      // A fresh session starts its index at 0 and publishes densely.
      expect(firstIdx).toEqual(denseFrom(firstIdx.length));
      await first.pc.close();
      // Give the media node a moment to observe the drop WITHOUT releasing the
      // slot (grace), then re-offer on the same session.
      await sleep(200);
      expect(g.closed).not.toContain(sid);

      // ---- segment 2: the reconnect ----
      const beforeSecond = g.publishes.length;
      const second = await browserSegment(srv, sid, g, 2);
      const secondIdx = g.publishes.slice(beforeSecond);

      // 1) NO RESTART AT 0 — the defect's literal shape.
      expect(secondIdx.length).toBeGreaterThanOrEqual(2);
      expect(secondIdx[0]).toBe(firstIdx[firstIdx.length - 1] + 1);
      expect(secondIdx).not.toContain(0);

      // 2) One dense, strictly increasing index for the whole session: the
      //    reconnect is invisible to the rail, so no hole and no rewind.
      const all = g.publishes;
      expect(all).toEqual(denseFrom(all.length));
      for (let i = 1; i < all.length; i++) expect(all[i]).toBe(all[i - 1] + 1);

      // 3) The decoder's own per-connection counter DID restart (idx keeps
      //    climbing while sourceSeq is back at 0) — the two numbers are now
      //    separate on purpose, and the evidence line names both.
      const boundary = logged.filter((l) => l.includes("sourceSeq=0"));
      expect(boundary.length).toBeGreaterThanOrEqual(2);
      const afterRefoffer = boundary.find(
        (l) => Number(/idx=(\d+)/.exec(l)![1]) === secondIdx[0],
      );
      expect(afterRefoffer).toBeTruthy();

      // 4) The relay reads events-out at the SAME index it published (idx and
      //    observation index stay the same number) and tails the live edge —
      //    the runner publishes one observation per consumed index.
      expect(g.headReads).toBeGreaterThan(0);
      for (const idx of all) expect(g.obsBySeq.has(idx)).toBe(true);

      // AC4 evidence: the observed index values across the re-offer, so a QA leg
      // can re-grade the same shape (deployed leg `3740585f` froze at ~299).
      // eslint-disable-next-line no-console
      console.info(
        `[8817] segment1 idx ${firstIdx[0]}..${firstIdx[firstIdx.length - 1]} (n=${firstIdx.length}); ` +
          `re-offer -> segment2 idx ${secondIdx[0]}..${secondIdx[secondIdx.length - 1]} ` +
          `(n=${secondIdx.length}); session idx 0..${all[all.length - 1]}`,
      );

      await second.pc.close();
    } finally {
      logSpy.mockRestore();
      await srv.close();
    }
  }, 60_000);
});

describe("WS ingest keeps a monotonic publish index (ADAAAA-8817 AC2)", () => {
  it("a WS re-attach whose client numbering restarts at 0 cannot rewind video-in", async () => {
    const g = new RunnerFakeOrch("sess-ws-8817");
    const ms = new MediaServer(
      { orchBase: "http://orch", reconnectGraceMs: 5000, rtcSampleFps: 3 },
      g as any,
    );
    const srv = await ms.build();
    await srv.listen({ port: 0, host: "127.0.0.1" });
    const sBase = `http://127.0.0.1:${(srv.server.address() as any).port}`;
    try {
      const prov = await srv.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-ws-8817" } });
      const sid = prov.json().sessionId;
      const jpegB64 = Buffer.from("ws-jpeg-bytes").toString("base64");

      // First attach: the client numbers its frames 1..3.
      const ws1 = await wsConnect(`${sBase.replace("http", "ws")}/stream/${sid}`);
      for (let seq = 1; seq <= 3; seq++) {
        ws1.send(JSON.stringify({ seq, image: jpegB64, timestamp: seq / 3 }));
        await sleep(60);
      }
      for (let i = 0; i < 40 && g.publishes.length < 3; i++) await sleep(50);
      expect(g.publishes.length).toBe(3);
      ws1.close();
      await sleep(100);

      // Re-attach: a NEW socket whose own numbering restarts at 1 (the shape a
      // reconnecting legacy client has, and the same class as the RTC re-offer).
      const ws2 = await wsConnect(`${sBase.replace("http", "ws")}/stream/${sid}`);
      for (let seq = 1; seq <= 3; seq++) {
        ws2.send(JSON.stringify({ seq, image: jpegB64, timestamp: seq / 3 }));
        await sleep(60);
      }
      for (let i = 0; i < 40 && g.publishes.length < 6; i++) await sleep(50);
      ws2.close();

      // Six published frames, one dense index each: the node owns the index, so
      // the re-attach resumes at 3 instead of replaying 0..2 on the rail.
      expect(g.publishes).toEqual(denseFrom(6));
    } finally {
      await srv.close();
    }
  }, 30_000);
});

describe("observation relay reads events-out at the published index (ADAAAA-8817 AC1)", () => {
  it("asks for exactly the published sequence, in order, across a re-offer boundary", async () => {
    const reads: number[] = [];
    const delivered: number[] = [];
    const relay = new ObservationRelay({
      read: async (seq) => {
        reads.push(seq);
        return { type: "observation", seq, tracks: [] };
      },
      emit: (obs, frame) => {
        expect(obs.seq).toBe(frame.seq);
        delivered.push(frame.seq);
      },
      pollIntervalMs: 10,
      deadlineMs: 1_000,
    });
    // The indices a session-owned counter produces across a re-offer: the first
    // connection ends at 2, the second resumes at 3 (had the fix been absent the
    // second connection's frames would carry 0,1 again and the relay would read
    // indices the runner already served).
    const published = [0, 1, 2, 3, 4, 5];
    for (const seq of published) relay.commit({ seq, ts: seq, jpeg: new Uint8Array([1]) });
    await relay.flush(2_000);

    expect(reads).toEqual(published);
    expect(delivered).toEqual(published);
    for (let i = 1; i < reads.length; i++) expect(reads[i]).toBeGreaterThan(reads[i - 1]);
    expect(relay.stats().delivered).toBe(published.length);
    relay.close();
  });
});

afterAll(() => {
  /* nothing global to release: each test owns its server */
});
