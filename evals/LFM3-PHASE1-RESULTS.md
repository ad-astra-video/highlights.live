# LFM3-Omni Phase 1 — CPU-only audio/predicate discriminator eval (ADAAAA-8245)

Generated: 2026-11-06T23:29:32Z · harness `evals/lfm3_predicate_eval.py` · population `evals/inc9-trace-frames.json` (49 Stage-A candidates, 10 labeled clips).

**Cost envelope: 0 GB VRAM, $0 Livepeer, CPU-only.** No production default, live-box env, `GEMMA_GPU_MEM_UTIL`, `ASR_DEVICE`, `DECIDE_CONFIRM_ENABLED` or Stage-A gate setting was changed.

## Verdict

**NOT ADOPTED.** Kill criteria triggered: `<2 of 4 negatives rejected; p95 > 300 ms`. No Phase 2.

| AC | Bar | Measured | Verdict |
|---|---|---|---|
| AC1 precision (negatives eliminated) | >= 3 of 4 negative clips, 0 positives lost | 1 of 4 (soc-off-02); positives lost none; clip-level precision 60.0% -> 66.7% | FAIL |
| AC2 recall retained | 10/10 positives accepted (>= 95% on a 20-clip sample) | 6/6 positives retained an accepted GOAL (0 lost). The INC-5 labeled set contains 6 positives (4 goal + 2 near-goal), not 10; the 20-clip arm was not in scope | PASS |
| AC3 gate latency | p95 <= 300 ms per candidate | p50 2272.1 ms · p95 2312.9 ms · max 2341.2 ms (n=49); probability pass p95 501.5 ms | FAIL |
| AC4 cost | 0 Livepeer calls, 0 GB VRAM, RSS <= 2 GB | decide calls 0 · Livepeer spend $0 (harness only talks to 127.0.0.1:8099 + CPU ffmpeg) · nvidia-smi before/during/after unchanged (3090 Ti 22336 MiB, 5070 Ti 6764 MiB) · llama-server CPU RSS 2.22 GB after load + audio-only pass, 2.89 GB with vision, 5.53 GB after 147 requests (4 slots, KV growth) — above the 2 GB bar | FAIL (RSS > 2 GB) |
| AC5 noise split reported separately | pre-gate rejects split from Stage-A FP rate | pre-gate rejects 2/49 (0.0408); Stage-A (audio_gate) rejected 18/49 (0.3673) — different gates, NOT conflated | PASS |
| AC6 evidence | per-candidate table + command + artifact paths | this doc + `evals/lfm3-phase1-candidates.csv` + `evals/lfm3-phase1-summary.json` + `evals/lfm3-phase1-candidates.jsonl` | PASS |

## What was measured

| leg | value |
| --- | --- |
| Model | `LiquidAI/LFM3-Omni-2B-GGUF` Q4_K_M (1.10 GB) + `mmproj-...-Q4_K_M` (292 MB) |
| Runtime | llama.cpp **v0.8.0** (commit 8642541b255bfb5dc39cd351a178be09013a55d6), CMake CPU build `GGML_CUDA=OFF`, `-ngl 0 --no-mmproj-offload -t 16 --ctx-size 8192 --reasoning off --temp 0`, localhost 127.0.0.1:8099 |
| Candidate population | 49 Stage-A candidates over the 10 INC-5 labeled clips (GOAL/near 32, off-target 8, warm-up 9) replayed from the INC-9 trace |
| Per-candidate audio | trigger window `[ts-2.0s, ts+2.0s]` clamped to the clip, 16 kHz mono PCM, extracted with CPU ffmpeg (same convention as `evals/drive_inc8.py:crowd_energy_from_audio`) |
| Gate rule (pre-registered) | keep iff crowd_eruption==yes OR whistle==yes OR celebration_visible==yes (unparseable => reject) |
| Scoring | INC-9 Gemma decisions replayed from the trace (`gemmaAccepted` = the recorded `decision.isHighlight` for that candidate order) |

### Predicate answer distribution (49 candidates, audio-only pass)

| predicate | yes | no | unknown |
|---|---|---|---|
| crowd_eruption | 47 | 2 | 0 |
| whistle | 10 | 39 | 0 |
| commentary_excited | 47 | 2 | 0 |
| celebration_visible | 0 | 0 | 49 |

Model-reported crowd-eruption probability (`pYes` from a separate one-question logprob pass): positives mean 0.569 (min 0.078, max 0.725) vs negatives mean 0.453 (min 0.008, max 0.683) — overlapping distributions, no separating threshold.

### Why precision did not move

`crowd_eruption` answers **yes on 47 of 49 candidates** and `commentary_excited` yes on 47/49, on positives and negatives alike: broadcast crowd ambience is present in both classes, so a 2B omni model reading a 4 s window cannot separate a goal eruption from ordinary match noise. The only two candidates answered `no` sit on `soc-off-02` — one eliminated negative out of four, below the AC1 bar of three.

### Per-clip outcome (pre-gate applied on top of the recorded Gemma decisions)

| clip | phase | label | candidates | Gemma accepted | gate kept | kept+accepted | accepted GOAL survives? |
|---|---|---|---|---|---|---|---|
| soc-goal-01 | goal | positive | 8 | 5 | 8 | 5 | yes |
| soc-goal-02 | goal | positive | 8 | 5 | 8 | 5 | yes |
| soc-goal-03 | goal | positive | 6 | 5 | 6 | 5 | yes |
| soc-goal-04 | goal | positive | 4 | 3 | 4 | 3 | yes |
| soc-near-01 | near_goal | positive | 4 | 3 | 4 | 3 | yes |
| soc-near-02 | near_goal | positive | 2 | 1 | 2 | 1 | yes |
| soc-off-01 | off_target | negative | 5 | 2 | 5 | 2 | yes |
| soc-off-02 | off_target | negative | 3 | 1 | 1 | 0 | NO |
| soc-warm-01 | warm_up | negative | 5 | 3 | 5 | 3 | yes |
| soc-warm-02 | warm_up | negative | 4 | 3 | 4 | 3 | yes |

## Latency (AC3)

| shape | p50 | p95 | max | n |
|---|---|---|---|---|
| gate pass (4-predicate JSON reply) | 2272.1 | 2312.9 | 2341.2 | 49 |
| probability pass (1 yes/no + logprobs) | n/a | 501.5 | n/a | 49 |
| cheapest shape (4-token `y/n y/n y/n` reply) | 722.5 | 762.6 | 808.3 | 49 |

Even the cheapest answer shape stays far above the 300 ms bar (762.6 ms p95): the cost is the audio encoder forward pass + 2B decode on CPU (~0.4-0.8 s prefill for a 4 s window at ~31 tok/s decode), not prompt length. Prompt shaping cannot close the gap.

## Robustness checks

- **Repeat run, same config** (stability): gate p95 2250.5 ms, negatives eliminated 1, positives lost none — same verdict.
- **Vision variant** (anchor frame at candidate ts, 448 px, fixed prompt): celebration_visible yes on 12 clips, negatives eliminated 1, positives lost none, gate p95 2940.4 ms. Vision works in this build (a plain frame is described correctly in 6.2 s) but costs ~3x the audio pass on CPU and does not separate the classes either.
- **Window sensitivity** (Gemma-accepted candidates, 3 window lengths): crowd_eruption yes-rate A_4s pos 0.95 / neg 0.89, B_post1s pos 1.00 / neg 1.00, C_2s pos 1.00 / neg 1.00 — no window makes the predicate class-separating.

## ASR appendix (same run, no extra cost)

- LFM3-Omni with the model-card system prompt `Perform ASR in English.` did **not** transcribe these broadcast clips: it replies conversationally (e.g. `Thank you.`, `Oh, welcome!`) instead of a transcript; p50 3166.0 ms / p95 4262.6 ms per clip.
- Deployed faster-whisper `base` int8 baseline on the same clips: p50 2642.7 ms / p95 10069.7 ms; empty transcripts on crowd-only windows.
- Adoption bar (WER <= baseline AND p95 <= 0.70 s): **not met** — latency alone is 4262.6 ms vs the 700 ms bar, and no usable transcript was produced. WER against the baseline transcript is therefore recorded as 1.0 but is not informative (no human reference exists; the baseline is itself empty on most windows).
- Premise correction confirmed: dropping ASR frees **0 GB VRAM** — it is already CPU-only.

## Per-candidate table (AC6)

| clip | ts | phase | label | gemma accepted | crowd_eruption | whistle | commentary_excited | pYes | gate | latency ms |
|---|---|---|---|---|---|---|---|---|---|---|
| soc-goal-01 | 0.25 | goal | pos | True | yes | no | yes | 0.5941 | keep | 2199.3 |
| soc-goal-01 | 1.75 | goal | pos | True | yes | no | yes | 0.639013 | keep | 2227.4 |
| soc-goal-01 | 2.25 | goal | pos | False | yes | no | yes | 0.543512 | keep | 2280.1 |
| soc-goal-01 | 1.75 | goal | pos | False | yes | no | yes | 0.639013 | keep | 2284.6 |
| soc-goal-01 | 4.25 | goal | pos | True | yes | no | yes | 0.663785 | keep | 2280.3 |
| soc-goal-01 | 4.25 | goal | pos | True | yes | no | yes | 0.663785 | keep | 2269.8 |
| soc-goal-01 | 6.25 | goal | pos | True | yes | yes | yes | 0.615191 | keep | 2272.9 |
| soc-goal-01 | 6.25 | goal | pos | False | yes | yes | yes | 0.615191 | keep | 2280.9 |
| soc-goal-02 | 0.25 | goal | pos | True | yes | yes | yes | 0.078425 | keep | 2181.6 |
| soc-goal-02 | 2.25 | goal | pos | False | yes | no | yes | 0.56553 | keep | 2313.6 |
| soc-goal-02 | 2.75 | goal | pos | False | yes | no | yes | 0.585888 | keep | 2249.6 |
| soc-goal-02 | 4.25 | goal | pos | True | yes | no | yes | 0.587335 | keep | 2341.2 |
| soc-goal-02 | 6.75 | goal | pos | False | yes | no | yes | 0.553212 | keep | 2274.9 |
| soc-goal-02 | 9.25 | goal | pos | True | yes | no | yes | 0.545273 | keep | 2289.0 |
| soc-goal-02 | 10.75 | goal | pos | True | yes | no | yes | 0.504516 | keep | 2274.4 |
| soc-goal-02 | 11.75 | goal | pos | True | yes | no | yes | 0.505831 | keep | 2271.0 |
| soc-goal-03 | 3.75 | goal | pos | True | yes | yes | yes | 0.50897 | keep | 2286.3 |
| soc-goal-03 | 4.25 | goal | pos | True | yes | no | yes | 0.641751 | keep | 2311.9 |
| soc-goal-03 | 6.25 | goal | pos | False | yes | no | yes | 0.508977 | keep | 2308.9 |
| soc-goal-03 | 8.75 | goal | pos | True | yes | no | yes | 0.539794 | keep | 2269.0 |
| soc-goal-03 | 10.25 | goal | pos | True | yes | no | yes | 0.513314 | keep | 2280.8 |
| soc-goal-03 | 11.25 | goal | pos | True | yes | no | yes | 0.529557 | keep | 2245.7 |
| soc-goal-04 | 0.75 | goal | pos | True | yes | no | yes | 0.634286 | keep | 2181.2 |
| soc-goal-04 | 4.25 | goal | pos | False | yes | no | yes | 0.537916 | keep | 2243.5 |
| soc-goal-04 | 6.25 | goal | pos | True | yes | no | yes | 0.568309 | keep | 2234.4 |
| soc-goal-04 | 6.75 | goal | pos | True | yes | no | yes | 0.608534 | keep | 2235.5 |
| soc-near-01 | 3.75 | near_goal | pos | True | yes | yes | yes | 0.637213 | keep | 2287.7 |
| soc-near-01 | 4.25 | near_goal | pos | True | yes | yes | yes | 0.590889 | keep | 2296.5 |
| soc-near-01 | 6.25 | near_goal | pos | False | yes | yes | yes | 0.555929 | keep | 2272.1 |
| soc-near-01 | 8.75 | near_goal | pos | True | yes | no | yes | 0.544435 | keep | 2324.5 |
| soc-near-02 | 5.75 | near_goal | pos | True | yes | no | yes | 0.724512 | keep | 2282.0 |
| soc-near-02 | 8.25 | near_goal | pos | False | yes | no | yes | 0.675777 | keep | 2252.0 |
| soc-off-01 | 0.25 | off_target | neg | True | yes | yes | yes | 0.583147 | keep | 2157.7 |
| soc-off-01 | 2.25 | off_target | neg | False | yes | no | yes | 0.524883 | keep | 2221.6 |
| soc-off-01 | 2.75 | off_target | neg | False | yes | no | yes | 0.511082 | keep | 2271.1 |
| soc-off-01 | 9.25 | off_target | neg | False | yes | no | yes | 0.521615 | keep | 2259.9 |
| soc-off-01 | 12.75 | off_target | neg | True | yes | no | yes | 0.501934 | keep | 2295.9 |
| soc-off-02 | 0.25 | off_target | neg | False | yes | yes | yes | 0.047706 | keep | 2165.4 |
| soc-off-02 | 4.25 | off_target | neg | False | no | no | no | 0.041061 | REJECT | 2302.7 |
| soc-off-02 | 7.75 | off_target | neg | True | no | no | no | 0.008461 | REJECT | 2307.6 |
| soc-warm-01 | 2.25 | warm_up | neg | True | yes | no | yes | 0.564645 | keep | 2267.0 |
| soc-warm-01 | 4.25 | warm_up | neg | False | yes | no | yes | 0.53144 | keep | 2294.2 |
| soc-warm-01 | 4.75 | warm_up | neg | False | yes | no | yes | 0.521098 | keep | 2199.1 |
| soc-warm-01 | 6.25 | warm_up | neg | True | yes | no | yes | 0.527467 | keep | 2287.9 |
| soc-warm-01 | 5.25 | warm_up | neg | True | yes | no | yes | 0.589192 | keep | 2280.6 |
| soc-warm-02 | 0.25 | warm_up | neg | True | yes | yes | yes | 0.520192 | keep | 2175.9 |
| soc-warm-02 | 1.25 | warm_up | neg | True | yes | no | yes | 0.682568 | keep | 2226.3 |
| soc-warm-02 | 2.25 | warm_up | neg | True | yes | no | yes | 0.496583 | keep | 2245.9 |
| soc-warm-02 | 6.25 | warm_up | neg | False | yes | no | yes | 0.528955 | keep | 2239.4 |

## Reproduce

```sh
# on livepeer-ai-x99 (CPU only; no GPU, no Livepeer)
# 1) build llama.cpp v0.8.0 CPU-only
git clone --depth 1 --branch v0.8.0 https://github.com/ggml-org/llama.cpp ~/llama-build/llama.cpp
cmake -B ~/llama-build/llama.cpp/build -DGGML_CUDA=OFF -DGGML_NATIVE=ON -DLLAMA_CURL=ON
cmake --build ~/llama-build/llama.cpp/build -j 12 --target llama-server
# 2) model (1.10 GB + 292 MB)
curl -L -o ~/models/lfm3/LFM3-Omni-2B-Q4_K_M.gguf https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/resolve/main/LFM3-Omni-2B-Q4_K_M.gguf
curl -L -o ~/models/lfm3/mmproj-LFM3-Omni-2B-Q4_K_M.gguf https://huggingface.co/LiquidAI/LFM3-Omni-2B-GGUF/resolve/main/mmproj-LFM3-Omni-2B-Q4_K_M.gguf
# 3) serve CPU-only
llama-server -m ~/models/lfm3/LFM3-Omni-2B-Q4_K_M.gguf --mmproj ~/models/lfm3/mmproj-LFM3-Omni-2B-Q4_K_M.gguf \
  --host 127.0.0.1 --port 8099 -ngl 0 --no-mmproj-offload -t 16 --ctx-size 8192 \
  --reasoning off --temp 0
# 4) eval
python3 evals/lfm3_predicate_eval.py --out evals/lfm3-phase1-candidates.jsonl \
  --summary evals/lfm3-phase1-summary.json --csv evals/lfm3-phase1-candidates.csv
python3 evals/lfm3_latency_floor_probe.py      # cheapest-shape latency floor
python3 evals/lfm3_asr_appendix.py             # ASR appendix
python3 evals/lfm3_phase1_report.py            # this report
```

## Caveats

- The replay scores the pre-gate against the **recorded** INC-9 Gemma decisions; it does not re-run perceive or decide (that would need GPU / Livepeer and is out of scope).
- Latency is wall-clock per candidate with a single client and `n_slots=4` on an otherwise idle box; the box was also serving `highlights-*` containers, so absolute numbers carry normal CPU contention noise.
- Sample: 10 labeled clips / 49 candidates, 4 negatives. AC1/AC2 are graded on the INC-5 set as the ticket specifies; a 20-clip sample was not in scope.
- No production wiring was added. Any future adoption needs an off-by-default flag plus the Phase 2 co-residency decision, neither of which this eval authorises.

