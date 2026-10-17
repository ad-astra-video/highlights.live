import { describe, it, expect, vi } from "vitest";
import {
  analyzeJob,
  assembleFrameSequence,
  EvidenceTracker,
  LiveRunShared,
  decideOnCandidate,
  SessionLostError,
  pcmInt16ToWavB64,
  rmsNormalized,
  sleep,
  backoffDelayMs,
  DEFAULT_ANALYSIS_FPS,
  DEFAULT_MAX_FRAMES_PER_ANALYSIS,
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
      return { isHighlight: true, score: 80, eventType: "KILL" };
    },
    // Increment D (ADAAAA-6467): the worker fires the warm-up / re-check
    // planner; a canned valid plan keeps the loop unaffected.
    plan: async () => {
      log.push("plan");
      return { planVersion: 1, category: "soccer", intent: "", source: "planner-fallback", maxTracks: 3, targets: [{ label: "player", role: "player" }], reason: "test" };
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
    expect(log).toEqual(["reserve", "plan", "analyze", "analyze", "analyze", "stop"]);
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
        return { isHighlight: true, score: 90, eventType: "GOAL" };
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
        return { isHighlight: true, score: 80, eventType: "GOAL" };
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

  it("publishes MULTIPLE highlights at decision time — interleaved with observations, not batched at job end (ADAAAA-6352)", async () => {
    let call = 0;
    const { client } = fakeClient({
      analyze: async () => {
        call++;
        if (call === 2 || call === 4) {
          return { observation: { tracks: [], seq: call - 1, timestamp: call - 1 }, candidate: { eventType: "KILL", timestamp: call - 1 } };
        }
        return { observation: { tracks: [], seq: call - 1, timestamp: call - 1 } };
      },
    });
    const events: any[] = [];
    const outcome = await analyzeJob(
      client,
      frames(4),
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "" },
      (ev) => events.push(ev)
    );
    // Each accepted highlight is emitted IMMEDIATELY after its candidate's
    // decide inside the frame loop (not deferred until all frames are done): the
    // event stream interleaves candidate->highlight with the surrounding
    // observations, and there is no trailing batch of highlights at the end.
    expect(events.map((e) => e.type)).toEqual([
      "observation", // frame 1
      "observation", "candidate", "highlight", // frame 2 (accepted)
      "observation", // frame 3
      "observation", "candidate", "highlight", // frame 4 (accepted)
    ]);
    expect(events.filter((e) => e.type === "highlight")).toHaveLength(2);
    expect(outcome.highlights).toHaveLength(2);
  });

  it("decides on the ANCHORED strike frame image and cuts at its timestamp when a candidate fires late (ADAAAA-4193)", async () => {
    let call = 0;
    const decideImages: (string | undefined)[] = [];
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
        decideImages.push(opts?.imageB64);
        return { isHighlight: true, score: 85, eventType: "GOAL" };
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
    // decide saw the anchored strike frame (img2), NOT the late current frame (img3)
    expect(decideImages).toEqual(["img2"]);
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
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "", sessionRetryBackoffMs: 0, sessionRetryBackoffMaxMs: 0 }
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
        { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "", maxReReserves: 2, sessionRetryBackoffMs: 0, sessionRetryBackoffMaxMs: 0 }
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

  it("sleeps bounded exponential backoff between session-lost re-reserves (ADAAAA-6577)", async () => {
    // Stub setTimeout to record the requested delay and resolve immediately via
    // microtask, so the loop proceeds without real waiting while we capture the
    // backoff cadence. Only the sleep() backoff uses setTimeout on this path
    // (the plan controller re-check uses setInterval), so `delays` is exact.
    const delays: number[] = [];
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((cb: () => void, ms: number) => {
        delays.push(ms);
        queueMicrotask(cb);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
    const client = fakeClient({
      analyze: async () => {
        throw new SessionLostError();
      },
      reservePerceive: async () => ({ sessionId: "sess-r", appUrl: "", controlUrl: "" }),
    });
    await expect(
      analyzeJob(client.client, frames(1), async (ts) => ({ clipId: "c", clipUri: "u" }), {
        jobId: "j",
        clipBeforeS: 4,
        clipAfterS: 4,
        gameHint: "",
        maxReReserves: 3,
        sessionRetryBackoffMs: 500,
        sessionRetryBackoffMaxMs: 8000,
      })
    ).rejects.toBeInstanceOf(SessionLostError);
    spy.mockRestore();
    // One backoff sleep per re-reserve, doubling then capped: 500 -> 1000 -> 2000
    // (maxReReserves=3, base 500ms, cap 8000ms). No request storm.
    expect(delays).toEqual([500, 1000, 2000]);
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

  it("delivers the what-to-track plan to perceive once warmed up (ADAAAA-6467)", async () => {
    // Warm-up plan returns a valid roster; the controller delivers it on the
    // per-frame /analyze opts so detect/seeding stays scoped to the plan.
    const optsSeen: { trackingPlan?: Record<string, unknown> }[] = [];
    const { client } = fakeClient({
      plan: async () => ({
        planVersion: 1,
        category: "soccer",
        intent: "",
        source: "planner",
        maxTracks: 3,
        targets: [{ label: "player", role: "player" }, { label: "soccer ball", role: "ball" }],
      }),
      analyze: async (sid: string, _frame: any, opts: any) => {
        optsSeen.push(opts || {});
        return { observation: { tracks: [], seq: optsSeen.length - 1, timestamp: optsSeen.length - 1 } };
      },
      stopPerceive: async () => {},
    });
    await analyzeJob(client, frames(2), async (ts) => ({ clipId: `c${ts}`, clipUri: "/c.mp4" }), {
      jobId: "j",
      clipBeforeS: 4,
      clipAfterS: 4,
      gameHint: "soccer",
    });
    // The warm-up planner ran once and the active plan (roster) rode the
    // per-frame /analyze opts.
    expect(optsSeen.length).toBeGreaterThanOrEqual(1);
    const plan = optsSeen[optsSeen.length - 1].trackingPlan as any;
    expect(plan).toBeDefined();
    expect(plan.maxTracks).toBe(3);
    expect(plan.targets.map((t: any) => t.label)).toEqual(["player", "soccer ball"]);
  });
});

describe("decideOnCandidate (INC-2 / ADAAAA-4325 slice 4: audio candidate -> decide on anchored frame)", () => {
  it("decides an audio candidate on the ANCHORED video frame and records a highlight when Gemma accepts", async () => {
    const decideImages: (string | undefined)[] = [];
    const { client } = fakeClient({
      decide: async (_ev, opts) => {
        decideImages.push(opts?.imageB64);
        return { isHighlight: true, score: 75, eventType: "GOAL" };
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
    expect(decideImages).toEqual(["img3"]); // anchored to the audio onset frame
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
        return { isHighlight: true, score: 70, eventType: "GOAL" };
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

  // ADAAAA-6598: a near_miss / big_play frame read must NOT be accepted as a
  // scoring GOAL highlight on the board, even when the decide verdict sets
  // isHighlight=true (defense-in-depth gate at the server layer).
  it.each([
    ["near_miss", "shot saved; ball does not enter the net"],
    ["big_play", "ball is being saved; does not enter the net"],
  ])("does NOT cut/record a %s verdict as a scoring highlight", async (outcome, reason) => {
    const { client } = fakeClient({
      decide: async () => ({ isHighlight: true, score: 45, eventType: "GOAL", outcome: outcome as "near_miss" | "big_play", reason }),
    });
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
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer" },
      { eventType: "AUDIO", timestamp: 0, seq: 1 },
      (ev) => events.push(ev)
    );
    expect(cuts).toEqual([]);
    expect(shared.highlights).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual(["candidate"]); // no highlight emitted
  });

  it("records a scoring_play verdict as a board highlight (true-goal recall not regressed)", async () => {
    const { client } = fakeClient({
      decide: async () => ({ isHighlight: true, score: 80, eventType: "GOAL", outcome: "scoring_play", reason: "ball crossed the line into the net" }),
    });
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
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer" },
      { eventType: "AUDIO", timestamp: 0, seq: 1 },
      (ev) => events.push(ev)
    );
    expect(cuts).toEqual([0]);
    expect(shared.highlights).toHaveLength(1);
    expect(shared.highlights[0]).toMatchObject({ eventType: "GOAL", outcome: "scoring_play", status: "pending" });
  });

  // ADAAAA-6855: a near_miss / big_play frame read IS cut & recorded when the
  // job explicitly requested that non-goal class in preferLabels (exported as a
  // DISTINCT highlight, never a goal).
  it.each([
    ["near_miss", "shot saved; ball does not enter the net", ["near-misses"]],
    ["big_play", "ball is being saved; does not enter the net", ["saves"]],
  ])("cuts/records a requested %s verdict as a distinct highlight", async (outcome, reason, preferLabels) => {
    const { client } = fakeClient({
      decide: async () => ({ isHighlight: true, score: 45, eventType: "GOAL", outcome: outcome as "near_miss" | "big_play", reason }),
    });
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
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", preferLabels },
      { eventType: "AUDIO", timestamp: 0, seq: 1 },
      (ev) => events.push(ev)
    );
    expect(cuts).toEqual([0]);
    expect(shared.highlights).toHaveLength(1);
    // Preserved as a distinct non-goal highlight — never relabeled as a goal.
    expect(shared.highlights[0].outcome).toBe(outcome);
    expect(events.map((e) => e.type)).toEqual(["candidate", "highlight"]);
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
      decide: async () => ({ isHighlight: true, score: 70, eventType: "GOAL" }),
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
      { eventType: "AUDIO", timestamp: 60, seq: 1 }
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
        return call === 1 ? { isHighlight: true, score: 80 } : { isHighlight: false, score: 10 };
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
        return { isHighlight: true, score: 80, eventType: "GOAL" };
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

  it("live baseline (no decideWindowN): forwards the assembled capped frame sequence (increment F)", async () => {
    // Increment F / ADAAAA-6465: frames are now the PRIMARY evidence on EVERY
    // trigger (live + VOD). The live baseline no longer sends a bare anchored
    // image — it assembles a capped frame sequence sampled at analysis_fps.
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
      frames(2),
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer" }
    );
    expect(seen.frames).toBeDefined(); // assembled sequence forwarded
    expect(seen.frames!.length).toBeGreaterThanOrEqual(1);
    expect(seen.frames![0]).toMatchObject({ role: "full" });
    expect(seen.audioB64).toBeUndefined();
    expect(seen.imageB64).toBeDefined(); // anchored frame still present
  });

  it("live audio-context knob (audioContext): forwards the audio clip alongside the capped frame sequence", async () => {
    // ADAAAA-6314 Path 2: enabling LIVE_AUDIO_CONTEXT forwards the surrounding
    // audio clip for LIVE trigger candidates so the decide prompt gets ASR'd
    // audio context — while increment F still forwards the assembled capped
    // frame sequence (frames are the primary evidence).
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
    const shared = new LiveRunShared();
    shared.addAudioChunk(0, Buffer.from([0, 0, 1, 0]).toString("base64"));
    await analyzeJob(
      client,
      frames(2),
      async (ts) => ({ clipId: `c${ts}`, clipUri: `/clips/c${ts}.mp4` }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", audioContext: true },
      undefined,
      undefined,
      shared
    );
    expect(seen.frames).toBeDefined(); // capped frame sequence still forwarded
    expect(seen.audioB64).toBeTruthy(); // audio clip forwarded for ASR context
    expect(seen.imageB64).toBeDefined(); // anchored frame still present
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

  it("A2: live baseline carries priorContextText plus the capped frame sequence (increment F)", async () => {
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
    // ...and the increment-F frame watcher always forwards the assembled capped
    // sequence (frames are the PRIMARY evidence) on every trigger.
    expect(seen.frames).toBeDefined();
    expect(seen.audioB64).toBeUndefined();
    expect(seen.imageB64).toBeDefined();
  });
});


describe("I4 / ADAAAA-6361: rich detection + audio level evidence", () => {
  it("rmsNormalized returns a normalized 0..1 RMS energy for a mono PCM buffer", () => {
    // A max-amplitude 16-bit sample -> ~1.0; silence -> 0.
    expect(rmsNormalized(Buffer.from([0x00, 0x00]))).toBe(0);
    expect(rmsNormalized(Buffer.from([0xff, 0x7f]))).toBeCloseTo(1.0, 2);
    expect(rmsNormalized(Buffer.from([]))).toBe(0);
  });

  it("audioLevelSeries returns the RMS curve from the buffered audio taps", () => {
    const shared = new LiveRunShared();
    shared.addAudioChunk(0, Buffer.from([0, 0]).toString("base64")); // silence
    shared.addAudioChunk(1, Buffer.from([0xff, 0x7f]).toString("base64")); // loud
    const levels = shared.audioLevelSeries();
    expect(levels).toHaveLength(2);
    expect(levels[0]).toBeCloseTo(0, 3);
    expect(levels[1]).toBeGreaterThan(0.9);
  });

  it("richDetections + ballPosition read per-detection geometry from cached findings", () => {
    const shared = new LiveRunShared();
    shared.addFrame(0, 0, "img0");
    shared.setFindings(0, {
      tracks: [
        { trackId: "t1", slot: 0, bbox: [0.3, 0.4, 0.46, 0.9], kind: "player", label: "player", lostFrames: 0 },
        { trackId: "b0", slot: 1, bbox: [0.48, 0.52, 0.52, 0.58], kind: "player", label: "soccer ball", lostFrames: 0 },
      ],
      objects: [{ label: "goalkeeper", confidence: 0.7, bbox: [0.1, 0.2, 0.2, 0.6] }],
      ocr: [],
    });
    const dets = shared.richDetections(0);
    expect(dets.length).toBe(3);
    expect(dets[0]).toMatchObject({ label: "player", bbox: [0.3, 0.4, 0.46, 0.9], trackId: "t1" });
    expect(dets[2]).toMatchObject({ label: "goalkeeper", confidence: 0.7 });
    const ball = shared.ballPosition(0);
    expect(ball).toEqual([0.5, 0.55]);
  });
});

describe("I7 / ADAAAA-6361: higher-FPS burst re-sample around a trigger", () => {
  it("detail-first decideOnCandidate re-samples the burst and forwards it as frames[]", async () => {
    let resampledTs: number | undefined;
    let seenOpts: any;
    const { client } = fakeClient({
      decide: async (_ev, opts: any) => {
        seenOpts = opts;
        return { isHighlight: true, score: 80, eventType: "GOAL" };
      },
    });
    const shared = new LiveRunShared({ decideWindowN: 4 });
    shared.addFrame(0, 0, "img0");
    await decideOnCandidate(
      client,
      shared,
      async () => ({ clipId: "c", clipUri: "u" }),
      {
        jobId: "j",
        clipBeforeS: 4,
        clipAfterS: 4,
        gameHint: "soccer",
        decideWindowN: 4,
        resampleFrames: async (ts) => {
          resampledTs = ts;
          return [
            { timestamp: ts - 0.25, imageB64: "b0" },
            { timestamp: ts, imageB64: "b1" },
            { timestamp: ts + 0.25, imageB64: "b2" },
          ];
        },
      },
      { eventType: "GOAL", timestamp: 10, seq: 1 }
    );
    expect(resampledTs).toBe(10);
    // The higher-FPS burst (not the low-fps rolling window) is the decide frames[],
    // so the goal-line-crossing instant is represented in the window.
    expect(seenOpts.frames).toEqual([
      { role: "full", base64: "b0" },
      { role: "full", base64: "b1" },
      { role: "full", base64: "b2" },
    ]);
  });

  it("detail-first decideOnCandidate forwards rich detection + audio level evidence (I4)", async () => {
    let seenEv: any;
    const { client } = fakeClient({
      decide: async (ev: any) => {
        seenEv = ev;
        return { isHighlight: true, score: 80, eventType: "GOAL" };
      },
    });
    const shared = new LiveRunShared({ decideWindowN: 4 });
    shared.addFrame(0, 0, "img0");
    shared.setFindings(0, {
      tracks: [{ trackId: "b0", slot: 0, bbox: [0.48, 0.52, 0.52, 0.58], kind: "player", label: "soccer ball", lostFrames: 0 }],
      objects: [],
      ocr: [],
    });
    shared.addAudioChunk(0, Buffer.from([0xff, 0x7f]).toString("base64"));
    await decideOnCandidate(
      client,
      shared,
      async () => ({ clipId: "c", clipUri: "u" }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", decideWindowN: 4 },
      { eventType: "GOAL", timestamp: 0, seq: 1 }
    );
    expect(seenEv.detections).toBeDefined();
    expect(seenEv.detections![0].label).toBe("soccer ball");
    expect(seenEv.ballPosition).toEqual([0.5, 0.55]);
    expect(seenEv.audioLevels).toBeDefined();
  });

  it("live baseline forwarding no rich evidence stays regressed-free", async () => {
    let seenEv: any;
    const { client } = fakeClient({
      decide: async (ev: any) => {
        seenEv = ev;
        return { isHighlight: true, score: 80, eventType: "GOAL" };
      },
    });
    const shared = new LiveRunShared();
    shared.addFrame(0, 0, "img0");
    await decideOnCandidate(
      client,
      shared,
      async () => ({ clipId: "c", clipUri: "u" }),
      { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer" },
      { eventType: "GOAL", timestamp: 0, seq: 1 }
    );
    expect(seenEv.detections).toBeUndefined();
    expect(seenEv.audioLevels).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Increment F / ADAAAA-6465: frame-sequence assembler (plan §4.9A/§4.9D)
// ---------------------------------------------------------------------------
describe("frame-sequence assembler (increment F, ADAAAA-6465)", () => {
  // Build `n` frames at `dt` seconds apart starting at `start`.
  const mk = (start: number, dt: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      timestamp: +(start + i * dt).toFixed(3),
      imageB64: `img-${i}`,
    }));

  it("filters to the pre/post window around the trigger", () => {
    // trigger at 10s, pre 2 / post 3 -> window [8, 13].
    const res = assembleFrameSequence(mk(0, 1, 20), {
      triggerTs: 10,
      analysisFps: 5,
      preWindowS: 2,
      postWindowS: 3,
    });
    // Every returned frame sits inside [8,13].
    for (const f of res) {
      const t = Number(f.base64.replace("img-", ""));
      expect(t).toBeGreaterThanOrEqual(8);
      expect(t).toBeLessThanOrEqual(13);
    }
    expect(res.length).toBeGreaterThan(0);
  });

  it("returns the ImageRef shape gemma ask(frames=...) consumes, oldest->newest", () => {
    const res = assembleFrameSequence(mk(0, 1, 12), { triggerTs: 5, analysisFps: 5, preWindowS: 1, postWindowS: 2 });
    expect(res.length).toBeGreaterThan(0);
    for (const f of res) expect(f).toMatchObject({ role: "full" });
    const idxs = res.map((f) => Number(f.base64.replace("img-", "")));
    expect([...idxs]).toEqual([...idxs].sort((a, b) => a - b)); // ascending (oldest -> newest)
  });

  it("HARD-CAP: a dense window never exceeds maxFramesPerAnalysis", () => {
    // 100 dense frames (0.1s apart) across the window; cap = 12.
    const res = assembleFrameSequence(mk(5, 0.1, 100), {
      triggerTs: 10,
      analysisFps: 5,
      maxFramesPerAnalysis: 12,
      preWindowS: 2,
      postWindowS: 3,
    });
    expect(res.length).toBeLessThanOrEqual(12);
  });

  it("never exceeds the cap even when keyframes alone approach it", () => {
    const res = assembleFrameSequence(mk(5, 0.1, 100), {
      triggerTs: 10,
      analysisFps: 5,
      maxFramesPerAnalysis: 2, // keyframe set is 3 -> must still clamp to 2
      preWindowS: 2,
      postWindowS: 3,
    });
    expect(res.length).toBeLessThanOrEqual(2);
  });

  it("always includes the keyframe set (trigger-onset, peak-audio, window-end)", () => {
    // frames indexed 0..19, timestamps 8.0..17.5 (0.5s apart).
    const frames = mk(8, 0.5, 20);
    const res = assembleFrameSequence(frames, {
      triggerTs: 10,
      analysisFps: 5,
      maxFramesPerAnalysis: 10,
      preWindowS: 2,
      postWindowS: 3,
      peakAudioTs: 11.2,
    });
    const present = new Set(res.map((f) => f.base64));
    // In-window frames are indices 0 (ts 8.0) .. 10 (ts 13.0).
    // trigger-onset -> nearest real frame to ts 10.0 is index 4.
    expect(present.has("img-4")).toBe(true);
    // peak-audio (11.2) -> nearest real frame is index 6 (ts 11.0).
    expect(present.has("img-6")).toBe(true);
    // window-end -> last in-window frame, index 10 (ts 13.0).
    expect(present.has("img-10")).toBe(true);
  });

  it("empty window yields an empty sequence", () => {
    const res = assembleFrameSequence(mk(0, 1, 5), {
      triggerTs: 100,
      analysisFps: 5,
      preWindowS: 2,
      postWindowS: 3,
    });
    expect(res).toEqual([]);
  });
});

describe("bounded exponential backoff helpers (ADAAAA-6577)", () => {
  it("backoffDelayMs doubles per attempt from the base and caps at max", () => {
    // Defaults: base 500ms, cap 8000ms -> 500, 1s, 2s, 4s, then capped at 8s.
    expect(backoffDelayMs(0, 500, 8000)).toBe(500);
    expect(backoffDelayMs(1, 500, 8000)).toBe(1000);
    expect(backoffDelayMs(2, 500, 8000)).toBe(2000);
    expect(backoffDelayMs(3, 500, 8000)).toBe(4000);
    expect(backoffDelayMs(4, 500, 8000)).toBe(8000);
    // Cap holds so a long-lived flap never exceeds the max cadence.
    expect(backoffDelayMs(5, 500, 8000)).toBe(8000);
    expect(backoffDelayMs(100, 500, 8000)).toBe(8000);
  });

  it("backoffDelayMs clamps a negative attempt to the base (no negative delay)", () => {
    expect(backoffDelayMs(-1, 500, 8000)).toBe(500);
  });

  it("sleep resolves after roughly the requested delay", async () => {
    const t0 = Date.now();
    await sleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });
});
