# highlights.live — execution chunks

The 756-line implementation plan is split into small executable files.
Each chunk = one readable section + a concrete checklist. Work through
them in order; verify (tests) before moving on.

| # | File | Plan sections | Focus |
|---|------|---------------|-------|
| 00 | 00-overview.md | 0, 0.1, 0.2, 0.3, 0.4 | system split, routes, GPU split, remote signer |
| 01 | 01-contracts.md | 1 | shared JSON contracts (packages/events) |
| 02 | 02-perceive-runner.md | 3.1–3.10 | perceive live-runner (Florence + SAM3), route, control |
| 03 | 03-decide-runner.md | 3.7 | decide live-runner (Gemma) + clip |
| 04 | 04-server-worker.md | 4 | server: offline job, live path, payment loop |
| 05 | 05-frontend.md | 5 | operator console, review, overlay, live console |
| 06 | 06-deploy-e2e.md | 7, this-week | deploy orchestrator/perceive/decide/llama-cpp to 192.168.1.6; run webapp+server e2e |
| 07 | 07-browser-stream-rail.md | 3.5, 5 | browser stream rail (WebSocket trickle re-architecture) |
| 08 | 08-tracking-plan-latency-cost.md | 7 D, 8, 14.4 | tracking-plan → perceive latency & cost accounting |
| 09 | 09-live-observer-latency-report.md | 11, live | live decide-observer latency surface & ~30 s flag budget |
| 10 | 10-media-node-observability.md | 0, 4.5, 7 D | post-split media-node capacity/health + per-node inference cost attribution |

Definition of done + risks live in 00-overview's tail (plan §8/§9).
