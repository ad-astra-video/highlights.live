# Audio-noise trigger (shared detection contract)

Status: live increment [ADAAAA-7658](/ADAAAA/issues/ADAAAA-7658) · Option A approved
on [ADAAAA-7592](/ADAAAA/issues/ADAAAA-7592) (decision packet
`audio-trigger-decision` rev 2 §7, amendments A1–A4) · owner Developer.
Revised by [ADAAAA-7691](/ADAAAA/issues/ADAAAA-7691), which added the
tap-vs-counter sections below (tap candidates are event-only; refire at the tap
is cooldown-bounded while coalescing happens downstream) and made the
anchored-window count readable as `observeMetrics.triggerFires`.

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
   Anchored decide scheduling runs on **one** rail today: the server-side live
   ingest (`runLiveJob` → `LiveRunShared.recordAudioTrigger` → `LiveObserver`),
   and only when the live decide-observer is enabled (`liveObserveLoop` on with
   `decideWindowN` unset). The client `/ingest` rail and the VOD pass never call
   `recordAudioTrigger`, so no window is anchored to a trigger there — see
   "Where the anchored-window count is observable" below before asserting a
   window count on those rails.

## Tap candidates are evidence only (ADAAAA-7691 AC1)

`POST /jobs/:id/audio` (and the identical server-side and VOD taps) returns the
fired candidate to the caller and emits it on the job's SSE stream as a
`candidate` event. It writes **nothing** into the job's counters. Every counter
on the job record is produced by the decide/observe path
(`services/server/src/job-counters.ts`), never by the tap, so a tap-only feed
reads exactly this and it is **correct**:

```
candidatesTriggered 0 · candidates 0 · highlightsFound 0 · stageAMetricsStatus "n/a"
```

Read that as "the decide/observe path produced nothing", **not** as "the gate
never fired". A zero counter is never evidence of a silent gate.

Where tap candidates *are* observable:

| surface | what it counts | notes |
| --- | --- | --- |
| per-chunk response body | `{ candidate, series }` — `candidate` non-null exactly when the gate fired for that chunk | the authoritative tap count; carries the full record incl. `audio.thresholdId` |
| job SSE stream | `type: "candidate"` events | one per fired candidate; same record as the response |
| media node `GET /health` | `audio.triggerCandidates` (cumulative), with `audio.chunksPosted` / `audio.chunksDropped` | RTC-rail provenance; counts only, no ids on the public surface |

`stageAMetrics` / `stageAMetricsStatus` describe the **decide outcome** of
Stage-A candidates (accepted vs rejected by gemma), not the tap: the snapshot is
only `"measured"` once a candidate has been decided and recorded, and no
production path calls `StageAMetrics.recordOutcome()` today, so `"n/a"` is
currently the expected value on every job — see
[ADAAAA-7694](/ADAAAA/issues/ADAAAA-7694) for that separate defect.

## Cooldown-bounded refire at the tap vs ONE anchored window (ADAAAA-7691 AC2)

The two counts are different layers. Do not judge the anchored-window rule from
the `/audio` candidate count.

**Tap level — refire is bounded by the gate's cooldown, not by the coalescing
window.** `AudioEnergyGate._fire()` stamps `_last_fired_ts = firedAt` (the FIRE
time, not the onset) and `_in_cooldown()` suppresses any further fire while
`ts - _last_fired_ts < cooldown_s` (2.0 s). One sustained burst therefore emits
one candidate per `cooldown_s` of burst, each with its own onset. The window that
accumulates while suppressed keeps the *earliest* onset, so a refire's
`onsetLatencyS` climbs toward `cooldown_s`. Measured 2026-11-01 on one sustained
broadband burst:

| candidate | `ts` (onset) | `firedAt` | `onsetLatencyS` |
| --- | --- | --- | --- |
| 1 | 4.0 | 4.2 | 0.2 |
| 2 | 4.3 | 6.2 | 1.9 |

4.3 s sits inside the cooldown opened at the 4.2 s fire, and 6.2 s is exactly
`4.2 + cooldown_s`, so this is cooldown-bounded refire — not two audible events.
Tap candidate count for one burst is `>= 1` and grows with burst length; never
assert "one burst = one candidate".

**Downstream — coalescing makes it one anchored window.**
`LiveObserver.recordTrigger` → `TriggerWindowScheduler.record` drops a trigger
whose `|onsetTs - lastAcceptedOnset| < AUDIO_TRIGGER_COALESCE_S` (2.5 s) as
`coalesced`, so the 4.0 s and 4.3 s candidates above produce **one** scheduled
analysis, anchored at the earlier onset. A trigger whose `onset + AUDIO_TRIGGER_LEAD_S`
(1.0 s) is due fires the window and spends one cadence budget token (it may fire
early once 40% of a token has accrued; the balance is repaid before the next
cadence tick), so a trigger window replaces a cadence window instead of adding
one. The scheduler's
`accepted / coalesced / covered / expired / fired` tallies are **in-process only**
(`TriggerWindowScheduler.stats()`, surfaced as `LiveObserver.triggerStats()`);
they are not persisted, so a post-run reader cannot count coalesces.

### Where the anchored-window count is observable

| rail | anchored windows? | assert the window count from |
| --- | --- | --- |
| server live ingest (`rtmp` / `screen` / `file-sim`, live observe loop on) | yes | `job.observeMetrics.triggerFires`, with `cadenceFires`, on `GET /jobs/{id}` and `GET /jobs/{id}/detail`. Invariant: `triggerFires + cadenceFires == decideCalls`. |
| client `/ingest` rail (browser streams sampled frames) | no — frames arrive per chunk, no `TriggerWindowScheduler` | no anchored-window counter; judge the decide trail (`job.candidates` / detail `sections`) |
| VOD (`file` / `url`) | no — the VOD tap only feeds the level-curve series + bias hints; `recordAudioTrigger` is never called | `job.vodObserveMetrics.decideCalls`; the VOD snapshot carries no trigger counter |
| media RTC relay | no — the control plane owns no frame to anchor to | tap candidates only (`/health` → `audio.triggerCandidates`) |

QA recipe for "ONE anchored window" on the live rail:

1. Feed one sustained burst and count its tap candidates from the per-chunk
   response (or the SSE `candidate` events). Expect `>= 1`, spaced by roughly
   `cooldown_s` — that number is *not* the window count.
2. Read `GET /jobs/{id}` after the job completes and take
   `job.observeMetrics.triggerFires`. For one burst it must be `1` at most, and
   `triggerFires + cadenceFires` must equal `decideCalls`.
3. Treat a **missing** `triggerFires`/`cadenceFires` pair as "not recorded"
   (optional additive fields: records written before ADAAAA-7691 had them
   stripped out of the persisted snapshot), never as zero.


## Operating point (AC1 context, A3)

The gate's tuned operating point is defined by `GateConfig` in
`services/perceive/app/audio_gate.py`: rolling-percentile baseline over a
`lookback_s` (**6 s** since ADAAAA-7674, was 8 s) window, `burst_ratio` /
`swell_ratio` 1.3x, `burst_min_frames` 3 (~0.3 s), `swell_seconds` 2.5,
`cooldown_s` 2.0. The `thresholdId` on every record names the ratio and sustain
that fired, so a re-tune cannot silently redefine what a historical trigger was.

**ADAAAA-7674 re-tune (8 s -> 6 s ambient window).** At 8 s the frames of a roar
stay inside the baseline percentile window long enough that the next roar of the
same celebration wave is measured against a baseline that still contains the
previous one, so it never reaches 1.3x and the pair coalesces into a single fire.
Clearing a roar from the ambient window before the next one lands restores the
distinct fire **without changing the ratio, the sustain window or the
`thresholdId`** (`stageA/burst/1.3x/0.3s` unchanged, so historical records stay
comparable). Measured on `real_goal_3080` with `evals/measure_audio_recall.py`:
recall 0.78 (25/32) -> 0.88 (28/32), trigger-window FP rate 0.14 -> 0.10
(2/21), onset->fire p50/p95 unchanged at 0.20 s / 0.20 s, and cross-clip trigger
volume on `real_match_70s` unchanged (13 candidates / 70 s, 11.1/min) — i.e. the
recall was not bought with sensitivity.

The residual misses (4/32) have no usable acoustic onset: they sit in a
continuous loud crowd where the frame ratio never exceeds 1.31x for more than
one 0.1 s chunk, which no level-change gate can separate from the crowd.

## Per-class fidelity (ADAAAA-7674 AC1/AC2)

`evals/audio-labels.json` is the labeled corpus, one entry per trigger class;
`evals/measure_audio_recall.py --labels evals/audio-labels.json --clip-root /data`
prints the table. A class with `clip: null` is a recorded gap and prints `N/A` —
it is not a pass.

| class | clip | events | recall | FP rate | onset->fire p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| `goal_roar` | `real_goal_3080` | 32 | 0.88 (28/32) | 0.10 (2/21) | 0.20 s / 0.20 s |
| `whistle` | corpus clip `9c09c609` | 2 | 0.00 (0/2) | 1.00 (5/5) | 0.20 s / 0.50 s |
| `pa_announcement` | — | — | **N/A** | N/A | N/A |
| `music_bed` | — | — | **N/A** | N/A | N/A |

`whistle` is the honest negative result: the gate is a **broadband level-change**
detector, and a referee whistle is a narrowband tonal burst whose RMS sits at the
crowd floor (2.4-3.4 kHz band energy 74x ambient while the speech and low bands
stay flat), so it produces no level anomaly to fire on. Measuring the class
surfaced that; a whistle path would need a band-limited detector, which is not
this gate. `pa_announcement` and `music_bed` remain `N/A` because the corpus has
no footage for them (see the `gapReason` fields in the manifest).

AC1 is a **re-measurement** of this operating point on the media-relay path
against the real clips in hand, reported per class with explicit `N/A` where a
class has no footage. It is not a new detector and it is not gated on a new
labeled corpus.
