# Chunk 03 — Decide live-runner (GPU 1, Gemma) + clip

Source: plan §3.7, §0.3. Container `highlights-decide`, app `highlights-live/decide`,
mode `single-shot`, capacity 1, health 200 when the gemma server answers.

- Exposes ONLY `POST /app/highlight`. Input: ContextSnapshot + up to 4 JPEGs (full frame + 2 track crops). Output: HighlightDecision JSON.
- Does NOT import SAM3/Florence. Stateless given ContextSnapshot.
- Decide container calls an in-compose **vLLM** OpenAI server serving
  **cyankiwi/gemma-4-12B-it-qat-AWQ-INT4** (ADAAAA-6695; replaces the llama.cpp
  `llama-server` + mmproj on GPU 1). Encode on CPU libx264 (or NVENC only while
  decide idle). Not a live-runner.
- Concurrency: vLLM `--max-num-seqs` is driven by the compose ENV
  `GEMMA_MAX_CONCURRENCY` (default 4); changing the ENV changes effective
  concurrent decides with no code change. KV cache is fp8-quantized
  (`--kv-cache-dtype fp8`, default) so 4 concurrent 30-frame sequences fit the
  16 GB RTX 5070 Ti.
- Payments: one `generate-live-payment` per /highlight. Prefer `unit: fixed` → pay once, no refresh.
- runners.json entry: mode single-shot, capacity 1, gpu{id:1}, price unit fixed.

## Notable-only bar (ADAAAA-5778)
The `/app/highlight` gate is notable-only: a candidate is a highlight only when
it carries corroborating evidence AND (its event class is high-value OR its
notability score clears `DECIDE_NOTABILITY_MIN`, default data-landed 60 on the
§6 eval set — `evals/decide_discernment.py`). Bare scene/audio triggers with no
notable content are rejected. The gate is a pure post-process over signals the
request already carries, so it adds NO inference (same Gemma call budget).

## STATUS
- /app/highlight stub-rule (deterministic evidence scorer) + /health: DONE (decider.py, app/__init__.py).
- Notable-only gate (event-class + corroboration + config bar): DONE (ADAAAA-5778).
- Real Gemma 12B INT4 via vLLM: IN PROGRESS (ADAAAA-6695). The gemma compose
  service now runs a vLLM OpenAI server on GPU 1 serving
  `cyankiwi/gemma-4-12B-it-qat-AWQ-INT4` (compressed-tensors INT4, encoder-free
  image+audio+video via `gemma4_mm`), with `--max-num-seqs` bound to
  `GEMMA_MAX_CONCURRENCY` (default 4) and `--kv-cache-dtype fp8`. The decide
  service's `GEMMA_MODEL` now matches the served model name, and
  `gemma.py` sends `chat_template_kwargs.enable_thinking=false` to keep Gemma 4
  reasoning off so strict JSON returns immediately.
- Clip on CPU via server ffmpeg: DONE (server cutClip).

## Decision observer contract (ADAAAA-7007)
The VOD pass has moved from candidate-gated decide to a **decide-observer** loop.
`decide` is now the primary observer of the timeline:
- **Cadence ~3 s** of content time (`OBSERVE_CADENCE_S`), not gated on a perceive
  candidate.
- **Reference window ~10 s** (`OBSERVE_WINDOW_S`) of frames assembled around the
  current moment (`services/server/src/observe-loop.ts` `assembleObserveWindow`).
- **Overlap retained** between consecutive windows because the window (10 s) is
  longer than the cadence (3 s) — consecutive windows share ~7 s of content.
- **<=30-frame hard cap** (`OBSERVE_MAX_FRAMES`); a denser window is subsampled
  to the cap (`subsampleToCap`). Never send more than 30 frames in one call.
- **perceive = data seeder + on-demand provider**, not the candidate gate. Every
  decide payload carries perceive-derived per-frame context (detections /
  tracking / scoreboard / motion/geometry) as `seeds`, plus the window's
  candidate triggers as **bias hints / provenance** (`biasHints`) — never the
  on/off switch. On-demand perceive recall: when decide needs more evidence for
  a moment it recalls perceive before finalizing (`applyOnDemandRecall`).
- **Finalize**: decide returns `isHighlight` + score; on accept the server cuts a
  clip. Only `scoring_play` outcome is a board `GOAL`; `near_miss`/`big_play` are
  never published as GOAL (`isAcceptedHighlight`).
- The candidate/event **vocabulary is frozen** (`packages/events` outcome enum,
  `eventTypeForOutcome`, `isAcceptedHighlight`).

The server wires the loop via `ObserveDecider` (per-frame loop integration seam)
and `runObserveLoop` (streaming driver). Per-call decide input size + per-job
decide spend are surfaced by `inputSizeSamples()` / `decideCalls()` to feed the
-67% cost measure in the companion issue.

## Live decide-observer (ADAAAA-7008)
The LIVE path uses the same observer architecture, but the window is a **rolling
PAST** window because a live observer cannot decode ahead. `LiveObserver`
(`services/server/src/observe-loop.ts`) replaces the VOD `ObserveDecider`:
- **Cadence ~3 s** (`OBSERVE_CADENCE_S`), CEO-locked, fired via `maybeFire` /
  `shouldFireObserve`.
- **Rolling PAST window ~10 s** (`LIVE_OBSERVE_WINDOW_S`): the window is
  `[now-10s, now]` (`assembleLiveWindow`), NOT the symmetric `[center±5s]` band
  the VOD path uses. Consecutive windows still overlap because the window (10 s)
  is longer than the cadence (3 s).
- **<=30-frame hard cap** (`LIVE_OBSERVE_MAX_FRAMES`), subsampled via the shared
  `subsampleToCap`. Never send more than 30 frames in one call.
- **perceive = data seeder + on-demand provider**, same as VOD. Every payload
  carries `seeds` (per-frame detections / tracking / scoreboard / geometry) +
  `biasHints` (folded perceive triggers). On live, perceive's **audio
  noise-change** and **motion** are **bias hints** only — decide still runs every
  cadence tick regardless of whether perceive emitted a candidate.
- **Finalize** unchanged: `isHighlight` + score; only `scoring_play` is a board
  `GOAL` (`isAcceptedHighlight`); `near_miss`/`big_play` never published as
  GOAL.
- Each fired decide is a paid **single-shot** `unit: fixed` call through
  `packages/livepeer-session` `decide()` — the observer cadence directly drives
  live decide spend.

The measurement/report surface (cadence + gemma end-to-end per invocation, the
~30 s flag budget, and how it is reported on the Livepeer runner) is documented
in [`09-live-observer-latency-report.md`](09-live-observer-latency-report.md).

## Deployment requirement (user criterion)
Deploy a vLLM OpenAI server for the decide model on 192.168.1.6 (GPU 1 / RTX 5070 Ti, 16 GB).
INT4 weights ≈ 10.45 GB; the decide pass sends up to ~30 frames (~8.4K KV tokens/req)
plus audio, so 4 TRULY-concurrent sequences only fit with the fp8 KV cache
quantization (halves KV bytes vs f16) and a bounded `--max-model-len`. Verify the
actual KV allocation on first load (vLLM logs it); if it OOMs, lower
`GEMMA_MAX_CONCURRENCY` / `GEMMA_MAX_SOFT_TOKENS` or `GEMMA_GPU_MEM_UTIL` via
docker/.env — no code change.
