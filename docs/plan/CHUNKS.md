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

Definition of done + risks live in 00-overview's tail (plan §8/§9).
