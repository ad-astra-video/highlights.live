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

One compact record per perceive seed, ordered by `ts`:

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
  window's aligned seeds; **one record per seed**, so a 27-29-seed / ~10 s window
  yields ~3 records per second.
- Bounded to `DECIDE_MAX_PERCEIVE_RECORDS` (32) and clamped per field
  (`tracks` le=8, label/anchor lists bounded), mirroring the decide service's
  `Evidence.perceiveTimeline max_length=32`. The server clamps first, so decide
  never 422s the live loop (ADAAAA-7022 contract holds).
- A seed perceive never observed still yields a zero record (`tracks: 0`,
  `objects: []`) — that is how an empty timeline stays distinguishable from a
  missing one.
- Absent on the VOD rail: the enrichment is live-only, so the VOD request stays
  byte-identical.

### Prompt budget (AC-E3)

`render_perceive_timeline` (`services/decide/app/gemma.py`) renders the block into
the window prompt under `PERCEIVE_TIMELINE_MAX_CHARS = 1000`. When the budget
binds, the ladder is: **scalars only** (drop object labels / OCR anchors / track
ids, keep `t`, `tracks`, `vel`, `ball`, `poss`, flags) and only then **thinned**
(fewer records, keeping those nearest the window center). Records are never
silently dropped; the compaction mode is reported per window.

A 29-record live window renders in scalars form (~930 chars ≈ 230 tokens); the
delta against the pre-enrichment prompt is what AC-E3 measures on the box.

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
migration):

```json
{
  "elapsedMs": 4123.4,
  "asrLatencyS": 0.68,
  "perceiveTimeline": {"records": 29, "chars": 931, "compacted": "scalars",
                        "seeds": 29, "withFindings": 29},
  "audioPath": "asr_text", "asrRan": true, "windowAudioPresent": true,
  "noAudioReason": "", "audioTapChunks": 4, "audioClipBytes": 48000
}
```

## 4. Grading a fresh live leg

- **AC-E1**: 100 % of decide rows carry `timings.perceiveTimeline.records >= 1`
  per ~1 s of span, and no row reports `records == 0` while
  `withFindings > 0`.
- **AC-E2**: 100 % of rows report `audioPath == "asr_text"`, `asrRan == true`; the
  rows that did not are counted and named by `noAudioReason`.
- **AC-E3**: same-cell A/B (≥3 distinct windows per side) — decide wall time with
  vs without the block. A delta > 0.5 s means compact further before any frame
  budget is raised.
