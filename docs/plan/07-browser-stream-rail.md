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

## Target architecture (user-proposed, locked)
EVERYTHING goes through the Orchestrator. No media leg bypasses it. MediaMTX is
the orchestrator's media ingress (exactly Livepeer's own AI pipeline layout:
"components = MediaMTX + Trickle Server"). The main Fastify server is control
plane ONLY — it never carries media bytes.

    browser (getDisplayMedia, audio+video)
        --WHIP--> MediaMTX (orchestrator's media ingress; per-stream URL)
        --trickle video-in--> [Orchestrator: ticket auth + relay]
        --> perceive RUNNER: consumes the FULL STREAM at ~5fps + audio
             via session.step() on ONE persistent session, events-out back through orchestrator
        --> decide: fuses audio bursts + visual evidence

Client side speaks the Livepeer trickle protocol via the `livepeer_gateway`
Python SDK (LiveVideoJob: video-in / events-out / control / audio channels; all
terminate at and relay through the Orchestrator). Fastify only PROVISIONS the
per-stream WHIP URL + AnalyzeSession; it is not a hop in the media path.

Media hot path = MediaMTX replicas, horizontally scalable independently of the
main server. Control path = Fastify + Orchestrator (ticket/session), unaffected
by media load.

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

### 2. Server
- TODO: WHIP/WebRTC ingest endpoint (net-new transport; aiortc / node-wrtc /
  libdatachannel sidecar). Receives SRTP, demuxes to 5fps JPEG frames + audio
  segments (1s, opus/pcm) with timestamps.
- TODO: hold ONE AnalyzeSession for the job; push frames via trickle video-in
  into the orchestrator (continuous, ordered, timestamped) — reinstate the
  stream-id keyed app-call/trickle the per-frame request path bypassed.

### 3. Orchestrator (go-livepeer)
- Already the runner registry + reverse-proxy + trickle broker per the plan.
- NOTE: app-call/trickle is HTTP-request-ish; a true low-latency SRTP media leg to
  the runner would bypass the orchestrator and is a bigger change — not assumed.

### 4. Perceive runner
- SessionRegistry/SessionState already model one-session-per-stream; `/app/analyze`
  and trickle `video-in` share `session.step(frame)` (§3.5). Add the trickle
  video-in front door consuming ~5fps.
- TODO: audio-burst feature — spectral/energy detector on the audio segments
  (crowd/announcer spike) → scalar evidence the decide stage can weigh.

### 5. Decide
- TODO: fuse audio-burst + visual evidence (track count/velocity/ocrHits) into the
  `HighlightDecision`.

## Constraints / honest notes
- Chrome yields audio ONLY when sharing a TAB (screen/window capture has no
  audio) → audio analysis effectively requires tab / in-page element capture.
- WebRTC-to-server transport is net-new (no WHIP/webrtc dep in the server today).
- go-livepeer's media path: confirmed HTTP app-call / trickle, not raw SRTP à la
  a media server (Mediamtx/Antmedia) — if we need true low-latency media into the
  runner, that bypasses the orchestrator and is a separate rail.
- clip-vs-analyzed-stream frame-lock: acceptable skew for clips.

## Risks
Session≠socket (unhealthy checks release sessions); trickle seq gaps; WHIP stack
maturity in the chosen framework; audio analysis is brand-new (not in the stack);
re-encode quality if clip fidelity model changes.
