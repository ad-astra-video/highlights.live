# Chunk 03 — Decide live-runner (GPU 1, Gemma) + clip

Source: plan §3.7, §0.3. Container `highlights-decide`, app `highlights-live/decide`,
mode `single-shot`, capacity 1, health 200 when llama-server answers.

- Exposes ONLY `POST /app/highlight`. Input: ContextSnapshot + up to 4 JPEGs (full frame + 2 track crops). Output: HighlightDecision JSON.
- Does NOT import SAM3/Florence. Stateless given ContextSnapshot.
- Decide container runs Gemma 4 12B Q4 via llama.cpp `llama-server` (GPU 1). Encode on CPU libx264 (or NVENC only while decide idle). Not a live-runner.
- Payments: one `generate-live-payment` per /highlight. Prefer `unit: fixed` → pay once, no refresh.
- runners.json entry: mode single-shot, capacity 1, gpu{id:1}, price unit fixed.

## STATUS
- /app/highlight stub-rule (deterministic evidence scorer) + /health: DONE (decider.py, app/__init__.py).
- Real Gemma 12B Q4 via llama-server: NOT DONE. Decide is a stub, no llama.cpp integration, no multipart JPEG ingestion.
- Clip on CPU via server ffmpeg: DONE (server cutClip).

## Deployment requirement (user criterion)
Deploy a llama.cpp `llama-server` for the decide model on 192.168.1.6 (GPU 1 / RTX 5070 Ti, 16 GB). Gemma 4 12B Q4_0 ≈ 6.7 GB weights — fits, but GPU 1 currently ~14.9G/16G used by other containers; may need to free GPU 1 or run decide model on CPU/GPU 0.
