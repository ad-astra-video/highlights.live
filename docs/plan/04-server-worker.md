# Chunk 04 — Server (API + worker)

Source: plan §4. Add `packages/livepeer-session` as the ONLY client of signer + orchestrator.

## livepeer-session client (§4.1)
- discover({caps}), signOrchInfo(address), generatePayment(orchInfo, signerState), reservePerceive, refreshPayment(sessionId), stop(sessionId), highlight(context,images), openChannels/publishFrame/subscribeEvents.
- Talks to signer + orchestrator public URL. Never runner_url. Never holds a keystore.

## Offline job (§4.2) — still session-scoped
1. Insert streams row
2. Discover perceive+decide via signer (or pinned offchain orch)
3. reservePerceive(); on 402 → generatePayment + retry
4. Start payment refresh task
5. Extract 1fps; POST perceive /app/analyze
6. TemporalEngine + adapters
7. Each candidate: decide (own payment)
8. Maybe CPU /clip
9. stop() perceive in finally; cancel payment loop
Acceptance: VOD → json+clips, one perceive session id, on-chain ≥1 successful /payment refresh.

## Live path (§4.3)
1. Ingest HLS/RTMP → 2-4s segments, last 60s on disk
2. Discover+pay+reserve one perceive session when live
3. Sample 1fps, publish to trickle video-in
4. Subscribe events-out + SSE; persist
5. **Decide-observer (ADAAAA-7008)**: a `LiveObserver` fires a single-shot
   decide on the ~3 s cadence over the rolling-PAST ~10 s window
   (`OBSERVE_CADENCE_S` / `LIVE_OBSERVE_WINDOW_S` / `LIVE_OBSERVE_MAX_FRAMES`).
   perceive supplies `seeds` + `biasHints` (it is the data seeder, NOT the
   on/off gate); `scoring_play` accept → wait for T+15 then confirm + CPU clip
6. Stream end: stop perceive + halt payment refresh
7. The observer records cadence + gemma end-to-end latency per invocation
   (`LiveObserver` latency surface — see
   [`09-live-observer-latency-report.md`](09-live-observer-latency-report.md))
   to prove the ~30 s flag budget.
Redis: stream:{id}:session, stream:{id}:tracks.

## Tests (§4.5)
Reserve→3 analyze→same trackId; Stop→next analyze 404/410; Capacity 1→2nd reserve 503; On-chain reserve w/o payment→402→retry w/ tickets succeeds; Payment refresh failure stops session; works via trickle too.

## STATUS
- livepeer-session client (reserve/analyze/decide/stop, HttpSignerClient, 402 → PaymentRequiredError, refreshPerceivePayment): DONE.
- Offline VOD worker (analyzeJob, EvidenceTracker, reserve→analyze→decide→clip→stop in finally; 402 path via PaymentRequiredError): DONE.
- Live ingest (LiveIngest: screen/rtmp/file-sim, record session.ts, sample+analyze rail, clip from session, stop): DONE.
- Payment REFRESH LOOP actually run in the worker: NOT DONE — refreshPerceivePayment exists but no worker task drives it on an interval.
- Redis (stream:{id}:session / :tracks), trickle publish/subscribe, 60s buffer, /streams/:id/live server-SSE: NOT DONE.
- Docker compose (orchestrator/perceive/decide/server) + signer profile + Railway split: DONE.
