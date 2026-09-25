import { describe, it, expect, vi } from "vitest";
import {
  analyzeJob,
  EvidenceTracker,
  LiveRunShared,
  decideOnCandidate,
  SessionLostError,
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

  it("clamps crowdEnergy and trackCount into decide schema bounds (ADAAAA-4736)", async () => {
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
