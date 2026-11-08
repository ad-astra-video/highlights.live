// ADAAAA-8430 (LFR-5): the media/RTC rail width.
//
// The natural browser live path never read `LIVE_FRAME_SCALE` (that knob covers
// only the server's ffmpeg rail); its decode cap was a hardcoded `maxWidth 480`
// in services/media/src/rtc.ts. Measured on natural job b55c5781: 1800/1800
// rail JPEGs at 480x300 and 459/459 decide rows at imageW=480. These cases pin
// the wire end to end: env -> config -> MediaServer -> session -> ffmpeg filter,
// and pin that an unset knob is still exactly 480 (inert by default).
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RTC_MAX_WIDTH_DEFAULT,
  RTC_MAX_WIDTH_MAX,
  RTC_MAX_WIDTH_MIN,
  WebRtcIngestSession,
  normalizeRtcMaxWidth,
} from "../src/rtc";
import { loadConfig, rtcMaxWidthFromEnv } from "../src/config";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** A decoder that records the exact argv it was spawned with, then emits one
 *  complete JPEG (the shape decodeAndEmit expects from `-f mjpeg`). */
function argvRecordingDecoder(): { bin: string; argsFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "hl-rtc-8430-"));
  const bin = path.join(dir, "ffmpeg-args");
  const argsFile = path.join(dir, "argv.json");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
      "const jpeg = Buffer.concat([Buffer.from([0xff,0xd8]), Buffer.alloc(64, 0x41), Buffer.from([0xff,0xd9])]);",
      "process.stdout.write(jpeg);",
      "process.exit(0);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { bin, argsFile };
}

describe("MEDIA_RTC_MAX_WIDTH resolution + clamp (ADAAAA-8430)", () => {
  it("defaults to 480 when the knob is absent, empty or invalid", () => {
    // Absent: the pre-wire hardcoded cap. This is the inert-default contract.
    expect(RTC_MAX_WIDTH_DEFAULT).toBe(480);
    expect(normalizeRtcMaxWidth(undefined)).toBe(480);
    expect(normalizeRtcMaxWidth(null)).toBe(480);
    // compose's `${MEDIA_RTC_MAX_WIDTH:-}` passes "" when .env does not set it.
    expect(normalizeRtcMaxWidth("")).toBe(480);
    expect(normalizeRtcMaxWidth("   ")).toBe(480);
    expect(normalizeRtcMaxWidth("not-a-number")).toBe(480);
    expect(normalizeRtcMaxWidth(Number.NaN)).toBe(480);
    expect(normalizeRtcMaxWidth(Number.POSITIVE_INFINITY)).toBe(480);
  });

  it("honours the LFR-5 flip value and mirrors the fps helper's clamp shape", () => {
    expect(normalizeRtcMaxWidth(640)).toBe(640);
    expect(normalizeRtcMaxWidth("640")).toBe(640);
    expect(normalizeRtcMaxWidth(" 640 ")).toBe(640);
    // Rounded to whole pixels, clamped into a sane floor/ceiling.
    expect(normalizeRtcMaxWidth(640.4)).toBe(640);
    expect(normalizeRtcMaxWidth(1)).toBe(RTC_MAX_WIDTH_MIN);
    expect(normalizeRtcMaxWidth(64)).toBe(64);
    expect(normalizeRtcMaxWidth(1920)).toBe(1920);
    expect(normalizeRtcMaxWidth(99999)).toBe(RTC_MAX_WIDTH_MAX);
    expect(normalizeRtcMaxWidth(-10)).toBe(RTC_MAX_WIDTH_MIN);
    expect(RTC_MAX_WIDTH_MIN).toBe(64);
    expect(RTC_MAX_WIDTH_MAX).toBe(1920);
  });

  it("reads the env name the compose passthrough sets", () => {
    expect(rtcMaxWidthFromEnv({})).toBe(480);
    expect(rtcMaxWidthFromEnv({ MEDIA_RTC_MAX_WIDTH: "" })).toBe(480);
    expect(rtcMaxWidthFromEnv({ MEDIA_RTC_MAX_WIDTH: "640" })).toBe(640);
    expect(rtcMaxWidthFromEnv({ MEDIA_RTC_MAX_WIDTH: "junk" })).toBe(480);
    // loadConfig carries the same resolved value onto MediaConfig.
    expect(loadConfig({}).rtcMaxWidth).toBe(480);
    expect(loadConfig({ MEDIA_RTC_MAX_WIDTH: "640" }).rtcMaxWidth).toBe(640);
  });
});

describe("the decoded sample's ffmpeg filter uses the configured width (ADAAAA-8430)", () => {
  it("caps at 640 when the knob is 640 and preserves aspect/min() semantics", async () => {
    const { bin, argsFile } = argvRecordingDecoder();
    const session = new WebRtcIngestSession({
      sampleFps: 1,
      ffmpegBin: bin,
      maxWidth: 640,
      sessionId: "sess-8430-640",
    });
    session.on("error", () => {});
    session.on("ffmpeg", () => {});
    (session as any).seg = [{ data: Buffer.alloc(64, 7), pts: 0 }];
    (session as any).vclCount = 1;
    await (session as any).sampleFrame(Date.now() / 1000, 0);

    const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    const vf = args[args.indexOf("-vf") + 1];
    // The comma inside min() stays escaped or ffmpeg splits the filter graph.
    expect(vf).toBe("scale=min(640\\,iw):-2");
    expect(session.framesEmitted).toBe(1);
  });

  it("still caps at 480 when the session is built without a width", async () => {
    const { bin, argsFile } = argvRecordingDecoder();
    const session = new WebRtcIngestSession({ sampleFps: 1, ffmpegBin: bin, sessionId: "sess-8430-default" });
    session.on("error", () => {});
    session.on("ffmpeg", () => {});
    (session as any).seg = [{ data: Buffer.alloc(64, 7), pts: 0 }];
    (session as any).vclCount = 1;
    await (session as any).sampleFrame(Date.now() / 1000, 0);

    const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=min(480\\,iw):-2");
  });
});
