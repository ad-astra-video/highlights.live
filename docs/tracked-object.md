# Tracked-object definition (shared detection contract)

Status: live increment ADAAAA-5050 · owner Developer · applies to the perceive
live-runner (live + VOD detect paths) and to the shared detection contract in
`packages/events/src/index.ts`.

This document is the authoritative definition of what counts as a **tracked
object**. It is the "selection + ID-persistence rules" the object-tracking
increment requires, and it is what the labeled eval set
(`evals/track_label_manifest.json`) and the accuracy measurement harness
(`evals/track_metrics.py`) score against.

## What a "detected object" is vs. a "tracked object"

The perceive detector (Florence-2 `<OD>`, or the background-diff CPU stub)
emits a per-frame **detected object**: `{label, confidence, bbox}` — a box in
one frame, independent of every other frame (see `DetectedObjectSchema`).

A **tracked object** is a detected object that has been **promoted into a
persistent identity**: a `Track` (see `app/tracker.Track`) that is carried
across frames while it stays on screen. A track is the unit that has a stable
`trackId`, a `slot` (0..capacity-1), and a continuity/accuracy measurement.
Tracking is what converts a stream of independent detections into an object
whose identity survives occlusions, jitter, and re-detection gaps — and it is
what the highlight/clip decision path consumes (`trackCount` →
`humansInMotion` reaction evidence in `services/server/src/analyzer.ts`).

## Selection rules — what gets tracked

An object becomes a track if **any** of the following is true:

1. **Operator / on-demand selection (INC-6, `control` `track`/`seed`)** — a
   user (or the UI) picks a region on-screen: `{type:"track", bbox?, slot?}` in
   the shared `ControlMessageSchema`. perceive normalizes it to a slot, marks
   it `selected`, and follows it across frames while on screen. This is the
   surfaced, company-bounded form of `seed`.
2. **Auto-detection (live + VOD passive path)** — a detected object that is
   not yet tracked takes a free slot up to the mode capacity (live 3 / VOD 8)
   via the tracker's `step()`. It becomes a `kind`/`label`-carrying track.
   Passive auto-tracks do **not** report the `accuracy`/persistence fields
   (those belong to selected find-and-track targets), but they still occupy a
   slot and feed `trackCount`.
3. **Ball track (dedicated slot)** — the ball lives in its own
   eviction-guarded `BallTracker`, independent of the player `capacity`
   (see INC-2b / INC-7), and is never a possession/highlight candidate itself.

**Selection precedence / capacity:** mode capacity is the hard ceiling — a live
session tracks at most `LIVE_MAX_TRACKS = 3`, a VOD pass at most
`VOD_MAX_TRACKS = 8` (see `app/session.mode_capacity`). Operator selection
takes precedence over auto-detection for the contested slot; an operator slot is
locked against automatic eviction (`control` `lock`).

## ID-persistence rules — what keeps a track the same identity

A track persists its identity across frames under the tracker's match rules
(`IoUTracker.step`): a new detection belongs to an existing track when its box
**IoU-overlaps** the track's previous box (IoU threshold 0.05) **or** its
centroid is within the movement gate (Manhattan centroid distance < 0.20). The
nearest / highest-scoring match wins; a box that matches none becomes a new
track (in a free slot), and an existing track with no match increments
`lost_frames`.

The identity is **kept** (ID persists) as long as the track is matched at least
once every `lost_before_evict` frames (default 8) — across short occlusions
and single-frame detection dropouts. An **unmatched** track that exceeds the
eviction window and is **not locked** is removed (its slot frees, its identity
ends). A **locked / selected** slot survives repeated lost frames and keeps its
last box until re-acquired or explicitly evicted.

The perceived continuity metric on a selected target is
`accuracy = onto_frames / (onto_frames + lost_frames)` over the tracked window
(1.0 = never dropped while on screen) — surfaced on `TrackObservation` as
`accuracy`, `onScreen`, `ontoFrames`, `lostFrames`.

## Measurement definition (what the eval set scores)

A **labeled eval set** for tracking is ground truth over frames: for each clip
(`mode` live or VOD) a list of frames, each carrying the objects that SHOULD be
tracked with stable labels (`object ids`). The harness `evals/track_metrics.py`
drives the same tracker the deployed path uses and scores:

- **ID persistence (ID persist rate):** the fraction of on-screen frames of a
  labeled object that were carried by the single correct track (no identity
  split/switch). 1.0 = the object never lost its identity while on screen.
- **IoU accuracy:** mean IoU between the tracker's emitted box and the labeled
  box for the correctly-matched object, over matched frames.
- **Max concurrent objects:** the largest number of simultaneously-live tracks
  observed (must reach 3 on a live clip / 8 on a VOD clip, and never exceed
  the mode cap).

Acceptance target for the spawned eval set: **ID persist ≥ 95%**, **IoU ≥ 0.5**,
and **max concurrent = mode cap** on the representative mix of live (3) and VOD
(8) soccer scenes. (Numbers for the run are posted on the increment issue.)
