import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clipWindow, validateClipWindow, CLIP_WINDOW_MAX_SIDE_S } from "../src/config";
import {
  localizeHighlightInstant,
  localizeHighlightInstantFrame,
  localizeHighlightInstantVod,
  assessAudioBurst,
  frameLocalizationScore,
  acceptVideoDecision,
  LiveRunShared,
  AUDIO_BURST_MIN_PEAK_TO_BASELINE,
  PEAK_AUDIO_ANCHOR_TOLERANCE_S,
  type LocalizeFrameInput,
  type AnalyzerConfig,
} from "../src/analyzer";
import type { PerFrameSignal } from "../src/observe-loop";

describe("clipWindow (ADAAAA-7232)", () => {
  it("defaults to a 15s window centered on the event (7s before, 8s after)", () => {
    const w = clipWindow(100, 7, 8, 15);
    expect(w.start).toBe(93);
    expect(w.end).toBe(108);
    expect(w.end - w.start).toBe(15);
  });

  it("pads the after side to honor the >=15s floor when tuned shorter", () => {
    const w = clipWindow(100, 2, 2, 15);
    expect(w.end - w.start).toBe(15);
    // padding goes to the after side, pre-roll is preserved
    expect(w.start).toBe(98);
    expect(w.end).toBe(113);
  });

  it("does not shrink a window that already meets the floor", () => {
    const w = clipWindow(100, 10, 10, 15);
    expect(w.start).toBe(90);
    expect(w.end).toBe(110);
    expect(w.end - w.start).toBe(20);
  });

  it("clamps the start at 0 around a very early event", () => {
    const w = clipWindow(3, 7, 8, 15);
    expect(w.start).toBe(0);
    expect(w.end - w.start).toBe(15);
  });
});

describe("localizeHighlightInstant (ADAAAA-7232)", () => {
  it("picks the highest-RMS audio tap strictly after the trigger within lookahead", () => {
    const taps = [
      { ts: 9.0, rms: 0.1 },
      { ts: 10.5, rms: 0.9 },
      { ts: 12.0, rms: 0.5 },
    ];
    const loc = localizeHighlightInstant(9.5, taps, 8);
    expect(loc).toEqual({ ts: 10.5, signal: "peak_audio" });
  });

  it("ignores taps at or before the trigger and beyond the lookahead", () => {
    const taps = [
      { ts: 9.4, rms: 1.0 }, // <= trigger (9.5) -> ignored
      { ts: 9.6, rms: 0.3 },
      { ts: 20.0, rms: 1.0 }, // beyond lookahead -> ignored
    ];
    const loc = localizeHighlightInstant(9.5, taps, 8);
    expect(loc).toEqual({ ts: 9.6, signal: "peak_audio" });
  });

  it("falls back to the trigger when no post-trigger tap is buffered", () => {
    const loc = localizeHighlightInstant(12, [{ ts: 11, rms: 0.9 }], 8);
    expect(loc).toEqual({ ts: 12, signal: "trigger" });
    expect(localizeHighlightInstant(12, undefined, 8)).toEqual({ ts: 12, signal: "trigger" });
    expect(localizeHighlightInstant(12, [], 8)).toEqual({ ts: 12, signal: "trigger" });
  });
});

describe("validateClipWindow (ADAAAA-7247 / ACC-7)", () => {
  it("accepts whole-second values and returns the nominal window", () => {
    const v = validateClipWindow(7, 8, 15);
    expect(v.ok).toBe(true);
    expect(v.clipBeforeS).toBe(7);
    expect(v.clipAfterS).toBe(8);
    expect(v.windowSec).toBe(15);
  });

  it("accepts any non-negative whole-second pair (even < minSec; clipWindow pads at assembly)", () => {
    const v = validateClipWindow(1, 2, 15);
    expect(v.ok).toBe(true);
    expect(v.windowSec).toBe(3);
  });

  it("rejects a missing / non-numeric value with a clear message", () => {
    const v = validateClipWindow(undefined, 8, 15);
    expect(v.ok).toBe(false);
    expect(v.error).toContain("clipBeforeS must be a number");
    const v2 = validateClipWindow("7", 8, 15);
    expect(v2.ok).toBe(false);
    expect(v2.error).toContain("clipBeforeS must be a number");
  });

  it("rejects fractional seconds", () => {
    const v = validateClipWindow(7.5, 8, 15);
    expect(v.ok).toBe(false);
    expect(v.error).toContain("whole number of seconds");
  });

  it("rejects negative values with a clear message", () => {
    const v = validateClipWindow(-1, 8, 15);
    expect(v.ok).toBe(false);
    expect(v.error).toContain("0 or more seconds");
  });

  it("rejects out-of-range (per-side > cap) values with a clear message", () => {
    const v = validateClipWindow(7, CLIP_WINDOW_MAX_SIDE_S + 1, 15);
    expect(v.ok).toBe(false);
    expect(v.error).toContain("capped at");
  });

  it("never lets an invalid pair break the >=15s floor (clipWindow pads)", () => {
    // Even a 1/1 setting still yields a >=15s delivered window via clipWindow.
    const w = clipWindow(100, 1, 1, 15);
    expect(w.end - w.start).toBe(15);
  });
});

describe("frameLocalizationScore (ADAAAA-7253 / ACC-3)", () => {
  const sig = (over: PerFrameSignal): PerFrameSignal => over;
  it("ranks ball-in-net above goal-crossed above scoreboard-change", () => {
    expect(frameLocalizationScore({ ts: 1, signal: sig({ ballInNet: true }) })).toBeGreaterThan(
      frameLocalizationScore({ ts: 1, signal: sig({ goalCrossed: true }) })
    );
    expect(frameLocalizationScore({ ts: 1, signal: sig({ goalCrossed: true }) })).toBeGreaterThan(
      frameLocalizationScore({ ts: 1, signal: sig({ scoreBoardChanged: true }) })
    );
  });

  it("scores a goal-valued ballOutcome above a plain scoreboard change", () => {
    const goal = frameLocalizationScore({ ts: 1, signal: sig({ ballOutcome: "goal" }) });
    const sb = frameLocalizationScore({ ts: 1, signal: sig({ scoreBoardChanged: true }) });
    expect(goal).toBeGreaterThan(sb);
  });

  it("falls through to tracking-detection confidence when no goal signal is present", () => {
    const none = frameLocalizationScore({ ts: 1, signal: undefined, detectionConfidence: 0 });
    const conf = frameLocalizationScore({ ts: 1, signal: undefined, detectionConfidence: 0.9 });
    expect(conf).toBeGreaterThan(none);
    expect(conf).toBeGreaterThan(0);
  });
});

describe("localizeHighlightInstantFrame (ADAAAA-7253 / ACC-3)", () => {
  const frame = (ts: number, signal?: PerFrameSignal, detectionConfidence?: number): LocalizeFrameInput => ({
    ts,
    signal,
    detectionConfidence,
  });
  const ballInNet = (ts: number): LocalizeFrameInput => frame(ts, { ballInNet: true });

  it("picks the peak ball-in-net frame deterministically after the trigger", () => {
    const frames = [
      frame(9.6, { scoreBoardChanged: true }), // scoreboard change
      frame(10.5, { ballInNet: true }), // peak (ball-in-net)
      frame(11.0, { goalCrossed: true }),
    ];
    const loc = localizeHighlightInstantFrame(frames, 9.5, 8);
    expect(loc).toEqual({ ts: 10.5, signal: "peak_frame" });
  });

  it("tie-breaks to the earliest qualifying frame (deterministic)", () => {
    const frames = [ballInNet(10.5), ballInNet(11.0)];
    const loc = localizeHighlightInstantFrame(frames, 9.5, 8);
    expect(loc).toEqual({ ts: 10.5, signal: "peak_frame" });
  });

  it("ignores frames at/before the trigger and beyond the lookahead", () => {
    const frames = [
      ballInNet(9.4), // <= trigger -> ignored
      ballInNet(9.6),
      ballInNet(20.0), // beyond lookahead -> ignored
    ];
    const loc = localizeHighlightInstantFrame(frames, 9.5, 8);
    expect(loc).toEqual({ ts: 9.6, signal: "peak_frame" });
  });

  it("falls back to detection-confidence peak when no goal signal is present", () => {
    const frames = [
      frame(10.0, undefined, 0.5),
      frame(11.0, undefined, 0.9),
      frame(12.0, undefined, 0.7),
    ];
    const loc = localizeHighlightInstantFrame(frames, 9.5, 8);
    expect(loc).toEqual({ ts: 11.0, signal: "peak_frame" });
  });

  it("falls back to the trigger when no qualifying signal-bearing frame exists", () => {
    const loc = localizeHighlightInstantFrame([frame(10.0)], 9.5, 8);
    expect(loc).toEqual({ ts: 9.5, signal: "trigger" });
    expect(localizeHighlightInstantFrame([], 9.5, 8)).toEqual({ ts: 9.5, signal: "trigger" });
    expect(localizeHighlightInstantFrame([frame(3, { ballInNet: true })], 9.5, 8)).toEqual({ ts: 9.5, signal: "trigger" });
  });
});

describe("localizeHighlightInstantVod (ADAAAA-7253 / ACC-3)", () => {
  const taps = [{ ts: 10.5, rms: 0.9 }];
  const frames: LocalizeFrameInput[] = [{ ts: 10.5, signal: { ballInNet: true } }];

  it("prefers the frame-based peak over peak-audio when a frame signal is present", () => {
    const loc = localizeHighlightInstantVod(9.5, frames, taps, 8);
    expect(loc).toMatchObject({
      ts: 10.5,
      signal: "peak_frame",
      anchorReason: "frame_attestation",
      evidenceTs: 10.5,
      deltaSec: 0,
    });
  });

  it("falls back to peak-audio when no frame signal qualifies and the peak agrees with the evidence", () => {
    const loc = localizeHighlightInstantVod(9.5, [], taps, 8);
    expect(loc).toMatchObject({
      ts: 10.5,
      signal: "peak_audio",
      anchorReason: "peak_audio_reaction",
      evidenceTs: 9.5,
      deltaSec: 1,
    });
  });

  it("falls back to the trigger when neither frame nor audio signal is present", () => {
    const loc = localizeHighlightInstantVod(9.5, undefined, undefined, 8);
    expect(loc).toMatchObject({
      ts: 9.5,
      signal: "trigger",
      anchorReason: "trigger_evidence",
      evidenceTs: 9.5,
      deltaSec: 0,
    });
  });
});

describe("localizeHighlightInstantVod — evidence anchoring (ADAAAA-7845)", () => {
  /** 100 ms taps for an 8 s lookahead. `shape` fills the window; the peak tap is
   * overwritten afterwards so the caller controls ratio + sustained fraction. */
  const buildTaps = (trigger: number, shape: number[], peak?: { at: number; rms: number }) => {
    const taps = shape.map((rms, i) => ({ ts: +(trigger + 0.1 * (i + 1)).toFixed(1), rms }));
    if (peak) {
      const idx = Math.round(peak.at * 10) - 1;
      taps[idx] = { ts: +(trigger + peak.at).toFixed(1), rms: peak.rms };
    }
    return taps;
  };
  // Continuous narration: a steady ~0.08 bed with a modest 0.13 swell 6.1 s in.
  // This is the dee44c2f shape (ratio 1.66, sustained 0.637).
  const narrationTaps = (trigger: number) => buildTaps(trigger, Array(80).fill(0.08), { at: 6.1, rms: 0.13 });
  // A crowd/react burst: a quiet bed with one short loud swell 3.4 s in
  // (ratio ~5, sustained ~0.06).
  const reactBurstTaps = (trigger: number) => {
    const shape = Array(80).fill(0.03);
    for (const i of [33, 34, 35, 36]) shape[i] = 0.11;
    return buildTaps(trigger, shape, { at: 3.4, rms: 0.16 });
  };

  it("anchors on the accepting evidence instant when a far peak is continuous narration (AC1)", () => {
    const loc = localizeHighlightInstantVod(117, [], narrationTaps(117), 8);
    expect(loc).toMatchObject({
      ts: 117,
      signal: "trigger",
      anchorReason: "peak_audio_far_rejected",
      evidenceTs: 117,
      deltaSec: 0,
    });
    // The far peak (123.1) is still reported in the assessment, so the reject is
    // auditable rather than silent.
    const burst = assessAudioBurst(narrationTaps(117), 117, 8);
    expect(burst?.peakTs).toBe(123.1);
    expect(burst?.isBurst).toBe(false);
  });

  it("caps a far crowd/react burst to the +/-2 s tolerance edge (no >2 s drift)", () => {
    const loc = localizeHighlightInstantVod(162, [], reactBurstTaps(162), 8);
    expect(loc).toMatchObject({
      ts: 164,
      signal: "peak_audio",
      anchorReason: "peak_audio_far_burst_capped",
      evidenceTs: 162,
      deltaSec: 2,
    });
    expect(Math.abs(loc.ts - loc.evidenceTs)).toBeLessThanOrEqual(PEAK_AUDIO_ANCHOR_TOLERANCE_S);
  });

  it("assessAudioBurst separates a narration bed from a short react swell", () => {
    const narration = assessAudioBurst(narrationTaps(100), 100, 8)!;
    const burst = assessAudioBurst(reactBurstTaps(100), 100, 8)!;
    expect(narration.isBurst).toBe(false);
    expect(narration.sustainedFraction).toBeGreaterThan(0.6);
    expect(burst.isBurst).toBe(true);
    expect(burst.peakToBaseline).toBeGreaterThan(AUDIO_BURST_MIN_PEAK_TO_BASELINE);
    expect(burst.sustainedFraction).toBeLessThan(0.2);
    expect(assessAudioBurst(undefined, 100, 8)).toBeUndefined();
    expect(assessAudioBurst([{ ts: 99, rms: 0.9 }], 100, 8)).toBeUndefined();
  });

  it("replays job dee44c2f's own tap windows: every accepted highlight anchors within 2 s (AC1/AC3)", () => {
    // Taps reconstructed from the job's own source with the same ffmpeg decode +
    // 100 ms chunking the VOD audio tap uses (vod-audio.ts / chunkPcmBytes). The
    // reconstruction is validated by reproducing ALL FIVE production
    // localizedTs values (123.1 / 153.6 / 165.6 / 183.1 / 190.6).
    const fixture = JSON.parse(
      readFileSync(join(__dirname, "fixtures", "vod-7845-audio-taps.json"), "utf8")
    ) as { windows: Record<string, { ts: number; rms: number }[]> };
    const production: Record<string, number> = { "117": 123.1, "153": 153.6, "162": 165.6, "180": 183.1, "189": 190.6 };
    const expected: Record<string, { ts: number; signal: string; anchorReason: string }> = {
      "117": { ts: 117, signal: "trigger", anchorReason: "peak_audio_far_rejected" },
      "153": { ts: 153.6, signal: "peak_audio", anchorReason: "peak_audio_reaction" },
      "162": { ts: 162, signal: "trigger", anchorReason: "peak_audio_far_rejected" },
      "180": { ts: 180, signal: "trigger", anchorReason: "peak_audio_far_rejected" },
      "189": { ts: 190.6, signal: "peak_audio", anchorReason: "peak_audio_reaction" },
    };
    for (const [triggerKey, taps] of Object.entries(fixture.windows)) {
      const trigger = Number(triggerKey);
      // Reproduction check: the un-guarded peak-audio picker still lands on the
      // value production persisted, so these taps are the job's own taps.
      expect(localizeHighlightInstant(trigger, taps, 8).ts).toBe(production[triggerKey]);
      const loc = localizeHighlightInstantVod(trigger, [], taps, 8);
      expect({ ts: loc.ts, signal: loc.signal, anchorReason: loc.anchorReason }).toEqual(expected[triggerKey]);
      expect(Math.abs(loc.ts - loc.evidenceTs)).toBeLessThanOrEqual(2);
      // +/-7/+8 s padding and the 15 s length are unchanged.
      const win = clipWindow(loc.ts, 7, 8, 15);
      expect(win.end - win.start).toBe(15);
      expect(loc.ts - win.start).toBe(7);
    }
  });
});

describe("acceptVideoDecision frame-localized record (ADAAAA-7253 / ACC-3)", () => {
  const seedCfg = {
    jobId: "job-1",
    confirmEnabled: false,
    clipBeforeS: 7,
    clipAfterS: 8,
    clipWindowMinSec: 15,
  } as unknown as AnalyzerConfig;

  it("records localizeSignal=peak_frame and localizedTs on the highlight, with no new decide/confirm call", async () => {
    const run = new LiveRunShared({ goalBurstWindowS: 30 });
    let cutTs: number | undefined;
    const cut = async (ts: number) => {
      cutTs = ts;
      return { clipId: "clip-1", clipUri: "uri-1" };
    };
    // Any decide/confirm invocation would throw — proves the frame-based accept
    // path makes NO new decide/inference call (Acc-6).
    const client = {
      decide: () => {
        throw new Error("decide should NOT be called during frame-based accept");
      },
      confirm: () => {
        throw new Error("confirm should NOT be called when confirmEnabled=false");
      },
    } as any;

    const frameSignals: LocalizeFrameInput[] = [
      { ts: 10.6, signal: { scoreBoardChanged: true } },
      { ts: 11.4, signal: { ballInNet: true } }, // peak
      { ts: 12.0, signal: { goalCrossed: true } },
    ];

    await acceptVideoDecision(
      client,
      run,
      cut,
      seedCfg,
      undefined,
      { seq: 1, timestamp: 10.0 },
      { eventType: "GOAL", timestamp: 10.0 },
      { isHighlight: true, outcome: "scoring_play", score: 88 },
      frameSignals
    );

    expect(cutTs).toBe(11.4);
    expect(run.highlights).toHaveLength(1);
    const rec = run.highlights[0];
    expect(rec.localizedTs).toBe(11.4);
    expect(rec.localizeSignal).toBe("peak_frame");
    // The delivered clip is centered on the localized instant (ACC-2 centering).
    expect(rec.start).toBe(11.4 - 7);
    expect(rec.end).toBe(11.4 + 8);
  });

  it("falls back to the trigger signal on the record when no frame signal is present", async () => {
    const run = new LiveRunShared({ goalBurstWindowS: 30 });
    const cut = async () => ({ clipId: "clip-1", clipUri: "uri-1" });
    const client = {} as any;

    await acceptVideoDecision(
      client,
      run,
      cut,
      seedCfg,
      undefined,
      { seq: 1, timestamp: 42.0 },
      { eventType: "GOAL", timestamp: 42.0 },
      { isHighlight: true, outcome: "scoring_play", score: 90 }
    );

    expect(run.highlights).toHaveLength(1);
    const rec = run.highlights[0];
    expect(rec.localizeSignal).toBe("trigger");
    expect(rec.localizedTs).toBe(42.0);
  });

  it("persists the anchor reason, evidence instant and delta, with no decide/confirm call (AC2/AC4)", async () => {
    const run = new LiveRunShared({ goalBurstWindowS: 30 });
    let cutTs: number | undefined;
    const cut = async (ts: number) => {
      cutTs = ts;
      return { clipId: "clip-1", clipUri: "uri-1" };
    };
    const client = {
      decide: () => {
        throw new Error("decide should NOT be called during localization");
      },
      confirm: () => {
        throw new Error("confirm should NOT be called when confirmEnabled=false");
      },
    } as any;
    // 100 ms taps decoded by rmsNormalized: a steady narration bed with a far
    // 0.13 swell +6.1 s after the trigger (the dee44c2f shape).
    const pcm = (amp: number) => {
      const b = Buffer.alloc(1600 * 2);
      for (let i = 0; i < 1600; i++) b.writeInt16LE(Math.round(amp * 32768), i * 2);
      return b.toString("base64");
    };
    const bed = pcm(0.08);
    const swell = pcm(0.13);
    for (let i = 1; i <= 80; i++) {
      const ts = +(117 + 0.1 * i).toFixed(1);
      run.addAudioChunk(ts, ts === 123.1 ? swell : bed);
    }

    await acceptVideoDecision(
      client,
      run,
      cut,
      seedCfg,
      undefined,
      { seq: 1, timestamp: 117 },
      { eventType: "GOAL", timestamp: 117 },
      { isHighlight: true, outcome: "scoring_play", score: 88 }
    );

    expect(run.highlights).toHaveLength(1);
    const rec = run.highlights[0];
    expect(cutTs).toBe(117);
    expect(rec.localizedTs).toBe(117);
    expect(rec.localizeSignal).toBe("trigger");
    expect(rec.localizeAnchorReason).toBe("peak_audio_far_rejected");
    expect(rec.localizeEvidenceTs).toBe(117);
    expect(rec.localizeAnchorDeltaSec).toBe(0);
    // Clip padding unchanged: 7 s before, 8 s after, 15 s total.
    expect(rec.start).toBe(110);
    expect(rec.end).toBe(125);
    expect(rec.clipWindowSec).toBe(15);
  });
});
