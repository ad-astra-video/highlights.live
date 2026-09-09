# Chunk 02 — Perceive live-runner (GPU 0)

Source: plan §3.1–3.10. Container `highlights-perceive`, app `highlights-live/perceive`,
mode `persistent`, capacity 1, health 200 when Florence loaded (NOT when Gemma is up).

## Process/registration (§3.1)
- `runners.json` entry (label highlights-perceive, routing label, runner_url, health /health, mode persistent, capacity 1, proxy true, gpu{id:0}, price unit hour). DONE in docker/runners.json.

## Session object (§3.2)
- RunnerSession keyed by Livepeer-Session-Id: session_id, stream_id, token, control_url, prefer_labels, sample_fps, tracks (Sam3Tracker, MAX_TRACKS=2), frame_index, recent_frames (~60s), trickle handles, ws_clients, sse_subscribers.
- Lifecycle: create on first request with new id; open channels video-in/events-out/control; same object for all later traffic on that id; idle timeout or /app/session/close drops SAM3 + channels.

## Frame source (§3.3)
- VOD: FFmpeg fps=1 → /app/analyze. Live: server writes frames on video-in. Confirm window: runner extracts T±15s at 8fps internally (no second session).

## Control protocol (§3.4)
- ControlMessage union over WS + trickle control. Same JSON on both sockets.
- Commands: configure, seed, evict, lock, analyze-still, confirm, clip, ping. Acks on WS + SSE health + trickle events-out.

## Florence + SAM3 (§3.5)
1. Florence <OCR><OD><CAPTION> per sampled frame.
2. Selector MAX_TRACKS=2, IoU dedup, preferLabels adapter.
3. SAM3.1 multiplex, box-seeded from Florence, keyed by session id.
4. Drop slot after 8 lost frames unless lock.
5. IoU stub if HF access pending.
`/app/analyze` and trickle `video-in` call the same `session.step(frame)`.

## Outbound events (§3.6)
- OutboundEvent (observation|candidate|decision|clip|health). Fan-out: write once → trickle events-out AND SSE; WS copy only if operator connected.

## Dev stand-in (§3.10)
- X-Session-Id / X-Session-Token headers when go-livepeer down. Same session map.

## STATUS
- Session map keyed by id: DONE (session.py).
- Florence-2 real <OD> with device select (CPU/DirectML/CUDA/OpenVINO), fps gate, runtime sampling: DONE (florence.py).
- /app/analyze → same session.step, SSE /events, /session/stats, /session/close: DONE (app/__init__.py).
- SAM3 real multiplex: NOT DONE — tracker.py is an IoU-blob CPU stub (plan permits as HF-gate stand-in). SAM3 real = future GPU work.
- WebSocket /app/ws + control message handlers (seed/evict/lock/confirm/configure): NOT DONE — ControlMessage schema exists (events pkg) but perceive has no WS endpoint and no control handler.
- Trickle video-in/events-out/control: NOT DONE.
