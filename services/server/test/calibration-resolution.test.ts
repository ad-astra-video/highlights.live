// ADAAAA-7152 cont / ADAAAA-7163 Blocker 1: per-camera/per-clip goal-line
// calibration resolution. A job id is a server-side random UUID, so keying a
// calibration only by job id made it UNREACHABLE for an operator. This verifies
// the resolver tries, in order: exact job id -> a stable clip/camera key (source
// url/path basename) -> a reserved `default`, and returns undefined when nothing
// matches (perceive reports not_captured, never fabricated).
import { describe, it, expect } from "vitest";
import { resolveGoalLineCalibration, stableClipCalibrationKey } from "../src/api";
import type { ServerConfig } from "../src/config";

function cfg(cal: Record<string, unknown> | undefined): ServerConfig {
  return { goalLineCalibrations: cal as any } as unknown as ServerConfig;
}

describe("stableClipCalibrationKey", () => {
  it("derives a basename from a URL", () => {
    expect(stableClipCalibrationKey("https://cdn.example.com/clips/real_goal_3080.mp4")).toBe(
      "real_goal_3080.mp4"
    );
  });
  it("derives a basename from a local path", () => {
    expect(stableClipCalibrationKey("/home/brad/data/real_match_70s.mp4")).toBe(
      "real_match_70s.mp4"
    );
  });
  it("falls back to the raw string when no basename exists", () => {
    expect(stableClipCalibrationKey("rtmp://x")).toBe("rtmp://x");
  });
  it("returns undefined for an empty source", () => {
    expect(stableClipCalibrationKey("")).toBeUndefined();
    expect(stableClipCalibrationKey(undefined)).toBeUndefined();
  });
});

describe("resolveGoalLineCalibration", () => {
  const cal = { homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] };

  it("matches the exact job id first", () => {
    const c = cfg({ "job-123": cal, "real_goal_3080.mp4": { ...cal, h: 2 }, default: { ...cal, d: 3 } });
    const r = resolveGoalLineCalibration(c, ["job-123", "real_goal_3080.mp4"]);
    expect(r).toBe(cal);
  });

  it("falls through to the stable clip key when the job id is not keyed", () => {
    const clipCal = { ...cal, clip: true };
    const c = cfg({ "real_goal_3080.mp4": clipCal, default: { ...cal, d: 3 } });
    const r = resolveGoalLineCalibration(c, ["job-123", "real_goal_3080.mp4"]);
    expect(r).toBe(clipCal);
  });

  it("falls back to `default` when neither job id nor clip key matches", () => {
    const defCal = { ...cal, def: true };
    const c = cfg({ default: defCal });
    const r = resolveGoalLineCalibration(c, ["job-123", "real_goal_3080.mp4"]);
    expect(r).toBe(defCal);
  });

  it("returns undefined (never fabricated) when nothing matches", () => {
    expect(resolveGoalLineCalibration(cfg({}), ["job-123", "real_goal_3080.mp4"])).toBeUndefined();
    expect(resolveGoalLineCalibration(cfg(undefined), ["job-123"])).toBeUndefined();
  });

  it("skips undefined keys and uses the first present match", () => {
    const clipCal = { ...cal, clip: true };
    const c = cfg({ "real_goal_3080.mp4": clipCal });
    const r = resolveGoalLineCalibration(c, [undefined, "real_goal_3080.mp4"]);
    expect(r).toBe(clipCal);
  });
});
