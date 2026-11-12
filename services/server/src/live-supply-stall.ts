// ADAAAA-8807: name the reason a live share STOPS supplying the decide rail.
//
// Measured on leg `3740585f` (2026-11-12, one nominal 600 s browser share on the
// served build): the rail decided 21 windows up to content t = 99.592 s and then
// produced ZERO for the remaining ~9 minutes of the share. The transport was
// healthy the whole time (`connectionState connected`, audio relayed to
// 601.89 s), the job stayed `active`, and the share's last server line was a
// confirm-pump line — nothing named the stall. Finding it took a DB read of
// `observeMetrics.perceive`: `framesSeen 190`, `analysedThroughTs 99.592`,
// `tapThroughTs 99.592` — i.e. the VIDEO supply died at 99.6 s while the served
// clock kept running, so the same record reads `liveWatchMinutes 11.818`
// (11.8 min "watched") beside a decide sample that stopped at 1.7 min.
//
// A decide window needs pixels: the rail cannot decide on content that never
// arrives, and skipping decides is correct. What was missing is the NAME. This
// watch compares the three clocks a share publishes against the SERVED clock and
// reports the first interval that outlives the threshold as ONE `stalled` event
// (plus ONE `recovered` event if the supply comes back), with the reason naming
// WHICH supply lane died:
//
//   - `no-observation-supply` — the media node keeps publishing frame ticks but
//     the relay delivers no observation, so nothing can be recorded/decided
//     (perceive runner or relay stall);
//   - `no-video-supply` — frames stopped while audio keeps flowing: the
//     publisher's VIDEO track died. This is leg `3740585f` exactly (298 encoded
//     frames = 3 fps for its first 100 s segment, audio intact to 601.9 s);
//   - `no-media-supply` — nothing at all is arriving (socket/publisher gone).
//
// No timer lives here: the rail polls `poll()` on its own interval, so every
// boundary is unit-testable with an injected clock and no sleeping.

/** Default threshold: how long a live share may go without a decide frame
 *  before the stall is named. The rail's own lag budget is 30 s (a window older
 *  than that is dropped as stale), and a browser share's session opens ~20-40 s
 *  before its first frame, so 60 s names a real stall without blaming a slow
 *  start. Wired from `LIVE_SUPPLY_STALL_S`. */
export const LIVE_SUPPLY_STALL_S = 60;

/** How recently audio must have arrived for a video stall to be attributed to
 *  the VIDEO track rather than to the whole transport. Half the default stall
 *  threshold: audio at ~10 chunks/s cannot look "recent" by accident. */
export const LIVE_SUPPLY_AUDIO_LIVE_S = 30;

/** Default poll cadence for the rail's supply watch (ms). The threshold is 60 s,
 *  so a 5 s tick names a stall within 5 s of it without any per-frame cost. */
export const LIVE_SUPPLY_STALL_POLL_MS = 5000;

/** Which supply lane the stall belongs to (see the module note). */
export type SupplyStallReason = "no-observation-supply" | "no-video-supply" | "no-media-supply";

/** One transition the rail logs and counts. */
export interface SupplyStallEvent {
  type: "stalled" | "recovered";
  reason: SupplyStallReason;
  /** Wall clock of the transition (ISO). */
  at: string;
  /** Served seconds since the rail started (the same clock the share bills on). */
  wallS: number;
  /** Seconds the decide supply had been frozen at the transition. */
  stallSeconds: number;
  /** Content clock of the newest decided frame when the supply froze. */
  contentTs: number;
  /** Content clock of the newest frame the media node PUBLISHED (0 = none). */
  tickTs: number;
  /** Content clock of the newest audio chunk relayed (0 = none). */
  audioTs: number;
  /** Decide frames (observations with pixels) the rail had taken. */
  frames: number;
}

/** The persisted summary (`observeMetrics.supplyStall`), so a stored share names
 *  its own stall instead of requiring a second read of `perceive`. */
export interface SupplyStallSnapshot {
  reason: SupplyStallReason;
  detectedAt: string;
  contentTs: number;
  tickTs: number;
  audioTs: number;
  /** Served seconds when the stall was detected. */
  wallS: number;
  /** Length of the CURRENT stall (0 once recovered). */
  stallSeconds: number;
  /** Whether the share was still stalled when this snapshot was read. */
  active: boolean;
  /** How many stall intervals this share had. */
  occurrences: number;
  /** Longest stall seen on this share (seconds). */
  longestStallSeconds: number;
  /** Content clock where the supply resumed (null = never recovered). */
  recoveredAtContentTs: number | null;
}

/** One detected stall interval, as the watch remembers it. */
interface StallRecord {
  reason: SupplyStallReason;
  detectedAt: string;
  /** Served ms the stall was detected at. */
  atMs: number;
  /** Served ms the supply had been frozen from (the last decide frame). */
  stallStartMs: number;
  contentTs: number;
  tickTs: number;
  audioTs: number;
  wallS: number;
  stallSeconds: number;
}

export interface SupplyStallWatchOptions {
  /** Frozen-supply threshold in seconds (default {@link LIVE_SUPPLY_STALL_S}). */
  stallS?: number;
  /** Audio recency window used to attribute `no-video-supply`. */
  audioLiveS?: number;
  /** Injected served clock (epoch ms); defaults to `Date.now`. */
  now?: () => number;
}

export class SupplyStallWatch {
  private readonly stallMs: number;
  private readonly audioLiveMs: number;
  private readonly now: () => number;
  private startedMs: number | null = null;
  /** Newest decide frame (observation with pixels) + the served ms it landed. */
  private lastObsTs = 0;
  private lastObsAtMs: number | null = null;
  /** Newest frame the media node published (a tick carries no pixels). */
  private lastTickTs = 0;
  private lastTickAtMs: number | null = null;
  /** Newest relayed audio chunk. */
  private lastAudioTs = 0;
  private lastAudioAtMs: number | null = null;
  private active: StallRecord | null = null;
  /** The LAST stall this share named, kept after recovery so the persisted
   *  snapshot still describes it (a recovered share must not read as healthy). */
  private last: StallRecord | null = null;
  private occurrences = 0;
  private longestStallSeconds = 0;
  private recoveredAtContentTs: number | null = null;

  constructor(opts: SupplyStallWatchOptions = {}) {
    const stallS =
      typeof opts.stallS === "number" && Number.isFinite(opts.stallS) && opts.stallS > 0
        ? opts.stallS
        : LIVE_SUPPLY_STALL_S;
    this.stallMs = stallS * 1000;
    const audioLiveS =
      typeof opts.audioLiveS === "number" && Number.isFinite(opts.audioLiveS) && opts.audioLiveS > 0
        ? opts.audioLiveS
        : Math.min(LIVE_SUPPLY_AUDIO_LIVE_S, stallS);
    this.audioLiveMs = audioLiveS * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** The threshold this watch names a stall at (seconds). */
  get stallS(): number {
    return this.stallMs / 1000;
  }

  /** Whether the supply is currently named as stalled. */
  get isStalled(): boolean {
    return this.active !== null;
  }

  /** Anchor the served clock. First write wins: a reconnect that reuses the rail
   *  must not restart the stall clock. Idempotent. */
  start(nowMs: number = this.now()): void {
    if (!Number.isFinite(nowMs) || this.startedMs !== null) return;
    this.startedMs = nowMs;
  }

  /** One DECIDE frame landed (an observation that carried pixels). Only these
   *  can clear a stall: a tick alone still cannot produce a decide window. */
  noteObservation(ts: number, nowMs: number = this.now()): void {
    if (!Number.isFinite(ts)) return;
    this.start(nowMs);
    if (this.lastObsAtMs === null || ts > this.lastObsTs) this.lastObsTs = ts;
    this.lastObsAtMs = nowMs;
  }

  /** One frame the media node published (publish clock; no determine pixels). */
  noteFrameTick(ts: number, nowMs: number = this.now()): void {
    if (!Number.isFinite(ts)) return;
    this.start(nowMs);
    if (this.lastTickAtMs === null || ts > this.lastTickTs) this.lastTickTs = ts;
    this.lastTickAtMs = nowMs;
  }

  /** One relayed audio chunk — the lane that keeps flowing when ONLY the video
   *  track has died (the attribution this ticket needed). */
  noteAudio(ts: number, nowMs: number = this.now()): void {
    if (!Number.isFinite(ts)) return;
    this.start(nowMs);
    if (this.lastAudioAtMs === null || ts > this.lastAudioTs) this.lastAudioTs = ts;
    this.lastAudioAtMs = nowMs;
  }

  /** Compare the clocks with the served clock and report a transition, if any. */
  poll(nowMs: number = this.now(), counters: { frames?: number } = {}): SupplyStallEvent | null {
    if (!Number.isFinite(nowMs)) return null;
    this.start(nowMs);
    const startedMs = this.startedMs as number;
    const wallS = Math.max(0, Number(((nowMs - startedMs) / 1000).toFixed(1)));
    const frames = Math.max(0, Math.floor(counters.frames ?? 0));

    if (this.active) {
      // Recovered as soon as a decide frame lands after the detection instant.
      if (this.lastObsAtMs !== null && this.lastObsAtMs > this.active.atMs) {
        const stallSeconds = Math.max(0, Number(((this.active.atMs - this.active.stallStartMs) / 1000).toFixed(1)));
        this.recoveredAtContentTs = this.lastObsTs;
        if (stallSeconds > this.longestStallSeconds) this.longestStallSeconds = stallSeconds;
        const ev: SupplyStallEvent = {
          type: "recovered",
          reason: this.active.reason,
          at: new Date(nowMs).toISOString(),
          wallS,
          stallSeconds,
          contentTs: this.lastObsTs,
          tickTs: this.lastTickTs,
          audioTs: this.lastAudioTs,
          frames,
        };
        this.active = null;
        return ev;
      }
      return null;
    }

    // The decide supply is "frozen" from the last decide frame; before the first
    // one it is frozen from the serve start (a share that never sends a frame is
    // a supply stall too, and the rail's 30-40 s warmup is inside the threshold).
    const frozenFromMs = this.lastObsAtMs ?? startedMs;
    const frozenMs = nowMs - frozenFromMs;
    if (frozenMs < this.stallMs) return null;

    const reason: SupplyStallReason =
      this.lastTickAtMs !== null && nowMs - this.lastTickAtMs < this.stallMs
        ? "no-observation-supply"
        : this.lastAudioAtMs !== null && nowMs - this.lastAudioAtMs < this.audioLiveMs
          ? "no-video-supply"
          : "no-media-supply";
    const stallSeconds = Math.max(0, Number((frozenMs / 1000).toFixed(1)));
    const record: StallRecord = {
      reason,
      detectedAt: new Date(nowMs).toISOString(),
      atMs: nowMs,
      stallStartMs: frozenFromMs,
      contentTs: this.lastObsTs,
      tickTs: this.lastTickTs,
      audioTs: this.lastAudioTs,
      wallS,
      stallSeconds,
    };
    this.active = record;
    this.last = record;
    this.occurrences += 1;
    if (stallSeconds > this.longestStallSeconds) this.longestStallSeconds = stallSeconds;
    return {
      type: "stalled",
      reason,
      at: new Date(nowMs).toISOString(),
      wallS,
      stallSeconds,
      contentTs: this.lastObsTs,
      tickTs: this.lastTickTs,
      audioTs: this.lastAudioTs,
      frames,
    };
  }

  /** The persisted summary; null until this share ever stalled (so a healthy
   *  share's record stays byte-identical to the shipped one). A RECOVERED share
   *  still reports its stall (`active: false` + `recoveredAtContentTs`): the
   *  serve clock it billed for outlived the content, and that must stay visible. */
  snapshot(nowMs?: number): SupplyStallSnapshot | null {
    if (this.occurrences === 0 || !this.last) return null;
    const a = this.last;
    const now = nowMs ?? this.now();
    const active = this.active !== null;
    const stallSeconds = active
      ? Number.isFinite(now)
        ? Math.max(0, Number(((now - a.stallStartMs) / 1000).toFixed(1)))
        : a.stallSeconds
      : a.stallSeconds;
    return {
      reason: a.reason,
      detectedAt: a.detectedAt,
      contentTs: Number(a.contentTs.toFixed(3)),
      tickTs: Number(a.tickTs.toFixed(3)),
      audioTs: Number(a.audioTs.toFixed(3)),
      wallS: a.wallS,
      stallSeconds,
      active,
      occurrences: this.occurrences,
      longestStallSeconds: Math.max(this.longestStallSeconds, stallSeconds),
      recoveredAtContentTs: this.recoveredAtContentTs,
    };
  }
}
