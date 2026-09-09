# Chunk 06 — Deploy + end-to-end on 192.168.1.6

Target: `brad@soccer99` on 192.168.1.6:1222 (livepeer-ai-x99).
- GPU 0 RTX 3090 Ti (24 GB, ~10.6G free) → perceive (Florence)
- GPU 1 RTX 5070 Ti (16 GB, ~1.4G free) → decide (Gemma Q4 via llama.cpp) — may need to free GPU 1 or run Gemma on CPU
- 16 cores, 62 GB RAM. Docker 28.4 + compose. ~/highlights.live is empty; hl_src.tar.gz (202KB) staged.
- Box runs existing containers: worker-worker-1 (GPU1), worker-gemma-vllm-1 (GPU1, :6100), worker-vllm-1 (GPU0, :6000), embeddedings llama.cpp (:8081).

## Steps
1. Sync the highlights.live repo onto the box (extract hl_src.tar.gz or git clone/push). Verify source present.
2. Install a Gemma 12B Q4 GGUF for the decide model (confirm availability/disk) OR use the plan's stub-rule decide first for a working e2e, then swap in real Gemma.
3. `docker compose -f docker/docker-compose.yml up -d --build` → orchestrator, perceive, decide, server.
4. Verify: orchestrator 8935, perceive /health, decide /health, server :3000 /health.
5. Run the webapp (vite dev) + use the server API from this host against the box, or run server locally pointed at box runners.
6. End-to-end VOD job: upload test_vod.mp4 → perceive analyze → decide → clip → review. Confirm clips + json.
7. Live/confirmed-by-user path: start live console e2e if resources allow.

## Blockers to watch
- GPU 1 OOM (Gemma on 16 GB card that's ~93% used) → free GPU 1 or CPU fallback.
- docker compose `signer` profile is on-chain only; offchain lab omits it (correct for this test).
- The plan says perceive/decide each need a GPU — offchain compose uses stub detect by default; Florence real needs PERCEIVE_MODE=florence + weights on GPU 0.
