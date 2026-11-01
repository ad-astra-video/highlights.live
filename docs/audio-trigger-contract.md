# Audio-noise trigger (shared detection contract)

Status: live increment [ADAAAA-7658](/ADAAAA/issues/ADAAAA-7658) · Option A approved
on [ADAAAA-7592](/ADAAAA/issues/ADAAAA-7592) (decision packet
`audio-trigger-decision` rev 2 §7, amendments A1–A4) · owner Developer.

This document is the authoritative definition of an **audio trigger** — the
change/noise signal that anchors a gemma analysis window on the live path, and
the same record the VOD pass reads. It complements the tracked-object contract
in `docs/tracked-object.md`: that document defines what a *tracked object* is,
this one defines what a *trigger* is.

## The honest scope sentence (A4 — normative)

Option A puts an **audio-derived trigger signal** into the ingest loop; it does
**not** put audio frames there. The literal "audio frames pass to the frame
ingest loop" requirement stays unmet by design, because gemma is text-only on
decide (`GEMMA_SEND_AUDIO=0`) and raw audio in the worker buys nothing until a
stage needs the model to *hear*. Option B (an opus rail into the worker) is
parked as the VOD-detail milestone.

Do not re-read this contract as "audio frames now reach the ingest loop". What
reaches the ingest loop is a small typed record — kind, onset timestamp, fire
timestamp, onset latency, peak/baseline energy, threshold id — computed by DSP
at the media edge (and by the server's own tap on the non-RTC live path).

## The trigger record shape

Frozen in `packages/events/src/index.ts` as `AudioSignalSchema` (optional
`audio` field on `CandidateEvent`), camelCase on the wire:

| field            | type              | meaning                                                                 |
| ---------------- | ----------------- | ----------------------------------------------------------------------- |
| `kind`           | `"burst"` \| `"swell"` | which gate path fired: fast onset vs sustained rise                |
| `ts`             | number            | **onset** timestamp (seconds) of the energy change — the anchor         |
| `firedAt`        | number            | timestamp the gate actually fired (`>= ts`)                             |
| `onsetLatencyS`  | number (0..5)     | `firedAt - ts`; must fit the live 1–5 s latency budget                  |
| `peakEnergy`     | number (0..1)     | max RMS energy in the trigger window                                    |
| `baselineEnergy` | number (0..1)     | ambient/baseline energy at fire time (feeds the FP-rate metric)         |
| `thresholdId`    | string (optional) | the operating point that fired, e.g. `stageA/burst/1.3x/0.3s`           |

`services/server/src/audio-trigger.ts` normalizes a candidate's `audio` field
into `AudioTriggerRecord` (same fields; `thresholdId` defaults to
`stageA/<kind>` for pre-ADAAAA-7658 candidates that predate the field):
`audioTriggerFromCandidate(candidate)` → record | null. Invalid evidence
(missing/non-finite timestamps, latency outside 0–5 s) yields `null` and never
schedules an analysis.

**Clock rule:** `ts`/`firedAt` are seconds on the *rail's own* clock, and the
rail must use one clock for both its frames and its audio chunks or a trigger
cannot be anchored to a frame. The server live tap and the VOD tap use
stream-relative seconds (frame `timestamp = seq * sampleSec`); the media relay
uses wall-clock seconds because that is what its `video-in` frame timestamps
carry (`f.ts`). Both are internally consistent; do not mix them within a rail.

The gate itself lives in `services/perceive/app/audio_gate.py`
(`AudioEnergyGate`, ADAAAA-4325 + ADAAAA-4970 tune + ADAAAA-6312 baseline
normalization). Reuse it; do not write a second detector.

## Where a trigger comes from (both rails, one shape)

- **Media relay (RTC live path).** `services/media/src/rtc.ts` receives the
  browser's opus RTP; `services/media/src/audio-relay.ts` repages those packets
  into a live Ogg/Opus stream, decodes it with the ffmpeg already in the media
  image to mono 16 kHz int16 PCM, batches ~100 ms chunks, and POSTs
  `{seq, timestamp, samples}` (base64 PCM) to the control plane
  (`POST /jobs/:id/audio`), which forwards the chunk to perceive `POST /audio`
  on the **same** runner session id the `video-in` rail uses. No fourth trickle
  channel, no GPU, no new native dependency (A2).
- **Server tap (screen/rtmp/file live path + VOD).** `LiveIngest.audioChunks()`
  (`services/server/src/live.ts`) and `extractVodAudioChunks()`
  (`services/server/src/vod-audio.ts`) already POST the identical shape to
  perceive `POST /audio`. Unchanged by this increment.

Both rails therefore produce the same `AudioSignal` evidence, and both the live
and VOD passes read it through `packages/events` — that is the contract.

## What a trigger does (and does not) do

A trigger is **evidence and a schedule request, never a decision**:

1. Perceive `process_audio()` runs the DSP gate and returns/enqueues a
   `candidate` with the `AudioSignal` evidence. It bills no GPU.
2. The live decide observer (`services/server/src/observe-loop.ts`
   `LiveObserver.recordTrigger`) queues the trigger in a
   `TriggerWindowScheduler`. The scheduler **coalesces** triggers whose onsets
   are within `AUDIO_TRIGGER_COALESCE_S` (2.5 s) into ONE audible event, so one
   trigger produces one scheduled analysis — not a per-frame storm.
3. When a trigger's onset is at least `AUDIO_TRIGGER_LEAD_S` (1.0 s) old, the
   observer fires the assembled window anchored to that onset (`payload.trigger`
   carries the record). The trigger also rides the window's bias hints as
   `AUDIO_<KIND>` provenance.
4. Cost: every fire — cadence or trigger-anchored — spends one token of a
   one-token-per-`cadenceS` budget. Trigger windows therefore **replace**
   cadence ticks; decide invocations per stream-minute are unchanged or lower
   (0 added steady-state Livepeer GPU sessions, AC3). A trigger-anchored window
   is never skipped by the Tier-2 signal gate — a trigger *is* a signal.
5. On the media RTC rail the control plane owns no frame, so a trigger there is
   surfaced on the job SSE stream and counted on the media node
   (`/health` → `audio.triggerCandidates`); it does not by itself issue a decide.
   Anchored decide scheduling applies to the rails that own the frames (server
   live ingest and browser `/ingest`).

## Operating point (AC1 context, A3)

The gate's tuned operating point is defined by `GateConfig` in
`services/perceive/app/audio_gate.py`: rolling-percentile baseline over an
`lookback_s` (8 s) window, `burst_ratio`/`swell_ratio` 1.3x, `burst_min_frames`
3 (~0.3 s), `swell_seconds` 2.5, `cooldown_s` 2.0. The `thresholdId` on every
record names the ratio and sustain that fired, so a re-tune cannot silently
redefine what a historical trigger was.

AC1 is a **re-measurement** of this operating point on the media-relay path
against the real clips in hand (`evals/measure_audio_recall.py`,
`real_goal_3080` / `real_match_70s`), reported per class with explicit `N/A`
where a class has no footage. It is not a new detector and it is not gated on a
new labeled corpus.
