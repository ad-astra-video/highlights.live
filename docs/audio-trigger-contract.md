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
5. On the media RTC rail the media node relays the decoded anchor JPEG with each
   observation (`frameB64` on `POST /jobs/:id/observe`), so the control plane
   DOES own the pixels and the rail runs the same observer
   (`services/server/src/media-rail.ts` `MediaRailObserver`): the trigger is
   queued by `POST /jobs/:id/audio`, drained on the next relayed observation and
   fires ONE anchored window on the 'already paid-for' perceive session
   ([ADAAAA-7699](/ADAAAA/issues/ADAAAA-7699)). The trigger is still surfaced on
   the job SSE stream and counted on the media node
   (`/health` → `audio.triggerCandidates`).
   Anchored decide scheduling therefore runs on TWO rails: the server-side live
   ingest (`runLiveJob` → `LiveRunShared.recordAudioTrigger` → `LiveObserver`)
   and the media RTC rail (`/jobs/:id/audio` → `MediaRailObserver`), both only
   when the decide-observer is enabled (`liveObserveLoop` on). The client
   `/ingest` rail still never feeds a trigger to an observer, so no window is
   anchored there. The VOD pass feeds `recordAudioTrigger` since
   [ADAAAA-7694](/ADAAAA/issues/ADAAAA-7694) but only for MEASUREMENT (the
   Stage-A outcome ledger) — it never anchors a window, because a decoded VOD
   pass has no frame ahead of the decode to anchor to.
   See "Where the anchored-window count is observable" below before asserting a
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
only `"measured"` once a trigger has been judged by a decide window. Before
[ADAAAA-7694](/ADAAAA/issues/ADAAAA-7694) no production path called
`StageAMetrics.recordOutcome()`, so `"n/a"` was the value on every job; the
mapping is now implemented — see **Where a Stage-A outcome is recorded** below.

## Where a Stage-A outcome is recorded (ADAAAA-7694)

Under the observe architecture a fired Stage-A trigger no longer gets its own
`decide()` call: the observer decides on a cadence and the trigger is provenance
(plus, on the live rail, a window anchor). So a trigger has no verdict of its
own, and the honest outcome to persist is **the verdict of the decide window
that judges its onset**. That mapping is the recorded design decision:

> **Rule.** A Stage-A trigger's outcome is the verdict of the FIRST decide window
> whose evidence span contains the trigger's onset. `accepted = true` means that
> window cut a highlight; `accepted = false` means it judged the moment and cut
> none. `onsetLatencyS` from the trigger record is recorded with it, so the
> p50/p95 latency budget is measured on real gate samples.

It is implemented once, in `StageAOutcomeLedger`
(`services/server/src/stage-a-metrics.ts`), which both rails feed and both
observers write their verdicts into:

| rail | window span used as "judged" | who writes the verdict |
| --- | --- | --- |
| server live ingest (`LiveObserver`) | `[tickTs - observeWindowS, tickTs]` (rolling PAST) | `LiveObserver.fire()` after its decide returns |
| media RTC relay (`MediaRailObserver` → `LiveObserver`) | `[tickTs - observeWindowS, tickTs]` (rolling PAST, content clock rebased to the share start) | `LiveObserver.fire()` after its decide returns |
| VOD (`ObserveDecider`) | `[tickTs - observeWindowS/2, tickTs + observeWindowS/2]` (centred) | `ObserveDecider.fire()` after its decide returns |
| client `/ingest` | — | no observer owns the frames, so nothing is recorded (`"n/a"`, correct) |

Consequences you can rely on when reading a job:

- **One row per judged trigger, never per decide call.** A trigger is removed
  from the ledger when judged, so the overlapping windows that re-produce the
  same moment cannot re-count it. `totalCandidates` is therefore a count of
  audio events judged, not of decide invocations.
- **Coalesced re-fires are one event.** Two triggers whose onsets are closer
  than `AUDIO_TRIGGER_COALESCE_S` (2.5 s) are one audible event — the same rule
  the anchoring scheduler uses — so `totalCandidates` is a per-event count, not
  a per-chunk one. The tap's own `>= 1 candidate per burst` count is unchanged
  and stays the raw gate count.
- **A live trigger-anchored window judges its anchor.** The anchored trigger is
  judged explicitly even if the stream lagged far enough that its onset sits
  outside the trailing span; it is still counted once.
- **Unjudged is not rejected.** A trigger inside a window that was never decided
  (stale-frame drop, Tier-2 gate skip, past the stream tail) is dropped and
  never recorded. So `fpRate` can only be inflated by real decisions, and a
  gate-skipped window can neither lower nor raise it.
- **`"measured"` needs one judged trigger.** With `totalCandidates > 0` the job
  persists `stageAMetrics` + `stageAMetricsStatus: "measured"` and
  `job-counters.stageAMetricsForJob` stops deriving `"n/a"`; with none it stays
  `"n/a"` (no fabricated 0 % FP rate). The per-job evidence line
  `[live:<job>] / [vod:<job>] stageA fpRate=… (rejected/total rejected), latency
  mean/max=…, withinBudget=…` prints exactly when it is measured.
- **VOD measures, it does not anchor.** The VOD tap now feeds
  `LiveRunShared.recordAudioTrigger` so its fired triggers reach the ledger, but
  no VOD window is anchored to a trigger (the decode has no frame ahead of it) —
  the anchored-window table below is unchanged.

## The media (RTC / screen-share) rail decides (ADAAAA-7699)

A browser screen share takes the media rail (browser → media node → perceive over
WebRTC), not the control-plane `/ingest` rail. Until
[ADAAAA-7699](/ADAAAA/issues/ADAAAA-7699) that rail relayed observations and
surfaced audio triggers but never called `decide`, so a share produced
observations into nothing. The wiring is now:

1. **The anchor frame travels with the observation.** The media node already
   holds the decoded JPEG when it reads the runner's events-out
   (`services/media/src/server.ts` `publishAndObserve`); it attaches it as
   `frameB64` on the `POST /jobs/:id/observe` callback (size-bounded). The
   control plane strips it before stepping evidence or fanning the observation
   over SSE, so pixels never ride the console stream. No second session is
   opened to fetch frames, and the share is never routed back onto `/ingest`.
2. **`MediaRailObserver`** (`services/server/src/media-rail.ts`) records the
   frame + its perceive-derived seed into the same `LiveRunShared` /
   `LiveObserver` pair the RTMP rail uses, drains queued audio triggers (one
   anchored window each, coalesced), and fires on the cadence **or** the trigger
   anchor. Decides run on a serial chain, so the observe callback returns
   immediately and concurrent frames cannot double-fire the cadence.
3. **Content clock.** Frame/audio timestamps on this rail are wall-clock epoch
   seconds; the observer rebases everything to the first sampled moment so
   highlight windows (`start`/`end`) are share-relative and the stop path can cut
   clips from the recording.
4. **Clips are deferred, not skipped.** A highlight is persisted at decision
   time (with `clipUri: ""`) so the live feed updates during the share; the
   existing finalize path (`finishBrowserJob`) cuts every clip-less highlight
   from the browser recording once the share ends.
5. **Job record parity.** At share end the rail patches `decideCalls`,
   `observeMetrics` (same snapshot shape as a live RTMP job, incl.
   `triggerFires`/`cadenceFires`), `candidatesTriggered`/`candidatePath`
   (`observe`), `stageAMetrics*` when the audio gate judged something, and
   `perceiveSessionS`/`costUsd`. The decide fee is waived on the streaming
   session ([ADAAAA-5341](/ADAAAA/issues/ADAAAA-5341)): `canDecide(…,
   {streaming:true})` never 402s mid-share and `onDecideCompleted` meters at $0.
6. **No new GPU session.** The decide is a gemma call on the perceive session the
   media node already paid for; the rail never reserves one.

**A due trigger is never swallowed by a budget-refused tick.** The decide budget
is one token per `cadenceS` and an anchored fire spends the same token. The
observer now PEEKS a due trigger (`TriggerWindowScheduler.peekDue`) and consumes
it only once the budget gate passes, so a trigger that falls due while the budget
cannot afford the fire stays pending (bounded by the 8 s max-stale horizon) and
anchors the next affordable tick, instead of being popped and lost (`fired++`
with no decide).

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
| VOD (`file` / `url`) | no — the VOD tap feeds the level-curve series + bias hints and (ADAAAA-7694) the Stage-A outcome ledger; it never anchors a window | `job.vodObserveMetrics.decideCalls`; the VOD snapshot carries no trigger counter (the measured Stage-A rate is `job.stageAMetrics`) |
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
| `whistle` (Stage-A, pre-ADAAAA-7682) | corpus clip `9c09c609` | 2 | 0.00 (0/2) | 1.00 (5/5) | 0.20 s / 0.50 s |
| `whistle` (Stage-B, ADAAAA-7682) | 9 clips | 10 | 1.00 (10/10) | 0.00 (0/12) | 0.20 s / 0.20 s |
| `pa_announcement` | — | — | **N/A** | N/A | N/A |
| `music_bed` | — | — | **N/A** | N/A | N/A |

The Stage-A `whistle` row is the honest negative result that motivated the
second path: Stage-A is a **broadband level-change** detector, and a referee
whistle is a narrowband tonal burst whose RMS sits at the crowd floor
(2.4-3.4 kHz band energy 74x ambient while the speech and low bands stay flat),
so it produces no level anomaly to fire on. The Stage-B row is the band-limited
path documented below. `pa_announcement` and `music_bed` remain `N/A` because
the corpus has no footage for them (see the `gapReason` fields in the manifest).

AC1 is a **re-measurement** of this operating point on the media-relay path
against the real clips in hand, reported per class with explicit `N/A` where a
class has no footage. It is not a new detector and it is not gated on a new
labeled corpus.

## Stage-B: band-limited whistle path (ADAAAA-7682)

A referee whistle is a **trigger/boundary** class: it anchors a gemma analysis
window (stoppage / foul / offside, often *before* the crowd roar and on
free kicks / offside / VAR where the roar rail has no signal). It is not a
highlight finding class. Detection is pure DSP over the PCM chunks the media
relay and the server tap already decode — **0 added Livepeer GPU sessions**.

### Operating point

`WhistleConfig` in `services/perceive/app/audio_gate.py`:

| field | value | meaning |
| --- | --- | --- |
| `band_lo_hz` / `band_hi_hz` | 2400 / 3400 | the pea-whistle band |
| `sample_rate` | 16000 | production PCM on both rails |
| `lookback_s` | 6.0 | same rolling ambient percentile window as Stage-A |
| `baseline_percentile` | 0.55 | band-energy ambient baseline |
| `whistle_ratio` | **5.0** | band energy >= 5x the rolling band baseline |
| `sustain_frames` | 3 | consecutive elevated frames (~0.3 s at `frameS` 0.1) |
| `guard_max_ratio` | 3.0 | speech (0.3-2 kHz) and low (<0.3 kHz) bands must stay near ambient |
| `min_tonality` | 6.0 | band peak / band mean |
| `max_flatness` | 0.25 | spectral flatness inside the band (tonal vs broadband) |
| `cooldown_s` | 2.0 | same anti-storm rule as Stage-A |
| `emitted` | **true** | emit switch — a whistle fire becomes a scheduling candidate (see below) |

`thresholdId` is `stageB/whistle/2.4-3.4k/5x/0.3s`. The `kind` stays `"burst"`
so the frozen `AudioSignalSchema` in `packages/events` is unchanged; the two
paths are discriminated by the `thresholdId` family prefix (`stageA/` vs
`stageB/`). A later re-tune must change the id and this table together, so a
historical trigger can never be silently redefined.

**Emitting since ADAAAA-7707.** `process_audio()` runs both paths on every
chunk. A Stage-B fire is counted (`state.whistle_candidates`), logged, and
returned as a `whistle` block on the `/audio` response with `emitted: true` /
`measureOnly: false`. Since `emitted` is `true`, the fire ALSO becomes a
candidate event — same `AudioSignalSchema` shape as Stage-A, anchored on the
onset, discriminated by the `stageB/` `thresholdId` prefix — so it enters
candidate scheduling and each fire anchors one gemma analysis (ADAAAA-7705
Option 3). One candidate per chunk: a whistle fire takes the candidate slot on
the chunk it fires (its tone onset is also a Stage-A level rise and the whistle
is the more precise anchor); every other chunk keeps the Stage-A candidate
unchanged. The `whistle` block is returned in both cases, so the response stays
truthful about which path fired.

**Rollback — config only.** Flip `WhistleConfig.emitted` back to `False`. No
code revert, no logic redeploy: detection, reporting, `thresholdId`, guards and
the cooldown all stay as they are; the only change is that a fire stops being a
scheduling candidate, so the added gemma spend returns to $0. Both states are
asserted by `services/perceive/tests/test_audio_gate.py`
(`test_whistle_gate_ships_emitting_and_rolls_back_to_measure_only`,
`test_audio_route_emits_the_whistle_candidate`,
`test_audio_route_rollback_config_suppresses_the_whistle_candidate`) and the
deployed state is checked end-to-end by `evals/qa_whistle_live.py`.

### AC1 — sample-rate fidelity

The manifest decodes at `sr: 8000` (Nyquist 4000 Hz). Measured with
`evals/verify_whistle_onsets.py --compare-sr 8000` on all 10 whistle onsets, the
2.4-3.4 kHz band-energy rise differs by **0.0-0.3 %** between the 8 kHz and
16 kHz decode (the band sits below the 8 kHz Nyquist), i.e. inside the 10 %
tolerance — so the per-class override is **not required** by the AC's
conditional. It is set anyway (`"sr": 16000` on the whistle class, honoured at
`evals/measure_audio_recall.py` per class) because that is the rate production
PCM carries, and the whistle class is scored at it. **Scored at 16000 Hz.**

### AC3 — measured precision (the ship gate)

`evals/measure_audio_recall.py --labels evals/audio-labels.json --clip-root /data`
on the AC0 corpus (10 labelled onsets across 7 clips + 2 post-hoc verified clips,
27 negative windows, scored at 16 kHz):

| metric | gate | measured |
| --- | --- | --- |
| recall | >= 0.80 | **1.00 (10/10)** |
| trigger-window FP rate | <= 0.10 | **0.00 (0/12)** |
| negative-window FP rate | (AC0 FP denominator) | **0.00 (0/27)** |
| onset->fire p50 | <= 1.0 s | **0.20 s** |
| added trigger volume on `real_match_70s` | <= 2 candidates/min | **+0.0/min** (0 candidates / 70 s; Stage-A stays 11.1/min) |

All five gates pass, so the detector **ships**. AC3 is the gate for *shipping
the detector*; the emit switch is the separate PO call priced in AC5 — that call
is Option 3 on ADAAAA-7705, landed in ADAAAA-7707,
so the deployed path is **emitting** (see “Ships / emit call” below). Nothing
was bought with sensitivity — the operating point was swept (`whistle_ratio`
3-12 x `max_flatness` 0.12-0.35) and 5x/0.25 is the point that holds 10/10
recall at 0 FP; 6x drops recall to 0.80 and 3x adds FPs.

**Corpus corrections this measurement forced** (all verified independently by
`evals/verify_whistle_onsets.py`, not by the detector):

- `9c09c609` 15.5 s, `09dccf1b` 6.2 s and `02a5105d` 8.3 s / 12.3 s are
  referee whistles that the original survey missed (band rise 6.2x-10.1x,
  flatness 0.012-0.135, peak 2.49-3.15 kHz). They are recorded as
  `detectedOnsets`: a fire there counts as a true positive for FP accounting
  but **not** as recall, so the detector is never credited for points taken
  from its own output.
- Three "negative" windows contained those whistles and were removed (30 -> 27
  windows). A negative window is only a negative if it is verified clean.

### AC4 — no regression, and no mixed-evidence coalescing

`goal_roar` is unchanged at **0.88 (28/32) / FP 0.10 (2/21)** and Stage-A's
`thresholdId` (`stageA/burst/1.3x/0.3s`) is untouched; Stage-A was not re-tuned.

`services/server/src/audio-trigger.ts` now coalesces **per trigger family**
(`triggerFamily(thresholdId)` -> `stageA` / `stageB`). A whistle fire and a roar
fire inside one celebration are different evidence — the whistle marks the
stoppage even when the roar lands seconds later — so each keeps its own
anchored analysis instead of collapsing into one (the ADAAAA-6312 defect class).
Same-family re-fires still coalesce, so the anti-storm rule is unchanged.
Covered by `services/server/test/audio-trigger.test.ts` and
`services/perceive/tests/test_audio_gate.py`.

### AC5 — cost, stated

Detection and eval add **0 Livepeer GPU sessions**; the eval is CPU DSP
(ffmpeg + numpy). The cost that emit-behaviour would add is one gemma analysis
per candidate, priced at the current live-runner decide rate (~$0.01/decide):

- `real_match_70s` (ordinary match footage): 0 whistle candidates -> **$0.00
  added**.
- Whistle-dense corpus clips: 12 candidates over 179.5 s of footage =
  **4.01 candidates/min** -> ~**$0.0401/min (~$2.41/hr)** at the current
  live-runner decide rate (~$0.01/decide), on footage that is unrepresentative
  of ordinary play.

That worst case is the ceiling the PO accepted when graduating the path from
measure-only to emitting (Option 3).

### Ships / emit call (ADAAAA-7705 Option 3, landed ADAAAA-7707)

- **Detector: ships** — all AC3 gates pass on the AC0 corpus at 16 kHz.
- **Emit switch: EMITTING** — `WhistleConfig.emitted = True`. A whistle fire
  becomes a scheduling candidate, so the added gemma spend is the AC5 number
  below: **0.0 candidates/min on ordinary play (`real_match_70s`); dense-corpus
  ceiling 4.01 candidates/min ≈ $2.41/hr at ~$0.01/decide** (unrepresentative
  referee-whistle-heavy footage). The 0.00 trigger-window FP rate is what makes
  that spend defensible: cheap because whistles are rare, not because the
  detector is sloppy.
- **Rollback:** flip `emitted` back to `False` (config only, no code revert, no
  logic redeploy). Reporting stays intact and truthful (`emitted: false` /
  `measureOnly: true`); only the candidate emission stops.

### Wiring on the live rail (ADAAAA-7707)

The switch alone was not the graduation: `emitted = True` made the whistle ride
the generic `res.candidate` slot with no family identity at the server boundary,
so a whistle verdict was judged into `stageAMetrics` and no crowding counter
existed. The wiring that makes the anchor real:

- **The live loop consumes the `whistle` block explicitly** —
  `services/server/src/api.ts` (`runLiveJob` audio tap) reads `res.whistle` and
  builds the trigger through `audioTriggerFromWhistle` (`audio-trigger.ts`). The
  block WINS over the generic candidate on the same chunk (perceive puts the
  whistle in the candidate slot too, and the tone onset is also a Stage-A level
  rise; the whistle is the more precise anchor). One fire = one anchored window;
  the 2.5 s same-family coalesce remains the anti-storm bound.
- **Measure-only is inert.** `audioTriggerFromWhistle` returns null unless the
  block says `emitted: true` / `measureOnly: false`, so the rollback above needs
  no code change.
- **Live rail only.** The VOD tap records its triggers but does not anchor ahead
  of the decode, and the media/browser rail has no control-plane frame — the
  whistle → decide path is the live rail, which is the product case.
- **Family-aware ledgers.** `LiveRunShared.recordAudioTrigger` routes by
  `triggerFamily(thresholdId)`: `stageA/*` feeds `stageAMetrics` (unchanged),
  `stageB/*` feeds its own `StageAMetrics` + `StageAOutcomeLedger`, and the live
  observer judges a trigger in its family's ledger. A whistle fire — accepted or
  rejected — cannot move the published Stage-A `fpRate` / `totalCandidates` /
  `meanOnsetLatencyS`.
- **Crowding counters (ADAAAA-7713 tripwires).** The live job persists
  `observeMetrics.whistleFires` (whistle triggers scheduled), `whistleDecides`
  (decide windows a whistle anchored) and `whistleShare`
  (= `whistleDecides / decideCalls`), and the completion log prints
  `[live:<job>] stageB whistle fires=… decides=… share=…% decideCalls=… withinTripwire=…`.
  The hard tripwire is share > 25% (flip `emitted = False`, escalate to the
  ADAAAA-7713 decision record with the window's raw counts); added volume is the
  alert threshold (expected 0.0/min on ordinary play).
- **The family is READABLE after the run (ADAAAA-7722).** The tripwire needs the
  whistle decide to be identifiable once the stream is over, so three additive
  fields carry it:
  - `observeMetrics.allDecides` — the explicit denominator, equal to
    `decideCalls` by construction, so `whistleDecides / allDecides` is computable
    from two persisted counts;
  - `observeMetrics.whistleWindows[]` — one record per whistle-anchored decide
    (`{centerTs, thresholdId, family}`), the anchored window labelled with
    `stageB/whistle/2.4-3.4k/5x/0.3s`;
  - the durable `decide_audit` row for that window carries
    `params.triggerFamily` / `params.triggerThresholdId` (stamped server-side;
    the decide service's descriptor does not know how the window was scheduled).
  The completion line now prints both counts:
  `[live:<job>] stageB whistle fires=… decides=… share=…% decideCalls=… allDecides=… withinTripwire=…`.
- **`stageAMetrics` is whistle-free, proven.** Every rail passes the Stage-B
  ledger (`stageB`) into its decide observer (live, VOD `ObserveDecider`, media
  rail), so `judgeWindow` / `judgeTrigger` route a whistle onset into the whistle
  ledger only. `services/server/test/whistle-envelope.test.ts` asserts that a
  whistle fire leaves `stageA.snapshot()` **byte-identical** to the same run
  without it, and that a `stageA/burst/1.3x/0.3s` fire still moves it.
- **Live watch-minutes (ADAAAA-7722 AC3).** Each completed live session persists
  `job.liveWatchMinutes` — the rail's own session clock in minutes (live
  RTMP/file-sim: start→completion; browser/RTC: the media node's
  `sessionSeconds`). `GET /admin/live-watch-minutes?month=YYYY-MM` (UTC, default
  current month, admin read-only) returns `{month, liveWatchMinutes, sessions,
  unmeasuredSessions, perSession[]}` from the persisted records, so the
  ADAAAA-7713 envelope's monthly ceiling cites a measurement instead of a
  continuous-attachment assumption. VOD jobs are excluded (decode time is not
  watch time) and unmeasured sessions are reported, never counted as 0.
- **Tests:** `services/server/test/whistle-trigger.test.ts` pins the trigger
  build (including measure-only = nothing), the family-aware ledger, the
  one-fire-one-anchored-window rule and the persisted share counters.

## Eval corpus shape (ADAAAA-7682)

`evals/audio-labels.json` keeps one entry per trigger class. A class may now
carry:

- `gate`: `stageA` (default) or `whistle` (the Stage-B path).
- `sr`: per-class decode-rate override (`whistle` = 16000, production rate).
- `clips: [{clip, onsets, detectedOnsets}]`: several clips per class, each a
  separate stream scored on its own — fires from one clip can never "match" an
  onset in another.
- `negatives: [{clip, start, end}]`: windows decoded with a fresh gate for the
  false-positive rate; each must be verified free of the target sound.

`pa_announcement` and `music_bed` stay `null` with a `gapReason`; they are
recorded gaps, not passes, and are out of scope for this increment.
