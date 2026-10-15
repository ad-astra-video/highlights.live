import { describe, it, expect, vi, afterEach } from "vitest";
import {
  analyzeJob,
  WATCHER_TICK_S,
  type PipelineClient,
  type ObservationResult,
} from "../src/analyzer";
import {
  HttpDecideWatcherClient,
  makeDecideWatcherClient,
  type DecideWatcherClient,
} from "../src/watch-client";

// ---------------------------------------------------------------------------
// ADAAAA-6742 G5 "Live watcher-first". Unit tests (with a mocked decide
// watcher client) that:
//  (a) prove the flag-OFF legacy live path is untouched — no watcher/stash call
//      is ever made when `liveWatcherFirst` is false;
//  (b) prove the flag-ON live path drives watcher/start, feeds frames, steps
//      pass-1 + pass-2, invokes deep investigation on a depth-router flag, and
//      (via the decide stash) accepts the decide-uploaded clip.
// A mocked decide client is used throughout — no live decide/perceive process.
// ---------------------------------------------------------------------------

function fakePipeline(over: Partial<PipelineClient> = {}): { client: PipelineClient; log: string[] } {
  const log: string[] = [];
  const client: PipelineClient = {
    reservePerceive: async () => {
      log.push("reserve");
      return { sessionId: "sess-w", appUrl: "", controlUrl: "" };
    },
    analyze: async (_session, frame) => {
      log.push("analyze");
      return {
        observation: { tracks: [{ trackId: "t1", slot: 0, bbox: [0, 0, 0.2, 0.2], kind: "player", lostFrames: 0 }], seq: frame.seq, timestamp: frame.timestamp },
      } as ObservationResult;
    },
    decide: async () => {
      log.push("decide");
      return { isHighlight: true, score: 80, eventType: "KILL" };
    },
    plan: async () => {
      log.push("plan");
      return { planVersion: 1, category: "soccer", intent: "", source: "planner-fallback", maxTracks: 3, targets: [{ label: "player", role: "player" }], reason: "test" };
    },
    stopPerceive: async () => {
      log.push("stop");
    },
    postAudio: async () => {
      log.push("audio");
      return null;
    },
    controlForward: async () => {
      log.push("control");
    },
    analysisQuery: async () => null,
    analysisState: async () => null,
    train: async () => ({ run: "x", checkpoint: "/runs/x/model.safetensors" }),
    ...over,
  };
  return { client, log };
}

/** Fake decide watcher client: records every call and serves configurable
 * responses, so the decide side is fully mocked. */
interface WatcherMock {
  client: DecideWatcherClient;
  log: { method: string; req: any }[];
}
function fakeWatcher(step2Responses: any[] = []): WatcherMock {
  const log: { method: string; req: any }[] = [];
  const call = (method: string, req: any) => {
    log.push({ method, req });
    return { ok: true };
  };
  let step2i = 0;
  const client: DecideWatcherClient = {
    watcherStart: async (req) => call("watcherStart", req),
    watcherIngest: async (req) => call("watcherIngest", req),
    stashStart: async (req) => call("stashStart", req),
    stashIngest: async (req) => call("stashIngest", req),
    watcherStep: async (req) => call("watcherStep", req),
    watcherStep2: async (req) => {
      const r = step2Responses[Math.min(step2i, step2Responses.length - 1)] ?? {};
      step2i++;
      log.push({ method: "watcherStep2", req });
      return r;
    },
    deepInvestigate: async (req) => call("deepInvestigate", req),
  };
  return { client, log };
}

async function* frames(timestamps: number[], seqBase = 0) {
  for (let i = 0; i < timestamps.length; i++) yield { seq: seqBase + i, timestamp: timestamps[i], imageB64: `img${i}` };
}

const cut = async (ts: number) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` });

describe("ADAAAA-6742 G5 live watcher-first", () => {
  it("flag OFF: runs the legacy per-frame loop and NEVER drives the watcher", async () => {
    // A watcher client that would throw loudly if the live path tried to use it.
    const { client, log } = fakePipeline();
    const bomb = {
      watcherStart: async () => {
        throw new Error("watcher must not be started when flag is off");
      },
      watcherIngest: async () => {
        throw new Error("watcher ingest must not run when flag is off");
      },
      stashStart: async () => {
        throw new Error("stash must not start when flag is off");
      },
      stashIngest: async () => {
        throw new Error("stash ingest must not run when flag is off");
      },
      watcherStep: async () => {
        throw new Error("step must not run when flag is off");
      },
      watcherStep2: async () => {
        throw new Error("step2 must not run when flag is off");
      },
      deepInvestigate: async () => {
        throw new Error("deep investigate must not run when flag is off");
      },
    } as unknown as DecideWatcherClient;

    const outcome = await analyzeJob(client, frames([0, 1, 2, 3]), cut, {
      jobId: "job-legacy",
      clipBeforeS: 4,
      clipAfterS: 4,
      gameHint: "soccer",
      // flag default OFF — legacy path. `decideWatcher` is still supplied to
      // prove the legacy branch ignores it entirely.
      liveWatcherFirst: false,
    }, undefined, undefined, undefined, undefined, bomb);

    // Legacy loop: reserve -> warm-up plan -> analyze each frame -> stop.
    expect(log[0]).toBe("reserve");
    expect(log[log.length - 1]).toBe("stop");
    expect(log.filter((x) => x === "analyze")).toHaveLength(4);
    // And the watcher client was never touched (bomb didn't throw).
    expect(outcome.framesAnalyzed).toBe(4);
    // No liveWatcher config = undefined also stays legacy.
    const outcome2 = await analyzeJob(client, frames([0, 1]), cut, {
      jobId: "job-legacy2",
      clipBeforeS: 4,
      clipAfterS: 4,
      gameHint: "",
    });
    expect(outcome2.framesAnalyzed).toBe(2);
  });

  it("flag ON: starts watcher + stash, feeds frames, steps pass-1 + pass-2, and invokes deep investigation on a flag", async () => {
    const { client } = fakePipeline();
    const step2Responses = [
      // first tick: no flag (nothing to investigate)
      { summary: { t: 0 }, flag: null, deepVerdicts: [] },
      // second tick: depth router flags a moment -> server must deep-investigate
      { summary: { t: 3 }, flag: { ts: 2.5 }, deepVerdicts: [] },
    ];
    const w = fakeWatcher(step2Responses);

    await analyzeJob(client, frames([0, 1, 2, 3, 4, 5]), cut, {
      jobId: "job-live",
      clipBeforeS: 4,
      clipAfterS: 4,
      gameHint: "soccer",
      liveWatcherFirst: true,
      streamId: "stream-live",
    }, undefined, undefined, undefined, undefined, w.client);

    // Stream start drives watcher + stash start.
    expect(w.log.filter((c) => c.method === "watcherStart")).toHaveLength(1);
    expect(w.log.filter((c) => c.method === "stashStart")).toHaveLength(1);
    expect(w.log.find((c) => c.method === "watcherStart")!.req).toMatchObject({
      sessionId: "sess-w",
      streamId: "stream-live",
      traceJobId: "job-live",
    });
    expect(w.log.find((c) => c.method === "stashStart")!.req).toMatchObject({
      jobId: "job-live",
      streamId: "stream-live",
    });

    // Every analyzed frame is fed to the watcher rail + stash.
    expect(w.log.filter((c) => c.method === "watcherIngest")).toHaveLength(6);
    expect(w.log.filter((c) => c.method === "stashIngest")).toHaveLength(6);
    expect(w.log.find((c) => c.method === "watcherIngest")!.req).toMatchObject({
      ts: 0,
      seq: 0,
      players: [{ trackId: "t1" }],
    });

    // ~3 s ticks drive pass-1 step + pass-2 step2 (ticks at ts 0 and ts 3).
    expect(w.log.filter((c) => c.method === "watcherStep")).toHaveLength(2);
    expect(w.log.filter((c) => c.method === "watcherStep2")).toHaveLength(2);
    expect(WATCHER_TICK_S).toBe(3);

    // The depth-router flag at ts 2.5 triggers a /deep/investigate.
    const deep = w.log.filter((c) => c.method === "deepInvestigate");
    expect(deep).toHaveLength(1);
    expect(deep[0].req).toMatchObject({ flagTs: 2.5 });
  });

  it("flag ON: does NOT deep-investigate a flag that step2 already auto-verdict'd (no duplicate deep pass)", async () => {
    const { client } = fakePipeline();
    // step2's flag IS already in deepVerdicts -> the server must not re-invoke
    // /deep/investigate (the decide side already ran it + stash-built/uploaded).
    const w = fakeWatcher([
      { summary: { t: 0 }, flag: null, deepVerdicts: [] },
      { summary: { t: 3 }, flag: { ts: 2.5 }, deepVerdicts: [{ flagTs: 2.5, isHighlight: true }] },
    ]);
    await analyzeJob(client, frames([0, 1, 2, 3, 4, 5]), cut, {
      jobId: "job-live2",
      clipBeforeS: 4,
      clipAfterS: 4,
      gameHint: "soccer",
      liveWatcherFirst: true,
      streamId: "stream-live2",
    }, undefined, undefined, undefined, undefined, w.client);
    expect(w.log.filter((c) => c.method === "deepInvestigate")).toHaveLength(0);
  });

  it("accepts the decide-uploaded clip on the live path (delegated to POST /jobs/:id/clips which already persists + publishes)", async () => {
    // The decided+uploaded clip acceptance is the server's existing
    // POST /jobs/:id/clips route (ADAAAA-6738 G1), which persists + publishes.
    // The watcher-first loop itself does NOT cut clips. Here we assert the
    // flag-on live outcome carries no server-cut clip (its `highlights` come
    // from the decide stash upload path, not analyzeJob) and that the loop
    // still drives the stash, whose build-or-discard uploads to that route.
    const { client } = fakePipeline();
    const w = fakeWatcher([{ summary: { t: 0 }, flag: null, deepVerdicts: [] }]);
    const outcome = await analyzeJob(client, frames([0, 1]), cut, {
      jobId: "job-clip",
      clipBeforeS: 4,
      clipAfterS: 4,
      gameHint: "soccer",
      liveWatcherFirst: true,
      streamId: "stream-clip",
    }, undefined, undefined, undefined, undefined, w.client);
    // Stash is fed so the decide side can build-or-discard + upload a clip.
    expect(w.log.filter((c) => c.method === "stashIngest")).toHaveLength(2);
    // No clip was cut server-side in the watcher-first path.
    expect(outcome.highlights).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The HTTP decide watcher client posts to the decide base. Verified with a
// stubbed global fetch (no live decide process).
// ---------------------------------------------------------------------------
describe("HttpDecideWatcherClient", () => {
  function stubFetch(): { calls: { url: string; body: any }[] } {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      })
    );
    return { calls };
  }

  afterEach(() => vi.unstubAllGlobals());

  it("POSTs watcher/stash/deep endpoints to <decideUrl>/app/* with the expected payloads", async () => {
    const { calls } = stubFetch();
    const c = new HttpDecideWatcherClient("http://decide:8000", { fetchFn: fetch });
    await c.watcherStart({ sessionId: "s1", streamId: "st1", traceJobId: "job1", config: {} });
    await c.watcherIngest({ ts: 1.5, seq: 3, players: [], objects: [], caption: "goal", audioPeak: 0.4 });
    await c.stashStart({ sessionId: "s1", streamId: "st1", jobId: "job1", config: {} });
    await c.stashIngest({ ts: 1.5, seq: 3, jpeg: "aGVsbG8=" });
    await c.watcherStep({ tickTs: 3 });
    await c.watcherStep2({ tickTs: 3 });
    await c.deepInvestigate({ flagTs: 2.5 });

    expect(calls.map((x) => x.url)).toEqual([
      "http://decide:8000/app/watcher/start",
      "http://decide:8000/app/watcher/ingest",
      "http://decide:8000/app/stash/start",
      "http://decide:8000/app/stash/ingest",
      "http://decide:8000/app/watcher/step",
      "http://decide:8000/app/watcher/step2",
      "http://decide:8000/app/deep/investigate",
    ]);
    expect(calls[0].body).toMatchObject({ sessionId: "s1", streamId: "st1", traceJobId: "job1" });
    expect(calls[1].body).toMatchObject({ ts: 1.5, seq: 3, players: [], objects: [], caption: "goal", audioPeak: 0.4, audioBaseline: 0 });
    expect(calls[3].body).toMatchObject({ ts: 1.5, seq: 3, jpeg: "aGVsbG8=", audio: "", audioMime: "" });
    expect(calls[4].body).toMatchObject({ tickTs: 3 });
    expect(calls[6].body).toMatchObject({ flagTs: 2.5 });
  });

  it("makeDecideWatcherClient returns null (safe no-op) when no DECIDE_URL is configured", () => {
    expect(makeDecideWatcherClient({})).toBeNull();
    expect(makeDecideWatcherClient({ decideUrl: "http://d:8000" })).toBeInstanceOf(HttpDecideWatcherClient);
  });
});
