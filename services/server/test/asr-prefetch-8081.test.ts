// ADAAAA-8081: ASR off the live decide critical path.
//
// Evidence (ADAAAA-8074 legs A/B, master efaebe1, 4 images / in-flight 2 /
// keep-ratio 0.66): decide p50 5 003 / 5 022 ms (gate 5 500 PASS) but max
// 14 954 / 13 446 ms (gate 8 000 FAIL). Two of the four slow rows were 1-image
// tail windows where ASR took 4.27 s / 5.48 s and the decide call could not come
// in under 8 s, because the decide service transcribes the window serially
// ahead of gemma inside the same call.
//
// These tests pin the fix:
//   1. `AsrPrefetcher` runs the transcription in a side lane: content-addressed
//      cache + single flight (a re-decide of the same clip pays once), bounded
//      concurrency, and `ran:false` on every failure path (which is what keeps
//      the decide service's inline ASR as a fallback, so coverage never falls).
//   2. The live window payload carries the transcript (`opts.asr`) ONLY when ASR
//      actually ran — an absent block is the byte-identical pre-8081 request.
//   3. The live analyzer config carries the lane's endpoint + posture, and the
//      compose file ships the knob default so a deploy cannot disagree.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AsrPrefetcher } from "../src/asr-prefetch";
import { buildObserveDecideRequest, LiveRunShared } from "../src/analyzer";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";
import type { ObserveDecidePayload } from "../src/observe-loop";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");

function pcmChunkB64(): string {
  // 100 ms of mono 16 kHz int16 silence (enough for the audio ring to slice).
  return Buffer.alloc(3200).toString("base64");
}

function payload(): ObserveDecidePayload {
  return {
    centerTs: 1.0,
    frames: [
      { ts: 0.5, imageB64: "f05" },
      { ts: 1.0, imageB64: "f10" },
      { ts: 1.5, imageB64: "f15" },
    ],
    seeds: [],
    biasHints: [],
    capped: false,
    droppedCount: 0,
  };
}

/** One fake ASR endpoint whose behaviour the test controls. */
function fakeAsr(handler?: (body: any, n: number) => Promise<Response> | Response) {
  let calls = 0;
  const fetchImpl = (async (_url: any, init: any) => {
    calls++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (handler) return handler(body, calls);
    return new Response(JSON.stringify({ text: "what a goal", asrError: "" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe("AsrPrefetcher (ADAAAA-8081)", () => {
  it("is inert without an ASR endpoint (decide keeps its inline ASR)", () => {
    const p = new AsrPrefetcher({});
    expect(p.enabled).toBe(false);
    expect(p.start("clip")).toBeNull();
  });

  it("returns null for an empty clip", () => {
    const p = new AsrPrefetcher({ asrUrl: "http://asr:8082" });
    expect(p.start("")).toBeNull();
  });

  it("transcribes once and serves the cached transcript for the same clip", async () => {
    const asr = fakeAsr();
    const p = new AsrPrefetcher({ asrUrl: "http://asr:8082", fetchImpl: asr.fetchImpl });
    const first = await p.start("clip-A");
    expect(first).toMatchObject({ transcript: "what a goal", ran: true });
    expect(first!.latencyS).toBeGreaterThanOrEqual(0);
    // A re-decide of the SAME window (recall / confirm re-read) must not pay ASR
    // twice — this was measured as g99 + g99:call2 both transcribing one window.
    const second = await p.start("clip-A");
    expect(second!.transcript).toBe("what a goal");
    expect(asr.calls()).toBe(1);
    expect(p.stats.hits).toBe(1);
  });

  it("single-flights concurrent requests for the same clip", async () => {
    const asr = fakeAsr(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ text: "go" }), { status: 200 });
    });
    const p = new AsrPrefetcher({ asrUrl: "http://asr:8082", fetchImpl: asr.fetchImpl });
    const [a, b] = await Promise.all([p.start("clip-B"), p.start("clip-B")]);
    expect(a!.transcript).toBe("go");
    expect(b!.transcript).toBe("go");
    expect(asr.calls()).toBe(1);
  });

  it("bounds concurrency so the lane cannot recreate the ASR contention tail", async () => {
    let live = 0;
    let peak = 0;
    const asr = fakeAsr(async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 20));
      live--;
      return new Response(JSON.stringify({ text: "x" }), { status: 200 });
    });
    const p = new AsrPrefetcher({ asrUrl: "http://asr:8082", maxConcurrent: 2, fetchImpl: asr.fetchImpl });
    await Promise.all([p.start("c1"), p.start("c2"), p.start("c3"), p.start("c4")]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(asr.calls()).toBe(4);
  });

  it("reports ran:false (and does NOT cache) on an HTTP error, so inline ASR covers it", async () => {
    const asr = fakeAsr(() => new Response("nope", { status: 503 }));
    const p = new AsrPrefetcher({ asrUrl: "http://asr:8082", fetchImpl: asr.fetchImpl });
    const res = await p.start("clip-C");
    expect(res).toMatchObject({ ran: false, transcript: "" });
    expect(res!.error).toContain("503");
    // Not cached: the next attempt retries instead of serving a permanent miss.
    await p.start("clip-C");
    expect(asr.calls()).toBe(2);
    expect(p.stats.failures).toBe(2);
  });

  it("reports ran:false on a transport failure (never rejects)", async () => {
    const p = new AsrPrefetcher({
      asrUrl: "http://asr:8082",
      timeoutMs: 5_000,
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const res = await p.start("clip-D");
    expect(res).toMatchObject({ ran: false, transcript: "" });
    expect(res!.error).toContain("ECONNREFUSED");
  });

  it("treats a 200-with-empty-text (silent window) as RAN — coverage must not fall", async () => {
    const asr = fakeAsr(() =>
      new Response(JSON.stringify({ text: "", asrError: "silent_window" }), { status: 200 })
    );
    const p = new AsrPrefetcher({ asrUrl: "http://asr:8082", fetchImpl: asr.fetchImpl });
    const res = await p.start("clip-silent");
    expect(res!.ran).toBe(true);
    expect(res!.transcript).toBe("");
  });

  it("times out a hung ASR instead of stalling the pass", async () => {
    const p = new AsrPrefetcher({
      asrUrl: "http://asr:8082",
      timeoutMs: 250,
      fetchImpl: ((_u: any, init: any) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        })) as unknown as typeof fetch,
    });
    const res = await p.start("clip-E");
    expect(res!.ran).toBe(false);
  });
});

describe("live decide payload carries the side-lane transcript (ADAAAA-8081)", () => {
  function cfgWith(extra: Record<string, unknown> = {}) {
    return {
      gameHint: "soccer",
      audioContext: true,
      ...extra,
    } as Parameters<typeof buildObserveDecideRequest>[0];
  }

  it("forwards opts.asr when ASR ran (and still sends the same clip)", () => {
    const run = new LiveRunShared();
    for (let i = 0; i < 20; i++) run.addAudioChunk(i * 0.1, pcmChunkB64());
    const { opts } = buildObserveDecideRequest(cfgWith(), run, payload(), {
      transcript: "what a goal",
      latencyS: 1.15,
      ran: true,
    });
    expect(opts!.asr).toEqual({ transcript: "what a goal", latencyS: 1.15, ran: true });
    // The clip still rides the payload: `windowAudioPresent` / the confirm path
    // read it, and `windowAudioSlice` must stay the single source for both.
    expect((opts!.audioB64 as string).length).toBeGreaterThan(0);
  });

  it("omits opts.asr when the prefetch missed (decide transcribes inline, as before)", () => {
    const run = new LiveRunShared();
    for (let i = 0; i < 20; i++) run.addAudioChunk(i * 0.1, pcmChunkB64());
    const { opts } = buildObserveDecideRequest(cfgWith(), run, payload(), {
      transcript: "",
      latencyS: 0.2,
      ran: false,
      error: "HTTP 503",
    });
    expect(opts).not.toHaveProperty("asr");
    // …and with no prefetch at all the request is byte-identical to pre-8081.
    expect(buildObserveDecideRequest(cfgWith(), run, payload()).opts).not.toHaveProperty("asr");
  });

  it("live analyzer config carries the lane endpoint + posture", () => {
    const cfg = loadConfig({
      PERCEIVE_URL: "http://p",
      DECIDE_URL: "http://d",
      ASR_URL: "http://asr:8082",
      LIVE_OBSERVE_LOOP: "1",
      DECIDE_CONFIRM_ENABLED: "1",
    });
    const analyzer = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-8081", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    });
    expect(analyzer.asrUrl).toBe("http://asr:8082");
    expect(analyzer.decideAsrPrefetch).toBe(true);
    expect(analyzer.decideAsrPrefetchTimeoutMs).toBe(6000);
    // ADAAAA-8300: the lane's in-flight budget defaults to the pre-8300 source
    // constant (2) and is now env-tunable, so a wider lane is not a rebuild.
    expect(analyzer.decideAsrPrefetchConcurrency).toBe(2);
  });

  it("LIVE_DECIDE_ASR_PREFETCH_CONCURRENCY raises the lane budget (ADAAAA-8300)", () => {
    const cfg = loadConfig({
      PERCEIVE_URL: "http://p",
      DECIDE_URL: "http://d",
      ASR_URL: "http://asr:8082",
      LIVE_OBSERVE_LOOP: "1",
      LIVE_DECIDE_ASR_PREFETCH_CONCURRENCY: "4",
    });
    const analyzer = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-8300", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    });
    expect(analyzer.decideAsrPrefetchConcurrency).toBe(4);
  });

  it("LIVE_DECIDE_ASR_PREFETCH=0 is a config-only rollback", () => {
    const cfg = loadConfig({
      PERCEIVE_URL: "http://p",
      DECIDE_URL: "http://d",
      ASR_URL: "http://asr:8082",
      LIVE_OBSERVE_LOOP: "1",
      LIVE_DECIDE_ASR_PREFETCH: "0",
      LIVE_DECIDE_ASR_PREFETCH_TIMEOUT_MS: "2500",
    });
    const analyzer = buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-8081b", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
    });
    expect(analyzer.decideAsrPrefetch).toBe(false);
    expect(analyzer.decideAsrPrefetchTimeoutMs).toBe(2500);
  });

  it("compose ships the lane knobs on the server service", () => {
    const lines = compose.split("\n");
    const start = lines.findIndex((l) => l === "  server:");
    expect(start).toBeGreaterThanOrEqual(0);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^  [a-zA-Z0-9_.-]+:\s*$/.test(lines[i])) {
        end = i;
        break;
      }
    }
    const server = lines.slice(start, end).join("\n");
    expect(server).toContain("LIVE_DECIDE_ASR_PREFETCH=${LIVE_DECIDE_ASR_PREFETCH:-1}");
    expect(server).toContain(
      "LIVE_DECIDE_ASR_PREFETCH_TIMEOUT_MS=${LIVE_DECIDE_ASR_PREFETCH_TIMEOUT_MS:-6000}"
    );
    // ADAAAA-8300: the lane's in-flight budget ships with the same default as
    // the prefetcher's own constant, so the deploy cannot disagree with the code.
    expect(server).toContain(
      "LIVE_DECIDE_ASR_PREFETCH_CONCURRENCY=${LIVE_DECIDE_ASR_PREFETCH_CONCURRENCY:-2}"
    );
  });
});
