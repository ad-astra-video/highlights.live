// ADAAAA-8544: the per-stream decide knob, server side.
//
// Contract (spec rev 2/3 on ADAAAA-8527, do not re-derive):
//   AC1 the resolved knob is stamped on the record at job start and readable in
//       the admin window audit — asserted on a STORED-RECORD FIXTURE (no live
//       job, no GPU).
//   AC2 the knob changes NOTHING else: the window span, the audio-noise trigger
//       options and the VOD window fields are byte-identical to the unset case,
//       and the diff touches only the throttle path, the record write and the
//       estimate.
//   AC4 the 63-decide coverage floor is a 422 at the route, 63 is accepted.
//
// The 422 itself is asserted on the pure validator (the route calls it before any
// quota or compute gate); the wiring guards below read the shipped source so a
// regression that drops the observer line or the route validation fails here
// instead of silently shipping an unpriced knob (the ADAAAA-8074 class).
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  DECIDE_RATE_FLOOR_PER_300S,
  estimateDecideUsdPerHour,
  resolveDecideKnob,
  validateDecideKnobInput,
  type DecideKnobStamp,
} from "@highlights/events";
import { windowAuditForJob } from "../src/window-audit";
import { buildLiveAnalyzerConfig } from "../src/api";
import { MediaRailObserver } from "../src/media-rail";
import { loadConfig } from "../src/config";
import { buildTestApp } from "./helpers";

const BASE_ENV = { PERCEIVE_URL: "http://p", DECIDE_URL: "http://d", LIVE_OBSERVE_LOOP: "1" };
const cfgFor = (overrides: Record<string, string> = {}) => loadConfig({ ...BASE_ENV, ...overrides });

/** A stored observe snapshot as the live pass writes it (fields the audit reads). */
function storedSnapshot(over: Record<string, unknown> = {}) {
  return {
    decideCalls: 312,
    accepted: 12,
    maxFrames: 4,
    meanE2eMs: 4200,
    maxE2eMs: 6100,
    meanCadenceMs: 3553.3,
    maxCadenceMs: 4120,
    skippedStaleWindows: 0,
    backpressureSkippedWindows: 0,
    admissionSkippedWindows: 0,
    throttleSkippedWindows: 0,
    capacityDroppedWindows: 0,
    supplySkippedWindows: 0,
    ...over,
  } as any;
}

function stamp(over: Partial<DecideKnobStamp> = {}): DecideKnobStamp {
  return { ...resolveDecideKnob({ rail: "browser" }), ...over };
}

describe("AC1 — the stamped knob is echoed by the window audit, never recomputed", () => {
  it("echoes the stored stamp field for field, including resolvedSource", () => {
    const knob = resolveDecideKnob({ cadenceSec: 3, rateCapPer300s: 63, rail: "analyzer" });
    const audit = windowAuditForJob({
      id: "job-8544-stored",
      status: "done",
      source: "rtmp",
      decideKnob: knob,
      observeMetrics: storedSnapshot({ decideKnob: knob, decideOpportunities: 320 }),
    });
    expect(audit.decideKnob).toEqual(knob);
    expect(audit.decideKnob?.resolvedSource).toBe("user");
    expect(audit.decideKnob?.rateCapPer300s).toBe(63);
    // The measured opportunities are the job's OWN number, and the 300 s density
    // is derived from the stored cadence (84.4 per 300 s at a 3.553 s mean) —
    // which is what a grader contrasts with the predicted 104.
    expect(audit.decideOpportunities).toBe(320);
    expect(audit.decideOpportunitiesPer300s).toBeCloseTo(300000 / 3553.3, 1);
    // A wrong recomputation would produce 104 here (the stamped analyzer
    // prediction is capped at 63 charged, but the OPPORTUNITY prediction is 104);
    // the echoed stamp must keep its own numbers.
    expect(audit.decideKnob?.opportunitiesPer300s).toBe(104);
  });

  it("falls back to the frozen record stamp when no snapshot was written (in-flight row)", () => {
    const knob = stamp({ rateCapPer300s: 66, resolvedSource: "user" });
    const audit = windowAuditForJob({ id: "job-8544-inflight", status: "active", source: "browser", decideKnob: knob });
    expect(audit.stored).toBe(false);
    expect(audit.decideKnob).toEqual(knob);
    // Counters stay null on an unmeasured row — never a fabricated 0.
    expect(audit.decideOpportunities).toBeNull();
    expect(audit.decideOpportunitiesPer300s).toBeNull();
  });

  it("a pre-knob row reports null (not recorded), never 'started uncapped'", () => {
    const audit = windowAuditForJob({
      id: "job-8544-legacy",
      status: "done",
      source: "rtmp",
      observeMetrics: storedSnapshot(),
    });
    expect(audit.decideKnob).toBeNull();
    expect(audit.decideOpportunities).toBeNull();
    expect(audit.decideKnob).not.toEqual({ rateCapPer300s: null });
  });

  it("the stored estimate is the shipped one for that posture (AC3 on the record)", () => {
    const knob = stamp();
    const audit = windowAuditForJob({
      id: "job-8544-econ",
      status: "done",
      source: "browser",
      decideKnob: knob,
      observeMetrics: storedSnapshot({ decideKnob: knob }),
    });
    const same = estimateDecideUsdPerHour({ cadenceSec: 5, rateCapPer300s: null, rail: "browser" });
    expect(audit.decideKnob?.predictedUsdPerHour).toBe(same.usdPerHour);
    expect(audit.decideKnob?.estimateVersion).toBe("est-v3");
    expect(audit.decideKnob?.resolvedSource).toBe("default");
  });
});

describe("AC2 — the knob resolves nothing else", () => {
  function analyzerFor(knob?: DecideKnobStamp) {
    return buildLiveAnalyzerConfig({
      cfg: cfgFor({}),
      job: { id: "job-8544", gameHint: "soccer" } as any,
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 } as any,
      ...(knob ? { decideKnob: knob } : {}),
    });
  }

  const presets: { name: string; knob: DecideKnobStamp }[] = [
    { name: "3 s uncapped", knob: resolveDecideKnob({ cadenceSec: 3, rail: "browser" }) },
    { name: "5 s uncapped (default)", knob: resolveDecideKnob({ rail: "browser" }) },
    { name: "3 s cap 63", knob: resolveDecideKnob({ cadenceSec: 3, rateCapPer300s: 63, rail: "browser" }) },
    { name: "5 s cap 66", knob: resolveDecideKnob({ cadenceSec: 5, rateCapPer300s: 66, rail: "analyzer" }) },
  ];

  it("window span, audio-noise trigger opts and VOD window fields are byte-identical to unset", () => {
    const unset = analyzerFor();
    for (const preset of presets) {
      const withKnob = analyzerFor(preset.knob);
      // Window span: AC2's first clause. `undefined` here means "the 10 s
      // constant" — the same value the unset case carries, byte for byte.
      expect(withKnob.liveObserveWindowS, preset.name).toBe(unset.liveObserveWindowS);
      expect(withKnob.liveObserveWindowS).toBeUndefined();
      // The audio-noise trigger contract.
      expect(withKnob.observeSignalGate, preset.name).toBe(unset.observeSignalGate);
      expect(JSON.stringify(withKnob.observeSignalGateOpts ?? null), preset.name).toBe(
        JSON.stringify(unset.observeSignalGateOpts ?? null)
      );
      // The VOD pass' own symmetric window + decide depth.
      expect(withKnob.observeWindowS, preset.name).toBe(unset.observeWindowS);
      expect(withKnob.decideWindowN, preset.name).toBe(unset.decideWindowN);
      expect(withKnob.observeCadenceS, preset.name).toBe(unset.observeCadenceS);
      // Image budget + content consume rate are outside the knob too.
      expect(withKnob.observeMaxFrames, preset.name).toBe(unset.observeMaxFrames);
      expect(withKnob.liveObserveContentFps, preset.name).toBe(unset.liveObserveContentFps);
      // The deploy-time fraction stays untouched: the knob is additive, not a
      // replacement of the field.
      expect(withKnob.liveDecideKeepRatio, preset.name).toBe(unset.liveDecideKeepRatio);
    }
  });

  it("changes exactly two fields: the cadence and the rate cap", () => {
    const unset = analyzerFor();
    const three = analyzerFor(presets[0].knob);
    const five = analyzerFor(presets[1].knob);
    const capped = analyzerFor(presets[2].knob);
    expect(three.liveObserveCadenceS).toBe(3);
    expect(five.liveObserveCadenceS).toBe(5);
    expect(three.liveDecideRateCapPer300s).toBeNull();
    expect(capped.liveDecideRateCapPer300s).toBe(63);
    expect(unset.liveDecideRateCapPer300s).toBeNull();
    expect(unset.liveObserveCadenceS).toBeUndefined(); // no knob => the env value
  });
});

describe("the knob reaches the observer and binds the charged rate", () => {
  let T0 = 0;
  let relayedS = 0;
  beforeEach(() => {
    T0 = Date.now() / 1000;
    relayedS = 0;
  });
  const servedClock = () => (T0 + relayedS) * 1000;

  /** Relay a paced 300 s share at a 4.12 s opportunity spacing (~73 / 300 s, the
   *  natural browser shape) and report what the rail charged. */
  async function driveShare(opts: { rateCapPer300s?: number | null; cadenceS?: number }) {
    const rail = new MediaRailObserver({
      jobId: `job-8544-rate-${opts.rateCapPer300s ?? "uncapped"}`,
      fps: 2,
      cadenceS: opts.cadenceS ?? 3,
      windowS: 10,
      maxFrames: 4,
      decideRateCapPer300s: opts.rateCapPer300s ?? null,
      wallClock: servedClock,
      onDecide: async () => false,
    });
    for (let i = 0; i < 73; i++) {
      const ts = T0 + i * 4.12;
      relayedS = ts - T0;
      rail.onObservation({ timestamp: ts, tracks: [] } as any, Buffer.from(`f${i}`).toString("base64"));
      await new Promise((r) => setTimeout(r, 0));
    }
    // Let the decide chain drain.
    let prev = -1;
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const now = rail.stats().decideCalls;
      if (now === prev && i > 4) break;
      prev = now;
    }
    const metrics = rail.observeMetrics();
    return {
      charged: rail.stats().decideCalls,
      throttled: metrics.throttleSkippedWindows ?? 0,
      opportunities: metrics.decideOpportunities ?? 0,
    };
  }

  it("an uncapped job (the shipped default) charges every opportunity", async () => {
    const r = await driveShare({ rateCapPer300s: null });
    expect(r.charged).toBe(73);
    expect(r.throttled).toBe(0);
    // The measured density is recorded even when nothing is capped — that is the
    // number the audit contrasts with the stamped prediction.
    expect(r.opportunities).toBeGreaterThanOrEqual(73);
  });

  it("rateCapPer300s 63 charges at the floor, not a fraction of the opportunities", async () => {
    const r = await driveShare({ rateCapPer300s: 63 });
    expect(r.throttled).toBeGreaterThan(0);
    expect(r.charged).toBeLessThanOrEqual(DECIDE_RATE_FLOOR_PER_300S);
    // A keep-ratio wire at the old 0.64 would charge 46 here; the knob charges
    // the floor in absolute units.
    expect(r.charged).toBeGreaterThan(Math.floor(0.64 * 73));
    expect(r.charged).toBeGreaterThanOrEqual(60);
  });

  it("rateCapPer300s 66 charges the ratified target on the same stream", async () => {
    const r = await driveShare({ rateCapPer300s: 66 });
    expect(r.charged).toBeGreaterThanOrEqual(62);
    expect(r.charged).toBeLessThanOrEqual(66);
  });
});

describe("AC4 — the coverage floor is enforced where the job is created", () => {
  it("62 is refused with decide_rate_below_coverage_floor, 63 accepted", () => {
    const bad = validateDecideKnobInput({ rateCapPer300s: 62 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("decide_rate_below_coverage_floor");
      expect(bad.message).toContain("63");
    }
    const good = validateDecideKnobInput({ rateCapPer300s: 63 });
    expect(good.ok).toBe(true);
  });
});

describe("wiring guards — the knob reaches BOTH rails and the route", () => {
  const serverSrc = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");

  it("POST /jobs validates the knob before the quota gate and stamps it on the row", () => {
    const src = serverSrc("api.ts");
    const routeAt = src.indexOf('app.post<{\n    Body: {');
    expect(routeAt).toBeGreaterThan(0);
    const block = src.slice(routeAt, routeAt + 4000);
    // The validation must appear before the quota gate so a refused knob spends
    // nothing.
    const validateAt = block.indexOf("validateDecideKnobInput");
    const quotaAt = block.indexOf("entitlements.canSubmit");
    expect(validateAt).toBeGreaterThan(0);
    expect(quotaAt).toBeGreaterThan(0);
    expect(validateAt).toBeLessThan(quotaAt);
    expect(block).toContain('code: knobInput.code');
    // The stamp is written once, at creation.
    expect(src).toMatch(/resolveDecideKnob\(\{/);
    expect(src).toMatch(/await store\.patchJob\(job\.id, \{ decideKnob \}\)/);
  });

  it("the analyzer live pass AND the media rail both receive decideRateCapPer300s", () => {
    const analyzer = serverSrc("analyzer.ts");
    expect(analyzer).toMatch(/decideRateCapPer300s: cfg\.liveDecideRateCapPer300s \?\? null/);
    const api = serverSrc("api.ts");
    const mediaAt = api.indexOf("new MediaRailObserver(");
    expect(mediaAt).toBeGreaterThan(0);
    expect(api.slice(mediaAt, mediaAt + 9000)).toContain("decideRateCapPer300s");
  });

  it("the live config carries the knob's cadence and rate cap, and nothing else", () => {
    const api = serverSrc("api.ts");
    expect(api).toMatch(/liveObserveCadenceS: decideKnob\?\.cadenceSec \?\? cfg\.liveObserveCadenceS/);
    expect(api).toMatch(/liveDecideRateCapPer300s: decideKnob\?\.rateCapPer300s \?\? null/);
  });
});

// --- AC1 at the ROUTE ------------------------------------------------------
//
// The first cut resolved the knob from `validateDecideKnobInput`'s output, which
// FILLS an absent input with the shipped default — so a bare POST /jobs stamped
// `resolvedSource: "user"` and the record could not tell the CEO-ruled economy
// default from a real choice. These assertions run the real route (buildTestApp,
// in-memory sqlite, no GPU, no live job) rather than the resolver in isolation,
// because the defect lived in the caller.
describe("AC1 at the route — the stamp reports what the client sent, not the validator's default", () => {
  async function registerUser(app: any, email: string): Promise<string> {
    const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "password123" } });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }

  async function submit(app: any, token: string, payload: Record<string, unknown>) {
    const r = await app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token}` }, payload });
    return { statusCode: r.statusCode, body: r.json() };
  }

  it("a bare POST /jobs stamps resolvedSource 'default' (5 s, uncapped) — never 'user'", async () => {
    const { app, store } = await buildTestApp();
    const token = await registerUser(app, "knob-bare@test.dev");
    const res = await submit(app, token, { source: "browser", gameHint: "x" });
    expect(res.statusCode).toBe(200);
    const jobId = res.body.job.id;
    const stored = store.getJob(jobId) as any;
    expect(stored.decideKnob).toBeTruthy();
    expect(stored.decideKnob.resolvedSource).toBe("default");
    expect(stored.decideKnob.cadenceSec).toBe(5);
    expect(stored.decideKnob.rateCapPer300s).toBeNull();
    // AC1: the audit echoes the stored stamp field for field, so it reads
    // 'default' too (a recomputation would drop back to 'user'/'default' drift).
    expect(windowAuditForJob(stored).decideKnob).toEqual(stored.decideKnob);
    await app.close();
  });

  it("an explicit value is 'user' — including an explicit 5 s and an explicit null cap", async () => {
    const { app, store } = await buildTestApp();
    const token = await registerUser(app, "knob-user@test.dev");

    const three = await submit(app, token, { source: "browser", gameHint: "x", cadenceSec: 3 });
    expect(three.statusCode).toBe(200);
    expect((store.getJob(three.body.job.id) as any).decideKnob.resolvedSource).toBe("user");
    expect((store.getJob(three.body.job.id) as any).decideKnob.cadenceSec).toBe(3);

    // Choosing the default value IS a choice: the record must say so.
    const five = await submit(app, token, { source: "browser", gameHint: "x", cadenceSec: 5 });
    expect(five.statusCode).toBe(200);
    expect((store.getJob(five.body.job.id) as any).decideKnob.resolvedSource).toBe("user");
    expect((store.getJob(five.body.job.id) as any).decideKnob.cadenceSec).toBe(5);

    const capped = await submit(app, token, { source: "browser", gameHint: "x", rateCapPer300s: 63 });
    expect(capped.statusCode).toBe(200);
    const cappedStamp = (store.getJob(capped.body.job.id) as any).decideKnob;
    expect(cappedStamp.resolvedSource).toBe("user");
    expect(cappedStamp.rateCapPer300s).toBe(63);
    expect(cappedStamp.predictedUsdPerHour).toBeGreaterThan(0);
    await app.close();
  });

  it("a below-floor cap is a 422 at the route and creates no job row", async () => {
    const { app, store } = await buildTestApp();
    const token = await registerUser(app, "knob-floor@test.dev");
    const before = store.listAllJobs().length;
    const res = await submit(app, token, { source: "browser", gameHint: "x", rateCapPer300s: 62 });
    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe("decide_rate_below_coverage_floor");
    expect(store.listAllJobs().length).toBe(before);
    // 63 on the same route is accepted (boundary).
    const ok = await submit(app, token, { source: "browser", gameHint: "x", rateCapPer300s: 63 });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it("wiring guard: the route hands resolveDecideKnob the raw body, not knobInput", () => {
    const src = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    const at = src.indexOf("const decideKnob = resolveDecideKnob({");
    expect(at).toBeGreaterThan(0);
    const call = src.slice(at, at + 400);
    expect(call).toContain("cadenceSec: req.body?.cadenceSec");
    expect(call).toContain("rateCapPer300s: req.body?.rateCapPer300s");
    expect(call).not.toContain("knobInput.cadenceSec");
    expect(call).not.toContain("knobInput.rateCapPer300s");
  });
});
