import { describe, expect, it } from "vitest";
import {
  BITRATE_RATIO,
  FRESHNESS_SECONDS,
  HEALTH_SAMPLE_MS,
  HOLD_SAMPLES,
  NOMINAL_CAPTURE_KBPS,
  QUALITY_THRESHOLDS,
  applyVerdict,
  bitrateFromCounters,
  foldSample,
  healthChips,
  initialHealthState,
  parseRtcStats,
  rateBitrate,
  rateFreshness,
  rateLink,
  rateQuality,
  type ChipState,
  type HealthState,
  type RtcSample,
} from "./streamHealth";

// ADAAAA-7730 (Inc 2 of ADAAAA-7726). AC2 is the core proof here: every
// threshold in the spec table is exercised just-under / exactly-at / just-over,
// and the hysteresis reducer is proven to hold a verdict until HOLD_SAMPLES
// consecutive breaching samples, so one blip never turns a chip red.

const chip = (verdict: ChipState["verdict"], streak = 0): ChipState => ({ verdict, streak });

describe("chip 2 — quality thresholds (spec table)", () => {
  it("RTT: 149 good / 150 good / 151 degraded, 299 degraded / 300 degraded / 301 poor", () => {
    expect(QUALITY_THRESHOLDS.good.rttMs).toBe(150);
    expect(QUALITY_THRESHOLDS.degraded.rttMs).toBe(300);
    const q = (rttMs: number) => rateQuality({ rttMs, lossPct: null, jitterMs: null });
    expect(q(149)).toBe("good");
    expect(q(150)).toBe("good");
    expect(q(151)).toBe("degraded");
    expect(q(299)).toBe("degraded");
    expect(q(300)).toBe("degraded");
    expect(q(301)).toBe("poor");
  });

  it("loss: 0.99 % good / 1 % good / 1.01 % degraded, 4.99 / 5 degraded, 5.01 poor", () => {
    const q = (lossPct: number) => rateQuality({ rttMs: null, lossPct, jitterMs: null });
    expect(q(0.99)).toBe("good");
    expect(q(1)).toBe("good");
    expect(q(1.01)).toBe("degraded");
    expect(q(4.99)).toBe("degraded");
    expect(q(5)).toBe("degraded");
    expect(q(5.01)).toBe("poor");
  });

  it("jitter: 29 ms good / 30 ms good / 31 degraded, 59 / 60 degraded, 61 poor", () => {
    const q = (jitterMs: number) => rateQuality({ rttMs: null, lossPct: null, jitterMs });
    expect(q(29)).toBe("good");
    expect(q(30)).toBe("good");
    expect(q(31)).toBe("degraded");
    expect(q(59)).toBe("degraded");
    expect(q(60)).toBe("degraded");
    expect(q(61)).toBe("poor");
  });

  it("the worst measured metric decides; a missing metric is never a breach", () => {
    expect(rateQuality({ rttMs: 40, lossPct: 3, jitterMs: 10 })).toBe("degraded");
    expect(rateQuality({ rttMs: 40, lossPct: 0.2, jitterMs: 400 })).toBe("poor");
    expect(rateQuality({ rttMs: null, lossPct: null, jitterMs: null })).toBe("unknown");
  });
});

describe("chip 3 — bitrate bands (share of nominal target)", () => {
  it("80 % exactly good, 79.9 % degraded, 40 % exactly degraded, 39.9 % poor", () => {
    expect(BITRATE_RATIO.good).toBe(0.8);
    expect(BITRATE_RATIO.degraded).toBe(0.4);
    const target = 1000;
    expect(rateBitrate(800, target)).toBe("good");
    expect(rateBitrate(799, target)).toBe("degraded");
    expect(rateBitrate(400, target)).toBe("degraded");
    expect(rateBitrate(399, target)).toBe("poor");
  });

  it("falls back to the panel's capture nominal when getStats reports no target", () => {
    expect(NOMINAL_CAPTURE_KBPS).toBe(3000);
    expect(rateBitrate(2400)).toBe("good");
    expect(rateBitrate(2399)).toBe("degraded");
    expect(rateBitrate(null)).toBe("unknown");
  });
});

describe("chip 4 — detect freshness (seconds since last observation)", () => {
  it("2 s exactly good, 2.001 s degraded, 5 s exactly degraded, 5.001 s poor", () => {
    expect(FRESHNESS_SECONDS.good).toBe(2);
    expect(FRESHNESS_SECONDS.degraded).toBe(5);
    expect(rateFreshness(1999)).toBe("good");
    expect(rateFreshness(2000)).toBe("good");
    expect(rateFreshness(2001)).toBe("degraded");
    expect(rateFreshness(4999)).toBe("degraded");
    expect(rateFreshness(5000)).toBe("degraded");
    expect(rateFreshness(5001)).toBe("poor");
  });

  it("no reading yet stays unknown instead of a false poor", () => {
    expect(rateFreshness(null)).toBe("unknown");
    expect(rateFreshness(Number.NaN)).toBe("unknown");
  });
});

describe("chip 1 — link state machine", () => {
  it("Live on either live rail, Reconnecting while pending, Offline on the ingest fallback", () => {
    expect(rateLink({ sharing: true, mode: "rtc", reconnectAttempt: 0 })).toEqual({ label: "Live", verdict: "good" });
    expect(rateLink({ sharing: true, mode: "ws", reconnectAttempt: 0 })).toEqual({ label: "Live", verdict: "good" });
    expect(rateLink({ sharing: true, mode: "pending", reconnectAttempt: 1 })).toEqual({ label: "Reconnecting", verdict: "degraded" });
    expect(rateLink({ sharing: true, mode: "pending", reconnectAttempt: 2 })).toEqual({ label: "Reconnecting", verdict: "degraded" });
    expect(rateLink({ sharing: true, mode: "ingest", reconnectAttempt: 6 })).toEqual({ label: "Offline", verdict: "poor" });
    expect(rateLink({ sharing: false, mode: "pending", reconnectAttempt: 0 })).toEqual({ label: "Paused", verdict: "unknown" });
  });
});

describe("hysteresis — a verdict holds until HOLD_SAMPLES consecutive breaches", () => {
  it("requires two consecutive breaching samples to be a constant", () => {
    expect(HOLD_SAMPLES).toBe(2);
  });

  it("a single-sample blip leaves the chip unchanged", () => {
    const held = applyVerdict(chip("good"), "poor");
    expect(held.verdict).toBe("good");
    expect(held.streak).toBe(1);
    expect(applyVerdict(held, "good").verdict).toBe("good");
  });

  it("two consecutive breaching samples flip the chip", () => {
    const once = applyVerdict(chip("good"), "poor");
    expect(applyVerdict(once, "poor").verdict).toBe("poor");
  });

  it("a matching sample resets the streak (good, poor, good, poor never flips)", () => {
    let s = chip("good");
    s = applyVerdict(s, "poor");
    s = applyVerdict(s, "good");
    expect(s).toEqual(chip("good", 0));
    s = applyVerdict(s, "poor");
    expect(s.verdict).toBe("good");
    expect(s.streak).toBe(1);
  });

  it("recovering also needs two consecutive samples", () => {
    const held = applyVerdict(chip("poor"), "good");
    expect(held.verdict).toBe("poor");
    expect(applyVerdict(held, "good").verdict).toBe("good");
  });

  it("degraded -> poor is still a breach of the held verdict", () => {
    const once = applyVerdict(chip("degraded"), "poor");
    expect(once.verdict).toBe("degraded");
    expect(applyVerdict(once, "poor").verdict).toBe("poor");
  });

  it("an unknown sample never changes a held verdict and clears the streak", () => {
    const afterBlip = applyVerdict(chip("good"), "poor");
    const unknown = applyVerdict(afterBlip, "unknown");
    expect(unknown).toEqual(chip("good", 0));
  });

  it("the first real reading adopts immediately (nothing to protect yet)", () => {
    expect(applyVerdict(chip("unknown"), "poor")).toEqual(chip("poor", 0));
  });

  it("foldSample applies the hold to every chip independently", () => {
    const start = initialHealthState();
    const once = foldSample(start, { link: "degraded", quality: "poor", bitrate: "poor", freshness: "good" });
    expect(once.link.verdict).toBe("degraded"); // adopted: first reading
    const twice = foldSample(once, { link: "good", quality: "good", bitrate: "poor", freshness: "poor" });
    expect(twice.link.verdict).toBe("degraded"); // one recovery sample: held
    expect(twice.quality.verdict).toBe("poor"); // one recovery sample: held
    expect(twice.bitrate.verdict).toBe("poor");
    const third = foldSample(twice, { link: "good", quality: "good", bitrate: "poor", freshness: "poor" });
    expect(third.link.verdict).toBe("good");
    expect(third.quality.verdict).toBe("good");
    expect(third.freshness.verdict).toBe("poor");
  });
});

describe("AC3 — freshness honesty when the SSE consumer stalls", () => {
  // Deterministic replay of the sampler: observations arrive every 1 s, then the
  // consumer pauses for 8 s from t=10 s, then resumes. Each line is one 2 s
  // sample — the same cadence and the same reducer the hook runs in the browser.
  const runTimeline = () => {
    const observations: number[] = [];
    for (let t = 0; t <= 10000; t += 1000) observations.push(t);
    for (let t = 18000; t <= 26000; t += 1000) observations.push(t);

    const lastObsAt = (t: number) => {
      let latest = -1;
      for (const o of observations) if (o <= t) latest = o;
      return latest;
    };

    const log: Array<{ t: string; ageMs: number; verdict: string; chip: string; changed: boolean }> = [];
    let freshness = chip("unknown");
    let previous = freshness.verdict;
    for (let t = 2000; t <= 26000; t += HEALTH_SAMPLE_MS) {
      const ageMs = lastObsAt(t) >= 0 ? t - lastObsAt(t) : Infinity;
      const raw = rateFreshness(ageMs);
      freshness = applyVerdict(freshness, raw);
      log.push({
        t: `${(t / 1000).toFixed(1)}s`,
        ageMs,
        verdict: raw,
        chip: String(freshness.verdict),
        changed: freshness.verdict !== previous,
      });
      previous = freshness.verdict;
    }
    return log;
  };

  it("the chip is Good, goes Poor when observations stop > 5 s, and recovers to Good", () => {
    const log = runTimeline();
    // Timestamped sample log — the AC3 evidence trail.
    for (const row of log) {
      // eslint-disable-next-line no-console
      console.log(
        `t=${row.t.padStart(6)} sample=${row.verdict.padEnd(9)} chip=${row.chip.padEnd(9)} age=${row.ageMs === Infinity ? "n/a" : `${(row.ageMs / 1000).toFixed(1)}s`}${row.changed ? "  <-- verdict changed" : ""}`
      );
    }

    const transitions = log.filter((r) => r.changed).map((r) => r.chip);
    expect(transitions).toEqual(["good", "poor", "good"]);

    // Poor only after 2 consecutive breaching samples, i.e. never before the
    // observation age actually exceeded 5 s.
    const firstPoor = log.find((r) => r.chip === "poor")!;
    expect(firstPoor.ageMs).toBeGreaterThan(FRESHNESS_SECONDS.degraded * 1000);
    // ...and no single stalled sample can produce it.
    const goodRun = log.slice(0, log.findIndex((r) => r.chip === "poor"));
    expect(goodRun.every((r) => r.chip === "good")).toBe(true);
  });

  it("the chip text carries the seconds since the last observation", () => {
    const state: HealthState = foldSample(initialHealthState(), {
      link: "good",
      quality: "good",
      bitrate: "good",
      freshness: "good",
    });
    const chips = healthChips({
      state,
      link: { label: "Live", verdict: "good" },
      bitrate: { kbps: 2500, targetKbps: 3000, width: 1920, height: 1080, fps: 30 },
      freshnessMs: 1200,
      activity: { clips: 2, detecting: true },
    });
    const fresh = chips.find((c) => c.id === "freshness")!;
    expect(fresh.value).toBe("Good");
    expect(fresh.detail).toBe("1.2 s ago");
  });
});

describe("getStats() reduction", () => {
  const report = (extra: Record<string, any>[] = []) => [
    {
      type: "outbound-rtp",
      kind: "video",
      bytesSent: 5_000_000,
      targetBitrate: 3_000_000,
      frameWidth: 1920,
      frameHeight: 1080,
      framesPerSecond: 30,
    },
    { type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.042 },
    { type: "remote-inbound-rtp", kind: "video", roundTripTime: 0.05, fractionLost: 0.02, jitter: 0.012 },
    ...extra,
  ];

  it("reads RTT (ms), loss (%), jitter (ms), byte counter, resolution and fps", () => {
    const s = parseRtcStats(report(), 1000);
    expect(s.rttMs).toBeCloseTo(42, 5);
    expect(s.lossPct).toBeCloseTo(2, 5);
    expect(s.jitterMs).toBeCloseTo(12, 5);
    expect(s.bytesSent).toBe(5_000_000);
    expect(s.targetKbps).toBe(3000);
    expect(s.width).toBe(1920);
    expect(s.height).toBe(1080);
    expect(s.fps).toBe(30);
  });

  it("falls back to inbound-rtp loss/jitter and remote RTT when the preferred rows are absent", () => {
    const s = parseRtcStats(
      [
        { type: "outbound-rtp", kind: "video", bytesSent: 1000 },
        { type: "remote-inbound-rtp", roundTripTime: 0.2 },
        { type: "inbound-rtp", kind: "video", packetsLost: 5, packetsReceived: 95, jitter: 0.03 },
      ],
      1000
    );
    expect(s.rttMs).toBeCloseTo(200, 5);
    expect(s.lossPct).toBeCloseTo(5, 5);
    expect(s.jitterMs).toBeCloseTo(30, 5);
    expect(s.targetKbps).toBeNull();
  });

  it("bitrate comes from the counter delta over the sample delta", () => {
    const first: RtcSample = parseRtcStats(report(), 1000);
    const second: RtcSample = parseRtcStats([{ ...report()[0], bytesSent: 5_625_000 }], 3000);
    const reading = bitrateFromCounters({ bytes: first.bytesSent!, atMs: first.atMs }, second)!;
    // 625 000 bytes over 2000 ms -> 2500 kbps
    expect(Math.round(reading.kbps)).toBe(2500);
    expect(reading.targetKbps).toBe(3000);
    expect(reading.width).toBe(1920);
  });

  it("no previous sample, a zero gap or a counter reset reads null (never a bogus 0 kbps)", () => {
    const sample = parseRtcStats(report(), 5000);
    expect(bitrateFromCounters(null, sample)).toBeNull();
    expect(bitrateFromCounters({ bytes: 1000, atMs: 5000 }, sample)).toBeNull();
    expect(bitrateFromCounters({ bytes: 9_000_000, atMs: 3000 }, sample)).toBeNull();
  });
});

describe("AC1/AC5 — the strip model is five chips and carries nothing internal", () => {
  it("always yields exactly the five spec chips, in order", () => {
    const chips = healthChips({
      state: initialHealthState(),
      link: rateLink({ sharing: true, mode: "ingest", reconnectAttempt: 6 }),
      bitrate: null,
      freshnessMs: 60_000,
      activity: { clips: 0, detecting: false },
    });
    expect(chips.map((c) => c.id)).toEqual(["link", "quality", "bitrate", "freshness", "activity"]);
    expect(chips.length).toBeLessThanOrEqual(5);
  });

  it("renders plain-language values only — no cost, session id, origin, url or pipeline counters", () => {
    const chips = healthChips({
      state: foldSample(initialHealthState(), { link: "good", quality: "good", bitrate: "good", freshness: "good" }),
      link: rateLink({ sharing: true, mode: "rtc", reconnectAttempt: 0 }),
      bitrate: { kbps: 2500, targetKbps: 3000, width: 1920, height: 1080, fps: 30 },
      freshnessMs: 800,
      activity: { clips: 3, detecting: true },
    });
    const text = chips.map((c) => `${c.label} ${c.value}${c.detail ? ` ${c.detail}` : ""}`).join(" | ");
    expect(text).toBe("Link Live | Quality Good | Bitrate 2500 kbps 1920×1080 30 fps | Detect Good 0.8 s ago | Clips 3 detecting");
    for (const forbidden of ["$", "costUsd", "mediaSessionId", "mediaOrigin", "wsUrl", "decide", "perceive", "observe", "seq", "slot", "accuracy"]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
