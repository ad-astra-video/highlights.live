# Chunk 07 — Browser stream rail (re-architecture)

Status: DESIGN, pending go-ahead on transport.

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

## Target architecture (user-proposed, locked — corrected, no MediaMTX)
The Orchestrator has no media server — it only creates live-runner CHANNELS that
proxy data to the live-runner (trickle video-in / control / events-out). The
gateway process does PYTHON WebRTC passthrough: it terminates the browser WHIP
in-process (aiortc) and forwards frames + audio to the Orchestrator over trickle.
No MediaMTX binary. Everything still goes THROUGH the Orchestrator.

    browser (getDisplayMedia, audio+video)
        --WHIP--> livepeer_gateway process (server side; PYTHON WebRTC
                             termination via aiortc — terminates SRTP/DTLS,
                             decodes frames + audio, then opens trickle
                             video-in to the Orchestrator and pushes them,
                             subscribes events-out)
        --> Orchestrator (creates live-runner CHANNELS that proxy data
                             to the live-runner; ticket auth; no media server)
        --> perceive LIVE-RUNNER (consumes full stream ~5fps + audio via
                                  session.step(), events-out back through
                                  orchestrator channels)
        --> decide: fuses audio bursts + visual evidence

Why pure-Python passthrough is enough here: the gateway only feeds the ANALYSIS
path (frames + audio, ~5fps). Clips come from the browser's separate
high-fidelity recording — so the WebRTC hop is NOT a full-res media transcoder
and doesn't need MediaMTX-class C++ throughput.

Fastify (main server) is control plane only: it PROVISIONS the per-stream WHIP
URL, asks the gateway to start the job, and receives final results. It never
carries media bytes.

Media hot path = the gateway processes themselves, horizontally scalable
independently of the main server (no separate media server). Control path =
Fastify + Orchestrator (ticket/session/live-runner channels), unaffected by
media load. If load profiling later shows Python WebRTC termination is the
bottleneck, add MediaMTX then — not speculatively now.

## Clip-fidelity model (default: Option 1 — recommended)
- ANALYSIS consumes the full stream (5fps frames + audio) via trickle.
- CLIPS cut from the browser's original high-fidelity MediaRecorder (audio+video),
  uploaded at stop — so saved highlights are real source bytes, not a lossy
  re-transmit. Server cuts on highlight timestamps as today.
- Why: WebRTC to a re-encoding server is lossy; the browser's original capture is
  the best clip source. Detachment from the analyzed stream is acceptable because
  both carry wall-clock timestamps (minor skew tolerated for clips).

Alt models (not chosen): clips from the server's re-encoded WebRTC stream (single
source, lossy, simpler); clips from a server-side high-bitrate transcribe (most
faithful to "runner gets the stream", heaviest server work).

## Components

### 1. Browser (BrowserCapture)
- DONE: getDisplayMedia({video:true, audio:true}) — tab capture carries sound.
- TODO: replace the JPEG-sampling + MediaRecorder-upload analyze path with an
  RTCPeerConnection (WHIP) to the server carrying realtime audio+video.
- KEEP: the local MediaRecorder as the high-fidelity clip source (stop upload).

### 2. Server gateway process (livepeer_gateway) — Python WebRTC passthrough
- A process on the SERVER that terminates the browser WHIP in-process using
  Python WebRTC (aiortc): per-stream WHIP URL, terminates SRTP/DTLS, decodes
  frames (video) + audio(~1s segments). No MediaMTX.
- It then sends the media to the Orchestrator: opens trickle video-in, pushes
  frames + audio (~5fps) continuously, subscribes events-out. Uses
  `livepeer_gateway` (LiveVideoJob + Orchestrator/PaymentSession).
- Replicas of this process ARE the media hot path, scaled independently of the
  main server. Fastify stays control plane: provisions the per-stream WHIP URL,
  asks the gateway to start the job, receives results. Fastify never handles
  media bytes.

### 3. Orchestrator (go-livepeer)
- NOT a media server: no MediaMTX. Its media role = create live-runner CHANNELS
  that proxy data to the live-runner (video-in / control / events-out), plus
  ticket auth/session lifecycle. The gateway pushes through these channels; the
  runner's output comes back through them.

### 4. Perceive runner
- SessionRegistry/SessionState already model one-session-per-stream; `/app/analyze`
  and trickle `video-in` share `session.step(frame)` (§3.5). Add the trickle
  video-in front door consuming ~5fps.
- TODO: audio-burst feature — spectral/energy detector on the audio segments
  (crowd/announcer spike) → scalar evidence the decide stage can weigh.

### 6. Decide
- TODO: fuse audio-burst + visual evidence (track count/velocity/ocrHits) into the
  `HighlightDecision`.

## Constraints / honest notes
- Chrome yields audio ONLY when sharing a TAB (screen/window capture has no
  audio) → audio analysis effectively requires tab / in-page element capture.
- WebRTC-to-gateway transport is net-new: Python WHIP termination via aiortc
  (no webrtc dep in the repo today). aiortc is the default WebRTC stack.
- The gateway terminates WebRTC in Python; if load profiling later shows that is
  the bottleneck (GIL / SRTP throughput), swap to MediaMTX then — not now.
- clip-vs-analyzed-stream frame-lock: acceptable skew for clips.

## Risks
Session≠socket (unhealthy checks release sessions); trickle seq gaps; aiortc
WHIP maturity at concurrency; audio analysis is brand-new (not in the stack);
re-encode quality if clip fidelity model changes.
