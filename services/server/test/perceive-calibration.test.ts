import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config";
import { parsePerceiveCalibration, resolvePerceiveCalibration } from "../src/perceive-calibration";
import { configurePerceiveCalibration, analyzeJob } from "../src/analyzer";
import type { PipelineClient, ReserveResult } from "../src/analyzer";

// A synthetic calibration fixture. This is a TEST fixture only — production
// calibration is never synthesized; it comes from explicit per-camera config
// (`PERCEIVE_CALIBRATION_JSON`) and we only exercise the plumbing here.
const FIXTURE_HOMOG = [
  [0.001, 0, -0.1],
  [0, 0.002, -0.2],
  [0, 0, 1],
];
const FIXTURE_GOAL_LINE = { axis: "y", position: 0, mouthMin: 20, mouthMax: 48 } as const;

describe("parsePerceiveCalibration (ADAAAA-7152 Gap 2)", () => {
  it("returns undefined when the env value is unset", () => {
    expect(parsePerceiveCalibration(undefined)).toBeUndefined();
  });

  it("returns undefined on malformed JSON or non-object", () => {
    expect(parsePerceiveCalibration("not json{")).toBeUndefined();
    expect(parsePerceiveCalibration("[1,2,3]")).toBeUndefined();
    expect(parsePerceiveCalibration("42")).toBeUndefined();
  });

  it("accepts a per-camera map with a reserved default entry", () => {
    const map = parsePerceiveCalibration(
      JSON.stringify({
        "stadium-north": { homography: FIXTURE_HOMOG, goalLine: FIXTURE_GOAL_LINE },
        default: { homography: FIXTURE_HOMOG },
      })
    );
    expect(map).toBeDefined();
    expect(resolvePerceiveCalibration(map, "stadium-north")).toEqual({
      homography: FIXTURE_HOMOG,
      goalLine: FIXTURE_GOAL_LINE,
    });
    // Unknown camera falls back to the default entry.
    expect(resolvePerceiveCalibration(map, "elsewhere")).toEqual({ homography: FIXTURE_HOMOG });
  });

  it("treats a bare calibration object as the default camera entry", () => {
    const map = parsePerceiveCalibration(JSON.stringify({ homography: FIXTURE_HOMOG, goalLine: FIXTURE_GOAL_LINE }));
    expect(map).toBeDefined();
    // no camera id -> default applies
    expect(resolvePerceiveCalibration(map)).toEqual({ homography: FIXTURE_HOMOG, goalLine: FIXTURE_GOAL_LINE });
  });

  it("drops malformed entries and returns undefined when nothing valid remains", () => {
    // goalLine has mouthMin >= mouthMax -> invalid entry dropped
    const map = parsePerceiveCalibration(
      JSON.stringify({
        "stadium-north": { goalLine: { axis: "y", position: 0, mouthMin: 50, mouthMax: 20 } },
        "stadium-south": { homography: "not-an-array" },
      })
    );
    expect(map).toBeUndefined();
    // A map with only a valid default survives.
    const map2 = parsePerceiveCalibration(JSON.stringify({ default: { homography: FIXTURE_HOMOG } }));
    expect(map2).toBeDefined();
    expect(resolvePerceiveCalibration(map2)).toEqual({ homography: FIXTURE_HOMOG });
  });

  it("loadConfig wires PERCEIVE_CALIBRATION_JSON into the config", () => {
    const cfg = loadConfig({ PERCEIVE_CALIBRATION_JSON: JSON.stringify({ default: { homography: FIXTURE_HOMOG, goalLine: FIXTURE_GOAL_LINE } }) });
    expect(cfg.perceiveCalibration).toBeDefined();
    expect(resolvePerceiveCalibration(cfg.perceiveCalibration)).toEqual({
      homography: FIXTURE_HOMOG,
      goalLine: FIXTURE_GOAL_LINE,
    });
  });

  it("loadConfig leaves calibration undefined when unset (uncalibrated baseline)", () => {
    const cfg = loadConfig({});
    expect(cfg.perceiveCalibration).toBeUndefined();
  });
});

describe("resolvePerceiveCalibration (ADAAAA-7152 Gap 2)", () => {
  const map = parsePerceiveCalibration(
    JSON.stringify({ "cam-a": { homography: FIXTURE_HOMOG }, default: { goalLine: FIXTURE_GOAL_LINE } })
  );
  it("picks the explicit camera entry over default", () => {
    expect(resolvePerceiveCalibration(map, "cam-a")).toEqual({ homography: FIXTURE_HOMOG });
  });
  it("falls back to default for an unknown camera", () => {
    expect(resolvePerceiveCalibration(map, "cam-zzz")).toEqual({ goalLine: FIXTURE_GOAL_LINE });
  });
  it("returns undefined when no calibration is configured", () => {
    expect(resolvePerceiveCalibration(undefined, "cam-a")).toBeUndefined();
    expect(resolvePerceiveCalibration({}, "cam-a")).toBeUndefined();
  });
});

describe("configurePerceiveCalibration forward (ADAAAA-7152 Gap 2)", () => {
  it("sends a `configure` control with homography + goalLine when calibration is present", async () => {
    const calls: any[] = [];
    const client = { controlForward: async (_sid: string, c: any) => { calls.push(c); } } as unknown as PipelineClient;
    await configurePerceiveCalibration(client, "sess-1", { homography: FIXTURE_HOMOG, goalLine: FIXTURE_GOAL_LINE });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ type: "configure", homography: FIXTURE_HOMOG, goalLine: FIXTURE_GOAL_LINE });
  });

  it("is a strict no-op (no forward) when no calibration is configured", async () => {
    const calls: any[] = [];
    const client = { controlForward: async (_sid: string, c: any) => { calls.push(c); } } as unknown as PipelineClient;
    await configurePerceiveCalibration(client, "sess-1", undefined);
    expect(calls).toHaveLength(0);
  });

  it("swallows a best-effort forward failure (never fatal)", async () => {
    const client = {
      controlForward: async () => { throw new Error("404 session lost"); },
    } as unknown as PipelineClient;
    // must not throw
    await expect(configurePerceiveCalibration(client, "sess-1", { homography: FIXTURE_HOMOG })).resolves.toBeUndefined();
  });

  it("only carries the parts of the calibration that are present", async () => {
    const calls: any[] = [];
    const client = { controlForward: async (_sid: string, c: any) => { calls.push(c); } } as unknown as PipelineClient;
    await configurePerceiveCalibration(client, "sess-1", { goalLine: FIXTURE_GOAL_LINE });
    expect(calls[0]).toEqual({ type: "configure", goalLine: FIXTURE_GOAL_LINE });
  });
});

// Minimal fake PipelineClient that records controlForward calls so we can assert
// analyzeJob ships the calibration to the reserved session.
function buildFakePipeline(record: any[]): PipelineClient {
  const controlCalls = record as Array<{ sessionId: string; control: any }>;
  return {
    async reservePerceive(): Promise<ReserveResult> {
      return { sessionId: "sess-fake", appUrl: "", controlUrl: "" };
    },
    async controlForward(sessionId: string, control: any): Promise<void> {
      controlCalls.push({ sessionId, control });
    },
    async analyze() {
      return { observation: { tracks: [], seq: 0, timestamp: 0 } };
    },
    async decide(): Promise<any> {
      return { isHighlight: true, score: 80, eventType: "GOAL", reason: "test" };
    },
    async postAudio() {
      return { candidate: null, series: [] };
    },
    async plan(): Promise<any> {
      return { planVersion: 1, category: "soccer", intent: "", source: "planner-fallback", maxTracks: 3, targets: [], reason: "test" };
    },
    async stopPerceive() {},
    async recallPerceive() {
      return { seeds: [] };
    },
    async confirm(): Promise<any> {
      return { goalConfirmed: null, verdict: { isHighlight: false, score: 0, eventType: "GOAL", reason: "test", outcome: "not_highlight" } };
    },
    async train(): Promise<any> {
      return { run: "r", checkpoint: "/r/m.safetensors", epochs: 1, samples: 1, eval: { eval: "completed", precision: 0, recall: 0, f1: 0 } };
    },
  };
}

function singleFrame() {
  return (async function* () {
    yield { seq: 0, timestamp: 0.0, imageB64: "AAAA" };
  })();
}

describe("analyzeJob ships calibration to the reserved perceive session", () => {
  it("forwards a `configure` control on reserve when calibration is configured", async () => {
    const record: any[] = [];
    const client = buildFakePipeline(record);
    await analyzeJob(client, singleFrame(), async () => ({ clipId: "c", clipUri: "u" , hasAudio: true }), {
      jobId: "job-1",
      gameHint: "soccer",
      clipBeforeS: 2,
      clipAfterS: 2,
      perceiveCalibration: { homography: FIXTURE_HOMOG, goalLine: FIXTURE_GOAL_LINE },
    });
    const fc = record.find((r) => r.control.type === "configure");
    expect(fc).toBeDefined();
    expect(fc.control.homography).toEqual(FIXTURE_HOMOG);
    expect(fc.control.goalLine).toEqual(FIXTURE_GOAL_LINE);
  });

  it("sends NO configure control when no calibration is configured (uncalibrated baseline)", async () => {
    const record: any[] = [];
    const client = buildFakePipeline(record);
    await analyzeJob(client, singleFrame(), async () => ({ clipId: "c", clipUri: "u" , hasAudio: true }), {
      jobId: "job-2",
      gameHint: "soccer",
      clipBeforeS: 2,
      clipAfterS: 2,
      // perceiveCalibration absent
    });
    expect(record.filter((r) => r.control.type === "configure")).toHaveLength(0);
  });
});
