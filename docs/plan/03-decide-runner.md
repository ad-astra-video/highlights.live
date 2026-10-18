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

## Watcher / depth router / deep investigation (ADAAAA-6738 G1c, ADAAAA-6740 G3)
The decide runner also exposes the *watcher* pipeline in addition to the
single-shot `/highlight`:

- **Pass 1 — watcher** (`/watcher/start|ingest|step|summaries`): a 3 s-tick /
  10 s window / 3 fps chunk that emits a timestamped summary row and carries the
  last-30 s summary list. `app/watcher.py` (`WatcherSession`).
- **Pass 2 — depth router** (`/depth/state|flags`): the **sole trigger
  authority**. It keeps a rolling dialog of the pass-1 rows and flags a moment
  for deep investigation when the dialog shows a high-signal moment (high-value
  event or a strong crowd reaction) that cleared an **audio-noise-reliability
  gate** (decide queries `get_audio_levels` and requires a real baseline-relative
  rise, so gemma is NOT fired for silence/audio-noise). A cooldown bounds the
  flag rate (target <= 5 flags/min). `app/depth_router.py` (`DepthRouter`).
  Perceive emits no candidate/trigger — only windowed tool envelopes.
- **Deep investigation** (`/deep/investigate|state|verdicts`, and auto-run via
  `/watcher/step2`): for each flagged moment, a deeper verdict over the
  **3 s-forward / 12 s-back** window (video + audio) with perceive tools as
  windowed corroborating evidence. Resolves through the single accept gate
  (`finalize_goal_acceptance` — only a `scoring_play` is accepted); a refuted /
  non-highlight moment is discarded (no clip). `app/deep_investigation.py`
  (`DeepInvestigator`).

Gates measured in `evals/decide_watcher_deep_investigation.py` (Pass 2 +
deep-investigation): depth-router recall >= 80 %, false-positive flag rate
<= 5/min, deep verdict truth (precision/recall), no clip on discard, and the
audio-noise false-positive rate (bounded via `get_audio_levels`).

## Decide-runner clip stash + build-or-discard (ADAAAA-6741 G4 — implemented)
The 120 s frame+audio ring now lives on the decide runner:
- **`app/clip_stash.py`** (`ClipStash`): a continuous 120 s in-memory ring
  (`StashConfig.ring_duration_s`) of small JPEG frames (+ optional tiny audio
  segments), fed by the media/orchestrator rail through **`POST /stash/ingest`**
  (`/stash/start` opens it). `preclip(trigger)` assembles the **20 s-before /
  10 s-after** window straight from the stash, and `build_clip` re-encodes an
  MP4 from the stashed JPEGs via local ffmpeg (`libx264`) — CPU work, no GPU,
  no source re-read.
- **Build-or-discard** (`build_or_discard`): a **confirmed** highlight
  (`is_highlight && !discarded`) is built from the stash window and uploaded to
  the server; a **discarded/refuted** moment frees the stash (no clip, no server
  record). Auto-driven from the deep-investigation verdict (`/deep/investigate`,
  `/watcher/step2`) when a stash is open — `stashAction` in those responses.
- **Upload**: `app/clip_upload.py` posts the built MP4 to the server's new
  **`POST /jobs/:id/clips`** route (multipart), which persists an `accepted`
  highlight and publishes it to the public feed. The server no longer runs the
  ffmpeg clip cut.
- Gates verified: `services/decide/tests/test_clip_stash.py` (ring eviction,
  pre-clip 20/10, real ffmpeg MP4 build, confirm→build+upload, refute→free,
  multipart upload contract) + `services/server/test/clip-upload.test.ts`
  (record builder, persist, GET /feed visibility).

## Deployment requirement (user criterion)
Deploy a vLLM OpenAI server for the decide model on 192.168.1.6 (GPU 1 / RTX 5070 Ti, 16 GB).
INT4 weights ≈ 10.45 GB; the decide pass sends up to ~30 frames (~8.4K KV tokens/req)
plus audio, so 4 TRULY-concurrent sequences only fit with the fp8 KV cache
quantization (halves KV bytes vs f16) and a bounded `--max-model-len`. Verify the
actual KV allocation on first load (vLLM logs it); if it OOMs, lower
`GEMMA_MAX_CONCURRENCY` / `GEMMA_MAX_SOFT_TOKENS` or `GEMMA_GPU_MEM_UTIL` via
docker/.env — no code change.
