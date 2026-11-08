// ADAAAA-8377 (LFR-1): the live rail's frame SCALE is a knob, and every decide
// row states the REAL dims of the images it shipped.
//
// The live rail hardcoded `-vf fps=…,scale=320:180` (live.ts) while VOD ran
// 640:360, so every live finding rested on a 4x coarser image and nothing on a
// decide row said so. LFR-1 threads `LIVE_FRAME_SCALE` (default 320:180, no
// default flip) into the live extraction and stamps the payload's measured dims
// beside the image budget, so the ON leg of the A/B proves 640x360 off stored
// rows instead of `printenv`.
//
// These tests pin:
//   1. the env -> config -> ffmpeg-filter path of the knob (default + override),
//   2. the boot posture line that names it,
//   3. the JPEG dim measurement (real bytes when ffmpeg is available, a
//      hand-built SOF header otherwise),
//   4. `imageW`/`imageH` on a live payload built through the shipped selection
//      step, and their ABSENCE when nothing was measured (never a fabricated 0).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LIVE_FRAME_SCALE_DEFAULT, loadConfig, resolveFrameScale } from "../src/config";
import { LIVE_OBSERVE_MAX_FRAMES, assembleLiveWindow, assembleObserveWindow, buildObservePayload } from "../src/observe-loop";
import { liveDecideBootLines } from "../src/live-decide-posture";
import { attachPayloadImageDims } from "../src/analyzer";
import { jpegDimensions, jpegDimensionsFromBase64 } from "../src/image-dims";

/** Build a minimal JPEG byte stream whose SOF0 segment states `w x h`. Enough
 * for the header walk (SOI -> APP0 -> SOF0 -> EOI) without a real encoder. */
function syntheticJpeg(w: number, h: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2); // segment length (includes the length field)
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof.writeUInt8(3, 9); // components
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("LIVE_FRAME_SCALE: the knob (ADAAAA-8377 AC-1 / AC-7)", () => {
  it("defaults to the shipped 320:180 — no silent flip", () => {
    expect(LIVE_FRAME_SCALE_DEFAULT).toBe("320:180");
    expect(loadConfig({}).liveFrameScale).toBe("320:180");
    // An empty value (compose's `${X:-}`) means UNSET, not a broken filter.
    expect(loadConfig({ LIVE_FRAME_SCALE: "" }).liveFrameScale).toBe("320:180");
  });

  it("honours the ON-arm override and normalizes both ffmpeg spellings", () => {
    expect(loadConfig({ LIVE_FRAME_SCALE: "640:360" }).liveFrameScale).toBe("640:360");
    expect(loadConfig({ LIVE_FRAME_SCALE: "640x360" }).liveFrameScale).toBe("640:360");
    expect(loadConfig({ LIVE_FRAME_SCALE: " 1280:720 " }).liveFrameScale).toBe("1280:720");
    // Nothing that would hand ffmpeg a filter it cannot parse.
    for (const bad of ["", "640", "0:0", "-640:360", "big:small", "640:360:extra"]) {
      expect(resolveFrameScale(bad)).toBe("320:180");
    }
  });

  it("names the resolved scale in the boot posture readout", () => {
    const off = liveDecideBootLines({
      liveObserveMaxFrames: LIVE_OBSERVE_MAX_FRAMES,
      liveObserveInFlight: 4,
    }).join("\n");
    expect(off).toContain("[boot] live frame scale: 320:180 (LIVE_FRAME_SCALE, default 320:180");
    const on = liveDecideBootLines({
      liveObserveMaxFrames: LIVE_OBSERVE_MAX_FRAMES,
      liveObserveInFlight: 4,
      liveFrameScale: "640:360",
    }).join("\n");
    expect(on).toContain("[boot] live frame scale: 640:360 (LIVE_FRAME_SCALE, default 320:180");
    // The readout keeps naming the image-budget line the scale sits beside.
    expect(on).toContain("[boot] live decide image budget:");
  });
});

describe("JPEG dim measurement (ADAAAA-8377 AC-1)", () => {
  it("reads the SOF dims and rejects non-JPEG bytes", () => {
    expect(jpegDimensions(syntheticJpeg(640, 360))).toEqual({ width: 640, height: 360 });
    expect(jpegDimensions(syntheticJpeg(320, 180))).toEqual({ width: 320, height: 180 });
    expect(jpegDimensions(Buffer.from("not a jpeg"))).toBeUndefined();
    expect(jpegDimensions(Buffer.from([0xff, 0xd8]))).toBeUndefined();
    // A truncated header (SOF length runs past the buffer) is unmeasured.
    const truncated = syntheticJpeg(640, 360).subarray(0, 12);
    expect(jpegDimensions(truncated)).toBeUndefined();
  });

  it("reads REAL ffmpeg JPEGs at both arm scales", () => {
    if (!hasFfmpeg) return; // the parser path above still covers CI without ffmpeg
    const dir = mkdtempSync(path.join(tmpdir(), "hl-frame-scale-8377-"));
    try {
      for (const [scale, w, h] of [
        ["320:180", 320, 180],
        ["640:360", 640, 360],
      ] as const) {
        const out = path.join(dir, `frame-${w}.jpg`);
        execFileSync("ffmpeg", [
          "-y", "-v", "error",
          "-f", "lavfi", "-i", `testsrc=size=1280x720:rate=1`,
          "-frames:v", "1",
          "-vf", `scale=${scale}`,
          "-q:v", "3",
          out,
        ]);
        const bytes = execFileSync("cat", [out]);
        expect(jpegDimensions(bytes)).toEqual({ width: w, height: h });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts bare base64 and a data: URL prefix", () => {
    const b64 = syntheticJpeg(640, 360).toString("base64");
    expect(jpegDimensionsFromBase64(b64)).toEqual({ width: 640, height: 360 });
    expect(jpegDimensionsFromBase64(`data:image/jpeg;base64,${b64}`)).toEqual({
      width: 640,
      height: 360,
    });
    expect(jpegDimensionsFromBase64(undefined)).toBeUndefined();
    expect(jpegDimensionsFromBase64("")).toBeUndefined();
  });
});

describe("decide payload dims (ADAAAA-8377 AC-1)", () => {
  const ON = syntheticJpeg(640, 360).toString("base64");
  const OFF = syntheticJpeg(320, 180).toString("base64");

  it("stamps imageW/imageH from the images the call actually carries", () => {
    const frames = Array.from({ length: 12 }, (_, i) => ({
      ts: 1_000 + i,
      imageB64: ON,
    }));
    const win = assembleLiveWindow(frames, 1_011, { maxFrames: 4, windowS: 10 });
    expect(win.frames.length).toBeLessThanOrEqual(4);
    const payload = buildObservePayload(win, new Map());
    expect(payload.imagesPerDecide).toBe(payload.frames.length);
    expect(payload.imageBudgetApplied).toBe(true);
    expect(payload.imageW).toBe(640);
    expect(payload.imageH).toBe(360);

    const offWin = assembleLiveWindow(
      frames.map((f) => ({ ...f, imageB64: OFF })),
      1_011,
      { maxFrames: 4, windowS: 10 }
    );
    const offPayload = buildObservePayload(offWin, new Map());
    expect([offPayload.imageW, offPayload.imageH]).toEqual([320, 180]);
  });

  it("claims no dims when the window carries no images (never a fabricated 0)", () => {
    const win = assembleLiveWindow([], 1_000, { maxFrames: 4, windowS: 10 });
    const payload = buildObservePayload(win, new Map());
    expect(payload.frames).toEqual([]);
    expect(payload).not.toHaveProperty("imageW");
    expect(payload).not.toHaveProperty("imageH");
  });

  it("leaves a VOD symmetric window free of live-only keys", () => {
    const win = assembleObserveWindow([{ ts: 1_000, imageB64: ON }], 1_000, { maxFrames: 4 });
    const payload = buildObservePayload(win, new Map());
    // A VOD window never consults the live image budget, so it must not invent
    // the budget clause or dims either — this is the byte-identical VOD contract.
    expect(payload.imageBudgetApplied).toBeUndefined();
    expect(payload).not.toHaveProperty("imageW");
    expect(payload).not.toHaveProperty("imageH");
  });
});

describe("decide-audit dim stamp (ADAAAA-8377 AC-1)", () => {
  it("stamps the payload dims beside the image budget and in timings.imageDims", () => {
    const audit = {
      timings: {
        elapsedMs: 2100,
        perceiveTimeline: { records: 4, imagesPerDecide: 4, imageBudgetApplied: true },
      },
    };
    const out = attachPayloadImageDims(audit, { imageW: 640, imageH: 360 }) as any;
    expect(out.timings.perceiveTimeline.imageW).toBe(640);
    expect(out.timings.perceiveTimeline.imageH).toBe(360);
    expect(out.timings.imageDims).toEqual({ width: 640, height: 360 });
    // The decide-reported ledger is preserved, and the input is not mutated.
    expect(out.timings.perceiveTimeline.imagesPerDecide).toBe(4);
    expect(out.timings.elapsedMs).toBe(2100);
    expect((audit.timings.perceiveTimeline as any).imageW).toBeUndefined();
  });

  it("always leaves a server-measured imageDims even with no echoed ledger", () => {
    const out = attachPayloadImageDims({ timings: { elapsedMs: 900 } }, { imageW: 320, imageH: 180 }) as any;
    expect(out.timings.imageDims).toEqual({ width: 320, height: 180 });
    expect(out.timings.perceiveTimeline).toBeUndefined();
  });

  it("never overwrites a dim the decide service reported", () => {
    const out = attachPayloadImageDims(
      { timings: { perceiveTimeline: { imageW: 640, imageH: 360 } } },
      { imageW: 320, imageH: 180 }
    ) as any;
    expect(out.timings.perceiveTimeline.imageW).toBe(640);
    expect(out.timings.perceiveTimeline.imageH).toBe(360);
  });

  it("claims nothing when the payload carried no measured dims", () => {
    const audit = { timings: { perceiveTimeline: { records: 4 } } };
    expect(attachPayloadImageDims(audit, {})).toBe(audit);
    expect((audit.timings.perceiveTimeline as any).imageW).toBeUndefined();
  });
});
