# Live decide payload: perceive timeline + ASR coverage (ADAAAA-8056)

Lever **B+e** (ratified on [ADAAAA-8047]): the live rail keeps fewer *pixels* per
decide without losing the window's temporal density. Perceive already produces a
per-frame view at 3 fps; this document describes the two additive payload parts
that carry it into the same single gemma call, plus the coverage ledgers a fresh
live leg is graded on.

Nothing here changes the window span (~10 s), the audio-noise-change trigger, the
`<=30`-frame ceiling, `maxDecideInFlight` 4, the VOD path, or the funded spend
ceiling. It is report-only instrumentation until the frame budget is set from the
ladder on [ADAAAA-8049].

## 1. `evidence.perceiveTimeline` (live rail only)

One compact record per **perceived frame in the window span**, ordered by `ts`.
The source is the window's full observation set, not the images the call ships
(ADAAAA-8064 — see §1a):

```json
{
  "ts": 12.66, "tracks": 3, "maxVelocity": 0.41,
  "objects": ["player", "ball"], "trackIds": ["t0", "ball"],
  "ocr": ["1-0"], "ballOutcome": "goal", "possession": "p12",
  "goalCrossed": true, "ballInNet": true, "scoreBoardChanged": true,
  "motionBurst": false
}
```

- Built by `buildPerceiveTimeline` (`services/server/src/analyzer.ts`) from the
  window's full observation set (`ObserveWindow.observedFrames`, pre image-cap);
  **one record per perceived frame**, so a ~10 s window at ~2.8 obs/s yields ~28
  records — independent of how many images the call ships. A payload with no
  observation set (VOD symmetric window, legacy stub) falls back to `seeds` and
  says so (`timelineSource: "seeds"`).
- Bounded to `DECIDE_MAX_PERCEIVE_RECORDS` (32) and clamped per field
  (`tracks` le=8, label/anchor lists bounded), mirroring the decide service's
  `Evidence.perceiveTimeline max_length=32`. The server clamps first, so decide
  never 422s the live loop (ADAAAA-7022 contract holds).
- A frame perceive never observed still yields a zero record (`tracks: 0`,
  `objects: []`) — that is how an empty timeline stays distinguishable from a
  missing one.
- Absent on the VOD rail: the enrichment is live-only, so the VOD request stays
  byte-identical.

### 1a. Source decoupling (ADAAAA-8064, ruling R1 of ADAAAA-8047 rev 3)

The first construction projected the timeline off the **image seeds**, so its
density was a function of the frame budget: 4 images -> 0.40 records/s over a
~10 s span, 12 images -> 1.20 records/s but decide p50 7 166 ms. That made AC-E1
(density) and AC-3 (latency) mutually exclusive. It was a **construction
defect**, not a frame-budget verdict.

- `assembleLiveWindow` (`services/server/src/observe-loop.ts`) now keeps the
  pre-cap in-window frame list (`observedFrames`, timestamps only — no image
  bytes) alongside the capped `frames` the call ships.
- `buildObservePayload` aligns that set to the perceive findings and puts it on
  the payload as `observations`; `buildObserveDecideRequest` builds the timeline
  from `observations`. Nothing new is inferred: the observations already exist.
- The VOD symmetric window (`assembleObserveWindow`) keeps no observation set, so
  the VOD payload is unchanged (AC-C5).

Per-window ledger, on `decide_audit.timings.perceiveTimeline` **and** mirrored in
`analysis.perceiveTimeline`:

| field | meaning |
|---|---|
| `timelineRecords` | timeline records built for this window |
| `observationsInSpan` | perceived frames inside the span (the timeline source) |
| `imageCount` | images the decide call actually carried |
| `imageGapMaxMs` | largest gap between consecutive shipped images |
| `recordsPerSecond` | `timelineRecords / spanS`; omitted when the window has < 2 observed frames (a 1-frame tick has no span) |
| `spanS` | observed span in content seconds (last - first) |
| `timelineSource` | `observations` \| `seeds` |

`timelineRecords == imageCount < observationsInSpan` on a row is a construction
regression (AC-C1). `imageGapMaxMs` is the honest imaging statement: ~3 s at a
4-image cap means the images are genuinely spread over the span, not that the
call has visual coverage every second.

### 1b. The RTC arm's observation set is the rail's publish clock (ADAAAA-8069)

The 8064 fix was correct on the **file-sim** rail and inert on the **media/RTC**
rail, which is the one that ships. Measured on job `8024a341` (media rail,
`kids300_7935.mp4`, `LIVE_OBSERVE_MAX_FRAMES=4`, 06:46-06:51Z): all 39
`decide_audit` rows read `timelineRecords == observationsInSpan == imageCount`
(4-ish), `recordsPerSecond` 0.22-1.30, `timelineSource=observations`.

Cause, with the accounting from that leg's media-node close line
(`[rtc] observe session=66072e42 seconds=302.8 published=848 delivered=93
expired=47 skipped=697 refused=0`):

- The media node's `ObservationRelay` follows the runner's `events-out` live
  edge and pairs a queued frame with the observation carrying its `seq`
  (`services/media/src/observe-relay.ts` `loopPush`). Every queued frame below
  the observed `seq` is abandoned as `skipped` — the runner fast-forwards on
  go-livepeer's live edge (`highlights-perceive` log:
  `fast-forward session=66072e42 ... skipped_total=607`), so those observations
  never exist.
- `MediaRailObserver.onObservation` (`services/server/src/media-rail.ts`)
  records a frame only for a **delivered** observation that carries an anchor
  JPEG, so `LiveObserver.frames` — and therefore 8064's `observedFrames` — was
  the delivered set. The "full observation set" was the image set again, and the
  timeline's density followed the image budget on the only rail that ships.

Fix (plumbing/construction only — image budget, ratio, span, cadence, keep ratio
and spend ceiling unchanged):

- `ObservationRelay` reports the clock of **every** frame it publishes
  (`onPublished`, before any observation pairing); the media node batches those
  to the new `POST /jobs/:id/media/frames` (~1 s batches).
- `MediaRailObserver.onFrameTick` feeds them to
  `LiveObserver.recordObservation`, and `assembleLiveWindow` unions that clock
  with the delivered frames into `observedFrames`. A tick carries no image, so it
  can never become a decide frame, fire the cadence or spend a decide token.
- An observation relayed **without** anchor pixels now also joins the
  observation set (with its findings) instead of being dropped outright.
- A frame perceive never observed is still a zero record (§1), which is how the
  timeline stays distinguishable from a missing one.

Expected shape at a 4-image cap: `timelineRecords > imageCount`,
`timelineRecords == observationsInSpan`, `recordsPerSecond` ≈ the rail's publish
rate (~2.8/s at 3 fps).

#### ADAAAA-8069 measured grades (media/RTC leg, build `821af33`, 4-image cell)

Job `74e34b22` (media rail, werift VP8 share, 176.2 s,
`LIVE_OBSERVE_MAX_FRAMES=4`; media session `24470b7f`:
`published=496 delivered=420 skipped=65`):

- 46 `decide_audit` rows, every one with a span; 46/46 `timelineRecords >
  imageCount` (imageCount 1-4, observationsInSpan 7-29).
- 46/46 `timelineRecords == observationsInSpan`; 46/46 `recordsPerSecond >= 1.0`
  (min 2.73, mean 2.95 — the rail's publish rate).
- `imageGapMaxMs` ~3.5 s at the 4-image cap: the honest imaging statement.
- 46/46 `timelineSource=observations`.

The pre-fix control is job `8024a341` on the same cell: 39/39 rows
`timelineRecords == imageCount`, `recordsPerSecond` 0.22-1.30.

### Prompt budget (AC-E3)

`render_perceive_timeline` (`services/decide/app/gemma.py`) renders the block into
the window prompt under `PERCEIVE_TIMELINE_MAX_CHARS = 3400` (ADAAAA-8064; it was
1000, which bound on every full-rate window and thinned records — silently undoing
the decoupling). When the budget binds, the ladder is: **scalars only** (drop
object labels / OCR anchors, keep `t`, `tracks`, `vel`, `ball`, `poss`, flags) and
only then **thinned** (fewer records, keeping those nearest the window center).
Records are never silently dropped; the compaction mode is reported per window.

Track ids are on the record but deliberately not rendered: eight ids per line
pushed every record past the ~120 chars/record the full-rate window budgets. The
ids stay joinable through `evidence.detections`.

A 28-29 record live window renders at ~90-110 chars/record (~2.5-3.2 KB ≈ 650-800
tokens), which fits the 3400-char budget without compaction. The delta against the
pre-enrichment prompt is what AC-C4 measures on the box.

### Inspector

The same block is mirrored as a `perceive_timeline` entry in the decision's
`analysis.dataItems`, so a decided window shows exactly the temporal evidence the
model was given, and `analysis.perceiveTimeline` carries the per-window ledger.

## 2. Trigger-nearest detection selection (the oldest-detections bug)

`buildObserveDecideRequest` used `detections.slice(0, DECIDE_MAX_DETECTIONS)` —
the FIRST 16 detections, i.e. the **oldest** frames of the window. On a 27-29-seed
window with several objects per frame that cut the tail where the goal happens.
`selectDecideDetections` now picks the frames **nearest the trigger instant**
(the audio trigger's `onsetTs`, else the window center), then emits the kept
detections chronologically. The `<=16` / `bbox <=4` / confidence clamps are
unchanged.

## 3. ASR coverage (`audioContext` + `decide_audit.timings`)

Every decide reports:

| field | meaning |
|---|---|
| `audioContext.path` | `input_audio` \| `asr_text` \| `none` |
| `audioContext.asrRan` | the ASR call actually ran |
| `audioContext.asrLatencyS` | its wall time |
| `audioContext.transcribed` | it produced text |
| `audioContext.windowAudioPresent` | the window carried ANY audio |
| `audioContext.noAudioReason` | `""` \| `no_audio_clip` \| `retention_gap` \| `audio_clip_disabled` \| `asr_unavailable` \| `audio_context_off` |

`retention_gap` means the tap had banked chunks but this window's clip fell
outside the retained span — not a silent stream. `audio_clip_disabled` means the
window clip was gated off the live payload (`LIVE_DECIDE_AUDIO_CLIP=0`, the
ADAAAA-7777 trim 2): the tap is fed and the level curve is computed, but no clip
reaches decide, so ASR cannot run. AC-E2 counts gated windows apart from
transcribed ones instead of blaming retention. Degradation is unchanged: an ASR
failure returns empty text and the decide runs text-only, never a 5xx.

The same coverage is stamped on the audit descriptor's `timings`, which the server
persists as the `decide_audit` row (`timings` is an existing JSON column — no
migration). It is computed *before* the gemma call, so the record appended to
`DECIDE_AUDIT_DIR/decide-audit.jsonl` on the decide box carries it too; a grade
can read either layer:

```json
{
  "elapsedMs": 4123.4,
  "asrLatencyS": 0.68,
  "perceiveTimeline": {"records": 28, "chars": 2810, "compacted": "none",
                       "seeds": 4, "withFindings": 28,
                       "timelineRecords": 28, "observationsInSpan": 28,
                       "imageCount": 4, "imageGapMaxMs": 3300,
                       "recordsPerSecond": 2.83, "spanS": 9.9,
                       "timelineSource": "observations"},
  "audioPath": "asr_text", "asrRan": true, "windowAudioPresent": true,
  "noAudioReason": "", "audioTapChunks": 4, "audioClipBytes": 48000
}
```

## 4. Grading a fresh live leg

- **The JSONL is container-local and dies with a recreate.** `DECIDE_AUDIT_DIR`
  (`/srv/decide/audit` on the box) is inside the decide image, not a mounted
  volume, and `decide` and `decide-b` each keep their own file. Any
  `docker compose up -d --build decide` — including a sibling ticket's deploy —
  starts an empty trail, and `highlights-asr`'s `[asr] done` lines die the same
  way. Copy the rows out of the container (or grade `decide_audit`) as soon as
  the leg ends. The file is append-only while the DB upserts on
  `(session_id, group_key)`, so a retried window shows twice in the file and once
  in the row: compare latest-per-group, never line counts.

- **AC-E2 precondition — the clip must be ON.** `AC-E2` is satisfiable only with
  `LIVE_DECIDE_AUDIO_CLIP=1` on the live payload (`docker/.env`, server env).
  With it at `0` the honest number is 0 % and every window is named
  `audio_clip_disabled`; that is a config posture, not an instrumentation bug, so
  a grade taken on `0` must read `not_captured` rather than `fail`. Flipping it
  puts a ~560-580 KB clip on every decide, and the ASR leg (~0.7-0.9 s p50,
  CPU-side) then rides the critical path — AC-E3's ON/OFF delta must cover
  enrichment **plus** ASR, not the text records alone.

- **AC-E1**: 100 % of decide rows carry `timings.perceiveTimeline.records >= 1`
  per ~1 s of span, and no row reports `records == 0` while
  `withFindings > 0`.
- **AC-E2**: 100 % of rows report `audioPath == "asr_text"`, `asrRan == true`; the
  rows that did not are counted and named by `noAudioReason`.
- **AC-E3**: same-cell A/B (≥3 distinct windows per side) — decide wall time with
  vs without the block. A delta > 0.5 s means compact further before any frame
  budget is raised.

### ADAAAA-8064 density-ledger grades (one live leg at 4 images)

- **AC-C1 (decoupling)**: ≥ 99 % of rows show
  `timelineRecords == observationsInSpan > imageCount`. A row with
  `timelineRecords == imageCount < observationsInSpan` is a FAIL of the
  construction fix.
- **AC-C2 (coverage)**: `recordsPerSecond >= 1.0` on 100 % of rows (~2.8 expected
  at a ~10 s span), and 0 rows with an empty timeline while
  `observationsInSpan > 0`.
- **AC-C3 (honest imaging)**: `imageGapMaxMs` present on every row and ~3.0 s at a
  4-image cap. A sub-0.9 s value at 4 images is a recording bug, not a win.
- **AC-C4 (no latency regression)**: same-cell decide wall time vs the 4-image
  baseline (p50 4 374 ms, max 5 165 ms) with **alternating ON/OFF order** on both
  sides; timeline delta p50 <= 0.5 s. ON-first-only reads a false +588 ms through
  the warm image prefix.
