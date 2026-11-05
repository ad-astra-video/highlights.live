import { describe, it, expect } from "vitest";
import {
  RECORDING_MIME_LADDER,
  MIN_RECORDED_BYTES,
  RECORDING_STALL_MS,
  RECORDING_HEALTH_POLL_MS,
  ENCODER_PROBE_MS,
  ENCODER_PROBE_MIN_BYTES,
  RECORDING_STALL_NOTICE,
  recordingStalled,
  recordingHealth,
  supportedRecordingMimes,
  probeProvesEncoding,
  chooseRecordingMime,
} from "./recordingCodec";

// ADAAAA-8055: a browser can claim `video/mp4;codecs=avc1` and then record only
// a container header, which left every screen-share highlight with no clip.
// ADAAAA-8105: a browser can also claim it and emit NOTHING, so the ladder order
// alone is not a capability test — these pin the probe-before-commit walk, the
// raised header floor, and the zero-chunk health state.

describe("recording codec ladder (ADAAAA-8055)", () => {
  it("prefers WebM and keeps mp4 only as a last resort", () => {
    expect(RECORDING_MIME_LADDER[0]).toBe("video/webm;codecs=vp9");
    expect(RECORDING_MIME_LADDER.indexOf("video/mp4;codecs=avc1")).toBe(RECORDING_MIME_LADDER.length - 1);
  });

  it("keeps the supported mimes in ladder order", () => {
    const all = supportedRecordingMimes(() => true);
    expect(all).toEqual([...RECORDING_MIME_LADDER]);
  });

  it("drops containers the browser cannot record", () => {
    // Safari-like: WebM unsupported, mp4 supported -> mp4 is chosen.
    expect(supportedRecordingMimes((m) => !m.includes("webm"))).toEqual(["video/mp4;codecs=avc1"]);
    // Chrome-like: only the plain webm fallback is offered.
    expect(supportedRecordingMimes((m) => m === "video/webm")).toEqual(["video/webm"]);
  });

  it("survives an isTypeSupported that throws", () => {
    expect(
      supportedRecordingMimes((m) => {
        if (m.includes("vp9")) throw new Error("boom");
        return true;
      })
    ).toEqual(["video/webm", "video/mp4;codecs=avc1"]);
  });

  it("returns no mime when nothing is supported (recorder default is used)", () => {
    expect(supportedRecordingMimes(() => false)).toEqual([]);
  });
});

describe("probe-before-commit mime choice (ADAAAA-8105)", () => {
  it("counts a container header as NO proof and real bytes as proof", () => {
    // Header sizes measured on the box: 752 B mp4, 49 B webm.
    expect(probeProvesEncoding(752)).toBe(false);
    expect(probeProvesEncoding(49)).toBe(false);
    expect(probeProvesEncoding(0)).toBe(false);
    expect(probeProvesEncoding(ENCODER_PROBE_MIN_BYTES - 1)).toBe(false);
    expect(probeProvesEncoding(ENCODER_PROBE_MIN_BYTES)).toBe(true);
    // ~1.5 s of a 3 Mbps share is ~500 KB, far above the floor.
    expect(probeProvesEncoding(500_000)).toBe(true);
  });

  it("commits the first arm that proves it can encode", async () => {
    const tried: string[] = [];
    const commit = await chooseRecordingMime([...RECORDING_MIME_LADDER], async (mime) => {
      tried.push(mime);
      return 500_000;
    });
    expect(tried).toEqual(["video/webm;codecs=vp9"]);
    expect(commit).toEqual({
      mime: "video/webm;codecs=vp9",
      proved: true,
      attempts: [{ mime: "video/webm;codecs=vp9", bytes: 500_000 }],
    });
  });

  it("walks down the ladder when an arm is claimed but cannot encode (the measured case)", async () => {
    // Reproduces `ccc9f1aa`: isTypeSupported says yes to mp4/avc1, the arm emits
    // a 752 B header and no frames. With the ladder ordered webm-first, the
    // broken arm is reached last; force it to be the only candidate.
    const tried: string[] = [];
    const commit = await chooseRecordingMime(["video/mp4;codecs=avc1"], async (mime) => {
      tried.push(mime);
      return 752;
    });
    expect(tried).toEqual(["video/mp4;codecs=avc1"]);
    // No arm proved; the header-only arm is still committed (best available)
    // instead of the caller uploading nothing, and `proved` tells the caller to
    // keep the live health warning armed.
    expect(commit.proved).toBe(false);
    expect(commit.mime).toBe("video/mp4;codecs=avc1");
  });

  it("skips a zero-chunk arm and commits the next one that encodes", async () => {
    const tried: string[] = [];
    const commit = await chooseRecordingMime([...RECORDING_MIME_LADDER], async (mime) => {
      tried.push(mime);
      // The first (vp9) arm emits nothing at all; plain webm encodes.
      return mime === "video/webm;codecs=vp9" ? 0 : 400_000;
    });
    expect(tried).toEqual(["video/webm;codecs=vp9", "video/webm"]);
    expect(commit.mime).toBe("video/webm");
    expect(commit.proved).toBe(true);
    expect(commit.attempts).toEqual([
      { mime: "video/webm;codecs=vp9", bytes: 0 },
      { mime: "video/webm", bytes: 400_000 },
    ]);
  });

  it("commits the most promising arm when nothing proves", async () => {
    const bytes: Record<string, number> = {
      "video/webm;codecs=vp9": 0,
      "video/webm": 49,
      "video/mp4;codecs=avc1": 752,
    };
    const commit = await chooseRecordingMime([...RECORDING_MIME_LADDER], async (m) => bytes[m]);
    expect(commit.proved).toBe(false);
    expect(commit.mime).toBe("video/mp4;codecs=avc1");
    expect(commit.attempts).toHaveLength(RECORDING_MIME_LADDER.length);
  });

  it("falls back to the preferred arm when every probe is empty", async () => {
    const commit = await chooseRecordingMime([...RECORDING_MIME_LADDER], async () => 0);
    expect(commit.proved).toBe(false);
    expect(commit.mime).toBe("video/webm;codecs=vp9");
  });

  it("treats a throwing probe as an empty arm instead of aborting the share", async () => {
    let n = 0;
    const commit = await chooseRecordingMime(["video/webm;codecs=vp9", "video/webm"], async () => {
      n += 1;
      if (n === 1) throw new Error("encoder init failed");
      return 300_000;
    });
    expect(commit.mime).toBe("video/webm");
    expect(commit.proved).toBe(true);
    expect(commit.attempts[0]).toEqual({ mime: "video/webm;codecs=vp9", bytes: 0 });
  });

  it("returns the browser default when the ladder offers nothing", async () => {
    const commit = await chooseRecordingMime([], async () => 1_000_000);
    expect(commit).toEqual({ mime: "", proved: false, attempts: [] });
  });

  it("probes each arm for a bounded window", () => {
    // One timeslice (1 s) plus encoder start-up slack; anything longer turns
    // share start into a stall of its own.
    expect(ENCODER_PROBE_MS).toBeGreaterThanOrEqual(1000);
    expect(ENCODER_PROBE_MS).toBeLessThanOrEqual(2500);
  });
});

describe("recording health (ADAAAA-8055 / ADAAAA-8105)", () => {
  it("flags a header-only recorder after the stall window", () => {
    expect(recordingStalled({ bytes: 752, ms: RECORDING_STALL_MS, state: "recording" })).toBe(true);
    expect(recordingStalled({ bytes: 0, ms: RECORDING_STALL_MS + 5000, state: "recording" })).toBe(true);
  });

  it("flags the zero-chunk recorder that died before its first chunk (ADAAAA-8105)", () => {
    // The measured `ccc9f1aa` shape: `start()` accepted, zero `dataavailable`
    // events, `state` flipped to inactive. Nothing is ever uploaded, so this is
    // the only place the loss can be caught during the share.
    expect(recordingHealth({ bytes: 0, ms: RECORDING_STALL_MS, state: "inactive" })).toBe("stalled");
    expect(recordingStalled({ bytes: 0, ms: RECORDING_STALL_MS + 5000, state: "inactive" })).toBe(true);
    // ... but never inside the start-up window, where inactive is transient.
    expect(recordingHealth({ bytes: 0, ms: RECORDING_STALL_MS - 1, state: "inactive" })).toBe("pending");
  });

  it("raises the header floor above the 1,194 B webm header job 202d0dad shipped", () => {
    expect(MIN_RECORDED_BYTES).toBeGreaterThan(1194);
    expect(recordingHealth({ bytes: 1194, ms: RECORDING_STALL_MS, state: "recording" })).toBe("stalled");
    expect(recordingHealth({ bytes: 752, ms: RECORDING_STALL_MS, state: "recording" })).toBe("stalled");
  });

  it("keeps the floor below real footage so a short share is not rejected", () => {
    // The smallest real recording the server suite produces is a 2-frame
    // 320x180 mp4 at 6,096 B; a 4 KB floor must accept it (an 8 KB floor
    // rejected it, which is why this bound is pinned).
    expect(MIN_RECORDED_BYTES).toBeLessThan(6000);
    expect(recordingHealth({ bytes: 6096, ms: RECORDING_STALL_MS, state: "recording" })).toBe("ok");
    // Header sizes measured on the box stay rejected.
    expect(recordingHealth({ bytes: 1194, ms: RECORDING_STALL_MS, state: "recording" })).toBe("stalled");
  });

  it("does not flag a healthy recording", () => {
    expect(recordingStalled({ bytes: 3_000_000, ms: RECORDING_STALL_MS, state: "recording" })).toBe(false);
    expect(recordingStalled({ bytes: MIN_RECORDED_BYTES, ms: RECORDING_STALL_MS, state: "recording" })).toBe(false);
    expect(recordingHealth({ bytes: 3_000_000, ms: 1000, state: "recording" })).toBe("ok");
  });

  it("does not flag before the stall window", () => {
    expect(recordingStalled({ bytes: 0, ms: RECORDING_STALL_MS - 1, state: "recording" })).toBe(false);
    expect(recordingHealth({ bytes: 0, ms: RECORDING_STALL_MS - 1, state: "recording" })).toBe("pending");
  });

  it("does not flag a paused recorder", () => {
    expect(recordingHealth({ bytes: 0, ms: RECORDING_STALL_MS * 3, state: "paused" })).toBe("pending");
  });

  it("keeps a live health readout cadence that warns during the share", () => {
    // Poll well inside the stall window so the warning lands while the share is
    // still live, and often enough that a mid-share recorder death is caught.
    expect(RECORDING_HEALTH_POLL_MS).toBeLessThan(RECORDING_STALL_MS);
    expect(RECORDING_STALL_MS / RECORDING_HEALTH_POLL_MS).toBeGreaterThanOrEqual(2);
  });

  it("names the consequence and the action in the live notice", () => {
    expect(RECORDING_STALL_NOTICE).toMatch(/clips will be missing/i);
    expect(RECORDING_STALL_NOTICE).toMatch(/another browser/i);
  });
});
