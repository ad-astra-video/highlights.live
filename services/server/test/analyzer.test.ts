import { describe, it, expect, vi } from "vitest";
import { analyzeJob, EvidenceTracker, SessionLostError, type PipelineClient } from "../src/analyzer";

function fakeClient(over: Partial<PipelineClient> = {}): { client: PipelineClient; log: string[] } {
  const log: string[] = [];
  const client: PipelineClient = {
    reservePerceive: async () => {
      log.push("reserve");
      return { sessionId: "sess-x", appUrl: "", controlUrl: "" };
    },
    analyze: async () => {
      log.push("analyze");
      return { observation: { tracks: [], seq: 0, timestamp: 0 } };
    },
    decide: async () => {
      log.push("decide");
      return { isHighlight: true, score: 80, eventType: "KILL" };
    },
    stopPerceive: async () => {
      log.push("stop");
    },
    ...over,
  };
  return { client, log };
}

async function* frames(n: number) {
  for (let i = 0; i < n; i++) yield { seq: i, timestamp: i, imageB64: `img${i}` };
}

describe("analyzeJob", () => {
  it("reserves, analyzes every frame, and stops the perceive session in finally", async () => {
    const { client, log } = fakeClient();
    const cuts: number[] = [];
    const outcome = await analyzeJob(
      client,
      frames(3),
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` };
      },
      { jobId: "job-1", clipBeforeS: 4, clipAfterS: 4 }
    );
    expect(log).toEqual(["reserve", "analyze", "analyze", "analyze", "stop"]);
    expect(outcome.sessionId).toBe("sess-x");
    expect(outcome.framesAnalyzed).toBe(3);
  });

  it("cuts a clip and records a highlight when decide fires, only on candidates", async () => {
    let call = 0;
    const { client } = fakeClient({
      analyze: async () => {
        call++;
        if (call === 3) {
          return { observation: { tracks: [], seq: 2, timestamp: 2 }, candidate: { eventType: "KILL", timestamp: 2 } };
        }
        return { observation: { tracks: [], seq: call - 1, timestamp: call - 1 } };
      },
    });
    const cuts: number[] = [];
    const cut = async (ts: number) => {
      cuts.push(ts);
      return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` };
    };
    const outcome = await analyzeJob(client, frames(4), cut, { jobId: "j", clipBeforeS: 4, clipAfterS: 4 });
    expect(cuts).toEqual([2]);
    expect(outcome.highlights).toHaveLength(1);
    expect(outcome.highlights[0]).toMatchObject({ jobId: "j", eventType: "KILL", status: "pending" });
    expect(outcome.highlights[0].clipUri).toBe("/clips/c2.mp4");
  });

  it("fires onEvent for every observation, candidate, and highlight (live-console feed)", async () => {
    let call = 0;
    const { client } = fakeClient({
      analyze: async () => {
        call++;
        if (call === 2) {
          return { observation: { tracks: [{ trackId: "a", slot: 0, bbox: [0,0,0.2,0.2], kind: "player", lostFrames: 0 }], seq: 1, timestamp: 1 }, candidate: { eventType: "KILL", timestamp: 1 } };
        }
        return { observation: { tracks: [], seq: call - 1, timestamp: call - 1 } };
      },
    });
    const events: any[] = [];
    await analyzeJob(
      client,
      frames(3),
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" },
      (ev) => events.push(ev)
    );
    const types = events.map((e) => e.type);
    expect(types).toEqual(["observation", "observation", "candidate", "highlight", "observation"]);
    const cand = events.find((e) => e.type === "candidate");
    expect(cand.candidate).toEqual({ eventType: "KILL", timestamp: 1 });
    const hl = events.find((e) => e.type === "highlight");
    expect(hl.highlight.score).toBe(80);
  });

  it("does NOT cut when decide returns isHighlight=false", async () => {
    const { client } = fakeClient({
      analyze: async () => ({ observation: { tracks: [], seq: 0, timestamp: 0 }, candidate: { eventType: "MOVE", timestamp: 0 } }),
      decide: async () => ({ isHighlight: false, score: 20 }),
    });
    const cuts: number[] = [];
    const outcome = await analyzeJob(
      client,
      frames(2),
      async (ts) => {
        cuts.push(ts);
        return { clipId: "c", clipUri: "u" };
      },
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4 }
    );
    expect(cuts).toEqual([]);
    expect(outcome.highlights).toHaveLength(0);
  });

  it("re-reserves a fresh perceive session and continues when analyze 404s (session/runner lost mid-pass)", async () => {
    let reserveCalls = 0;
    let analyzeCalls = 0;
    const sessions = ["sess-a", "sess-b"];
    const stops: string[] = [];
    const client = fakeClient({
      reservePerceive: async () => {
        reserveCalls++;
        return { sessionId: sessions[reserveCalls - 1], appUrl: "", controlUrl: "" };
      },
      analyze: async (sid) => {
        analyzeCalls++;
        if (sid === "sess-a" && analyzeCalls === 2) {
          // The perceive runner flapped mid-pass: session lost on the 2nd frame.
          throw new SessionLostError();
        }
        return { observation: { tracks: [], seq: analyzeCalls - 1, timestamp: analyzeCalls - 1 } };
      },
      stopPerceive: async (sid) => {
        stops.push(sid);
      },
    });
    const outcome = await analyzeJob(
      client.client,
      frames(3),
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" }
    );
    // 2 reserves (initial + one re-reserve), 4 analyze invocations (3 frames,
    // with the 2nd frame's lost-session 404 retried once on the fresh session),
    // and both sessions stopped.
    expect(reserveCalls).toBe(2);
    expect(analyzeCalls).toBe(4);
    expect(outcome.sessionId).toBe("sess-b");
    expect(outcome.framesAnalyzed).toBe(3);
    expect(new Set(stops)).toEqual(new Set(["sess-a", "sess-b"]));
  });

  it("aborts cleanly (no more re-reserves) once the bounded re-reserve cap is exhausted", async () => {
    let reserveCalls = 0;
    const client = fakeClient({
      reservePerceive: async () => {
        reserveCalls++;
        return { sessionId: `sess-${reserveCalls}`, appUrl: "", controlUrl: "" };
      },
      analyze: async () => {
        throw new SessionLostError();
      },
    });
    await expect(
      analyzeJob(
        client.client,
        frames(2),
        async (ts) => ({ clipId: "c", clipUri: "u" }),
        { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "", maxReReserves: 2 }
      )
    ).rejects.toBeInstanceOf(SessionLostError);
    // 1 initial + maxReReserves=2 retries (the 3rd analyze throws straight out).
    expect(reserveCalls).toBe(3);
    expect(client.log.filter((x) => x === "stop").length).toBeGreaterThanOrEqual(1);
  });

  it("does not re-reserve on a non-404 analyze error — the pass aborts", async () => {
    let reserveCalls = 0;
    const client = fakeClient({
      reservePerceive: async () => {
        reserveCalls++;
        return { sessionId: "sess-x", appUrl: "", controlUrl: "" };
      },
      analyze: async () => {
        throw new Error("analyze failed: HTTP 503");
      },
    });
    await expect(
      analyzeJob(client.client, frames(2), async (ts) => ({ clipId: "c", clipUri: "u" }), {
        jobId: "j",
        clipBeforeS: 4,
        clipAfterS: 4,
        gameHint: "",
      })
    ).rejects.toThrow("HTTP 503");
    expect(reserveCalls).toBe(1);
  });

  it("delivers the job's closed vocabulary to perceive on every analyze (ADAAAA-4109)", async () => {
    const optsSeen: { gameHint?: string; preferLabels?: string[] }[] = [];
    const sess: string[] = [];
    // Reserve twice (sess-a then sess-b on the 404 re-reserve) to prove the
    // vocabulary rides the /analyze call for a FRESH re-reserved session too.
    const client = fakeClient({
      reservePerceive: async () => {
        const s = sess.length === 0 ? "sess-a" : "sess-b";
        sess.push(s);
        return { sessionId: s, appUrl: "", controlUrl: "" };
      },
      analyze: async (sid, _frame, opts) => {
        optsSeen.push(opts || {});
        if (sid === "sess-a" && optsSeen.length === 2) throw new SessionLostError();
        return { observation: { tracks: [], seq: optsSeen.length - 1, timestamp: optsSeen.length - 1 } };
      },
      stopPerceive: async () => {},
    });
    await analyzeJob(
      client.client,
      frames(3),
      async (ts) => ({ clipId: "c", clipUri: "u" }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", preferLabels: ["player", "soccer ball"] }
    );
    expect(optsSeen.length).toBe(4); // 3 frames; frame 2's session-lost retried on the fresh session
    for (const o of optsSeen) {
      expect(o.gameHint).toBe("soccer");
      expect(o.preferLabels).toEqual(["player", "soccer ball"]);
    }
    expect(sess).toContain("sess-b"); // a re-reserved session also got config on its first analyze
  });

  it("records max velocity + track count from observations", () => {
    const ev = new EvidenceTracker();
    ev.step({
      tracks: [
        { trackId: "a", slot: 0, bbox: [0.1, 0.1, 0.2, 0.2], kind: "player", lostFrames: 0 },
      ] as any,
    });
    ev.step({
      tracks: [
        { trackId: "a", slot: 0, bbox: [0.3, 0.1, 0.4, 0.2], kind: "player", lostFrames: 0 },
      ] as any,
    });
    expect(ev.trackCount).toBe(1);
    expect(ev.maxVelocity).toBeGreaterThan(0);
  });
});
