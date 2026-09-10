# Chunk 07 — Browser stream rail (re-architecture)

Status: DESIGN — WebSocket delivery locked; implementation next.

## Problem with the current browser rail
The client-side screen share (`BrowserCapture`) mangles the stream before it
reaches the pipeline:
- Samples the preview to 320x180 JPEGs and POSTs each via HTTP `/jobs/:id/ingest`.
- The perceive runner never sees a stream — only stateless, request/response
  app calls. No temporal state beyond a per-frame tracker, no audio.
- MediaRecorder upload exists only to cut clips; the two paths are not frame-locked.

This departs from the plan's intended trickle design (§0.2, §3.2/3.5) and the
`SessionRule`: "One persistent perceive session per stream... trickle video-in —
one session.step(frame) per front door."

## Target architecture (locked — WebSocket delivery)
LIVE DELIVERY = WebSocket, end to end. The browser MediaRecorder stream travels
entirely over WebSockets:

    browser (getDisplayMedia, audio+video)
       --MediaRecorder(high-bitrate, binary frames)--> [WS]
       --> MEDIA SERVER (WS terminus; server-side process)
             - terminates the browser WS
             - writes the same bytes to disk = the CLIP source
             - demuxes to frames (~5fps) + audio for the ANALYSIS path
       --> [WS tunnel] uses livepeer_gateway to proxy/open a WebSocket
            to the ORCHESTRATOR
       --> Orchestrator (live-runner CHANNEL: WS proxy to the live-runner)
       --> perceive LIVE-RUNNER (WS video-in: consumes full stream ~5fps + audio
                                  via session.step(); events-out back through the
                                  channel)
       --> decide: fuses audio bursts + visual evidence

The media server IS the media hot path (horizontally scalable gateway replicas,
independent of the Fastify control plane). It has NO media-server dependency of
its own — it is a process that terminates the browser WS and uses
`livepeer_gateway` to proxy that stream up the WS tunnel to the Orchestrator's
live-runner channel. Fastify stays control plane (provisions the per-stream WS
URL + job, asks a gateway to start the Orchestrator session, receives results);
it never carries media bytes.

Single-stream design: the high-bitrate MediaRecorder stream the WS carries is
both (a) demuxed to 5fps frames + audio for perception and (b) written to disk
for clip cutting at stop. Same source bytes -> no frame-lock skew, no second
upload. Latency ~1s (MediaRecorder timeslice + GOP keyframe wait) is fine:
detection runs over multi-second windows and clips are timestamp-cut from the
recording.

Fastify (main server) is control plane only: it PROVISIONS the per-stream WS URL
+ job, asks the gateway to start the Orchestrator session, and receives final
results. It never carries media bytes.

Media hot path = the gateway WS processes (horizontally scalable, independent of
the main server). Control path = Fastify + Orchestrator
(ticket/session/live-runner channels), unaffected by media load.

## Clip-fidelity model (single stream — supersedes the two-stream Option 1)
- The one WebSocket stream is high-bitrate MediaRecorder (audio+video). The
  saved clips are cut from these same bytes at stop — real source fidelity, no
  lossy re-transmit, and timestamp-aligned with the analyzed frames (no skew).
- Chrome yields audio only when sharing a TAB; screen/window capture is silent.

## Components
### 1. Browser (BrowserCapture)
- DONE: getDisplayMedia({video:true, audio:true}) — tab capture carries sound.
- TODO: replace the JPEG-sampling + REST-recording-upload with ONE high-bitrate
  MediaRecorder streamed over a WebSocket to the gateway (this becomes both the
  analysis feed and the clip source). IntervalFrameReader samples ~5fps from the
  same recording for perception; MediaRecorder timeslices feed the clip file.

### 2. Media server / gateway — WebSocket media terminus (livepeer_gateway)
- A process on the SERVER that terminates the browser WebSocket, writes the
  received MediaRecorder bytes to disk (the clip source), and demuxes them
  (ffmpeg) to ~5fps frames + ~1s audio segments for the ANALYSIS path.
- **It does not natively reach the Orchestrator.** Each browser WS maps to one
  `livepeer_gateway` client that proxies the analysis media up a SECOND WebSocket
  **to the Orchestrator** (the live-runner video-in channel): pushes frames +
  audio, subscribes events-out. Uses `livepeer_gateway` (LiveVideoJob +
  Orchestrator/PaymentSession tickets).
- Replicas of this process ARE the media hot path, scaled independently of the
  main server. Fastify stays control plane (provisions the per-stream WS URL,
  starts the job, receives results) and never handles media bytes.

### 3. Orchestrator (go-livepeer)
- NOT a media server. Its media role = create live-runner CHANNELS that proxy
  data to the live-runner (video-in / control / events-out), plus ticket auth /
  session lifecycle. The gateway pushes through these channels; the runner's
  output comes back through them.

### 4. Perceive runner
- SessionRegistry/SessionState already model one-session-per-stream; `/app/analyze`
  and trickle `video-in` share `session.step(frame)` (§3.5). Add the trickle
  video-in front door consuming ~5fps.
- Tracking: HybridTracker (app/sam_tracker.py) = Florence(detect) + SAM 3.1(track).
  Florence-2-base/230M is the DETECTOR (its labels are unreliable on untrained
  game-UI content — proven live: minimap->"mobile phone", timer->"digital clock").
  SAM 3.1 propagates masks between Florence passes; Florence re-detects only on
  SAM loss (no mask) or target change / re-detect cadence. Handoff logic unit-tested
  with a stub backend. Enabled via PERCEIVE_TRACKER=florence_sam; without a real
  SAM backend it degrades to Florence->IoU (current default, unchanged).

  GATING RULE (enforced in `_sam_step`): Florence IDENTIFIES, SAM TRACKS — SAM
  never runs when there is nothing to track. Nothing tracked yet + Florence
  identified objects this frame -> BOOTSTRAP (seed SAM prompts from those
  detections, then step). Nothing tracked + no identification -> IDLE frame, SAM
  is NOT called at all (no `advance()`, no GPU spend on an empty scene). Once
  seeded, SAM advances its existing prompts every frame (it follows what was
  already identified even if a single frame has no fresh detections). New +
  existing tests (test_sam_tracker.py: idle-frame / bootstrap / carried-forward)
  lock this in.

  SAM 3.1 is per-frame, not whole-video: `propagate_in_video` is a driver loop
  over a per-frame step (`sam3/model/sam3_video_inference.py` `_run_single_frame_inference`,
  yields `out["obj_id_to_mask"]` per frame), driven one frame at a time via
  `propagate_in_video(start_frame_idx=f, max_frame_num_to_track=1)`. So the real
  backend (app/sam3_backend.py, `Sam3Backend`) reuses SAM's OWN session/state and
  its obj_id-keyed multi-mask tracking instead of reimplementing tracking:
  slot->obj_id 1:1, box prompt -> single positive center point, per-frame
  `advance(prompts)` + `get(slot)` (mask->bbox, None when target absent this frame).
  `advance()` distinguishes SAM DRIFT (prompt == box we last returned; normal,
  keep seeding) from an EXTERNAL target change (user seed / Florence re-detect;
  reset + re-add per SAM 3's reset-then-add). All of this — per-frame stepping,
  multi-slot tracking, drift-vs-change, loss->Florence re-detect — is testable
  against a fake predictor that mimics handle_request / handle_stream_request
  / obj_id_to_mask (tests/test_sam3_backend.py), so it runs without triton/weights.
  `sam3` still hard-imports triton (CUDA), so `ready()` is False on CPU hosts and
  the hybrid falls back to Florence->IoU; a real run needs the .venv312 host +
  HF token for facebook/sam3.1 weights + a clip path (PERCEIVE_SAM_CLIP).
- TODO: audio-burst feature — spectral/energy detector on the audio segments
  (crowd/announcer spike) → scalar evidence the decide stage can weigh.

### 5. Decide
- TODO: fuse audio-burst + visual evidence (track count/velocity/ocrHits) into the
  `HighlightDecision`.

## Constraints / honest notes
- WebSocket transport is net-new on the gateway (server has no WS media endpoint
  or webrtc dep today; the browser already has MediaRecorder).
- One encode/decode round trip (browser encode + gateway ffmpeg decode) adds
  ~1s latency (MediaRecorder timeslice + GOP keyframe wait) — acceptable because
  detection runs over multi-second windows and clips are cut from the recording.
- Orchestrator is NOT a media path — it proxies live-runner channels only.
- If gateway WS decode throughput ever bottlenecks, MediaMTX can terminate the
  WebRTC/ingest — only then, not speculatively now.

## Risks
Session≠socket (unhealthy checks release sessions); trickle seq gaps; ffmpeg
demux of MediaRecorder webm/mp4 under load; audio analysis is brand-new (not in
the stack); clip quality depends on the browser's MediaRecorder encode settings.
