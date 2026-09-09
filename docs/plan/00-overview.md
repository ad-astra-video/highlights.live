# Chunk 00 — Overview: system split, routes, GPU, remote signer

Source: plan §0–0.4, §8, §9.

## System split (processes, one contract)
- Perceive runner (GPU 0): Florence-2, SAM3 (2 slots), 1fps+8fps confirm, trickle/WS/SSE. Does NOT hold Gemma, ETH keys, DB, UI.
- Decide runner (GPU 1): Gemma 4 12B Q4 `/highlight`, single-shot. No SAM3 state, no keys.
- Transcoder: FFmpeg CPU or NVENC sidecar. No models/payments.
- Server (API + worker): ingest, jobs, temporal engine, adapters, context, scoring, Postgres/Redis, clip records, payment refresh. No model weights, no keystore.
- Remote signer: ETH keystore, deposit/reserve, ticket signing, orch discovery. Beside API, loopback only, never on GPU box.
- Frontend: operator console, review queue, public feed, overlays.
- Orchestrator(s): runner registry, capacity, reverse proxy, ticket verify, trickle broker.

## Session rule (§0.1)
One persistent perceive session per stream. Decide is single-shot (each `/highlight` is its own paid call). Never start a second perceive session for a second socket. Stop perceive at stream end; decide dies when the HTTP response ends.

## Communication routes (§0.2) — one session, split by payload
- Trickle `video-in` (server→runner, frames), `events-out` (runner→server, observations/candidates), `control` (bi).
- WebSocket `/app/ws` (operator commands+acks).
- SSE `/app/events` (decisions, lost-track, health).
- HTTP `/app/analyze` (perceive), `/app/highlight` (decide), `/clip` (CPU).

Headers the runner MUST read: `Livepeer-Session-Id`, `Livepeer-Session-Token`, `Livepeer-Session-Control`, `Livepeer-Runner-Route`.

## GPU split (§0.3)
- GPU 0 PERCEIVE (Florence + SAM3, persistent). GPU 1 DECIDE (Gemma Q4 via llama-server, single-shot).
- Two live-runners, not one process with two devices. Pin with `CUDA_VISIBLE_DEVICES`.
- Session mapping: streamId → perceiveSessionId (persistent) + decideRequestId (ephemeral).

## Remote signer (§0.4)
- `go-livepeer -remoteSigner` beside the API, loopback :7936, network arbitrum-one. Cannot use `-network offchain`.
- Server talks to signer (`/discover-orchestrators`, `/sign-orchestrator-info`, `/generate-live-payment`) + orchestrator public URL only, never `runner_url`, never holds a keystore.
- 402 Payment Required on reserve is the expected handshake — retry with signer tickets.
- Payment refresh loop (perceive) keeps the session alive; decide pays once per `/highlight` (unit: fixed).
- Offchain lab profile omits the signer entirely.

## Definition of done (MVP / alpha / beta)
- MVP: VOD through a reserved persistent perceive session → ≤2 stable tracks → single-shot decide → clips → operator review. Offchain, no signer.
- Live alpha: one live source, one perceive session, trickle+SSE, 60s buffer. Signer optional offchain.
- Public beta: accepted clips on a feed. Remote signer on, deposit funded, payment refresh keeps perceive alive, decide paid per eval. Max 2 tracks.

## Risks
Session≠socket; unhealthy health checks release sessions; VRAM; orchestrator hides runner_url; trickle seq gaps; SAM3 HF gate (IoU stub ok); signer on-chain only; 402 is the handshake; missed payment refresh wipes SAM3; keys off GPU hosts; price units differ (hour→refresh, fixed→once).
