# Chunk 01 — Shared contracts (packages/events)

Source: plan §1. Freeze JSON BEFORE any UI/model wiring.

Required types (all in packages/events/src/index.ts, Zod + JSON-schema-able):
- `FrameObservation` incl. `tracks[]` (max 2)
- `CandidateEvent`
- `ContextSnapshot`
- `HighlightDecision`
- `TrackObservation` (`trackId`, `slot:0|1`, bbox, kind, lostFrames)
- `RunnerSession` `{ sessionId, streamId, kind: perceive|decide, orchAddress, signerState, gameHint, preferLabels, sampleFps }`
- `ControlMessage` discriminated union (configure/seed/evict/lock/analyze-still/confirm/clip/ping)
- `OutboundEvent` discriminated union (observation | candidate | decision | clip | health)

HTTP paths (under reserved session on live-runner):
- `POST /apps/highlights-perceive/session`
- `ANY /apps/highlights-perceive/session/{sid}/app/analyze`
- `GET /apps/highlights-perceive/session/{sid}/app/events`  (SSE)
- `GET /apps/highlights-perceive/session/{sid}/app/ws`      (WS)
- `POST /apps/highlights-perceive/session/{sid}/payment`
- `POST /apps/highlights-perceive/session/{sid}/stop`
- `ANY /apps/highlights-decide/app/highlight`               (single-shot)
Direct runner (dev): same paths minus `/apps/.../session/{id}` prefix, but still require `Livepeer-Session-Id` (or local `X-Session-Id`).

Server public API: `POST /jobs` `GET /jobs/:id` `GET /highlights` `POST /highlights/:id/review` `POST /streams/:id/session` `GET /streams/:id/live`.

Acceptance: mocked runner + mocked worker produce one highlights.json the frontend can render.

## STATUS
DONE — packages/events/src/index.ts implements all of the above (verified earlier). Tests in packages/events/test/contracts.test.ts.
