// ADAAAA-7699: media (RTC / screen-share) rail decide wiring.
//
// The deployed symptom was 34 `source: browser` jobs producing 0 highlights, 0
// candidates and 0 decide calls: `/jobs/:id/observe` only stepped evidence and
// `/jobs/:id/audio` surfaced a fired trigger as SSE evidence, so a live share
// never reached decide. These tests pin the three load-bearing behaviours:
//
// - one decide per cadence tick, on the RELAYED anchor frame (no blind decide,
//   no second session to fetch pixels);
// - one anchored decide window per fired audio trigger (coalesced, bounded by
//   the same decide budget — no storm);
// - decide_audit parity with the live rtmp path on the route.
import { describe, it, expect, beforeEach } from "vitest";
import { MediaRailObserver, attestationFromObservation, seedFromObservation } from "../src/media-rail";
import { buildTestApp } from "./helpers";

/** Wall-clock epoch seconds, as the media node's frame/audio clock reports.
 *  Real (not a fixed past epoch): the rail drops frames whose content time is
 *  behind the wall clock by more than the lag budget (ADAAAA-7676). */
let T0 = 0;
beforeEach(() => {
  T0 = Date.now() / 1000;
});

function jpeg(n: number): string {
  return Buffer.from(`jpeg-frame-${n}`).toString("base64");
}

/** 100 ms mono int16 PCM at 16 kHz, as the media-edge audio relay POSTs. */
function pcmB64(): string {
  return Buffer.alloc(1600 * 2).toString("base64");
}

function trigger(onsetTs: number, firedAt: number, thresholdId = "stageA/burst/1.3x/0.3s") {
  return {
    kind: "burst" as const,
    ts: onsetTs,
    firedAt,
    onsetLatencyS: firedAt - onsetTs,
    peakEnergy: 0.4,
    baselineEnergy: 0.03,
    thresholdId,
  };
}

/** Wait for an async condition (the rail's decide chain is deliberately async). */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition not met within timeout");
}

describe("media rail seed/attestation helpers (ADAAAA-7699)", () => {
  it("folds perceive findings into the decide seed, with no fabricated signal", () => {
    const seed = seedFromObservation(3, {
      tracks: [{ trackId: "t1", label: "player", bbox: [0.1, 0.2, 0.3, 0.4] }],
      objects: [{ label: "ball", confidence: 0.9, bbox: [0.5, 0.5, 0.6, 0.6] }],
      ocr: ["2-1"],
    });
    expect(seed.ts).toBe(3);
    expect(seed.tracks).toHaveLength(1);
    expect(seed.objects).toHaveLength(1);
    expect(seed.ocr).toEqual(["2-1"]);
    // absent evidence stays absent (recall-safe, never a fabricated goal signal)
    expect(seed.signal).toBeUndefined();
  });

  it("attests only when the observation carries independent goal evidence", () => {
    expect(attestationFromObservation({})).toBeNull();
    expect(attestationFromObservation({ evidence: { goalInfra: true } })).toBeNull();
    expect(attestationFromObservation({ scoreBoardChanged: true })).toMatchObject({ scoreBoardChanged: true });
    expect(attestationFromObservation({ evidence: { goalCrossed: true } })).toMatchObject({ goalCrossed: true });
    expect(attestationFromObservation({ ballOutcome: "goal" })).toMatchObject({ ballOutcome: "goal" });
    // a non-goal outcome is not an attestation
    expect(attestationFromObservation({ ballOutcome: "off_target" })).toBeNull();
  });
});

describe("MediaRailObserver decide cadence (ADAAAA-7699)", () => {
  it("decides on the cadence with the relayed anchor frames, rebased to the share clock", async () => {
    const calls: any[] = [];
    const rail = new MediaRailObserver({ jobId: "j-cadence", onDecide: async (p) => (calls.push(p), false) });
    for (let i = 0; i < 10; i++) rail.onObservation({ seq: i, timestamp: T0 + i, tracks: [] }, jpeg(i));
    await rail.finish();

    // ~10 s of content at a 3 s cadence: the first tick + one per cadence,
    // plus the single end-of-stream tail — never a per-frame decide storm.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeLessThanOrEqual(5);
    // AC-1/AC-3: the decide payload carries the pixels the media node relayed
    expect(calls[0].frames.length).toBeGreaterThan(0);
    expect(calls[0].frames[0].imageB64).toBe(jpeg(0));
    // the content clock is rebased to the first sampled moment, so highlight
    // clip windows are cut against the recording (not epoch seconds)
    expect(calls[0].centerTs).toBe(0);
    expect(rail.stats().frames).toBe(10);
    expect(rail.stats().decideCalls).toBe(calls.length);
  });

describe("media rail decide-window density follows the resolved live cadence (ADAAAA-7990)", () => {
  // The media node now samples the browser/RTMP share at the control plane's
  // resolved live rate (3 fps). Denser sampling must mean MORE frames inside the
  // UNCHANGED ~10 s rolling window and the UNCHANGED <=30-frame cap — never a
  // longer window and never an unbounded payload.
  it("carries up to 30 frames at 3 fps inside the same ~10 s window", async () => {
    const calls: any[] = [];
    const rail = new MediaRailObserver({
      jobId: "j-7990-3fps",
      fps: 3,
      cadenceS: 3600, // only the finish-tail decide, so the window is the whole share
      onDecide: async (p) => (calls.push(p), false),
    });
    const base = T0 - 10; // 10 s of content ending now
    for (let i = 0; i < 30; i++) rail.onObservation({ seq: i, timestamp: base + i / 3, tracks: [] }, jpeg(i));
    await rail.finish();

    // The cadence-first tick decides the first frame; the finish tail decides the
    // whole share (that tail is the window this ticket is about).
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const win = calls[calls.length - 1].frames;
    expect(win.length).toBe(30);
    expect(win.length).toBeLessThanOrEqual(30); // LIVE_OBSERVE_MAX_FRAMES unchanged
    const span = win[win.length - 1].ts - win[0].ts;
    expect(span).toBeLessThanOrEqual(10); // window span unchanged (~10 s)
  });

  it("thins the same stream to the 2 fps content default when no rate is passed", async () => {
    const calls: any[] = [];
    const rail = new MediaRailObserver({
      jobId: "j-7990-2fps-default",
      cadenceS: 3600,
      onDecide: async (p) => (calls.push(p), false),
    });
    const base = T0 - 10;
    for (let i = 0; i < 30; i++) rail.onObservation({ seq: i, timestamp: base + i / 3, tracks: [] }, jpeg(i));
    await rail.finish();

    // 20 distinct frames on the 2 fps grid (the pre-7990 behaviour), versus 30
    // once the rail is handed the resolved 3 fps rate.
    const win = calls[calls.length - 1].frames;
    // 21 frames on a 2 fps grid across 9.67 s of content (versus the 30-frame cap
    // the resolved 3 fps rate fills).
    expect(win.length).toBeLessThanOrEqual(21);
    expect(win.length).toBeLessThan(30);
    expect(win[win.length - 1].ts - win[0].ts).toBeLessThanOrEqual(10);
  });
});


  it("never decides without pixels (the anchor frame is required)", async () => {
    const calls: any[] = [];
    const rail = new MediaRailObserver({ jobId: "j-noframe", onDecide: async (p) => (calls.push(p), false) });
    for (let i = 0; i < 8; i++) rail.onObservation({ seq: i, timestamp: T0 + i, tracks: [] }, undefined);
    await rail.finish();
    expect(calls).toHaveLength(0);
    expect(rail.stats().frames).toBe(0);
  });

  it("hands every accepted frame to the persist hook with a dense seq and content clock", async () => {
    const frames: any[] = [];
    const rail = new MediaRailObserver({
      jobId: "j-persist",
      onDecide: async () => false,
      onFrame: (f) => frames.push({ seq: f.seq, timestamp: f.timestamp, bytes: f.frameB64 }),
    });
    // The media node's own seq is NOT trusted: it can skip (a dropped POST, a
    // media-node restart mid-share). The rail allocates 0,1,2.. so the frame
    // file name never disagrees with the decide window's evidence refs.
    rail.onObservation({ seq: 4, timestamp: T0, tracks: [] }, jpeg(4));
    rail.onObservation({ seq: 9, timestamp: T0 + 1, tracks: [] }, jpeg(9));
    // An observation without pixels is evidence-only (nothing persisted), and a
    // frame with an implausible clock is rejected before it reaches the hook.
    rail.onObservation({ seq: 10, timestamp: T0 + 2, tracks: [] }, undefined);
    rail.onObservation({ seq: 11, timestamp: 0, tracks: [] }, jpeg(11));
    await waitFor(() => rail.stats().frames === 2);

    expect(frames.map((f) => f.seq)).toEqual([0, 1]);
    expect(frames.map((f) => f.timestamp)).toEqual([0, 1]);
    expect(frames[1].bytes).toBe(jpeg(9));
    expect(rail.frameCount()).toBe(2);
  });

  it("rejects a relayed frame whose timestamp is not an epoch-second clock", async () => {
    // The deployed defect: a media node that relayed `timestamp: 0` pinned the
    // rail's content origin at 1970, the lag gate read every frame as decades
    // stale, and only the finish-tail decide ever ran (0 decides per share).
    const calls: any[] = [];
    const rail = new MediaRailObserver({ jobId: "j-clock", onDecide: async (p) => (calls.push(p), false) });
    for (let i = 0; i < 6; i++) rail.onObservation({ seq: i, timestamp: 0, tracks: [] }, jpeg(i));
    await rail.finish();
    expect(calls).toHaveLength(0);
    expect(rail.stats().frames).toBe(0);
    expect(rail.stats().clockRejected).toBe(6);
    // A mis-stamped stream never becomes the content origin either.
    expect(rail.contentOrigin()).toBeNull();
    // ...and an honest clock on a fresh rail still decides normally.
    const honest: any[] = [];
    const rail2 = new MediaRailObserver({ jobId: "j-clock-ok", onDecide: async (p) => (honest.push(p), false) });
    for (let i = 0; i < 4; i++) rail2.onObservation({ seq: 100 + i, timestamp: T0 + i, tracks: [] }, jpeg(100 + i));
    await waitFor(() => rail2.stats().decideCalls > 0);
    expect(rail2.stats().frames).toBe(4);
    expect(rail2.stats().clockRejected).toBe(0);
  });

  it("never swallows a due trigger when the decide budget cannot afford the fire", async () => {
    const calls: any[] = [];
    const rail = new MediaRailObserver({ jobId: "j-budget", onDecide: async (p) => (calls.push(p), false) });
    // Frame 0 fires the cadence; a trigger that falls due one second later
    // cannot afford an anchored fire yet (budget 1/3 of a token) — it must stay
    // pending and anchor the next affordable tick, not be dropped.
    rail.onObservation({ seq: 0, timestamp: T0 }, jpeg(0));
    rail.onAudioCandidate({ audio: trigger(T0 + 0.4, T0 + 1.3) });
    for (let i = 1; i <= 5; i++) rail.onObservation({ seq: i, timestamp: T0 + i, tracks: [] }, jpeg(i));
    await rail.finish();
    expect(rail.stats().triggerFires).toBe(1);
    expect(rail.stats().triggers).toBe(1);
  });

  it("anchors ONE decide window per fired audio trigger and coalesces re-fires", async () => {
    const calls: any[] = [];
    const rail = new MediaRailObserver({
      jobId: "j-trigger",
      onDecide: async (p) => (calls.push(p), false),
      // Keep the gate's own coalescing semantics (2.5 s, per family).
    });
    // frames 0..6 (1 fps); a burst fires at ~4.5 s and re-fires 2 chunks later.
    rail.onObservation({ seq: 0, timestamp: T0 }, jpeg(0));
    for (let i = 1; i <= 4; i++) rail.onObservation({ seq: i, timestamp: T0 + i, tracks: [] }, jpeg(i));
    for (let i = 0; i < 10; i++) rail.onAudioChunk(T0 + 4 + i * 0.1, pcmB64());
    expect(rail.onAudioCandidate({ audio: trigger(T0 + 4.5, T0 + 5.1) })).not.toBeNull();
    expect(rail.onAudioCandidate({ audio: trigger(T0 + 4.7, T0 + 5.3) })).not.toBeNull();
    for (let i = 5; i <= 6; i++) rail.onObservation({ seq: i, timestamp: T0 + i, tracks: [] }, jpeg(i));
    await rail.finish();

    const stats = rail.stats();
    // Both re-fires were queued at the tap, but the scheduler coalesced them
    // into ONE anchored window (one analysis per audible event).
    expect(stats.triggers).toBe(1);
    expect(stats.triggerFires).toBe(1);
    // The anchored window carries the audio trigger as a provenance hint.
    const anchored = calls.filter((c) => c.trigger);
    expect(anchored.length).toBeGreaterThanOrEqual(1);
    expect(anchored[0].trigger.kind).toBe("burst");
    // The audio chunk timeline reached the retained window audio (ASR context).
    expect(stats.audioChunks).toBe(10);
  });
});

describe("MediaRailObserver pipelined decide depth (ADAAAA-7987)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("keeps >= 2 decide windows in flight and still accepts in CONTENT order", async () => {
    // The deployed defect: the rail handed its LiveObserver only `onDecide`, so a
    // browser/RTMP share decided strictly one window at a time
    // (`observeMetrics.maxDecideInFlight = 0`) while 4 decide slots sat idle —
    // a ~4 s decide against the ~3.9 s cadence can never hold the cadence, which
    // is the constant 15-17 s delivery lag the CEO saw.
    let active = 0;
    let maxActive = 0;
    const decided: number[] = [];
    const accepted: number[] = [];
    const rail = new MediaRailObserver({
      jobId: "j-7987-depth",
      cadenceS: 0.5,
      windowS: 2,
      fps: 2,
      maxInFlight: 4,
      decideAdmission: 8,
      onDecideStaged: (payload) => {
        decided.push(payload.centerTs);
        return {
          decide: async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            // The FIRST window is the SLOWEST, so completion order is reversed
            // against content order — acceptance must not follow it.
            await sleep(payload.centerTs === 0 ? 300 : 120);
            active--;
          },
          accept: async () => {
            accepted.push(payload.centerTs);
            return true;
          },
        };
      },
    });
    // 6.5 s of content at a 0.5 s cadence (~13 windows), relayed on a ~30 ms
    // wall clock (like the media node's observe POSTs) so the decides overlap
    // instead of all arriving in one synchronous burst.
    for (let i = 0; i <= 12; i++) {
      rail.onObservation({ seq: i, timestamp: T0 + i * 0.5, tracks: [] }, jpeg(i));
      await sleep(30);
    }
    await waitFor(() => decided.length >= 8);
    await rail.finish();

    const m = rail.observeMetrics();
    expect(rail.isPipelined()).toBe(true);
    // AC-1: several windows really were outstanding at once...
    expect(m.maxDecideInFlight).toBeGreaterThanOrEqual(2);
    expect(m.maxDecideInFlight).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThanOrEqual(2);
    // ...AC-5: acceptance still applies in content order, and one decide is one
    // window (the billing invariant — the only repeat is the end-of-stream tail,
    // which re-observes the newest window, the pre-existing flush behaviour).
    expect(accepted).toEqual([...accepted].sort((a, b) => a - b));
    expect(accepted[0]).toBe(0); // the slow first window is applied FIRST
    const distinct = new Set(decided);
    expect(distinct.size).toBeGreaterThanOrEqual(decided.length - 1);
    expect(m.decideCalls).toBe(decided.length);
  });

  it("shares the in-flight depth across concurrent live streams (never above LIVE_OBSERVE_IN_FLIGHT)", async () => {
    // AC-4: one stream gets >= 2, never more than the configured depth; two
    // concurrent streams split the decide admission and neither is starved.
    const opts = (jobId: string, admission: number) => ({
      jobId,
      cadenceS: 3,
      maxInFlight: 4,
      decideAdmission: admission,
      onDecideStaged: () => ({ decide: async () => {}, accept: async () => false }),
    });
    const lone = new MediaRailObserver(opts("j-7987-lone", 8));
    expect(lone.currentDepthBudget()).toBe(4); // >= 2, <= LIVE_OBSERVE_IN_FLIGHT
    lone.release();
    const a = new MediaRailObserver(opts("j-7987-share-a", 8));
    const b = new MediaRailObserver(opts("j-7987-share-b", 8));
    expect(a.currentDepthBudget()).toBe(4); // 8 / 2 streams = 4 each
    expect(b.currentDepthBudget()).toBe(4);
    // A 2-wide decide gate cannot give two streams depth: each falls back to the
    // serial pass instead of queueing a decide that would land late.
    a.release();
    b.release();
    const narrowA = new MediaRailObserver(opts("j-7987-narrow-a", 2));
    const narrowB = new MediaRailObserver(opts("j-7987-narrow-b", 2));
    expect(narrowA.currentDepthBudget()).toBe(1);
    expect(narrowB.currentDepthBudget()).toBe(1);
    narrowA.release();
    narrowB.release();
  });

  it("ADAAAA-8437 AC5: a discovered-capacity getter widens the per-stream depth mid-run", () => {
    // The fleet advertises 6 on the routed 5090 set; raising DECIDE_WORKER_SEQS
    // makes it advertise 12. The depth must follow the advertisement, not the
    // static funded number.
    let effective = 6;
    const opts = (jobId: string) => ({
      jobId,
      cadenceS: 3,
      maxInFlight: 4,
      decideAdmission: () => effective,
      onDecideStaged: () => ({ decide: async () => {}, accept: async () => false }),
    });
    const a = new MediaRailObserver(opts("j-8437-admit-a"));
    expect(a.currentDepthBudget()).toBe(4); // lone stream: min(4, 6) = 4 (byte-identical)
    const b = new MediaRailObserver(opts("j-8437-admit-b"));
    expect(a.currentDepthBudget()).toBe(3); // 2 streams: floor(6 / 2) = 3 each
    expect(b.currentDepthBudget()).toBe(3);
    effective = 12; // the pool advertised more (worker-seqs re-create, cost-gated)
    expect(a.currentDepthBudget()).toBe(4); // floor(12 / 2) = 6, capped at 4
    expect(b.currentDepthBudget()).toBe(4);
    a.release();
    b.release();
  });

  it("keeps the serial path byte-identical when the off-loop flag is off", () => {
    const rail = new MediaRailObserver({
      jobId: "j-7987-serial",
      onDecide: async () => false,
      maxInFlight: 1,
      decideAdmission: 8,
      observeDecideOffLoop: false,
      onDecideStaged: () => ({ decide: async () => {}, accept: async () => false }),
    });
    // Depth 1 + flag off => the pre-7987 in-chain serial decide (no staged fork,
    // no registration in the shared depth budget).
    expect(rail.isPipelined()).toBe(false);
    expect(rail.currentDepthBudget()).toBe(1);
    rail.release();
  });
});

describe("POST /jobs/:id/observe + /jobs/:id/audio decide on the media rail (ADAAAA-7699)", () => {
  async function register(app: any, email: string): Promise<string> {
    const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "password123" } });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }

  it("runs decide on the relayed observation, persists the highlight and the decide-audit row", async () => {
    const decides: any[] = [];
    const base = (await import("./helpers")).fakePipeline();
    const adapter = {
      ...base,
      async decide(evidence: any, opts: any) {
        decides.push({ evidence, opts });
        return {
          isHighlight: true,
          score: 91,
          eventType: "GOAL",
          outcome: "scoring_play",
          reason: "media rail test",
          audit: {
            jobId: opts?.jobId,
            groupKey: opts?.groupKey,
            timestamp: 0,
            frameCount: opts?.frames?.length ?? 0,
            candidateCount: 1,
            promptText: "gemma prompt for the media rail window",
            mediaHashes: [],
            params: { cadenceS: 3 },
            rawReply: "{}",
            verdicts: { outcome: "scoring_play" },
            timings: { elapsedMs: 8 },
            createdAt: Date.now() / 1000,
            replayable: true,
          },
        };
      },
    };
    const { app, store } = await buildTestApp({ LIVE_OBSERVE_LOOP: "1" }, { adapter });
    const token = await register(app, "mediarail1@test.dev");
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser", gameHint: "soccer" },
    });
    expect([200, 202]).toContain(jr.statusCode);
    const jobId = jr.json().job.id as string;

    // The media node relays observations over the share; the control plane now
    // anchors a decide to the frame that travelled with each one.
    for (let i = 0; i < 4; i++) {
      const r = await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/observe`,
        payload: { seq: i, timestamp: Date.now() / 1000 + i, tracks: [], frameB64: jpeg(i) },
      });
      expect(r.statusCode).toBe(200);
    }
    await waitFor(() => decides.length >= 1);

    // decide actually received pixels (not a blind scalar decide)
    expect(decides[0].opts.frames.length).toBeGreaterThan(0);
    expect(decides[0].opts.frames[0].base64).toBe(jpeg(0));
    // streaming decide fee is waived, not billed (ADAAAA-5341)
    expect(decides[0].opts.jobId).toBe(jobId);

    // AC-2: audit parity — the durable row carries promptText/frameCount/timings
    const audit = await app.inject({ method: "GET", url: `/jobs/${jobId}/decide-audit`, headers: { authorization: `Bearer ${token}` } });
    expect(audit.statusCode).toBe(200);
    const rows = audit.json().audits as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].promptText).toBe("gemma prompt for the media rail window");
    expect(rows[0].frameCount).toBeGreaterThan(0);
    expect(rows[0].replayable).toBe(true);
    expect(rows[0].timings).toBeTruthy();

    // AC-4: the accepted highlight is persisted at decision time; its clip
    // window is on the share's content clock so the stop path can cut it.
    await waitFor(() => store.highlightsForJob(jobId).length >= 1);
    const h = store.highlightsForJob(jobId)[0];
    expect(h.start).toBeGreaterThanOrEqual(0);
    expect(h.start).toBeLessThan(600); // content seconds, never epoch seconds
    expect(h.end).toBeGreaterThan(h.start);
  });

  it("a fired audio trigger anchors the decide on the media rail (not SSE-only)", async () => {
    const decides: any[] = [];
    const base = (await import("./helpers")).fakePipeline();
    const adapter = {
      ...base,
      async postAudio(sessionId: string) {
        const wall = Date.now() / 1000;
        return {
          candidate: { type: "candidate", sessionId, eventType: "AUDIO", timestamp: 0, audio: trigger(wall + 0.5, wall + 1.4) },
          series: [],
        };
      },
      async decide(evidence: any, opts: any) {
        decides.push({ evidence, opts });
        return { isHighlight: false, score: 10, eventType: "SPORTING_EVENT", reason: "no goal" };
      },
    };
    const { app } = await buildTestApp({ LIVE_OBSERVE_LOOP: "1", LIVEOBSERVE: "1" }, { adapter });
    const token = await register(app, "mediarail2@test.dev");
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser" },
    });
    const jobId = jr.json().job.id as string;
    const now = Date.now() / 1000;

    // one frame, then the audio tap fires, then the next relayed observation
    // drains the trigger into an anchored decide window.
    await app.inject({ method: "POST", url: `/jobs/${jobId}/observe`, payload: { seq: 0, timestamp: now, tracks: [], frameB64: jpeg(0) } });
    const audio = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/audio`,
      payload: { seq: 0, timestamp: now + 0.6, samples: pcmB64(), sessionId: "media-sess" },
    });
    expect(audio.statusCode).toBe(200);
    expect(audio.json().candidate.audio.kind).toBe("burst");
    for (let i = 1; i <= 2; i++) {
      await app.inject({ method: "POST", url: `/jobs/${jobId}/observe`, payload: { seq: i, timestamp: now + i, tracks: [], frameB64: jpeg(i) } });
    }
    await waitFor(() => decides.length >= 1);
    // The anchored window carries the trigger as provenance (AUDIO_* hint).
    expect(decides.some((d) => /^AUDIO_/.test(d.evidence.eventType))).toBe(true);
  });
});

// ADAAAA-8069: the RTC arm's decide window takes its observation set from the
// rail's PUBLISHED-frame clock, not from the frames that survived to a decide.
// Measured on job 8024a341: 848 frames published, 93 observations delivered,
// 697 skipped by the runner's fast-forward — so `timelineRecords == imageCount`
// on 39/39 windows at 0.22-1.30 records/s.
describe("media rail published-frame clock (ADAAAA-8069)", () => {
  it("records ticks without deciding and without becoming decide frames", async () => {
    const calls: any[] = [];
    const rail = new MediaRailObserver({ jobId: "j-ticks", onDecide: async (p) => (calls.push(p), false) });
    // Ten published frames over the 10 s window, NO relayed observation/image.
    for (let i = 0; i < 10; i++) rail.onFrameTick(T0 + i / 3);
    await rail.finish();
    expect(calls).toHaveLength(0);
    expect(rail.stats().frameTicks).toBe(10);
    // A tick carries no pixels, so it can never become a decide frame.
    expect(rail.stats().frames).toBe(0);
  });

  it("a window fired on one delivered observation carries the published clock as its observation set", async () => {
    const calls: any[] = [];
    const rail = new MediaRailObserver({ jobId: "j-ticks2", onDecide: async (p) => (calls.push(p), false) });
    // 3 fps publish clock, then the ONE frame the runner actually observed.
    for (let i = 0; i < 10; i++) rail.onFrameTick(T0 + i / 3);
    rail.onObservation({ seq: 0, timestamp: T0 + 3, tracks: [] }, jpeg(0));
    await waitFor(() => calls.length >= 1);
    const p = calls[0];
    // The image set is the delivered frame; the observation set is the rail.
    expect(p.frames.length).toBe(1);
    expect(p.observations?.length).toBe(10);
    // The delivered frame is also a publish tick: it is counted ONCE.
    const ts = (p.observations ?? []).map((o: any) => Math.round(o.ts * 1000));
    expect(new Set(ts).size).toBe(ts.length);
  });

  it("an evidence-only observation (no pixels) still joins the observation set", async () => {
    const calls: any[] = [];
    const rail = new MediaRailObserver({ jobId: "j-evidence", onDecide: async (p) => (calls.push(p), false) });
    rail.onObservation({ seq: 0, timestamp: T0, tracks: [] }, jpeg(0));
    // A relayed observation whose anchor JPEG was over the size cap / missing.
    // It must join the observation set but never the image set or the cadence.
    rail.onObservation({ seq: 1, timestamp: T0 + 3, tracks: [{ trackId: "t1" }] }, undefined);
    // The next delivered frame closes the cadence window over both.
    rail.onObservation({ seq: 2, timestamp: T0 + 6, tracks: [] }, jpeg(2));
    await waitFor(() => calls.length >= 2);
    const p = calls[calls.length - 1];
    expect(p.frames.length).toBe(2); // only the two frames with pixels
    expect(p.observations?.length).toBe(3); // ...plus the evidence-only clock
    expect(p.observations?.filter((o: any) => (o.tracks?.length ?? 0) > 0).length).toBe(1);
    expect(rail.stats().frames).toBe(2);
  });

  it("honors the configured live frame budget on the media rail", async () => {
    const calls: any[] = [];
    // ADAAAA-8069: `LIVE_OBSERVE_MAX_FRAMES` is the documented live frame budget
    // ("trim 1") but only the analyzer's live pass read it, so the media rail ran
    // at the 30-frame default even in a 4-image cell.
    const rail = new MediaRailObserver({ jobId: "j-cap", maxFrames: 4, onDecide: async (p) => (calls.push(p), false) });
    // 3 fps publish clock over ~10 s AND every frame delivered (a runner that
    // keeps up): the image cap is the only thing that can separate the sets.
    for (let i = 0; i < 30; i++) rail.onFrameTick(T0 + i / 3);
    for (let i = 0; i < 30; i++) rail.onObservation({ seq: i, timestamp: T0 + i / 3, tracks: [] }, jpeg(i));
    await waitFor(() => calls.length >= 3);
    const p = calls[calls.length - 1];
    expect(p.frames.length).toBeLessThanOrEqual(4);
    // ...while the perceive timeline still carries the whole span.
    expect(p.observations?.length).toBeGreaterThan(p.frames.length);
  });
});

describe("POST /jobs/:id/media/frames feeds the window observation set (ADAAAA-8069)", () => {
  async function register(app: any, email: string): Promise<string> {
    const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "password123" } });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }

  it("a decide window carries the rail's publish clock, not only the shipped images", async () => {
    const decides: any[] = [];
    const base = (await import("./helpers")).fakePipeline();
    const adapter = {
      ...base,
      async decide(evidence: any, opts: any) {
        decides.push({ evidence, opts });
        return { isHighlight: false, score: 5, eventType: "SPORTING_EVENT", reason: "no goal" };
      },
    };
    const { app } = await buildTestApp({ LIVE_OBSERVE_LOOP: "1" }, { adapter });
    const token = await register(app, "mediaticks@test.dev");
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "browser" },
    });
    expect([200, 202]).toContain(jr.statusCode);
    const jobId = jr.json().job.id as string;
    const now = Date.now() / 1000;

    // 3 s of the media node's publish clock at 3 fps — the runner produced NO
    // observation for these (its fast-forward path), so they arrive as clocks.
    const frames = Array.from({ length: 9 }, (_, i) => ({ seq: i, timestamp: now + i / 3 }));
    const tick = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media/frames`,
      payload: { sessionId: "media-sess", frames },
    });
    expect(tick.statusCode).toBe(200);
    expect(tick.json().recorded).toBe(9);

    // ONE relayed observation with pixels closes the cadence window.
    const obs = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/observe`,
      payload: { seq: 9, timestamp: now + 3, tracks: [], frameB64: jpeg(0) },
    });
    expect(obs.statusCode).toBe(200);
    await waitFor(() => decides.length >= 1);

    const d = decides[0];
    // The image set is one delivered frame; the observe timeline is the rail.
    expect(d.opts.frames.length).toBe(1);
    expect(d.evidence.perceiveTimeline.length).toBeGreaterThan(d.opts.frames.length);
    expect(d.evidence.perceiveTimeline.length).toBe(10);
  });

  it("ignores malformed / non-browser callbacks instead of failing the node", async () => {
    const { app } = await buildTestApp({ LIVE_OBSERVE_LOOP: "1" }, {});
    const missing = await app.inject({ method: "POST", url: "/jobs/does-not-exist/media/frames", payload: { frames: [] } });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().ignored).toBeTruthy();
  });
});
