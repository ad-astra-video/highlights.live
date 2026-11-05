// ADAAAA-8106: the clip cut's argument vector is CONTRACT, not taste.
//
// A 1080p browser share recorded by MediaRecorder reports `r_frame_rate 1000/1`
// (1 ms timescale => the demuxer's smallest frame duration looks like 1 ms), so
// ffmpeg's default CFR output duplicated each real frame up to that nominal
// rate: a 15 s window encoded 15,030 frames instead of ~441 and took ~20 s
// instead of ~2.5 s on the box, which missed ADAAAA-8032 AC1 (clip within
// clipAfterS + 5 s). These assertions pin the two properties that fix it, so a
// future "make it faster" edit cannot silently change the delivered window
// (moving -ss/-t after -i) or reintroduce the frame-rate explosion (dropping
// -fps_mode vfr).
import { describe, it, expect } from "vitest";
import { buildClipArgs } from "../src/ffmpeg";

const SOURCE = "/data/live/job-1/capture.webm";
const OUT = "/data/clips/job-1-2739.mp4";

function reencodeMp4(startS = 273.9, durationS = 15) {
  return buildClipArgs({ source: SOURCE, outPath: OUT, startS, durationS, mode: "reencode", kind: "mp4" });
}

describe("buildClipArgs — window strategy", () => {
  it("seeks at the demuxer: -ss and -t sit BEFORE -i", () => {
    const args = reencodeMp4();
    const ss = args.indexOf("-ss");
    const t = args.indexOf("-t");
    const i = args.indexOf("-i");
    expect(ss).toBeGreaterThanOrEqual(0);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(i).toBeGreaterThan(ss);
    expect(i).toBeGreaterThan(t);
    // The values are the requested window, unchanged by the strategy switch.
    expect(args[ss + 1]).toBe("273.9");
    expect(args[t + 1]).toBe("15");
    expect(args[i + 1]).toBe(SOURCE);
    expect(args[args.length - 1]).toBe(OUT);
  });

  it("clamps a negative in-point to 0 instead of asking ffmpeg to seek backwards", () => {
    const args = reencodeMp4(-4, 15);
    expect(args[args.indexOf("-ss") + 1]).toBe("0");
  });
});

describe("buildClipArgs — re-encode strategy", () => {
  it("re-encodes vp9/opus webm into playable h264/aac with VFR frame timing", () => {
    const args = reencodeMp4();
    expect(args).toContain("-c:v");
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    expect(args[args.indexOf("-preset") + 1]).toBe("veryfast");
    expect(args[args.indexOf("-crf") + 1]).toBe("23");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
    expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
    expect(args).toContain("-movflags");
    // load-bearing (see file header): without it a 1000/1 source encodes ~34x
    // the real frames.
    expect(args.filter((a) => a === "-fps_mode")).toHaveLength(1);
    expect(args[args.indexOf("-fps_mode") + 1]).toBe("vfr");
    // An audio-less share must not fail the cut.
    expect(args[args.indexOf("-map", args.indexOf("-map") + 1) + 1]).toBe("0:a:0?");
  });

  it("re-encodes into webm with the same VFR guard", () => {
    const args = buildClipArgs({
      source: "/data/clips/in.mp4",
      outPath: "/data/clips/out.webm",
      startS: 1,
      durationS: 15,
      mode: "reencode",
      kind: "webm",
    });
    expect(args[args.indexOf("-c:v") + 1]).toBe("libvpx-vp9");
    expect(args[args.indexOf("-fps_mode") + 1]).toBe("vfr");
  });
});

describe("buildClipArgs — stream-copy strategy (720p / h264 path)", () => {
  it("keeps the historical copy args so the 720p path's bytes do not change", () => {
    const args = buildClipArgs({ source: "/data/rec.mp4", outPath: OUT, startS: 8, durationS: 15, mode: "copy", kind: "mp4" });
    expect(args[args.indexOf("-c") + 1]).toBe("copy");
    expect(args[args.indexOf("-avoid_negative_ts") + 1]).toBe("make_zero");
    // no encoder settings and no frame-rate resampling on the copy path
    expect(args).not.toContain("-fps_mode");
    expect(args).not.toContain("-c:v");
    expect(args).not.toContain("-preset");
    expect(args[args.length - 1]).toBe(OUT);
  });
});
