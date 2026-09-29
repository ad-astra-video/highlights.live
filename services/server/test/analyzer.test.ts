import { describe, it, expect, vi } from "vitest";
import {
  analyzeJob,
  EvidenceTracker,
  LiveRunShared,
  applyGroundingGate,
  decideOnCandidate,
  SessionLostError,
  pcmInt16ToWavB64,
  type PipelineClient,
} from "../src/analyzer";

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
      return { isHighlight: true, score: 80, eventType: "KILL", ...GROUNDED };
    },
    stopPerceive: async () => {
      log.push("stop");
    },
    // Stage-A audio gate client (INC-2 / ADAAAA-4325): no-op here — the audio
    // path is not exercised in these unit tests, but postAudio is now required
    // on the PipelineClient interface. null = the gate did not fire.
    postAudio: async () => {
      log.push("audio");
      return null;
    },
    // INC-6 find-and-track control forward: not exercised in these unit tests,
    // but required on the PipelineClient interface.
    controlForward: async () => {
      log.push("control");
    },
    // ADAAAA-5262 fine-tune trigger: not exercised in these unit tests, but
    // required on the PipelineClient interface.
    train: async () => ({ run: "x", checkpoint: "/runs/x/model.safetensors" }),
    ...over,
  };
  return { client, log };
}

// Supported-grounding output for mock decide calls: a claimed highlight must
// tie to supporting vision evidence (ADAAAA-6028 grounding gate, plan G3), so
// highlight-claiming mocks carry it. Tests that specifically exercise the gate
// override this (see the "grounding gate" describe block).
const GROUNDED = {
  grounding: { objects: ["ball"], evidence: "ball in net", supports: true },
};

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
      { jobId: "job-1", clipBeforeS: 4, clipAfterS: 4, gameHint: "" }
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
    const outcome = await analyzeJob(client, frames(4), cut, { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" });
    expect(cuts).toEqual([2]);
    expect(outcome.highlights).toHaveLength(1);
    expect(outcome.highlights[0]).toMatchObject({ jobId: "j", eventType: "KILL", status: "pending" });
    expect(outcome.highlights[0].clipUri).toBe("/clips/c2.mp4");
  });

  it("forwards INC-4 people-reaction evidence (ball + visual) from an analyze candidate to decide", async () => {
    let seen: any;
    const { client } = fakeClient({
      analyze: async () => ({
        observation: {
          tracks: [{ trackId: "t1", slot: 0, bbox: [0, 0, 0.2, 0.2], kind: "player", lostFrames: 0 }],
          seq: 0,
          timestamp: 0,
        },
        candidate: {
          eventType: "GOAL",
          timestamp: 0,
          ballVelocity: { speedMps: 22.5 },
          ballPossession: { possessingPlayerId: "t1" },
        },
      }),
      decide: async (evidence: any) => {
        seen = evidence;
        return { isHighlight: true, score: 90, eventType: "GOAL", ...GROUNDED };
      },
    });
    await analyzeJob(client, frames(1), async () => ({ clipId: "c", clipUri: "/c.mp4" }), {
      jobId: "j",
      clipBeforeS: 4,
      clipAfterS: 4,
      gameHint: "",
    });
    // ball velocity/possession from the CandidateEvent fold into reaction
    // evidence; humansInMotion = tracked-object count (visual celebration proxy).
    expect(seen.reaction).toEqual({
      crowdEnergy: 0,
      audioKind: "",
      humansInMotion: 1,
      ballSpeedMps: 22.5,
      ballPossessionId: "t1",
    });
  });

  it("clamps crowdEnergy and trackCount into decide schema bounds (ADAAAA-4736/5231)", async () => {
    // Real media can report peakEnergy > 1 and observe > 2 tracked objects;
    // without clamping the server would 422-reject the whole decide request.
    let seen: any;
    const { client } = fakeClient({
      analyze: async () => ({
        observation: {
          tracks: [
            { trackId: "a", slot: 0, bbox: [0, 0, 0.2, 0.2], kind: "player", lostFrames: 0 },
            { trackId: "b", slot: 1, bbox: [0.5, 0.5, 0.6, 0.6], kind: "player", lostFrames: 0 },
            { trackId: "c", slot: 2, bbox: [0.1, 0.9, 0.3, 1.0], kind: "player", lostFrames: 0 },
            { trackId: "d", slot: 3, bbox: [0.8, 0.1, 1.0, 0.3], kind: "player", lostFrames: 0 },
            { trackId: "e", slot: 4, bbox: [0.3, 0.3, 0.4, 0.4], kind: "player", lostFrames: 0 },
          ] as any,
          seq: 0,
          timestamp: 0,
        },
        candidate: {
          eventType: "GOAL",
          timestamp: 0,
          audio: { kind: "burst", ts: 0, firedAt: 0.2, onsetLatencyS: 0.2, peakEnergy: 1.5, baselineEnergy: 0.1 },
        } as any,
      }),
      decide: async (evidence: any) => {
        seen = evidence;
        return { isHighlight: true, score: 80, eventType: "GOAL", ...GROUNDED };
      },
    });
    await analyzeJob(client, frames(1), async () => ({ clipId: "c", clipUri: "/c.mp4" }), {
      jobId: "j",
      clipBeforeS: 4,
      clipAfterS: 4,
      gameHint: "",
    });
    // trackCount (5 observed) clamped to the decide schema's accepted top (2);
    // crowdEnergy (1.5 observed) clamped to 1.0; humansInMotion follows trackCount.
    expect(seen.trackCount).toBe(2);
    expect(seen.reaction.crowdEnergy).toBe(1.0);
    expect(seen.reaction.humansInMotion).toBe(2);
    // clamp01 / clampTrackCount helpers also guard NaN and negatives.
    const { clamp01, clampTrackCount, buildReactionEvidence } = await import("../src/analyzer");
    expect(clamp01(undefined)).toBe(0);
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clampTrackCount(undefined)).toBe(0);
    expect(clampTrackCount(-3)).toBe(0);
    expect(clampTrackCount(5)).toBe(2);
    expect(clampTrackCount(1)).toBe(1);
    expect(
      buildReactionEvidence({ audio: { peakEnergy: 2.4 } as any, ballVelocity: { speedMps: 99 } }, 12).crowdEnergy
    ).toBe(1);
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

  it("decides on the ANCHORED strike frame image and cuts at its timestamp when a candidate fires late (ADAAAA-4193)", async () => {
    let call = 0;
    const decideCalls: any[] = [];
    const { client } = fakeClient({
      analyze: async () => {
        call++;
        if (call === 4) {
          // Candidate fired during frame seq=3 (t=3, the late post-strike frame),
          // but ANCHORED at the peak-motion strike frame seq=2 (t=2).
          return { observation: { tracks: [], seq: 3, timestamp: 3 }, candidate: { eventType: "GOAL", timestamp: 2 } };
        }
        return { observation: { tracks: [], seq: call - 1, timestamp: call - 1 } };
      },
      decide: async (_evidence, opts) => {
        decideCalls.push(opts || {});
        return { isHighlight: true, score: 85, eventType: "GOAL", ...GROUNDED };
      },
    });
    const cuts: number[] = [];
    const outcome = await analyzeJob(
      client,
      frames(4),
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` };
      },
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer" }
    );
    // Two-tier decide (plan §E): coarse + confirmed-candidate burst confirmation.
    // BOTH are anchored to the strike frame (img2), NOT the late frame (img3).
    expect(decideCalls).toHaveLength(2);
    expect(decideCalls.map((o) => o.imageB64)).toEqual(["img2", "img2"]);
    // E1: the confirmation call carries a dense burstFrames[] in the payload.
    expect(decideCalls[1].burstFrames).toBeDefined();
    expect(decideCalls[1].burstFrames!.length).toBeGreaterThan(0);
    // clip cut centered at the anchored strike timestamp, not the late frame
    expect(cuts).toEqual([2]);
    expect(outcome.highlights[0]).toMatchObject({ eventType: "GOAL", start: Math.max(0, 2 - 4), end: 2 + 4 });
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
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" }
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

  it("carries the stream's LoRA ref to perceive on every analyze (ADAAAA-5324)", async () => {
    const optsSeen: { loraRef?: string }[] = [];
    const client = fakeClient({
      reservePerceive: async () => ({ sessionId: "sess-l", appUrl: "", controlUrl: "" }),
      analyze: async (sid, _frame, opts) => {
        optsSeen.push(opts || {});
        return { observation: { tracks: [], seq: optsSeen.length - 1, timestamp: optsSeen.length - 1 } };
      },
      stopPerceive: async () => {},
    });
    await analyzeJob(
      client.client,
      frames(2),
      async (ts) => ({ clipId: "c", clipUri: "u" }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", loraRef: "/models/lora-stream-7" }
    );
    expect(optsSeen.length).toBe(2);
    for (const o of optsSeen) {
      expect(o.loraRef).toBe("/models/lora-stream-7");
    }
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

describe("decideOnCandidate (INC-2 / ADAAAA-4325 slice 4: audio candidate -> decide on anchored frame)", () => {
  it("decides an audio candidate on the ANCHORED video frame and records a highlight when Gemma accepts", async () => {
    const decideCalls: any[] = [];
    const { client } = fakeClient({
      decide: async (_ev, opts) => {
        decideCalls.push(opts || {});
        return { isHighlight: true, score: 75, eventType: "GOAL", ...GROUNDED };
      },
    });
    const shared = new LiveRunShared();
    // The video leg already sampled frames t=0..4; the audio onset (t=3) must
    // anchor to img3 even though the audio gate fired off the video cadence.
    for (let i = 0; i <= 4; i++) shared.addFrame(i, i, `img${i}`);
    // Seed video evidence so the decide payload carries the current track state.
    shared.evidence.step({ tracks: [{ trackId: "a", slot: 0, bbox: [0, 0, 0.1, 0.1], kind: "player", lostFrames: 0 }] as any });
    const cuts: number[] = [];
    const events: any[] = [];
    await decideOnCandidate(
      client,
      shared,
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` };
      },
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer" },
      { eventType: "AUDIO", timestamp: 3, seq: 99 },
      (ev) => events.push(ev),
      { seq: 99, timestamp: 3 }
    );
    // Two-tier: coarse + burst confirmation, both anchored to the audio onset
    // frame (img3); the confirmation carries burstFrames (plan §E).
    expect(decideCalls).toHaveLength(2);
    expect(decideCalls.map((o) => o.imageB64)).toEqual(["img3", "img3"]);
    expect(decideCalls[1].burstFrames!.length).toBeGreaterThan(0);
    expect(cuts).toEqual([3]);
    expect(shared.highlights).toHaveLength(1);
    expect(shared.highlights[0]).toMatchObject({ jobId: "j", eventType: "GOAL", status: "pending" });
    expect(events.map((e) => e.type)).toEqual(["candidate", "highlight"]);
  });

  it("forwards INC-4 audio reaction evidence (crowd energy) from an audio candidate to decide", async () => {
    let seen: any;
    const { client } = fakeClient({
      decide: async (evidence: any) => {
        seen = evidence;
        return { isHighlight: true, score: 70, eventType: "GOAL", ...GROUNDED };
      },
    });
    const shared = new LiveRunShared();
    shared.addFrame(0, 0, "img0");
    shared.evidence.step({
      tracks: [
        { trackId: "a", slot: 0, bbox: [0, 0, 0.1, 0.1], kind: "player", lostFrames: 0 },
        { trackId: "b", slot: 1, bbox: [0.5, 0.5, 0.6, 0.6], kind: "player", lostFrames: 0 },
      ] as any,
    });
    await decideOnCandidate(
      client,
      shared,
      async () => ({ clipId: "c", clipUri: "u" }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer" },
      {
        eventType: "AUDIO",
        timestamp: 0,
        seq: 1,
        audio: { kind: "swell", ts: 0, firedAt: 0.5, onsetLatencyS: 0.5, peakEnergy: 0.93, baselineEnergy: 0.2 },
      }
    );
    // audio gate swell energy + humans-in-motion cue forwarded as reaction context
    expect(seen.reaction).toEqual({
      crowdEnergy: 0.93,
      audioKind: "swell",
      humansInMotion: 2,
      ballSpeedMps: 0,
      ballPossessionId: "",
    });
  });

  it("does NOT cut or record a highlight when decide rejects an audio candidate (cost bound)", async () => {
    const { client } = fakeClient({ decide: async () => ({ isHighlight: false, score: 10 }) });
    const shared = new LiveRunShared();
    shared.addFrame(0, 0, "img0");
    const cuts: number[] = [];
    const events: any[] = [];
    await decideOnCandidate(
      client,
      shared,
      async (ts) => {
        cuts.push(ts);
        return { clipId: "c", clipUri: "u" };
      },
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" },
      { eventType: "AUDIO", timestamp: 0, seq: 1 },
      (ev) => events.push(ev)
    );
    expect(cuts).toEqual([]);
    expect(shared.highlights).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["candidate"]); // candidate only, no highlight
  });

  it("LiveRunShared: video + audio legs accumulate highlights into the SAME array (runLiveJob wiring)", async () => {
    let call = 0;
    const { client } = fakeClient({
      analyze: async () => {
        call++;
        if (call === 1) {
          return { observation: { tracks: [], seq: 0, timestamp: 0 }, candidate: { eventType: "KILL", timestamp: 0 } };
        }
        return { observation: { tracks: [], seq: 0, timestamp: 0 } };
      },
      decide: async () => ({ isHighlight: true, score: 70, eventType: "GOAL", ...GROUNDED }),
    });
    const shared = new LiveRunShared();
    const outcome = await analyzeJob(
      client,
      frames(2),
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" },
      undefined,
      undefined,
      shared
    );
    // A video candidate already landed in shared.highlights, and the shared
    // array is the one analyzeJob returns/persists.
    expect(outcome.highlights).toBe(shared.highlights);
    // Now an audio candidate fires on the same live session — it routes to the
    // same decide path and same highlight array (no separate persistence pass).
    await decideOnCandidate(
      client,
      shared,
      async (ts) => ({ clipId: `a${ts}`, clipUri: `/clips/a${ts}.mp4` }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" },
      { eventType: "AUDIO", timestamp: 0, seq: 1 }
    );
    expect(shared.highlights.length).toBe(2);
  });
});

describe("Stage-A FP-rate metric on decideOnCandidate (INC-2 / ADAAAA-4325 slice 5)", () => {
  it("records accepted vs rejected audio candidates so the fpRate cost bound is tracked", async () => {
    let call = 0;
    const { client } = fakeClient({
      decide: async () => {
        call++;
        // Candidate 0: coarse (call 1) confirms -> its burst confirmation
        // (call 2) also confirms => accepted. Candidate 1: coarse (call 3)
        // rejects => no burst, rejected. (Two-tier, plan §E.)
        return call <= 2 ? { isHighlight: true, score: 80, ...GROUNDED } : { isHighlight: false, score: 10 };
      },
    });
    const shared = new LiveRunShared();
    shared.addFrame(0, 0, "img0");
    const cand = (ts: number) => ({
      eventType: "AUDIO",
      timestamp: ts,
      seq: ts,
      audio: { kind: "burst", ts, firedAt: ts + 0.3, onsetLatencyS: 0.3, peakEnergy: 0.8, baselineEnergy: 0.1 },
    });
    // First candidate accepted, second rejected.
    await decideOnCandidate(client, shared, async () => ({ clipId: "c", clipUri: "u" }), { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" }, cand(0));
    await decideOnCandidate(client, shared, async () => ({ clipId: "c", clipUri: "u" }), { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" }, cand(1));
    const s = shared.stageA.snapshot();
    expect(s.totalCandidates).toBe(2);
    expect(s.accepted).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.fpRate).toBeCloseTo(0.5, 10); // 1/2 rejected -> <= 60% budget
    expect(s.fpRateWithinBudget).toBe(true);
    expect(s.meanOnsetLatencyS).toBeCloseTo(0.3, 3); // both reported onsetLatencyS 0.3
    expect(shared.highlights).toHaveLength(1); // only the accepted one cut a clip
  });
});

describe("detail-first VOD (ADAAAA-4954)", () => {
  it("LiveRunShared respects the decideWindowN knob for its frame window size", () => {
    const shared = new LiveRunShared({ decideWindowN: 4 });
    for (let i = 0; i < 10; i++) shared.addFrame(i, i, `img${i}`);
    // Only the last 4 frames are kept in the rolling anchor window.
    expect(shared.framesWindow()).toHaveLength(4);
    expect(shared.framesWindow().map((f) => f.base64)).toEqual(["img6", "img7", "img8", "img9"]);
    // Default (live baseline) window is still the legacy 16.
    const def = new LiveRunShared();
    for (let i = 0; i < 20; i++) def.addFrame(i, i, `img${i}`);
    expect(def.framesWindow()).toHaveLength(16);
  });

  it("pcmInt16ToWavB64 wraps int16 PCM into a valid mono 16 kHz WAV (RIFF/fmt/data)", () => {
    // 4 samples of mono int16 LE (0, 0, 256, -256 -> 0x0100, 0xFF00).
    const pcm = Buffer.from([0, 0, 0, 0, 0, 1, 0, 255]);
    const wavB64 = pcmInt16ToWavB64(pcm.toString("base64"));
    const wav = Buffer.from(wavB64, "base64");
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.subarray(12, 16).toString()).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.subarray(36, 40).toString()).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(4 * 2); // 4 samples * 2 bytes
    expect(wav.length).toBe(44 + 8);
  });

  it("detail-first (decideWindowN set): forwards frames[] SEQUENCE + audio clip to decide", async () => {
    let seen: any;
    const { client } = fakeClient({
      analyze: async () => ({
        observation: { tracks: [], seq: 0, timestamp: 0 },
        candidate: { eventType: "GOAL", timestamp: 0 },
      }),
      decide: async (_ev, opts) => {
        seen = opts;
        return { isHighlight: true, score: 80, eventType: "GOAL", ...GROUNDED };
      },
    });
    const shared = new LiveRunShared({ decideWindowN: 4 });
    shared.addAudioChunk(0, Buffer.from([0, 0, 1, 0]).toString("base64"));
    await analyzeJob(
      client,
      frames(4),
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", decideWindowN: 4 },
      undefined,
      undefined,
      shared
    );
    expect(seen.frames).toBeDefined();
    expect(seen.frames!.length).toBeGreaterThanOrEqual(1);
    expect(seen.frames![0]).toMatchObject({ role: "full" });
    expect(seen.audioB64).toBeTruthy(); // surrounding audio clip forwarded
    expect(seen.imageB64).toBeDefined(); // anchored frame still present
  });

  it("live baseline (no decideWindowN): decide sees only the anchored single image, no frames/audio", async () => {
    let seen: any;
    const { client } = fakeClient({
      analyze: async () => ({
        observation: { tracks: [], seq: 0, timestamp: 0 },
        candidate: { eventType: "GOAL", timestamp: 0 },
      }),
      decide: async (_ev, opts) => {
        seen = opts;
        return { isHighlight: true, score: 80, eventType: "GOAL", ...GROUNDED };
      },
    });
    await analyzeJob(
      client,
      frames(2),
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer" }
    );
    expect(seen.frames).toBeUndefined();
    expect(seen.audioB64).toBeUndefined();
    expect(seen.imageB64).toBeDefined();
  });

  it("LiveRunShared audioClipB64 accumulates the ~10s rolling clip and trims old chunks", () => {
    const shared = new LiveRunShared();
    shared.addAudioChunk(0, Buffer.from([0, 0]).toString("base64"));
    shared.addAudioChunk(1, Buffer.from([1, 0]).toString("base64"));
    shared.addAudioChunk(2, Buffer.from([2, 0]).toString("base64"));
    expect(shared.audioClipB64()).toBeTruthy();
    // A far-later chunk trims chunks older than AUDIO_CLIP_KEEP_S (10 s).
    shared.addAudioChunk(30, Buffer.from([3, 0]).toString("base64"));
    const wav = Buffer.from(shared.audioClipB64(), "base64");
    expect(wav.length).toBe(44 + 2); // only the t=30 chunk (2 bytes) survives
  });
});

describe("grounded-evidence gate (ADAAAA-6028 / plan G3)", () => {
  it("accepts a claimed highlight that ties to supporting vision evidence", () => {
    const gate = applyGroundingGate(
      { isHighlight: true, score: 90, eventType: "GOAL", grounding: { objects: ["ball"], evidence: "ball in net", supports: true } },
      "GOAL"
    );
    expect(gate.accepted).toBe(true);
    expect(gate.reason).toBe("");
  });

  it("rejects a claimed highlight with NO grounding object (the board's exact failure mode)", () => {
    const gate = applyGroundingGate({ isHighlight: true, score: 95, eventType: "GOAL" }, "GOAL");
    expect(gate.accepted).toBe(false);
    expect(gate.reason).toContain("no grounding evidence");
  });

  it("rejects a claimed highlight whose grounding REFUTES the event type (supports=false)", () => {
    const gate = applyGroundingGate(
      { isHighlight: true, score: 95, eventType: "GOAL", grounding: { objects: ["ball"], evidence: "ball nowhere near goal", supports: false } },
      "GOAL"
    );
    expect(gate.accepted).toBe(false);
    expect(gate.reason).toContain("refutes");
  });

  it("rejects a claimed event with no cited evidence (empty objects/evidence/ocrDelta)", () => {
    const gate = applyGroundingGate(
      { isHighlight: true, score: 70, eventType: "GOAL", grounding: { objects: [], evidence: "", ocrDelta: "", supports: true } },
      "GOAL"
    );
    expect(gate.accepted).toBe(false);
    expect(gate.reason).toContain("no cited evidence");
  });

  it("accepts when grounding supplies OCR-delta-only support", () => {
    const gate = applyGroundingGate(
      { isHighlight: true, score: 60, eventType: "GOAL", grounding: { ocrDelta: "scoreboard 0-0 -> 1-0", supports: true } },
      "GOAL"
    );
    expect(gate.accepted).toBe(true);
  });

  it("is a no-op for non-highlight decisions (never a counted rejection)", () => {
    const gate = applyGroundingGate({ isHighlight: false, score: 20 }, "GOAL");
    expect(gate.accepted).toBe(false);
    expect(gate.reason).toBe("");
  });

  it("decideOnCandidate rejects a grounding-less claimed highlight: no clip, counted, candidateBlocked emitted", async () => {
    const { client } = fakeClient({ decide: async () => ({ isHighlight: true, score: 90, eventType: "GOAL" }) });
    const shared = new LiveRunShared();
    shared.addFrame(0, 0, "img0");
    shared.evidence.step({ tracks: [{ trackId: "a", slot: 0, bbox: [0, 0, 0.1, 0.1], kind: "player", lostFrames: 0 }] as any });
    const cuts: number[] = [];
    const events: any[] = [];
    await decideOnCandidate(
      client,
      shared,
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: "/clips/c.mp4" };
      },
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer" },
      { eventType: "GOAL", timestamp: 0, seq: 1 },
      (ev) => events.push(ev)
    );
    expect(cuts).toEqual([]); // no clip cut
    expect(shared.highlights).toHaveLength(0); // not surfaced
    expect(shared.groundingRejections).toBe(1); // G3 rejections are measurable
    const blocked = events.find((e) => e.type === "candidateBlocked");
    expect(blocked).toBeDefined();
    expect(blocked.reason).toContain("grounding gate");
  });

  it("analyzeJob rejects an un-grounded candidate and reports groundingRejections on the outcome", async () => {
    let call = 0;
    const { client } = fakeClient({
      analyze: async () => {
        call++;
        if (call === 1) return { observation: { tracks: [], seq: 0, timestamp: 0 }, candidate: { eventType: "GOAL", timestamp: 0 } };
        return { observation: { tracks: [], seq: call - 1, timestamp: call - 1 } };
      },
      decide: async () => ({ isHighlight: true, score: 90, eventType: "GOAL" }),
    });
    const cuts: number[] = [];
    const outcome = await analyzeJob(
      client,
      frames(2),
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: "/clips/c.mp4" };
      },
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer" }
    );
    expect(cuts).toEqual([]);
    expect(outcome.highlights).toHaveLength(0);
    expect(outcome.groundingRejections).toBe(1);
  });
});
describe("A — 60s rolling window + processed-frame/finding cache (ADAAAA-6029)", () => {
  const obs = (seq: number, over: Partial<{ tracks: any[]; objects: any[]; ocr: string[] }> = {}) => ({
    tracks: over.tracks ?? [{ trackId: `t${seq}`, label: "player", bbox: [0.1, 0.2, 0.3, 0.4] }],
    objects: over.objects ?? [],
    ocr: over.ocr ?? (seq % 2 ? [] : ["SCORE 1-0"]),
    seq,
    timestamp: seq,
  });

  it("A1: window is 60s time-bounded AND hard-capped (no growth on long streams)", () => {
    // Time-bounded: a frame older than 60 s behind the newest is dropped even
    // though the count cap never engaged (only 2 frames were added).
    const shared = new LiveRunShared();
    shared.addFrame(0, 0, "img0");
    expect(shared.cachedFrameCount()).toBe(1);
    shared.addFrame(1, 100, "img100"); // 100 s later: frame 0 falls out of the window
    expect(shared.cachedFrameCount()).toBe(1);
    expect(shared.anchor(100)).toBe("img100");

    // Hard count cap: many frames packed into <60 s (10 fps) can't grow past 60.
    const dense = new LiveRunShared();
    for (let i = 0; i < 500; i++) dense.addFrame(i, i * 0.1, `img${i}`);
    expect(dense.cachedFrameCount()).toBe(60);

    // Bounded on a long 1 fps stream: still never exceeds the cap.
    const long = new LiveRunShared();
    for (let i = 0; i < 2000; i++) long.addFrame(i, i, `img${i}`);
    expect(long.cachedFrameCount()).toBeLessThanOrEqual(60);
  });

  it("A1: findings are cached per frame and REUSED (no re-analysis) — windowFactsText reflects them", () => {
    const shared = new LiveRunShared();
    shared.addFrame(0, 12, "img0");
    shared.setFindings(0, obs(0));
    shared.addFrame(1, 13, "img1");
    shared.setFindings(1, obs(1, { ocr: [] }));
    const text = shared.windowFactsText();
    // Track label + OCR from the cached /analyze result, assembled — not recomputed.
    expect(text).toContain("tracks:player@");
    expect(text).toContain("SCORE 1-0");
    // Stable/reused: same cache, same output (no side effects / re-analyze).
    expect(shared.windowFactsText()).toBe(text);
  });

  it("A1: behavior identical when the window has nothing to add (empty text)", () => {
    const shared = new LiveRunShared();
    expect(shared.windowFactsText()).toBe("");
    // Frames WITHOUT cached findings also add nothing.
    shared.addFrame(0, 0, "img0");
    expect(shared.windowFactsText()).toBe("");
  });

  it("A2: window facts (incl. candidates) are included and bounded by the maxChars cap", () => {
    const shared = new LiveRunShared();
    for (let i = 0; i < 40; i++) {
      shared.addFrame(i, i, `img${i}`);
      shared.setFindings(i, obs(i));
    }
    shared.addCandidate({ timestamp: 39, eventType: "goal_scored", reaction: { crowdEnergy: 0.9, audioKind: "burst", humansInMotion: 2, ballSpeedMps: 12, ballPossessionId: "p9" } });
    const text = shared.windowFactsText();
    expect(text).toContain("candidate:goal_scored");
    expect(text).toContain("(rxn:e=0.90)");

    // Hard token/cap bound: even a pathological payload is truncated to maxChars.
    const tight = shared.windowFactsText({ maxChars: 100 });
    expect(tight.length).toBeLessThanOrEqual(100 + 1); // +1 for the ellipsis char
    // Default cap is WINDOW_FACTS_MAX_CHARS.
    expect(text.length).toBeLessThanOrEqual(2400 + 1);
  });

  it("A2: every decide call carries priorContextText (empty when window adds nothing)", async () => {
    let seen: any;
    const { client } = fakeClient({
      analyze: async () => ({ observation: { tracks: [], seq: 0, timestamp: 0 }, candidate: { eventType: "GOAL", timestamp: 0 } }),
      decide: async (_ev, opts) => {
        seen = opts;
        return { isHighlight: true, score: 80, eventType: "GOAL" };
      },
    });
    // detail-first path: candidate processed after finding-cache population.
    const shared = new LiveRunShared({ decideWindowN: 4 });
    await analyzeJob(
      client,
      frames(2),
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", decideWindowN: 4 },
      undefined,
      undefined,
      shared
    );
    expect(seen.priorContextText).toBeDefined();
    // Window had frames but no findings were recorded by the stub -> text may be
    // "" or assembled; assert it is a string and bounded.
    expect(typeof seen.priorContextText).toBe("string");
    expect(seen.priorContextText!.length).toBeLessThanOrEqual(2400 + 1);
  });

  it("A2: live baseline carries priorContextText but frames/audio stay unchanged (no regression)", async () => {
    let seen: any;
    const { client } = fakeClient({
      analyze: async () => ({
        observation: { tracks: [], seq: 0, timestamp: 0 },
        candidate: { eventType: "GOAL", timestamp: 0 },
      }),
      decide: async (_ev, opts) => {
        seen = opts;
        return { isHighlight: true, score: 80, eventType: "GOAL" };
      },
    });
    await analyzeJob(
      client,
      frames(1),
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" }
    );
    // A2 window facts are present and bounded...
    expect(typeof seen.priorContextText).toBe("string");
    expect(seen.priorContextText.length).toBeLessThanOrEqual(2400 + 1);
    // ...while the live baseline's vision inputs are byte-for-byte unchanged.
    expect(seen.frames).toBeUndefined();
    expect(seen.audioB64).toBeUndefined();
    expect(seen.imageB64).toBeDefined();
  });
});
describe("E — motion-aware confirmation burst tier (ADAAAA-6030 / plan §E)", () => {
  it("E1: burstFrames spans ±2.5 s around T and is bounded by the live cap", () => {
    const shared = new LiveRunShared();
    for (let i = 0; i < 20; i++) shared.addFrame(i, i, `img${i}`); // 1 fps
    // Frames within [T-2.5, T+2.5] for T=10 => ts 8,9,10,11,12 (5 frames).
    const burst = shared.burstFrames(10, { max: 6 });
    expect(burst.map((f) => f.base64)).toEqual(["img8", "img9", "img10", "img11", "img12"]);
    expect(burst.length).toBeLessThanOrEqual(6); // LIVE_BURST_MAX bound
    // No cached frame within the span -> empty burst (burst skipped upstream).
    expect(shared.burstFrames(100, { max: 6 })).toEqual([]);
  });

  it("E1: dense VOD cache is trimmed to the VOD cap, kept centered on T", () => {
    const shared = new LiveRunShared();
    for (let i = 0; i < 30; i++) shared.addFrame(i, i * 0.5, `img${i}`); // 2 fps
    const burst = shared.burstFrames(10, { max: 8 });
    expect(burst.length).toBeLessThanOrEqual(8); // VOD_BURST_MAX bound
    // 2 fps over ±2.5 s => ~10 in-span frames trimmed to the 8 cap.
  });

  it("confirmed candidate runs a SECOND decide with burstFrames; non-highlight pays one call", async () => {
    const calls: any[] = [];
    const { client } = fakeClient({
      analyze: async () => ({ observation: { tracks: [], seq: 0, timestamp: 0 }, candidate: { eventType: "GOAL", timestamp: 0 } }),
      decide: async (_ev, opts) => {
        calls.push(opts || {});
        return { isHighlight: true, score: 80, eventType: "GOAL", ...GROUNDED };
      },
    });
    const shared = new LiveRunShared();
    shared.addFrame(0, 0, "img0");
    await analyzeJob(
      client,
      frames(1),
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" },
      undefined,
      undefined,
      shared
    );
    expect(calls).toHaveLength(2); // coarse + burst confirmation
    expect(calls[0].burstFrames).toBeUndefined(); // coarse carries no burst
    expect(calls[1].burstFrames).toBeDefined(); // confirmation carries burst
    expect(shared.highlights).toHaveLength(1);
  });

  it("A5: when no cached frame lies in the burst span, burst is skipped (single decide, coarse kept)", async () => {
    let decideCalls = 0;
    const { client } = fakeClient({
      analyze: async () => ({ observation: { tracks: [], seq: 0, timestamp: 0 }, candidate: { eventType: "GOAL", timestamp: 100 } }),
      decide: async () => {
        decideCalls++;
        return { isHighlight: true, score: 80, eventType: "GOAL", ...GROUNDED };
      },
    });
    const shared = new LiveRunShared();
    shared.addFrame(0, 0, "img0"); // far from candidate T=100
    const cuts: number[] = [];
    await analyzeJob(
      client,
      frames(1),
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` };
      },
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" },
      undefined,
      undefined,
      shared
    );
    expect(decideCalls).toBe(1); // burst skipped, no second call
    expect(shared.highlights).toHaveLength(1); // coarse verification kept
    expect(cuts).toEqual([100]);
  });

  it("A5: a throwing burst confirmation never blocks the paid path — coarse verdict kept", async () => {
    let decideCalls = 0;
    const { client } = fakeClient({
      analyze: async () => ({ observation: { tracks: [], seq: 0, timestamp: 0 }, candidate: { eventType: "GOAL", timestamp: 0 } }),
      decide: async () => {
        decideCalls++;
        if (decideCalls === 2) throw new Error("burst runner down");
        return { isHighlight: true, score: 80, eventType: "GOAL", ...GROUNDED };
      },
    });
    const shared = new LiveRunShared();
    shared.addFrame(0, 0, "img0");
    const cuts: number[] = [];
    await analyzeJob(
      client,
      frames(1),
      async (ts) => {
        cuts.push(ts);
        return { clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` };
      },
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" },
      undefined,
      undefined,
      shared
    );
    // Burst attempted (2 calls) but its failure fell back to the coarse verdict.
    expect(decideCalls).toBe(2);
    expect(shared.highlights).toHaveLength(1);
    expect(cuts).toEqual([0]);
  });
});
