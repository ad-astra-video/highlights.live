// Unit tests for the VOD match-context resolver orchestration (ADAAAA-7855).
//
// These cover the SERVER half: the bounded commentary probe, the single-parse
// ASR call, the bounded re-check schedule and the best-effort persistence. The
// pure fold (lexicon, confidence, monotonic guard, kit naming) is unit-tested in
// services/perceive/tests/test_match_context.py.
import { describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  DEFAULT_MATCH_CONTEXT_ASR_SECONDS,
  MATCH_CONTEXT_RECHECKS,
  createVodMatchContextResolver,
  extractCommentaryWav,
  matchContextEnabled,
  transcribeCommentary,
  type MatchContext,
} from "../src/match-context";

function withAsrServer(
  handler: (body: any) => { status?: number; json: any },
  fn: (url: string) => Promise<void>
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const out = handler(JSON.parse(raw || "{}"));
        res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out.json));
      });
    });
    server.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      try {
        await fn(url);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

function fakeJob(matchContext?: MatchContext) {
  return { id: "job1", status: "analyzing", matchContext } as any;
}

function fakeStore() {
  const jobs = new Map<string, any>([["job1", fakeJob()]]);
  const patches: any[] = [];
  return {
    patches,
    getJob: (id: string) => jobs.get(id),
    patchJob: async (id: string, patch: any) => {
      patches.push(patch);
      const next = { ...(jobs.get(id) ?? fakeJob()), ...patch };
      jobs.set(id, next);
      return next;
    },
  };
}

const sampleContext = (progress: number): MatchContext => ({
  sport: "soccer",
  teams: [
    {
      name: "Portugal",
      side: "home",
      kitColors: [{ primary: "red" }],
      confidence: 0.65,
      evidence: [{ source: "scorebug_ocr", snippet: "POR 1 - 0 ESP" }],
    },
    {
      name: "Spain",
      side: "away",
      kitColors: [{ primary: "white" }],
      confidence: 0.65,
      evidence: [{ source: "scorebug_ocr", snippet: "POR 1 - 0 ESP" }],
    },
  ],
  inferredAt: new Date().toISOString(),
  resolverVersion: 1,
  ambiguous: false,
  trail: [
    {
      at: new Date().toISOString(),
      progressPct: progress,
      names: [],
      action: ["no change"],
    },
  ],
});

describe("matchContextEnabled", () => {
  it("is on by default and off only for the documented rollback values", () => {
    expect(matchContextEnabled({} as any)).toBe(true);
    expect(matchContextEnabled({ MATCH_CONTEXT: "1" } as any)).toBe(true);
    expect(matchContextEnabled({ MATCH_CONTEXT: "0" } as any)).toBe(false);
    expect(matchContextEnabled({ MATCH_CONTEXT: "off" } as any)).toBe(false);
    expect(matchContextEnabled({ MATCH_CONTEXT: "false" } as any)).toBe(false);
  });
});

describe("transcribeCommentary", () => {
  it("posts the bounded prefix to /transcribe and returns the text", async () => {
    let seen: any = null;
    await withAsrServer(
      (body) => {
        seen = body;
        return { json: { text: "Spain in the white shirts" } };
      },
      async (url) => {
        const out = await transcribeCommentary(url, "AAAA", 5000);
        expect(out.text).toBe("Spain in the white shirts");
        expect(seen.audio).toBe("AAAA");
        expect(seen.sample_rate).toBe(16000);
      }
    );
  });

  it("degrades to no text on a 5xx or an unset ASR_URL", async () => {
    await withAsrServer(
      () => ({ status: 500, json: { error: "boom" } }),
      async (url) => {
        expect((await transcribeCommentary(url, "AAAA")).text).toBe("");
      }
    );
    expect((await transcribeCommentary(undefined, "AAAA")).text).toBe("");
    expect((await transcribeCommentary(undefined, "AAAA")).error).toBe("ASR_URL unset");
  });
});

describe("extractCommentaryWav", () => {
  const hasFfmpeg = (() => {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasFfmpeg)("decodes a bounded prefix and respects the byte cap", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mc-"));
    const src = path.join(dir, "tone.wav");
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-y",
      src,
    ]);
    const full = await extractCommentaryWav("ffmpeg", src, 1, 8 * 1024 * 1024);
    expect(full.bytes).toBeGreaterThan(44);
    expect(full.truncated).toBe(false);
    const capped = await extractCommentaryWav("ffmpeg", src, 1, 200);
    expect(capped.bytes).toBeLessThanOrEqual(200);
    expect(capped.truncated).toBe(true);
  });

  it("returns empty on a missing binary instead of throwing", async () => {
    const out = await extractCommentaryWav("/nonexistent/ffmpeg", "/nonexistent/video.mp4", 1, 1024);
    expect(out.b64).toBe("");
  });
});

describe("createVodMatchContextResolver", () => {
  const baseDeps = (store: ReturnType<typeof fakeStore>, client: any) => ({
    jobId: "job1",
    videoPath: "/data/job1.mp4",
    sessionId: "sess-1",
    hints: { title: "Portugal vs Spain", gameHint: "soccer", filename: "job1.mp4" },
    cfg: {
      ffmpegPath: "/nonexistent/ffmpeg",
      asrUrl: "http://127.0.0.1:1",
      asrSeconds: DEFAULT_MATCH_CONTEXT_ASR_SECONDS,
      asrMaxBytes: 8 * 1024 * 1024,
    },
    client,
    getJob: store.getJob,
    patchJob: store.patchJob,
    log: () => {},
    probeCommentary: async () => ({ text: "Spain in the white shirts", seconds: 90, bytes: 1000 }),
  });

  it("fires the three bounded checkpoints once each and persists every result", async () => {
    const store = fakeStore();
    const calls: number[] = [];
    const client = {
      postMatchContext: async (_sid: string, payload: any) => {
        calls.push(payload.progressPct);
        expect(payload.transcript).toBe("Spain in the white shirts");
        expect(payload.title).toBe("Portugal vs Spain");
        return { matchContext: sampleContext(payload.progressPct) };
      },
    };
    const r = createVodMatchContextResolver(baseDeps(store, client));
    r.begin();
    r.onProgress(5);
    r.onProgress(26);
    r.onProgress(51);
    r.onProgress(80);
    await r.finish();
    expect(calls).toEqual([...MATCH_CONTEXT_RECHECKS]);
    expect(store.patches.filter((p) => p.matchContext)).toHaveLength(3);
    expect(store.getJob("job1").matchContext.trail[0].progressPct).toBe(50);
  });

  it("probes the commentary once per job, not once per checkpoint", async () => {
    const store = fakeStore();
    const probe = vi.fn(async () => ({ text: "Portugal", seconds: 90, bytes: 900 }));
    const client = { postMatchContext: async () => ({ matchContext: sampleContext(0) }) };
    const r = createVodMatchContextResolver({ ...baseDeps(store, client), probeCommentary: probe });
    r.begin();
    r.onProgress(0);
    r.onProgress(30);
    r.onProgress(60);
    await r.finish();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("passes the previously persisted context so the Python guard can merge", async () => {
    const store = fakeStore();
    const seen: any[] = [];
    const client = {
      postMatchContext: async (_sid: string, payload: any) => {
        seen.push(payload.previous);
        return { matchContext: sampleContext(payload.progressPct) };
      },
    };
    const r = createVodMatchContextResolver(baseDeps(store, client));
    r.begin();
    r.onProgress(0);
    await r.finish();
    r.onProgress(30);
    await r.finish();
    expect(seen[0]).toBeUndefined();
    expect(seen[1]?.teams?.[0]?.name).toBe("Portugal");
  });

  it("never fails the job: a throwing client leaves matchContext absent", async () => {
    const store = fakeStore();
    const client = {
      postMatchContext: async () => {
        throw new Error("perceive 500");
      },
    };
    const r = createVodMatchContextResolver(baseDeps(store, client));
    r.begin();
    r.onProgress(0);
    await expect(r.finish()).resolves.toBeUndefined();
    expect(store.getJob("job1").matchContext).toBeUndefined();
  });

  it("is inert when the client has no match-context support", async () => {
    const store = fakeStore();
    const r = createVodMatchContextResolver(baseDeps(store, {}));
    r.begin();
    r.onProgress(0);
    await r.finish();
    expect(store.patches).toHaveLength(0);
  });
});
