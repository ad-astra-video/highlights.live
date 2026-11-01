# Live window audio and the two clocks (ADAAAA-7671)

Every analysis window on the LIVE path must carry the audio of the moment it
analyzes: `analysis.audio.path = "asr_text"` with a usable transcript, plus a
non-empty `analysis.audioSeries` so the AUDIO energy graph renders. Before
ADAAAA-7671 only the FIRST window of a live job carried audio (measured 1/9, 1/7
and 1/17 windows) even though ASR itself was healthy.

## Why it broke: two independent clocks

The live pass has two rails that feed the same window:

- **video rail** — `LiveIngest.frames()` yields frames tagged
  `timestamp = seq / sampleFps`. That is the *pipeline's content position*: how
  much content the decide-observer has actually processed. It is NOT real time.
- **audio rail** — the Stage-A tap (`LiveIngest.audioChunks()`) timestamps each
  ~100 ms PCM chunk from the bytes it has decoded, i.e. real (stream) time.

On a loaded box the decide loop cannot keep up with the 3 s cadence: one decide
call costs ~8–13 s wall, so 3 s of content is decided ~15–20 s later. Measured on
job `11b90ebf` (2026-11-01): window `T+3s` was decided at wall +26 s and `T+42s`
at wall +242 s — the frame clock runs ~5.7x slower than the tap clock.

`LiveRunShared` used to prune the tap buffer relative to the **newest chunk**
(`ts - AUDIO_CLIP_KEEP_S`), i.e. the trailing seconds of REAL time. The audio the
current window needs (its content range, tens of seconds to minutes behind the
tap) had already been dropped, so `audioWindowB64()` returned `""` for every
window after the first. `setAudioSeries()` had the same shape for a second
reason: it REPLACED the array with perceive's latest ~1.7 s lookback snapshot,
which sat far past the lagging window's content time.

> ADAAAA-7676 bounds the two-clock gap itself: the live loop now drops stale
> frames once the content clock falls more than `LIVE_OBSERVE_LAG_BUDGET_S`
> (default 30 s) behind wall time, so the ratio quoted above is capped instead of
> growing without bound. See `docs/live-observe-lag.md`. Retention anchoring on
> the analysis position (rule 1 below) still holds — a dropped frame simply does
> not advance it, and the window at the resynced position still finds its slice.

## The invariant

1. **Retention is anchored on the analysis position.** `addFrame()` advances
   `LiveRunShared.analysisPosTs`, and the tap audio (and the audio-gate series)
   are pruned back `audioRetainS` seconds from THAT, not from the newest chunk.
   A hard cap (`AUDIO_BUFFER_MAX_S`, 240 s) bounds memory when the tap races far
   ahead of a stalled pipeline, and never undercuts a configured retention, so
   the VOD full-timeline retain is unchanged.
2. **The live retention window is 20 s** (`LIVE_AUDIO_RETAIN_S`): a live window is
   the trailing `LIVE_OBSERVE_WINDOW_S` (10 s) plus `AUDIO_WINDOW_MARGIN_S` (2 s)
   on each side, so the old 10 s clipped the window's own head.
3. **The audio-gate series accumulates over content time** (merge by `t`, pruned
   against the same anchor, point-capped), so a window far behind the tap still
   finds its energy series.
4. **`audioClipB64()` stays bounded to `AUDIO_CLIP_KEEP_S`** (10 s) regardless of
   retention, so a longer live retention can never inflate the Stage-2 confirm
   payload into a multi-minute WAV.
5. **VOD slicing is untouched**: the VOD tap decodes the whole file ahead of the
   video pass and retains the full (capped) timeline; only retention pruning
   changed shape, and its anchor is never tighter than the configured retain.

Live is *intended* to attach audio to EVERY analysis window, not only
trigger-anchored ones; a window with genuinely silent audio still stays
text-only (`audio.path = "none"`), which is the existing decide guard.

## Verifying on a deployed image

Each live window logs one line (mirrors the VOD `[vod-audio:<job>]` line):

```
[live-audio:<job>] decide @4.67s tapChunks=406 tap=[0.10..40.60] pos=4.67 prePost=6.7/2.0 audioB64Len=281660 levels=48 series=66
```

- `tap=[from..to]` — the buffered tap audio's content-time span.
- `pos` — the video rail's analysis position (window content time).
- `audioB64Len` — the window slice actually shipped to ASR (>0 means the window
  carried audio). Pre-fix this was `0` for every window whose `pos` lagged the
  tap by more than the retention window.
- `series` — inspection-series points inside the window.

Cross-check the ASR side: `docker logs highlights-asr | grep '\[asr\] bytes='`
must show a real payload (`secs=` matching the slice, a non-zero `rms=`) for the
same instant.
