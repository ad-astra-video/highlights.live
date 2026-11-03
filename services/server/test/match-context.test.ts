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
  toMatchContextEvidence,
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

  // ADAAAA-7868 (AC-P8): the resolver's `evidenceStatus` is persisted ON the
  // job record beside `matchContext`, so an operator can read WHY a side has no
  // kit colour from GET /jobs/:id instead of a server log. It is a copy of what
  // the resolver returned (E4) and it never takes matchContext down (E3).
  it("persists the evidence status in the SAME patchJob as matchContext (E1/E4)", async () => {
    const store = fakeStore();
    const evidenceStatus = {
      scorebugOcrFrames: 1,
      commentaryChars: 2122,
      kitSamples: 252,
      kitSampleFrames: 224,
      kitSampleTracks: 17,
      scorebugSwatches: 134,
      sources: ["scorebug_ocr", "asr", "metadata"],
      kitClusterColors: ["white", "red"],
      kitColorsUnattributed: [],
      kitPriorUsed: ["away"],
      kitPriorMiss: [],
      kitPriorConflict: [],
      sessionId: "sess-1",
      sessionEvidence: true,
      sport: "soccer",
    };
    const client = {
      postMatchContext: async () => ({ matchContext: sampleContext(0), evidenceStatus }),
    };
    const r = createVodMatchContextResolver(baseDeps(store, client));
    r.begin();
    r.onProgress(0);
    await r.finish();
    // One write, not two: the context and its evidence land together.
    expect(store.patches).toHaveLength(1);
    expect(store.patches[0].matchContext).toBeTruthy();
    expect(store.patches[0].matchContextEvidence).toEqual(evidenceStatus);
    // Copy only — nothing was recomputed on the server side.
    expect(store.getJob("job1").matchContextEvidence).toEqual(evidenceStatus);
  });

  it("writes no evidence field when the resolver returns no status (E2)", async () => {
    for (const evidenceStatus of [undefined, {}]) {
      const store = fakeStore();
      const client = {
        postMatchContext: async () => ({ matchContext: sampleContext(0), evidenceStatus }),
      };
      const r = createVodMatchContextResolver(baseDeps(store, client));
      r.begin();
      r.onProgress(0);
      await r.finish();
      expect(store.patches).toHaveLength(1);
      expect(store.patches[0]).toHaveProperty("matchContext");
      expect(store.patches[0]).not.toHaveProperty("matchContextEvidence");
      expect(store.getJob("job1").matchContextEvidence).toBeUndefined();
    }
  });

  it("still persists matchContext when the store rejects the evidence field (E3)", async () => {
    const store = fakeStore();
    const writes: any[] = [];
    const inner = store.patchJob;
    const patchJob = async (id: string, patch: any) => {
      writes.push(patch);
      // Stand-in for `JobSchema.parse` in store.patchJob: a marker that fails
      // validation rejects the WHOLE patch, which must never cost the context.
      if ("matchContextEvidence" in patch) throw new Error("JobSchema: invalid matchContextEvidence");
      return inner(id, patch);
    };
    const client = {
      postMatchContext: async () => ({
        matchContext: sampleContext(0),
        evidenceStatus: { kitPriorUsed: ["away"] },
      }),
    };
    const r = createVodMatchContextResolver({ ...baseDeps(store, client), patchJob });
    r.begin();
    r.onProgress(0);
    await r.finish();
    expect(writes).toHaveLength(2);
    expect(writes[0]).toHaveProperty("matchContextEvidence");
    expect(writes[1]).not.toHaveProperty("matchContextEvidence");
    expect(store.getJob("job1").matchContext.teams[0].name).toBe("Portugal");
    expect(store.getJob("job1").matchContextEvidence).toBeUndefined();
  });
});

describe("toMatchContextEvidence (ADAAAA-7868)", () => {
  it("returns no value for an absent or empty status", () => {
    expect(toMatchContextEvidence(undefined).value).toBeUndefined();
    expect(toMatchContextEvidence(null).value).toBeUndefined();
    expect(toMatchContextEvidence({}).value).toBeUndefined();
  });

  it("validates a real status and keeps unknown evidence keys (faithful copy)", () => {
    const out = toMatchContextEvidence({
      scorebugOcrFrames: 1,
      kitClusterColors: ["white", "red"],
      kitColorsUnattributed: ["away"],
      kitPriorUsed: ["away"],
      kitPriorMiss: [],
      kitPriorConflict: [],
      kitSampleFrames: 224,
      someFutureChannel: { note: "kept" },
    });
    expect(out.error).toBeUndefined();
    expect(out.value?.kitClusterColors).toEqual(["white", "red"]);
    expect(out.value?.kitColorsUnattributed).toEqual(["away"]);
    // A resolver key the contract does not declare yet still reaches the record.
    expect((out.value as any).someFutureChannel).toEqual({ note: "kept" });
  });

  it("reports a validation failure instead of throwing (E3)", () => {
    const out = toMatchContextEvidence({ scorebugOcrFrames: "many", sources: "scorebug_ocr" });
    expect(out.value).toBeUndefined();
    expect(out.error).toContain("scorebugOcrFrames");
    expect(out.error).toContain("sources");
  });
});
