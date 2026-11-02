// Customer stream-health strip: the pure logic (ADAAAA-7726 Inc 2 / ADAAAA-7730).
//
// The CEO saw media-server internals + cost figures on the customer app while
// screen sharing. Inc 1 (ADAAAA-7727) gated those behind an admin role; this
// strip is the ONE non-admin readout that replaces them: five plain-language
// chips computed only from data the browser already holds —
//
//   1 Link      the existing WS/WebRTC state machine (mode / reconnect count)
//   2 Quality   RTCPeerConnection.getStats(): RTT, loss ratio, jitter
//   3 Bitrate   getStats() byte counters + the capture resolution/fps
//   4 Detect    seconds since the last `observation` SSE frame
//   5 Activity  clips found this session (SSE `highlight`) + detecting state
//
// Nothing here is server-side, nothing here reads a gated field, and nothing
// here is a network call: `useStreamHealth` samples getStats() + in-memory
// state on ONE 2 s interval.
//
// Hysteresis: an indicator that cries wolf is worse than none. Every verdict is
// HOLD-sampled — a chip changes only after HOLD_SAMPLES consecutive breaching
// samples — so a single reconnect blip or one dropped RTT sample cannot turn a
// chip red. The first reading of a chip adopts immediately (there is no prior
// verdict to protect).

export type Verdict = "good" | "degraded" | "poor";
/** A chip with no usable sample yet. Never breaches, never hiders a verdict. */
export type ChipVerdict = Verdict | "unknown";
export type Tone = "ok" | "warn" | "bad" | "muted";

/** Consecutive breaching samples required before a chip changes verdict. */
export const HOLD_SAMPLES = 2;
/** The one and only sampling cadence for the strip. */
export const HEALTH_SAMPLE_MS = 2000;

/** Quality thresholds (spec table, chip 2). `good` is inclusive, `degraded` is
 * the upper inclusive bound of the middle band, and anything beyond is poor. */
export const QUALITY_THRESHOLDS = {
  good: { rttMs: 150, lossPct: 1, jitterMs: 30 },
  degraded: { rttMs: 300, lossPct: 5, jitterMs: 60 },
} as const;

/** Bitrate bands as a share of the nominal capture target (spec, chip 3). */
export const BITRATE_RATIO = { good: 0.8, degraded: 0.4 } as const;

/** Nominal capture target used when getStats() reports no `targetBitrate`.
 * A screen share in this panel is encoded at the panel's capture nominal of
 * 3 Mbps, so "80 % of nominal" is measured against that. */
export const NOMINAL_CAPTURE_KBPS = 3000;

/** Detect-freshness bands in seconds (spec, chip 4). */
export const FRESHNESS_SECONDS = { good: 2, degraded: 5 } as const;

// --- thresholds -------------------------------------------------------------

export interface QualitySample {
  rttMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
}

function band(value: number, goodMax: number, degradedMax: number): Verdict {
  if (value <= goodMax) return "good";
  if (value <= degradedMax) return "degraded";
  return "poor";
}

function worst(levels: Verdict[]): Verdict {
  if (levels.includes("poor")) return "poor";
  if (levels.includes("degraded")) return "degraded";
  return "good";
}

function usable(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Chip 2 verdict: the WORST measured metric decides. A metric the peer did not
 * report is skipped (never treated as a breach); all-missing reads `unknown`. */
export function rateQuality(sample: QualitySample): ChipVerdict {
  const levels: Verdict[] = [];
  if (usable(sample.rttMs)) levels.push(band(sample.rttMs, QUALITY_THRESHOLDS.good.rttMs, QUALITY_THRESHOLDS.degraded.rttMs));
  if (usable(sample.lossPct)) levels.push(band(sample.lossPct, QUALITY_THRESHOLDS.good.lossPct, QUALITY_THRESHOLDS.degraded.lossPct));
  if (usable(sample.jitterMs)) levels.push(band(sample.jitterMs, QUALITY_THRESHOLDS.good.jitterMs, QUALITY_THRESHOLDS.degraded.jitterMs));
  if (levels.length === 0) return "unknown";
  return worst(levels);
}

/** Chip 3 verdict: measured kbps as a share of the nominal target. */
export function rateBitrate(kbps: number | null, targetKbps: number = NOMINAL_CAPTURE_KBPS): ChipVerdict {
  if (!usable(kbps) || !usable(targetKbps) || targetKbps <= 0) return "unknown";
  const ratio = kbps / targetKbps;
  if (ratio >= BITRATE_RATIO.good) return "good";
  if (ratio >= BITRATE_RATIO.degraded) return "degraded";
  return "poor";
}

/** Chip 4 verdict: seconds since the last observation. `null` (no observation
 * yet, or the age is unusable) reads `unknown` rather than a false "poor". */
export function rateFreshness(ageMs: number | null): ChipVerdict {
  if (!usable(ageMs) || ageMs < 0) return "unknown";
  const seconds = ageMs / 1000;
  if (seconds <= FRESHNESS_SECONDS.good) return "good";
  if (seconds <= FRESHNESS_SECONDS.degraded) return "degraded";
  return "poor";
}

// --- chip 1: link -----------------------------------------------------------

export type LinkMode = "rtc" | "ws" | "ingest" | "pending";
export type LinkLabel = "Live" | "Reconnecting" | "Paused" | "Offline";

export interface LinkInput {
  /** Is a share running right now? */
  sharing: boolean;
  /** The capture panel's `modeRef`: rtc | ws | ingest | pending. */
  mode: LinkMode;
  /** `rcRef`: consecutive reconnect attempts. */
  reconnectAttempt: number;
}

export interface LinkVerdict {
  label: LinkLabel;
  verdict: ChipVerdict;
}

/**
 * Chip 1. `rtc` and `ws` are both live rails to the media server, so both read
 * Live. "Fell back to the HTTP ingest rail" is the spec's poor bucket and reads
 * Offline: the live media link IS gone (the existing panel banner explains that
 * the share itself continues on the degraded rail). No label here is an
 * internal value.
 */
export function rateLink(input: LinkInput): LinkVerdict {
  if (!input.sharing) return { label: "Paused", verdict: "unknown" };
  if (input.mode === "rtc" || input.mode === "ws") return { label: "Live", verdict: "good" };
  if (input.mode === "ingest") return { label: "Offline", verdict: "poor" };
  // pending: a reconnect is in flight (attempt 1..MAX_RECONNECT) or the first
  // provisioning round-trip has not resolved yet.
  return { label: "Reconnecting", verdict: "degraded" };
}

// --- hysteresis -------------------------------------------------------------

export interface ChipState {
  verdict: ChipVerdict;
  /** Consecutive samples that disagree with `verdict`. */
  streak: number;
}

export const IDLE_CHIP: ChipState = { verdict: "unknown", streak: 0 };

/**
 * Fold one raw verdict into a chip's held verdict.
 *
 * - `unknown` never changes the held verdict (a missing sample is not a breach).
 * - the first real reading of a chip adopts immediately.
 * - a differing verdict must repeat HOLD_SAMPLES times in a row before it wins.
 * - a sample matching the held verdict clears the streak, so "consecutive"
 *   really means consecutive (good, degraded, good, degraded never flips).
 */
export function applyVerdict(prev: ChipState, raw: ChipVerdict): ChipState {
  if (raw === "unknown") return { verdict: prev.verdict, streak: 0 };
  if (prev.verdict === "unknown") return { verdict: raw, streak: 0 };
  if (raw === prev.verdict) return { verdict: prev.verdict, streak: 0 };
  const streak = prev.streak + 1;
  if (streak >= HOLD_SAMPLES) return { verdict: raw, streak: 0 };
  return { verdict: prev.verdict, streak };
}

export interface HealthState {
  link: ChipState;
  quality: ChipState;
  bitrate: ChipState;
  freshness: ChipState;
}

export function initialHealthState(): HealthState {
  return { link: IDLE_CHIP, quality: IDLE_CHIP, bitrate: IDLE_CHIP, freshness: IDLE_CHIP };
}

export interface RawSample {
  link: ChipVerdict;
  quality: ChipVerdict;
  bitrate: ChipVerdict;
  freshness: ChipVerdict;
}

/** One sampling tick: every chip gets the same hold treatment. */
export function foldSample(prev: HealthState, raw: RawSample): HealthState {
  return {
    link: applyVerdict(prev.link, raw.link),
    quality: applyVerdict(prev.quality, raw.quality),
    bitrate: applyVerdict(prev.bitrate, raw.bitrate),
    freshness: applyVerdict(prev.freshness, raw.freshness),
  };
}

// --- getStats() reading -----------------------------------------------------

type StatsLike = Record<string, any>;

/**
 * The shapes a stats report arrives in: a real `RTCStatsReport` (maplike — it
 * yields `[id, stat]` pairs on iteration and exposes `values()`), or the plain
 * array of stat objects a mock/test hands over.
 */
export type RtcStatsSource = Iterable<StatsLike> | { values: () => Iterable<StatsLike> };

export interface RtcSample extends QualitySample {
  atMs: number;
  bytesSent: number | null;
  bytesReceived: number | null;
  targetKbps: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
}

function num(v: any): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Flatten any getStats() shape into the stat OBJECTS it carries.
 *
 * `RTCPeerConnection.getStats()` returns an `RTCStatsReport`, which is MAPLIKE:
 * plain iteration yields `[id, statObject]` pairs, so `entry.type` is
 * `undefined` for every row and every field stays null (ADAAAA-7731 — the
 * Quality and Bitrate chips read "—" for a whole live share because of exactly
 * this). Older callers/tests pass a plain array of stat objects, so both shapes
 * are accepted: prefer `values()` when the report exposes it, and unwrap an
 * `[id, stat]` pair defensively when it does not.
 */
function statObjects(stats: RtcStatsSource | null | undefined): StatsLike[] {
  if (!stats || typeof stats !== "object") return [];
  let entries: Iterable<unknown> = stats as Iterable<unknown>;
  const maybeValues = (stats as { values?: unknown }).values;
  if (typeof maybeValues === "function") {
    try {
      entries = (maybeValues as () => Iterable<unknown>).call(stats);
    } catch {
      entries = [];
    }
  }
  const out: StatsLike[] = [];
  for (const entry of entries) {
    if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string") {
      const stat = entry[1];
      if (stat && typeof stat === "object") out.push(stat as StatsLike);
      continue;
    }
    if (entry && typeof entry === "object") out.push(entry as StatsLike);
  }
  return out;
}

/**
 * Reduce an RTCPeerConnection.getStats() report to the handful of numbers the
 * strip needs. Pure, so the boundaries are unit-testable without a peer
 * connection. Accepts a real maplike `RTCStatsReport` as well as the plain
 * array of stat objects a mock hands over.
 */
export function parseRtcStats(stats: RtcStatsSource, atMs: number): RtcSample {
  let rttMs: number | null = null;
  let remoteRttMs: number | null = null;
  let lossPct: number | null = null;
  let remoteLossPct: number | null = null;
  let jitterMs: number | null = null;
  let bytesSent: number | null = null;
  let bytesReceived: number | null = null;
  let targetKbps: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let fps: number | null = null;

  for (const entry of statObjects(stats)) {
    if (!entry || typeof entry !== "object") continue;
    const type = entry.type;
    if (type === "candidate-pair") {
      // The nominated/succeeded pair carries the live path RTT.
      const selected = entry.nominated === true || entry.selected === true || entry.state === "succeeded";
      if (selected) {
        rttMs = num(entry.currentRoundTripTime) != null ? num(entry.currentRoundTripTime)! * 1000 : rttMs;
      }
    } else if (type === "remote-inbound-rtp") {
      // What the receiver reports back about our send: RTT + loss fraction.
      remoteRttMs = num(entry.roundTripTime) != null ? num(entry.roundTripTime)! * 1000 : remoteRttMs;
      remoteLossPct = num(entry.fractionLost) != null ? num(entry.fractionLost)! * 100 : remoteLossPct;
      if (num(entry.jitter) != null) jitterMs = num(entry.jitter)! * 1000;
    } else if (type === "inbound-rtp") {
      if (num(entry.jitter) != null && jitterMs == null) jitterMs = num(entry.jitter)! * 1000;
      const lost = num(entry.packetsLost);
      const received = num(entry.packetsReceived);
      if (lost != null && received != null && received + lost > 0) {
        lossPct = (lost / (received + lost)) * 100;
      }
      if (num(entry.bytesReceived) != null) bytesReceived = num(entry.bytesReceived);
    } else if (type === "outbound-rtp") {
      if (num(entry.bytesSent) != null) bytesSent = num(entry.bytesSent);
      if (num(entry.targetBitrate) != null) targetKbps = num(entry.targetBitrate)! / 1000;
      if (num(entry.frameWidth) != null) width = num(entry.frameWidth);
      if (num(entry.frameHeight) != null) height = num(entry.frameHeight);
      if (num(entry.framesPerSecond) != null) fps = num(entry.framesPerSecond);
    }
  }

  return {
    atMs,
    rttMs: rttMs ?? remoteRttMs,
    lossPct: remoteLossPct ?? lossPct,
    jitterMs,
    bytesSent,
    bytesReceived,
    targetKbps,
    width,
    height,
    fps,
  };
}

export interface BitrateReading {
  kbps: number;
  targetKbps: number;
  width: number | null;
  height: number | null;
  fps: number | null;
}

/**
 * kbps from two consecutive byte-counter readings. Needs the previous sample and
 * a positive time delta; otherwise the chip stays `unknown` instead of flashing
 * a bogus 0 kbps on the first tick or after a reconnect.
 */
export function bitrateFromCounters(prev: { bytes: number; atMs: number } | null, cur: RtcSample): BitrateReading | null {
  const bytes = cur.bytesSent ?? cur.bytesReceived;
  if (!prev || bytes == null) return null;
  const dtMs = cur.atMs - prev.atMs;
  if (!(dtMs > 0)) return null;
  const deltaBytes = bytes - prev.bytes;
  if (deltaBytes < 0) return null; // counters reset (peer renegotiated)
  const kbps = (deltaBytes * 8) / dtMs; // bits per ms == kbps
  const targetKbps = cur.targetKbps != null && cur.targetKbps > 0 ? cur.targetKbps : NOMINAL_CAPTURE_KBPS;
  return { kbps, targetKbps, width: cur.width, height: cur.height, fps: cur.fps };
}

// --- rendering model --------------------------------------------------------

export type ChipId = "link" | "quality" | "bitrate" | "freshness" | "activity";

export interface ChipView {
  id: ChipId;
  /** Plain-language chip name, e.g. "Quality". */
  label: string;
  /** The primary reading. */
  value: string;
  /** Optional secondary reading (ms / resolution / verdict word). */
  detail: string | null;
  tone: Tone;
}

const VERDICT_WORD: Record<ChipVerdict, string> = { good: "Good", degraded: "Degraded", poor: "Poor", unknown: "—" };
const VERDICT_TONE: Record<ChipVerdict, Tone> = { good: "ok", degraded: "warn", poor: "bad", unknown: "muted" };

export interface ActivityReading {
  clips: number;
  detecting: boolean;
}

export interface ChipInputs {
  state: HealthState;
  link: LinkVerdict;
  bitrate: BitrateReading | null;
  /** ms since the last observation frame, or null before/without one. */
  freshnessMs: number | null;
  activity: ActivityReading;
}

function round(v: number): number {
  return Math.round(v);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Build the five chip views. Always returns exactly five entries so the strip's
 * shape is stable sample to sample (and never more than five).
 */
export function healthChips(inputs: ChipInputs): ChipView[] {
  const { state, link, bitrate, freshnessMs, activity } = inputs;
  const quality: ChipView = {
    id: "quality",
    label: "Quality",
    value: VERDICT_WORD[state.quality.verdict],
    detail: null,
    tone: VERDICT_TONE[state.quality.verdict],
  };
  const bitrateChip: ChipView = {
    id: "bitrate",
    label: "Bitrate",
    value: bitrate ? `${round(bitrate.kbps)} kbps` : "—",
    detail: bitrate
      ? [bitrate.width != null && bitrate.height != null ? `${bitrate.width}×${bitrate.height}` : null, bitrate.fps != null ? `${round(bitrate.fps)} fps` : null]
          .filter(Boolean)
          .join(" ") || null
      : null,
    tone: VERDICT_TONE[state.bitrate.verdict],
  };
  const freshness: ChipView = {
    id: "freshness",
    label: "Detect",
    value: VERDICT_WORD[state.freshness.verdict],
    detail: freshnessMs != null ? `${seconds(freshnessMs)} ago` : null,
    tone: VERDICT_TONE[state.freshness.verdict],
  };
  return [
    { id: "link", label: "Link", value: link.label, detail: null, tone: VERDICT_TONE[state.link.verdict] },
    quality,
    bitrateChip,
    freshness,
    {
      id: "activity",
      label: "Clips",
      value: String(Math.max(0, activity.clips)),
      detail: activity.detecting ? "detecting" : "idle",
      tone: "muted",
    },
  ];
}
