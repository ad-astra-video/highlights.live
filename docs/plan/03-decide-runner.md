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

## Deployment requirement (user criterion)
Deploy a vLLM OpenAI server for the decide model on 192.168.1.6 (GPU 1 / RTX 5070 Ti, 16 GB).
INT4 weights ≈ 10.45 GB; the decide pass sends up to ~30 frames (~8.4K KV tokens/req)
plus audio, so 4 TRULY-concurrent sequences only fit with the fp8 KV cache
quantization (halves KV bytes vs f16) and a bounded `--max-model-len`. Verify the
actual KV allocation on first load (vLLM logs it); if it OOMs, lower
`GEMMA_MAX_CONCURRENCY` / `GEMMA_MAX_SOFT_TOKENS` or `GEMMA_GPU_MEM_UTIL` via
docker/.env — no code change.
